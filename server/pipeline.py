"""Google ADK 2.0 orchestration pipeline for BExtractor extraction jobs."""

from __future__ import annotations

import importlib
import importlib.util
import json
from collections.abc import AsyncIterator
from typing import Any

from google.adk import Workflow
from google.adk.agents import LlmAgent
from google.adk.events import Event
from google.adk.events.event_actions import EventActions
from google.adk.workflow import FunctionNode

from server.custom_tools import search_tool


scalar_extractor = LlmAgent(
    name="scalar_extractor",
    model="models/gemini-1.5-flash",
    instruction=(
        "You extract isolated scalar data points from insurance and financial "
        "documents. Use search_tool with the requested field name and definition "
        "before answering. Return strict JSON only with keys: item_id, field_name, "
        "value, unit, confidence, evidence, and critique_response. If workflow "
        "state includes a critique for this item, correct the extraction and "
        "explain the fix in critique_response."
    ),
    tools=[search_tool],
    mode="single_turn",
)


tabular_extractor = LlmAgent(
    name="tabular_extractor",
    model="models/gemini-1.5-flash",
    instruction=(
        "You strictly parse markdown tables from retrieved document chunks into "
        "structured JSON arrays. Use search_tool with the table name and "
        "definition before answering. Preserve row order, column names, numeric "
        "types, and source evidence. Return strict JSON only with keys: item_id, "
        "table_name, rows, confidence, evidence, and critique_response. If workflow "
        "state includes a critique for this table, revise only the affected rows."
    ),
    tools=[search_tool],
    mode="single_turn",
)


critic_agent = LlmAgent(
    name="critic_agent",
    model="models/gemini-1.5-flash",
    instruction=(
        "Review the compiled extraction JSON against the template requirements and "
        "mathematical/accounting constraints. Check examples such as Total Assets "
        "= Liabilities + Equity, subtotals equaling row sums, premiums matching "
        "rate times exposure, and dates/ranges being internally consistent. Return "
        "strict JSON only with keys: status ('pass' or 'fail'), failed_item_id, "
        "failed_item_type ('Scalar' or 'Tabular'), critique, and corrected_payload. "
        "When status is fail, identify exactly one extractor item to rerun and give "
        "actionable critique for that item."
    ),
    mode="single_turn",
    output_key="critic_output",
)


def _template_items(template_payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize supported UI template shapes into a flat item list."""

    candidates = (
        template_payload.get("items"),
        template_payload.get("fields"),
        template_payload.get("template", {}).get("items")
        if isinstance(template_payload.get("template"), dict)
        else None,
    )
    for candidate in candidates:
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]
    return [template_payload] if template_payload else []


def _item_id(item: dict[str, Any], index: int) -> str:
    return str(item.get("id") or item.get("key") or item.get("name") or f"item_{index}")


def _safe_node_name(prefix: str, value: str) -> str:
    sanitized = "".join(char if char.isalnum() else "_" for char in value).strip("_")
    if not sanitized or sanitized[0].isdigit():
        sanitized = f"field_{sanitized or 'unnamed'}"
    return f"{prefix}_{sanitized}"[:80]


def _seed_state(ctx, node_input: Any) -> dict[str, Any]:
    payload = node_input if isinstance(node_input, dict) else {}
    if not payload and hasattr(node_input, "parts"):
        text = "".join(getattr(part, "text", "") or "" for part in node_input.parts)
        try:
            parsed = json.loads(text) if text else {}
            payload = parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            payload = {}
    template = payload.get("template_payload", payload)
    ctx.state["template_payload"] = template
    ctx.state["extraction_results"] = {}
    ctx.state["extractor_critiques"] = {}
    ctx.state["critic_result"] = {}
    return {"template_payload": template}


def _make_prepare_item(item: dict[str, Any], item_id: str):
    def prepare_item(ctx) -> dict[str, Any]:
        critique = ctx.state.get("extractor_critiques", {}).get(item_id)
        node_payload = {"item_id": item_id, "item": item, "critique": critique}
        ctx.state["current_item"] = node_payload
        return node_payload

    prepare_item.__name__ = _safe_node_name("prepare", item_id)
    return prepare_item


def _make_collect_item(item_id: str, output_key: str):
    def collect_item(ctx) -> dict[str, Any]:
        results = dict(ctx.state.get("extraction_results", {}))
        results[item_id] = ctx.state.get(output_key)
        ctx.state["extraction_results"] = results
        return {"item_id": item_id, "result": results[item_id]}

    collect_item.__name__ = _safe_node_name("collect", item_id)
    return collect_item


def compile_payload(ctx) -> dict[str, Any]:
    compiled = {
        "template": ctx.state.get("template_payload", {}),
        "results": ctx.state.get("extraction_results", {}),
    }
    ctx.state["compiled_payload"] = compiled
    return compiled


def route_critic_result(ctx) -> Event:
    raw = ctx.state.get("critic_output") or ctx.state.get("critic_result") or {}
    parsed = raw
    try:
        if isinstance(raw, str):
            parsed = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"Gemini critic response parsing failed: {exc}") from exc
    ctx.state["critic_result"] = parsed
    route = "db_commit"
    if isinstance(parsed, dict) and parsed.get("status") == "fail":
        failed_item_id = str(parsed.get("failed_item_id") or "")
        critiques = dict(ctx.state.get("extractor_critiques", {}))
        critiques[failed_item_id] = parsed.get("critique")
        ctx.state["extractor_critiques"] = critiques
        route = f"retry_{failed_item_id}"
    return Event(output=parsed, actions=EventActions(route=route))


async def save_extraction_results(template_id: str, results: dict[str, Any]) -> dict[str, Any]:
    """Insert the final validated JSON payload into Prisma's ExtractionResult table."""

    if importlib.util.find_spec("prisma") is None:
        return {"status": "ready", "backend": "memory", "payload": results}

    try:
        prisma_module = importlib.import_module("prisma")
        client = prisma_module.Prisma()
        await client.connect()
        try:
            document_id = str(
                results.get("document_id")
                or results.get("documentId")
                or template_id
                or "uploaded_document"
            )
            file_name = str(results.get("file_name") or results.get("fileName") or "uploaded.pdf")
            raw_text = results.get("raw_text") or results.get("rawText")
            confidence = results.get("confidence") if isinstance(results.get("confidence"), (int, float)) else None
            status = str(results.get("status") or "validated")

            await client.execute_raw(
                """
                INSERT INTO "ExtractionResult" (
                    "id", "documentId", "fileName", "rawText", "data",
                    "confidence", "status", "templateId", "createdAt", "updatedAt"
                )
                VALUES (
                    $1, $2, $3, $4, $5::jsonb, $6, $7,
                    (SELECT "id" FROM "DocumentTemplate" WHERE "id" = $8),
                    NOW(), NOW()
                )
                ON CONFLICT ("id") DO UPDATE SET
                    "documentId" = EXCLUDED."documentId",
                    "fileName" = EXCLUDED."fileName",
                    "rawText" = EXCLUDED."rawText",
                    "data" = EXCLUDED."data",
                    "confidence" = EXCLUDED."confidence",
                    "status" = EXCLUDED."status",
                    "templateId" = EXCLUDED."templateId",
                    "updatedAt" = NOW()
                """,
                document_id,
                document_id,
                file_name,
                raw_text,
                json.dumps(results),
                confidence,
                status,
                template_id or None,
            )
            return {"status": "committed", "backend": "prisma", "record_id": document_id}
        finally:
            await client.disconnect()
    except Exception as exc:
        raise RuntimeError(f"Prisma database insertion failed: {exc}") from exc


async def db_commit_node(ctx) -> dict[str, Any]:
    """Persist the final validated extraction payload with Prisma."""

    payload = ctx.state.get("compiled_payload", {})
    if isinstance(ctx.state.get("critic_result"), dict) and ctx.state["critic_result"].get("corrected_payload"):
        payload = ctx.state["critic_result"]["corrected_payload"]

    template = payload.get("template", {}) if isinstance(payload, dict) else {}
    template_id = str(template.get("id") or template.get("template_id") or "") if isinstance(template, dict) else ""
    return await save_extraction_results(template_id, payload if isinstance(payload, dict) else {"data": payload})



async def workflow_progress(template_payload: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """Yield progress events while the dynamic extraction workflow is prepared."""

    for index, item in enumerate(_template_items(template_payload), start=1):
        item_name = str(item.get("name") or item.get("id") or item.get("key") or f"Item {index}")
        yield {"status": f"Processing {item_name}", "item": item_name, "index": index}

def build_dynamic_graph(template_payload: dict) -> Workflow:
    """Build a Google ADK workflow graph from the UI extraction template."""

    items = _template_items(template_payload)
    seed_node = FunctionNode(func=_seed_state, name="seed_template_state")
    compile_node = FunctionNode(func=compile_payload, name="compile_payload")
    route_node = FunctionNode(func=route_critic_result, name="route_critic_result")
    commit_node = FunctionNode(func=db_commit_node, name="db_commit_node")

    edges: list[Any] = [("START", seed_node)]
    previous: Any = seed_node
    retry_targets: dict[str, FunctionNode] = {}

    for index, item in enumerate(items, start=1):
        item_id = _item_id(item, index)
        item_type = str(item.get("type", "Scalar"))
        prepare_node = FunctionNode(func=_make_prepare_item(item, item_id))
        output_key = f"extract_{item_id}_output"
        base_agent = tabular_extractor if item_type == "Tabular" else scalar_extractor
        extractor_node = base_agent.model_copy(
            update={"name": _safe_node_name(base_agent.name, item_id), "output_key": output_key}
        )
        collect_node = FunctionNode(func=_make_collect_item(item_id, output_key))
        edges.extend([(previous, prepare_node), (prepare_node, extractor_node), (extractor_node, collect_node)])
        previous = collect_node
        retry_targets[item_id] = prepare_node

    edges.extend([(previous, compile_node), (compile_node, critic_agent), (critic_agent, route_node)])
    for item_id, prepare_node in retry_targets.items():
        edges.append((route_node, {f"retry_{item_id}": prepare_node}))
    edges.append((route_node, {"db_commit": commit_node}))

    return Workflow(
        name="bextract_dynamic_extraction_workflow",
        description="Dynamic scalar/tabular extraction, criticism, retry, and persistence workflow.",
        edges=edges,
    )

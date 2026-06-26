"""Google ADK 2.0 orchestration pipeline for BExtractor extraction jobs."""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import re
from collections.abc import AsyncIterator
from typing import Any

from google.adk import Workflow
from google.adk.agents import LlmAgent
from google.adk.events import Event
from google.adk.events.event_actions import EventActions
from google.adk.workflow import FunctionNode
from google import genai
from google.genai import types

from server.custom_tools import document_hybrid_search, search_tool

INPUT_RATE_PER_MILLION = 1.50
OUTPUT_RATE_PER_MILLION = 9.00

def _reset_llm_request_to_stateless_turn(callback_context=None, llm_request=None, **_kwargs) -> None:
    """Strip ADK chat history before each model call.

    The dynamic workflow invokes extractor agents once per template item. ADK
    sessions can otherwise include prior node turns in ``llm_request.contents``,
    causing prompt tokens to grow with every extraction. Keep only the newest
    content payload for the current node and sever any provider-side previous
    interaction pointer. Returning ``None`` lets ADK continue with the sanitized
    request.
    """

    if llm_request is None:
        return None

    if not llm_request.contents:
        llm_request.previous_interaction_id = None
        return None

    if _contains_function_response(llm_request.contents):
        # Gemini requires each tool/function response to immediately follow the
        # model turn that requested it.  During the tool-continuation request,
        # ADK has already assembled that adjacent function-call/function-response
        # transcript; trimming it to only the latest user turn would leave an
        # orphaned function response and the provider rejects the request with
        # INVALID_ARGUMENT.  Keep this continuation turn intact and let the next
        # ordinary model request be reduced back to a single user payload.
        return None

    llm_request.previous_interaction_id = None
    latest_user_content = next(
        (content for content in reversed(llm_request.contents) if getattr(content, "role", None) == "user"),
        llm_request.contents[-1],
    )
    llm_request.contents = [latest_user_content]
    return None


def _contains_function_response(contents: list[Any]) -> bool:
    """Return True when an ADK request is continuing after a tool response."""

    for content in contents:
        for part in getattr(content, "parts", []) or []:
            if getattr(part, "function_response", None) is not None:
                return True
    return False


scalar_extractor = LlmAgent(
    name="scalar_extractor",
    model="gemini-3.5-flash",
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
    include_contents="none",
    before_model_callback=_reset_llm_request_to_stateless_turn,
)


tabular_extractor = LlmAgent(
    name="tabular_extractor",
    model="gemini-3.5-flash",
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
    include_contents="none",
    before_model_callback=_reset_llm_request_to_stateless_turn,
)


critic_agent = LlmAgent(
    name="critic_agent",
    model="gemini-3.5-flash",
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
    include_contents="none",
    before_model_callback=_reset_llm_request_to_stateless_turn,
    output_key="critic_output",
)



def _usage_metadata_from_mapping(payload: dict[str, Any]) -> tuple[int, int] | None:
    """Return prompt/candidate token counts from a serialized GenAI response."""

    metadata = payload.get("usage_metadata") or payload.get("usageMetadata")
    if not isinstance(metadata, dict):
        return None

    input_tokens = metadata.get("prompt_token_count", metadata.get("promptTokenCount", 0)) or 0
    output_tokens = metadata.get("candidates_token_count", metadata.get("candidatesTokenCount", 0)) or 0
    try:
        return int(input_tokens), int(output_tokens)
    except (TypeError, ValueError):
        return 0, 0


def _iter_usage_metadata(payload: Any) -> list[tuple[int, int]]:
    """Recursively find usage metadata in ADK/GenAI dicts, models, and lists."""

    if hasattr(payload, "model_dump"):
        payload = payload.model_dump(mode="json")

    if isinstance(payload, dict):
        current = _usage_metadata_from_mapping(payload)
        nested = [usage for value in payload.values() for usage in _iter_usage_metadata(value)]
        return ([current] if current is not None else []) + nested

    if isinstance(payload, list):
        return [usage for item in payload for usage in _iter_usage_metadata(item)]

    return []


def calculate_token_cost_metrics(workflow_output: Any) -> dict[str, Any]:
    """Calculate total token usage and cost from ADK workflow output."""

    event_payload = workflow_output.get("events") if isinstance(workflow_output, dict) else None
    usage_entries = _iter_usage_metadata(event_payload)
    if not usage_entries:
        usage_entries = _iter_usage_metadata(workflow_output)

    input_tokens = sum(input_count for input_count, _ in usage_entries)
    output_tokens = sum(output_count for _, output_count in usage_entries)
    input_cost = (input_tokens / 1_000_000) * INPUT_RATE_PER_MILLION
    output_cost = (output_tokens / 1_000_000) * OUTPUT_RATE_PER_MILLION

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "input_cost": input_cost,
        "output_cost": output_cost,
        "total_cost": input_cost + output_cost,
    }


def log_token_cost_metrics(metrics: dict[str, Any]) -> None:
    """Print a structured terminal block for extraction token usage and cost."""

    input_tokens = int(metrics.get("input_tokens", 0) or 0)
    output_tokens = int(metrics.get("output_tokens", 0) or 0)
    total_tokens = int(metrics.get("total_tokens", input_tokens + output_tokens) or 0)
    input_cost = float(metrics.get("input_cost", 0.0) or 0.0)
    output_cost = float(metrics.get("output_cost", 0.0) or 0.0)
    total_cost = float(metrics.get("total_cost", input_cost + output_cost) or 0.0)

    print("=== BEXTRACT TOKEN & COST METRICS ===")
    print(f"[Input]   Tokens: {input_tokens:,} | Cost: ${input_cost:.4f}")
    print(f"[Output]  Tokens: {output_tokens:,} | Cost: ${output_cost:.4f}")
    print("--------------------------------------")
    print(f"[Total]   Tokens: {total_tokens:,} | Total Cost: ${total_cost:.4f}")
    print("======================================")


def _metrics_from_usage_entries(usage_entries: list[tuple[int, int]]) -> dict[str, Any]:
    input_tokens = sum(input_count for input_count, _ in usage_entries)
    output_tokens = sum(output_count for _, output_count in usage_entries)
    input_cost = (input_tokens / 1_000_000) * INPUT_RATE_PER_MILLION
    output_cost = (output_tokens / 1_000_000) * OUTPUT_RATE_PER_MILLION
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "input_cost": input_cost,
        "output_cost": output_cost,
        "total_cost": input_cost + output_cost,
    }



def _node_name_from_event(event_payload: Any) -> str:
    """Best-effort extraction of the ADK node/agent name from a runner event."""

    payload = event_payload.model_dump(mode="json") if hasattr(event_payload, "model_dump") else event_payload
    if not isinstance(payload, dict):
        return type(event_payload).__name__

    for key in ("node_name", "nodeName", "node_id", "nodeId", "author", "name", "id"):
        value = payload.get(key)
        if value:
            return str(value)

    actions = payload.get("actions")
    if isinstance(actions, dict):
        for key in ("node_name", "nodeName", "route"):
            value = actions.get(key)
            if value:
                return str(value)

    return "unknown_adk_node"


def _event_usage_tokens(event_payload: Any) -> tuple[int, int]:
    """Return total prompt/candidate token counts found on one ADK event."""

    usage_entries = _iter_usage_metadata(event_payload)
    return (
        sum(input_count for input_count, _ in usage_entries),
        sum(output_count for _, output_count in usage_entries),
    )


def _estimated_context_length(step_input_payload: Any) -> int:
    """Return a stable debug estimate for the payload/context visible to a step."""

    try:
        return len(str(step_input_payload))
    except Exception:
        return 0


def _node_cost(input_tokens: int, output_tokens: int) -> float:
    """Calculate per-node estimated cost using configured model rates."""

    return (input_tokens / 1_000_000) * INPUT_RATE_PER_MILLION + (output_tokens / 1_000_000) * OUTPUT_RATE_PER_MILLION


def record_node_token_audit(
    node_audit_summary: list[dict[str, Any]],
    event_payload: Any,
    step_input_payload: Any,
) -> dict[str, Any]:
    """Append and print a granular token trace for a single ADK runner event/node turn."""

    node_name = _node_name_from_event(event_payload)
    input_tokens, output_tokens = _event_usage_tokens(event_payload)
    context_length = _estimated_context_length(step_input_payload)
    audit_entry = {
        "node_name": node_name,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "dynamic_context_length": context_length,
        "estimated_cost": _node_cost(input_tokens, output_tokens),
    }
    node_audit_summary.append(audit_entry)

    print(f"--- ADK NODE TRACE: {node_name} ---")
    print(f"* Step Input Tokens:  {input_tokens:,}")
    print(f"* Step Output Tokens: {output_tokens:,}")
    print(f"* Step Dynamic Context Length (Estimated characters/keys): {context_length}")
    print("----------------------------------")

    return audit_entry


def log_graph_token_audit_ledger(node_audit_summary: list[dict[str, Any]]) -> None:
    """Print an aggregated ledger of every audited ADK graph node turn."""

    print("===========================================================")
    print("BEXTRACT GRAPH TOKEN AUDIT LEDGER")
    print("===========================================================")
    print("Node Name           | Input Tokens | Output Tokens | Est. Cost")
    print("-----------------------------------------------------------")
    for entry in node_audit_summary:
        node_name = str(entry.get("node_name", "unknown_adk_node"))
        input_tokens = int(entry.get("input_tokens", 0) or 0)
        output_tokens = int(entry.get("output_tokens", 0) or 0)
        estimated_cost = float(entry.get("estimated_cost", _node_cost(input_tokens, output_tokens)) or 0.0)
        print(f"{node_name[:19]:<19} | {input_tokens:>12,} | {output_tokens:>13,} | ${estimated_cost:.4f}")
    print("===========================================================")

def _normalize_match_key(value: Any) -> str:
    """Return a casing/spacing-insensitive key for matching template and LLM fields."""

    return re.sub(r"[\s_]+", "", str(value or "").strip().lower())


def _case_insensitive_get(payload: dict[str, Any], *keys: str, default: Any = None) -> Any:
    """Fetch a value from a dict while ignoring key case, spaces, and underscores."""

    normalized = {_normalize_match_key(key): value for key, value in payload.items()}
    for key in keys:
        match = _normalize_match_key(key)
        if match in normalized:
            return normalized[match]
    return default


def _parse_result_payload(raw: Any) -> Any:
    """Parse extractor outputs that may be dicts, ADK part payloads, or JSON strings."""

    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        candidate = _extract_json_candidate(raw)
        if candidate:
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                return raw
    if hasattr(raw, "parts"):
        text = "".join(getattr(part, "text", "") or "" for part in raw.parts)
        return _parse_result_payload(text)
    return raw


def normalize_workflow_results(template_payload: dict[str, Any], workflow_output: Any) -> dict[str, Any]:
    """Map ADK/Gemini output onto template item cards with tolerant key matching."""

    output = workflow_output if isinstance(workflow_output, dict) else {}
    state = output.get("state", {}) if isinstance(output.get("state"), dict) else {}
    compiled = state.get("compiled_payload", {}) if isinstance(state.get("compiled_payload"), dict) else {}
    raw_results = compiled.get("results") if isinstance(compiled.get("results"), dict) else state.get("extraction_results", {})
    raw_results = raw_results if isinstance(raw_results, dict) else {}

    normalized_results: dict[str, Any] = {}
    for raw_key, raw_value in raw_results.items():
        parsed = _parse_result_payload(raw_value)
        normalized_results[_normalize_match_key(raw_key)] = parsed
        if isinstance(parsed, dict):
            for candidate_key in ("item_id", "item id", "field_name", "field name", "table_name", "table name", "name", "key", "id"):
                candidate_value = _case_insensitive_get(parsed, candidate_key)
                if candidate_value:
                    normalized_results[_normalize_match_key(candidate_value)] = parsed

    mapped: dict[str, Any] = {}
    for index, item in enumerate(_template_items(template_payload), start=1):
        item_id = _item_id(item, index)
        lookup_keys = [item_id, item.get("key"), item.get("name"), item.get("label"), item.get("field_name")]
        result = None
        for lookup_key in lookup_keys:
            normalized_lookup = _normalize_match_key(lookup_key)
            if normalized_lookup and normalized_lookup in normalized_results:
                result = normalized_results[normalized_lookup]
                break

        if isinstance(result, dict):
            item_name = str(item.get("name") or item.get("label") or item_id)
            mapped[item_id] = {
                "item_id": str(_case_insensitive_get(result, "item_id", "item id", default=item_id)),
                "field_name": str(_case_insensitive_get(result, "field_name", "field name", "table_name", "table name", default=item_name)),
                "value": _case_insensitive_get(result, "value", "rows", "data", "answer", default="Pending ADK extraction result"),
                "unit": _case_insensitive_get(result, "unit", "data_type", "data type", default=item.get("dataType", "String")),
                "confidence": _case_insensitive_get(result, "confidence", "score", default=0.0),
                "evidence": _case_insensitive_get(result, "evidence", "source", "citation", default=""),
                "critique_response": _case_insensitive_get(result, "critique_response", "critique response", default=""),
            }
        elif result is not None:
            mapped[item_id] = result

    return mapped

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


def _state_pop(state: Any, key: str, default: Any = None) -> Any:
    """Return and clear a workflow state value across dict and ADK State APIs.

    google.adk.sessions.state.State intentionally exposes a small mapping-like
    API with get/set/update but no pop/delete. Function nodes still need to
    consume temporary agent outputs without assuming a concrete dict type. For
    plain mutable mappings, remove the key. For ADK State, read the value and
    overwrite it with None so downstream parsing does not see stale output.
    """

    if hasattr(state, "pop"):
        return state.pop(key, default)

    value = state.get(key, default) if hasattr(state, "get") else default
    if key in state:
        state[key] = None
    return value


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
        raw_result = _state_pop(ctx.state, output_key, None)
        results[item_id] = _parse_result_payload(raw_result)
        ctx.state["extraction_results"] = results
        _state_pop(ctx.state, "current_item", None)
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


def _extract_json_candidate(text: str) -> str:
    """Return the most likely JSON object/array from an LLM text response."""

    stripped = text.strip()
    if not stripped:
        return ""

    fence_match = re.search(r"```(?:json)?\s*(.*?)\s*```", stripped, flags=re.IGNORECASE | re.DOTALL)
    if fence_match:
        return fence_match.group(1).strip()

    decoder = json.JSONDecoder()
    for index, char in enumerate(stripped):
        if char not in "[{":
            continue
        try:
            _, end = decoder.raw_decode(stripped[index:])
        except json.JSONDecodeError:
            continue
        return stripped[index : index + end]

    return stripped


def _parse_critic_response(raw: Any) -> dict[str, Any]:
    """Parse critic output defensively so malformed LLM text cannot break routing."""

    if isinstance(raw, dict):
        return raw

    if not isinstance(raw, str):
        return {
            "status": "pass",
            "failed_item_id": "",
            "failed_item_type": "",
            "critique": "Critic returned no parseable response; continuing with compiled payload.",
            "corrected_payload": None,
            "parse_warning": f"Unsupported critic output type: {type(raw).__name__}",
        }

    candidate = _extract_json_candidate(raw)
    if not candidate:
        return {
            "status": "pass",
            "failed_item_id": "",
            "failed_item_type": "",
            "critique": "Critic returned an empty response; continuing with compiled payload.",
            "corrected_payload": None,
            "parse_warning": "empty response",
        }

    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as exc:
        return {
            "status": "pass",
            "failed_item_id": "",
            "failed_item_type": "",
            "critique": "Critic returned malformed JSON; continuing with compiled payload.",
            "corrected_payload": None,
            "parse_warning": str(exc),
            "raw_response": raw,
        }

    if isinstance(parsed, dict):
        return parsed

    return {
        "status": "pass",
        "failed_item_id": "",
        "failed_item_type": "",
        "critique": "Critic returned JSON that was not an object; continuing with compiled payload.",
        "corrected_payload": None,
        "parse_warning": f"Expected object, got {type(parsed).__name__}",
    }


def _retryable_item_ids(ctx) -> set[str]:
    """Return item IDs that have retry routes in the dynamic workflow."""

    template = ctx.state.get("template_payload", {}) if hasattr(ctx, "state") else {}
    return {_item_id(item, index) for index, item in enumerate(_template_items(template), start=1)}


def route_critic_result(ctx) -> Event:
    raw = ctx.state.get("critic_output")
    if raw is None:
        raw = ctx.state.get("critic_result") or {}
    parsed = _parse_critic_response(raw)
    ctx.state["critic_result"] = parsed
    route = "db_commit"
    if isinstance(parsed, dict) and parsed.get("status") == "fail":
        failed_item_id = str(parsed.get("failed_item_id") or "")
        retryable_ids = _retryable_item_ids(ctx)
        if failed_item_id and failed_item_id in retryable_ids:
            critiques = dict(ctx.state.get("extractor_critiques", {}))
            critiques[failed_item_id] = parsed.get("critique")
            ctx.state["extractor_critiques"] = critiques
            route = f"retry_{failed_item_id}"
        else:
            parsed["route_warning"] = (
                "Critic requested a retry for an unknown or missing item id; "
                "committing the compiled payload instead of routing to a nonexistent workflow edge."
            )
            parsed["status"] = "pass"
            print(
                "WARNING: Critic retry route ignored because failed_item_id "
                f"{failed_item_id!r} is not one of {sorted(retryable_ids)!r}."
            )
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

    print("=== DEBUG DATABASE PAYLOAD ===")
    print(f"Payload keys: {list(payload.keys()) if isinstance(payload, dict) else 'Not a dict'}")
    print(f"Payload content: {repr(payload)}")

    template = payload.get("template", {}) if isinstance(payload, dict) else {}
    template_id = str(template.get("id") or template.get("template_id") or "") if isinstance(template, dict) else ""
    return await save_extraction_results(template_id, payload if isinstance(payload, dict) else {"data": payload})



async def workflow_progress(template_payload: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """Yield progress events while the dynamic extraction workflow is prepared."""

    for index, item in enumerate(_template_items(template_payload), start=1):
        item_name = str(item.get("name") or item.get("id") or item.get("key") or f"Item {index}")
        yield {"status": f"Processing {item_name}", "item": item_name, "index": index}


def _pre_injected_prompt(item: dict[str, Any], item_id: str, item_name: str, chunks: str) -> str:
    item_type = str(item.get("type") or item.get("routeType") or "Scalar")
    definition = str(item.get("definition") or item.get("description") or "")
    data_type = str(item.get("dataType") or item.get("data_type") or "String")
    return (
        "You are extracting one field from a document using only the retrieved evidence below.\n"
        "Return strict JSON only. Do not wrap the JSON in markdown.\n"
        "Required keys: item_id, field_name, value, unit, confidence, evidence, critique_response.\n"
        "For tabular fields, put the parsed row array in value.\n\n"
        f"Item ID: {item_id}\n"
        f"Field name: {item_name}\n"
        f"Field type: {item_type}\n"
        f"Expected data type/unit: {data_type}\n"
        f"Definition: {definition}\n\n"
        "Retrieved document chunks:\n"
        f"{chunks}\n"
    )


async def run_pre_injected_extraction(
    document_id: str,
    template: dict[str, Any],
    *,
    model: str = "gemini-3.5-flash",
) -> AsyncIterator[dict[str, Any] | str]:
    """Run stateless per-field RAG extraction without ADK Runner orchestration."""

    yield "Executing stateless extraction..."
    client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))
    extraction_results: dict[str, Any] = {}
    events: list[dict[str, Any]] = []
    node_audit_summary: list[dict[str, Any]] = []
    usage_entries: list[tuple[int, int]] = []

    for index, item in enumerate(_template_items(template), start=1):
        item_id = _item_id(item, index)
        item_name = str(item.get("name") or item.get("label") or item_id)
        definition = str(item.get("definition") or item.get("description") or "")
        yield f"Processing {item_name}"

        chunks = await document_hybrid_search(item_name, definition)
        prompt = _pre_injected_prompt(item, item_id, item_name, chunks)
        response = await client.aio.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        response_payload = response.model_dump(mode="json") if hasattr(response, "model_dump") else response
        events.append({"node_name": f"pre_injected_{item_id}", "response": response_payload})
        current_usage = _iter_usage_metadata(response_payload)
        usage_entries.extend(current_usage)

        input_tokens = sum(input_count for input_count, _ in current_usage)
        output_tokens = sum(output_count for _, output_count in current_usage)
        node_audit_summary.append(
            {
                "node_name": f"pre_injected_{item_id}"[:80],
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "dynamic_context_length": _estimated_context_length(prompt),
                "estimated_cost": _node_cost(input_tokens, output_tokens),
            }
        )

        raw_text = getattr(response, "text", "") or ""
        parsed = _parse_result_payload(raw_text)
        if not isinstance(parsed, dict):
            parsed = {
                "item_id": item_id,
                "field_name": item_name,
                "value": parsed,
                "unit": item.get("dataType", "String"),
                "confidence": 0.0,
                "evidence": chunks,
                "critique_response": "Model response was not a JSON object; raw value preserved.",
            }
        extraction_results[item_id] = {
            "item_id": str(_case_insensitive_get(parsed, "item_id", "item id", default=item_id)),
            "field_name": str(_case_insensitive_get(parsed, "field_name", "field name", "table_name", "table name", default=item_name)),
            "value": _case_insensitive_get(parsed, "value", "rows", "data", "answer", default=""),
            "unit": _case_insensitive_get(parsed, "unit", "data_type", "data type", default=item.get("dataType", "String")),
            "confidence": _case_insensitive_get(parsed, "confidence", "score", default=0.0),
            "evidence": _case_insensitive_get(parsed, "evidence", "source", "citation", default=chunks),
            "critique_response": _case_insensitive_get(parsed, "critique_response", "critique response", default=""),
        }

    token_cost_metrics = _metrics_from_usage_entries(usage_entries)
    log_token_cost_metrics(token_cost_metrics)
    log_graph_token_audit_ledger(node_audit_summary)
    yield {
        "results": extraction_results,
        "workflow_output": {
            "events": events,
            "state": {"compiled_payload": {"template": template, "results": extraction_results}},
            "node_audit_summary": node_audit_summary,
            "approach": "pre_injected",
            "document_id": document_id,
        },
        "token_cost_metrics": token_cost_metrics,
        "node_audit_summary": node_audit_summary,
    }

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

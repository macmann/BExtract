from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api/evals", tags=["evals"])

EvalExportFormat = Literal["openai_chat", "gemini_tuning"]


def _json_default(value: Any) -> str:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _coerce_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _json_line(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, default=_json_default) + "\n"


def _template_items(template_payload: dict[str, Any]) -> list[dict[str, Any]]:
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


def _field_instruction(template_config: Any, field_id: str) -> str:
    config = _coerce_json(template_config)
    if isinstance(config, dict):
        for index, item in enumerate(_template_items(config), start=1):
            if _item_id(item, index) == field_id:
                instruction = item.get("definition") or item.get("description") or item.get("instructions")
                if instruction:
                    return str(instruction)
                label = item.get("name") or item.get("label") or field_id
                return f"Extract the {label} field from the supplied context."
    return f"Extract the {field_id} field from the supplied context."


def _assistant_value(corrected_value: Any) -> str:
    corrected_value = _coerce_json(corrected_value)
    if isinstance(corrected_value, str):
        return corrected_value
    return json.dumps(corrected_value, ensure_ascii=False, default=_json_default)


def _openai_chat_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "messages": [
            {
                "role": "system",
                "content": _field_instruction(row.get("template_config"), str(row.get("field_id") or "")),
            },
            {"role": "user", "content": str(row.get("input_context_chunk") or "")},
            {"role": "assistant", "content": _assistant_value(row.get("corrected_value"))},
        ]
    }


def _gemini_tuning_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "systemInstruction": {
            "role": "system",
            "parts": [
                {"text": _field_instruction(row.get("template_config"), str(row.get("field_id") or ""))}
            ],
        },
        "contents": [
            {"role": "user", "parts": [{"text": str(row.get("input_context_chunk") or "")}]},
            {"role": "model", "parts": [{"text": _assistant_value(row.get("corrected_value"))}]},
        ],
    }


def _format_record(row: dict[str, Any], export_format: EvalExportFormat) -> dict[str, Any]:
    if export_format == "gemini_tuning":
        return _gemini_tuning_record(row)
    return _openai_chat_record(row)


async def _verified_examples_stream(export_format: EvalExportFormat) -> AsyncIterator[str]:
    from prisma import Prisma
    from server.db_schema import ensure_verified_field_examples_table

    client = Prisma()
    await client.connect()
    try:
        await ensure_verified_field_examples_table(client)
        rows = await client.query_raw(
            """
            SELECT
                vfe."template_id",
                vfe."field_id",
                vfe."input_context_chunk",
                vfe."corrected_value",
                dt."config" AS "template_config"
            FROM "verified_field_examples" vfe
            LEFT JOIN "DocumentTemplate" dt ON dt."id" = vfe."template_id"
            ORDER BY vfe."template_id" ASC, vfe."field_id" ASC, vfe."updated_at" DESC, vfe."created_at" DESC
            """
        )
        for row in rows:
            yield _json_line(_format_record(dict(row), export_format))
    finally:
        await client.disconnect()


@router.get("/export")
async def export_verified_examples(
    format: EvalExportFormat = Query(..., description="Export format: openai_chat or gemini_tuning"),
) -> StreamingResponse:
    """Stream human-verified examples as JSONL for evals and fine-tuning."""

    filename = f"verified-field-examples-{format}.jsonl"
    return StreamingResponse(
        _verified_examples_stream(format),
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

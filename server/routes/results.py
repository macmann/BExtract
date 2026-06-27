from __future__ import annotations

import csv
import io
import json
from collections.abc import AsyncIterator
from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from prisma import Prisma

router = APIRouter(prefix="/api/results", tags=["results"])

DownloadFormat = Literal["json", "csv", "logs"]


def _json_default(value: Any) -> str:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _coerce_payload(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _normalize_run(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.get("id")),
        "template_id": row.get("template_id"),
        "status": row.get("status"),
        "started_at": row.get("started_at"),
        "completed_at": row.get("completed_at"),
        "total_files": row.get("total_files"),
        "processed_files": row.get("processed_files"),
        "total_input_tokens": row.get("total_input_tokens"),
        "total_output_tokens": row.get("total_output_tokens"),
        "total_cost_usd": row.get("total_cost_usd"),
    }


def _normalize_file(row: dict[str, Any], *, include_payload: bool = False) -> dict[str, Any]:
    item = {
        "id": str(row.get("id")),
        "run_id": str(row.get("run_id")),
        "file_name": row.get("file_name"),
        "status": row.get("status"),
        "error_message": row.get("error_message"),
    }
    if include_payload:
        item["extracted_payload"] = _coerce_payload(row.get("extracted_payload"))
    return item


def _flatten_payload(payload: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(payload, dict):
        flattened: dict[str, Any] = {}
        for key, value in payload.items():
            child_key = f"{prefix}.{key}" if prefix else str(key)
            flattened.update(_flatten_payload(value, child_key))
        return flattened
    if isinstance(payload, list):
        return {prefix: json.dumps(payload, default=_json_default, ensure_ascii=False)}
    return {prefix: payload}


async def _fetch_run(client: Prisma, run_id: str) -> dict[str, Any] | None:
    rows = await client.query_raw(
        """
        SELECT
            "id"::text,
            "template_id",
            "status"::text,
            "started_at",
            "completed_at",
            "total_files",
            "processed_files",
            "total_input_tokens",
            "total_output_tokens",
            "total_cost_usd"
        FROM "pipeline_runs"
        WHERE "id" = $1::uuid
        LIMIT 1
        """,
        run_id,
    )
    return dict(rows[0]) if rows else None


async def _fetch_files(client: Prisma, run_id: str) -> list[dict[str, Any]]:
    rows = await client.query_raw(
        """
        SELECT
            "id"::text,
            "run_id"::text,
            "file_name",
            "status"::text,
            "extracted_payload",
            "logs",
            "error_message"
        FROM "file_extractions"
        WHERE "run_id" = $1::uuid
        ORDER BY "file_name" ASC, "id" ASC
        """,
        run_id,
    )
    return [dict(row) for row in rows]


@router.get("")
async def list_results() -> list[dict[str, Any]]:
    """Return all pipeline runs, newest first, for the execution history page."""

    client = Prisma()
    await client.connect()
    try:
        rows = await client.query_raw(
            """
            SELECT
                "id"::text,
                "template_id",
                "status"::text,
                "started_at",
                "completed_at",
                "total_files",
                "processed_files",
                "total_input_tokens",
                "total_output_tokens",
                "total_cost_usd"
            FROM "pipeline_runs"
            ORDER BY "started_at" DESC
            """
        )
        return [_normalize_run(dict(row)) for row in rows]
    finally:
        await client.disconnect()


@router.get("/{run_id}")
async def get_result(run_id: str) -> dict[str, Any]:
    """Return a pipeline run with its child file extraction summaries."""

    client = Prisma()
    await client.connect()
    try:
        run = await _fetch_run(client, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="Pipeline run not found")
        files = await _fetch_files(client, run_id)
        return {**_normalize_run(run), "files": [_normalize_file(file) for file in files]}
    finally:
        await client.disconnect()


async def _json_payload_stream(run_id: str) -> AsyncIterator[bytes]:
    client = Prisma()
    await client.connect()
    try:
        yield b"["
        first = True
        for file in await _fetch_files(client, run_id):
            payload = _coerce_payload(file.get("extracted_payload"))
            if not first:
                yield b","
            first = False
            yield json.dumps(payload, default=_json_default, ensure_ascii=False).encode("utf-8")
        yield b"]"
    finally:
        await client.disconnect()


async def _csv_payload_stream(run_id: str) -> AsyncIterator[str]:
    client = Prisma()
    await client.connect()
    try:
        files = await _fetch_files(client, run_id)
        flattened_rows = [_flatten_payload(_coerce_payload(file.get("extracted_payload"))) for file in files]
        headers = list(flattened_rows[0].keys()) if flattened_rows else []
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        for row in flattened_rows:
            writer.writerow(row)
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)
    finally:
        await client.disconnect()


async def _logs_stream(run_id: str) -> AsyncIterator[str]:
    client = Prisma()
    await client.connect()
    try:
        for index, file in enumerate(await _fetch_files(client, run_id), start=1):
            if index > 1:
                yield "\n\n"
            yield f"===== {file.get('file_name') or file.get('id')} =====\n"
            yield str(file.get("logs") or "")
    finally:
        await client.disconnect()


@router.get("/{run_id}/download")
async def download_result(
    run_id: str,
    format: DownloadFormat = Query(..., description="Download format: json, csv, or logs"),
) -> StreamingResponse:
    """Stream run payloads or processing logs as a downloadable artifact."""

    client = Prisma()
    await client.connect()
    try:
        run = await _fetch_run(client, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="Pipeline run not found")
    finally:
        await client.disconnect()

    if format == "json":
        return StreamingResponse(
            _json_payload_stream(run_id),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="pipeline-run-{run_id}.json"'},
        )
    if format == "csv":
        return StreamingResponse(
            _csv_payload_stream(run_id),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="pipeline-run-{run_id}.csv"'},
        )
    return StreamingResponse(
        _logs_stream(run_id),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="pipeline-run-{run_id}-logs.txt"'},
    )

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from server.ingestion import ingest_document
from server.pipeline import (
    build_dynamic_graph,
    calculate_token_cost_metrics,
    db_commit_node,
    log_graph_token_audit_ledger,
    log_token_cost_metrics,
    normalize_workflow_results,
    record_node_token_audit,
    workflow_progress,
)

REQUIRED_ENV_VARS = ("GOOGLE_API_KEY", "DATABASE_URL", "DIRECT_URL")
missing_env_vars = [name for name in REQUIRED_ENV_VARS if not os.getenv(name)]
if missing_env_vars:
    raise RuntimeError(
        "BExtractor server startup failed: missing required environment variable(s): "
        + ", ".join(missing_env_vars)
        + ". Set them before starting the API."
    )

app = FastAPI(title="BExtractor API")

CLIENT_OUT_DIR = (Path(__file__).resolve().parent / ".." / "client" / "out").resolve()


async def log_document_chunk_embedding_column_type() -> None:
    """Print the physical PostgreSQL type for DocumentChunk.embedding at startup."""

    from prisma import Prisma

    raw_sql = """
        SELECT data_type, character_maximum_length, udt_name
        FROM information_schema.columns
        WHERE table_name = 'DocumentChunk' AND column_name = 'embedding';
    """
    client = Prisma()
    await client.connect()
    try:
        rows = await client.query_raw(raw_sql)
        print(f"DEBUG: DocumentChunk.embedding physical column type: {rows}")
    finally:
        await client.disconnect()


@app.on_event("startup")
async def startup_database_introspection() -> None:
    await log_document_chunk_embedding_column_type()


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def _sse_data(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, default=str)}\n\n"


def _template_items(template_payload: dict[str, Any]) -> list[dict[str, Any]]:
    items = template_payload.get("items") or template_payload.get("fields") or []
    return [item for item in items if isinstance(item, dict)]


async def _run_adk_workflow(graph: Any, payload: dict[str, Any]) -> Any:
    """Run the ADK workflow through Runner so ADK initializes invocation internals."""

    app_name = "bextract"
    user_id = "api"
    session_id = f"bextract-{id(graph)}"
    session_service = InMemorySessionService()
    await session_service.create_session(
        app_name=app_name,
        user_id=user_id,
        session_id=session_id,
        state={},
    )
    runner = Runner(
        app_name=app_name,
        node=graph,
        session_service=session_service,
    )
    new_message = types.Content(
        role="user",
        parts=[types.Part(text=json.dumps(payload, default=str))],
    )

    try:
        events = []
        node_audit_summary: list[dict[str, Any]] = []
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=new_message,
            state_delta=payload,
        ):
            event_payload = event.model_dump(mode="json") if hasattr(event, "model_dump") else event
            events.append(event_payload)
            record_node_token_audit(node_audit_summary, event_payload, payload)

        log_graph_token_audit_ledger(node_audit_summary)

        session = await session_service.get_session(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
        )
        state = {}
        if session is not None and getattr(session, "state", None) is not None:
            session_state = session.state
            state = session_state.to_dict() if hasattr(session_state, "to_dict") else dict(session_state)
        response = {"events": events, "state": state, "node_audit_summary": node_audit_summary}
        print("=== DEBUG FINAL WORKFLOW OUTPUT ===")
        print(f"Type of output: {type(response)}")
        print(f"Content of output: {repr(response)}")
        return response
    except Exception as exc:
        raise RuntimeError(f"Gemini workflow execution failed: {exc}") from exc


async def _ingest_document_with_progress(
    uploaded_bytes: bytes,
    document_id: str,
    remember_log,
) -> AsyncIterator[str | list[Any]]:
    """Run ingestion in a background task while streaming progress messages."""

    progress_queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def progress_callback(message: str) -> None:
        await progress_queue.put(message)

    ingestion_task = asyncio.create_task(
        ingest_document(uploaded_bytes, document_id=document_id, progress_callback=progress_callback)
    )

    while not ingestion_task.done():
        try:
            message = await asyncio.wait_for(progress_queue.get(), timeout=0.5)
        except TimeoutError:
            yield _sse("log", {"tone": "info", "status": "Indexing PDF", "message": remember_log("Still indexing PDF chunks...")})
            continue
        if message is not None:
            yield _sse("log", {"tone": "info", "status": "Indexing PDF", "message": remember_log(message)})

    while not progress_queue.empty():
        message = progress_queue.get_nowait()
        if message is not None:
            yield _sse("log", {"tone": "info", "status": "Indexing PDF", "message": remember_log(message)})

    yield await ingestion_task


async def _fallback_commit(compiled_payload: dict[str, Any]) -> dict[str, Any]:
    class _Context:
        def __init__(self) -> None:
            self.state = {
                "compiled_payload": compiled_payload,
                "critic_result": {"status": "pass"},
            }

    return await db_commit_node(_Context())


def _format_backend_log_export(
    runtime_log_lines: list[str],
    token_cost_metrics: dict[str, Any] | None,
    node_audit_summary: list[dict[str, Any]],
    error_details: str | None = None,
) -> str:
    """Build a plain-text troubleshooting log that mirrors backend terminal diagnostics."""

    sections = ["BEXTRACT BACKEND TROUBLESHOOTING LOG", "", "Runtime events:"]
    sections.extend(runtime_log_lines or ["No runtime events were captured."])

    if error_details:
        sections.extend([
            "",
            "=== EXTRACTION ERROR DETAILS ===",
            error_details.strip(),
            "================================",
        ])

    if token_cost_metrics:
        input_tokens = int(token_cost_metrics.get("input_tokens", 0) or 0)
        output_tokens = int(token_cost_metrics.get("output_tokens", 0) or 0)
        total_tokens = int(token_cost_metrics.get("total_tokens", input_tokens + output_tokens) or 0)
        input_cost = float(token_cost_metrics.get("input_cost", 0.0) or 0.0)
        output_cost = float(token_cost_metrics.get("output_cost", 0.0) or 0.0)
        total_cost = float(token_cost_metrics.get("total_cost", input_cost + output_cost) or 0.0)
        sections.extend([
            "",
            "=== BEXTRACT TOKEN & COST METRICS ===",
            f"[Input]   Tokens: {input_tokens:,} | Cost: ${input_cost:.4f}",
            f"[Output]  Tokens: {output_tokens:,} | Cost: ${output_cost:.4f}",
            "--------------------------------------",
            f"[Total]   Tokens: {total_tokens:,} | Total Cost: ${total_cost:.4f}",
            "======================================",
        ])

    sections.extend([
        "",
        "===========================================================",
        "BEXTRACT GRAPH TOKEN AUDIT LEDGER",
        "===========================================================",
        "Node Name           | Input Tokens | Output Tokens | Est. Cost",
        "-----------------------------------------------------------",
    ])
    if node_audit_summary:
        for entry in node_audit_summary:
            node_name = str(entry.get("node_name", "unknown_adk_node"))
            input_tokens = int(entry.get("input_tokens", 0) or 0)
            output_tokens = int(entry.get("output_tokens", 0) or 0)
            estimated_cost = float(entry.get("estimated_cost", 0.0) or 0.0)
            sections.append(f"{node_name[:19]:<19} | {input_tokens:>12,} | {output_tokens:>13,} | ${estimated_cost:.4f}")
    else:
        sections.append("No ADK node audit rows were captured.")
    sections.append("===========================================================")
    return "\n".join(sections)


class _TeeLogCapture(io.StringIO):
    """Capture backend stdout/stderr while still forwarding it to the server terminal."""

    def __init__(self, stream: Any) -> None:
        super().__init__()
        self._stream = stream

    def write(self, value: str) -> int:
        self._stream.write(value)
        self._stream.flush()
        return super().write(value)

    def flush(self) -> None:
        self._stream.flush()
        super().flush()

    def fileno(self) -> int:
        """Expose the wrapped terminal file descriptor for subprocess users.

        Prisma's Python client starts a query-engine subprocess. On Windows,
        ``subprocess.Popen`` asks the currently redirected stdout/stderr for a
        real OS file descriptor; ``io.StringIO`` does not provide one, which
        raises ``io.UnsupportedOperation: fileno``. Delegating to the original
        server stream keeps log capture active without breaking subprocess
        startup.
        """

        return self._stream.fileno()


async def _extract_stream(upload: UploadFile, template_payload: dict[str, Any]) -> AsyncIterator[str]:
    backend_log_lines: list[str] = []
    backend_log_capture = _TeeLogCapture(sys.__stdout__)
    backend_error_capture = _TeeLogCapture(sys.__stderr__)

    def remember_log(message: str) -> str:
        backend_log_lines.append(message)
        return message

    def captured_backend_log_text() -> str:
        return "\n".join(
            part.strip()
            for part in (backend_log_capture.getvalue(), backend_error_capture.getvalue())
            if part.strip()
        )

    try:
        with redirect_stdout(backend_log_capture), redirect_stderr(backend_error_capture):
            uploaded_bytes = await upload.read()
            file_name = upload.filename or "upload.pdf"
            document_id = Path(file_name).stem or "uploaded_document"

            yield _sse("log", {"tone": "info", "status": f"Document accepted: {file_name}", "message": remember_log(f"Document accepted: {file_name}")})
            chunks = []
            async for ingestion_event in _ingest_document_with_progress(uploaded_bytes, document_id, remember_log):
                if isinstance(ingestion_event, str):
                    yield ingestion_event
                else:
                    chunks = ingestion_event
            raw_text = "\n\n".join(chunk.content for chunk in chunks)
            yield _sse("log", {"tone": "success", "status": f"Indexed {len(chunks)} PDF text chunks", "message": remember_log(f"{len(chunks)} PDF text chunks indexed for hybrid retrieval.")})

            yield _sse("log", {"tone": "info", "status": "Building dynamic ADK workflow graph", "message": remember_log("Building dynamic ADK workflow graph from Template Configurator payload.")})
            graph = build_dynamic_graph(template_payload)

            items = _template_items(template_payload)
            extraction_results: dict[str, Any] = {}
            async for progress in workflow_progress(template_payload):
                yield _sse("log", {"tone": "info", "message": remember_log(str(progress["status"])), **progress})
                await asyncio.sleep(0)

            for index, item in enumerate(items, start=1):
                item_id = str(item.get("id") or item.get("key") or item.get("name") or f"item_{index}")
                item_name = str(item.get("name") or item_id)
                extraction_results[item_id] = {
                    "item_id": item_id,
                    "field_name": item_name,
                    "value": "Pending ADK extraction result",
                    "unit": item.get("dataType", "String"),
                    "confidence": 0.0,
                    "evidence": "Workflow execution streamed by backend prototype.",
                }

            yield _sse("log", {"tone": "info", "status": "Executing ADK workflow graph", "message": remember_log("Executing ADK workflow graph and critic validation.")})
            workflow_output = await _run_adk_workflow(graph, {"template_payload": template_payload})
            normalized_results = normalize_workflow_results(template_payload, workflow_output)
            if normalized_results:
                extraction_results.update(normalized_results)
            yield _sse("log", {"tone": "success", "status": "Committing structured extraction payload", "message": remember_log("ADK workflow completed; committing structured extraction payload.")})

            compiled_payload = {
                "template": template_payload,
                "results": extraction_results,
                "workflow_output": workflow_output,
                "document_id": document_id,
                "file_name": file_name,
                "raw_text": raw_text,
                "status": "validated",
            }
            commit = await _fallback_commit(compiled_payload)
            token_cost_metrics = calculate_token_cost_metrics(workflow_output)
            log_token_cost_metrics(token_cost_metrics)

            node_audit_summary = workflow_output.get("node_audit_summary", []) if isinstance(workflow_output, dict) else []
            remember_log("Database insert confirmation returned to client.")
            captured_backend_logs = captured_backend_log_text()
            backend_log_text = _format_backend_log_export(backend_log_lines, token_cost_metrics, node_audit_summary)
            if captured_backend_logs:
                backend_log_text = f"{captured_backend_logs}\n\n{backend_log_text}"
            yield _sse("debug_log", {"message": captured_backend_logs or backend_log_text})

            final_payload = {
                "structured_json": compiled_payload,
                "database": commit,
                "token_cost_metrics": token_cost_metrics,
                "node_audit_summary": node_audit_summary,
                "backend_log_text": backend_log_text,
                "backend_log_lines": backend_log_lines,
            }
            yield _sse("result", final_payload)
            yield _sse("log", {"tone": "success", "status": "Database insert confirmation returned", "message": "Database insert confirmation returned to client."})
            yield _sse("done", {"ok": True, "status": "done"})
    except Exception as exc:
        error_message = f"Extraction failed: {exc}"
        error_details = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        remember_log(error_message)
        remember_log(error_details.rstrip())
        print("=== BEXTRACT EXTRACTION ERROR ===", file=sys.stderr)
        print(error_details, file=sys.stderr, end="")
        captured_backend_logs = captured_backend_log_text()
        backend_log_text = _format_backend_log_export(backend_log_lines, None, [], error_details)
        if captured_backend_logs:
            backend_log_text = f"{captured_backend_logs}\n\n{backend_log_text}"
        yield _sse("debug_log", {"message": backend_log_text})
        yield _sse("log", {"tone": "error", "status": "Extraction failed", "message": error_message})
        yield _sse_data({"error": error_message, "backend_log_text": backend_log_text})
    finally:
        await upload.close()


@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "service": "BExtractor"}


@app.post("/api/extract")
async def extract_document(file: UploadFile = File(...), payload: str = Form(...)) -> StreamingResponse:
    """Stream an extraction run as Server-Sent Events for the Next.js right panel."""

    try:
        template_payload = json.loads(payload)
    except json.JSONDecodeError as exc:
        return StreamingResponse(
            iter([_sse_data({"error": f"Invalid template payload JSON: {exc}"})]),
            media_type="text/event-stream",
            status_code=400,
        )

    return StreamingResponse(
        _extract_stream(file, template_payload),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if CLIENT_OUT_DIR.exists():
    app.mount("/_next", StaticFiles(directory=CLIENT_OUT_DIR / "_next"), name="next-static")
    app.mount("/", StaticFiles(directory=CLIENT_OUT_DIR, html=True), name="client")
else:
    @app.get("/")
    def client_not_built() -> dict[str, str]:
        return {
            "message": "BExtractor API is running. Build the Next.js client to serve the web app.",
            "expected_static_dir": str(CLIENT_OUT_DIR),
        }


@app.exception_handler(404)
def spa_fallback(_, __):
    index_file = CLIENT_OUT_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse({"detail": "Not Found"}, status_code=404)

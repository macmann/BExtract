"""PDF ingestion and Neon/pgvector-backed retrieval storage for BExtractor."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from io import BytesIO
from pathlib import Path
import re

import google.generativeai as genai


@dataclass(frozen=True)
class DocumentChunk:
    """A text chunk extracted from a source document."""

    chunk_id: str
    document_id: str
    chunk_type: str
    content: str
    metadata: dict[str, Any] = field(default_factory=dict)


_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+")
EMBEDDING_MODEL = "models/gemini-embedding-001"
EMBEDDING_DIMENSION = 3072
EMBEDDING_TIMEOUT_SECONDS = int(os.getenv("BEXTRACT_EMBEDDING_TIMEOUT_SECONDS", "60"))
ProgressCallback = Callable[[str], Awaitable[None]]


def tokenize(text: str) -> list[str]:
    """Normalize text into query/index terms."""

    return [token.lower() for token in _TOKEN_RE.findall(text)]


def _source_bytes(document_file: bytes | str | Path) -> bytes:
    if isinstance(document_file, bytes):
        return document_file
    return Path(document_file).read_bytes()


def extract_pdf_pages(pdf_bytes: bytes) -> list[str]:
    """Extract text from PDF bytes, returning one string per page."""

    return [page["text"] for page in extract_pdf_pages_with_layout(pdf_bytes)]


def extract_pdf_pages_with_layout(pdf_bytes: bytes) -> list[dict[str, Any]]:
    """Extract text and word-level coordinates from PDF bytes.

    Coordinates are returned in PDF page points as ``x0``, ``y0``, ``x1``, and
    ``y1`` with page dimensions so the frontend can scale highlights to the
    rendered PDF page. Falls back to PyPDF2 text-only extraction when PyMuPDF is
    unavailable or cannot parse the file.
    """

    try:
        import fitz  # PyMuPDF

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        pages: list[dict[str, Any]] = []
        for page_index, page in enumerate(doc, start=1):
            words = []
            text_parts = []
            for word_index, word in enumerate(page.get_text("words")):
                x0, y0, x1, y1, text, *_ = word
                clean_text = str(text).strip()
                if not clean_text:
                    continue
                words.append({
                    "text": clean_text,
                    "x0": float(x0),
                    "y0": float(y0),
                    "x1": float(x1),
                    "y1": float(y1),
                    "index": word_index,
                })
                text_parts.append(clean_text)
            rect = page.rect
            pages.append({
                "page": page_index,
                "text": " ".join(text_parts),
                "words": words,
                "width": float(rect.width),
                "height": float(rect.height),
            })
        return pages
    except Exception:
        from PyPDF2 import PdfReader

        reader = PdfReader(BytesIO(pdf_bytes))
        return [
            {"page": index, "text": page.extract_text() or "", "words": [], "width": None, "height": None}
            for index, page in enumerate(reader.pages, start=1)
        ]


def _chunk_page_words(words: list[dict[str, Any]], max_tokens: int = 260, overlap: int = 40) -> list[dict[str, Any]]:
    """Split page words into overlapping chunks while preserving coordinates."""

    if not words:
        return []
    chunks: list[dict[str, Any]] = []
    step = max(max_tokens - overlap, 1)
    for start in range(0, len(words), step):
        window = words[start : start + max_tokens]
        if window:
            chunks.append({"text": " ".join(str(word.get("text") or "") for word in window), "words": window})
        if start + max_tokens >= len(words):
            break
    return chunks


def _chunk_page_text(text: str, max_tokens: int = 260, overlap: int = 40) -> list[str]:
    """Split page text into lightweight overlapping chunks."""

    return [chunk["text"] for chunk in _chunk_page_words([{"text": token} for token in text.split()], max_tokens, overlap)]


def _word_bbox(words: list[dict[str, Any]]) -> dict[str, float] | None:
    positioned = [word for word in words if all(key in word for key in ("x0", "y0", "x1", "y1"))]
    if not positioned:
        return None
    return {
        "x0": min(float(word["x0"]) for word in positioned),
        "y0": min(float(word["y0"]) for word in positioned),
        "x1": max(float(word["x1"]) for word in positioned),
        "y1": max(float(word["y1"]) for word in positioned),
    }


def parse_pdf_chunks(pdf_bytes: bytes, document_id: str) -> list[DocumentChunk]:
    """Extract PDF text page by page and convert it into retrieval chunks."""

    chunks: list[DocumentChunk] = []
    for page in extract_pdf_pages_with_layout(pdf_bytes):
        page_number = int(page.get("page") or len(chunks) + 1)
        page_chunks = _chunk_page_words(page.get("words") or []) or [
            {"text": content, "words": []} for content in _chunk_page_text(str(page.get("text") or ""))
        ]
        for chunk_number, chunk in enumerate(page_chunks, start=1):
            words = chunk.get("words") or []
            metadata = {
                "page": page_number,
                "chunk": chunk_number,
                "page_width": page.get("width"),
                "page_height": page.get("height"),
                "bbox": _word_bbox(words),
                "words": words,
            }
            chunks.append(
                DocumentChunk(
                    chunk_id=f"{document_id}:p{page_number}:c{chunk_number}",
                    document_id=document_id,
                    chunk_type="pdf_text",
                    content=str(chunk.get("text") or ""),
                    metadata=metadata,
                )
            )
    return chunks


def configure_google_embeddings() -> None:
    """Configure the Google Generative AI client when an API key is available."""

    api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if api_key:
        genai.configure(api_key=api_key)


def generate_embedding(text: str) -> list[float]:
    """Generate a 3072-dimensional embedding with Google's gemini-embedding-001 model."""

    configure_google_embeddings()
    response = genai.embed_content(model=EMBEDDING_MODEL, content=text, task_type="retrieval_document")
    embedding = response["embedding"] if isinstance(response, dict) else response.embedding
    return [float(value) for value in embedding]


def vector_literal(embedding: list[float]) -> str:
    """Serialize an embedding for pgvector's vector input syntax."""

    return "[" + ",".join(str(value) for value in embedding) + "]"


async def ensure_extraction_result_record(client, extraction_id: str, *, file_name: str | None = None) -> None:
    """Ensure chunk inserts have a parent ExtractionResult row to satisfy FK constraints."""

    safe_file_name = file_name or f"{extraction_id}.pdf"
    await client.execute_raw(
        """
        INSERT INTO "ExtractionResult" (
            "id", "documentId", "fileName", "data", "status", "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4::jsonb, 'indexing', NOW(), NOW())
        ON CONFLICT ("id") DO NOTHING
        """,
        extraction_id,
        extraction_id,
        safe_file_name,
        json.dumps({"status": "indexing", "document_id": extraction_id}),
    )


async def persist_document_chunks(
    chunks: list[DocumentChunk],
    progress_callback: ProgressCallback | None = None,
) -> None:
    """Persist parsed chunks and dense vectors into Neon PostgreSQL via Prisma raw SQL."""

    if not chunks:
        return

    async def report(message: str) -> None:
        print(message, flush=True)
        if progress_callback is not None:
            await progress_callback(message)

    from prisma import Prisma

    client = Prisma()
    await client.connect()
    try:
        extraction_ids = {chunk.document_id for chunk in chunks}
        for extraction_id in extraction_ids:
            await ensure_extraction_result_record(client, extraction_id)

        total_chunks = len(chunks)
        for index, chunk in enumerate(chunks, start=1):
            await report(f"Embedding PDF chunk {index}/{total_chunks} ({chunk.chunk_id}).")
            try:
                embedding = await asyncio.wait_for(
                    asyncio.to_thread(generate_embedding, chunk.content),
                    timeout=EMBEDDING_TIMEOUT_SECONDS,
                )
            except TimeoutError as exc:
                raise RuntimeError(
                    f"Timed out after {EMBEDDING_TIMEOUT_SECONDS}s while generating embedding "
                    f"for PDF chunk {index}/{total_chunks} ({chunk.chunk_id})."
                ) from exc
            await client.execute_raw(
                f'''
                INSERT INTO "DocumentChunk" ("id", "extraction_id", "chunk_text", "embedding", "metadata")
                VALUES ($1, $2, $3, $4::vector({EMBEDDING_DIMENSION}), $5::jsonb)
                ON CONFLICT ("id") DO UPDATE SET
                    "chunk_text" = EXCLUDED."chunk_text",
                    "embedding" = EXCLUDED."embedding",
                    "metadata" = EXCLUDED."metadata"
                ''',
                chunk.chunk_id,
                chunk.document_id,
                chunk.content,
                vector_literal(embedding),
                json.dumps({"chunk_type": chunk.chunk_type, **chunk.metadata}),
            )
    finally:
        await client.disconnect()


async def ingest_document(
    document_file: bytes | str | Path,
    document_id: str | None = None,
    progress_callback: ProgressCallback | None = None,
) -> list[DocumentChunk]:
    """Parse a PDF, generate dense embeddings, and store chunks in pgvector."""

    async def report(message: str) -> None:
        print(message, flush=True)
        if progress_callback is not None:
            await progress_callback(message)

    doc_id = document_id or (Path(document_file).stem if not isinstance(document_file, bytes) else "uploaded_document")
    await report(f"Parsing PDF text for document {doc_id}.")
    chunks = parse_pdf_chunks(_source_bytes(document_file), document_id=doc_id)
    await report(f"Parsed {len(chunks)} PDF text chunks for document {doc_id}.")
    await persist_document_chunks(chunks, progress_callback=progress_callback)
    return chunks


def ensure_seed_index() -> None:
    """Compatibility hook retained for existing tool initialization paths."""

    return None

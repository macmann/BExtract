"""Streaming ingestion for LLM-flattened scanned PDFs."""

from __future__ import annotations

import asyncio
import gc
import json
from pathlib import Path

from server.ingestion import (
    EMBEDDING_DIMENSION,
    EMBEDDING_TIMEOUT_SECONDS,
    DocumentChunk,
    ensure_extraction_result_record,
    generate_embedding,
    vector_literal,
)
from server.utils.llm_ocr import flatten_pdf_pages


async def process_and_index_scanned_pdf(
    file_path: str,
    run_id: str,
    provider: str,
    model_name: str,
    overlap_chars: int = 200,
) -> int:
    """OCR, overlap, embed, and persist a scanned PDF one page at a time.

    The function never builds a full-document text string.  Each LLM-OCR page is
    stitched with the tail of the previous page, embedded, and stored before the
    next page is rendered.
    """

    from prisma import Prisma

    file_name = Path(file_path).name
    safe_overlap_chars = max(int(overlap_chars or 0), 0)
    previous_page_tail = ""
    indexed_page_count = 0

    client = Prisma()
    await client.connect()
    try:
        await ensure_extraction_result_record(client, run_id, file_name=file_name)

        for flattened_page in flatten_pdf_pages(file_path, provider=provider, model_name=model_name):
            current_page_text = flattened_page.text or ""
            prepended_overlap_chars = len(previous_page_tail)
            stitched_text = f"{previous_page_tail}{current_page_text}" if previous_page_tail else current_page_text
            previous_page_tail = current_page_text[-safe_overlap_chars:] if safe_overlap_chars else ""

            chunk = DocumentChunk(
                chunk_id=f"{run_id}:llm-ocr:p{flattened_page.page_number}",
                document_id=run_id,
                chunk_type="llm_ocr_page",
                content=stitched_text,
                metadata={
                    "run_id": run_id,
                    "file_name": file_name,
                    "page_number": flattened_page.page_number,
                    "page": flattened_page.page_number,
                    "overlap_chars": safe_overlap_chars,
                    "prepended_overlap_chars": prepended_overlap_chars,
                    "provider": provider,
                    "model_name": model_name,
                },
            )

            await _embed_and_persist_page_chunk(client, chunk)
            indexed_page_count += 1

            del current_page_text
            del stitched_text
            del prepended_overlap_chars
            del chunk
            gc.collect()
    finally:
        await client.disconnect()

    return indexed_page_count


async def _embed_and_persist_page_chunk(client, chunk: DocumentChunk) -> None:
    try:
        embedding = await asyncio.wait_for(
            asyncio.to_thread(generate_embedding, chunk.content),
            timeout=EMBEDDING_TIMEOUT_SECONDS,
        )
    except TimeoutError as exc:
        raise RuntimeError(
            f"Timed out after {EMBEDDING_TIMEOUT_SECONDS}s while generating embedding for {chunk.chunk_id}."
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

    del embedding
    gc.collect()

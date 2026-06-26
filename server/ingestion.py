"""PDF ingestion and Neon/pgvector-backed retrieval storage for BExtractor."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
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
    metadata: dict[str, str] = field(default_factory=dict)


_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+")
EMBEDDING_MODEL = "models/text-embedding-004"


def tokenize(text: str) -> list[str]:
    """Normalize text into query/index terms."""

    return [token.lower() for token in _TOKEN_RE.findall(text)]


def _source_bytes(document_file: bytes | str | Path) -> bytes:
    if isinstance(document_file, bytes):
        return document_file
    return Path(document_file).read_bytes()


def extract_pdf_pages(pdf_bytes: bytes) -> list[str]:
    """Extract text from PDF bytes, returning one string per page."""

    from PyPDF2 import PdfReader

    reader = PdfReader(BytesIO(pdf_bytes))
    pages: list[str] = []
    for page in reader.pages:
        pages.append(page.extract_text() or "")
    return pages


def _chunk_page_text(text: str, max_tokens: int = 260, overlap: int = 40) -> list[str]:
    """Split page text into lightweight overlapping chunks."""

    tokens = text.split()
    if not tokens:
        return []
    chunks: list[str] = []
    step = max(max_tokens - overlap, 1)
    for start in range(0, len(tokens), step):
        window = tokens[start : start + max_tokens]
        if window:
            chunks.append(" ".join(window))
        if start + max_tokens >= len(tokens):
            break
    return chunks


def parse_pdf_chunks(pdf_bytes: bytes, document_id: str) -> list[DocumentChunk]:
    """Extract PDF text page by page and convert it into retrieval chunks."""

    chunks: list[DocumentChunk] = []
    for page_number, page_text in enumerate(extract_pdf_pages(pdf_bytes), start=1):
        for chunk_number, content in enumerate(_chunk_page_text(page_text), start=1):
            chunks.append(
                DocumentChunk(
                    chunk_id=f"{document_id}:p{page_number}:c{chunk_number}",
                    document_id=document_id,
                    chunk_type="pdf_text",
                    content=content,
                    metadata={"page": str(page_number), "chunk": str(chunk_number)},
                )
            )
    return chunks


def configure_google_embeddings() -> None:
    """Configure the Google Generative AI client when an API key is available."""

    api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if api_key:
        genai.configure(api_key=api_key)


def generate_embedding(text: str) -> list[float]:
    """Generate a 768-dimensional embedding with Google's text-embedding-004 model."""

    configure_google_embeddings()
    response = genai.embed_content(model=EMBEDDING_MODEL, content=text, task_type="retrieval_document")
    embedding = response["embedding"] if isinstance(response, dict) else response.embedding
    return [float(value) for value in embedding]


def vector_literal(embedding: list[float]) -> str:
    """Serialize an embedding for pgvector's vector input syntax."""

    return "[" + ",".join(str(value) for value in embedding) + "]"


async def persist_document_chunks(chunks: list[DocumentChunk]) -> None:
    """Persist parsed chunks and dense vectors into Neon PostgreSQL via Prisma raw SQL."""

    if not chunks:
        return

    from prisma import Prisma

    client = Prisma()
    await client.connect()
    try:
        for chunk in chunks:
            embedding = generate_embedding(chunk.content)
            await client.execute_raw(
                '''
                INSERT INTO "DocumentChunk" ("id", "extraction_id", "chunk_text", "embedding", "metadata")
                VALUES ($1, $2, $3, $4::vector, $5::jsonb)
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


async def ingest_document(document_file: bytes | str | Path, document_id: str | None = None) -> list[DocumentChunk]:
    """Parse a PDF, generate dense embeddings, and store chunks in pgvector."""

    doc_id = document_id or (Path(document_file).stem if not isinstance(document_file, bytes) else "uploaded_document")
    chunks = parse_pdf_chunks(_source_bytes(document_file), document_id=doc_id)
    await persist_document_chunks(chunks)
    return chunks


def ensure_seed_index() -> None:
    """Compatibility hook retained for existing tool initialization paths."""

    return None

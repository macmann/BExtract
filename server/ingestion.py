"""PDF ingestion and in-memory hybrid retrieval indexes for BExtractor."""

from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
import math
import re
from typing import Iterable


@dataclass(frozen=True)
class DocumentChunk:
    """A text chunk extracted from a source document."""

    chunk_id: str
    document_id: str
    chunk_type: str
    content: str
    metadata: dict[str, str] = field(default_factory=dict)


MOCK_INDEX: dict[str, dict[str, object]] = {
    "chunks": {},
    "vector_index": {},
    "bm25_index": {},
}

_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+")


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


def ingest_document(document_file: bytes | str | Path, document_id: str | None = None) -> list[DocumentChunk]:
    """Parse a PDF and register chunks in the in-memory hybrid indexes."""

    doc_id = document_id or (Path(document_file).stem if not isinstance(document_file, bytes) else "uploaded_document")
    chunks = parse_pdf_chunks(_source_bytes(document_file), document_id=doc_id)
    for chunk in chunks:
        terms = tokenize(chunk.content)
        term_counts = {term: terms.count(term) for term in set(terms)}
        MOCK_INDEX["chunks"][chunk.chunk_id] = chunk
        MOCK_INDEX["vector_index"][chunk.chunk_id] = term_counts
        MOCK_INDEX["bm25_index"][chunk.chunk_id] = terms
    return chunks


def ensure_seed_index() -> None:
    """Leave the index empty until a real PDF is uploaded."""

    return None


def vector_score(query_terms: Iterable[str], chunk_id: str) -> float:
    """Compute a small cosine-over-token-counts score for semantic simulation."""

    terms = list(query_terms)
    query_counts = {term: terms.count(term) for term in set(terms)}
    chunk_counts = MOCK_INDEX["vector_index"].get(chunk_id, {})
    if not query_counts or not chunk_counts:
        return 0.0
    dot = sum(query_counts.get(term, 0) * chunk_counts.get(term, 0) for term in query_counts)
    query_norm = math.sqrt(sum(value * value for value in query_counts.values()))
    chunk_norm = math.sqrt(sum(value * value for value in chunk_counts.values()))
    return dot / (query_norm * chunk_norm) if query_norm and chunk_norm else 0.0


def bm25_score(query_terms: Iterable[str], chunk_id: str) -> float:
    """Compute a lightweight BM25-like lexical score over the in-memory corpus."""

    terms = list(query_terms)
    document_terms = MOCK_INDEX["bm25_index"].get(chunk_id, [])
    if not terms or not document_terms:
        return 0.0

    corpus_terms = MOCK_INDEX["bm25_index"]
    corpus_size = max(len(corpus_terms), 1)
    score = 0.0
    for term in set(terms):
        frequency = document_terms.count(term)
        if frequency == 0:
            continue
        documents_with_term = sum(1 for indexed_terms in corpus_terms.values() if term in indexed_terms)
        idf = math.log(1 + (corpus_size - documents_with_term + 0.5) / (documents_with_term + 0.5))
        score += idf * frequency / (frequency + 1.2)
    return score

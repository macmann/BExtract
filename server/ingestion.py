"""Layout-aware mock ingestion for BExtractor documents.

This module intentionally keeps persistence in memory while modelling the two
indexes BExtractor expects to query later: a semantic/vector-style index and a
BM25-style lexical index. The parser is a lightweight mock that preserves table
layouts as Markdown chunks instead of flattening them into ordinary text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import math
import re
from typing import Iterable


@dataclass(frozen=True)
class DocumentChunk:
    """A layout-aware chunk extracted from a source document."""

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


_SAMPLE_DOCUMENT = """
BExtractor extracts insurance submission fields from uploaded documents. The
system should preserve context around each field definition so downstream agents
can cite the original source language.

| Field | Definition | Example |
| --- | --- | --- |
| Named Insured | Legal entity that owns the policy | Acme LLC |
| Effective Date | Date when coverage begins | 2026-01-01 |

Tables frequently contain limits, deductibles, premium schedules, and exposure
values. Keeping these grids intact helps retrieval return neighboring labels and
values that would be lost during naive fixed-width chunking.
""".strip()


def tokenize(text: str) -> list[str]:
    """Normalize text into query/index terms."""

    return [token.lower() for token in _TOKEN_RE.findall(text)]


def _read_document(document_file: str | Path) -> str:
    path = Path(document_file)
    if path.exists() and path.is_file():
        return path.read_text(encoding="utf-8")
    return _SAMPLE_DOCUMENT


def _is_table_line(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("|") and stripped.endswith("|") and stripped.count("|") >= 2


def parse_layout_chunks(document_file: str | Path, document_id: str | None = None) -> list[DocumentChunk]:
    """Mock a layout parser that emits paragraph chunks and intact table chunks.

    Consecutive Markdown table rows are grouped into one ``table`` chunk, while
    non-table text is split on blank lines into ``paragraph`` chunks.
    """

    source_text = _read_document(document_file)
    doc_id = document_id or Path(document_file).stem or "mock-document"
    chunks: list[DocumentChunk] = []
    paragraph_lines: list[str] = []
    table_lines: list[str] = []

    def flush_paragraph() -> None:
        if not paragraph_lines:
            return
        content = " ".join(line.strip() for line in paragraph_lines if line.strip())
        if content:
            chunks.append(
                DocumentChunk(
                    chunk_id=f"{doc_id}:p:{len(chunks) + 1}",
                    document_id=doc_id,
                    chunk_type="paragraph",
                    content=content,
                    metadata={"layout": "text_block"},
                )
            )
        paragraph_lines.clear()

    def flush_table() -> None:
        if not table_lines:
            return
        chunks.append(
            DocumentChunk(
                chunk_id=f"{doc_id}:t:{len(chunks) + 1}",
                document_id=doc_id,
                chunk_type="table",
                content="\n".join(table_lines),
                metadata={"layout": "markdown_table"},
            )
        )
        table_lines.clear()

    for line in source_text.splitlines():
        if _is_table_line(line):
            flush_paragraph()
            table_lines.append(line.strip())
            continue
        flush_table()
        if line.strip():
            paragraph_lines.append(line)
        else:
            flush_paragraph()

    flush_table()
    flush_paragraph()
    return chunks


def ingest_document(document_file: str | Path, document_id: str | None = None) -> list[DocumentChunk]:
    """Parse a document and register chunks in the in-memory mock indexes."""

    chunks = parse_layout_chunks(document_file, document_id=document_id)
    for chunk in chunks:
        terms = tokenize(chunk.content)
        term_counts = {term: terms.count(term) for term in set(terms)}
        MOCK_INDEX["chunks"][chunk.chunk_id] = chunk
        MOCK_INDEX["vector_index"][chunk.chunk_id] = term_counts
        MOCK_INDEX["bm25_index"][chunk.chunk_id] = terms
    return chunks


def ensure_seed_index() -> None:
    """Populate the mock index with a representative document if it is empty."""

    if not MOCK_INDEX["chunks"]:
        ingest_document("sample_submission.md", document_id="sample_submission")


def vector_score(query_terms: Iterable[str], chunk_id: str) -> float:
    """Compute a small cosine-over-token-counts score for semantic simulation."""

    query_counts = {term: list(query_terms).count(term) for term in set(query_terms)}
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

"""Custom ADK tools used by BExtractor agents."""

from __future__ import annotations

import asyncio
from contextvars import ContextVar

import google.generativeai as genai
from google.adk.tools import FunctionTool
from rank_bm25 import BM25Okapi

from server.ingestion import EMBEDDING_DIMENSION, EMBEDDING_MODEL, configure_google_embeddings, tokenize, vector_literal


_current_document_id: ContextVar[str | None] = ContextVar("bextract_current_document_id", default=None)


def set_current_document_id(document_id: str | None):
    """Scope retrieval tools to the document currently being extracted."""

    return _current_document_id.set(document_id)


def reset_current_document_id(token) -> None:
    """Restore the previous retrieval document scope."""

    _current_document_id.reset(token)


async def _fetch_dense_matches(
    query_embedding: list[float], document_id: str | None, limit: int = 10
) -> list[dict[str, object]]:
    """Return the 10 nearest pgvector chunks by cosine distance."""

    from prisma import Prisma

    client = Prisma()
    await client.connect()
    try:
        if document_id:
            rows = await client.query_raw(
                f'''
                SELECT "id", "chunk_text", "metadata", "embedding" <=> $1::vector({EMBEDDING_DIMENSION}) AS distance
                FROM "DocumentChunk"
                WHERE "extraction_id" = $2
                ORDER BY "embedding" <=> $1::vector({EMBEDDING_DIMENSION})
                LIMIT $3
                ''',
                vector_literal(query_embedding),
                document_id,
                limit,
            )
        else:
            rows = await client.query_raw(
                f'''
                SELECT "id", "chunk_text", "metadata", "embedding" <=> $1::vector({EMBEDDING_DIMENSION}) AS distance
                FROM "DocumentChunk"
                ORDER BY "embedding" <=> $1::vector({EMBEDDING_DIMENSION})
                LIMIT $2
                ''',
                vector_literal(query_embedding),
                limit,
            )
        return [dict(row) for row in rows]
    finally:
        await client.disconnect()


async def _fetch_all_chunks(document_id: str | None) -> list[dict[str, object]]:
    """Load text chunks for sparse BM25 ranking."""

    from prisma import Prisma

    client = Prisma()
    await client.connect()
    try:
        if document_id:
            rows = await client.query_raw(
                'SELECT "id", "chunk_text", "metadata" FROM "DocumentChunk" WHERE "extraction_id" = $1',
                document_id,
            )
        else:
            rows = await client.query_raw('SELECT "id", "chunk_text", "metadata" FROM "DocumentChunk"')
        return [dict(row) for row in rows]
    finally:
        await client.disconnect()


def _query_embedding(text: str) -> list[float]:
    configure_google_embeddings()
    response = genai.embed_content(model=EMBEDDING_MODEL, content=text, task_type="retrieval_query")
    embedding = response["embedding"] if isinstance(response, dict) else response.embedding
    return [float(value) for value in embedding]


def _sparse_bm25_matches(query: str, chunks: list[dict[str, object]], limit: int = 10) -> list[dict[str, object]]:
    tokenized_corpus = [tokenize(str(chunk.get("chunk_text") or "")) for chunk in chunks]
    if not tokenized_corpus:
        return []

    bm25 = BM25Okapi(tokenized_corpus)
    scores = bm25.get_scores(tokenize(query))
    ranked_indexes = sorted(range(len(scores)), key=lambda index: scores[index], reverse=True)[:limit]
    return [{**chunks[index], "bm25_score": float(scores[index])} for index in ranked_indexes]


def _reciprocal_rank_fusion(rankings: list[list[dict[str, object]]], rank_constant: int = 60) -> list[str]:
    fused_scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, row in enumerate(ranking, start=1):
            chunk_id = str(row.get("id") or "")
            if not chunk_id:
                continue
            fused_scores[chunk_id] = fused_scores.get(chunk_id, 0.0) + 1.0 / (rank_constant + rank)
    return [chunk_id for chunk_id, _ in sorted(fused_scores.items(), key=lambda item: item[1], reverse=True)]


async def _document_hybrid_search(
    query: str,
    *,
    chunk_limit: int = 3,
    max_chunk_limit: int = 10,
    dense_limit: int = 10,
    sparse_limit: int = 10,
    rank_constant: int = 60,
    structured: bool = False,
) -> str | list[dict[str, object]]:
    query = query.strip()
    chunk_limit = max(1, min(int(chunk_limit or 3), int(max_chunk_limit or 10)))
    dense_limit = max(1, int(dense_limit or 10))
    sparse_limit = max(1, int(sparse_limit or 10))
    query_embedding = _query_embedding(query)

    document_id = _current_document_id.get()
    dense_matches, all_chunks = await asyncio.gather(
        _fetch_dense_matches(query_embedding, document_id, dense_limit),
        _fetch_all_chunks(document_id),
    )
    sparse_matches = _sparse_bm25_matches(query, all_chunks, limit=sparse_limit)

    chunks_by_id = {str(chunk.get("id")): chunk for chunk in all_chunks}
    for dense_match in dense_matches:
        chunks_by_id[str(dense_match.get("id"))] = dense_match

    dense_scores = {str(row.get("id")): float(row.get("distance", 0.0) or 0.0) for row in dense_matches}
    bm25_scores = {str(row.get("id")): float(row.get("bm25_score", 0.0) or 0.0) for row in sparse_matches}
    rerank_order = _reciprocal_rank_fusion([dense_matches, sparse_matches], rank_constant=rank_constant)
    fused_chunk_ids = rerank_order[:chunk_limit]
    if not fused_chunk_ids:
        return [] if structured else "No relevant chunks found."

    source_records: list[dict[str, object]] = []
    for rank, chunk_id in enumerate(fused_chunk_ids, start=1):
        chunk = chunks_by_id[chunk_id]
        metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
        source_records.append({
            "chunk_id": chunk_id,
            "page": metadata.get("page"),
            "chunk": metadata.get("chunk"),
            "chunk_text": str(chunk.get("chunk_text") or ""),
            "dense_score": dense_scores.get(chunk_id),
            "bm25_score": bm25_scores.get(chunk_id),
            "rerank_score": 1.0 / (rank_constant + rank),
        })

    if structured:
        return source_records

    return "\n\n".join(str(record.get("chunk_text") or "") for record in source_records)


async def document_hybrid_search(
    field_name: str = "",
    definition: str = "",
    *,
    query: str | None = None,
    chunk_limit: int = 3,
    max_chunk_limit: int = 10,
    dense_limit: int = 10,
    sparse_limit: int = 10,
    rank_constant: int = 60,
    structured: bool = False,
) -> str | list[dict[str, object]]:
    """Return top chunks using pgvector + BM25 reciprocal rank fusion.

    ``chunk_limit`` defaults to the narrow scalar-field window but callers can
    request a wider evidence window for narrative/summary fields.
    """

    search_query = query if query is not None else f"{field_name} {definition}".strip()
    return await _document_hybrid_search(
        search_query,
        chunk_limit=chunk_limit,
        max_chunk_limit=max_chunk_limit,
        dense_limit=dense_limit,
        sparse_limit=sparse_limit,
        rank_constant=rank_constant,
        structured=structured,
    )


search_tool = FunctionTool(document_hybrid_search)

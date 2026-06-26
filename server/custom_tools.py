"""Custom ADK tools used by BExtractor agents."""

from __future__ import annotations

from google.adk.tools import FunctionTool

from server.ingestion import MOCK_INDEX, bm25_score, ensure_seed_index, tokenize, vector_score


def _rank_by_score(scores: dict[str, float]) -> list[str]:
    return [chunk_id for chunk_id, _ in sorted(scores.items(), key=lambda item: item[1], reverse=True)]


def document_hybrid_search(field_name: str, definition: str) -> str:
    """Return the top three layout-aware chunks using simulated hybrid RAG search."""

    ensure_seed_index()
    query = f"{field_name} {definition}".strip()
    query_terms = tokenize(query)

    vector_scores = {chunk_id: vector_score(query_terms, chunk_id) for chunk_id in MOCK_INDEX["chunks"]}
    bm25_scores = {chunk_id: bm25_score(query_terms, chunk_id) for chunk_id in MOCK_INDEX["chunks"]}
    vector_ranking = _rank_by_score(vector_scores)
    bm25_ranking = _rank_by_score(bm25_scores)

    fused_scores: dict[str, float] = {}
    rank_constant = 60
    for ranking in (vector_ranking, bm25_ranking):
        for rank, chunk_id in enumerate(ranking, start=1):
            fused_scores[chunk_id] = fused_scores.get(chunk_id, 0.0) + 1.0 / (rank_constant + rank)

    top_chunk_ids = [chunk_id for chunk_id, _ in sorted(fused_scores.items(), key=lambda item: item[1], reverse=True)[:3]]
    if not top_chunk_ids:
        return "No relevant chunks found."

    formatted_chunks = []
    for position, chunk_id in enumerate(top_chunk_ids, start=1):
        chunk = MOCK_INDEX["chunks"][chunk_id]
        formatted_chunks.append(f"{position}. [{chunk.chunk_type}] {chunk.content}")
    return "\n\n".join(formatted_chunks)


search_tool = FunctionTool.from_function(document_hybrid_search)

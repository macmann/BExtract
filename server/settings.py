"""Runtime settings normalization shared by extraction pipelines."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuntimeSettings:
    empty_results_max_retries: int = 3
    extraction_model: str = "gemini-3.5-flash"
    critic_model: str = "gemini-3.5-flash"
    scalar_chunk_limit: int = 3
    narrative_chunk_limit: int = 8
    max_chunk_limit: int = 10
    retry_chunk_expansion_step: int = 2
    dense_candidate_limit: int = 10
    sparse_candidate_limit: int = 10
    rank_fusion_constant: int = 60
    query_min_words: int = 3
    query_max_words: int = 5
    prior_result_preview_chars: int = 1000
    enforce_flat_json: bool = True
    response_mime_type: str = "application/json"
    input_rate_per_million: float = 1.50
    output_rate_per_million: float = 9.00


def _as_int(value: Any, default: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return min(maximum, max(minimum, parsed))


def _as_float(value: Any, default: float, *, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return min(maximum, max(minimum, parsed))


def _as_str(value: Any, default: str) -> str:
    if value is None:
        return default
    parsed = str(value).strip()
    return parsed or default


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return default


def runtime_settings_from_template(template_payload: dict[str, Any] | None) -> RuntimeSettings:
    """Return normalized runtime settings from a template payload."""

    payload = template_payload or {}
    raw_settings = payload.get("runtimeSettings")
    settings = raw_settings if isinstance(raw_settings, dict) else {}
    defaults = RuntimeSettings()

    empty_retries = settings.get("emptyResultsMaxRetries", payload.get("emptyResultsMaxRetries"))
    scalar_chunk_limit = _as_int(settings.get("scalarChunkLimit"), defaults.scalar_chunk_limit, minimum=1, maximum=25)
    narrative_chunk_limit = _as_int(settings.get("narrativeChunkLimit"), defaults.narrative_chunk_limit, minimum=1, maximum=25)
    max_chunk_limit = _as_int(settings.get("maxChunkLimit"), defaults.max_chunk_limit, minimum=1, maximum=50)
    query_min_words = _as_int(settings.get("queryMinWords"), defaults.query_min_words, minimum=1, maximum=20)
    query_max_words = _as_int(settings.get("queryMaxWords"), defaults.query_max_words, minimum=1, maximum=20)

    return RuntimeSettings(
        empty_results_max_retries=_as_int(empty_retries, defaults.empty_results_max_retries, minimum=0, maximum=10),
        extraction_model=_as_str(settings.get("extractionModel"), defaults.extraction_model),
        critic_model=_as_str(settings.get("criticModel"), defaults.critic_model),
        scalar_chunk_limit=scalar_chunk_limit,
        narrative_chunk_limit=max(narrative_chunk_limit, scalar_chunk_limit),
        max_chunk_limit=max(max_chunk_limit, scalar_chunk_limit),
        retry_chunk_expansion_step=_as_int(settings.get("retryChunkExpansionStep"), defaults.retry_chunk_expansion_step, minimum=0, maximum=10),
        dense_candidate_limit=_as_int(settings.get("denseCandidateLimit"), defaults.dense_candidate_limit, minimum=1, maximum=50),
        sparse_candidate_limit=_as_int(settings.get("sparseCandidateLimit"), defaults.sparse_candidate_limit, minimum=1, maximum=50),
        rank_fusion_constant=_as_int(settings.get("rankFusionConstant"), defaults.rank_fusion_constant, minimum=1, maximum=200),
        query_min_words=query_min_words,
        query_max_words=max(query_max_words, query_min_words),
        prior_result_preview_chars=_as_int(settings.get("priorResultPreviewChars"), defaults.prior_result_preview_chars, minimum=0, maximum=5000),
        enforce_flat_json=_as_bool(settings.get("enforceFlatJson"), defaults.enforce_flat_json),
        response_mime_type=_as_str(settings.get("responseMimeType"), defaults.response_mime_type),
        input_rate_per_million=_as_float(settings.get("inputRatePerMillion"), defaults.input_rate_per_million, minimum=0, maximum=100),
        output_rate_per_million=_as_float(settings.get("outputRatePerMillion"), defaults.output_rate_per_million, minimum=0, maximum=100),
    )

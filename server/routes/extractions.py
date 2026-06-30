from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import APIRouter, HTTPException, status
from prisma import Prisma
from pydantic import BaseModel, ConfigDict, Field, model_validator

from server.db_schema import ensure_verified_field_examples_table

router = APIRouter(prefix="/api/extractions", tags=["extractions"])

MAX_VERIFIED_EXAMPLES_PER_FIELD = 5


class VerifiedFieldPayload(BaseModel):
    """One frontend-approved or manually corrected field value."""

    model_config = ConfigDict(extra="forbid")

    field_id: str = Field(..., min_length=1)
    corrected_value: Any
    input_context_chunk: str = Field(..., min_length=1)


class VerifyExtractionPayload(BaseModel):
    """Payload accepted by the extraction verification endpoint.

    The preferred shape is ``{"fields": [...]}``, which lets each corrected
    field carry the exact RAG context chunk used for that field turn. For
    simple clients, ``corrected_fields`` may be provided with a shared
    ``input_context_chunk``.
    """

    model_config = ConfigDict(extra="forbid")

    fields: list[VerifiedFieldPayload] | None = None
    corrected_fields: dict[str, Any] | None = None
    input_context_chunk: str | None = Field(default=None, min_length=1)
    template_id: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def require_field_examples(self) -> "VerifyExtractionPayload":
        if self.fields:
            return self
        if self.corrected_fields and self.input_context_chunk:
            self.fields = [
                VerifiedFieldPayload(
                    field_id=field_id,
                    corrected_value=corrected_value,
                    input_context_chunk=self.input_context_chunk,
                )
                for field_id, corrected_value in self.corrected_fields.items()
            ]
            return self
        raise ValueError("Provide either fields or corrected_fields with input_context_chunk")


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _context_hash(input_context_chunk: str) -> str:
    return hashlib.sha256(input_context_chunk.encode("utf-8")).hexdigest()


@router.post("/{extraction_id}/verify", status_code=status.HTTP_200_OK)
async def verify_extraction(extraction_id: str, payload: VerifyExtractionPayload) -> dict[str, Any]:
    """Record human-verified field examples and mark an extraction verified."""

    client = Prisma()
    await client.connect()
    try:
        await ensure_verified_field_examples_table(client)
        rows = await client.query_raw(
            """
            SELECT fe."id"::text, pr."template_id"
            FROM "file_extractions" fe
            JOIN "pipeline_runs" pr ON pr."id" = fe."run_id"
            WHERE fe."id" = $1::uuid
            LIMIT 1
            """,
            extraction_id,
        )
        if not rows:
            raise HTTPException(status_code=404, detail="File extraction not found")

        row = dict(rows[0])
        template_id = payload.template_id or row.get("template_id")
        if not template_id:
            raise HTTPException(
                status_code=422,
                detail="A template_id is required because the extraction's pipeline run has no template_id",
            )

        verified_fields = payload.fields or []
        for field in verified_fields:
            await client.execute_raw(
                """
                INSERT INTO "verified_field_examples"
                    ("template_id", "field_id", "input_context_chunk", "context_hash", "corrected_value")
                VALUES ($1, $2, $3, $4, $5::jsonb)
                ON CONFLICT ("template_id", "field_id", "context_hash")
                DO UPDATE SET
                    "input_context_chunk" = EXCLUDED."input_context_chunk",
                    "corrected_value" = EXCLUDED."corrected_value",
                    "updated_at" = NOW()
                """,
                template_id,
                field.field_id,
                field.input_context_chunk,
                _context_hash(field.input_context_chunk),
                _json_dumps(field.corrected_value),
            )
            await client.execute_raw(
                """
                DELETE FROM "verified_field_examples"
                WHERE "id" IN (
                    SELECT "id"
                    FROM "verified_field_examples"
                    WHERE "template_id" = $1 AND "field_id" = $2
                    ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
                    OFFSET $3
                )
                """,
                template_id,
                field.field_id,
                MAX_VERIFIED_EXAMPLES_PER_FIELD,
            )

        await client.execute_raw(
            """
            UPDATE "file_extractions"
            SET "status" = 'human_verified'::"PipelineExecutionStatus",
                "error_message" = NULL
            WHERE "id" = $1::uuid
            """,
            extraction_id,
        )

        return {
            "extraction_id": extraction_id,
            "status": "human_verified",
            "template_id": template_id,
            "verified_examples_written": len(verified_fields),
            "max_examples_per_field": MAX_VERIFIED_EXAMPLES_PER_FIELD,
        }
    finally:
        await client.disconnect()

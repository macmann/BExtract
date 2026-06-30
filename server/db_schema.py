from __future__ import annotations

from prisma import Prisma


async def ensure_file_extraction_source_path_column(client: Prisma) -> None:
    """Ensure legacy databases can store the source PDF path for result previews.

    Some installations were created before the source PDF column was added. The
    application writes to and reads from this column during extraction/results, so
    make the additive schema change idempotently at runtime as a safety net for
    databases that have not yet had the latest Prisma migration applied.
    """

    await client.execute_raw(
        'ALTER TABLE "file_extractions" ADD COLUMN IF NOT EXISTS "source_file_path" TEXT'
    )


async def ensure_human_verified_status(client: Prisma) -> None:
    """Ensure the extraction status enum can represent human verification."""

    await client.execute_raw(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_enum e
                JOIN pg_type t ON t.oid = e.enumtypid
                WHERE t.typname = 'PipelineExecutionStatus'
                  AND e.enumlabel = 'human_verified'
            ) THEN
                ALTER TYPE "PipelineExecutionStatus" ADD VALUE 'human_verified';
            END IF;
        END $$;
        """
    )


async def ensure_verified_field_examples_table(client: Prisma) -> None:
    """Ensure storage exists for human-verified golden field examples."""

    await ensure_human_verified_status(client)
    await client.execute_raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')
    await client.execute_raw(
        """
        CREATE TABLE IF NOT EXISTS "verified_field_examples" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "template_id" TEXT NOT NULL,
            "field_id" TEXT NOT NULL,
            "input_context_chunk" TEXT NOT NULL,
            "context_hash" TEXT NOT NULL,
            "corrected_value" JSONB NOT NULL,
            "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    await client.execute_raw(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS "verified_field_examples_template_field_context_key"
        ON "verified_field_examples" ("template_id", "field_id", "context_hash")
        """
    )
    await client.execute_raw(
        """
        CREATE INDEX IF NOT EXISTS "verified_field_examples_template_field_updated_idx"
        ON "verified_field_examples" ("template_id", "field_id", "updated_at" DESC)
        """
    )

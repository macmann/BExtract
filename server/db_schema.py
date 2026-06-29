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

-- Add a terminal status for extraction rows after a user approves or overrides values.
ALTER TYPE "PipelineExecutionStatus" ADD VALUE IF NOT EXISTS 'human_verified';

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "verified_field_examples" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "template_id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "input_context_chunk" TEXT NOT NULL,
    "context_hash" TEXT NOT NULL,
    "corrected_value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "verified_field_examples_template_field_context_key"
    ON "verified_field_examples" ("template_id", "field_id", "context_hash");

CREATE INDEX IF NOT EXISTS "verified_field_examples_template_field_updated_idx"
    ON "verified_field_examples" ("template_id", "field_id", "updated_at" DESC);

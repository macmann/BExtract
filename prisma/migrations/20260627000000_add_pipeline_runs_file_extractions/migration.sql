-- CreateEnum
CREATE TYPE "PipelineExecutionStatus" AS ENUM ('processing', 'success', 'failed');

-- CreateTable
CREATE TABLE "pipeline_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" TEXT,
    "status" "PipelineExecutionStatus" NOT NULL DEFAULT 'processing',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "total_files" INTEGER NOT NULL,
    "processed_files" INTEGER NOT NULL DEFAULT 0,
    "total_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0.0,

    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_extractions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "status" "PipelineExecutionStatus" NOT NULL DEFAULT 'processing',
    "extracted_payload" JSONB NOT NULL DEFAULT '{}',
    "logs" TEXT NOT NULL DEFAULT '',
    "error_message" TEXT,

    CONSTRAINT "file_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pipeline_runs_template_id_idx" ON "pipeline_runs"("template_id");

-- CreateIndex
CREATE INDEX "pipeline_runs_status_idx" ON "pipeline_runs"("status");

-- CreateIndex
CREATE INDEX "file_extractions_run_id_idx" ON "file_extractions"("run_id");

-- CreateIndex
CREATE INDEX "file_extractions_status_idx" ON "file_extractions"("status");

-- AddForeignKey
ALTER TABLE "file_extractions" ADD CONSTRAINT "file_extractions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

export type RunStatus = "success" | "processing" | "failure";

export type SourceWord = { text: string; x0?: number; y0?: number; x1?: number; y1?: number; index?: number };

export type SourceBBox = { x0: number; y0: number; x1: number; y1: number };

export type SourceChunk = {
  chunk_id: string;
  page?: string | number | null;
  chunk?: string | number | null;
  chunk_text: string;
  bbox?: SourceBBox | null;
  words?: SourceWord[];
  page_width?: number | null;
  page_height?: number | null;
  dense_score?: number | null;
  bm25_score?: number | null;
  rerank_score?: number | null;
};

export type ExtractedFieldResult = {
  item_id?: string;
  field_name?: string;
  value?: unknown;
  unit?: string | null;
  confidence?: number | string | null;
  evidence?: string | null;
  critique_response?: string | null;
  source_chunks?: SourceChunk[];
  sources?: SourceChunk[];
  [key: string]: unknown;
};

export type ExtractedPayload = Record<string, ExtractedFieldResult | unknown>;

export type RunDocument = {
  id: string;
  fileName: string;
  status: RunStatus;
  emptyFields: string[];
  extractedFields: number;
  totalFields: number;
  logs: string[];
  errorMessage?: string | null;
  extractedPayload?: ExtractedPayload | unknown;
  sourceFileAvailable: boolean;
};

export type HistoricalRun = {
  id: string;
  startedAt: string;
  completedAt?: string | null;
  filesProcessed: number;
  totalFiles: number;
  totalCost: number;
  status: RunStatus;
  templateId?: string | null;
  inputTokens: number;
  outputTokens: number;
  documents: RunDocument[];
};

type ApiRun = {
  id: string;
  template_id?: string | null;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  total_files?: number | null;
  processed_files?: number | null;
  total_input_tokens?: number | null;
  total_output_tokens?: number | null;
  total_cost_usd?: number | string | null;
  files?: ApiFile[];
};

type ApiFile = {
  id: string;
  file_name?: string | null;
  status?: string | null;
  logs?: string | string[] | null;
  error_message?: string | null;
  extracted_payload?: unknown;
  source_file_available?: boolean | null;
};

function normalizeStatus(status?: string | null): RunStatus {
  if (status === "success" || status === "processing" || status === "failure") return status;
  if (status === "completed") return "success";
  if (status === "failed" || status === "error") return "failure";
  return "processing";
}

function numeric(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function countPayloadFields(payload: unknown): { extractedFields: number; totalFields: number; emptyFields: string[] } {
  if (!payload || typeof payload !== "object") {
    return { extractedFields: payload == null ? 0 : 1, totalFields: payload == null ? 0 : 1, emptyFields: [] };
  }

  let extractedFields = 0;
  let totalFields = 0;
  const emptyFields: string[] = [];

  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        totalFields += 1;
        emptyFields.push(path);
        return;
      }
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        totalFields += 1;
        emptyFields.push(path);
        return;
      }
      entries.filter(([key]) => key !== "source_chunks" && key !== "sources").forEach(([key, child]) => visit(child, path ? `${path}.${key}` : key));
      return;
    }

    totalFields += 1;
    if (value === null || value === undefined || value === "") emptyFields.push(path);
    else extractedFields += 1;
  };

  visit(payload, "");
  return { extractedFields, totalFields, emptyFields: emptyFields.filter(Boolean) };
}

function normalizeLogs(logs: ApiFile["logs"]): string[] {
  if (Array.isArray(logs)) return logs.map(String).filter(Boolean);
  if (typeof logs === "string") return logs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [];
}

export function mapApiRun(apiRun: ApiRun): HistoricalRun {
  const documents = (apiRun.files ?? []).map((file): RunDocument => {
    const fieldCounts = countPayloadFields(file.extracted_payload);
    return {
      id: file.id,
      fileName: file.file_name || file.id,
      status: normalizeStatus(file.status),
      logs: normalizeLogs(file.logs),
      errorMessage: file.error_message,
      extractedPayload: file.extracted_payload,
      sourceFileAvailable: Boolean(file.source_file_available),
      ...fieldCounts,
    };
  });

  return {
    id: apiRun.id,
    startedAt: apiRun.started_at || new Date(0).toISOString(),
    completedAt: apiRun.completed_at,
    filesProcessed: numeric(apiRun.processed_files),
    totalFiles: numeric(apiRun.total_files),
    totalCost: numeric(apiRun.total_cost_usd),
    status: normalizeStatus(apiRun.status),
    templateId: apiRun.template_id,
    inputTokens: numeric(apiRun.total_input_tokens),
    outputTokens: numeric(apiRun.total_output_tokens),
    documents,
  };
}

export async function fetchHistoricalRuns(): Promise<HistoricalRun[]> {
  const response = await fetch("/api/results", { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load results history (${response.status})`);
  const runs = (await response.json()) as ApiRun[];
  return runs.map(mapApiRun);
}

export async function fetchHistoricalRun(runId: string): Promise<HistoricalRun | null> {
  const response = await fetch(`/api/results/${encodeURIComponent(runId)}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to load result ${runId} (${response.status})`);
  return mapApiRun((await response.json()) as ApiRun);
}

export async function deleteHistoricalRun(runId: string): Promise<void> {
  const response = await fetch(`/api/results/${encodeURIComponent(runId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Failed to delete result ${runId} (${response.status})`);
}

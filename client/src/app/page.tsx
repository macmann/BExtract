"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  DatabaseZap,
  Download,
  FileJson,
  FolderOpen,
  Gauge,
  Layers3,
  MoreVertical,
  Play,
  Plus,
  Save,
  RefreshCw,
  Search,
  ShieldCheck,
  Settings2,
  TerminalSquare,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";

type RouteType = "Scalar" | "Tabular";
type DataType = "String" | "Float" | "Date" | "Text Summary";
type ExtractionApproach = "pre_injected" | "agentic";

type RuntimeSettings = {
  emptyResultsMaxRetries: number;
  extractionModel: string;
  criticModel: string;
  scalarChunkLimit: number;
  narrativeChunkLimit: number;
  maxChunkLimit: number;
  retryChunkExpansionStep: number;
  denseCandidateLimit: number;
  sparseCandidateLimit: number;
  rankFusionConstant: number;
  queryMinWords: number;
  queryMaxWords: number;
  priorResultPreviewChars: number;
  enforceFlatJson: boolean;
  responseMimeType: string;
  inputRatePerMillion: number;
  outputRatePerMillion: number;
};

type FieldCard = {
  id: number;
  name: string;
  definition: string;
  routeType: RouteType;
  dataType: DataType;
};

type ExtractionResult = {
  fieldId?: string;
  field: string;
  value: string;
  confidence: string;
  status: "validated" | "alert";
  alert?: string;
};

type BatchExportRecord = Record<string, string | number | boolean | null>;

type RuntimeLog = {
  time: string;
  tone: "info" | "success" | "warn" | "error";
  text: string;
};

type TokenCostMetrics = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_cost: number;
  output_cost: number;
  total_cost: number;
};

type DebugRunMetrics = {
  runId: string;
  chunkCount: number | null;
  elapsedSeconds: number | null;
};

type SavedTemplate = {
  id: string;
  name: string;
  fields: FieldCard[];
  extractionApproach: ExtractionApproach;
  runtimeSettings: RuntimeSettings;
  updatedAt: string;
};

type TemplateImportPayload = {
  id?: string;
  name?: string;
  fields?: Partial<FieldCard>[];
  items?: Partial<FieldCard>[];
  extractionApproach?: ExtractionApproach;
  runtimeSettings?: Partial<RuntimeSettings>;
  emptyResultsMaxRetries?: number;
  updatedAt?: string;
};

type ToastState = {
  id: number;
  tone: RuntimeLog["tone"];
  message: string;
};

const TEMPLATE_STORAGE_KEY = "bextract.savedTemplates";
const runtimeSettingsSchema = [
  { key: "emptyResultsMaxRetries", label: "Empty Results Max Retry", type: "number", defaultValue: 3, min: 0, max: 10, step: 1, description: "Controls how many times null or empty extracted fields are retried before returning the final payload." },
  { key: "extractionModel", label: "Extraction Model", type: "text", defaultValue: "gemini-3.5-flash", description: "Model used by the pre-injected extractor and empty-result verifier." },
  { key: "criticModel", label: "Critic Model", type: "text", defaultValue: "gemini-3.5-flash", description: "Reserved for critic/agentic validation model selection." },
  { key: "scalarChunkLimit", label: "Scalar Chunk Limit", type: "number", defaultValue: 3, min: 1, max: 10, step: 1, description: "Evidence chunks supplied for scalar or categorical fields." },
  { key: "narrativeChunkLimit", label: "Narrative Chunk Limit", type: "number", defaultValue: 8, min: 1, max: 10, step: 1, description: "Evidence chunks supplied for narrative or summary fields." },
  { key: "maxChunkLimit", label: "Maximum Chunk Limit", type: "number", defaultValue: 10, min: 1, max: 25, step: 1, description: "Upper bound for final fused chunks returned to extraction prompts." },
  { key: "retryChunkExpansionStep", label: "Retry Chunk Expansion", type: "number", defaultValue: 2, min: 0, max: 10, step: 1, description: "Additional chunks requested per empty-result retry attempt." },
  { key: "denseCandidateLimit", label: "Dense Candidate Limit", type: "number", defaultValue: 10, min: 1, max: 50, step: 1, description: "Nearest-vector candidates considered before rank fusion." },
  { key: "sparseCandidateLimit", label: "Sparse Candidate Limit", type: "number", defaultValue: 10, min: 1, max: 50, step: 1, description: "BM25 candidates considered before rank fusion." },
  { key: "rankFusionConstant", label: "Rank Fusion Constant", type: "number", defaultValue: 60, min: 1, max: 200, step: 1, description: "Reciprocal-rank-fusion smoothing constant." },
  { key: "queryMinWords", label: "Query Min Words", type: "number", defaultValue: 3, min: 1, max: 10, step: 1, description: "Minimum target words for generated retrieval queries." },
  { key: "queryMaxWords", label: "Query Max Words", type: "number", defaultValue: 5, min: 1, max: 20, step: 1, description: "Maximum target words for generated retrieval queries." },
  { key: "priorResultPreviewChars", label: "Prior Result Preview", type: "number", defaultValue: 1000, min: 0, max: 5000, step: 100, description: "Characters of previous empty output included in retry prompts." },
  { key: "enforceFlatJson", label: "Enforce Flat JSON", type: "boolean", defaultValue: true, description: "Adds guardrails that keep evidence and critique fields as plain text." },
  { key: "responseMimeType", label: "Response MIME Type", type: "text", defaultValue: "application/json", description: "Generation response MIME type for model calls." },
  { key: "inputRatePerMillion", label: "Input $ / 1M Tokens", type: "number", defaultValue: 1.5, min: 0, max: 100, step: 0.01, description: "Input token rate used for estimated run costs." },
  { key: "outputRatePerMillion", label: "Output $ / 1M Tokens", type: "number", defaultValue: 9, min: 0, max: 100, step: 0.01, description: "Output token rate used for estimated run costs." },
] as const;


type RuntimeSettingsField = (typeof runtimeSettingsSchema)[number];

const defaultRuntimeSettings = runtimeSettingsSchema.reduce((settings, field) => ({
  ...settings,
  [field.key]: field.defaultValue,
}), {} as RuntimeSettings);

const normalizeRuntimeSettingValue = (field: RuntimeSettingsField, value: unknown): string | number | boolean => {
  if (field.type === "boolean") return Boolean(value);
  if (field.type === "text") {
    const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
    return text || field.defaultValue;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return field.defaultValue;
  const stepped = field.step && field.step < 1 ? parsed : Math.trunc(parsed);
  return Math.min(field.max, Math.max(field.min, stepped));
};

const normalizeRuntimeSettings = (settings?: Partial<RuntimeSettings>): RuntimeSettings => {
  const normalized = runtimeSettingsSchema.reduce((nextSettings, field) => ({
    ...nextSettings,
    [field.key]: normalizeRuntimeSettingValue(field, settings?.[field.key]),
  }), {} as RuntimeSettings);
  if (normalized.queryMaxWords < normalized.queryMinWords) {
    normalized.queryMaxWords = normalized.queryMinWords;
  }
  if (normalized.narrativeChunkLimit < normalized.scalarChunkLimit) {
    normalized.narrativeChunkLimit = normalized.scalarChunkLimit;
  }
  return normalized;
};

const initialFields: FieldCard[] = [
  {
    id: 1,
    name: "Total Commitment",
    definition:
      "Committed capital amount, including amendments and side-letter adjustments.",
    routeType: "Scalar",
    dataType: "Float",
  },
  {
    id: 2,
    name: "Fee Schedule",
    definition:
      "Extract tabular management fee tiers with basis, rate, and effective date.",
    routeType: "Tabular",
    dataType: "String",
  },
];

const extractionApproachOptions: {
  value: ExtractionApproach;
  label: string;
}[] = [
  { value: "pre_injected", label: "Pre-Injected RAG (Fast/Cheap)" },
  { value: "agentic", label: "Agentic RAG (Deep Reasoning)" },
];

const initialLogs: RuntimeLog[] = [
  {
    time: "--:--:--",
    tone: "info",
    text: "Upload a PDF and run extraction to stream backend logs.",
  },
];

const initialResults: ExtractionResult[] = [];

const initialDebugRunMetrics: DebugRunMetrics = {
  runId: "Not started",
  chunkCount: null,
  elapsedSeconds: null,
};

function UploadDropzone({
  files,
  onFilesChange,
}: {
  files: File[];
  onFilesChange: (files: File[]) => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-dashed border-cyan-400/40 bg-cyan-400/[0.03] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition hover:border-cyan-300/70 hover:bg-cyan-400/[0.06]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-200">
          <UploadCloud className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-cyan-100">
            Upload Document
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {files.length > 0
              ? files.map((selectedFile) => selectedFile.name).join(", ")
              : "Drop or browse for one or more PDFs. OCR and chunking start when you run extraction."}
          </p>
        </div>
        <label className="cursor-pointer rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 shadow-sm transition hover:border-cyan-300 hover:text-cyan-100">
          Browse
          <input
            className="sr-only"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onFilesChange(Array.from(event.target.files ?? []))
            }
          />
        </label>
      </div>
    </div>
  );
}

function FieldCardEditor({
  field,
  result,
  onChange,
  onRemove,
}: {
  field: FieldCard;
  result?: ExtractionResult;
  onChange: (field: FieldCard) => void;
  onRemove: () => void;
}) {
  return (
    <article className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-4 shadow-2xl shadow-black/20">
      <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
          <Layers3 className="h-4 w-4 text-cyan-300" /> Field Card #{field.id}
        </div>
        <div className="flex items-center gap-2">
          {result?.status === "validated" && (
            <CheckCircle2
              className="h-5 w-5 text-emerald-300"
              aria-label="Verified field"
            />
          )}
          {result?.status === "alert" && (
            <AlertTriangle
              className="h-5 w-5 text-red-300"
              aria-label="Validation alert"
            />
          )}
          <button
            onClick={onRemove}
            className="rounded-md p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-300"
            aria-label="Remove field"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Field Name</span>
          <input
            value={field.name}
            onChange={(event) =>
              onChange({ ...field, name: event.target.value })
            }
            className="terminal-input"
            placeholder="e.g. NAV"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Data Type</span>
          <div className="relative">
            <select
              value={field.dataType}
              onChange={(event) =>
                onChange({ ...field, dataType: event.target.value as DataType })
              }
              className="terminal-input appearance-none pr-9"
            >
              {(["String", "Float", "Date", "Text Summary"] as DataType[]).map(
                (type) => (
                  <option key={type}>{type}</option>
                ),
              )}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-500" />
          </div>
        </label>
      </div>
      <label className="mt-3 block space-y-1.5">
        <span className="text-xs font-medium text-slate-300">Definition</span>
        <textarea
          value={field.definition}
          onChange={(event) =>
            onChange({ ...field, definition: event.target.value })
          }
          className="terminal-input min-h-20 resize-none"
          placeholder="Describe source language, constraints, and validation rules."
        />
      </label>
      <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-xl border border-slate-700 bg-slate-950 p-1">
        {(["Scalar", "Tabular"] as RouteType[]).map((route) => (
          <button
            key={route}
            onClick={() => onChange({ ...field, routeType: route })}
            className={`rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] transition ${field.routeType === route ? "bg-cyan-300 text-slate-950" : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"}`}
          >
            {route}
          </button>
        ))}
      </div>
      {result && (
        <div
          className={`mt-4 rounded-xl border p-3 ${result.status === "alert" ? "border-red-300/50 bg-red-950/30" : "border-emerald-300/30 bg-emerald-400/[0.06]"}`}
        >
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">
            Extracted Value
          </p>
          <p className="mt-1 text-sm font-semibold text-slate-50">
            {result.value || "No value returned"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Confidence {result.confidence}
          </p>
          {result.status === "alert" && (
            <p className="mt-2 text-xs font-semibold text-red-200">
              {result.alert}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function BExtractorLogo({
  isActive,
  size = "lg",
}: {
  isActive: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClasses = {
    sm: { wrapper: "h-10 w-10", inset: "inset-1", svg: "h-7 w-7" },
    md: { wrapper: "h-14 w-14", inset: "inset-2", svg: "h-10 w-10" },
    lg: { wrapper: "h-28 w-28", inset: "inset-3", svg: "h-20 w-20" },
  }[size];

  return (
    <div
      className={`relative flex ${sizeClasses.wrapper} items-center justify-center`}
      aria-label="BExtractor animated processing logo"
    >
      <div
        className={`absolute inset-0 rounded-full bg-[conic-gradient(from_90deg,rgba(34,211,238,0),rgba(34,211,238,0.85),rgba(16,185,129,0.75),rgba(34,211,238,0))] p-px ${isActive ? "animate-spin" : ""}`}
      >
        <div className="h-full w-full rounded-full bg-slate-950" />
      </div>
      <div
        className={`absolute ${sizeClasses.inset} rounded-full border border-cyan-300/20 bg-cyan-300/5 shadow-[0_0_40px_rgba(34,211,238,0.22)] ${isActive ? "animate-pulse" : ""}`}
      />
      <svg
        viewBox="0 0 96 96"
        className={`relative ${sizeClasses.svg} drop-shadow-[0_0_18px_rgba(34,211,238,0.45)]`}
        role="img"
        aria-hidden="true"
      >
        <path
          d="M29 12h25l15 15v48a9 9 0 0 1-9 9H29a9 9 0 0 1-9-9V21a9 9 0 0 1 9-9Z"
          className="fill-slate-900 stroke-cyan-200/80"
          strokeWidth="3"
        />
        <path
          d="M54 12v14a5 5 0 0 0 5 5h10"
          className="fill-none stroke-emerald-300/80"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M33 37h20M33 48h14M33 59h11"
          className="stroke-slate-400"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M47 70c4-8 8-16 12-24h-9l5-16-18 26h10l-4 14Z"
          className="fill-emerald-300 stroke-emerald-100"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <circle
          cx="61"
          cy="61"
          r="11"
          className="fill-slate-950/80 stroke-cyan-200"
          strokeWidth="4"
        />
        <path
          d="m69 69 11 11"
          className="stroke-cyan-200"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <circle cx="22" cy="24" r="2.5" className="fill-cyan-300" />
        <circle cx="76" cy="44" r="2.5" className="fill-emerald-300" />
      </svg>
    </div>
  );
}

function ExtractionLoadingPanel({
  logs,
  isLoading,
  onCancel,
}: {
  logs: RuntimeLog[];
  isLoading: boolean;
  onCancel: () => void;
}) {
  const activeLog = logs.at(-1)?.text ?? "Initializing extraction stream...";

  return (
    <section
      className={`fixed inset-0 z-40 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px] transition-all duration-500 ${isLoading ? "opacity-100" : "pointer-events-none opacity-0"}`}
      aria-live="polite"
      aria-busy={isLoading}
    >
      <div className="w-full max-w-4xl overflow-hidden rounded-3xl border border-cyan-300/25 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.16),transparent_34%),linear-gradient(135deg,rgba(15,23,42,0.96),rgba(2,6,23,0.94))] p-5 shadow-2xl shadow-cyan-950/50">
        <div className="mb-4 flex justify-end">
          <button
            onClick={onCancel}
            className="inline-flex items-center gap-2 rounded-xl border border-red-300/40 bg-red-400/10 px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-red-100 transition hover:border-red-200 hover:bg-red-400/20"
          >
            <X className="h-4 w-4" /> Cancel
          </button>
        </div>
        <div className="grid min-w-0 items-center gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col items-center overflow-hidden text-center">
            <BExtractorLogo isActive={isLoading} />
            <p className="mt-3 text-xs font-black uppercase tracking-[0.28em] text-cyan-200">
              BExtractor Active
            </p>
            <div className="mt-2 flex w-full min-w-0 items-center justify-center gap-2 text-xs text-slate-400">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]" />
              <span className="min-w-0 max-w-full truncate">{activeLog}</span>
            </div>
          </div>
          <LogsPanel
            logs={logs}
            isLoading={isLoading}
            compact
            title="Runtime Extraction Logs"
          />
        </div>
      </div>
    </section>
  );
}

function ExtractionSuccessModal({
  onViewResults,
}: {
  onViewResults: () => void;
}) {
  return (
    <section
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="extraction-success-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-emerald-300/40 bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.18),transparent_36%),linear-gradient(135deg,rgba(15,23,42,0.98),rgba(2,6,23,0.96))] p-6 text-center shadow-2xl shadow-emerald-950/40">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-emerald-200/50 bg-emerald-300/15 text-emerald-200 shadow-[0_0_32px_rgba(110,231,183,0.22)]">
          <CheckCircle2 className="h-9 w-9" />
        </div>
        <p className="mt-5 text-xs font-black uppercase tracking-[0.28em] text-emerald-200">
          Extraction successful
        </p>
        <h2
          id="extraction-success-title"
          className="mt-2 text-2xl font-black text-white"
        >
          Your extraction is complete.
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          The results are ready on the main screen behind this confirmation.
          Click below to return to the results view.
        </p>
        <button
          onClick={onViewResults}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-300 px-5 py-3 text-xs font-black uppercase tracking-[0.18em] text-slate-950 transition hover:bg-emerald-200"
        >
          <ShieldCheck className="h-4 w-4" /> View Results
        </button>
      </div>
    </section>
  );
}

function LogsPanel({
  logs,
  isLoading,
  compact = false,
  title = "Runtime Extraction Logs",
}: {
  logs: RuntimeLog[];
  isLoading: boolean;
  compact?: boolean;
  title?: string;
}) {
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  return (
    <section
      className={`min-w-0 flex flex-col rounded-2xl border border-slate-700 bg-slate-950/80 shadow-2xl shadow-black/30 ${compact ? "h-[22rem] w-full xl:w-[508px]" : "h-80 w-full"}`}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <TerminalSquare className="h-4 w-4 text-cyan-300" /> {title}
        </div>
        <span
          className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-widest ${isLoading ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-800 text-slate-400"}`}
        >
          {isLoading ? "Live" : "Idle"}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 font-mono text-xs">
        {logs.map((log, index) => {
          const isActive = isLoading && index === logs.length - 1;

          return (
            <div
              key={`${log.time}-${index}-${log.text}`}
              className={`grid min-w-0 grid-cols-[64px_12px_minmax(0,1fr)] gap-3 rounded-lg border px-3 py-2 transition ${isActive ? "border-cyan-300/40 bg-cyan-300/10 shadow-[0_0_18px_rgba(34,211,238,0.12)]" : "border-slate-800 bg-slate-900/70 opacity-75"}`}
            >
              <span className="text-slate-500">{log.time}</span>
              <span
                className={`mt-1.5 h-2 w-2 rounded-full ${isActive ? "animate-pulse bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.9)]" : "bg-slate-700"}`}
              />
              <span
                className={`${
                  log.tone === "success"
                    ? "text-emerald-300"
                    : log.tone === "warn"
                      ? "text-amber-300"
                      : log.tone === "error"
                        ? "text-red-300"
                        : "text-cyan-100"
                } min-w-0 break-words`}
              >
                {log.text}
              </span>
            </div>
          );
        })}
        <div ref={logsEndRef} />
      </div>
    </section>
  );
}

function DebugLogsPanel({
  text,
  isLoading,
}: {
  text: string;
  isLoading: boolean;
}) {
  const debugEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    debugEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [text]);

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-950/80 shadow-2xl shadow-black/30">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <TerminalSquare className="h-4 w-4 text-cyan-300" /> Debug Logs
        </div>
        <span
          className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-widest ${isLoading ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-800 text-slate-400"}`}
        >
          {isLoading ? "Live" : "Idle"}
        </span>
      </div>
      <pre className="max-h-[52vh] overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-cyan-50">
        {text || "Run an extraction to stream full Python backend logs here."}
        <div ref={debugEndRef} />
      </pre>
    </section>
  );
}

const parseNumberMetric = (value: unknown) => {
  const numericValue = typeof value === "string" ? Number(value) : value;
  return typeof numericValue === "number" && Number.isFinite(numericValue)
    ? numericValue
    : 0;
};

const normalizeTokenCostMetrics = (value: unknown): TokenCostMetrics | null => {
  if (!value || typeof value !== "object") return null;

  const metrics = value as Record<string, unknown>;
  const inputTokens = parseNumberMetric(metrics.input_tokens);
  const outputTokens = parseNumberMetric(metrics.output_tokens);
  const totalTokens =
    parseNumberMetric(metrics.total_tokens) || inputTokens + outputTokens;
  const inputCost = parseNumberMetric(metrics.input_cost);
  const outputCost = parseNumberMetric(metrics.output_cost);
  const totalCost =
    parseNumberMetric(metrics.total_cost) || inputCost + outputCost;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: totalCost,
  };
};

const formatTokenCount = (value: number) =>
  new Intl.NumberFormat("en-US").format(Math.round(value));
const formatCost = (value: number) => `$${value.toFixed(4)}`;

function CostMetricsModal({
  metrics,
  onClose,
}: {
  metrics: TokenCostMetrics;
  onClose: () => void;
}) {
  const rows = [
    { label: "Input", tokens: metrics.input_tokens, cost: metrics.input_cost },
    {
      label: "Output",
      tokens: metrics.output_tokens,
      cost: metrics.output_cost,
    },
    { label: "Total", tokens: metrics.total_tokens, cost: metrics.total_cost },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cost-metrics-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-cyan-300/30 bg-slate-950 shadow-2xl shadow-cyan-950/40">
        <div className="flex items-start justify-between border-b border-slate-800 bg-cyan-300/10 p-5">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.24em] text-cyan-200">
              Extraction Cost
            </p>
            <h2
              id="cost-metrics-title"
              className="mt-2 text-xl font-black text-white"
            >
              Token & cost metrics
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            aria-label="Close cost metrics"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 p-5">
          {rows.map((row) => (
            <div
              key={row.label}
              className={`rounded-2xl border p-4 ${row.label === "Total" ? "border-emerald-300/40 bg-emerald-300/10" : "border-slate-800 bg-slate-900/70"}`}
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">
                {row.label}
              </p>
              <div className="mt-2 flex items-end justify-between gap-3">
                <div>
                  <p className="font-mono text-lg font-black text-slate-50">
                    {formatTokenCount(row.tokens)}
                  </p>
                  <p className="text-xs text-slate-400">tokens</p>
                </div>
                <p className="font-mono text-lg font-black text-cyan-100">
                  {formatCost(row.cost)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RuntimeSettingsModal({
  settings,
  onChange,
  onClose,
}: {
  settings: RuntimeSettings;
  onChange: (settings: RuntimeSettings) => void;
  onClose: () => void;
}) {
  const updateSetting = (field: RuntimeSettingsField, value: string | boolean) => {
    onChange(normalizeRuntimeSettings({
      ...settings,
      [field.key]: normalizeRuntimeSettingValue(field, value),
    }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="runtime-settings-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-cyan-300/30 bg-slate-950 shadow-2xl shadow-cyan-950/40">
        <div className="flex items-start justify-between border-b border-slate-800 bg-cyan-300/10 p-5">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.24em] text-cyan-200">
              Runtime Settings
            </p>
            <h2
              id="runtime-settings-title"
              className="mt-2 text-xl font-black text-white"
            >
              Runtime extraction controls
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            aria-label="Close runtime settings"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          {runtimeSettingsSchema.map((field) => (
            <label key={field.key} className="block rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
              <span className="text-xs font-black uppercase tracking-[0.18em] text-slate-300">
                {field.label}
              </span>
              {field.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={Boolean(settings[field.key])}
                  onChange={(event) => updateSetting(field, event.target.checked)}
                  className="mt-3 h-4 w-4 accent-cyan-300"
                />
              ) : (
                <input
                  type={field.type}
                  min={field.type === "number" ? field.min : undefined}
                  max={field.type === "number" ? field.max : undefined}
                  step={field.type === "number" ? field.step : undefined}
                  value={String(settings[field.key])}
                  onChange={(event) => updateSetting(field, event.target.value)}
                  className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm font-bold text-cyan-100 outline-none transition focus:border-cyan-300"
                />
              )}
              <p className="mt-2 text-xs text-slate-500">{field.description}</p>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultsPanel({
  results,
  tokenCostMetrics,
  hasBackendLogs,
  onViewCostMetrics,
  onDownload,
  onDownloadLogs,
  onSendToMcp,
}: {
  results: ExtractionResult[];
  tokenCostMetrics: TokenCostMetrics | null;
  hasBackendLogs: boolean;
  onViewCostMetrics: () => void;
  onDownload: (format: "csv" | "json") => void;
  onDownloadLogs: () => void;
  onSendToMcp: () => void;
}) {
  return (
    <section className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
      <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <ShieldCheck className="h-4 w-4 text-emerald-300" /> Extraction
            Results
          </h2>
          <span className="text-xs text-slate-500">
            {results.length} fields · schema v2.1
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onViewCostMetrics}
            disabled={!tokenCostMetrics}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-emerald-100 hover:border-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              tokenCostMetrics
                ? "View token and cost metrics for this extraction"
                : "Run an extraction to view token and cost metrics"
            }
          >
            <CircleDollarSign className="h-4 w-4" /> Cost
          </button>
          <button
            onClick={onDownloadLogs}
            disabled={!hasBackendLogs}
            className="inline-flex items-center gap-2 rounded-lg border border-purple-300/30 bg-purple-300/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-purple-100 hover:border-purple-200 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              hasBackendLogs
                ? "Export backend runtime, cost, and audit logs as text"
                : "Run an extraction to export backend logs"
            }
          >
            <Download className="h-4 w-4" /> Logs TXT
          </button>
          <button
            onClick={() => onDownload("csv")}
            disabled={results.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-cyan-100 hover:border-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-4 w-4" /> CSV
          </button>
          <button
            onClick={() => onDownload("json")}
            disabled={results.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-cyan-100 hover:border-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FileJson className="h-4 w-4" /> JSON
          </button>
          <button
            onClick={onSendToMcp}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-amber-100 hover:border-amber-200"
          >
            <DatabaseZap className="h-4 w-4" /> MCP
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {results.map((result) => (
          <div
            key={result.field}
            className={`rounded-xl border p-3 ${result.status === "alert" ? "border-red-300/60 bg-red-950/25" : "border-emerald-400/20 bg-emerald-400/[0.04]"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                  {result.field}
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-50">
                  {result.value}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Confidence {result.confidence}
                </p>
              </div>
              {result.status === "validated" ? (
                <CheckCircle2 className="h-6 w-6 text-emerald-300" />
              ) : (
                <AlertTriangle className="h-6 w-6 text-red-300" />
              )}
            </div>
            {result.status === "alert" && (
              <div className="mt-4 rounded-lg border border-red-300/30 bg-red-950/40 p-3">
                <p className="mb-3 text-sm font-semibold text-red-100">
                  {result.alert}
                </p>
                <div className="grid gap-2 xl:grid-cols-[auto_1fr]">
                  <button className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-300 px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-red-950 hover:bg-red-200">
                    <RefreshCw className="h-4 w-4" /> AI Re-Try
                  </button>
                  <input
                    className="terminal-input border-red-300/30"
                    placeholder="Manual Edit: enter corrected value"
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}


function TemplateDrawer({
  templates,
  activeTemplateId,
  templateName,
  onTemplateNameChange,
  onSaveTemplate,
  onLoadTemplate,
  onDeleteTemplate,
  onRunTemplate,
  onExportTemplate,
  onImportTemplate,
  isLoading,
  isExpanded,
  onToggleExpanded,
}: {
  templates: SavedTemplate[];
  activeTemplateId: string | null;
  templateName: string;
  onTemplateNameChange: (name: string) => void;
  onSaveTemplate: () => void;
  onLoadTemplate: (template: SavedTemplate) => void;
  onDeleteTemplate: (templateId: string) => void;
  onRunTemplate: (template: SavedTemplate) => void;
  onExportTemplate: (template: SavedTemplate) => void;
  onImportTemplate: (file: File, targetTemplate?: SavedTemplate) => void;
  isLoading: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  const [openMenuTemplateId, setOpenMenuTemplateId] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importTargetTemplateRef = useRef<SavedTemplate | undefined>(undefined);

  const openImportPicker = (targetTemplate?: SavedTemplate) => {
    importTargetTemplateRef.current = targetTemplate;
    setOpenMenuTemplateId(null);
    importInputRef.current?.click();
  };
  return (
    <aside
      className={`${isExpanded ? "w-72 p-4" : "w-[4.75rem] px-3 py-4"} shrink-0 border-r border-cyan-300/10 bg-[linear-gradient(180deg,#070b14,#03050a)] transition-all duration-300`}
      aria-label="Template side panel"
    >
      <div className="sticky top-4 space-y-4">
        <button
          onClick={onToggleExpanded}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-black uppercase tracking-[0.16em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-300/20"
          aria-label={isExpanded ? "Collapse template panel" : "Expand template panel"}
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <>
              <ChevronLeft className="h-4 w-4" /> Collapse
            </>
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        {!isExpanded && (
          <div className="flex flex-col items-center gap-3 pt-2 text-center">
            <BExtractorLogo isActive={isLoading} size="sm" />
            <span className="[writing-mode:vertical-rl] rotate-180 text-[10px] font-black uppercase tracking-[0.26em] text-cyan-200">
              Templates
            </span>
            <span className="rounded-full bg-slate-800 px-2 py-1 text-[10px] font-bold text-slate-400">
              {templates.length}
            </span>
          </div>
        )}
        {isExpanded && (
          <>
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">
            <FolderOpen className="h-4 w-4" /> Templates
          </p>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Save extraction field cards, select a template, then run it against the uploaded PDF set.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-700/80 bg-slate-950/70 p-3 shadow-inner shadow-black/30">
          <label className="space-y-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
              Template Name
            </span>
            <input
              value={templateName}
              onChange={(event) => onTemplateNameChange(event.target.value)}
              className="terminal-input"
              placeholder="Template name"
            />
          </label>
          <button
            onClick={onSaveTemplate}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-slate-950 hover:bg-cyan-200"
          >
            <Save className="h-4 w-4" /> Save Template
          </button>
        </div>

        <input
          ref={importInputRef}
          className="sr-only"
          type="file"
          accept="application/json,.json"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const selectedFile = event.target.files?.[0];
            if (selectedFile) {
              onImportTemplate(selectedFile, importTargetTemplateRef.current);
            }
            importTargetTemplateRef.current = undefined;
            event.target.value = "";
          }}
        />

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">
              Saved Templates
            </p>
            <span className="rounded-full bg-slate-800 px-2 py-1 text-[10px] font-bold text-slate-400">
              {templates.length}
            </span>
          </div>
          {templates.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-4 text-xs leading-5 text-slate-500">
              No saved templates yet. Configure fields and click Save Template.
            </div>
          ) : (
            templates.map((template) => (
              <article
                key={template.id}
                className={`rounded-2xl border p-3 transition ${activeTemplateId === template.id ? "border-cyan-300/60 bg-cyan-300/10" : "border-slate-800 bg-slate-900/60 hover:border-slate-600"}`}
              >
                <div className="relative flex items-start gap-2">
                  <button
                    onClick={() => onLoadTemplate(template)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-sm font-bold text-slate-100">
                      {template.name}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {template.fields.length} fields · {template.extractionApproach === "pre_injected" ? "Pre-Injected" : "Agentic"}
                    </p>
                  </button>
                  <button
                    onClick={() =>
                      setOpenMenuTemplateId((current) =>
                        current === template.id ? null : template.id,
                      )
                    }
                    className="rounded-lg border border-slate-700 bg-slate-950/70 p-1.5 text-slate-300 transition hover:border-cyan-300/60 hover:text-cyan-100"
                    aria-label={`Open actions for ${template.name}`}
                    aria-expanded={openMenuTemplateId === template.id}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                  {openMenuTemplateId === template.id && (
                    <div className="absolute right-0 top-8 z-20 w-44 overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-2xl shadow-black/50">
                      <button
                        onClick={() => openImportPicker(template)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-200 hover:bg-cyan-300/10 hover:text-cyan-100"
                      >
                        <UploadCloud className="h-3.5 w-3.5" /> Input Template
                      </button>
                      <button
                        onClick={() => {
                          setOpenMenuTemplateId(null);
                          onExportTemplate(template);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-200 hover:bg-cyan-300/10 hover:text-cyan-100"
                      >
                        <Download className="h-3.5 w-3.5" /> Output Template
                      </button>
                    </div>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                  <button
                    onClick={() => onRunTemplate(template)}
                    disabled={isLoading}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-300 px-3 py-2 text-[10px] font-black uppercase tracking-[0.16em] text-slate-950 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Play className="h-3.5 w-3.5" /> Run
                  </button>
                  <button
                    onClick={() => onDeleteTemplate(template.id)}
                    className="rounded-lg border border-red-300/30 bg-red-400/10 p-2 text-red-200 hover:border-red-200 hover:bg-red-400/20"
                    aria-label={`Delete ${template.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
          </>
        )}
      </div>
    </aside>
  );
}

export default function Home() {
  const [fields, setFields] = useState(initialFields);
  const [files, setFiles] = useState<File[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLog[]>(initialLogs);
  const [debugLogText, setDebugLogText] = useState("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const [extractionResults, setExtractionResults] =
    useState<ExtractionResult[]>(initialResults);
  const [batchExportRecords, setBatchExportRecords] = useState<
    BatchExportRecord[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(true);
  const [isTemplatePanelExpanded, setIsTemplatePanelExpanded] = useState(true);
  const [templateName, setTemplateName] = useState("BExtractor Template");
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(() => {
    if (typeof window === "undefined") return [];

    try {
      const storedTemplates = window.localStorage.getItem(TEMPLATE_STORAGE_KEY);
      if (!storedTemplates) return [];

      const parsedTemplates = JSON.parse(storedTemplates) as SavedTemplate[];
      if (!Array.isArray(parsedTemplates)) return [];

      return parsedTemplates
        .filter(
          (template) =>
            template &&
            typeof template.id === "string" &&
            typeof template.name === "string" &&
            Array.isArray(template.fields),
        )
        .map((template) => ({
          ...template,
          extractionApproach:
            template.extractionApproach === "agentic" ? "agentic" : "pre_injected",
          runtimeSettings: normalizeRuntimeSettings(template.runtimeSettings),
        }));
    } catch {
      return [];
    }
  });
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [extractionApproach, setExtractionApproach] =
    useState<ExtractionApproach>("pre_injected");
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>(defaultRuntimeSettings);
  const [tokenCostMetrics, setTokenCostMetrics] =
    useState<TokenCostMetrics | null>(null);
  const [backendLogText, setBackendLogText] = useState("");
  const [debugRunMetrics, setDebugRunMetrics] = useState<DebugRunMetrics>(
    initialDebugRunMetrics,
  );
  const runStartedAtRef = useRef<number | null>(null);
  const [isCostMetricsOpen, setIsCostMetricsOpen] = useState(false);
  const [isRuntimeSettingsOpen, setIsRuntimeSettingsOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showExtractionSuccessModal, setShowExtractionSuccessModal] = useState(false);
  const resultsSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.localStorage.setItem(
      TEMPLATE_STORAGE_KEY,
      JSON.stringify(savedTemplates),
    );
  }, [savedTemplates]);

  useEffect(() => {
    if (!toast) return;
    const timeoutId = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  const addField = () =>
    setFields((current) => [
      ...current,
      {
        id: Date.now(),
        name: "",
        definition: "",
        routeType: "Scalar",
        dataType: "String",
      },
    ]);
  const updateField = (updated: FieldCard) =>
    setFields((current) =>
      current.map((field) => (field.id === updated.id ? updated : field)),
    );

  const timestamp = () =>
    new Date().toLocaleTimeString("en-US", { hour12: false });

  const updateDebugRunMetrics = (updates: Partial<DebugRunMetrics>) =>
    setDebugRunMetrics((current) => ({ ...current, ...updates }));

  const updateElapsedSeconds = () => {
    if (!runStartedAtRef.current) return;
    updateDebugRunMetrics({
      elapsedSeconds: (Date.now() - runStartedAtRef.current) / 1000,
    });
  };

  const captureChunkCountFromMessage = (message: string) => {
    const chunkMatch = message.match(/(?:Parsed|Indexed)\s+(\d+)\s+PDF text chunks/i);
    if (chunkMatch) {
      updateDebugRunMetrics({ chunkCount: Number(chunkMatch[1]) });
    }
  };

  const showToast = (tone: RuntimeLog["tone"], message: string) =>
    setToast({ id: Date.now(), tone, message });

  const appendLog = (tone: RuntimeLog["tone"], text: string) =>
    setRuntimeLogs((current) => [
      ...current,
      { time: timestamp(), tone, text },
    ]);

  const applyTemplate = (template: SavedTemplate) => {
    setActiveTemplateId(template.id);
    setTemplateName(template.name);
    setFields(template.fields.map((field) => ({ ...field })));
    setExtractionApproach(template.extractionApproach);
    setRuntimeSettings(normalizeRuntimeSettings(template.runtimeSettings));
    setExtractionResults([]);
    setBatchExportRecords([]);
    setShowExtractionSuccessModal(false);
    setTokenCostMetrics(null);
    setBackendLogText("");
    setDebugLogText("");
  };

  const handleSaveTemplate = () => {
    const normalizedName = safeTemplateName();
    const templateId = activeTemplateId ?? crypto.randomUUID();
    const template: SavedTemplate = {
      id: templateId,
      name: normalizedName,
      fields: fields.map((field) => ({ ...field })),
      extractionApproach,
      runtimeSettings,
      updatedAt: new Date().toISOString(),
    };

    setSavedTemplates((current) => {
      const existingIndex = current.findIndex((item) => item.id === templateId);
      if (existingIndex === -1) return [template, ...current];
      return current.map((item) => (item.id === templateId ? template : item));
    });
    setActiveTemplateId(templateId);
    setTemplateName(normalizedName);
    appendLog("success", `Saved template "${normalizedName}".`);
    showToast("success", `Template "${normalizedName}" saved successfully.`);
  };


  const buildTemplateExport = (template: SavedTemplate) => ({
    id: template.id,
    name: template.name,
    fields: template.fields.map((field) => ({ ...field })),
    extractionApproach: template.extractionApproach,
    runtimeSettings: template.runtimeSettings,
    updatedAt: template.updatedAt,
  });

  const handleExportTemplate = (template: SavedTemplate) => {
    const payload = buildTemplateExport(template);
    const slug =
      template.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "bextract-template";
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug}-template.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    appendLog("success", `Downloaded template "${template.name}" as JSON.`);
    showToast("success", `Template "${template.name}" exported successfully.`);
  };

  const normalizeImportedFields = (items: TemplateImportPayload["fields"]): FieldCard[] => {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Template JSON must include at least one field.");
    }

    return items.map((item, index) => ({
      id:
        typeof item.id === "number"
          ? item.id
          : Number(item.id) || Date.now() + index,
      name: String(item.name ?? `Imported Field ${index + 1}`),
      definition: String(item.definition ?? ""),
      routeType: item.routeType === "Tabular" ? "Tabular" : "Scalar",
      dataType: (["String", "Float", "Date", "Text Summary"] as DataType[]).includes(
        item.dataType as DataType,
      )
        ? (item.dataType as DataType)
        : "String",
    }));
  };

  const handleImportTemplate = async (file: File, targetTemplate?: SavedTemplate) => {
    try {
      const payload = JSON.parse(await file.text()) as TemplateImportPayload;
      const importedFields = normalizeImportedFields(
        payload.fields ?? payload.items,
      );
      const importedTemplate: SavedTemplate = {
        id: targetTemplate?.id ?? activeTemplateId ?? crypto.randomUUID(),
        name:
          String(
            payload.name ?? targetTemplate?.name ?? file.name.replace(/\.json$/i, ""),
          ).trim() || "Imported Template",
        fields: importedFields,
        extractionApproach:
          payload.extractionApproach === "agentic" ? "agentic" : "pre_injected",
        runtimeSettings: normalizeRuntimeSettings({
          ...targetTemplate?.runtimeSettings,
          ...payload.runtimeSettings,
          emptyResultsMaxRetries:
            payload.runtimeSettings?.emptyResultsMaxRetries ??
            payload.emptyResultsMaxRetries ??
            targetTemplate?.runtimeSettings?.emptyResultsMaxRetries,
        }),
        updatedAt: new Date().toISOString(),
      };

      applyTemplate(importedTemplate);
      appendLog("success", `Loaded imported template "${importedTemplate.name}" into the editor.`);
      showToast("success", `Template "${importedTemplate.name}" loaded. Click Save Template to overwrite the selected template.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to import template JSON.";
      appendLog("error", message);
      showToast("error", message);
    }
  };

  const handleDeleteTemplate = (templateId: string) => {
    setSavedTemplates((current) => current.filter((template) => template.id !== templateId));
    if (activeTemplateId === templateId) setActiveTemplateId(null);
    appendLog("warn", "Template deleted from this browser.");
  };

  const coerceTone = (tone: unknown): RuntimeLog["tone"] => {
    if (tone === "success" || tone === "warn" || tone === "error") return tone;
    return "info";
  };

  const formatConfidence = (confidence: unknown) => {
    if (typeof confidence === "number")
      return confidence <= 1
        ? `${Math.round(confidence * 100)}%`
        : `${Math.round(confidence)}%`;
    return String(confidence ?? "n/a");
  };

  const findFieldForResult = (row: Record<string, unknown>) => {
    const resultId = String(row.field_id ?? row.item_id ?? row.id ?? "");
    const resultName = String(
      row.field_name ?? row.field ?? row.name ?? "",
    ).toLowerCase();

    return fields.find(
      (field) =>
        String(field.id) === resultId ||
        field.name.toLowerCase() === resultName,
    );
  };

  const mapFinalPayloadToResults = (
    payload: Record<string, unknown>,
  ): ExtractionResult[] => {
    const rawResults = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(
            (payload.structured_json as Record<string, unknown> | undefined)
              ?.results,
          )
        ? ((payload.structured_json as Record<string, unknown>)
            .results as unknown[])
        : Object.values(
            ((payload.structured_json as Record<string, unknown> | undefined)
              ?.results ??
              payload.extracted_values ??
              {}) as Record<string, unknown>,
          );

    return rawResults.map((rawResult) => {
      const row = (
        typeof rawResult === "object" && rawResult !== null
          ? rawResult
          : { value: rawResult }
      ) as Record<string, unknown>;
      const field = findFieldForResult(row);
      const validation = (row.validation ?? row.critic ?? row.error) as
        | Record<string, unknown>
        | string
        | undefined;
      const alert =
        typeof validation === "string"
          ? validation
          : String(
              row.alert ??
                row.validation_error ??
                validation?.message ??
                validation?.error ??
                "",
            );
      const isAlert =
        Boolean(alert) ||
        row.status === "alert" ||
        row.valid === false ||
        (validation &&
          typeof validation === "object" &&
          validation.valid === false);

      return {
        fieldId: field
          ? String(field.id)
          : String(row.field_id ?? row.item_id ?? row.id ?? ""),
        field:
          field?.name ??
          String(
            row.field_name ??
              row.field ??
              row.name ??
              row.item_id ??
              "Unknown field",
          ),
        value: String(row.value ?? row.extracted_value ?? row.answer ?? ""),
        confidence: formatConfidence(row.confidence ?? row.score),
        status: isAlert ? "alert" : "validated",
        alert: isAlert
          ? alert || "Critic Agent flagged this field for review."
          : undefined,
      };
    });
  };

  const handleSseData = (
    eventName: string | undefined,
    data: Record<string, unknown>,
  ) => {
    const normalizedEvent =
      eventName ?? String(data.event ?? data.type ?? "message");
    const errorMessage = typeof data.error === "string" ? data.error : "";
    const message = String(
      errorMessage ||
        data.message ||
        data.status ||
        data.detail ||
        data.log ||
        "",
    );

    if (errorMessage) {
      appendLog("error", errorMessage);
      updateElapsedSeconds();
      abortControllerRef.current = null;
      setIsLoading(false);
      setShowExtractionSuccessModal(false);
      return;
    }

    if (normalizedEvent === "debug_log" && typeof data.message === "string") {
      captureChunkCountFromMessage(data.message);
      setDebugLogText(
        (current) => `${current}${current ? "\n" : ""}${data.message}`,
      );
      return;
    }

    if (message) {
      captureChunkCountFromMessage(message);
      appendLog(
        coerceTone(
          data.tone ?? (normalizedEvent === "error" ? "error" : undefined),
        ),
        message,
      );
    }

    const batchProgress =
      data.batch_progress && typeof data.batch_progress === "object"
        ? (data.batch_progress as Record<string, unknown>)
        : null;
    const batchCurrent = Number(batchProgress?.current ?? 0);
    const batchTotal = Number(batchProgress?.total ?? 0);
    const isBatchFileResult =
      normalizedEvent === "result" && batchTotal > 1 && batchCurrent > 0;

    if (normalizedEvent === "batch_export") {
      const records = Array.isArray(data.records)
        ? (data.records.filter(
            (record): record is BatchExportRecord =>
              typeof record === "object" && record !== null && !Array.isArray(record),
          ) as BatchExportRecord[])
        : [];
      if (records.length > 0) setBatchExportRecords(records);
      const metrics = normalizeTokenCostMetrics(data.token_cost_metrics);
      if (metrics) setTokenCostMetrics(metrics);
      updateElapsedSeconds();
      appendLog(
        "success",
        message || "Extraction completed successfully for all files.",
      );
      setIsLoading(false);
      setShowExtractionSuccessModal(true);
      return;
    }

    if (
      ["result", "complete", "completed", "done", "final"].includes(
        normalizedEvent,
      ) ||
      data.results ||
      data.structured_json ||
      data.extracted_values
    ) {
      const results = mapFinalPayloadToResults(data);
      if (results.length > 0) setExtractionResults(results);
      const metrics = normalizeTokenCostMetrics(data.token_cost_metrics);
      if (metrics) setTokenCostMetrics(metrics);
      updateDebugRunMetrics({
        runId: String(data.batch_id ?? data.document_id ?? debugRunMetrics.runId),
      });
      if (typeof data.backend_log_text === "string") {
        captureChunkCountFromMessage(data.backend_log_text);
        setBackendLogText(data.backend_log_text);
        setDebugLogText(data.backend_log_text);
      }

      if (isBatchFileResult) {
        appendLog(
          "success",
          batchCurrent < batchTotal
            ? `File ${batchCurrent}/${batchTotal} completed. Continuing batch extraction...`
            : `File ${batchCurrent}/${batchTotal} completed. Preparing final batch exports...`,
        );
        return;
      }

      updateElapsedSeconds();
      appendLog(
        "success",
        batchTotal > 1
          ? `Extraction completed successfully for ${batchTotal}/${batchTotal} files. Field cards were updated with the latest file results.`
          : "Extraction completed successfully. Field cards were updated.",
      );
      setIsLoading(false);
      setShowExtractionSuccessModal(true);
    }
  };

  const parseSseEvent = (rawEvent: string) => {
    const lines = rawEvent.split(/\r?\n/);
    const eventName = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!dataText) return dataText;
    if (dataText === "[DONE]") {
      appendLog("success", "Extraction stream completed successfully.");
      setIsLoading(false);
      return dataText;
    }

    try {
      handleSseData(eventName, JSON.parse(dataText) as Record<string, unknown>);
    } catch {
      appendLog("info", dataText);
    }
    return dataText;
  };

  const safeTemplateName = () =>
    (
      templateName.trim() ||
      files[0]?.name.replace(/\.pdf$/i, "") ||
      "bextract-output"
    ).trim();

  const serializeResultsForDownload = () => {
    const hasBatchRecords = batchExportRecords.length > 0;
    return {
      templateName: safeTemplateName(),
      exportedAt: new Date().toISOString(),
      isBatchExport: hasBatchRecords,
      results: hasBatchRecords
        ? batchExportRecords
        : extractionResults.map((result) => ({
            field: result.field,
            value: result.value,
            confidence: result.confidence,
            status: result.status,
            alert: result.alert ?? "",
          })),
    };
  };

  const escapeCsvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;

  const getCsvHeaders = (rows: Record<string, unknown>[]) => {
    const preferredHeaders = ["File Name", "Extraction Status"];
    const headers = preferredHeaders.filter((header) =>
      rows.some((row) => Object.prototype.hasOwnProperty.call(row, header)),
    );
    rows.forEach((row) => {
      Object.keys(row).forEach((key) => {
        if (!headers.includes(key)) headers.push(key);
      });
    });
    return headers;
  };

  const handleDownloadOutput = (format: "csv" | "json") => {
    const payload = serializeResultsForDownload();
    const slug =
      payload.templateName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "bextract-output";
    const content =
      format === "json"
        ? JSON.stringify(
            payload.isBatchExport ? payload.results : payload,
            null,
            2,
          )
        : (() => {
            const rows = payload.results as Record<string, unknown>[];
            const headers = payload.isBatchExport
              ? getCsvHeaders(rows)
              : [
                  "template_name",
                  "field",
                  "value",
                  "confidence",
                  "status",
                  "alert",
                ];
            const csvRows = payload.isBatchExport
              ? rows.map((row) => headers.map((header) => row[header] ?? ""))
              : rows.map((result) => [
                  payload.templateName,
                  result.field,
                  result.value,
                  result.confidence,
                  result.status,
                  result.alert,
                ]);
            return [headers, ...csvRows]
              .map((row) =>
                row.map((cell) => escapeCsvCell(String(cell))).join(","),
              )
              .join("\n");
          })();
    const blob = new Blob([content], {
      type: format === "json" ? "application/json" : "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug}-results.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
    appendLog(
      "success",
      `Downloaded ${payload.templateName} output as ${format.toUpperCase()}.`,
    );
  };

  const handleDownloadLogs = () => {
    if (!backendLogText) {
      appendLog("warn", "Run an extraction before exporting backend logs.");
      return;
    }

    const slug =
      safeTemplateName()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "bextract-output";
    const blob = new Blob([backendLogText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug}-backend-logs.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    appendLog(
      "success",
      "Downloaded backend runtime, cost, and audit logs as TXT.",
    );
  };

  const handleSendToMcp = () => {
    appendLog(
      "info",
      "MCP database delivery is a placeholder. Connector configuration will be added in a future release.",
    );
  };

  const handleFilesChange = (nextFiles: File[]) => {
    abortControllerRef.current?.abort();
    setFiles(nextFiles);
    setIsLoading(false);
    setExtractionResults([]);
    setBatchExportRecords([]);
    setTokenCostMetrics(null);
    setBackendLogText("");
    setDebugLogText("");
    setDebugRunMetrics(initialDebugRunMetrics);
    runStartedAtRef.current = null;
    setIsCostMetricsOpen(false);
    setShowExtractionSuccessModal(false);
    setRuntimeLogs([
      {
        time: timestamp(),
        tone: nextFiles.length > 0 ? "info" : "warn",
        text:
          nextFiles.length > 0
            ? `Selected ${nextFiles.length} PDF${nextFiles.length === 1 ? "" : "s"}: ${nextFiles.map((selectedFile) => selectedFile.name).join(", ")}. Run extraction to generate fresh results.`
            : "PDF selection cleared. Upload at least one PDF before starting extraction.",
      },
    ]);
  };

  const handleCancelExtraction = () => {
    abortControllerRef.current?.abort();
    updateElapsedSeconds();
    setIsLoading(false);
    setShowExtractionSuccessModal(false);
  };

  const handleRunExtraction = async (templateOverride?: SavedTemplate) => {
    if (isLoading) return;

    if (files.length === 0) {
      appendLog("warn", "Select at least one PDF before starting extraction.");
      return;
    }

    setIsLoading(true);
    setRuntimeLogs([]);
    setDebugLogText("");
    setExtractionResults([]);
    setBatchExportRecords([]);
    setTokenCostMetrics(null);
    setBackendLogText("");
    setIsCostMetricsOpen(false);
    setShowExtractionSuccessModal(false);

    const runFields = templateOverride?.fields ?? fields;
    const runTemplateName = templateOverride?.name ?? safeTemplateName();
    const runApproach = templateOverride?.extractionApproach ?? extractionApproach;
    const runRuntimeSettings = templateOverride?.runtimeSettings ?? runtimeSettings;

    const fieldPayload = runFields.map((field) => ({
      id: String(field.id),
      name: field.name,
      definition: field.definition,
      routeType: field.routeType,
      dataType: field.dataType,
    }));
    const documentId =
      files.length === 1
        ? files[0].name.replace(/\.pdf$/i, "") || "uploaded_document"
        : `${runTemplateName}_batch`;
    runStartedAtRef.current = Date.now();
    setDebugRunMetrics({
      runId: documentId,
      chunkCount: null,
      elapsedSeconds: null,
    });
    const templatePayload = {
      documentId,
      items: fieldPayload,
      extractionApproach: runApproach,
      runtimeSettings: runRuntimeSettings,
      emptyResultsMaxRetries: runRuntimeSettings.emptyResultsMaxRetries,
    };
    const formData = new FormData();
    files.forEach((selectedFile) => {
      formData.append("files", selectedFile, selectedFile.name);
    });
    formData.append("fields", JSON.stringify(fieldPayload));
    formData.append("payload", JSON.stringify(templatePayload));

    try {
      appendLog(
        "info",
        `Uploading ${files.length} PDF${files.length === 1 ? "" : "s"} with ${runFields.length} field card${runFields.length === 1 ? "" : "s"}.`,
      );
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const response = await fetch("/api/extract", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Extraction request failed with ${response.status}`);
      if (!response.body)
        throw new Error(
          "Extraction response did not include a readable stream.",
        );

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = done ? "" : (events.pop() ?? "");

        for (const rawEvent of events) parseSseEvent(rawEvent);
        if (done) break;
      }

      if (buffer.trim()) parseSseEvent(buffer);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        appendLog("warn", "Extraction cancelled by user.");
        setShowExtractionSuccessModal(false);
      } else {
        appendLog(
          "error",
          error instanceof Error ? error.message : "Extraction request failed",
        );
        setShowExtractionSuccessModal(false);
      }
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  };


  const handleViewExtractionResults = () => {
    setShowExtractionSuccessModal(false);
    window.requestAnimationFrame(() => {
      resultsSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const handleRunSavedTemplate = (template: SavedTemplate) => {
    applyTemplate(template);
    void handleRunExtraction(template);
  };

  const debugSummaryMetrics = useMemo(
    () => [
      { label: "Run", value: debugRunMetrics.runId, icon: Play },
      {
        label: "Chunks",
        value:
          debugRunMetrics.chunkCount === null
            ? "Pending"
            : String(debugRunMetrics.chunkCount),
        icon: DatabaseZap,
      },
      {
        label: "SLA",
        value:
          debugRunMetrics.elapsedSeconds === null
            ? isLoading
              ? "Running"
              : "Pending"
            : `${debugRunMetrics.elapsedSeconds.toFixed(1)}s`,
        icon: Gauge,
      },
    ],
    [debugRunMetrics, isLoading],
  );

  return (
    <main className="min-h-screen bg-[#060913] text-slate-100">
      {toast && (
        <div className="fixed left-1/2 top-4 z-[60] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2" role="status" aria-live="polite">
          <div
            className={`rounded-2xl border px-4 py-3 text-sm font-semibold shadow-2xl backdrop-blur ${
              toast.tone === "error"
                ? "border-red-300/50 bg-red-950/90 text-red-100 shadow-red-950/40"
                : toast.tone === "warn"
                  ? "border-amber-300/50 bg-amber-950/90 text-amber-100 shadow-amber-950/40"
                  : "border-emerald-300/50 bg-emerald-950/90 text-emerald-100 shadow-emerald-950/40"
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}
      {showExtractionSuccessModal && (
        <ExtractionSuccessModal onViewResults={handleViewExtractionResults} />
      )}
      {isCostMetricsOpen && tokenCostMetrics && (
        <CostMetricsModal
          metrics={tokenCostMetrics}
          onClose={() => setIsCostMetricsOpen(false)}
        />
      )}
      {isRuntimeSettingsOpen && (
        <RuntimeSettingsModal
          settings={runtimeSettings}
          onChange={(settings) => {
            setRuntimeSettings(settings);
            setActiveTemplateId(null);
          }}
          onClose={() => setIsRuntimeSettingsOpen(false)}
        />
      )}
      <div className="flex min-h-screen">
        <TemplateDrawer
          templates={savedTemplates}
          activeTemplateId={activeTemplateId}
          templateName={templateName}
          onTemplateNameChange={(name) => {
            setTemplateName(name);
            setActiveTemplateId(null);
          }}
          onSaveTemplate={handleSaveTemplate}
          onLoadTemplate={applyTemplate}
          onDeleteTemplate={handleDeleteTemplate}
          onRunTemplate={handleRunSavedTemplate}
          onExportTemplate={handleExportTemplate}
          onImportTemplate={handleImportTemplate}
          isLoading={isLoading}
          isExpanded={isTemplatePanelExpanded}
          onToggleExpanded={() =>
            setIsTemplatePanelExpanded((isExpanded) => !isExpanded)
          }
        />
        <section
          className={`${showDebugPanel ? "w-full xl:w-[60%] xl:border-r" : "w-full"} border-cyan-300/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_32%),linear-gradient(180deg,#0f172a,#070b14)] p-5 transition-all duration-500`}
        >
          <header className="mb-5 flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <BExtractorLogo isActive={isLoading} size="md" />
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em] text-cyan-300">
                  <CircleDollarSign className="h-4 w-4" /> AI Document Intelligence
                </p>
                <h1 className="mt-2 text-3xl font-black tracking-tight text-white sm:text-4xl">
                  BExtractor Studio
                </h1>
                <p className="mt-1 max-w-xl text-xs text-slate-400">
                  Configure templates, extract fields, and validate results from one workspace.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Link
                href="/results"
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/40 bg-slate-950/80 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-300/10 hover:text-white"
              >
                <ClipboardList className="h-4 w-4" /> Results History
              </Link>
              <button
                onClick={() => handleRunExtraction()}
                disabled={isLoading}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/40 bg-slate-950/80 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-300/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Search
                  className={`h-4 w-4 ${isLoading ? "animate-pulse" : ""}`}
                />{" "}
                {isLoading ? "Extracting..." : "Run Extraction"}
              </button>
            </div>
          </header>
          <div className="mb-4 grid gap-3 rounded-2xl border border-slate-700/70 bg-slate-950/50 p-4 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <span className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
                Active Template
              </span>
              <p className="mt-1 text-lg font-black text-slate-50">{safeTemplateName()}</p>
              <p className="text-xs text-slate-500">Use the left drawer to save, select, delete, or run reusable templates.</p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm font-semibold text-slate-200">
              <input
                type="checkbox"
                checked={showDebugPanel}
                onChange={(event) => setShowDebugPanel(event.target.checked)}
                className="h-4 w-4 accent-cyan-300"
              />
              <Settings2 className="h-4 w-4 text-cyan-300" />
              Enable debugging panel
            </label>
          </div>
          <UploadDropzone files={files} onFilesChange={handleFilesChange} />
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-slate-700/70 bg-slate-950/50 p-3 lg:flex-row lg:items-center lg:justify-between">
            <fieldset className="flex flex-col rounded-xl border border-slate-700/80 bg-slate-950/70 p-1 shadow-inner shadow-black/20 sm:flex-row">
              <legend className="sr-only">Extraction architecture</legend>
              {extractionApproachOptions.map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-lg px-3 py-2 text-center text-xs font-black uppercase tracking-[0.14em] transition ${
                    extractionApproach === option.value
                      ? "bg-cyan-300 text-slate-950 shadow-lg shadow-cyan-950/30"
                      : "text-slate-300 hover:bg-slate-800/80 hover:text-cyan-100"
                  }`}
                >
                  <input
                    type="radio"
                    name="extraction-approach"
                    value={option.value}
                    checked={extractionApproach === option.value}
                    onChange={() => setExtractionApproach(option.value)}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsRuntimeSettingsOpen(true)}
                className="inline-flex items-center justify-center rounded-xl border border-cyan-300/40 bg-slate-950/80 p-2.5 text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-300/10 hover:text-white"
                aria-label="Open extraction settings"
                title="Extraction settings"
              >
                <Settings2 className="h-4 w-4" />
              </button>
              <button
                onClick={addField}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-slate-950 hover:bg-cyan-200"
              >
                <Plus className="h-4 w-4" /> Add Field
              </button>
            </div>
          </div>
          <ExtractionLoadingPanel
            logs={runtimeLogs}
            isLoading={isLoading}
            onCancel={handleCancelExtraction}
          />
          <div
            className={`mt-4 grid gap-4 transition-all duration-700 ${showDebugPanel ? "2xl:grid-cols-2" : "xl:grid-cols-2 2xl:grid-cols-3"} translate-y-0 opacity-100`}
          >
            {fields.map((field) => (
              <FieldCardEditor
                key={field.id}
                field={field}
                result={extractionResults.find(
                  (result) =>
                    result.fieldId === String(field.id) ||
                    result.field === field.name,
                )}
                onChange={updateField}
                onRemove={() =>
                  setFields((current) =>
                    current.filter((item) => item.id !== field.id),
                  )
                }
              />
            ))}
          </div>
          {(extractionResults.length > 0 ||
            tokenCostMetrics ||
            backendLogText) && (
            <div
              ref={resultsSectionRef}
              className={`mx-auto max-w-6xl scroll-mt-6 transition-all duration-700 ${isLoading ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"}`}
            >
              <ResultsPanel
                results={extractionResults}
                tokenCostMetrics={tokenCostMetrics}
                hasBackendLogs={Boolean(backendLogText)}
                onViewCostMetrics={() => setIsCostMetricsOpen(true)}
                onDownload={handleDownloadOutput}
                onDownloadLogs={handleDownloadLogs}
                onSendToMcp={handleSendToMcp}
              />
            </div>
          )}
        </section>

        {showDebugPanel && (
          <aside className="hidden w-[40%] bg-[linear-gradient(180deg,#0b1020,#05070d)] p-5 xl:block">
            <div className="mb-5 grid grid-cols-3 gap-3">
              {debugSummaryMetrics.map((metric) => {
                const Icon = metric.icon;

                return (
                  <div
                    key={metric.label}
                    className="rounded-xl border border-slate-700 bg-slate-900/70 p-3"
                  >
                    <Icon className="mb-2 h-4 w-4 text-cyan-300" />
                    <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                      {metric.label}
                    </p>
                    <p className="mt-1 font-mono text-sm font-bold text-slate-100">
                      {metric.value}
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="mb-4 flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/70 p-4">
              <Bot className="h-5 w-5 text-cyan-300" />
              <div>
                <p className="text-sm font-semibold text-slate-100">
                  Debug Logs & Results
                </p>
                <p className="text-xs text-slate-500">
                  Full Python backend logs from the extraction runtime.
                </p>
              </div>
            </div>
            <DebugLogsPanel text={debugLogText} isLoading={isLoading} />

            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/80 p-4 text-xs text-slate-400">
              <ClipboardList className="mb-2 h-4 w-4 text-cyan-300" /> Audit
              trail sealed with immutable run metadata. Source citations remain
              attached to every field-level decision.
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}

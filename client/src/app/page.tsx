"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  DatabaseZap,
  Download,
  FileJson,
  Gauge,
  Layers3,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Settings2,
  TerminalSquare,
  UploadCloud,
  X,
} from "lucide-react";

type RouteType = "Scalar" | "Tabular";
type DataType = "String" | "Float" | "Date" | "Text Summary";

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

const initialLogs: RuntimeLog[] = [
  {
    time: "--:--:--",
    tone: "info",
    text: "Upload a PDF and run extraction to stream backend logs.",
  },
];

const initialResults: ExtractionResult[] = [
  {
    field: "Total Commitment",
    value: "$42,000,000",
    confidence: "99.2%",
    status: "validated",
  },
  {
    field: "Effective Date",
    value: "2026-04-01",
    confidence: "96.8%",
    status: "validated",
  },
  {
    field: "Net Asset Value",
    value: "$18,720,419",
    confidence: "71.4%",
    status: "alert",
    alert: "Math validation failed: subtotal + accruals mismatch by $12,080.",
  },
];

function UploadDropzone({
  file,
  onFileChange,
}: {
  file: File | null;
  onFileChange: (file: File | null) => void;
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
            {file
              ? file.name
              : "Drop or browse for a PDF. OCR and chunking start when you run extraction."}
          </p>
        </div>
        <label className="cursor-pointer rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 shadow-sm transition hover:border-cyan-300 hover:text-cyan-100">
          Browse
          <input
            className="sr-only"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onFileChange(event.target.files?.[0] ?? null)
            }
          />
        </label>
      </div>
    </div>
  );
}

function PdfPreview({ file }: { file: File | null }) {
  const previewUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  if (!previewUrl) return null;

  return (
    <section className="mt-4 rounded-2xl border border-slate-700/80 bg-slate-950/70 p-4 shadow-2xl shadow-black/20">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-black uppercase tracking-[0.22em] text-cyan-100">
          PDF Preview
        </h2>
        <span className="max-w-[50%] truncate text-xs text-slate-400">
          {file?.name}
        </span>
      </div>
      <iframe
        src={previewUrl}
        title={`PDF preview for ${file?.name ?? "uploaded document"}`}
        className="h-[560px] w-full rounded-xl border border-slate-800 bg-slate-900"
      />
    </section>
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

function BExtractorLogo({ isActive }: { isActive: boolean }) {
  return (
    <div
      className="relative flex h-28 w-28 items-center justify-center"
      aria-label="BExtractor animated processing logo"
    >
      <div
        className={`absolute inset-0 rounded-full bg-[conic-gradient(from_90deg,rgba(34,211,238,0),rgba(34,211,238,0.85),rgba(16,185,129,0.75),rgba(34,211,238,0))] p-px ${isActive ? "animate-spin" : ""}`}
      >
        <div className="h-full w-full rounded-full bg-slate-950" />
      </div>
      <div
        className={`absolute inset-3 rounded-full border border-cyan-300/20 bg-cyan-300/5 shadow-[0_0_40px_rgba(34,211,238,0.22)] ${isActive ? "animate-pulse" : ""}`}
      />
      <svg
        viewBox="0 0 96 96"
        className="relative h-20 w-20 drop-shadow-[0_0_18px_rgba(34,211,238,0.45)]"
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
        <div className="grid min-w-0 items-center gap-5 xl:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col items-center text-center">
            <BExtractorLogo isActive={isLoading} />
            <p className="mt-3 text-xs font-black uppercase tracking-[0.28em] text-cyan-200">
              BExtractor Active
            </p>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]" />
              <span className="line-clamp-1">{activeLog}</span>
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
      className={`min-w-0 flex flex-col rounded-2xl border border-slate-700 bg-slate-950/80 shadow-2xl shadow-black/30 ${compact ? "h-[22rem] w-full" : "h-80 w-full"}`}
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
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 font-mono text-xs"
      >
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

export default function Home() {
  const [fields, setFields] = useState(initialFields);
  const [file, setFile] = useState<File | null>(null);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLog[]>(initialLogs);
  const [debugLogText, setDebugLogText] = useState("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const [extractionResults, setExtractionResults] =
    useState<ExtractionResult[]>(initialResults);
  const [isLoading, setIsLoading] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [templateName, setTemplateName] = useState("BExtractor Template");
  const [tokenCostMetrics, setTokenCostMetrics] =
    useState<TokenCostMetrics | null>(null);
  const [backendLogText, setBackendLogText] = useState("");
  const [isCostMetricsOpen, setIsCostMetricsOpen] = useState(false);
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
  const appendLog = (tone: RuntimeLog["tone"], text: string) =>
    setRuntimeLogs((current) => [
      ...current,
      { time: timestamp(), tone, text },
    ]);

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
      abortControllerRef.current = null;
      setIsLoading(false);
      return;
    }

    if (normalizedEvent === "debug_log" && typeof data.message === "string") {
      setDebugLogText(
        (current) => `${current}${current ? "\n" : ""}${data.message}`,
      );
      return;
    }

    if (message)
      appendLog(
        coerceTone(
          data.tone ?? (normalizedEvent === "error" ? "error" : undefined),
        ),
        message,
      );

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
      if (typeof data.backend_log_text === "string") {
        setBackendLogText(data.backend_log_text);
        setDebugLogText(data.backend_log_text);
      }
      appendLog(
        "success",
        "Extraction stream completed and field cards were updated.",
      );
      setIsLoading(false);
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
      appendLog("success", "Extraction stream completed.");
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
      file?.name.replace(/\.pdf$/i, "") ||
      "bextract-output"
    ).trim();

  const serializeResultsForDownload = () => ({
    templateName: safeTemplateName(),
    exportedAt: new Date().toISOString(),
    results: extractionResults.map((result) => ({
      field: result.field,
      value: result.value,
      confidence: result.confidence,
      status: result.status,
      alert: result.alert ?? "",
    })),
  });

  const escapeCsvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;

  const handleDownloadOutput = (format: "csv" | "json") => {
    const payload = serializeResultsForDownload();
    const slug =
      payload.templateName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "bextract-output";
    const content =
      format === "json"
        ? JSON.stringify(payload, null, 2)
        : [
            [
              "template_name",
              "field",
              "value",
              "confidence",
              "status",
              "alert",
            ],
            ...payload.results.map((result) => [
              payload.templateName,
              result.field,
              result.value,
              result.confidence,
              result.status,
              result.alert,
            ]),
          ]
            .map((row) =>
              row.map((cell) => escapeCsvCell(String(cell))).join(","),
            )
            .join("\n");
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

  const handleCancelExtraction = () => {
    abortControllerRef.current?.abort();
    setIsLoading(false);
  };

  const handleRunExtraction = async () => {
    if (isLoading) return;

    if (!file) {
      appendLog("warn", "Select a PDF before starting extraction.");
      return;
    }

    setIsLoading(true);
    setRuntimeLogs([]);
    setDebugLogText("");
    setExtractionResults([]);
    setTokenCostMetrics(null);
    setBackendLogText("");
    setIsCostMetricsOpen(false);

    const fieldPayload = fields.map((field) => ({
      id: String(field.id),
      name: field.name,
      definition: field.definition,
      routeType: field.routeType,
      dataType: field.dataType,
    }));
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("fields", JSON.stringify(fieldPayload));
    formData.append("payload", JSON.stringify({ items: fieldPayload }));

    try {
      appendLog(
        "info",
        `Uploading ${file.name} with ${fields.length} field card${fields.length === 1 ? "" : "s"}.`,
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
      } else {
        appendLog(
          "error",
          error instanceof Error ? error.message : "Extraction request failed",
        );
      }
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#060913] text-slate-100">
      {isCostMetricsOpen && tokenCostMetrics && (
        <CostMetricsModal
          metrics={tokenCostMetrics}
          onClose={() => setIsCostMetricsOpen(false)}
        />
      )}
      <div className="flex min-h-screen">
        <section
          className={`${showDebugPanel ? "w-full xl:w-[60%] xl:border-r" : "w-full"} border-cyan-300/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_32%),linear-gradient(180deg,#0f172a,#070b14)] p-5 transition-all duration-500`}
        >
          <header className="mb-5 flex items-center justify-between">
            <div>
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em] text-cyan-300">
                <CircleDollarSign className="h-4 w-4" /> BExtractor
              </p>
              <h1 className="mt-2 text-2xl font-black tracking-tight text-white">
                Template Configurator
              </h1>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                onClick={handleRunExtraction}
                disabled={isLoading}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-300 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-slate-950 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Search
                  className={`h-4 w-4 ${isLoading ? "animate-pulse" : ""}`}
                />{" "}
                {isLoading ? "Extracting..." : "Run Extraction"}
              </button>
              <button
                onClick={addField}
                className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-slate-950 hover:bg-cyan-200"
              >
                <Plus className="h-4 w-4" /> Add Field
              </button>
            </div>
          </header>
          <div className="mb-4 grid gap-3 rounded-2xl border border-slate-700/70 bg-slate-950/50 p-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <label className="space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
                Template Name
              </span>
              <input
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                className="terminal-input"
                placeholder="Name used in CSV/JSON exports"
              />
            </label>
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
          <UploadDropzone file={file} onFileChange={setFile} />
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
          {!showDebugPanel && (
            <div
              className={`mx-auto max-w-6xl transition-all duration-700 ${isLoading ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"}`}
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
          <PdfPreview file={file} />
        </section>

        {showDebugPanel && (
          <aside className="hidden w-[40%] bg-[linear-gradient(180deg,#0b1020,#05070d)] p-5 xl:block">
            <div className="mb-5 grid grid-cols-3 gap-3">
              {[
                { label: "Run", value: "ADK-2049", icon: Play },
                { label: "Chunks", value: "018", icon: DatabaseZap },
                { label: "SLA", value: "1.8s", icon: Gauge },
              ].map((metric) => {
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
            <div
              className={`transition-all duration-700 ${isLoading ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"}`}
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

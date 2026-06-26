"use client";

import { useState } from "react";
import type { ChangeEvent } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  DatabaseZap,
  Gauge,
  Layers3,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
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

const initialFields: FieldCard[] = [
  {
    id: 1,
    name: "Total Commitment",
    definition: "Committed capital amount, including amendments and side-letter adjustments.",
    routeType: "Scalar",
    dataType: "Float",
  },
  {
    id: 2,
    name: "Fee Schedule",
    definition: "Extract tabular management fee tiers with basis, rate, and effective date.",
    routeType: "Tabular",
    dataType: "String",
  },
];

const initialLogs: RuntimeLog[] = [
  { time: "--:--:--", tone: "info", text: "Upload a PDF and run extraction to stream backend logs." },
];

const initialResults: ExtractionResult[] = [
  { field: "Total Commitment", value: "$42,000,000", confidence: "99.2%", status: "validated" },
  { field: "Effective Date", value: "2026-04-01", confidence: "96.8%", status: "validated" },
  {
    field: "Net Asset Value",
    value: "$18,720,419",
    confidence: "71.4%",
    status: "alert",
    alert: "Math validation failed: subtotal + accruals mismatch by $12,080.",
  },
];

function UploadDropzone({ file, onFileChange }: { file: File | null; onFileChange: (file: File | null) => void }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-dashed border-cyan-400/40 bg-cyan-400/[0.03] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition hover:border-cyan-300/70 hover:bg-cyan-400/[0.06]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-200">
          <UploadCloud className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-cyan-100">Upload Document</p>
          <p className="mt-1 text-xs text-slate-400">{file ? file.name : "Drop or browse for a PDF. OCR and chunking start when you run extraction."}</p>
        </div>
        <label className="cursor-pointer rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 shadow-sm transition hover:border-cyan-300 hover:text-cyan-100">
          Browse
          <input className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event: ChangeEvent<HTMLInputElement>) => onFileChange(event.target.files?.[0] ?? null)} />
        </label>
      </div>
    </div>
  );
}

function FieldCardEditor({ field, onChange, onRemove }: { field: FieldCard; onChange: (field: FieldCard) => void; onRemove: () => void }) {
  return (
    <article className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-4 shadow-2xl shadow-black/20">
      <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
          <Layers3 className="h-4 w-4 text-cyan-300" /> Field Card #{field.id}
        </div>
        <button onClick={onRemove} className="rounded-md p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-300" aria-label="Remove field">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Field Name</span>
          <input value={field.name} onChange={(event) => onChange({ ...field, name: event.target.value })} className="terminal-input" placeholder="e.g. NAV" />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Data Type</span>
          <div className="relative">
            <select value={field.dataType} onChange={(event) => onChange({ ...field, dataType: event.target.value as DataType })} className="terminal-input appearance-none pr-9">
              {(["String", "Float", "Date", "Text Summary"] as DataType[]).map((type) => <option key={type}>{type}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-500" />
          </div>
        </label>
      </div>
      <label className="mt-3 block space-y-1.5">
        <span className="text-xs font-medium text-slate-300">Definition</span>
        <textarea value={field.definition} onChange={(event) => onChange({ ...field, definition: event.target.value })} className="terminal-input min-h-20 resize-none" placeholder="Describe source language, constraints, and validation rules." />
      </label>
      <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-xl border border-slate-700 bg-slate-950 p-1">
        {(["Scalar", "Tabular"] as RouteType[]).map((route) => (
          <button key={route} onClick={() => onChange({ ...field, routeType: route })} className={`rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] transition ${field.routeType === route ? "bg-cyan-300 text-slate-950" : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"}`}>
            {route}
          </button>
        ))}
      </div>
    </article>
  );
}

function LogsPanel({ logs, isLoading }: { logs: RuntimeLog[]; isLoading: boolean }) {
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-950/80 shadow-2xl shadow-black/30">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100"><TerminalSquare className="h-4 w-4 text-cyan-300" /> Runtime Extraction Logs</div>
        <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-emerald-300">{isLoading ? "Live" : "Idle"}</span>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto p-4 font-mono text-xs">
        {logs.map((log) => (
          <div key={`${log.time}-${log.text}`} className="grid grid-cols-[64px_1fr] gap-3 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
            <span className="text-slate-500">{log.time}</span>
            <span className={log.tone === "success" ? "text-emerald-300" : log.tone === "warn" ? "text-amber-300" : log.tone === "error" ? "text-red-300" : "text-cyan-100"}>{log.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResultsPanel({ results }: { results: ExtractionResult[] }) {
  return (
    <section className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100"><ShieldCheck className="h-4 w-4 text-emerald-300" /> Extraction Results</h2>
        <span className="text-xs text-slate-500">3 fields · schema v2.1</span>
      </div>
      <div className="space-y-3">
        {results.map((result) => (
          <div key={result.field} className={`rounded-xl border p-3 ${result.status === "alert" ? "border-red-300/60 bg-red-950/25" : "border-emerald-400/20 bg-emerald-400/[0.04]"}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{result.field}</p>
                <p className="mt-1 text-lg font-semibold text-slate-50">{result.value}</p>
                <p className="mt-1 text-xs text-slate-400">Confidence {result.confidence}</p>
              </div>
              {result.status === "validated" ? <CheckCircle2 className="h-6 w-6 text-emerald-300" /> : <AlertTriangle className="h-6 w-6 text-red-300" />}
            </div>
            {result.status === "alert" && (
              <div className="mt-4 rounded-lg border border-red-300/30 bg-red-950/40 p-3">
                <p className="mb-3 text-sm font-semibold text-red-100">{result.alert}</p>
                <div className="grid gap-2 xl:grid-cols-[auto_1fr]">
                  <button className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-300 px-3 py-2 text-xs font-black uppercase tracking-[0.18em] text-red-950 hover:bg-red-200"><RefreshCw className="h-4 w-4" /> AI Re-Try</button>
                  <input className="terminal-input border-red-300/30" placeholder="Manual Edit: enter corrected value" />
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
  const [extractionResults, setExtractionResults] = useState<ExtractionResult[]>(initialResults);
  const [isLoading, setIsLoading] = useState(false);
  const addField = () => setFields((current) => [...current, { id: Date.now(), name: "", definition: "", routeType: "Scalar", dataType: "String" }]);
  const updateField = (updated: FieldCard) => setFields((current) => current.map((field) => (field.id === updated.id ? updated : field)));

  const timestamp = () => new Date().toLocaleTimeString("en-US", { hour12: false });
  const appendLog = (tone: RuntimeLog["tone"], text: string) => setRuntimeLogs((current) => [...current, { time: timestamp(), tone, text }]);

  const handleRunExtraction = async () => {
    if (!file) {
      appendLog("warn", "Select a PDF before starting extraction.");
      return;
    }

    setIsLoading(true);
    setRuntimeLogs([]);
    setExtractionResults([]);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("payload", JSON.stringify({
      items: fields.map((field) => ({
        id: String(field.id),
        name: field.name,
        definition: field.definition,
        type: field.routeType,
        dataType: field.dataType,
      })),
    }));

    try {
      const response = await fetch("/api/extract", { method: "POST", body: formData });
      if (!response.ok || !response.body) throw new Error(`Extraction request failed with ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const rawEvent of events) {
          const eventName = rawEvent.match(/^event: (.+)$/m)?.[1];
          const dataLine = rawEvent.match(/^data: (.+)$/m)?.[1];
          if (!dataLine) continue;
          const data = JSON.parse(dataLine);
          if (eventName === "log") appendLog(data.tone ?? "info", data.message);
          if (eventName === "result") {
            const rows = Object.values(data.structured_json?.results ?? {}) as Array<Record<string, unknown>>;
            setExtractionResults(rows.map((row) => ({
              field: String(row.field_name ?? row.item_id ?? "Unknown field"),
              value: String(row.value ?? ""),
              confidence: typeof row.confidence === "number" ? `${Math.round(row.confidence * 100)}%` : String(row.confidence ?? "n/a"),
              status: "validated",
            })));
            appendLog("success", `Database status: ${data.database?.status ?? "confirmed"}`);
          }
          if (eventName === "error") appendLog("error", data.detail ?? "Unknown extraction error");
        }
      }
    } catch (error) {
      appendLog("error", error instanceof Error ? error.message : "Extraction request failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#060913] text-slate-100">
      <div className="flex min-h-screen">
        <section className="w-[60%] border-r border-cyan-300/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_32%),linear-gradient(180deg,#0f172a,#070b14)] p-5">
          <header className="mb-5 flex items-center justify-between">
            <div>
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em] text-cyan-300"><CircleDollarSign className="h-4 w-4" /> BExtractor</p>
              <h1 className="mt-2 text-2xl font-black tracking-tight text-white">Template Configurator</h1>
            </div>
            <div className="flex gap-2"><button onClick={handleRunExtraction} disabled={isLoading} className="inline-flex items-center gap-2 rounded-xl bg-emerald-300 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-slate-950 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"><Play className="h-4 w-4" /> {isLoading ? "Running" : "Run"}</button><button onClick={addField} className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-slate-950 hover:bg-cyan-200"><Plus className="h-4 w-4" /> Add Field</button></div>
          </header>
          <UploadDropzone file={file} onFileChange={setFile} />
          <div className="mt-4 grid gap-4 2xl:grid-cols-2">
            {fields.map((field) => <FieldCardEditor key={field.id} field={field} onChange={updateField} onRemove={() => setFields((current) => current.filter((item) => item.id !== field.id))} />)}
          </div>
        </section>

        <aside className="w-[40%] bg-[linear-gradient(180deg,#0b1020,#05070d)] p-5">
          <div className="mb-5 grid grid-cols-3 gap-3">
            {[{ label: "Run", value: "ADK-2049", icon: Play }, { label: "Chunks", value: "018", icon: DatabaseZap }, { label: "SLA", value: "1.8s", icon: Gauge }].map((metric) => {
              const Icon = metric.icon;

              return (
                <div key={metric.label} className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
                  <Icon className="mb-2 h-4 w-4 text-cyan-300" />
                  <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{metric.label}</p>
                  <p className="mt-1 font-mono text-sm font-bold text-slate-100">{metric.value}</p>
                </div>
              );
            })}
          </div>
          <div className="mb-4 flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/70 p-4">
            <Bot className="h-5 w-5 text-cyan-300" />
            <div><p className="text-sm font-semibold text-slate-100">Runtime Extraction Logs & Results</p><p className="text-xs text-slate-500">Validation agent monitoring financial extraction output.</p></div>
          </div>
          <LogsPanel logs={runtimeLogs} isLoading={isLoading} />
          <ResultsPanel results={extractionResults} />
          <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/80 p-4 text-xs text-slate-400">
            <ClipboardList className="mb-2 h-4 w-4 text-cyan-300" /> Audit trail sealed with immutable run metadata. Source citations remain attached to every field-level decision.
          </div>
        </aside>
      </div>
    </main>
  );
}

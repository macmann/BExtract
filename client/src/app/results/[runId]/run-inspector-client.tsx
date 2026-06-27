"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronDown, Download, FileText, TerminalSquare } from "lucide-react";
import { findRun, type HistoricalRun, type RunDocument, type RunStatus } from "@/lib/results-data";

const statusStyles: Record<RunStatus, string> = {
  success: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  processing: "border-yellow-300/30 bg-yellow-300/10 text-yellow-100",
  failure: "border-red-400/30 bg-red-400/10 text-red-200",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function downloadFile(fileName: string, contents: string, type: string) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function documentCsv(documents: RunDocument[]) {
  const rows = documents.map((document) => [
    document.id,
    document.fileName,
    document.status,
    `${document.extractedFields}/${document.totalFields}`,
    document.emptyFields.join("; "),
    document.cost.toFixed(2),
  ]);
  return [["Document ID", "File Name", "Status", "Fields", "Empty Fields", "Cost"], ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

export default function RunInspectorClient({ runId }: { runId: string }) {
  const [run, setRun] = useState<HistoricalRun | null>(null);
  const [openLogId, setOpenLogId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setRun(findRun(runId) ?? null), 0);
    return () => window.clearTimeout(timer);
  }, [runId]);

  const totalTokens = useMemo(
    () => (run ? run.inputTokens + run.outputTokens : 0),
    [run],
  );

  if (!run) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-3xl rounded-3xl border border-slate-800 bg-slate-900 p-8">
          <p className="text-sm uppercase tracking-[0.2em] text-red-300">Run not found</p>
          <h1 className="mt-3 text-3xl font-bold">No inspector data for {runId}</h1>
          <Link className="mt-6 inline-flex text-cyan-200 hover:text-cyan-100" href="/results">Back to results</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.14),transparent_30%),linear-gradient(135deg,#020617,#0f172a_52%,#111827)] px-6 py-10 text-slate-100">
      <section className="mx-auto max-w-7xl space-y-6">
        <Link href="/results" className="inline-flex items-center gap-2 text-sm font-semibold text-cyan-200 hover:text-cyan-100">
          <ArrowLeft className="h-4 w-4" /> Back to history
        </Link>

        <div className="rounded-3xl border border-slate-700/80 bg-slate-950/80 p-6 shadow-2xl shadow-black/30 backdrop-blur">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold capitalize ${statusStyles[run.status]}`}>{run.status}</span>
              <h1 className="mt-4 font-mono text-3xl font-bold tracking-tight text-white md:text-5xl">{run.id}</h1>
              <p className="mt-3 text-sm text-slate-400">Started {formatDate(run.startedAt)} by {run.owner} using {run.model}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => downloadFile(`${run.id}.csv`, documentCsv(run.documents), "text/csv")} className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-bold text-cyan-100 hover:bg-cyan-300/15">
                <Download className="h-4 w-4" /> Export CSV
              </button>
              <button onClick={() => downloadFile(`${run.id}.json`, JSON.stringify(run, null, 2), "application/json")} className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900 px-4 py-2 text-sm font-bold text-slate-100 hover:border-cyan-300/70">
                <Download className="h-4 w-4" /> Export JSON
              </button>
            </div>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-5">
            {[
              ["Files", `${run.filesProcessed}/${run.totalFiles}`],
              ["Input tokens", run.inputTokens.toLocaleString()],
              ["Output tokens", run.outputTokens.toLocaleString()],
              ["Total tokens", totalTokens.toLocaleString()],
              ["Cost", `$${run.totalCost.toFixed(2)}`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</p>
                <p className="mt-2 text-xl font-bold text-white">{value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-700/80 bg-slate-950/80 p-5 shadow-2xl shadow-black/30">
          <div className="mb-5 flex items-center gap-3">
            <FileText className="h-5 w-5 text-cyan-300" />
            <div>
              <h2 className="text-xl font-bold text-white">Processed documents</h2>
              <p className="text-sm text-slate-500">Expand logs to debug null or empty extraction fields.</p>
            </div>
          </div>

          <div className="space-y-3">
            {run.documents.map((document) => (
              <article key={document.id} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="font-semibold text-white">{document.fileName}</h3>
                      <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold capitalize ${statusStyles[document.status]}`}>{document.status}</span>
                    </div>
                    <p className="mt-2 text-sm text-slate-400">{document.pages} pages · {document.extractedFields}/{document.totalFields} fields · ${document.cost.toFixed(2)}</p>
                    {document.emptyFields.length > 0 && <p className="mt-2 text-xs text-yellow-100">Empty/null fields: {document.emptyFields.join(", ")}</p>}
                  </div>
                  <button onClick={() => setOpenLogId(openLogId === document.id ? null : document.id)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-bold text-slate-200 hover:border-cyan-300/70">
                    <TerminalSquare className="h-4 w-4 text-cyan-300" /> View Logs <ChevronDown className={`h-4 w-4 transition ${openLogId === document.id ? "rotate-180" : ""}`} />
                  </button>
                </div>
                {openLogId === document.id && (
                  <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-300 shadow-inner shadow-black/30">
                    {document.logs.map((log) => <p key={log}>› {log}</p>)}
                  </div>
                )}
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

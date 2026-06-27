"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Check, Clipboard, FileSearch, Search } from "lucide-react";
import { fetchHistoricalRuns, type HistoricalRun, type RunStatus } from "@/lib/results-data";

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

export default function ResultsPage() {
  const router = useRouter();
  const [runs, setRuns] = useState<HistoricalRun[]>([]);
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    fetchHistoricalRuns()
      .then((loadedRuns) => {
        if (!isMounted) return;
        setRuns(loadedRuns);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load results history.");
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const copyRunId = async (runId: string) => {
    await navigator.clipboard.writeText(runId);
    setCopiedRunId(runId);
    window.setTimeout(() => setCopiedRunId(null), 1400);
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.16),transparent_32%),linear-gradient(135deg,#020617,#0f172a_48%,#111827)] px-6 py-10 text-slate-100">
      <section className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-5 rounded-3xl border border-slate-700/70 bg-slate-950/70 p-6 shadow-2xl shadow-black/30 backdrop-blur md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.24em] text-cyan-100">
              <FileSearch className="h-4 w-4" /> Results
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white md:text-5xl">
              Historical extraction runs
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              Review prior batches, copy run identifiers, and open the detailed inspector for document-level debugging.
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-3 text-slate-400">
            <Search className="h-4 w-4 text-cyan-300" />
            <span className="text-sm">{runs.length} tracked runs</span>
          </div>
        </div>

        {error && <div className="mb-4 rounded-2xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}

        <div className="overflow-hidden rounded-3xl border border-slate-700/80 bg-slate-950/80 shadow-2xl shadow-black/30">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-900/90 text-xs uppercase tracking-[0.2em] text-slate-400">
              <tr>
                <th className="px-5 py-4">Run ID</th>
                <th className="px-5 py-4">Date/Time</th>
                <th className="px-5 py-4">Files Processed</th>
                <th className="px-5 py-4">Total Cost</th>
                <th className="px-5 py-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {!isLoading && runs.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-slate-400">No extraction runs found.</td></tr>
              )}
              {isLoading && (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-slate-400">Loading extraction runs…</td></tr>
              )}
              {runs.map((run) => (
                <tr
                  key={run.id}
                  onClick={() => router.push(`/results/inspector?runId=${encodeURIComponent(run.id)}`)}
                  className="group cursor-pointer transition hover:bg-cyan-300/[0.04]"
                >
                  <td className="px-5 py-5">
                    <button
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void copyRunId(run.id);
                      }}
                      className="relative z-10 inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-cyan-100 transition hover:border-cyan-300"
                      title="Copy full run ID"
                    >
                      {run.id.slice(0, 12)}…
                      {copiedRunId === run.id ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Clipboard className="h-3.5 w-3.5 text-slate-500" />}
                    </button>
                  </td>
                  <td className="px-5 py-5 text-slate-300">{formatDate(run.startedAt)}</td>
                  <td className="px-5 py-5 font-semibold text-white">{run.filesProcessed}/{run.totalFiles}</td>
                  <td className="px-5 py-5 text-slate-300">${run.totalCost.toFixed(2)}</td>
                  <td className="px-5 py-5">
                    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold capitalize ${statusStyles[run.status]}`}>
                      {run.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

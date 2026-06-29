"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Download, FileText, TerminalSquare, X } from "lucide-react";
import { fetchHistoricalRun, type HistoricalRun, type RunDocument, type RunStatus, type SourceBBox, type SourceChunk, type SourceWord } from "@/lib/results-data";

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


type DisplayField = {
  id: string;
  name: string;
  value: unknown;
  confidence?: unknown;
  evidence?: unknown;
  sources: SourceChunk[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceChunksFrom(value: unknown): SourceChunk[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((source) => ({
    chunk_id: String(source.chunk_id ?? source.id ?? ""),
    page: (source.page as SourceChunk["page"]) ?? null,
    chunk: (source.chunk as SourceChunk["chunk"]) ?? null,
    chunk_text: String(source.chunk_text ?? source.text ?? ""),
    dense_score: typeof source.dense_score === "number" ? source.dense_score : null,
    bm25_score: typeof source.bm25_score === "number" ? source.bm25_score : null,
    rerank_score: typeof source.rerank_score === "number" ? source.rerank_score : null,
    bbox: isRecord(source.bbox) ? source.bbox as SourceBBox : null,
    words: Array.isArray(source.words) ? source.words.filter(isRecord).map((word) => word as SourceWord) : [],
    page_width: typeof source.page_width === "number" ? source.page_width : null,
    page_height: typeof source.page_height === "number" ? source.page_height : null,
  })).filter((source) => source.chunk_id || source.chunk_text);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function extractedFields(document: RunDocument): DisplayField[] {
  const payload = document.extractedPayload;
  if (!isRecord(payload)) return [];
  return Object.entries(payload).map(([id, raw]) => {
    if (isRecord(raw)) {
      return {
        id,
        name: String(raw.field_name ?? raw.table_name ?? raw.item_id ?? id),
        value: raw.value ?? raw.rows ?? raw.data ?? raw.answer,
        confidence: raw.confidence,
        evidence: raw.evidence,
        sources: sourceChunksFrom(raw.source_chunks ?? raw.sources),
      };
    }
    return { id, name: id, value: raw, sources: [] };
  });
}



type PdfJsApi = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (url: string) => { promise: Promise<{ getPage: (page: number) => Promise<{ getViewport: (options: { scale: number }) => { width: number; height: number }; render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> } }> }> };
};

declare global {
  interface Window { pdfjsLib?: PdfJsApi }
}

function loadPdfJs(): Promise<PdfJsApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("PDF preview is only available in the browser."));
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-pdfjs="true"]');
    const script = existing ?? document.createElement("script");
    script.dataset.pdfjs = "true";
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      if (!window.pdfjsLib) {
        reject(new Error("PDF.js failed to initialize."));
        return;
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error("PDF.js could not be loaded."));
    if (!existing) document.head.appendChild(script);
  });
}

type HighlightRect = { x0: number; y0: number; x1: number; y1: number };

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function highlightRectsFor(source: SourceChunk, fieldValue: unknown): HighlightRect[] {
  const words = source.words ?? [];
  const value = displayValue(fieldValue);
  const valueTokens = normalizeText(value).split(" ").filter(Boolean);
  if (words.length > 0 && valueTokens.length > 0) {
    const wordTokens = words.map((word) => normalizeText(word.text));
    for (let index = 0; index <= wordTokens.length - valueTokens.length; index += 1) {
      if (valueTokens.every((token, offset) => wordTokens[index + offset] === token)) {
        return words.slice(index, index + valueTokens.length).flatMap((word) => (
          typeof word.x0 === "number" && typeof word.y0 === "number" && typeof word.x1 === "number" && typeof word.y1 === "number"
            ? [{ x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1 }]
            : []
        ));
      }
    }
  }
  return source.bbox ? [source.bbox] : [];
}

function SourcePreviewModal({ runId, document, fieldName, fieldValue, sources, onClose }: { runId: string; document: RunDocument; fieldName: string; fieldValue: unknown; sources: SourceChunk[]; onClose: () => void }) {
  const primarySource = sources[0];
  const pageNumber = Number(primarySource?.page || 0);
  const pdfUrl = `/api/results/${encodeURIComponent(runId)}/files/${encodeURIComponent(document.id)}/pdf`;
  const rects = primarySource ? highlightRectsFor(primarySource, fieldValue) : [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="max-h-[90vh] w-full max-w-6xl overflow-hidden rounded-3xl border border-slate-700 bg-slate-950 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 p-5">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Source preview</p>
            <h2 className="mt-2 text-xl font-bold text-white">{fieldName}</h2>
            <p className="mt-1 text-sm text-slate-500">{document.fileName}</p>
          </div>
          <button onClick={onClose} className="rounded-full border border-slate-700 p-2 text-slate-300 hover:border-cyan-300/70 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid max-h-[75vh] gap-4 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {document.sourceFileAvailable && pageNumber > 0 ? (
            <PdfCanvas pdfUrl={pdfUrl} pageNumber={pageNumber} source={primarySource} rects={rects} />
          ) : (
            <div className="rounded-2xl border border-yellow-300/20 bg-yellow-300/10 p-5 text-sm text-yellow-100">
              {document.sourceFileAvailable ? "No page number is available for PDF navigation." : "The original PDF is unavailable for this run."}
            </div>
          )}
          <div className="space-y-4">
            {sources.map((source, index) => (
              <div key={`${source.chunk_id}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
                <div className="flex flex-wrap gap-3 text-xs font-semibold text-slate-400">
                  <span>Page {source.page ?? "unknown"}</span>
                  <span>Chunk {source.chunk ?? "unknown"}</span>
                  <span className="font-mono">{source.chunk_id}</span>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-200">{source.chunk_text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PdfCanvas({ pdfUrl, pageNumber, source, rects }: { pdfUrl: string; pageNumber: number; source: SourceChunk; rects: HighlightRect[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function renderPdf() {
      try {
        const pdfjs = await loadPdfJs();
        const pdf = await pdfjs.getDocument(pdfUrl).promise;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: context, viewport }).promise;
        context.fillStyle = "rgba(34, 211, 238, 0.30)";
        context.strokeStyle = "rgba(34, 211, 238, 0.95)";
        context.lineWidth = 1.5;
        const width = source.page_width || viewport.width / 1.35;
        const height = source.page_height || viewport.height / 1.35;
        rects.forEach((rect) => {
          const x = (rect.x0 / width) * viewport.width;
          const y = (rect.y0 / height) * viewport.height;
          const w = ((rect.x1 - rect.x0) / width) * viewport.width;
          const h = ((rect.y1 - rect.y0) / height) * viewport.height;
          context.fillRect(x, y, w, h);
          context.strokeRect(x, y, w, h);
        });
      } catch (renderError) {
        if (!cancelled) setError(renderError instanceof Error ? renderError.message : "Unable to render PDF preview.");
      }
    }
    void renderPdf();
    return () => { cancelled = true; };
  }, [pdfUrl, pageNumber, rects, source.page_height, source.page_width]);
  if (error) return <div className="rounded-2xl border border-yellow-300/20 bg-yellow-300/10 p-5 text-sm text-yellow-100">PDF preview unavailable: {error}</div>;
  return <div className="overflow-auto rounded-2xl border border-slate-800 bg-slate-900 p-3"><canvas ref={canvasRef} className="mx-auto max-w-full" /></div>;
}

function downloadRunArtifact(runId: string, format: "csv" | "json" | "logs") {
  window.location.href = `/api/results/${encodeURIComponent(runId)}/download?format=${format}`;
}

export default function RunInspectorClient({ runId }: { runId: string }) {
  const [run, setRun] = useState<HistoricalRun | null>(null);
  const [openLogId, setOpenLogId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSources, setSelectedSources] = useState<{ document: RunDocument; fieldName: string; fieldValue: unknown; sources: SourceChunk[] } | null>(null);

  useEffect(() => {
    let isMounted = true;
    fetchHistoricalRun(runId)
      .then((loadedRun) => {
        if (!isMounted) return;
        setRun(loadedRun);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load run details.");
        setRun(null);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [runId]);

  const totalTokens = useMemo(
    () => (run ? run.inputTokens + run.outputTokens : 0),
    [run],
  );

  if (!run) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-3xl rounded-3xl border border-slate-800 bg-slate-900 p-8">
          <p className="text-sm uppercase tracking-[0.2em] text-cyan-300">{isLoading ? "Loading run" : "Run not found"}</p>
          <h1 className="mt-3 text-3xl font-bold">{isLoading ? `Loading inspector data for ${runId}` : `No inspector data for ${runId}`}</h1>
          {error && <p className="mt-3 text-sm text-red-200">{error}</p>}
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
              <p className="mt-3 text-sm text-slate-400">Started {formatDate(run.startedAt)}{run.templateId ? ` · Template ${run.templateId}` : ""}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => downloadRunArtifact(run.id, "csv")} className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-bold text-cyan-100 hover:bg-cyan-300/15">
                <Download className="h-4 w-4" /> Export CSV
              </button>
              <button onClick={() => downloadRunArtifact(run.id, "json")} className="inline-flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900 px-4 py-2 text-sm font-bold text-slate-100 hover:border-cyan-300/70">
                <Download className="h-4 w-4" /> Export JSON
              </button>
              <button onClick={() => downloadRunArtifact(run.id, "logs")} className="inline-flex items-center gap-2 rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-300/15">
                <Download className="h-4 w-4" /> Export Logs
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
                    <p className="mt-2 text-sm text-slate-400">{document.extractedFields}/{document.totalFields} fields</p>
                    {document.emptyFields.length > 0 && <p className="mt-2 text-xs text-yellow-100">Empty/null fields: {document.emptyFields.join(", ")}</p>}
                  </div>
                  <button onClick={() => setOpenLogId(openLogId === document.id ? null : document.id)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-bold text-slate-200 hover:border-cyan-300/70">
                    <TerminalSquare className="h-4 w-4 text-cyan-300" /> View Logs <ChevronDown className={`h-4 w-4 transition ${openLogId === document.id ? "rotate-180" : ""}`} />
                  </button>
                </div>
                <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-slate-800 px-4 py-3 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
                    <span>Extracted fields</span>
                    <span>Sources</span>
                  </div>
                  {extractedFields(document).length > 0 ? extractedFields(document).map((field) => (
                    <div key={field.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-slate-800/80 px-4 py-3 last:border-b-0">
                      <div>
                        <p className="text-sm font-semibold text-white">{field.name}</p>
                        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm text-slate-300">{displayValue(field.value)}</pre>
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                          {field.confidence !== undefined && <span>Confidence: {String(field.confidence)}</span>}
                          {Boolean(field.evidence) && <span>Evidence: {String(field.evidence)}</span>}
                        </div>
                      </div>
                      <button
                        disabled={field.sources.length === 0}
                        onClick={() => setSelectedSources({ document, fieldName: field.name, fieldValue: field.value, sources: field.sources })}
                        className="self-start rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-xs font-bold text-cyan-100 hover:bg-cyan-300/15 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-900 disabled:text-slate-600"
                      >
                        View source
                      </button>
                    </div>
                  )) : (
                    <p className="px-4 py-3 text-sm text-slate-500">No extracted payload available.</p>
                  )}
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
      {selectedSources && (
        <SourcePreviewModal
          runId={run.id}
          document={selectedSources.document}
          fieldName={selectedSources.fieldName}
          fieldValue={selectedSources.fieldValue}
          sources={selectedSources.sources}
          onClose={() => setSelectedSources(null)}
        />
      )}
    </main>
  );
}

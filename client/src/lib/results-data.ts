export type RunStatus = "success" | "processing" | "failure";

export type RunDocument = {
  id: string;
  fileName: string;
  pages: number;
  status: RunStatus;
  emptyFields: string[];
  extractedFields: number;
  totalFields: number;
  cost: number;
  logs: string[];
};

export type HistoricalRun = {
  id: string;
  startedAt: string;
  filesProcessed: number;
  totalFiles: number;
  totalCost: number;
  status: RunStatus;
  model: string;
  owner: string;
  inputTokens: number;
  outputTokens: number;
  documents: RunDocument[];
};

export const historicalRuns: HistoricalRun[] = [
  {
    id: "run_8f42c91a7b0e",
    startedAt: "2026-06-27T14:18:00Z",
    filesProcessed: 12,
    totalFiles: 12,
    totalCost: 7.42,
    status: "success",
    model: "gpt-4.1",
    owner: "Capital Ops",
    inputTokens: 185420,
    outputTokens: 28440,
    documents: [
      {
        id: "doc_lpa_001",
        fileName: "Northstar Fund IV - LPA.pdf",
        pages: 84,
        status: "success",
        emptyFields: [],
        extractedFields: 18,
        totalFields: 18,
        cost: 1.92,
        logs: [
          "OCR completed with 99.1% confidence across 84 pages.",
          "Resolved commitment, fee schedule, and waterfall sections.",
          "Validated extracted scalar fields against source citations.",
        ],
      },
      {
        id: "doc_sub_002",
        fileName: "Subscription Packet - Archer LP.pdf",
        pages: 32,
        status: "success",
        emptyFields: [],
        extractedFields: 12,
        totalFields: 12,
        cost: 0.88,
        logs: [
          "Detected investor profile table on pages 8-11.",
          "Normalized EIN and domicile fields.",
          "No null fields returned by extraction schema.",
        ],
      },
      {
        id: "doc_side_003",
        fileName: "Side Letter - Horizon Advisors.pdf",
        pages: 14,
        status: "success",
        emptyFields: ["MFN Election Window"],
        extractedFields: 9,
        totalFields: 10,
        cost: 0.41,
        logs: [
          "MFN clause found, but no explicit election window date was present.",
          "Returned null for MFN Election Window after citation check.",
          "Developer note: verify pages 12-13 if source document is amended.",
        ],
      },
    ],
  },
  {
    id: "run_72bd4fa19c35",
    startedAt: "2026-06-27T13:04:00Z",
    filesProcessed: 8,
    totalFiles: 10,
    totalCost: 4.18,
    status: "processing",
    model: "gpt-4.1-mini",
    owner: "Deal Team",
    inputTokens: 104905,
    outputTokens: 19220,
    documents: [
      {
        id: "doc_q2_001",
        fileName: "Q2 Capital Account Statement.pdf",
        pages: 21,
        status: "success",
        emptyFields: [],
        extractedFields: 14,
        totalFields: 14,
        cost: 0.72,
        logs: ["Statement tables parsed successfully.", "NAV and unfunded commitment matched summary page."],
      },
      {
        id: "doc_notice_002",
        fileName: "Capital Call Notice - June.pdf",
        pages: 7,
        status: "processing",
        emptyFields: [],
        extractedFields: 5,
        totalFields: 11,
        cost: 0.19,
        logs: ["Chunk embeddings queued.", "Awaiting final scalar extraction response from model."],
      },
    ],
  },
  {
    id: "run_a61408ed3f99",
    startedAt: "2026-06-26T20:45:00Z",
    filesProcessed: 5,
    totalFiles: 9,
    totalCost: 2.96,
    status: "failure",
    model: "gpt-4.1",
    owner: "QA Sandbox",
    inputTokens: 76210,
    outputTokens: 8084,
    documents: [
      {
        id: "doc_scan_001",
        fileName: "Legacy Scan - Watermarked.pdf",
        pages: 56,
        status: "failure",
        emptyFields: ["Management Fee", "Commitment Amount", "Effective Date"],
        extractedFields: 0,
        totalFields: 15,
        cost: 1.03,
        logs: [
          "OCR confidence fell below threshold on 41 pages.",
          "Extraction returned empty strings for required financial fields.",
          "Recommended action: rerun with enhanced OCR preprocessing.",
        ],
      },
    ],
  },
];

export function findRun(runId: string) {
  return historicalRuns.find((run) => run.id === runId);
}

# BExtractor - Agentic Financial Document Extraction

BExtractor is an enterprise-grade document extraction engine for complex financial, insurance, and compliance documents. It enables teams to define dynamic extraction schemas through a user interface, parse layout-aware PDFs while preserving table structures, and run high-fidelity extraction through a multi-agent, self-correcting LLM workflow.

At runtime, BExtractor ingests source documents, indexes layout-aware chunks for hybrid retrieval, routes scalar and tabular extraction tasks through a Google ADK-powered agent graph, validates the compiled output with a critic agent, and persists validated structured data into a relational PostgreSQL database.

## What BExtractor Does

BExtractor is designed for documents where accuracy, traceability, and table integrity matter:

- **Dynamic schemas:** Business users can define the exact fields and tables they want extracted without hard-coding a new parser for every document type.
- **Layout-aware document parsing:** Complex grids and repeated rows are preserved as intact Markdown-style table content so downstream extraction avoids row fragmentation.
- **Agentic extraction and validation:** Specialized LLM agents extract scalar values and tables, while a critic agent checks formatting, accounting relationships, and mathematical consistency before database insertion.
- **Relational persistence:** Validated extraction payloads, raw text, chunks, metadata, embeddings, and template associations are stored in PostgreSQL through Prisma.
- **Operational visibility:** The backend streams extraction progress to the frontend with Server-Sent Events so users can follow the workflow node-by-node, records batch-level execution history, and exposes downloadable JSON, CSV, and troubleshooting logs.

## Architecture Overview

BExtractor uses a deliberately simple **single-server monolithic architecture** optimized for deployment on Render. The production service is one native Python web service: FastAPI owns the API, serves the static Next.js export at `/`, and exposes extraction endpoints under `/api`.

```text
Browser
  |
  |  Static UI + SSE extraction logs
  v
FastAPI single web service
  |-- Serves Next.js static export from client/out at /
  |-- Exposes REST/SSE API routes under /api
  |-- Runs PDF ingestion and retrieval indexing
  |-- Builds and executes Google ADK extraction workflows
  |-- Persists validated extraction results through Prisma
  v
Neon Serverless PostgreSQL + pgvector
```

### Tech Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Frontend | Next.js App Router, static export, Tailwind CSS, Lucide React | Browser UI for template configuration, multi-file document upload, execution monitoring, and historical results inspection. |
| Backend | Python, FastAPI, Uvicorn | Single web service that serves the static frontend and handles API/SSE extraction, batch orchestration, results history, and export routes. |
| Agent Orchestration | Google Agent Development Kit (ADK 2.0) | Graph-based multi-agent extraction, critique, retry, and persistence workflow. |
| Database | Neon Serverless PostgreSQL, Prisma ORM with Python Client | Relational storage for templates, extraction results, chunks, metadata, and vector embeddings. |
| RAG & Search | PyPDF2, `pgvector`, Google `gemini-embedding-001`, `rank_bm25`, Reciprocal Rank Fusion (RRF) | Text-layer PDF extraction, overlapping chunk indexing, and hybrid retrieval using dense semantic search plus sparse keyword search. |
| Deployment | Render native Python web service | One service builds the frontend, installs backend dependencies, and runs FastAPI. |

## Key Product Features

### Dynamic UI Configurator

BExtractor supports configurable extraction templates that can contain different item types:

- **Scalar extraction routes** for isolated values such as policy numbers, total assets, dates, limits, premiums, insured names, or financial ratios.
- **Tabular extraction routes** for structured grids such as schedules, statement tables, bordereaux, claim listings, and financial line-item tables.

The backend normalizes template payloads and dynamically builds the extraction graph from the configured fields and tables.

### PDF Text Extraction and Chunking

The current ingestion path uses PyPDF2 before chunking: uploaded PDF bytes are opened with `PdfReader`, text is extracted page-by-page with `page.extract_text()`, and only then is the extracted page text split into overlapping retrieval chunks. This means BExtractor chunks text extracted from the PDF text layer, not raw PDF bytes directly.

Financial and insurance PDFs often contain dense tables, merged headers, multi-page schedules, and repeated row groups. BExtractor preserves the text that PyPDF2 returns as intact retrieval context so the tabular extractor can maintain:

- Row order
- Column names
- Numeric types
- Source evidence
- Page and chunk metadata

This prevents common extraction failures where rows are split across unrelated chunks or values are detached from their labels. Because the current parser is PyPDF2 text extraction rather than OCR, scanned/image-only PDFs require an embedded text layer or a future OCR preprocessing step before they can produce useful chunks.

### Agentic Self-Correction

BExtractor uses a multi-agent loop instead of a one-shot extraction call:

1. A dynamic workflow is generated from the user's schema.
2. Scalar items are routed to a scalar extractor agent.
3. Tabular items are routed to a table-focused extractor agent.
4. Results are compiled into a single structured payload.
5. A **Critic Agent** checks mathematical, accounting, date, and formatting constraints.
6. If the critic finds an issue, the graph routes the failed item back through a retry path with actionable critique.
7. Only validated or corrected payloads are committed to the database.

This design catches issues such as subtotal mismatches, malformed dates, inconsistent ranges, or accounting equations that do not balance.

### Batch Execution, Results History, and Exports

The extraction endpoint accepts one or more PDF files in the same multipart request. FastAPI creates a `PipelineRun` record for the batch and a `FileExtraction` record for each uploaded file, then processes the files sequentially so one failed document does not stop the rest of the batch. Each file record stores status, extracted payload, backend troubleshooting logs, and error details when applicable. The batch record aggregates processed-file counts, token usage, output tokens, and total estimated cost.

The frontend now includes a historical results area at `/results` and a per-run inspector at `/results/inspector?runId=...`. Users can review prior runs, copy run IDs, delete old runs, inspect document-level empty fields and logs, and download run artifacts. The results API supports:

- `GET /api/results` - list historical pipeline runs, newest first.
- `GET /api/results/{run_id}` - return a run with child file extraction records and payloads.
- `DELETE /api/results/{run_id}` - delete a run and its cascaded file extraction records.
- `GET /api/results/{run_id}/download?format=json|csv|logs` - stream extracted payloads or logs for offline review.

The active extraction stream also emits a `batch_export` event when all files finish. The server writes batch-level CSV and JSON exports under `server/exports` and serves them from `/exports`.

### Real-Time Execution Logs

The API streams extraction progress as Server-Sent Events. The frontend can display live status updates such as document ingestion, graph construction, item processing, critic validation, database commit, per-file batch progress, export generation, and completion.

## Repository Structure

```text
BExtract/
├── README.md
├── build.sh                  # Render build script for frontend and backend dependencies
├── package.json              # Root Prisma tooling scripts
├── render.yaml               # Render native Python web service configuration
├── prisma/
│   └── schema.prisma         # PostgreSQL, pgvector, Prisma JS, and Prisma Python schema
├── client/
│   ├── package.json          # Next.js frontend dependencies and scripts
│   ├── next.config.js        # Static export configuration
│   └── src/
│       └── app/
│           ├── layout.tsx    # App Router root layout
│           ├── page.tsx      # Main BExtractor UI
│           ├── results/      # Historical run list and per-run inspector UI
│           └── globals.css   # Tailwind/global styles
└── server/
    ├── __init__.py
    ├── main.py               # FastAPI app, API routes, batch/SSE streaming, static frontend serving
    ├── routes/results.py     # Historical results, delete, and download endpoints
    ├── pipeline.py           # Google ADK multi-agent extraction graph and DB commit nodes
    ├── ingestion.py          # PDF parsing, chunking, embedding generation, pgvector persistence
    ├── custom_tools.py       # Hybrid search tool: pgvector + BM25 + RRF
    └── requirements.txt      # Python backend dependencies
```

## Local Setup & Installation

### Prerequisites

Install the following before running BExtractor locally:

- **Node.js 20+** recommended for the Next.js frontend.
- **Python 3.10+** for the FastAPI backend.
- **PostgreSQL with `pgvector` enabled**, or a Neon Serverless PostgreSQL database with the vector extension available.
- **Google API key** with access to Gemini models and `gemini-embedding-001`.

### Environment Variables

Create a `.env` file at the repository root and export the same values in your shell before starting the backend.

```bash
cp .env.example .env  # If your environment provides one; otherwise create .env manually.
```

Required keys:

```bash
GOOGLE_API_KEY="your-google-api-key"
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require"
DIRECT_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require"
```

| Variable | Description |
| --- | --- |
| `GOOGLE_API_KEY` | Used by Google Gemini agents and the `gemini-embedding-001` embedding model. |
| `DATABASE_URL` | Prisma pooled/runtime connection string for Neon PostgreSQL. |
| `DIRECT_URL` | Prisma direct connection string used for schema operations such as `db push`. |

> **Note:** The FastAPI server validates these variables on startup and exits early if any are missing.

### Step 1: Build the Frontend

The frontend is a strict static export. Build it before starting the backend so FastAPI can serve `client/out` at `/`.

```bash
cd client
npm install
npm run build
cd ..
```

### Step 2: Set Up the Database

From the repository root, push the Prisma schema to your PostgreSQL database:

```bash
npx prisma db push
```

If this is your first time using Prisma Python Client in the environment, also generate clients as needed:

```bash
npx prisma generate
```

### Step 3: Install Backend Dependencies

Install the Python dependencies from the `server` directory:

```bash
cd server
python -m pip install -r requirements.txt
```

### Step 4: Run the Server

Start the FastAPI server from the repository root so Python can resolve the `server` package imports correctly:

```bash
uvicorn server.main:app --reload --host 0.0.0.0 --port 8000
```

Then open:

```text
http://localhost:8000
```

Useful API endpoints:

- `GET /api/health` - health check for the BExtractor API.
- `POST /api/extract` - multipart one-or-more document extraction endpoint that streams Server-Sent Events.
- `GET /api/results` - historical pipeline run list.
- `GET /api/results/{run_id}` - detailed run inspector payload.
- `GET /api/results/{run_id}/download?format=json|csv|logs` - run export downloads.
- `DELETE /api/results/{run_id}` - delete a historical run and file records.

## Deployment on Render

BExtractor is configured for Render as a single native Python web service.

- `render.yaml` declares the web service, build command, and start command.
- `build.sh` installs Node.js when necessary, builds the static Next.js frontend, and installs Python backend dependencies.
- FastAPI serves the generated frontend from `client/out` and exposes API routes from the same service.

Typical Render lifecycle:

```bash
./build.sh
uvicorn server.main:app --host 0.0.0.0 --port $PORT
```

Use this exact Render start command:

```bash
uvicorn server.main:app --host 0.0.0.0 --port $PORT
```

Configure the following Render environment variables:

```text
GOOGLE_API_KEY
DATABASE_URL
DIRECT_URL
NODE_VERSION=20
```

## Latest Documentation Updates

- Clarified that PDF ingestion uses PyPDF2 text extraction before chunking.
- Clarified that chunking operates on page-level extracted text with overlapping windows, not directly on raw PDF bytes.
- Updated retrieval documentation to reference the current `gemini-embedding-001` embedding model and 3072-dimensional pgvector storage.
- Documented the current limitation that image-only PDFs need an embedded text layer or future OCR preprocessing.
- Documented multi-file batch extraction, `PipelineRun` / `FileExtraction` persistence, the `/results` UI, and JSON/CSV/log exports.

## Data Flow

```text
1. User defines scalar and tabular extraction fields in the UI.
2. User uploads one or more PDFs and starts extraction.
3. FastAPI creates a PipelineRun plus one FileExtraction row per uploaded file.
4. For each file, FastAPI reads the upload and passes the PDF bytes to the ingestion pipeline.
5. PyPDF2 extracts text page-by-page before chunking.
6. Page text is split into overlapping retrieval chunks.
7. Chunks are embedded with Google gemini-embedding-001 and stored in pgvector.
8. Extractor agents call the hybrid search tool for relevant context.
9. Dense vector matches and sparse BM25 matches are fused with RRF.
10. Scalar and tabular agents produce structured JSON.
11. The critic agent validates the compiled payload.
12. Failed items are retried with critique; empty outputs can be retried by the verifier.
13. Passing payloads are committed to ExtractionResult and mirrored into FileExtraction history.
14. The frontend receives per-file SSE results, batch export links, and the final done event.
15. Users can revisit runs from /results, inspect logs, delete runs, or download JSON/CSV/log exports.
```

## Development Notes

- The frontend must remain compatible with Next.js static export because the production backend serves files from `client/out`.
- API routes should live in FastAPI under `/api`; do not depend on Next.js server-side runtime behavior in production.
- Keep extraction logic in backend modules so the Render deployment remains a single Python service.
- Use schema-driven extraction definitions whenever possible instead of hard-coded document-specific parsers.
- Preserve table context during ingestion and retrieval to avoid row fragmentation in tabular extraction.

## License

This repository is currently private/internal. Add the appropriate license before public distribution.

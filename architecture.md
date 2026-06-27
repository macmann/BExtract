# BExtractor Architecture

BExtractor is a single-service, agentic document extraction platform for financial, insurance, and compliance PDFs. It is designed to explain **what should be extracted**, retrieve the most relevant source evidence, run specialized extraction agents, validate the result, and persist a traceable structured payload for downstream systems.

This document is written for technical architects and technical investors. It focuses on the runtime architecture, the extraction pipeline, the agent topology, and the retrieval strategy that combines PostgreSQL, `pgvector`, BM25, and Reciprocal Rank Fusion.

> Note: This document intentionally uses plain-text flow charts instead of Mermaid diagrams so the architecture remains readable in every Markdown viewer, PDF export, pull-request diff, and investor deck.

## Executive Architecture Summary

BExtractor runs as a **FastAPI monolith**. The same backend process serves the static Next.js frontend, exposes the extraction API, parses PDFs, indexes document chunks, builds a Google ADK workflow, streams execution progress with Server-Sent Events (SSE), and commits the final validated JSON to PostgreSQL.

The platform is easiest to understand as five connected layers:

| Layer | What it contains | Main responsibility |
| --- | --- | --- |
| 1. Experience | Next.js static UI | Template builder, PDF upload, live progress logs, and final extraction review. |
| 2. API / Orchestration | FastAPI, SSE, ADK workflow runner, optional pre-injected RAG runner | Request handling, workflow construction, progress streaming, token/cost auditing, and result delivery. |
| 3. Document Intelligence | PyPDF2 PDF text extraction, chunking, embeddings, hybrid search | Converts PDF text-layer content into retrievable evidence chunks. |
| 4. Agent Runtime | Scalar extractor, tabular extractor, critic agent | Performs extraction, validates the payload, and retries failed items. |
| 5. Persistence | PostgreSQL, Prisma, `pgvector` | Stores templates, chunks, vectors, raw text, and validated structured JSON. |

### Component Flow Chart

```text
+--------------------------+
| User / Technical Reviewer|
+------------+-------------+
             |
             v
+--------------------------+
| Next.js Static UI        |
| - Template builder       |
| - PDF upload             |
| - Live SSE logs          |
+------------+-------------+
             |
             | POST /api/extract
             | PDF + template JSON
             v
+---------------------------------------------------------------+
| FastAPI Monolith                                              |
|                                                               |
|  +-------------------+     +-------------------------------+  |
|  | API endpoints     | --> | PDF ingestion + chunking       |  |
|  | SSE stream        |     | Embedding generation trigger   |  |
|  +-------------------+     +-------------------------------+  |
|            |                              |                   |
|            v                              v                   |
|  +-------------------+     +-------------------------------+  |
|  | ADK workflow      | --> | Agent runtime                  |  |
|  | dynamic graph     |     | scalar / tabular / critic      |  |
|  +-------------------+     +-------------------------------+  |
|            |                              |                   |
|            v                              v                   |
|  +-------------------+     +-------------------------------+  |
|  | Hybrid search     | <-- | Commit validated payload       |  |
|  | pgvector+BM25+RRF |     | to ExtractionResult            |  |
|  +-------------------+     +-------------------------------+  |
+------------+------------------------------+-------------------+
             |                              |
             v                              v
+--------------------------+     +------------------------------+
| Google AI Services      |     | PostgreSQL / Neon + pgvector |
| - Gemini extraction     |     | - DocumentTemplate           |
| - Embedding model       |     | - ExtractionResult           |
|                          |     | - DocumentChunk vector(3072) |
+--------------------------+     +------------------------------+
```

## Primary Runtime Components

| Component | Implementation | Responsibility |
| --- | --- | --- |
| Browser UI | Next.js static export | Template configuration, PDF upload, execution monitoring, and rendered extraction output. |
| API server | FastAPI | Serves static UI, receives extraction requests, streams SSE logs, invokes ingestion, executes ADK workflow, and returns final JSON. |
| PDF ingestion | `server/ingestion.py` with PyPDF2 | Opens uploaded PDF bytes with `PdfReader`, extracts page text with `page.extract_text()`, creates overlapping chunks, generates embeddings, and writes chunks to `DocumentChunk`. |
| Vector database | PostgreSQL with `pgvector` | Stores chunk text, metadata, and 3072-dimensional embeddings for semantic retrieval. |
| Relational data store | PostgreSQL + Prisma | Stores templates, extraction results, raw text, chunk metadata, and final structured JSON. |
| Hybrid search tool | `server/custom_tools.py` | Combines dense vector search, BM25 sparse search, and Reciprocal Rank Fusion. |
| Agent workflow | Google ADK `Workflow` | Dynamically creates extraction nodes from the submitted template and routes validation/retry behavior for the default agentic path. |
| Pre-injected RAG runner | Direct Gemini generation with retrieved chunks | Optional stateless extraction path that retrieves evidence first, injects it into a per-field prompt, and records the same token/cost audit shape. |
| Runtime observability | SSE, captured backend logs, token/cost audit ledger | Streams user-facing progress, exports troubleshooting logs, and reports per-node token usage and estimated cost. |
| LLM agents | Gemini via Google ADK | Scalar extraction, tabular extraction, and critic validation. |

## End-to-End Extraction Flow

The extraction run has two major phases: **index the uploaded PDF**, then **run extraction against the indexed evidence**. Indexing currently starts with PyPDF2 text-layer extraction before chunking; the system does not chunk raw PDF bytes directly. The default `agentic` approach uses the dynamic Google ADK workflow. A second pre-injected RAG approach can run stateless per-field Gemini calls after hybrid retrieval has selected the evidence chunks.

```text
PHASE 1 - INDEX THE DOCUMENT

User
  |
  | 1. Configure template and upload PDF
  v
Next.js UI
  |
  | 2. POST PDF + template JSON to /api/extract
  v
FastAPI
  |
  | 3. Read upload, derive document_id, open SSE stream
  v
PDF ingestion pipeline
  |
  | 4. Open PDF bytes with PyPDF2 PdfReader
  | 5. Extract text per page with page.extract_text()
  | 6. Split extracted page text into overlapping chunks
  | 7. Generate document embedding for each chunk
  v
PostgreSQL + pgvector
  |
  | 8. Store DocumentChunk rows:
  |    - chunk_text
  |    - metadata
  |    - embedding vector(3072)
  v
Indexed evidence base ready for agent search
```

```text
PHASE 2 - EXTRACT, VALIDATE, AND COMMIT

FastAPI
  |
  | 8. Choose extraction approach from payload
  |    - agentic: build Google ADK workflow from template items
  |    - pre-injected: retrieve chunks first and call Gemini per item
  v
Dynamic extraction runtime
  |
  | 9. For each scalar/table item, choose extractor type
  v
Scalar or tabular extractor agent
  |
  | 10. Call document_hybrid_search(field_name, definition)
  v
Hybrid search tool
  |
  | 11. Dense pgvector search + sparse BM25 search
  | 12. Fuse rankings with Reciprocal Rank Fusion
  | 13. Return top evidence chunks
  v
Extractor agent
  |
  | 14. Produce strict JSON result with evidence
  v
Compiled extraction payload
  |
  | 15. Critic validates math, accounting, dates, format
  v
+----------------------------+
| Did the critic pass?       |
+-------------+--------------+
              |
     +--------+---------+
     |                  |
     v                  v
  Yes: continue    No: retry only
  to final checks  failed item with
     |             critic feedback
     v                  +-----> back to relevant extractor
Empty-result verifier
  |
  | 16. Retry missing/unusable fields up to 3 times
  v
Commit final JSON to database
  |
  v
Next.js UI
  |
  | 17. Receive final SSE result and done event
  v
User reviews structured extraction output
```

## Latest Architecture Updates

- PDF ingestion is now documented as a two-step text-first path: PyPDF2 extracts page text, then the chunker splits that extracted text.
- The architecture diagrams and pipeline tables now make clear that raw PDF bytes are not chunked directly.
- The current embedding/indexing path is documented as 3072-dimensional `gemini-embedding-001` vectors stored in PostgreSQL with `pgvector`.
- Runtime execution now includes a shared **empty-result verification retry** safety net. Agentic workflow results are normalized first, then any missing or unusable item is retried through the stateless pre-injected verifier up to three times with alternate retrieval.
- The pre-injected RAG path now performs per-field query transformation before retrieval, classifies narrative fields for a wider evidence window, and applies the same up-to-three verification retry loop when a field returns no usable value.
- Retry attempts intentionally change search angle by using synonyms, nearby labels, abbreviations, and table headers; each retry expands the retrieval budget and records token/cost audit entries for both query transformation and extraction calls.
- Agentic execution now emits heartbeat SSE logs while the ADK workflow is still running, so long-running critic/extractor runs remain visible in the browser.
- Current limitation: PyPDF2 does not provide OCR for scanned/image-only PDFs; those files need an embedded text layer or an OCR preprocessing enhancement.

## Document Processing Pipeline

The document processing pipeline has clear subsystem ownership. Each step transforms the document into a more structured or more retrievable representation.

| Step | Owner | Input | Output | Why it matters |
| ---: | --- | --- | --- | --- |
| 1 | Next.js UI | User-defined fields/tables and PDF | Multipart form payload | Keeps extraction schema dynamic and user-configurable. |
| 2 | FastAPI | Multipart form payload | `document_id`, `file_name`, uploaded bytes | Establishes the extraction run identity. |
| 3 | PDF ingestion | PDF bytes | Page-level text extracted by PyPDF2 | Converts the PDF text layer into machine-readable text before any chunking occurs. |
| 4 | Chunker | Extracted page text | Overlapping text chunks | Preserves local context while keeping retrieval units small; raw PDF bytes are not chunked directly. |
| 5 | Embedding generator | Chunk text | 3072-dimensional vector | Enables semantic search over document evidence. |
| 6 | Prisma/raw SQL | Chunk text, metadata, vector | `DocumentChunk` rows | Persists source evidence for search and traceability. |
| 7 | Runtime selector | Template JSON and `approach` / `extractionApproach` | ADK workflow nodes or pre-injected per-field prompts | Creates one extraction path per requested field/table. |
| 8 | Extractor agents | Item definition and retrieved context | Strict JSON value/table rows | Produces structured extraction output. |
| 9 | Critic agent / audit layer | Compiled payload and model events | Pass/fail decision, optional critique, token/cost metrics | Adds quality control, targeted retry, and operational cost visibility. |
| 10 | Empty-result verifier | Missing/empty normalized results | Retried field results plus retry audit metrics | Recovers fields that were missed because first-pass retrieval or context was too narrow. |
| 11 | Commit node | Validated and retry-augmented payload | `ExtractionResult` row | Stores final result for downstream review and integration. |

### Pipeline Flow Chart

```text
[Template JSON] -----------------------------+
                                             |
                                             v
[PDF Upload] --> [FastAPI /api/extract] --> [PyPDF2 Page Text Extraction]
                                             |
                                             v
                                      [Chunk Text]
                                             |
                                             v
                                [Generate Embeddings]
                                             |
                                             v
                          [Store DocumentChunk + vector]
                                             |
                                             v
                            [Build Dynamic ADK Graph]
                                             |
                                             v
                       [Run Scalar / Tabular Extractors]
                                             |
                                             v
                               [Hybrid Search Evidence]
                                             |
                                             v
                              [Compile Result Payload]
                                             |
                                             v
                                [Critic Validation]
                                  /          \
                                 /            \
                              pass            fail
                               |                |
                               v                v
                    [Empty-Result Verifier] [Retry Failed Item]
                               |                |
                               v                |
                         [Commit Result] <------+
                               |
                               v
                         [SSE Final JSON]
```


## Extraction Approach Selection and Observability

The API accepts an `approach` or `extractionApproach` value in the template payload. When the value is `agentic`, FastAPI builds the dynamic ADK workflow, executes it through the ADK `Runner`, normalizes returned item results, and routes the critic result to either a targeted retry or database commit. When the value is anything else, the backend runs the pre-injected RAG path: each template item calls hybrid search first, the retrieved evidence is embedded directly into a strict JSON prompt, and Gemini returns one normalized item result at a time.

Both paths share the same ingestion, retrieval scope, result normalization, database commit, and SSE response envelope. The response includes `token_cost_metrics`, `node_audit_summary`, `backend_log_text`, and `backend_log_lines` so operators can inspect token usage, estimated cost, node-level activity, and captured backend diagnostics from the browser.

```text
/api/extract
  |
  v
[Index PDF chunks once]
  |
  v
[Read approach / extractionApproach]
  |
  +--> agentic ------------------> [ADK Runner + critic + retry routing]
  |                                      |
  |                                      v
  +--> pre-injected RAG ----------> [Hybrid search + direct Gemini per item]
                                         |
                                         v
                         [Normalize results + token/cost audit]
                                         |
                                         v
                         [Empty-result verification retry]
                                         |
                                         v
                         [Prisma commit + SSE result/debug logs]
```

## Agent Topology

BExtractor currently defines **three reusable agent roles** and creates a dynamic workflow instance for each extraction request.

| Agent | Count in code | Runtime behavior | Purpose |
| --- | ---: | --- | --- |
| `scalar_extractor` | 1 reusable base agent | Cloned once per scalar template item with a unique output key. | Extract isolated values such as dates, policy numbers, totals, ratios, names, and limits. |
| `tabular_extractor` | 1 reusable base agent | Cloned once per tabular template item with a unique output key. | Parse retrieved table-like context into structured JSON rows while preserving columns, order, numeric values, and evidence. |
| `critic_agent` | 1 agent | Runs after all item results are compiled. | Validates the full payload, identifies one failed item if needed, and routes retry instructions. |

### How Many Agents Are in a Run?

The code defines **3 agent roles**. At runtime, the number of extractor agent nodes is dynamic:

```text
runtime_agent_nodes = number_of_template_items + 1 critic agent
```

For example:

| Template contents | Runtime extractor nodes | Critic nodes | Total agent nodes |
| --- | ---: | ---: | ---: |
| 3 scalar fields | 3 | 1 | 4 |
| 2 scalar fields + 2 tables | 4 | 1 | 5 |
| 10 mixed fields/tables | 10 | 1 | 11 |

The extractor nodes are selected by item type. `type = "Tabular"` routes to the tabular extractor; all other item types route to the scalar extractor.

## Agent Workflow Flow Chart

The workflow is generated from the template. The following example shows a template with two scalar fields and one table.

```text
START
  |
  v
[seed_template_state]
  |
  v
+---------------------------------------------------------+
| Template Item 1: Scalar field                           |
| [prepare item 1] -> [scalar_extractor clone] -> [collect]|
+---------------------------------------------------------+
  |
  v
+---------------------------------------------------------+
| Template Item 2: Tabular field                          |
| [prepare item 2] -> [tabular_extractor clone] -> [collect]|
+---------------------------------------------------------+
  |
  v
+---------------------------------------------------------+
| Template Item 3: Scalar field                           |
| [prepare item 3] -> [scalar_extractor clone] -> [collect]|
+---------------------------------------------------------+
  |
  v
[compile_payload]
  |
  v
[critic_agent]
  |
  v
+----------------------+
| route_critic_result  |
+----------+-----------+
           |
      +----+-------------------------------+
      |                                    |
      v                                    v
 status=pass                         status=fail
      |                                    |
      v                                    v
[db_commit_node]              [retry only failed item]
      |                                    |
      v                                    |
    DONE <---------------------------------+
```

The retry loop is intentionally narrow. The critic identifies **exactly one failed item** and attaches actionable critique to that item. The workflow then reruns only the affected extractor path instead of repeating the entire document extraction.


## Retry and Recovery Mechanisms

BExtractor uses two complementary retry mechanisms. They solve different failure modes and are intentionally scoped so the system avoids expensive full-document reruns.

| Retry mechanism | Applies to | Trigger | Maximum attempts | Retry scope | Retrieval behavior | Audit behavior |
| --- | --- | --- | ---: | --- | --- | --- |
| Critic-routed agentic retry | `agentic` workflow | Critic returns `status = fail` with a retryable `failed_item_id` | Workflow route dependent; one failed item is routed at a time | Only the failed template item | Re-enters that item's prepare/extractor/collect path with critic feedback in state | Captured as part of the ADK workflow event and node audit output. |
| Empty-result verification retry | `pre-injected` path and post-`agentic` safety net | Normalized item result has no usable extracted content | 3 per empty field | Only missing/empty fields | Generates a fresh 3-5 word search query, asks for alternate labels/synonyms/table headers on retries, expands retrieved chunks, and reruns isolated extraction | Adds query-transform and extraction audit nodes, usage entries, and token/cost metrics. |

### Critic-Routed Agentic Retry

The ADK graph compiles item-level results, runs the critic, and then calls `route_critic_result`. If the critic passes, the payload goes to the database commit node. If the critic fails and names a known template item, the route becomes `retry_<item_id>` and the graph jumps back to that item's prepare node. This keeps the correction loop focused on the single item the critic believes is wrong, rather than rebuilding every extraction result.

```text
[compile_payload]
      |
      v
[critic_agent]
      |
      v
[route_critic_result]
      |
      +-- status=pass ------------------> [db_commit_node]
      |
      +-- status=fail + failed_item_id --> [prepare failed item]
                                          |
                                          v
                                  [extract failed item]
                                          |
                                          v
                                      [collect]
                                          |
                                          v
                                  [compile_payload]
```

### Empty-Result Verification Retry

Empty-result verification is a retrieval-focused recovery path for cases where a model response is syntactically valid but does not contain a usable value. The same policy is shared across both extraction approaches:

1. Detect item results whose `value`/table rows are null, empty, or equivalent to common not-found markers.
2. For each empty field, run up to three isolated verifier attempts.
3. Generate a concise retrieval query for the field before each attempt.
4. On retry attempts, instruct the query generator to use a different search angle: synonyms, nearby labels, abbreviations, or table headers.
5. Increase the chunk budget on retries so the verifier can inspect more context; narrative fields keep a protected wider context window.
6. Prompt the extractor with the prior empty result and require it to return `null` only after explicitly checking the supplied evidence.
7. Stop retrying that field as soon as a usable result is produced.
8. Merge verifier results back into the main extraction result and combine token/cost metrics.

```text
[Normalized extraction results]
          |
          v
[Find empty / unusable fields]
          |
          +-- none -------------------------------> [Commit / return]
          |
          v
[For each empty field]
          |
          v
[Generate alternate retrieval query]
          |
          v
[Hybrid search with expanded chunk budget]
          |
          v
[Isolated strict-JSON extraction]
          |
          v
+------------------------+
| Usable result found?   |
+-----------+------------+
            |
     +------+------+
     |             |
    yes            no, attempts remain
     |             |
     v             v
[Merge result]   [Retry with different query angle]
     |
     v
[Combine audit + token/cost metrics]
```

This design separates **correctness retry** from **coverage retry**. The critic-routed retry handles inconsistent or incorrect extracted values; the empty-result verifier handles missing values caused by weak first-pass retrieval or overly narrow context.

## Retrieval and Search Architecture

BExtractor uses hybrid retrieval so extractor agents receive evidence that is both semantically relevant and keyword-specific.

### Hybrid Search Flow Chart

```text
Extractor query
(field/table name + definition)
          |
          v
+---------+--------------------------------------------------+
|                                                            |
| Dense semantic branch                                      |
|   1. Generate query embedding                              |
|   2. Search pgvector with cosine distance                  |
|   3. Return top 10 dense matches                           |
|                                                            |
+---------+--------------------------------------------------+
          |
          | contributes ranked list
          v
+---------+--------------------------------------------------+
| Reciprocal Rank Fusion                                     |
| - Takes dense ranked list and sparse ranked list            |
| - Uses rank_constant = 60                                  |
| - Produces one fused ranking                               |
+---------+--------------------------------------------------+
          ^
          | contributes ranked list
+---------+--------------------------------------------------+
|                                                            |
| Sparse lexical branch                                      |
|   1. Tokenize query and chunk text                         |
|   2. Rank all loaded chunks with BM25Okapi                 |
|   3. Return top 10 sparse matches                          |
|                                                            |
+---------+--------------------------------------------------+
          |
          v
Top 3 fused chunks
          |
          v
Evidence context sent to scalar/table extractor
```

### Dense Search with `pgvector`

During ingestion, each document chunk is embedded and stored as a `vector(3072)` column. During retrieval, the search tool embeds the query and orders chunks by pgvector cosine distance using the `<=>` operator. Dense search is useful for semantic matches where the document uses different wording than the template definition.

### Sparse Search with BM25

The search tool also loads chunk text and ranks it using BM25 over normalized alphanumeric tokens. BM25 is useful for exact identifiers, financial line-item names, dates, table headings, and domain terms that should not be lost in a purely semantic search.

### Reciprocal Rank Fusion

Dense and sparse rankings are merged with Reciprocal Rank Fusion (RRF):

```text
score(chunk) = sum(1 / (rank_constant + rank_in_each_ranking))
```

The implementation uses a rank constant of `60`, fuses dense and sparse matches, and returns the top three chunk texts to the requesting extractor agent.

## Data Model

```text
DocumentTemplate
  id             primary key
  name           template name
  description    optional description
  config         extraction schema JSON
  createdAt      creation timestamp
  updatedAt      update timestamp
       |
       | one template can produce many extraction results
       v
ExtractionResult
  id             primary key
  documentId     logical document/run identifier
  fileName       uploaded PDF name
  rawText        extracted full raw text
  data           final structured extraction JSON
  confidence     optional confidence score
  status         pending/indexing/validated/etc.
  templateId     optional foreign key to DocumentTemplate
  createdAt      creation timestamp
  updatedAt      update timestamp
       |
       | one extraction result owns many indexed chunks
       v
DocumentChunk
  id             primary key
  extraction_id  foreign key to ExtractionResult
  chunk_text     retrieval text
  embedding      pgvector vector(3072)
  metadata       page/chunk metadata JSON
```

## Repository Structure and Ownership

```text
BExtract/
|
+-- client/                         Frontend user experience
|   +-- src/app/page.tsx            Main template/upload/extraction UI
|   +-- src/app/layout.tsx          App shell
|   +-- src/app/globals.css         Global styles
|
+-- server/                         Extraction runtime
|   +-- main.py                     FastAPI, SSE, static serving, /api/extract
|   +-- ingestion.py                PDF parsing, chunking, embeddings, pgvector inserts
|   +-- pipeline.py                 ADK agents, dynamic graph, critic, commit node
|   +-- custom_tools.py             Hybrid search: pgvector + BM25 + RRF
|   +-- requirements.txt            Python dependencies
|
+-- prisma/                         Database contract
|   +-- schema.prisma               PostgreSQL models and vector extension
|
+-- build.sh                        Render build script
+-- render.yaml                     Render service configuration
+-- README.md                       Project overview and setup
+-- architecture.md                 This architecture document
```

## Extraction Walkthrough

1. **Template creation**: The UI sends fields/tables as JSON. Each item includes a name, type, definition, and optional data type.
2. **PDF ingestion**: The backend reads the uploaded PDF, uses PyPDF2 to extract page text from the PDF text layer, and splits each page of extracted text into overlapping chunks.
3. **Embedding and indexing**: Each chunk is embedded with Google's embedding model and stored in PostgreSQL with `pgvector`.
4. **Workflow construction**: The backend creates a Google ADK workflow. For each template item, it adds prepare, extractor, and collect nodes.
5. **Context retrieval**: Each extractor calls `document_hybrid_search` with the item name and definition.
6. **Hybrid ranking**: The search tool runs pgvector nearest-neighbor search, BM25 keyword ranking, and RRF fusion.
7. **Strict JSON extraction**: Scalar and tabular agents return constrained JSON with values/rows, confidence, evidence, and critique response.
8. **Compilation**: Individual results are collected into a single payload keyed by template item ID.
9. **Critic validation**: The critic checks cross-field consistency, accounting equations, subtotals, date ranges, formatting, and template compliance.
10. **Critic retry or pass**: Failed items are routed back through their extractor with critique; passing payloads proceed toward finalization.
11. **Empty-result verification**: Missing or unusable item outputs are retried up to three times with alternate query generation, expanded context, and isolated strict-JSON extraction.
12. **Commit and client update**: The API streams progress and final structured JSON back to the browser over SSE.

## Technical Investor Notes

- **Template-driven scale**: New document types can be added by configuring extraction templates instead of writing bespoke parsers.
- **Traceability**: Results include source evidence and are linked to raw text, chunks, metadata, and template records.
- **Retrieval quality**: Combining `pgvector` semantic retrieval with BM25 keyword ranking reduces misses on both paraphrased content and exact financial terms.
- **Validation loop**: The critic/retry design improves reliability for high-value documents where subtotals, ratios, date ranges, and accounting relationships matter.
- **Deployment simplicity**: The current architecture is deployable as one Render web service while still preserving clean separation between UI, API, ingestion, retrieval, orchestration, and persistence concerns. Render starts the app from the repository root with `uvicorn server.main:app --host 0.0.0.0 --port $PORT` so package imports resolve consistently.

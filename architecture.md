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
| 2. API / Orchestration | FastAPI, SSE, ADK workflow runner | Request handling, workflow construction, progress streaming, and result delivery. |
| 3. Document Intelligence | PDF parsing, chunking, embeddings, hybrid search | Converts documents into retrievable evidence chunks. |
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
| PDF ingestion | `server/ingestion.py` | Extracts text page-by-page, creates overlapping chunks, generates embeddings, and writes chunks to `DocumentChunk`. |
| Vector database | PostgreSQL with `pgvector` | Stores chunk text, metadata, and 3072-dimensional embeddings for semantic retrieval. |
| Relational data store | PostgreSQL + Prisma | Stores templates, extraction results, raw text, chunk metadata, and final structured JSON. |
| Hybrid search tool | `server/custom_tools.py` | Combines dense vector search, BM25 sparse search, and Reciprocal Rank Fusion. |
| Agent workflow | Google ADK `Workflow` | Dynamically creates extraction nodes from the submitted template and routes validation/retry behavior. |
| LLM agents | Gemini via Google ADK | Scalar extraction, tabular extraction, and critic validation. |

## End-to-End Extraction Flow

The extraction run has two major phases: **index the uploaded PDF**, then **run agent extraction against the indexed evidence**.

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
  | 4. Extract text per page with PyPDF2
  | 5. Split page text into overlapping chunks
  | 6. Generate document embedding for each chunk
  v
PostgreSQL + pgvector
  |
  | 7. Store DocumentChunk rows:
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
  | 8. Build Google ADK workflow from template items
  v
Dynamic ADK workflow
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
  Yes: commit       No: retry only
  final JSON        failed item with
  to database       critic feedback
     |                  |
     v                  +-----> back to relevant extractor
Next.js UI
  |
  | 16. Receive final SSE result and done event
  v
User reviews structured extraction output
```

## Document Processing Pipeline

The document processing pipeline has clear subsystem ownership. Each step transforms the document into a more structured or more retrievable representation.

| Step | Owner | Input | Output | Why it matters |
| ---: | --- | --- | --- | --- |
| 1 | Next.js UI | User-defined fields/tables and PDF | Multipart form payload | Keeps extraction schema dynamic and user-configurable. |
| 2 | FastAPI | Multipart form payload | `document_id`, `file_name`, uploaded bytes | Establishes the extraction run identity. |
| 3 | PDF ingestion | PDF bytes | Page-level text | Converts source file into machine-readable text. |
| 4 | Chunker | Page text | Overlapping text chunks | Preserves local context while keeping retrieval units small. |
| 5 | Embedding generator | Chunk text | 3072-dimensional vector | Enables semantic search over document evidence. |
| 6 | Prisma/raw SQL | Chunk text, metadata, vector | `DocumentChunk` rows | Persists source evidence for search and traceability. |
| 7 | ADK graph builder | Template JSON | Dynamic workflow nodes | Creates one extraction path per requested field/table. |
| 8 | Extractor agents | Item definition and retrieved context | Strict JSON value/table rows | Produces structured extraction output. |
| 9 | Critic agent | Compiled payload | Pass/fail decision and optional critique | Adds quality control and targeted retry. |
| 10 | Commit node | Validated payload | `ExtractionResult` row | Stores final result for downstream review and integration. |

### Pipeline Flow Chart

```text
[Template JSON] -----------------------------+
                                             |
                                             v
[PDF Upload] --> [FastAPI /api/extract] --> [PDF Text Extraction]
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
                         [Commit Result]   [Retry Failed Item]
                               |                |
                               v                |
                         [SSE Final JSON] <-----+
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
2. **PDF ingestion**: The backend reads the uploaded PDF, extracts page text, and splits each page into overlapping chunks.
3. **Embedding and indexing**: Each chunk is embedded with Google's embedding model and stored in PostgreSQL with `pgvector`.
4. **Workflow construction**: The backend creates a Google ADK workflow. For each template item, it adds prepare, extractor, and collect nodes.
5. **Context retrieval**: Each extractor calls `document_hybrid_search` with the item name and definition.
6. **Hybrid ranking**: The search tool runs pgvector nearest-neighbor search, BM25 keyword ranking, and RRF fusion.
7. **Strict JSON extraction**: Scalar and tabular agents return constrained JSON with values/rows, confidence, evidence, and critique response.
8. **Compilation**: Individual results are collected into a single payload keyed by template item ID.
9. **Critic validation**: The critic checks cross-field consistency, accounting equations, subtotals, date ranges, formatting, and template compliance.
10. **Retry or commit**: Failed items are routed back through their extractor with critique; passing payloads are committed to PostgreSQL.
11. **Client update**: The API streams progress and final structured JSON back to the browser over SSE.

## Technical Investor Notes

- **Template-driven scale**: New document types can be added by configuring extraction templates instead of writing bespoke parsers.
- **Traceability**: Results include source evidence and are linked to raw text, chunks, metadata, and template records.
- **Retrieval quality**: Combining `pgvector` semantic retrieval with BM25 keyword ranking reduces misses on both paraphrased content and exact financial terms.
- **Validation loop**: The critic/retry design improves reliability for high-value documents where subtotals, ratios, date ranges, and accounting relationships matter.
- **Deployment simplicity**: The current architecture is deployable as one Render web service while still preserving clean separation between UI, API, ingestion, retrieval, orchestration, and persistence concerns.

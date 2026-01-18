# ARCHITECTURE.md

This is a student-friendly (“ELI5”) explanation of how the PDF Chat App works.
The guiding idea is simple:

> Don’t send the entire PDF to the AI.
> First find the relevant pages, then ask the AI using only those pages.

That keeps answers grounded, fast, and cheap.

## 1) Overview

### Components
- **Frontend (React + Vite)**: upload PDFs, select documents, ask questions, view citations.
- **Backend (Node.js + Express)**: extract text from PDFs, chunk + index it, run retrieval, call the LLM.
- **Storage (Supabase Postgres + Storage)**: persist document metadata + extracted text + chunks, and store raw PDFs.

### Data flow (end-to-end)
1) User uploads a PDF
2) Backend extracts text per page
3) Backend groups pages into chunks and stores them
4) Backend builds a TF‑IDF index for chunks (cheap “search engine”)
5) When a user asks a question:
   - retrieve top matching chunks
   - send only those chunks + the question to the LLM
6) UI renders the answer and the cited page ranges

## 2) Document Processing Strategy

### 2.1 How text extraction works
We use `pdfjs-dist` to read the PDF and extract text **page-by-page**.
This matters because citations are easiest when we keep page numbers.

If a PDF is scanned (images of text), extraction may return very little text.
We detect that with a heuristic (`scannedLikely`) and warn the user.

### 2.2 Handling large documents (why we don’t break)
Large PDFs break naive LLM apps because:
- the LLM has a limited “context window” (it can’t read infinite text at once)
- sending huge prompts is slow and expensive

So we never attempt “PDF → LLM” directly.
We always do **PDF → chunks → retrieval → LLM**.

Optional protection: `MAX_PAGES` can cap extraction work for extreme PDFs.

### 2.3 Chunking strategy
Chunking is just splitting the document into smaller pieces.

Implementation:
- concatenate adjacent pages until ~3,500 characters
- keep an overlap tail (~300 characters) when moving to the next chunk

Each chunk stores:
- `id` (stable per doc)
- `pageStart`, `pageEnd`
- `text`

Why this approach:
- **Citation-friendly** (page ranges come for free)
- **Predictable** (fixed-size chunks are easy to budget)
- **Cheap** (no embedding API needed for the baseline)

Trade-offs:
- Chunk boundaries can split a concept; overlap reduces but doesn’t eliminate this
- TF‑IDF is lexical (keyword matching); embeddings can be better for semantic queries

## 3) Retrieval Strategy (finding the right passages)

We use a local TF‑IDF + cosine similarity index:
- build vectors for each chunk
- build a vector for the query
- rank chunks by similarity

Why TF‑IDF:
- $0 in embedding costs
- fast enough for an interview-sized app
- good baseline quality for “find the section that mentions X”

What we’d do with more time:
- use embeddings (e.g., pgvector) for better semantic recall
- add a reranker to reduce `TOP_K` without losing answer quality

## 4) LLM Integration

### 4.1 Provider + model
The backend uses the Groq SDK (`groq-sdk`) and a configurable model (default is an 8B class model).

Why this choice:
- low latency (good for interactive chat)
- easy OpenAI-compatible API shape
- configurable via env vars so it’s easy to swap models/providers

### 4.2 Prompt construction (how we keep it grounded)
We send:
- a **system prompt** that forbids guessing and requires citations
- a **user message** containing:
  - `DOCUMENT SOURCES` (the retrieved chunk excerpts)
  - `QUESTION`

The assistant is instructed to cite sources like `(Source 1)`, `(Source 2)`.

### 4.3 Context management strategy
We enforce a strict budget so prompts don’t grow with PDF size:
- only send **top‑K** chunks
- cap chunk length (`MAX_CHUNK_CHARS`)
- cap total context (`MAX_TOTAL_CONTEXT_CHARS`)
- include only the last N chat messages (`CHAT_HISTORY_MESSAGES`)

This makes cost and latency predictable.

### 4.4 Cost optimization techniques used
- No embeddings API (TF‑IDF local index)
- Hard caps on context size (`MAX_TOTAL_CONTEXT_CHARS`)
- For summary-style questions, use map-reduce summarization instead of “stuff the whole doc”
- Cache summaries in storage once generated

## 5) Production Scenario Solutions (Phase 2)

For each scenario below:
- what broke in a naive design
- how we fix it (implemented or proposed)
- trade-offs
- what we’d improve

### Scenario 1: Large document performance (150 pages / ~75k words)

What breaks initially:
- **Context window** overflow if you try to send the whole paper
- **Latency** if you summarize dozens of chunks one-by-one
- **Cost** if you repeatedly summarize large text

Fix (implemented): map-reduce summarization
- Select a bounded set of chunks (relevant + evenly sampled)
- **Map**: summarize each chunk (batched to reduce calls)
- **Reduce**: combine chunk summaries into “key findings” with citations
- Cache per-chunk map summaries (TTL) + cache final summary in DB

Trade-offs:
- Some nuance can be lost in chunk-level summaries
- Requires careful instruction to avoid hallucinations

With more time:
- store “chunk abstracts” on upload
- add document-structure cues (section headings) to improve summarization quality

### Scenario 2: Rapid-fire questions (10 questions quickly)

What breaks initially:
- rate limits / spikes in concurrent LLM calls
- duplicated costs for repeated or highly similar questions
- slow responses if every question triggers a fresh LLM call

Fix (proposed next step for production):
- per-user/per-doc rate limiting and concurrency caps
- micro-batching: combine questions arriving within a short window (e.g., 250–500ms)
- answer/retrieval caching keyed by (docId, query, settings)

Trade-offs:
- batching introduces a tiny intentional delay to capture bursts
- cache invalidation requires versioning if docs can change

With more time:
- Redis-backed cache + queue for multi-instance deployments

### Scenario 3: Multi-user isolation (don’t show other users’ docs)

What breaks initially:
- without auth + ownership, `GET /api/documents` can list everyone’s docs
- service-role keys bypass RLS, so you must enforce ownership yourself or switch to user-scoped queries

Fix (recommended for production):
- add `owner_id` to documents/chunks
- enable Supabase RLS: users can only `select/insert/update/delete` their own rows
- require auth on all doc routes, and scope queries by `owner_id`

Trade-offs:
- more moving pieces (Auth + policies)
- debugging requires understanding RLS

### Scenario 4: Support multiple PDFs in one chat

What breaks initially:
- you can’t just concatenate multiple PDFs into one prompt
- retrieval across many docs can get slow and can blow the context budget

Fix (proposed): multi-document retrieval
- pick candidate docs (routing) → retrieve top chunks from those docs → merge into one bounded context
- label sources with doc name + pages

Trade-offs:
- more retrieval complexity
- must fairly allocate context budget across docs

### Scenario 5: “100 documents per user”, “<2s”, “<$0.01/question”

What breaks initially:
- in-memory indexes don’t scale across instances
- retrieval across 100 docs per query is too slow
- sending too many chunks increases tokens/cost

Fix (architecture change): 2-stage router + bounded RAG
- stage A: doc routing (BM25/tsvector on summaries) to select top 3–8 docs
- stage B: chunk retrieval within candidates (TF‑IDF/embeddings)
- stage C: single LLM call with hard token caps
- add Redis caching for retrieval + answers

Trade-offs:
- more infra (Redis, indexes)
- more pre-processing (summaries, embeddings)

With more time:
- embeddings + ANN indexes (pgvector)
- reranking for better quality with fewer chunks

## 6) Feature Extension Design: Document Comparison

### Why this feature
It demonstrates that the architecture generalizes: retrieval is done per document, then the LLM compares using only retrieved excerpts.

### Design decisions for ambiguous requirements
- Citations:
  - answer cites sources as `(A1)`, `(B2)`
  - UI also shows page ranges and excerpt snippets for transparency
- If no excerpts are found:
  - still run the prompt with placeholders, but instruct the model to say it cannot support claims

### Assumptions
- docs are primarily text PDFs (not scanned)
- “compare” can be answered from a small set of excerpts

### Limitations
- TF‑IDF retrieval may miss semantic matches
- comparisons across many sections may require higher `TOP_K` or better retrieval

## 7) Storage Notes

- Supabase Postgres stores documents + extracted pages + chunks.
- Raw PDFs are stored in Supabase Storage.
- TF‑IDF index is rebuilt in-memory when a doc is loaded (simple baseline).

## 8) Project Structure (quick map)

- backend/src/server.js: Express routes
- backend/src/pdf.js: PDF extraction + chunking
- backend/src/retrieval.js: TF‑IDF + cosine similarity
- backend/src/summary.js: map-reduce summarization for key findings
- backend/src/llm.js: Groq chat completions
- backend/src/store.js: Supabase-backed document store
- frontend/src/App.tsx: UI
- frontend/src/api.ts: API client

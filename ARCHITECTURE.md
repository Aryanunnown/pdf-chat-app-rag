# ARCHITECTURE.md

This document explains how the app works, and why the design choices were made.

## Overview

Two parts:
- **Frontend**: React (Vite) single-page app for upload, chat, and compare.
- **Backend**: Node.js + Express API for PDF processing, retrieval, and LLM calls.

Data flow:
1) User uploads PDF
2) Backend extracts text and chunks it
3) Backend builds a retrieval index
4) For each question, backend retrieves a few relevant chunks and sends only those (not the full PDF) to the LLM
5) UI shows the answer + citations (page ranges + excerpts)

## Document Processing Strategy

### How we extract text
- Uses `pdfjs-dist` to read PDFs and extract text **page-by-page**.
- Page boundaries are preserved so we can cite the answer’s sources as **page ranges**.

### Handling large documents
- The backend never sends the whole document to the LLM.
- It chunks the document and only sends the most relevant chunks per question.
- Optional `MAX_PAGES` can cap processing (useful for very large PDFs or memory constraints).

### Chunking strategy
- Pages are concatenated until the chunk reaches a target size (~3500 characters).
- A small overlap (~300 characters) is carried forward to reduce “boundary misses”.
- Each chunk stores:
  - `pageStart`, `pageEnd`
  - `text`
  - `id`

Why this approach:
- Simple, predictable, and citation-friendly.
- Easy to debug in an interview.
- Avoids premature vector DB complexity.

## Retrieval Strategy (finding relevant passages)

This implementation uses a **local TF‑IDF index**:
- Build TF‑IDF vectors for each chunk.
- Build a TF‑IDF vector for the question.
- Use cosine similarity to pick top‑K chunks.

Why TF‑IDF:
- No paid embedding API calls.
- Fast and cost-effective.
- Works surprisingly well for many “find the section” style questions.

If semantic retrieval is needed later:
- Replace TF‑IDF with embeddings + cosine similarity.
- The system is already structured around “chunks → retrieve topK → LLM”.

## LLM Integration

### Provider & model
- Uses the Groq SDK (`groq-sdk`) with an optional configurable base URL.
- Provider: **Groq**.

### Prompt construction
- System prompt enforces:
  - Answer only using provided sources
  - Cite sources like `(Source 1)`
  - If not found, say so
- User message includes:
  - `DOCUMENT SOURCES` (retrieved chunks)
  - `QUESTION`

### Context management
- Only sends:
  - Top‑K relevant chunks
  - Last ~6 chat messages
  - The current question

This prevents context window overflow and keeps cost low.

### Hallucination mitigation
Two guardrails:
1) Retrieval threshold (`MIN_SIMILARITY`): if nothing matches, return “can’t find in document” without calling the LLM.
2) System prompt: explicitly forbids using anything outside the sources.

## Feature Extension: Document Comparison

### What it does
- User selects **Document A** and **Document B**.
- User provides a comparison prompt.
- Backend retrieves relevant excerpts from each doc separately.
- LLM returns similarities/differences and cites excerpts using `(A1)`, `(B2)`, etc.

### Ambiguous requirements (decisions made)
- Citations include:
  - Page ranges (from chunk metadata)
  - Short excerpts shown in the UI
- If the comparison needs multiple sections:
  - The backend retrieves multiple chunks (`TOP_K`) from each doc.
- If no relevant excerpts are found:
  - The prompt still runs, but with “no relevant excerpts found” placeholders.

## Production Scenario Solutions (what breaks, how we handle it)

### Very long PDFs (e.g., 200 pages)
- Problem: Too much text to include in the prompt.
- Fix: Chunk + retrieve top‑K; never include full doc.
- Trade-off: Retrieval quality depends on chunking/retrieval method.

### Problematic PDFs
- Problem: Empty/low text extraction for scanned PDFs.
- Fix: Heuristic `scannedLikely` warning; answer may be “not found”.
- Trade-off: No OCR implemented (keeps scope small).

### Cost explosion
- Problem: Sending full PDF for every question is expensive.
- Fix: Only send top‑K chunks.

### “Support 100 documents per user”
- What breaks: In-memory storage won’t scale across servers.
- Fix: Store documents/chunks in a DB (Postgres) and store the retrieval index per doc (or use a vector DB).

### “Response time must be < 2 seconds”
- What breaks: Cold-start LLM + retrieval can be slow.
- Fix ideas:
  - Cache retrieval results for repeated questions
  - Precompute indices (already done on upload)
  - Use faster models / smaller max tokens

### “Cost must be <$0.01 per question”
- Fix ideas:
  - Use a low-cost model
  - Reduce prompt size (smaller chunks, smaller top‑K)
  - Summarize chunks on upload (two-tier retrieval)
  - Cache answers

## Storage

- Documents, extracted pages, and chunks are stored in Supabase (Postgres) in the `documents` table.
- The TF-IDF index is rebuilt in-memory when a document is loaded.

## Project Structure

- `backend/src/server.js`: Express routes
- `backend/src/pdf.js`: PDF extraction + chunking
- `backend/src/retrieval.js`: TF‑IDF + cosine similarity
- `backend/src/llm.js`: Groq chat completions
- `backend/src/store.js`: Supabase-backed document store
- `frontend/src/App.tsx`: single-page UI
- `frontend/src/api.ts`: API client

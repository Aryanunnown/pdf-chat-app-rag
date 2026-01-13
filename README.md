# PDF Chat App (React + Node)

End-to-end app to upload PDFs, ask questions, and get answers grounded in the document with citations (page ranges + excerpts). Includes a feature extension: **Document Comparison**.

## Local Setup

### 1) Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Set `GROQ_API_KEY` in `backend/.env`.

Create the Supabase table once by running [backend/supabase/schema.sql](backend/supabase/schema.sql) in the Supabase SQL Editor, then set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`.

Backend runs on `http://localhost:8080`.

### 2) Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

## Environment Variables

Backend (`backend/.env`):
- `GROQ_API_KEY`
- `LLM_BASE_URL` (optional; override Groq endpoint)
- `LLM_MODEL` (default: `llama-3.1-8b-instant`)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MAX_PAGES` (0 = no limit)
- `TOP_K` (retrieval count)
- `MIN_SIMILARITY` (hallucination guardrail)
- `CORS_ORIGIN` (default: `http://localhost:5173`)

Frontend (`frontend/.env`):
- `VITE_API_URL` (default: `http://localhost:8080`)

## How It Works

- Upload PDF → backend extracts text per page (`pdfjs-dist`), chunks it (page-range-preserving), and builds a lightweight TF‑IDF retrieval index.
- Ask a question → backend retrieves top chunks, sends only those excerpts + recent chat messages to Groq, and returns an answer with citations.
- Compare → backend retrieves relevant excerpts from both documents and asks the LLM to summarize similarities/differences with citations.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [COST_ANALYSIS.md](COST_ANALYSIS.md).

## Deployment (required by assignment)

This repo is ready to deploy as two services:
- Backend: Render / Fly.io / Railway (Node)
- Frontend: Vercel / Netlify (static)

You’ll need to set the same env vars from `.env.example` in your hosting provider.

## Known Limitations

- Scanned/image PDFs are not OCR’d (text extraction may be empty). The UI warns when a PDF looks scanned.
- Retrieval is TF‑IDF (cheap + fast). Semantic embeddings can be added later if required.

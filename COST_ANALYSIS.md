# COST_ANALYSIS.md

This app is designed to keep costs low by avoiding “send the whole PDF to the LLM”.

## What costs money?

Two possible cost centers:
1) **LLM calls** (per question / per comparison)
2) **Embeddings** (not used here; retrieval is local TF‑IDF)

PDF upload in this implementation does **not** call any paid AI APIs by default.
We only call the LLM when the user asks a question (or asks for a summary / comparison).

## Estimated Cost Per Document Upload

What happens on upload:
- `pdfjs-dist` extracts text page-by-page.
- Text is chunked (~3,500 chars per chunk with overlap).
- A local TF‑IDF index is built.

Estimated cost components:
- **LLM tokens**: **$0** (no LLM call during upload)
- **Embeddings**: **$0** (local TF‑IDF; no embedding API)
- **Compute**: CPU time for extraction + indexing (hosting cost)
- **Storage**: store PDF (8MB) + extracted pages/chunks in DB

So upload cost is mostly infrastructure.

Optional enhancement (not required): precompute a document summary on upload.
- Adds ~1–5 LLM calls (map-reduce) depending on `SUMMARY_MAX_CHUNKS` and batching.
- This can reduce per-question cost later for “overview / key findings” type questions.

## Estimated Cost Per Question

A typical `/api/chat` request sends the LLM:
- A short system prompt
- A bounded amount of retrieved context (defaults: `TOP_K=5`, `MAX_TOTAL_CONTEXT_CHARS=6500`, `MAX_CHUNK_CHARS=1200`)
- A small amount of chat history (default: `CHAT_HISTORY_MESSAGES=6`)
- The user question

### Token estimate (aligned to current defaults)
We intentionally cap prompt size by character limits, so token usage is stable even for huge PDFs.

Rule of thumb: **~4 characters per token** for English prose (very approximate).

Input tokens per question (typical):
- Retrieved context: `MAX_TOTAL_CONTEXT_CHARS=6500` → ~1,600 tokens
- System + instructions + formatting: ~150–300 tokens
- Question + small history: ~200–600 tokens

**Estimated input total**: ~2,000–2,500 tokens

Output tokens per question:
- Current default `max_tokens=800` (cap)
- Typical answers are often smaller; assume **~250–500 tokens** average

**Estimated output total**: ~250–500 tokens

These estimates are deliberately conservative; actual usage depends on retrieval and answer length.

So per question: input ~4,500 tokens, output ~800 tokens.

### Cost formula
Let:
- $X$ = input price ($/1M tokens)
- $Y$ = output price ($/1M tokens)
- $T_{in}$ = input tokens per question
- $T_{out}$ = output tokens per question

$$\text{Cost per question} \approx (T_{in}/10^6)\cdot X + (T_{out}/10^6)\cdot Y$$

Using the estimate above ($T_{in}\approx 2{,}250$, $T_{out}\approx 350$):
$$\text{Cost per question} \approx (2250/10^6)\cdot X + (350/10^6)\cdot Y$$

Example scenarios (plug in your provider’s real pricing):
- If $X=\$0.20$ and $Y=\$0.60$ → cost/question ≈ $0.00045 + 0.00021 = \$0.00066$
- If $X=\$1.00$ and $Y=\$3.00$ → cost/question ≈ $0.00225 + 0.00105 = \$0.00330$
- If $X=\$3.00$ and $Y=\$9.00$ → cost/question ≈ $0.00675 + 0.00315 = \$0.00990$ (just under $0.01$)

## Estimated Monthly Cost for 1,000 Users

Assumption from assignment:
- 1,000 users
- 10 docs/user (uploads)
- 50 questions/user

Uploads: 10,000 uploads → **$0** in LLM tokens (by default)
Questions: 50,000 questions/month

Using $T_{in}\approx 2{,}250$ and $T_{out}\approx 350$:
- Total input tokens: $50{,}000 \times 2{,}250 = 112{,}500{,}000$ (112.5M)
- Total output tokens: $50{,}000 \times 350 = 17{,}500{,}000$ (17.5M)

Monthly LLM cost:
$$\text{Monthly} \approx (112.5\text{M}/10^6)\cdot X + (17.5\text{M}/10^6)\cdot Y$$

Example scenarios:
- If $X=\$0.20$ and $Y=\$0.60$ → $112.5\times0.20 + 17.5\times0.60 = \$22.50 + \$10.50 = \$33.00/mo$
- If $X=\$1.00$ and $Y=\$3.00$ → $112.5\times1 + 17.5\times3 = \$112.50 + \$52.50 = \$165.00/mo$
- If $X=\$3.00$ and $Y=\$9.00$ → $112.5\times3 + 17.5\times9 = \$337.50 + \$157.50 = \$495.00/mo$

### Storage cost (often the larger line-item than tokens)
Given the prompt:
- 1,000 users × 10 docs/user = 10,000 PDFs
- Average PDF size = 8MB
- Raw PDF storage ≈ 80,000MB ≈ **~80GB**

DB storage for extracted text/chunks:
- 75,000 words ≈ ~350k–500k characters (~0.35–0.5MB raw text) per doc
- 10,000 docs → **~3.5–5GB** raw text (plus JSON overhead / indexes)

Total storage (rough): **~85–95GB**

Storage pricing depends on provider; use:
$$\text{StorageCost} \approx (\text{GB stored}) \times (\$ / \text{GB-month})$$

## How to Reduce Costs

High-leverage changes (lowest effort → highest impact):

1) **Cap tokens aggressively**
- Lower `MAX_TOTAL_CONTEXT_CHARS`
- Lower `max_tokens` (answer cap)
- Keep `CHAT_HISTORY_MESSAGES` small

2) **Cache more**
- Cache by `(docId, normalizedQuestion, retrievalQuery, settings)` for repeated questions
- Cache “summary/key findings” results per doc (already supported)

3) **Use a cheaper model for Q&A**
- Reserve larger models for difficult tasks only

4) **Improve retrieval so fewer chunks are needed**
- Better chunking (smaller chunks + headings)
- Two-stage retrieval (cheap shortlist → better re-rank) to reduce `TOP_K`

5) **Precompute summaries / chunk abstracts** (one-time cost)
- Store a 1–2 sentence “chunk abstract” on upload
- At question-time, retrieve abstracts first; only expand to raw text when needed

6) **Batch rapid-fire questions**
- If the UI sends multiple questions quickly, answer in one LLM call (shared context)

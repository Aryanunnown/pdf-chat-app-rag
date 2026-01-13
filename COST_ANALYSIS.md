# COST_ANALYSIS.md

This app is designed to keep costs low by avoiding “send the whole PDF to the LLM”.

## What costs money?

Two possible cost centers:
1) **LLM calls** (per question / per comparison)
2) **Embeddings** (not used here; retrieval is local TF‑IDF)

PDF upload in this implementation does **not** call any paid AI APIs.

## Estimated Cost Per Document Upload

- LLM: **$0** (no LLM call)
- Embeddings: **$0** (TF‑IDF is local)
- Compute: your hosting CPU time for PDF extraction + indexing

So the main “cost” is infrastructure, not tokens.

## Estimated Cost Per Question

A typical question request sends:
- System prompt
- Top‑K chunk excerpts (default `TOP_K=5`)
- A small amount of chat history

Rough sizing (example):
- Each chunk excerpt ~3,500 chars ≈ ~900 tokens (very approximate)
- 5 chunks ≈ ~4,500 tokens input
- Output capped (default) ~800 tokens

So per question: input ~4,500 tokens, output ~800 tokens.

### Provider examples

- **Groq (Llama 3.1 8B)**: $0 but rate-limited

If your provider cost is `$X` per million tokens input and `$Y` per million tokens output:

$$\text{Cost per question} \approx (4500/10^6)\cdot X + (800/10^6)\cdot Y$$

## Estimated Monthly Cost for 1,000 Users

Assumption from assignment:
- 1,000 users
- 10 docs/user (uploads)
- 50 questions/user

Uploads: 10,000 uploads → ~$0 in token usage
Questions: 50,000 questions

Using the token estimate above:
- Total input tokens: 50,000 × 4,500 = 225,000,000 tokens
- Total output tokens: 50,000 × 800 = 40,000,000 tokens

Then:

$$\text{Monthly} \approx (225\text{M}/10^6)\cdot X + (40\text{M}/10^6)\cdot Y$$

Example (if X = $0.18 and Y = $0.18 per million):
- Input: 225 × 0.18 = $40.50
- Output: 40 × 0.18 = $7.20
- Total ≈ **$47.70/month**

(These are rough; real token counts depend on PDF content and chunking.)

## How to Reduce Costs

- Reduce `TOP_K` (send fewer chunks)
- Reduce chunk size
- Lower `max_tokens` for answers
- Use a cheaper model
- Cache answers for repeated questions
- Summarize chunks at upload time (one-time cost, cheaper per-question)
- Add a two-stage retrieval: TF‑IDF shortlist → semantic re-rank (optional)

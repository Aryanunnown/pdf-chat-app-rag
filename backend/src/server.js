import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { z } from 'zod';

import { DocumentStore, stableDocId } from './store.js';
import { chunkPages, extractPages, isProbablyScanned } from './pdf.js';
import { searchTfidf } from './retrieval.js';
import { buildClient, chatCompletion, loadLlmConfig } from './llm.js';
import { summarizeDocument } from './summary.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const port = parseInt(process.env.PORT || '8080', 10);
const corsOriginsEnv = (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '').trim();
const allowedOrigins = (corsOriginsEnv
  ? corsOriginsEnv.split(',').map((s) => s.trim()).filter(Boolean)
  : ['http://localhost:5173', 'http://localhost:5174']);

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (curl/Postman) which send no Origin.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

const store = new DocumentStore({
  supabaseUrl: (process.env.SUPABASE_URL || '').trim(),
  supabaseServiceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
});
await store.init();

function getSettings() {
  return {
    maxPages: parseInt(process.env.MAX_PAGES || '0', 10) || 0,
    topK: parseInt(process.env.TOP_K || '5', 10) || 5,
    minSimilarity: parseFloat(process.env.MIN_SIMILARITY || '0.10') || 0.1,
    maxChunkChars: parseInt(process.env.MAX_CHUNK_CHARS || '1200', 10) || 1200,
    maxTotalContextChars: parseInt(process.env.MAX_TOTAL_CONTEXT_CHARS || '6500', 10) || 6500,
    chatHistoryMessages: parseInt(process.env.CHAT_HISTORY_MESSAGES || '6', 10) || 6,
  };
}

function isFollowUpQuestion(q) {
  const s = (q || '').toLowerCase().trim();
  if (!s) return false;

  // Heuristic: follow-ups that refer back to earlier content.
  return (
    /\b(second|third|first|former|latter|that|this|those|them|it|one)\b/.test(s) ||
    s.startsWith('elaborate') ||
    s.startsWith('expand') ||
    s.startsWith('can you elaborate') ||
    s.startsWith('tell me more') ||
    s.includes('as you said') ||
    s.includes('compare to previous') ||
    s.includes('previous research')
  );
}

function lastMessageOf(role, messages) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    if (messages[i]?.role === role) return messages[i]?.content || '';
  }
  return '';
}

function clampChars(s, maxChars) {
  const t = String(s || '');
  return t.length <= maxChars ? t : t.slice(0, maxChars);
}

function buildRetrievalQuery(question, messages) {
  const q = (question || '').trim();
  if (!isFollowUpQuestion(q) || !messages?.length) return q;

  // Add just enough context for TF-IDF to pick the right chunks.
  const prevUser = clampChars(lastMessageOf('user', messages), 600);
  const prevAssistant = clampChars(lastMessageOf('assistant', messages), 900);

  return [
    q,
    '',
    'Context from conversation (for retrieval only):',
    prevUser ? `Previous user question: ${prevUser}` : '',
    prevAssistant ? `Previous assistant answer: ${prevAssistant}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function isSummaryQuestion(q) {
  const s = (q || '').toLowerCase();
  return (
    s.includes('key findings') ||
    s.includes('key takeaways') ||
    s.includes('main findings') ||
    s.includes('main results') ||
    s.startsWith('summarize') ||
    s.includes('summarise') ||
    s.includes('summary') ||
    s.includes('tl;dr')
  );
}

function isLikelyRequestTooLargeError(e) {
  const msg = (e?.message || '').toLowerCase();
  return msg.includes('request too large') || msg.includes('413') || msg.includes('tpm') || msg.includes('tokens per minute');
}

const CompareMode = z.enum(['content', 'methodology', 'conclusions', 'structure', 'literal', 'custom']);

function defaultComparePromptForMode(mode) {
  switch (mode) {
    case 'methodology':
      return 'Compare the methodology: data, experimental setup, evaluation, and limitations.';
    case 'conclusions':
      return 'Compare the main conclusions, results, and key takeaways.';
    case 'structure':
      return 'Compare the document structure: sections, organization, and coverage.';
    case 'literal':
      return 'Compare literal wording differences: definitions, requirements, numbers, and constraints.';
    case 'custom':
      return 'Compare the documents: key similarities and key differences.';
    case 'content':
    default:
      return 'Compare the documents: key similarities and key differences.';
  }
}

function buildCompareRetrievalQuery(mode, task) {
  const base = (task || '').trim();
  // TF-IDF benefits from mode-specific keywords.
  switch (mode) {
    case 'methodology':
      return `${base}\n\nKeywords: methodology methods data dataset sampling experiment evaluation metrics baselines ablation limitations`;
    case 'conclusions':
      return `${base}\n\nKeywords: conclusion conclusions results findings takeaways contributions limitations future work discussion`;
    case 'structure':
      return `${base}\n\nKeywords: table of contents outline structure sections headings chapters overview introduction conclusion appendix`;
    case 'literal':
      return `${base}\n\nKeywords: definition shall must should requirements constraints thresholds numbers units version compatibility`;
    case 'custom':
    case 'content':
    default:
      return base;
  }
}

function extractStructuredJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return { markdown: '', structured: null };

  const m = raw.match(/<JSON>\s*([\s\S]*?)\s*<\/JSON>/i);
  if (!m) return { markdown: raw, structured: null };

  const jsonText = (m[1] || '').trim();
  const markdown = raw.replace(m[0], '').trim();

  try {
    const structured = JSON.parse(jsonText);
    return { markdown: markdown || raw, structured };
  } catch {
    return { markdown: raw, structured: null };
  }
}

function normalizeCompareStructured(structured, { mode, task }) {
  const base = {
    mode,
    task,
    topics: [],
    summary: undefined,
  };

  if (!structured || typeof structured !== 'object') return base;

  const s = structured;
  const out = {
    mode: typeof s.mode === 'string' ? s.mode : mode,
    task: typeof s.task === 'string' ? s.task : task,
    topics: Array.isArray(s.topics) ? s.topics : [],
    summary: typeof s.summary === 'string' ? s.summary : undefined,
  };

  // Normalize topic items to the expected keys.
  out.topics = out.topics
    .map((t) => {
      if (!t || typeof t !== 'object') return null;
      return {
        topic: typeof t.topic === 'string' ? t.topic : '',
        docA: typeof t.docA === 'string' ? t.docA : '',
        docB: typeof t.docB === 'string' ? t.docB : '',
        verdict: typeof t.verdict === 'string' ? t.verdict : 'unclear',
        notes: typeof t.notes === 'string' ? t.notes : undefined,
      };
    })
    .filter((t) => t && t.topic);

  // Clamp verdicts to known values; anything else becomes 'unclear'.
  const allowed = new Set(['same', 'different', 'onlyA', 'onlyB', 'unclear']);
  out.topics = out.topics.map((t) => ({
    ...t,
    verdict: allowed.has(t.verdict) ? t.verdict : 'unclear',
  }));

  return out;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/documents', (req, res) => {
  Promise.resolve(store.list())
    .then((documents) => res.json({ documents }))
    .catch((e) => res.status(500).json({ error: e?.message || 'List failed' }));
});

app.post('/api/documents', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing file' });
    if (!req.file.originalname.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF uploads are supported' });
    }

    const { maxPages } = getSettings();

    const id = stableDocId(req.file.buffer);
    const name = req.file.originalname;

    const { pages, numPages } = await extractPages(req.file.buffer, { maxPages });
    const scannedLikely = isProbablyScanned(pages);

    const totalExtractedChars = pages.reduce((sum, p) => sum + (p.text?.length || 0), 0);
    const nonEmptyPages = pages.filter((p) => (p.text || '').length >= 50).length;

    const chunks = chunkPages(pages, { docId: id });

    await store.upsert({
      id,
      name,
      createdAt: new Date().toISOString(),
      numPages,
      pages,
      chunks,
      scannedLikely,
      totalExtractedChars,
      nonEmptyPages,
    });

    res.json({
      document: {
        id,
        name,
        createdAt: new Date().toISOString(),
        numPages,
        numChunks: chunks.length,
        scannedLikely,
        totalExtractedChars,
        nonEmptyPages,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Upload failed' });
  }
});

const ChatBody = z.object({
  docId: z.string().min(1),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]),
  question: z.string().min(1),
});

app.post('/api/chat', async (req, res) => {
  try {
    const body = ChatBody.parse(req.body);
    const doc = await store.get(body.docId);
    if (!doc) return res.status(404).json({ error: 'Unknown document' });

    if (!doc.chunks.length || !doc.totalExtractedChars) {
      return res.json({
        answer:
          "No readable text was extracted from this PDF, so I can't answer questions from it. If this is a scanned PDF, OCR support would be needed.",
        sources: [],
      });
    }

    // Summary-style questions should not attempt to stuff the whole PDF into context.
    if (isSummaryQuestion(body.question)) {
      // Serve cached summary if present.
      if (doc.summary && typeof doc.summary === 'string' && doc.summary.trim()) {
        return res.json({
          answer: doc.summary,
          sources: [],
          kind: 'summary_cached',
        });
      }

      const cfg = loadLlmConfig(process.env);
      const client = buildClient(cfg);
      const { summary, sources } = await summarizeDocument({
        doc,
        question: body.question,
        chatCompletion,
        client,
        model: cfg.model,
        maxSelectedChunks: parseInt(process.env.SUMMARY_MAX_CHUNKS || '20', 10) || 20,
      });

      // Best-effort cache (won't break if columns aren't present).
      try {
        await store.upsert({
          ...doc,
          summary,
          summaryUpdatedAt: new Date().toISOString(),
        });
      } catch {
        // ignore caching failures
      }

      return res.json({ answer: summary, sources, kind: 'summary' });
    }
    const { topK, minSimilarity, maxChunkChars, maxTotalContextChars, chatHistoryMessages } = getSettings();
    const retrievalQuery = buildRetrievalQuery(body.question, body.messages);
    
    
    const retrieved = searchTfidf(doc.index, doc.chunks, retrievalQuery, {
      topK,
      maxChunkChars,
      maxTotalChars: maxTotalContextChars,
    });

    const strong = retrieved.filter((r) => r.score >= minSimilarity);

    // If TF-IDF scores are all below threshold, we still provide the best-effort
    // excerpts to the LLM, but force it to answer "not found" unless supported.
    // This avoids a hard failure on legitimate questions where TF-IDF scores run low.
    const candidates = strong.length ? strong : retrieved;

    if (candidates.length === 0) {
      return res.json({
        answer:
          "I couldn't find a relevant section for that question in the extracted text. Try adding unique keywords from the PDF (names, headings) or lower MIN_SIMILARITY in backend/.env.",
        sources: [],
      });
    }

    const contextBlocks = candidates
      .map(
        (r, i) =>
          `SOURCE ${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`
      )
      .join('\n\n');

    const system =
      "You are a careful assistant answering questions ONLY using the provided SOURCES from a PDF. " +
      "If the answer is not in the sources, say you can't find it in the document. " +
      "Cite sources by writing (Source 1), (Source 2), etc next to the relevant sentences. " +
      "If the sources seem unrelated to the question, you MUST say you can't find it in the document. " +
      "Do not make up facts.";

    const messages = [
      ...body.messages.slice(-chatHistoryMessages),
      {
        role: 'user',
        content: `DOCUMENT SOURCES:\n\n${contextBlocks}\n\nQUESTION: ${body.question}`,
      },
    ];

    const cfg = loadLlmConfig(process.env);
    const client = buildClient(cfg);
    let answer = '';
    try {
      answer = await chatCompletion({ client, model: cfg.model, system, messages });
    } catch (e) {
      if (!isLikelyRequestTooLargeError(e)) throw e;

      // Retry once with smaller context caps.
      const tighter = searchTfidf(doc.index, doc.chunks, retrievalQuery, {
        topK: Math.max(1, Math.min(3, topK)),
        maxChunkChars: Math.max(500, Math.floor(maxChunkChars * 0.6)),
        maxTotalChars: Math.max(2500, Math.floor(maxTotalContextChars * 0.6)),
      });

      const tightBlocks = tighter
        .map(
          (r, i) =>
            `SOURCE ${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`
        )
        .join('\n\n');

      const retryMessages = [
        ...body.messages.slice(-Math.min(4, chatHistoryMessages)),
        {
          role: 'user',
          content: `DOCUMENT SOURCES:\n\n${tightBlocks}\n\nQUESTION: ${body.question}`,
        },
      ];

      answer = await chatCompletion({ client, model: cfg.model, system, messages: retryMessages, maxTokens: 650 });
    }

    const sources = candidates.map((r) => ({
      chunkId: r.chunk.id,
      pageStart: r.chunk.pageStart,
      pageEnd: r.chunk.pageEnd,
      score: r.score,
      excerpt: r.chunk.text.slice(0, 240),
    }));

    res.json({ answer, sources });
  } catch (e) {
    res.status(400).json({ error: e?.message || 'Bad request' });
  }
});

const CompareBody = z.object({
  docIdA: z.string().min(1),
  docIdB: z.string().min(1),
  // Backward compatible: clients can continue sending `prompt` only.
  prompt: z.string().optional().default(''),
  mode: CompareMode.optional().default('content'),
});

app.post('/api/compare', async (req, res) => {
  try {
    const body = CompareBody.parse(req.body);
    const [docA, docB] = await Promise.all([store.get(body.docIdA), store.get(body.docIdB)]);
    if (!docA || !docB) return res.status(404).json({ error: 'Unknown document(s)' });

    const { topK, minSimilarity, maxChunkChars, maxTotalContextChars } = getSettings();

    const mode = body.mode;
    const task = (body.prompt || '').trim() || defaultComparePromptForMode(mode);
    const retrievalQuery = buildCompareRetrievalQuery(mode, task);

    const topKForMode = (() => {
      if (mode === 'literal' || mode === 'structure') return Math.min(10, topK + 3);
      return topK;
    })();

    const aRetrieved = searchTfidf(docA.index, docA.chunks, retrievalQuery, {
      topK: topKForMode,
      minScore: minSimilarity,
      maxChunkChars,
      maxTotalChars: Math.floor(maxTotalContextChars / 2),
    });
    const bRetrieved = searchTfidf(docB.index, docB.chunks, retrievalQuery, {
      topK: topKForMode,
      minScore: minSimilarity,
      maxChunkChars,
      maxTotalChars: Math.floor(maxTotalContextChars / 2),
    });

    const aContext = aRetrieved
      .map((r, i) => `A${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`)
      .join('\n\n');

    const bContext = bRetrieved
      .map((r, i) => `B${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`)
      .join('\n\n');

    const system =
      "You compare two PDFs using ONLY the provided excerpts. " +
      "When you state a similarity/difference, cite it like (A1) or (B2). " +
      "If you can't support a claim with excerpts, say so. " +
      "If the task asks for literal differences, focus on exact wording/numbers. " +
      "If the task is semantic, focus on meaning not writing style. " +
      "Return two parts: (1) a concise Markdown answer; (2) a STRICT JSON object inside <JSON>...</JSON>. " +
      "You MUST always include the <JSON> block even if you are unsure; in that case return an empty topics array and set verdicts to 'unclear'. " +
      "The JSON schema must be EXACTLY: {\"mode\":string,\"task\":string,\"topics\":[{\"topic\":string,\"docA\":string,\"docB\":string,\"verdict\":\"same\"|\"different\"|\"onlyA\"|\"onlyB\"|\"unclear\",\"notes\"?:string}],\"summary\"?:string}. " +
      "Do NOT wrap the JSON in markdown fences. Do NOT include trailing commentary inside <JSON>.";

    const messages = [
      {
        role: 'user',
        content: `MODE: ${mode}\n\nDOCUMENT A EXCERPTS:\n\n${aContext || '(no relevant excerpts found)'}\n\nDOCUMENT B EXCERPTS:\n\n${bContext || '(no relevant excerpts found)'}\n\nTASK: ${task}`,
      },
    ];

    const cfg = loadLlmConfig(process.env);
    const client = buildClient(cfg);
    const raw = await chatCompletion({ client, model: cfg.model, system, messages, maxTokens: 900 });
    const { markdown: answer, structured } = extractStructuredJson(raw);
    const normalizedStructured = normalizeCompareStructured(structured, { mode, task });

    res.json({
      answer,
      mode,
      task,
      structured: normalizedStructured,
      sourcesA: aRetrieved.map((r) => ({
        chunkId: r.chunk.id,
        pageStart: r.chunk.pageStart,
        pageEnd: r.chunk.pageEnd,
        score: r.score,
        excerpt: r.chunk.text.slice(0, 240),
      })),
      sourcesB: bRetrieved.map((r) => ({
        chunkId: r.chunk.id,
        pageStart: r.chunk.pageStart,
        pageEnd: r.chunk.pageEnd,
        score: r.score,
        excerpt: r.chunk.text.slice(0, 240),
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e?.message || 'Bad request' });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`);
});

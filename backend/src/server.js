import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import multer from 'multer';

import { DocumentStore, stableDocId } from './store.js';
import { chunkPages, extractPages, isProbablyScanned } from './pdf.js';
import { searchTfidf } from './retrieval.js';
import { buildClient, chatCompletion, loadLlmConfig } from './llm.js';
import { summarizeDocument } from './summary.js';

import { createCorsOptions, getPort, getSettings } from './server/settings.js';
import { buildRetrievalQuery, isLikelyRequestTooLargeError, isSummaryQuestion } from './server/chat-helpers.js';
import {
  buildCompareRetrievalQuery,
  defaultComparePromptForMode,
  extractStructuredJson,
  normalizeCompareStructured,
} from './server/compare-helpers.js';
import { ChatBody, CompareBody } from './server/schemas.js';
import { CHAT_DEFAULTS, COMPARE_DEFAULTS, EXTRACTION_DEFAULTS, SERVER_DEFAULTS, SETTINGS_DEFAULTS } from './server/constants.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SERVER_DEFAULTS.UPLOAD_FILE_SIZE_LIMIT_BYTES } });

const port = getPort(process.env);
const corsOptions = createCorsOptions(process.env);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: SERVER_DEFAULTS.JSON_BODY_LIMIT }));

const store = new DocumentStore({
  supabaseUrl: (process.env.SUPABASE_URL || '').trim(),
  supabaseServiceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
});
await store.init();

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

    // Store raw PDF in Supabase Storage (in addition to extracted text in Postgres).
    const storageBucket = (process.env.SUPABASE_STORAGE_BUCKET || SERVER_DEFAULTS.STORAGE_BUCKET || '').trim();
    const storagePrefix = (process.env.SUPABASE_STORAGE_PREFIX || SERVER_DEFAULTS.STORAGE_PREFIX || '').trim();
    const stored = await store.uploadPdfToStorage({
      docId: id,
      fileName: name,
      buffer: req.file.buffer,
      bucket: storageBucket,
      prefix: storagePrefix,
      contentType: req.file.mimetype || 'application/pdf',
    });

    const { pages, numPages } = await extractPages(req.file.buffer, { maxPages });
    const scannedLikely = isProbablyScanned(pages);

    const totalExtractedChars = pages.reduce((sum, p) => sum + (p.text?.length || 0), 0);
    const nonEmptyPages = pages.filter((p) => (p.text || '').length >= EXTRACTION_DEFAULTS.NON_EMPTY_PAGE_MIN_CHARS).length;

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

    // Best-effort: persist storage location if columns exist.
    await store.tryUpdateStorageInfo(id, {
      bucket: stored.bucket,
      path: stored.path,
      mime: req.file.mimetype || 'application/pdf',
      bytes: req.file.size,
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
        storage: stored,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Upload failed' });
  }
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
        maxSelectedChunks:
          parseInt(process.env.SUMMARY_MAX_CHUNKS || String(SETTINGS_DEFAULTS.SUMMARY_MAX_CHUNKS), 10) ||
          SETTINGS_DEFAULTS.SUMMARY_MAX_CHUNKS,
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

    const system = CHAT_DEFAULTS.SYSTEM_PROMPT;

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
        topK: Math.max(CHAT_DEFAULTS.RETRY.TOP_K_MIN, Math.min(CHAT_DEFAULTS.RETRY.TOP_K_CAP, topK)),
        maxChunkChars: Math.max(CHAT_DEFAULTS.RETRY.MIN_CHUNK_CHARS, Math.floor(maxChunkChars * CHAT_DEFAULTS.RETRY.SCALE)),
        maxTotalChars: Math.max(CHAT_DEFAULTS.RETRY.MIN_TOTAL_CHARS, Math.floor(maxTotalContextChars * CHAT_DEFAULTS.RETRY.SCALE)),
      });

      const tightBlocks = tighter
        .map(
          (r, i) =>
            `SOURCE ${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`
        )
        .join('\n\n');

      const retryMessages = [
        ...body.messages.slice(-Math.min(CHAT_DEFAULTS.RETRY.MAX_HISTORY_MESSAGES, chatHistoryMessages)),
        {
          role: 'user',
          content: `DOCUMENT SOURCES:\n\n${tightBlocks}\n\nQUESTION: ${body.question}`,
        },
      ];

      answer = await chatCompletion({ client, model: cfg.model, system, messages: retryMessages, maxTokens: CHAT_DEFAULTS.RETRY.MAX_TOKENS });
    }

    const sources = candidates.map((r) => ({
      chunkId: r.chunk.id,
      pageStart: r.chunk.pageStart,
      pageEnd: r.chunk.pageEnd,
      score: r.score,
      excerpt: r.chunk.text.slice(0, CHAT_DEFAULTS.SOURCE_EXCERPT_CHARS),
    }));

    res.json({ answer, sources });
  } catch (e) {
    res.status(400).json({ error: e?.message || 'Bad request' });
  }
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
      if (COMPARE_DEFAULTS.TOP_K_BONUS_MODES.has(mode)) {
        return Math.min(COMPARE_DEFAULTS.TOP_K_MAX_FOR_BONUS, topK + COMPARE_DEFAULTS.TOP_K_BONUS);
      }
      return topK;
    })();

    const aRetrieved = searchTfidf(docA.index, docA.chunks, retrievalQuery, {
      topK: topKForMode,
      minScore: minSimilarity,
      maxChunkChars,
      maxTotalChars: Math.floor(maxTotalContextChars / COMPARE_DEFAULTS.CONTEXT_SPLIT_FACTOR),
    });
    const bRetrieved = searchTfidf(docB.index, docB.chunks, retrievalQuery, {
      topK: topKForMode,
      minScore: minSimilarity,
      maxChunkChars,
      maxTotalChars: Math.floor(maxTotalContextChars / COMPARE_DEFAULTS.CONTEXT_SPLIT_FACTOR),
    });

    const aContext = aRetrieved
      .map((r, i) => `A${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`)
      .join('\n\n');

    const bContext = bRetrieved
      .map((r, i) => `B${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`)
      .join('\n\n');

    const system = COMPARE_DEFAULTS.SYSTEM_PROMPT;

    const messages = [
      {
        role: 'user',
        content: `MODE: ${mode}\n\nDOCUMENT A EXCERPTS:\n\n${aContext || '(no relevant excerpts found)'}\n\nDOCUMENT B EXCERPTS:\n\n${bContext || '(no relevant excerpts found)'}\n\nTASK: ${task}`,
      },
    ];

    const cfg = loadLlmConfig(process.env);
    const client = buildClient(cfg);
    const raw = await chatCompletion({ client, model: cfg.model, system, messages, maxTokens: COMPARE_DEFAULTS.MAX_TOKENS });
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
        excerpt: r.chunk.text.slice(0, CHAT_DEFAULTS.SOURCE_EXCERPT_CHARS),
      })),
      sourcesB: bRetrieved.map((r) => ({
        chunkId: r.chunk.id,
        pageStart: r.chunk.pageStart,
        pageEnd: r.chunk.pageEnd,
        score: r.score,
        excerpt: r.chunk.text.slice(0, CHAT_DEFAULTS.SOURCE_EXCERPT_CHARS),
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

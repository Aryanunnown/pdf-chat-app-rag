import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { z } from 'zod';

import { DocumentStore, stableDocId } from './store.js';
import { chunkPages, extractPages, isProbablyScanned } from './pdf.js';
import { buildTfidfIndex, searchTfidf } from './retrieval.js';
import { buildClient, chatCompletion, loadLlmConfig } from './llm.js';

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
  };
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
    const index = buildTfidfIndex(chunks);

    await store.upsert({
      id,
      name,
      createdAt: new Date().toISOString(),
      numPages,
      pages,
      chunks,
      index,
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

app.get('/api/documents/:id/stats', (req, res) => {
  Promise.resolve(store.get(req.params.id))
    .then((doc) => {
      if (!doc) return res.status(404).json({ error: 'Unknown document' });

      const sample = doc.chunks.slice(0, 2).map((c) => ({
        id: c.id,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        excerpt: c.text.slice(0, 300),
      }));

      return res.json({
        id: doc.id,
        name: doc.name,
        numPages: doc.numPages,
        scannedLikely: doc.scannedLikely,
        totalExtractedChars: doc.totalExtractedChars,
        nonEmptyPages: doc.nonEmptyPages,
        numChunks: doc.chunks.length,
        chunkSample: sample,
      });
    })
    .catch((e) => res.status(500).json({ error: e?.message || 'Stats failed' }));
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

    const { topK, minSimilarity } = getSettings();
    const retrieved = searchTfidf(doc.index, doc.chunks, body.question, topK);

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
      ...body.messages.slice(-6),
      {
        role: 'user',
        content: `DOCUMENT SOURCES:\n\n${contextBlocks}\n\nQUESTION: ${body.question}`,
      },
    ];

    const cfg = loadLlmConfig(process.env);
    const client = buildClient(cfg);
    const answer = await chatCompletion({ client, model: cfg.model, system, messages });

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
  prompt: z.string().min(1).default('Compare the documents: key similarities and key differences.'),
});

app.post('/api/compare', async (req, res) => {
  try {
    const body = CompareBody.parse(req.body);
    const [docA, docB] = await Promise.all([store.get(body.docIdA), store.get(body.docIdB)]);
    if (!docA || !docB) return res.status(404).json({ error: 'Unknown document(s)' });

    const { topK, minSimilarity } = getSettings();

    const aRetrieved = searchTfidf(docA.index, docA.chunks, body.prompt, topK).filter((r) => r.score >= minSimilarity);
    const bRetrieved = searchTfidf(docB.index, docB.chunks, body.prompt, topK).filter((r) => r.score >= minSimilarity);

    const aContext = aRetrieved
      .map((r, i) => `A${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`)
      .join('\n\n');

    const bContext = bRetrieved
      .map((r, i) => `B${i + 1} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}):\n${r.chunk.text}`)
      .join('\n\n');

    const system =
      "You compare two PDFs using ONLY the provided excerpts. " +
      "When you state a similarity/difference, cite it like (A1) or (B2). " +
      "If you can't support a claim with excerpts, say so.";

    const messages = [
      {
        role: 'user',
        content: `DOCUMENT A EXCERPTS:\n\n${aContext || '(no relevant excerpts found)'}\n\nDOCUMENT B EXCERPTS:\n\n${bContext || '(no relevant excerpts found)'}\n\nTASK: ${body.prompt}`,
      },
    ];

    const cfg = loadLlmConfig(process.env);
    const client = buildClient(cfg);
    const answer = await chatCompletion({ client, model: cfg.model, system, messages, maxTokens: 900 });

    res.json({
      answer,
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

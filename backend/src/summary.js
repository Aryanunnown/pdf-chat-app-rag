import { searchTfidf } from './retrieval.js';

function parseIntSafe(v, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonArrayBestEffort(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function createMapCache() {
  const maxEntries = parseIntSafe(process.env.SUMMARY_MAP_CACHE_MAX, 1200);
  const ttlMs = parseIntSafe(process.env.SUMMARY_MAP_CACHE_TTL_MS, 60 * 60_000);
  /** @type {Map<string, { value: any, expiresAt: number }>} */
  const map = new Map();

  const get = (key) => {
    const hit = map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      map.delete(key);
      return undefined;
    }
    // LRU bump
    map.delete(key);
    map.set(key, hit);
    return hit.value;
  };

  const set = (key, value) => {
    map.delete(key);
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (map.size > maxEntries) {
      const k = map.keys().next().value;
      if (k === undefined) break;
      map.delete(k);
    }
  };

  return { get, set };
}

const MAP_SUMMARY_CACHE = createMapCache();

async function pMapLimit(items, limit, mapper) {
  const concurrency = Math.max(1, limit || 1);
  const out = new Array(items.length);
  let idx = 0;

  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await mapper(items[i], i);
    }
  });

  await Promise.all(workers);
  return out;
}

function uniqById(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = it?.chunk?.id || it?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

function sampleEvenly(chunks, maxItems) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  if (!maxItems || maxItems <= 0) return [];
  if (chunks.length <= maxItems) return chunks;

  const step = chunks.length / maxItems;
  const out = [];
  for (let i = 0; i < maxItems; i++) {
    const idx = Math.floor(i * step);
    out.push(chunks[idx]);
  }
  return out;
}

function clip(s, maxChars) {
  if (!s) return '';
  if (!maxChars || maxChars <= 0) return s;
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/**
 * Map-reduce summarization for large PDFs.
 *
 * Strategy:
 * - Select a bounded set of chunks (top TF-IDF for a "summary" query + evenly sampled coverage)
 * - Summarize each selected chunk with a small output budget
 * - Reduce those summaries into final "key findings"
 */
export async function summarizeDocument({
  doc,
  question,
  chatCompletion,
  client,
  model,
  maxSelectedChunks = 20,
  perChunkChars = 1800,
  perChunkMaxTokens = 220,
  reduceMaxTokens = 650,
  mapBatchSize = parseIntSafe(process.env.SUMMARY_MAP_BATCH_SIZE, 4),
  mapConcurrency = parseIntSafe(process.env.SUMMARY_MAP_CONCURRENCY, 2),
  enableMapCache = (process.env.SUMMARY_MAP_CACHE || '1') !== '0',
}) {
  if (!doc?.chunks?.length) {
    return { summary: 'No chunks available to summarize.', sources: [] };
  }

  const summaryQuery =
    (question || '').trim() ||
    'key findings results conclusion contributions limitations future work abstract';

  // 1) Relevance-based selection (findings/results) + 2) Coverage-based selection (even sampling)
  const top = searchTfidf(doc.index, doc.chunks, summaryQuery, {
    topK: Math.min(12, maxSelectedChunks),
    maxChunkChars: perChunkChars,
    maxTotalChars: 50_000,
  });

  const coverageCount = Math.max(0, maxSelectedChunks - top.length);
  const sampled = sampleEvenly(doc.chunks, coverageCount).map((c) => ({ chunk: { ...c, text: clip(c.text, perChunkChars) }, score: 0 }));

  const selected = uniqById([...top, ...sampled]).slice(0, maxSelectedChunks);

  const mapSystem =
    'You are a careful research assistant. Extract only what is supported by the provided excerpt. ' +
    'Do not guess missing details.';

  const items = selected.map((r) => ({
    chunkId: r.chunk.id,
    pageStart: r.chunk.pageStart,
    pageEnd: r.chunk.pageEnd,
    text: r.chunk.text,
  }));

  /** @type {Array<{ pages: {start:number,end:number}, chunkId: string, summary: string }>} */
  const mapSummaries = [];

  // Reuse map summaries across repeated summary requests.
  /** @type {Map<string, string>} */
  const got = new Map();
  for (const it of items) {
    const key = `map:${model}:${perChunkChars}:${it.chunkId}`;
    if (!enableMapCache) continue;
    const cached = MAP_SUMMARY_CACHE.get(key);
    if (typeof cached === 'string' && cached.trim()) got.set(it.chunkId, cached);
  }

  const missing = items.filter((it) => !got.has(it.chunkId));

  // Batch map: summarize multiple excerpts per call to reduce API cost/latency.
  const batchSize = Math.max(1, mapBatchSize);
  const batches = [];
  for (let i = 0; i < missing.length; i += batchSize) batches.push(missing.slice(i, i + batchSize));

  const batchSystem =
    mapSystem +
    ' Return ONLY valid JSON: an array of objects: ' +
    '[{"chunkId":"...","summary":"..."}, ...]. No markdown fences.';

  async function summarizeBatch(batch) {
    const user = [
      'Summarize each excerpt independently.',
      'For each excerpt: extract up to 3 key findings/claims, plus any quantitative results (metrics, effect sizes) if present.',
      'Write short bullets inside a single string.',
      'If excerpt is background-only, start with "Background/Setup:" and keep it brief.',
      '',
      ...batch.map((c, idx) => {
        return (
          `EXCERPT ${idx + 1} (chunkId=${c.chunkId}, pages ${c.pageStart}-${c.pageEnd}):\n` +
          `${c.text}`
        );
      }),
    ].join('\n\n');

    const raw = await chatCompletion({
      client,
      model,
      system: batchSystem,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      // Budget roughly per-chunk.
      maxTokens: Math.max(250, Math.min(1400, perChunkMaxTokens * batch.length)),
    });

    const arr = parseJsonArrayBestEffort(raw);
    if (!arr) return [];
    return arr
      .map((x) => ({ chunkId: String(x?.chunkId || ''), summary: String(x?.summary || '') }))
      .filter((x) => x.chunkId && x.summary);
  }

  const batchResults = await pMapLimit(batches, mapConcurrency, summarizeBatch);
  for (const list of batchResults) {
    for (const r of list) {
      got.set(r.chunkId, clip(r.summary, 1400));
      if (enableMapCache) MAP_SUMMARY_CACHE.set(`map:${model}:${perChunkChars}:${r.chunkId}`, clip(r.summary, 1400));
    }
  }

  // Fallback: if the batch output didn't include some chunkIds, run the single-excerpt map.
  for (const it of items) {
    if (got.has(it.chunkId)) continue;
    const user =
      `EXCERPT (pages ${it.pageStart}-${it.pageEnd}):\n` +
      `${it.text}\n\n` +
      'Task: extract up to 3 key findings/claims, plus any quantitative results (metrics, effect sizes) if present. ' +
      'Write in short bullets. If excerpt is background-only, say "Background/Setup" and summarize briefly.';

    const text = await chatCompletion({
      client,
      model,
      system: mapSystem,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      maxTokens: perChunkMaxTokens,
    });
    got.set(it.chunkId, clip(text || '', 1400));
    if (enableMapCache) MAP_SUMMARY_CACHE.set(`map:${model}:${perChunkChars}:${it.chunkId}`, clip(text || '', 1400));
  }

  for (const it of items) {
    mapSummaries.push({
      pages: { start: it.pageStart, end: it.pageEnd },
      chunkId: it.chunkId,
      summary: got.get(it.chunkId) || '',
    });
  }

  const reduceSystem =
    'You write a faithful paper summary using ONLY the provided excerpt-summaries. ' +
    'Do not introduce facts that are not mentioned. When possible, attach page ranges like (pp. 12-14).';

  const reduceInput = mapSummaries
    .map(
      (s, i) =>
        `SUMMARY ${i + 1} (pp. ${s.pages.start}-${s.pages.end}):\n${s.summary}`
    )
    .join('\n\n');

  const reduceUser =
    `Paper question: ${question || 'What are the key findings?'}\n\n` +
    `Chunk summaries:\n\n${reduceInput}\n\n` +
    'Produce:\n' +
    '1) Key findings (8-12 bullets)\n' +
    '2) Evidence & numbers (bullets; include metrics if present)\n' +
    '3) Limitations / caveats\n' +
    '4) One-paragraph plain-English takeaway\n' +
    'If the summaries do not contain findings, say so.';

  const final = await chatCompletion({
    client,
    model,
    system: reduceSystem,
    messages: [{ role: 'user', content: reduceUser }],
    temperature: 0.2,
    maxTokens: reduceMaxTokens,
  });

  return {
    summary: (final || '').trim(),
    sources: mapSummaries.map((s) => ({
      chunkId: s.chunkId,
      pageStart: s.pages.start,
      pageEnd: s.pages.end,
    })),
  };
}

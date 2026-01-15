import { searchTfidf } from './retrieval.js';

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

  const mapSummaries = [];
  for (const [i, r] of selected.entries()) {
    const chunk = r.chunk;
    const user =
      `EXCERPT ${i + 1} (pages ${chunk.pageStart}-${chunk.pageEnd}):\n` +
      `${chunk.text}\n\n` +
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

    mapSummaries.push({
      pages: { start: chunk.pageStart, end: chunk.pageEnd },
      chunkId: chunk.id,
      summary: clip(text || '', 1400),
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

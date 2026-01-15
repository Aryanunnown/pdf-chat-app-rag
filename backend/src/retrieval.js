function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a)) || 1;
}

function normalize(vec) {
  const n = norm(vec);
  return vec.map((x) => x / n);
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function buildTf(tokens) {
  /** @type {Map<string, number>} */
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

export function buildTfidfIndex(chunks) {
  // Lightweight local retrieval (no paid embeddings). Good baseline.
  const docsTokens = chunks.map((c) => tokenize(c.text));
  const tfs = docsTokens.map(buildTf);

  /** @type {Map<string, number>} */
  const df = new Map();
  for (const tf of tfs) {
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }

  const N = chunks.length;
  const vocab = Array.from(df.keys());
  const vocabIndex = new Map(vocab.map((t, i) => [t, i]));

  const idf = vocab.map((t) => {
    const d = df.get(t) || 1;
    return Math.log((N + 1) / (d + 1)) + 1;
  });

  const vectors = chunks.map((_, i) => {
    const tf = tfs[i];
    const vec = new Array(vocab.length).fill(0);
    for (const [term, count] of tf.entries()) {
      const j = vocabIndex.get(term);
      if (j === undefined) continue;
      vec[j] = count * idf[j];
    }
    return normalize(vec);
  });

  return {
    kind: 'tfidf',
    vocab,
    vocabIndex,
    idf,
    vectors,
  };
}

function clipText(text, maxChars) {
  if (!text) return '';
  if (!maxChars || maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/**
 * Backward-compatible:
 * - searchTfidf(index, chunks, query, 5)
 * - searchTfidf(index, chunks, query, { topK, maxChunkChars, maxTotalChars, minScore })
 */
export function searchTfidf(index, chunks, query, opts = 5) {
  const options = typeof opts === 'number' ? { topK: opts } : (opts || {});
  const {
    topK = 5,
    minScore = -Infinity,
    maxChunkChars = 1400,
    maxTotalChars = 9000,
  } = options;

  const qTokens = tokenize(query);
  const qTf = buildTf(qTokens);

  const vec = new Array(index.vocab.length).fill(0);
  for (const [term, count] of qTf.entries()) {
    const j = index.vocabIndex.get(term);
    if (j === undefined) continue;
    vec[j] = count * index.idf[j];
  }
  const q = normalize(vec);

  const scored = index.vectors.map((v, i) => ({ i, score: dot(q, v) }));
  scored.sort((a, b) => b.score - a.score);

  const results = [];
  let used = 0;
  for (const { i, score } of scored) {
    if (results.length >= Math.max(1, topK)) break;
    if (score < minScore) continue;

    const chunk = chunks[i];
    if (!chunk) continue;

    const remaining = Math.max(0, maxTotalChars - used);
    if (remaining <= 0) break;

    const allowance = Math.min(maxChunkChars, remaining);
    const excerpt = clipText(chunk.text || '', allowance);
    if (!excerpt) continue;

    used += excerpt.length;
    results.push({ chunk: { ...chunk, text: excerpt }, score });
  }

  // Best-effort guarantee of at least one result.
  if (results.length === 0 && scored.length > 0) {
    const best = scored[0];
    const chunk = chunks[best.i];
    if (chunk) {
      const excerpt = clipText(chunk.text || '', Math.min(maxChunkChars, maxTotalChars));
      results.push({ chunk: { ...chunk, text: excerpt }, score: best.score });
    }
  }

  return results;
}

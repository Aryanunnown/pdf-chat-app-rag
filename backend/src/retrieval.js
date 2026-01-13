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

export function searchTfidf(index, chunks, query, topK = 5) {
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

  return scored.slice(0, Math.max(1, topK)).map(({ i, score }) => ({ chunk: chunks[i], score }));
}

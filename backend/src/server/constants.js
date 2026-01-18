export const SERVER_DEFAULTS = {
  PORT: 8080,
  ALLOWED_ORIGINS: ['http://localhost:5173', 'http://localhost:5174'],
  JSON_BODY_LIMIT: '2mb',
  UPLOAD_FILE_SIZE_LIMIT_BYTES: 30 * 1024 * 1024,
  STORAGE_BUCKET: 'pdfs',
  STORAGE_PREFIX: 'documents',
};

export const SETTINGS_DEFAULTS = {
  MAX_PAGES: 0,
  TOP_K: 5,
  MIN_SIMILARITY: 0.1,
  MAX_CHUNK_CHARS: 1200,
  MAX_TOTAL_CONTEXT_CHARS: 6500,
  CHAT_HISTORY_MESSAGES: 6,
  SUMMARY_MAX_CHUNKS: 20,
};

export const EXTRACTION_DEFAULTS = {
  NON_EMPTY_PAGE_MIN_CHARS: 50,
};

export const CHAT_DEFAULTS = {
  FOLLOW_UP_PRONOUN_REGEX: /\b(second|third|first|former|latter|that|this|those|them|it|one)\b/,
  FOLLOW_UP_PREFIXES: ['elaborate', 'expand', 'can you elaborate', 'tell me more'],
  FOLLOW_UP_INCLUDES: ['as you said', 'compare to previous', 'previous research'],
  SUMMARY_TRIGGERS: ['key findings', 'key takeaways', 'main findings', 'main results', 'summarize', 'summarise', 'summary', 'tl;dr'],
  REQUEST_TOO_LARGE_MARKERS: ['request too large', '413', 'tpm', 'tokens per minute'],

  RETRIEVAL_CONTEXT: {
    PREV_USER_MAX_CHARS: 600,
    PREV_ASSISTANT_MAX_CHARS: 900,
  },

  SOURCE_EXCERPT_CHARS: 240,

  SYSTEM_PROMPT:
    "You are a careful assistant answering questions ONLY using the provided SOURCES from a PDF. " +
    "If the answer is not in the sources, say you can't find it in the document. " +
    "Cite sources by writing (Source 1), (Source 2), etc next to the relevant sentences. " +
    "If the sources seem unrelated to the question, you MUST say you can't find it in the document. " +
    'Do not make up facts.',

  RETRY: {
    TOP_K_CAP: 3,
    TOP_K_MIN: 1,
    SCALE: 0.6,
    MIN_CHUNK_CHARS: 500,
    MIN_TOTAL_CHARS: 2500,
    MAX_HISTORY_MESSAGES: 4,
    MAX_TOKENS: 650,
  },
};

export const COMPARE_DEFAULTS = {
  MODES: ['content', 'methodology', 'conclusions', 'structure', 'literal', 'custom'],

  DEFAULT_PROMPTS: {
    content: 'Compare the documents: key similarities and key differences.',
    methodology: 'Compare the methodology: data, experimental setup, evaluation, and limitations.',
    conclusions: 'Compare the main conclusions, results, and key takeaways.',
    structure: 'Compare the document structure: sections, organization, and coverage.',
    literal: 'Compare literal wording differences: definitions, requirements, numbers, and constraints.',
    custom: 'Compare the documents: key similarities and key differences.',
  },

  MODE_KEYWORDS: {
    methodology:
      'Keywords: methodology methods data dataset sampling experiment evaluation metrics baselines ablation limitations',
    conclusions:
      'Keywords: conclusion conclusions results findings takeaways contributions limitations future work discussion',
    structure:
      'Keywords: table of contents outline structure sections headings chapters overview introduction conclusion appendix',
    literal:
      'Keywords: definition shall must should requirements constraints thresholds numbers units version compatibility',
  },

  TOP_K_BONUS_MODES: new Set(['literal', 'structure']),
  TOP_K_BONUS: 3,
  TOP_K_MAX_FOR_BONUS: 10,

  CONTEXT_SPLIT_FACTOR: 2,

  SYSTEM_PROMPT:
    'You compare two PDFs using ONLY the provided excerpts. ' +
    'When you state a similarity/difference, cite it like (A1) or (B2). ' +
    "If you can't support a claim with excerpts, say so. " +
    'If the task asks for literal differences, focus on exact wording/numbers. ' +
    'If the task is semantic, focus on meaning not writing style. ' +
    'Return two parts: (1) a concise Markdown answer; (2) a STRICT JSON object inside <JSON>...</JSON>. ' +
    "You MUST always include the <JSON> block even if you are unsure; in that case return an empty topics array and set verdicts to 'unclear'. " +
    'The JSON schema must be EXACTLY: {"mode":string,"task":string,"topics":[{"topic":string,"docA":string,"docB":string,"verdict":"same"|"different"|"onlyA"|"onlyB"|"unclear","notes"?:string}],"summary"?:string}. ' +
    'Do NOT wrap the JSON in markdown fences. Do NOT include trailing commentary inside <JSON>.',

  MAX_TOKENS: 900,

  ALLOWED_VERDICTS: new Set(['same', 'different', 'onlyA', 'onlyB', 'unclear']),
};

export const SCHEMA_DEFAULTS = {
  CHAT_ROLES: ['user', 'assistant'],
};

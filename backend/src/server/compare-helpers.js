import { z } from 'zod';
import { COMPARE_DEFAULTS } from './constants.js';

export const CompareMode = z.enum(COMPARE_DEFAULTS.MODES);

export function defaultComparePromptForMode(mode) {
  return COMPARE_DEFAULTS.DEFAULT_PROMPTS[mode] || COMPARE_DEFAULTS.DEFAULT_PROMPTS.content;
}

export function buildCompareRetrievalQuery(mode, task) {
  const base = (task || '').trim();
  // TF-IDF benefits from mode-specific keywords.
  switch (mode) {
    case 'methodology':
      return `${base}\n\n${COMPARE_DEFAULTS.MODE_KEYWORDS.methodology}`;
    case 'conclusions':
      return `${base}\n\n${COMPARE_DEFAULTS.MODE_KEYWORDS.conclusions}`;
    case 'structure':
      return `${base}\n\n${COMPARE_DEFAULTS.MODE_KEYWORDS.structure}`;
    case 'literal':
      return `${base}\n\n${COMPARE_DEFAULTS.MODE_KEYWORDS.literal}`;
    case 'custom':
    case 'content':
    default:
      return base;
  }
}

export function extractStructuredJson(text) {
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

export function normalizeCompareStructured(structured, { mode, task }) {
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
  const allowed = COMPARE_DEFAULTS.ALLOWED_VERDICTS;
  out.topics = out.topics.map((t) => ({
    ...t,
    verdict: allowed.has(t.verdict) ? t.verdict : 'unclear',
  }));

  return out;
}

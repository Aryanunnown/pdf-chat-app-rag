import { CHAT_DEFAULTS } from './constants.js';

function isFollowUpQuestion(q) {
  const s = (q || '').toLowerCase().trim();
  if (!s) return false;

  // Heuristic: follow-ups that refer back to earlier content.
  return (
    CHAT_DEFAULTS.FOLLOW_UP_PRONOUN_REGEX.test(s) ||
    CHAT_DEFAULTS.FOLLOW_UP_PREFIXES.some((p) => s.startsWith(p)) ||
    CHAT_DEFAULTS.FOLLOW_UP_INCLUDES.some((p) => s.includes(p))
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

export function buildRetrievalQuery(question, messages) {
  const q = (question || '').trim();
  if (!isFollowUpQuestion(q) || !messages?.length) return q;

  // Add just enough context for TF-IDF to pick the right chunks.
  const prevUser = clampChars(lastMessageOf('user', messages), CHAT_DEFAULTS.RETRIEVAL_CONTEXT.PREV_USER_MAX_CHARS);
  const prevAssistant = clampChars(
    lastMessageOf('assistant', messages),
    CHAT_DEFAULTS.RETRIEVAL_CONTEXT.PREV_ASSISTANT_MAX_CHARS
  );

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

export function isSummaryQuestion(q) {
  const s = (q || '').toLowerCase();
  return CHAT_DEFAULTS.SUMMARY_TRIGGERS.some((t) => (t === 'summarize' ? s.startsWith('summarize') : s.includes(t)));
}

export function isLikelyRequestTooLargeError(e) {
  const msg = (e?.message || '').toLowerCase();
  return CHAT_DEFAULTS.REQUEST_TOO_LARGE_MARKERS.some((m) => msg.includes(m));
}

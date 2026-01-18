import { SERVER_DEFAULTS, SETTINGS_DEFAULTS } from './constants.js';

export function getPort(env = process.env) {
  return parseInt(env.PORT || String(SERVER_DEFAULTS.PORT), 10);
}

export function getSettings(env = process.env) {
  return {
    maxPages: parseInt(env.MAX_PAGES || String(SETTINGS_DEFAULTS.MAX_PAGES), 10) || SETTINGS_DEFAULTS.MAX_PAGES,
    topK: parseInt(env.TOP_K || String(SETTINGS_DEFAULTS.TOP_K), 10) || SETTINGS_DEFAULTS.TOP_K,
    minSimilarity: parseFloat(env.MIN_SIMILARITY || String(SETTINGS_DEFAULTS.MIN_SIMILARITY)) || SETTINGS_DEFAULTS.MIN_SIMILARITY,
    maxChunkChars: parseInt(env.MAX_CHUNK_CHARS || String(SETTINGS_DEFAULTS.MAX_CHUNK_CHARS), 10) || SETTINGS_DEFAULTS.MAX_CHUNK_CHARS,
    maxTotalContextChars:
      parseInt(env.MAX_TOTAL_CONTEXT_CHARS || String(SETTINGS_DEFAULTS.MAX_TOTAL_CONTEXT_CHARS), 10) ||
      SETTINGS_DEFAULTS.MAX_TOTAL_CONTEXT_CHARS,
    chatHistoryMessages:
      parseInt(env.CHAT_HISTORY_MESSAGES || String(SETTINGS_DEFAULTS.CHAT_HISTORY_MESSAGES), 10) ||
      SETTINGS_DEFAULTS.CHAT_HISTORY_MESSAGES,
  };
}

export function getAllowedOrigins(env = process.env) {
  const corsOriginsEnv = (env.CORS_ORIGINS || env.CORS_ORIGIN || '').trim();
  return corsOriginsEnv
    ? corsOriginsEnv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : SERVER_DEFAULTS.ALLOWED_ORIGINS;
}

export function createCorsOptions(env = process.env) {
  const allowedOrigins = getAllowedOrigins(env);
  return {
    origin(origin, callback) {
      // Allow non-browser clients (curl/Postman) which send no Origin.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  };
}

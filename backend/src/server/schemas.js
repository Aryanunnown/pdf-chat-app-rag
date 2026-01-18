import { z } from 'zod';
import { CompareMode } from './compare-helpers.js';
import { SCHEMA_DEFAULTS } from './constants.js';

export const ChatBody = z.object({
  docId: z.string().min(1),
  messages: z.array(z.object({ role: z.enum(SCHEMA_DEFAULTS.CHAT_ROLES), content: z.string() })).default([]),
  question: z.string().min(1),
});

export const CompareBody = z.object({
  docIdA: z.string().min(1),
  docIdB: z.string().min(1),
  // Backward compatible: clients can continue sending `prompt` only.
  prompt: z.string().optional().default(''),
  mode: CompareMode.optional().default('content'),
});

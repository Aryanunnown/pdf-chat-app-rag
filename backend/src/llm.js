import Groq from 'groq-sdk';

export function loadLlmConfig(env) {
  const model = (env.LLM_MODEL || 'llama-3.1-8b-instant').trim();
  const baseURL = (env.LLM_BASE_URL || '').trim();

  const groq = (env.GROQ_API_KEY || '').trim();
  if (!groq) throw new Error('No API key set. Provide GROQ_API_KEY in your environment.');

  return {
    apiKey: groq,
    baseURL: baseURL || 'https://api.groq.com/openai/v1',
    model,
  };
}

export function buildClient(cfg) {
  return new Groq({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
}

export async function chatCompletion({ client, model, system, messages, temperature = 0.2, maxTokens = 800 }) {
  const resp = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature,
    max_tokens: maxTokens,
  });
  return resp.choices?.[0]?.message?.content || '';
}

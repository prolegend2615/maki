import { config } from './config.js';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const ATTEMPTS_PER_MODEL = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One model, a couple of tries for transient errors. Throws when the model is unusable right now. */
async function callModel(model, { messages, signal, temperature, maxTokens }) {
  let lastError;

  for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
    if (attempt > 0) await sleep(800);
    signal?.throwIfAborted();

    const timeout = AbortSignal.timeout(60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const res = await fetch(`${config.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        signal: combined,
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        const error = new Error(`LLM HTTP ${res.status}: ${body}`);
        if (RETRYABLE.has(res.status)) {
          lastError = error;
          continue;
        }
        error.final = true; // 4xx: retrying the same model will not help
        throw error;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw Object.assign(new Error('LLM returned no message content'), { final: true });
      }
      return text;
    } catch (error) {
      // User-triggered abort must propagate immediately; everything else counts as a model failure.
      if (signal?.aborted) throw error;
      if (error.final) throw error;
      lastError = error; // network error, timeout or retryable status: try again
      continue;
    }
  }

  throw lastError;
}

/**
 * Calls an OpenAI-compatible /chat/completions endpoint and returns the reply text.
 * Tries each model from MODEL in order; the first one that answers wins.
 */
export async function chat({ messages, signal, temperature = config.temperature, maxTokens = 700 }) {
  const failures = [];

  for (const model of config.models) {
    try {
      return await callModel(model, { messages, signal, temperature, maxTokens });
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`${model}: ${error.message}`);
      if (config.models.length > 1) console.warn(`[llm] ${model} failed, trying next: ${error.message}`);
    }
  }

  throw new Error(failures.join(' | '));
}

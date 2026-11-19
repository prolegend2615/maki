import { config } from './config.js';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const ATTEMPTS_PER_MODEL = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A 429 means "not now": retrying the same provider on every message just burns time.
// Daily-quota wording gets a long cooldown, a plain rate limit a short one.
const blockedUntil = new Map();
const cooldownFor = (message) =>
  /HTTP 429/.test(message) ? (/quota|daily/i.test(message) ? 30 * 60_000 : 60_000) : 0;

/** One model on one provider, a couple of tries for transient errors. Throws when the model is unusable right now. */
async function callModel(provider, model, { messages, signal, temperature, maxTokens }) {
  let lastError;

  for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
    if (attempt > 0) await sleep(800);
    signal?.throwIfAborted();

    const timeout = AbortSignal.timeout(60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const res = await fetch(`${provider.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
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
 * Walks the provider list in order, and each provider's models in order; the first
 * model that answers wins. If everything fails, throws with all collected errors.
 */
export async function chat({ messages, signal, temperature = config.temperature, maxTokens = 700 }) {
  const failures = [];

  for (const [pi, provider] of config.providers.entries()) {
    const until = blockedUntil.get(provider.label) ?? 0;
    if (Date.now() < until) {
      console.log(`[llm] skipping ${provider.label}: rate-limited, ${Math.ceil((until - Date.now()) / 60_000)}m cooldown left`);
      continue;
    }
    for (const [mi, model] of provider.models.entries()) {
      const started = Date.now();
      try {
        const text = await callModel(provider, model, { messages, signal, temperature, maxTokens });
        console.log(`[llm] ok ${provider.label}/${model} (${Date.now() - started}ms)`);
        return text;
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${provider.label}/${model}: ${error.message}`);
        const cooldown = cooldownFor(error.message);
        if (cooldown) {
          blockedUntil.set(provider.label, Date.now() + cooldown);
          console.warn(`[llm] ${provider.label} rate-limited — skipping it for ${cooldown / 60_000}m`);
          break; // rest of this provider's models share the same limit
        }
        const more = mi + 1 < provider.models.length || pi + 1 < config.providers.length;
        if (more) console.warn(`[llm] ${provider.label}/${model} failed, trying next: ${error.message.slice(0, 200)}`);
      }
    }
  }

  console.error(`[llm] ALL ${failures.length} provider/model attempts failed — no reply possible (daily quota? see lines above)`);
  throw new Error(failures.join(' | '));
}

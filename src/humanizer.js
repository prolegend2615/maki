import { config } from './config.js';

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const rand = (min, max) => min + Math.random() * (max - min);
const chance = (p) => Math.random() < p;

const NEARBY = {
  a: 'sq', s: 'ad', d: 'sf', f: 'dg', g: 'fh', h: 'gj', j: 'hk', k: 'jl', l: 'k',
  q: 'w', w: 'qe', e: 'wr', r: 'et', t: 'ry', y: 'tu', u: 'yi', i: 'uo', o: 'ip', p: 'o',
  z: 'x', x: 'zc', c: 'xv', v: 'cb', b: 'vn', n: 'bm', m: 'n',
};

/**
 * Introduces one realistic typo (swapped letters, neighbour key, dropped letter).
 * Returns null when the text has no suitable word.
 */
export function makeTypo(text) {
  const words = [...text.matchAll(/[A-Za-z]{4,}/g)];
  if (!words.length) return null;

  const word = words[Math.floor(Math.random() * words.length)];
  const w = word[0];
  const i = 1 + Math.floor(Math.random() * (w.length - 2)); // keep first/last letter mostly intact
  let broken;

  switch (Math.floor(Math.random() * 3)) {
    case 0: // swap adjacent letters
      broken = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
      break;
    case 1: { // neighbouring key
      const near = NEARBY[w[i].toLowerCase()];
      if (!near) return null;
      broken = w.slice(0, i) + near[Math.floor(Math.random() * near.length)] + w.slice(i + 1);
      break;
    }
    default: // dropped letter
      broken = w.slice(0, i) + w.slice(i + 1);
  }

  if (broken === w) return null;
  const typoText = text.slice(0, word.index) + broken + text.slice(word.index + w.length);
  return { typoText, word: w, broken };
}

/** Types for roughly as long as a human would take, with optional stop/start pauses. */
async function typeFor(channel, text, signal) {
  const total = Math.min(9000, Math.max(700, (text.length / config.typingCps) * 1000 * rand(0.8, 1.25)));
  const pause = text.length > 25 && chance(config.pauseChance);
  const parts = pause ? [rand(0.3, 0.6), 0] : [1];
  if (pause) parts[1] = 1 - parts[0];

  for (let n = 0; n < parts.length; n++) {
    await channel.sendTyping().catch(() => {});
    let left = total * parts[n];
    // Discord's typing indicator lasts ~10s, refresh it.
    while (left > 0) {
      const step = Math.min(left, 8000);
      await sleep(step, signal);
      left -= step;
      if (left > 0) await channel.sendTyping().catch(() => {});
    }
    if (n < parts.length - 1) await sleep(rand(1200, 3500), signal); // indicator lapses: "stopped typing"
  }
}

/**
 * Fixes a typo after a visible delay. Deliberately not tied to the abort signal, so a new
 * incoming message never makes the typo vanish instantly.
 */
async function fixTypo(channel, sent, text, typo) {
  try {
    await sleep(rand(config.typoFixMinMs, config.typoFixMaxMs));
    if (chance(0.7)) {
      await sent.edit({ content: text, allowedMentions: { parse: [] } });
    } else {
      await channel.sendTyping().catch(() => {});
      await sleep(rand(700, 1500));
      await channel.send({ content: `${typo.word}*`, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    console.error('[typo fix]', error.message); // e.g. message was deleted
  }
}

/**
 * Sends a message the human way. `replyTo` is only used on the first message.
 * May post a typo first and fix it later (edit, or a "word*" follow-up).
 */
export async function sendHuman(channel, text, { replyTo, signal } = {}) {
  await typeFor(channel, text, signal);

  const typo = chance(config.typoChance) ? makeTypo(text) : null;
  const payload = (content) =>
    replyTo
      ? { content, reply: { messageReference: replyTo, failIfNotExists: false }, allowedMentions: { parse: [], repliedUser: false } }
      : { content, allowedMentions: { parse: [] } };

  const sent = await channel.send(payload(typo ? typo.typoText : text));
  if (typo) void fixTypo(channel, sent, text, typo);
  return sent;
}

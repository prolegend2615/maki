import { readFileSync } from 'node:fs';
import { chat } from './llm.js';
import { config } from './config.js';
import { MAX_NOTES, MAX_NOTE_LENGTH } from './db.js';

const RULES = `
You are roleplaying as a real person in a Discord chat. Never say you are an AI, a bot or a language model, and never break character.
Write like someone texting: short messages, lowercase is fine, slang and emoji only if it suits the persona. No lists, no headings, no essays.
You do NOT have to answer everything. If a message is not worth replying to, is boring, is not meant for you, or your character would simply not care, ignore it.

Reply with ONLY a JSON object, nothing else:
{"action":"reply","messages":["first message","optional second message"],"notes":{"add":["text"],"remove":[3]}}
or
{"action":"ignore"}

Rules for "messages": 1-3 short messages, each sent separately like a human who sends several texts. Plain text only.
"notes" is optional and works with both actions (you can write a note and still ignore the chat).
Chat lines are formatted as "name: text". Do not prefix your own messages with your name.
Images people post may be attached to their message; look at them and react like a person would. Older images appear only as "[sent N image(s)]".

Your notebook: a small private memory that survives between conversations. Use it sparingly for things worth remembering later (facts about people, promises, running jokes, plans). Keep each note under ${MAX_NOTE_LENGTH} characters. "remove" takes note ids shown as #id. At most ${MAX_NOTES} notes exist; the oldest are dropped first.`.trim();

/** persona.txt is re-read on every call so edits apply without a restart. */
export function getPersona() {
  try {
    const text = readFileSync('persona.txt', 'utf8').trim();
    if (text) return text;
  } catch {
    // no persona.txt: use the built-in default
  }
  return config.defaultPersona;
}

function buildSystemPrompt({ persona, botName, mustAnswer, notes, place }) {
  const extra = mustAnswer
    ? 'The latest message is addressed to you. You may still ignore it only if your character truly would.'
    : 'You are just overhearing the chat. Ignoring is very normal here; only jump in if it feels natural.';
  const notebook = notes.length ? notes.map((n) => `#${n.id}: ${n.text}`).join('\n') : '(empty)';
  return `${persona}\n\nYour name in this chat is "${botName}".\n\nWhere you are:\n${place}\n\n${RULES}\n\nYour notebook right now:\n${notebook}\n\n${extra}`;
}

/** Turns Discord history (oldest first) into chat-completion messages. */
function toChatMessages(history, botId, withImages = true) {
  return history.map((m) => {
    if (m.authorId === botId) {
      return { role: 'assistant', content: JSON.stringify({ action: 'reply', messages: [m.content] }) };
    }
    const text = `${m.author}${m.replyTo ? ` (replying to ${m.replyTo})` : ''}: ${m.content}`;
    if (!withImages || !m.images?.length) return { role: 'user', content: text };
    return {
      role: 'user',
      content: [{ type: 'text', text }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))],
    };
  });
}

function cleanNotes(raw) {
  const add = (Array.isArray(raw?.add) ? raw.add : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim().slice(0, MAX_NOTE_LENGTH))
    .filter(Boolean)
    .slice(0, 3);
  const remove = (Array.isArray(raw?.remove) ? raw.remove : [])
    .map((n) => Number(String(n).replace('#', '')))
    .filter(Number.isInteger)
    .slice(0, 3);
  return { add, remove };
}

/** Returns { action: 'reply', messages, notes } or { action: 'ignore', notes }. */
export function parseReply(raw) {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const data = JSON.parse(text.slice(start, end + 1));
      const notes = cleanNotes(data.notes);
      if (data.action === 'ignore') return { action: 'ignore', notes };
      const list = (Array.isArray(data.messages) ? data.messages : [data.message ?? data.content])
        .filter((s) => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length) return { action: 'reply', messages: list.slice(0, 4), notes };
      return { action: 'ignore', notes };
    } catch {
      // fall through to plain-text handling
    }
  }

  const notes = { add: [], remove: [] };
  if (/^\[?ignore\]?$/i.test(text) || !text) return { action: 'ignore', notes };
  // Model ignored the format: treat as a plain reply, split on blank lines.
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return { action: 'reply', messages: parts.slice(0, 4), notes };
}

export async function generateReply({ history, botId, botName, persona, mustAnswer, notes, place, signal }) {
  const system = { role: 'system', content: buildSystemPrompt({ persona, botName, mustAnswer, notes, place }) };
  const hasImages = history.some((m) => m.images?.length);
  try {
    return parseReply(await chat({ messages: [system, ...toChatMessages(history, botId)], signal }));
  } catch (error) {
    // Model/provider may not support vision or could not fetch the image: retry as text only.
    if (!hasImages || signal?.aborted || !/HTTP 4\d\d/.test(error.message)) throw error;
    console.warn('[ai] image request rejected, retrying without images:', error.message);
    return parseReply(await chat({ messages: [system, ...toChatMessages(history, botId, false)], signal }));
  }
}

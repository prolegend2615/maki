import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

const need = (key) => {
  if (!env[key]) throw new Error(`Missing ${key} in .env`);
  return env[key];
};

const num = (key, fallback) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

// A bare command name ("piper") is looked up on PATH; anything with a slash is resolved to an absolute path.
const asPath = (value) => (/[\\/]/.test(value) ? resolve(value) : value);
const piperBin = asPath(env.PIPER_BIN || '');
const piperVoice = env.PIPER_VOICE ? resolve(env.PIPER_VOICE) : '';

const splitList = (raw) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
const hostOf = (base) => {
  try {
    return new URL(base).host || base;
  } catch {
    return base;
  }
};

/**
 * LLM providers, tried in order; within each provider its models are tried in order.
 * Simple setup: API_KEY / API_BASE_URL / MODEL (acts as the first provider).
 * Multi-provider: PROVIDER1_API_KEY / PROVIDER1_BASE_URL / PROVIDER1_MODELS, up to PROVIDER8_.
 */
const providers = [];
if (env.API_KEY) {
  const apiBase = (env.API_BASE_URL || 'https://api.xkiro.com/v1').replace(/\/+$/, '');
  const models = splitList(env.MODEL);
  providers.push({ label: hostOf(apiBase), apiBase, apiKey: env.API_KEY, models: models.length ? models : ['openai/gpt-4o'] });
}
for (let i = 1; i <= 8; i++) {
  const apiKey = env[`PROVIDER${i}_API_KEY`];
  const models = splitList(env[`PROVIDER${i}_MODELS`]);
  if (!apiKey || !models.length) {
    if (apiKey || models.length || env[`PROVIDER${i}_BASE_URL`]) {
      console.warn(`[config] PROVIDER${i} skipped: needs both PROVIDER${i}_API_KEY and PROVIDER${i}_MODELS`);
    }
    continue;
  }
  const apiBase = (env[`PROVIDER${i}_BASE_URL`] || 'https://api.xkiro.com/v1').replace(/\/+$/, '');
  providers.push({ label: `${i}:${hostOf(apiBase)}`, apiBase, apiKey, models });
}
if (!providers.length) throw new Error('Missing API_KEY (or PROVIDER1_API_KEY + PROVIDER1_MODELS) in .env');

export const config = {
  discordToken: need('DISCORD_TOKEN'),
  providers,
  guildId: env.GUILD_ID || null,

  // Chance (0-1) to silently skip a message when the bot was NOT pinged
  // (i.e. it is only chatting inside an active conversation window).
  ignoreChance: num('IGNORE_CHANCE', 0.15),
  typoChance: num('TYPO_CHANCE', 0.12),
  pauseChance: num('PAUSE_CHANCE', 0.2),
  // How long a typo stays visible before the bot notices and fixes it.
  typoFixMinMs: num('TYPO_FIX_MIN_MS', 5000),
  typoFixMaxMs: num('TYPO_FIX_MAX_MS', 9000),
  // How long the bot keeps listening in a channel after being pinged.
  activeWindowMs: num('ACTIVE_WINDOW_SECONDS', 180) * 1000,
  // Typing speed in characters per second.
  typingCps: num('TYPING_CPS', 8),
  historyLimit: num('HISTORY_LIMIT', 30),
  // Max images (newest first) sent to the model per reply. 0 disables vision.
  maxImages: num('MAX_IMAGES', 3),
  // Wait for rapid-fire messages to settle before answering.
  debounceMinMs: num('DEBOUNCE_MIN_MS', 1200),
  debounceMaxMs: num('DEBOUNCE_MAX_MS', 2600),
  temperature: num('TEMPERATURE', 0.9),

  // Automatic memory: rolling channel summaries + per-person fact extraction
  // in a background pass after the chat goes quiet. 'off' disables it.
  autoMemory: (env.AUTO_MEMORY || 'on') !== 'off',
  summaryMaxChars: num('SUMMARY_MAX_CHARS', 900),
  // Only run the fact-extraction pass when at least this many new messages exist.
  minExtractMessages: num('MEMORY_MIN_MESSAGES', 5),

  // Chance (0-1) that a message the bot chose to ignore still gets a subtle 👀 reaction.
  readChance: num('READ_CHANCE', 0.3),

  // Proactive follow-ups ("did you end up watching it?") — basic limits per channel.
  proactivePerDay: num('PROACTIVE_PER_DAY', 2),
  proactiveMinHours: num('PROACTIVE_MIN_HOURS', 4),
  // Server-hour window in which follow-ups are postponed (bot "sleeps").
  proactiveQuietStart: num('PROACTIVE_QUIET_START', 23),
  proactiveQuietEnd: num('PROACTIVE_QUIET_END', 9),

  // Tenor GIF search (free API key: Google Cloud Console -> enable "Tenor API").
  // Empty key = GIF action is disabled and the bot only texts.
  tenorKey: env.TENOR_API_KEY || '',
  tenorContentFilter: env.TENOR_CONTENT_FILTER || 'medium',

  // Chance (0-1) that a model-proposed "rephrase" actually becomes a send-then-edit self-correction.
  selfCorrectChance: num('SELF_CORRECT_CHANCE', 0.5),

  // Server notebook: a durable profile of each guild, rewritten by a throttled background pass.
  serverNotebookChars: num('SERVER_NOTEBOOK_CHARS', 2000),
  serverNotebookHours: num('SERVER_NOTEBOOK_HOURS', 4),
  // Announcements: chance to react 👀 on a new announcement, and to comment on it
  // in her most recent active channel (comment goes through the proactive limits; 0 = off).
  announceReactChance: num('ANNOUNCE_REACT_CHANCE', 0.3),
  announceCommentChance: num('ANNOUNCE_COMMENT_CHANCE', 0),

  // Text-to-speech with Piper. Enabled only when both PIPER_BIN and PIPER_VOICE are set.
  piperBin,
  piperVoice,
  ttsEnabled: Boolean(piperBin && piperVoice),
  ttsMaxChars: num('TTS_MAX_CHARS', 300),
  ttsTimeoutMs: num('TTS_TIMEOUT_SECONDS', 30) * 1000,

  // Staff actions: light moderation asked for in chat, executed after a button confirm.
  // Hard caps (timeout <= 60 min, slowmode <= 120 s) are constants in staff.js, not configurable.
  staffEnabled: (env.STAFF_ENABLED || 'on') !== 'off',
  staffOpsPerMinute: num('STAFF_OPS_PER_MINUTE', 5),
  staffConfirmSeconds: num('STAFF_CONFIRM_SECONDS', 120),
  staffLogChannelId: env.STAFF_LOG_CHANNEL || '',

  // Deterministic auto-mod: scam links, invite drops and mention spam. No AI, no confirm button.
  automodEnabled: (env.AUTOMOD_ENABLED || 'on') !== 'off',
  automodActionsPerMinute: num('AUTOMOD_ACTIONS_PER_MINUTE', 10),

  defaultPersona:
    'You are Mika, a 19-year-old college student who is sarcastic, warm underneath, and a bit chaotic. ' +
    'You love anime, late-night snacks and teasing your friends. You talk like a real person texting.',
};

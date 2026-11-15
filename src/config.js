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

export const config = {
  discordToken: need('DISCORD_TOKEN'),
  apiKey: need('API_KEY'),
  apiBase: (env.API_BASE_URL || 'https://api.xkiro.com/v1').replace(/\/+$/, ''),
  // Comma-separated list, tried in order: MODEL=openai/gpt-4o, google/gemini-3.1-pro
  models: (env.MODEL || 'openai/gpt-4o').split(',').map((s) => s.trim()).filter(Boolean),
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

  // Text-to-speech with Piper. Enabled only when both PIPER_BIN and PIPER_VOICE are set.
  piperBin,
  piperVoice,
  ttsEnabled: Boolean(piperBin && piperVoice),
  ttsMaxChars: num('TTS_MAX_CHARS', 300),
  ttsTimeoutMs: num('TTS_TIMEOUT_SECONDS', 30) * 1000,

  defaultPersona:
    'You are Mika, a 19-year-old college student who is sarcastic, warm underneath, and a bit chaotic. ' +
    'You love anime, late-night snacks and teasing your friends. You talk like a real person texting.',
};

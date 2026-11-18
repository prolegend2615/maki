import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });

// BOT_DB lets the test suite use a scratch database instead of the live bot's one.
const db = new DatabaseSync(process.env.BOT_DB || 'data/bot.db');
// WAL + busy timeout: readers never block on a writer, and brief write contention waits instead of throwing.
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_stats (
    scope TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    interactions INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, user_id)
  );
  CREATE TABLE IF NOT EXISTS user_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS announcements (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
`);

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export const getSetting = (key) => getStmt.get(key)?.value ?? null;
export const setSetting = (key, value) => void setStmt.run(key, String(value));
export const closeDb = () => db.close();
const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');
const prefixStmt = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?');
export const deleteSetting = (key) => void delStmt.run(key);
export const listSettings = (prefix) => prefixStmt.all(`${prefix}%`);

// --- AI notebook -----------------------------------------------------------
// scope is `guild:<id>` (shared by everyone in the server) or `dm:<channelId>` (one user).
export const MAX_NOTES = 20;
export const MAX_NOTE_LENGTH = 200;

const listStmt = db.prepare('SELECT id, text FROM notes WHERE scope = ? ORDER BY id');
const addStmt = db.prepare('INSERT INTO notes (scope, text) VALUES (?, ?)');
const removeStmt = db.prepare('DELETE FROM notes WHERE scope = ? AND id = ?');
const trimStmt = db.prepare(
  'DELETE FROM notes WHERE scope = ? AND id NOT IN (SELECT id FROM notes WHERE scope = ? ORDER BY id DESC LIMIT ?)',
);

export const listNotes = (scope) => listStmt.all(scope).map((n) => ({ id: n.id, text: n.text }));

export function applyNotes(scope, { add = [], remove = [] }) {
  for (const id of remove) removeStmt.run(scope, id);
  for (const text of add) addStmt.run(scope, text.slice(0, MAX_NOTE_LENGTH));
  trimStmt.run(scope, scope, MAX_NOTES); // oldest notes fall off the end
}

// --- People memory -----------------------------------------------------------
// Same scope as the notebook; one row per user the bot has engaged with.
export const MAX_FACTS_PER_USER = 8;
export const MAX_FACT_LENGTH = 160;

const bumpStmt = db.prepare(`
  INSERT INTO user_stats (scope, user_id, name, interactions, last_seen) VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(scope, user_id) DO UPDATE SET interactions = interactions + 1, last_seen = excluded.last_seen, name = excluded.name`);
const statsStmt = db.prepare('SELECT interactions, last_seen FROM user_stats WHERE scope = ? AND user_id = ?');
const factsStmt = db.prepare('SELECT id, text FROM user_facts WHERE scope = ? AND user_id = ? ORDER BY id');
const factAddStmt = db.prepare('INSERT INTO user_facts (scope, user_id, text) VALUES (?, ?, ?)');
const factRemoveStmt = db.prepare('DELETE FROM user_facts WHERE scope = ? AND user_id = ? AND id = ?');
const factTrimStmt = db.prepare(
  `DELETE FROM user_facts WHERE scope = ? AND user_id = ? AND id NOT IN
   (SELECT id FROM user_facts WHERE scope = ? AND user_id = ? ORDER BY id DESC LIMIT ?)`,
);

/** Counts one meaningful interaction (they pinged the bot, or kept a conversation going). */
export const bumpUser = (scope, userId, name) => void bumpStmt.run(scope, userId, name, Date.now());

export const getUserStats = (scope, userId) =>
  statsStmt.get(scope, userId) ?? { interactions: 0, last_seen: 0 };

export const listUserFacts = (scope, userId) => factsStmt.all(scope, userId).map((f) => ({ id: f.id, text: f.text }));

export function applyUserFacts(scope, userId, { add = [], remove = [] }) {
  for (const id of remove) factRemoveStmt.run(scope, userId, id);
  for (const text of add) factAddStmt.run(scope, userId, text.slice(0, MAX_FACT_LENGTH));
  factTrimStmt.run(scope, userId, scope, userId, MAX_FACTS_PER_USER); // oldest facts fall off the end
}

// --- Server announcements -----------------------------------------------------
// Messages recorded from watched announcement channels (auto-detected or via /announce-watch).
export const MAX_ANNOUNCEMENTS = 20;
export const MAX_ANNOUNCEMENT_LENGTH = 400;

const annAddStmt = db.prepare(
  'INSERT OR IGNORE INTO announcements (message_id, guild_id, channel_id, author, text, ts) VALUES (?, ?, ?, ?, ?, ?)',
);
const annPruneStmt = db.prepare(
  `DELETE FROM announcements WHERE guild_id = ? AND message_id NOT IN
   (SELECT message_id FROM announcements WHERE guild_id = ? ORDER BY ts DESC LIMIT ?)`,
);
const annListStmt = db.prepare('SELECT author, text, ts FROM announcements WHERE guild_id = ? ORDER BY ts DESC LIMIT ?');

export function addAnnouncement({ guildId, messageId, author, text, ts }) {
  const res = annAddStmt.run(messageId, guildId, '', author, text.slice(0, MAX_ANNOUNCEMENT_LENGTH), ts);
  if (res.changes === 0) return false; // already recorded
  annPruneStmt.run(guildId, guildId, MAX_ANNOUNCEMENTS);
  return true;
}

export const listAnnouncements = (guildId, limit = 5) =>
  annListStmt.all(guildId, limit).map((a) => ({ author: a.author, text: a.text, ts: a.ts }));

// --- Announcement channel watch list ------------------------------------------
export const getWatchList = (guildId) => {
  try {
    const list = JSON.parse(getSetting(`announceWatch:${guildId}`) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};
export const setWatchList = (guildId, ids) => setSetting(`announceWatch:${guildId}`, JSON.stringify(ids));

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });

const db = new DatabaseSync('data/bot.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    text TEXT NOT NULL
  );
`);

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export const getSetting = (key) => getStmt.get(key)?.value ?? null;
export const setSetting = (key, value) => void setStmt.run(key, String(value));

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

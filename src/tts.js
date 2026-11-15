import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';

// One synthesis at a time: the VPS is small and shared with the bot itself.
let queue = Promise.resolve();

/** Piper reads emoji, links and markdown symbols badly, so drop them before speaking. */
export function cleanForSpeech(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<a?:\w+:\d+>/g, '') // custom discord emoji
    .replace(/[*_`~|>#\\]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function synthesizeNow(text, signal) {
  signal?.throwIfAborted();
  const spoken = cleanForSpeech(text);
  if (!spoken) throw new Error('nothing speakable in text');

  const dir = await mkdtemp(join(tmpdir(), 'mika-tts-'));
  const out = join(dir, 'voice.wav');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(config.piperBin, ['--model', config.piperVoice, '--output_file', out], {
        stdio: ['pipe', 'ignore', 'pipe'],
        signal,
        timeout: config.ttsTimeoutMs,
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-400);
      });
      child.stdin.on('error', () => {}); // piper died early: the close handler reports why
      child.on('error', reject); // ENOENT (bad PIPER_BIN), abort
      child.on('close', (code, sig) =>
        code === 0 ? resolve() : reject(new Error(`piper ${sig ? `killed (${sig})` : `exited ${code}`}: ${stderr.trim()}`)),
      );
      child.stdin.end(`${spoken}\n`);
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Returns the .wav bytes for `text`. Jobs run strictly one after another. */
export function synthesize(text, signal) {
  const job = queue.then(() => synthesizeNow(text, signal));
  queue = job.catch(() => {});
  return job;
}

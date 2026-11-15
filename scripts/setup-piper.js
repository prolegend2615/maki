// One-time setup: downloads the Piper binary and one voice into ./piper, then prints the .env lines.
// Usage: npm run setup:piper [-- en_US-amy-medium]
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RELEASE = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2';
const VOICES = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const ARCHIVES = {
  'linux-x64': 'piper_linux_x86_64.tar.gz',
  'linux-arm64': 'piper_linux_aarch64.tar.gz',
  'darwin-x64': 'piper_macos_x64.tar.gz',
  'darwin-arm64': 'piper_macos_aarch64.tar.gz',
  'win32-x64': 'piper_windows_amd64.zip',
};

const dir = resolve('piper');
const voiceName = process.argv[2] || 'en_US-lessac-medium';
const archive = ARCHIVES[`${platform()}-${arch()}`];
if (!archive) fail(`No Piper build for ${platform()}-${arch()}.`);

// "en_US-lessac-medium" -> en/en_US/lessac/medium
const parts = voiceName.split('-');
if (parts.length !== 3) fail(`Voice must look like en_US-lessac-medium, got "${voiceName}".`);
const [locale, speaker, quality] = parts;
const voiceUrl = `${VOICES}/${locale.split('_')[0]}/${locale}/${speaker}/${quality}/${voiceName}`;

const bin = join(dir, 'piper', platform() === 'win32' ? 'piper.exe' : 'piper');
const voice = join(dir, 'voices', `${voiceName}.onnx`);

function fail(message) {
  console.error(`setup-piper: ${message}`);
  process.exit(1);
}

async function download(url, file) {
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) fail(`HTTP ${res.status} for ${url}`);
  const part = `${file}.part`; // never leave a half-written file under the final name
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    await rename(part, file);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

await mkdir(join(dir, 'voices'), { recursive: true });

if (existsSync(bin)) {
  console.log('piper binary already present, skipping');
} else {
  const file = join(dir, archive);
  await download(`${RELEASE}/${archive}`, file);
  // Windows: the PATH tar may be GNU tar (Git Bash), which cannot read zip; System32's bsdtar can.
  // Relative names + cwd, because GNU tar treats "C:\..." as a remote host.
  const tar = platform() === 'win32' ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
  const result = spawnSync(tar, ['-xf', archive], { cwd: dir, stdio: 'inherit' });
  await rm(file, { force: true });
  if (result.status !== 0) fail('could not extract the archive: is `tar` installed?');
  if (!existsSync(bin)) fail(`archive extracted but ${bin} is missing`);
}

for (const ext of ['.onnx', '.onnx.json']) {
  const file = join(dir, 'voices', `${voiceName}${ext}`);
  if (existsSync(file)) console.log(`${voiceName}${ext} already present, skipping`);
  else await download(`${voiceUrl}${ext}`, file);
}

const test = spawnSync(bin, ['--model', voice, '--output_file', join(dir, 'test.wav')], {
  input: 'hello, this is a test\n',
  encoding: 'utf8',
});
if (test.status !== 0) fail(`piper test run failed: ${test.error?.message ?? test.stderr}`);
await rm(join(dir, 'test.wav'), { force: true });

console.log('\nPiper works. Add this to .env and restart the bot:\n');
console.log(`PIPER_BIN=${bin}`);
console.log(`PIPER_VOICE=${voice}`);

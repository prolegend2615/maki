import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'x';
process.env.API_KEY ||= 'x';

const { parseReply } = await import('../src/ai.js');
const { config } = await import('../src/config.js');
const { cleanForSpeech } = await import('../src/tts.js');
const { makeTypo } = await import('../src/humanizer.js');
await import('../src/brain.js');
await import('../src/commands.js');

const none = { add: [], remove: [] };

test('parseReply handles ignore, fenced json, and plain text', () => {
  assert.deepEqual(parseReply('{"action":"ignore"}'), { action: 'ignore', notes: none });
  assert.deepEqual(parseReply('```json\n{"action":"reply","messages":["hey","sup"]}\n```'), {
    action: 'reply',
    messages: ['hey', 'sup'],
    notes: none,
  });
  assert.deepEqual(parseReply('just text'), { action: 'reply', messages: ['just text'], notes: none });
  assert.deepEqual(parseReply('[IGNORE]'), { action: 'ignore', notes: none });
});

test('parseReply keeps notes, even when ignoring', () => {
  const r = parseReply('{"action":"ignore","notes":{"add":["Sam likes cats"],"remove":["#2","x"]}}');
  assert.deepEqual(r, { action: 'ignore', notes: { add: ['Sam likes cats'], remove: [2] } });
});

test('voice action needs TTS enabled, otherwise it becomes a text reply', () => {
  const raw = '{"action":"voice","text":"hello there"}';
  assert.deepEqual(parseReply(raw), { action: 'reply', messages: ['hello there'], notes: none });
  config.ttsEnabled = true;
  try {
    assert.deepEqual(parseReply(raw), { action: 'voice', text: 'hello there', notes: none });
    assert.equal(parseReply(`{"action":"voice","text":"${'a'.repeat(999)}"}`).text.length, config.ttsMaxChars);
  } finally {
    config.ttsEnabled = false;
  }
});

test('cleanForSpeech strips links, markdown and emoji', () => {
  assert.equal(cleanForSpeech('**hey** look https://x.io/a 😂 ok'), 'hey look ok');
});

test('makeTypo changes exactly one word and keeps the rest', () => {
  for (let i = 0; i < 50; i++) {
    const typo = makeTypo('hello there friend');
    if (!typo) continue;
    assert.notEqual(typo.typoText, 'hello there friend');
    assert.equal(typo.typoText.replace(typo.broken, typo.word), 'hello there friend');
  }
  assert.equal(makeTypo('hi'), null);
});

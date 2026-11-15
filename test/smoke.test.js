import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'x';
process.env.API_KEY ||= 'x';

const { parseReply } = await import('../src/ai.js');
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

test('makeTypo changes exactly one word and keeps the rest', () => {
  for (let i = 0; i < 50; i++) {
    const typo = makeTypo('hello there friend');
    if (!typo) continue;
    assert.notEqual(typo.typoText, 'hello there friend');
    assert.equal(typo.typoText.replace(typo.broken, typo.word), 'hello there friend');
  }
  assert.equal(makeTypo('hi'), null);
});

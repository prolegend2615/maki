import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'x';
process.env.API_KEY ||= 'x';

const { parseReply, parseMemory, describeUser, describeMood, isValidEmoji } = await import('../src/ai.js');
const { config } = await import('../src/config.js');
const { cleanForSpeech } = await import('../src/tts.js');
const { makeTypo } = await import('../src/humanizer.js');
const { bumpUser, getUserStats, listUserFacts, applyUserFacts, MAX_FACTS_PER_USER, addAnnouncement, listAnnouncements, MAX_ANNOUNCEMENTS, getWatchList, setWatchList } = await import('../src/db.js');
const { canProactive, recordProactive, performLookup } = await import('../src/brain.js');
const { searchGif } = await import('../src/gifs.js');
await import('../src/commands.js');

const none = { add: [], remove: [] };

test('config builds at least one usable provider', () => {
  assert.ok(Array.isArray(config.providers) && config.providers.length >= 1);
  for (const p of config.providers) {
    assert.ok(p.apiBase && p.apiKey && p.models.length >= 1, `provider ${p.label} is complete`);
  }
});

test('describeUser tiers by interactions and fades with absence', () => {
  assert.equal(describeUser({ interactions: 0, lastSeen: 0 }), 'a stranger');
  assert.equal(describeUser({ interactions: 2, lastSeen: Date.now() }), 'someone you barely know');
  assert.equal(describeUser({ interactions: 7, lastSeen: Date.now() }), 'someone you know');
  assert.equal(describeUser({ interactions: 20, lastSeen: Date.now() }), 'a familiar face you talk to a lot');
  assert.equal(describeUser({ interactions: 50, lastSeen: Date.now() }), 'a close friend');
  const aMonthAgo = Date.now() - 30 * 86_400_000;
  assert.equal(describeUser({ interactions: 40, lastSeen: aMonthAgo }), 'someone you know'); // faded
});

test('parseMemory reads extraction json and survives garbage', () => {
  const good = parseMemory(
    '```json\n{"notes":{"add":["party friday"],"remove":["#2"]},"facts":{"Sam":{"add":["hates cilantro"]}}}\n```',
  );
  assert.deepEqual(good, {
    notes: { add: ['party friday'], remove: [2] },
    facts: { Sam: { add: ['hates cilantro'], remove: [] } },
    followUp: null,
    mood: null,
  });
  assert.deepEqual(parseMemory('nope'), { notes: { add: [], remove: [] }, facts: {}, followUp: null, mood: null });
  assert.deepEqual(parseMemory('{"facts":{"you":{"add":["is a bot"]}}}'), {
    notes: { add: [], remove: [] },
    facts: { you: { add: ['is a bot'], remove: [] } },
    followUp: null,
    mood: null,
  });
});

test('parseMemory parses followUp hints with clamped hours', () => {
  assert.deepEqual(parseMemory('{"notes":{},"followUp":{"topic":"exam monday","hours":0}}').followUp, {
    topic: 'exam monday',
    hours: 1,
  });
  assert.equal(parseMemory('{"followUp":{"topic":"trip","hours":100}}').followUp.hours, 48);
  assert.equal(parseMemory('{"followUp":{"topic":"trip"}}').followUp.hours, null);
  assert.equal(parseMemory('{"followUp":{"hours":5}}').followUp, null);
  assert.equal(parseMemory('{}').followUp, null);
});

test('isValidEmoji accepts emoji and custom emoji, rejects text and shortcodes', () => {
  assert.equal(isValidEmoji('💀'), true);
  assert.equal(isValidEmoji('👀'), true);
  assert.equal(isValidEmoji('👍🏽'), true);
  assert.equal(isValidEmoji('🇩🇪'), true);
  assert.equal(isValidEmoji('<:mika_hug:123456789012345678>'), true);
  assert.equal(isValidEmoji('<a:mika_spin:123456789012345678>'), true);
  assert.equal(isValidEmoji(':skull:'), false);
  assert.equal(isValidEmoji('lol 💀'), false);
  assert.equal(isValidEmoji(''), false);
  assert.equal(isValidEmoji('abc'), false);
  assert.equal(isValidEmoji(5), false);
});

test('parseReply supports the react action', () => {
  assert.deepEqual(parseReply('{"action":"react","emoji":"💀","target":2}'), {
    action: 'react',
    emoji: '💀',
    target: 2,
    notes: none,
  });
  assert.deepEqual(parseReply('{"action":"react","emoji":"👀"}'), {
    action: 'react',
    emoji: '👀',
    target: null,
    notes: none,
  });
  // A broken emoji falls back to any text the model included, otherwise stays silent.
  assert.deepEqual(parseReply('{"action":"react","emoji":"skull","messages":["lol"]}'), {
    action: 'reply',
    messages: ['lol'],
    notes: none,
    rephrase: null,
  });
  assert.deepEqual(parseReply('{"action":"react","emoji":"skull"}'), { action: 'ignore', notes: none });
});

test('proactive follow-ups respect their limits', () => {
  const id = `test-proactive-${process.pid}-${Date.now()}`;
  assert.equal(canProactive(id), true);
  recordProactive(id);
  assert.equal(canProactive(id), false); // inside the minimum gap
  recordProactive(id);
  assert.equal(canProactive(id), false); // daily cap reached
});

test('parseReply handles gif actions and rephrase', () => {
  config.tenorKey = 'test-key';
  try {
    assert.deepEqual(parseReply('{"action":"gif","query":"angry cat"}'), {
      action: 'gif',
      query: 'angry cat',
      messages: [],
      notes: none,
    });
    assert.deepEqual(parseReply('{"action":"gif","query":"cat","messages":["lol look"]}'), {
      action: 'gif',
      query: 'cat',
      messages: ['lol look'],
      notes: none,
    });
  } finally {
    config.tenorKey = '';
  }
  // Tenor off: falls back to the text, or stays silent.
  assert.deepEqual(parseReply('{"action":"gif","query":"cat","messages":["lol look"]}'), {
    action: 'reply',
    messages: ['lol look'],
    notes: none,
    rephrase: null,
  });
  assert.deepEqual(parseReply('{"action":"gif","query":"cat"}'), { action: 'ignore', notes: none });
  assert.equal(parseReply('{"action":"reply","messages":["hmm"],"rephrase":"wait actually"}').rephrase, 'wait actually');
  assert.equal(parseReply('{"action":"reply","messages":["hmm"]}').rephrase, null);
});

test('parseMemory clamps mood deltas', () => {
  assert.deepEqual(parseMemory('{"mood":{"energy":0.9,"irritability":-5}}').mood, { energy: 0.3, irritability: -0.3 });
  assert.equal(parseMemory('{"mood":{"energy":"x"}}').mood, null);
  assert.deepEqual(parseMemory('{"mood":{"energy":-0.1,"irritability":0}}').mood, { energy: -0.1, irritability: 0 });
  assert.equal(parseMemory('{}').mood, null);
});

test('describeMood blends hour baseline with stored experiences', () => {
  assert.match(describeMood({ energy: 0.9, irritability: 0.9, updated: Date.now() }), /Your mood right now/);
  assert.match(describeMood(null), /Your mood right now/); // never crashes without a stored mood
  assert.match(describeMood('garbage'), /Your mood right now/);
});

test('searchGif returns a candidate url from tenor', async () => {
  config.tenorKey = 'test-key';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [{ media_formats: { mediumgif: { url: 'https://media.tenor.com/a.gif' } } }] }),
  });
  try {
    assert.equal(await searchGif('cat'), 'https://media.tenor.com/a.gif');
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'x' });
    assert.equal(await searchGif('cat'), null); // failure stays silent
    config.tenorKey = '';
    assert.equal(await searchGif('cat'), null); // disabled
  } finally {
    config.tenorKey = '';
    delete globalThis.fetch;
  }
});

test('parseReply supports lookup actions', () => {
  assert.deepEqual(parseReply('{"action":"lookup","what":"server"}'), { action: 'lookup', what: 'server', name: null, notes: none });
  assert.deepEqual(parseReply('{"action":"lookup","what":"PERSON","name":"Sam (@sam)"}'), {
    action: 'lookup',
    what: 'person',
    name: 'Sam (@sam)',
    notes: none,
  });
  // Unknown kind falls back to any text, otherwise silence.
  assert.deepEqual(parseReply('{"action":"lookup","what":"weather","messages":["hi"]}'), {
    action: 'reply',
    messages: ['hi'],
    notes: none,
    rephrase: null,
  });
  assert.deepEqual(parseReply('{"action":"lookup","what":"weather"}'), { action: 'ignore', notes: none });
  assert.deepEqual(parseReply('{"action":"lookup","what":"INFO"}'), { action: 'lookup', what: 'info', name: null, notes: none });
  assert.deepEqual(parseReply('{"action":"lookup","what":"member","name":"Rae"}'), {
    action: 'lookup',
    what: 'member',
    name: 'Rae',
    notes: none,
  });
});

test('performLookup reads server info and member profiles', async () => {
  const makeRole = (name, position) => ({ name, position });
  const makeMember = (id, displayName, username, { roles = [], keyPerms = [], bot = false } = {}) => ({
    id,
    displayName,
    user: { id, username, bot },
    joinedTimestamp: Date.parse('2023-03-12'),
    roles: { cache: { values: () => roles } },
    permissions: { toArray: () => keyPerms },
  });
  const owner = makeMember('o1', 'RaidLeader', 'raidboss');
  const sam = makeMember('u1', 'Sam', 'samraw', {
    roles: [makeRole('Regular', 1), makeRole('Admin', 5), makeRole('@everyone', 0)],
    keyPerms: ['Administrator', 'SendMessages', 'BanMembers'],
  });
  const guild = {
    id: 'g1',
    ownerId: 'o1',
    memberCount: 42,
    premiumSubscriptionCount: 7,
    premiumTier: 2,
    createdTimestamp: Date.parse('2020-01-01'),
    channels: { cache: { size: 12 } },
    roles: { cache: { size: 15 } },
    emojis: { cache: { size: 30 } },
    verificationLevel: 'medium',
    members: { cache: { get: (id) => (id === 'o1' ? owner : null), find: (f) => [sam].find(f) } },
  };
  const channel = { guild };

  const info = await performLookup(channel, 'scope', [], { what: 'info' });
  assert.match(info, /Owner: RaidLeader/);
  assert.match(info, /Members: 42/);
  assert.match(info, /Boosts: 7 \(tier 2\)/);
  assert.match(info, /Channels: 12/);

  const member = await performLookup(channel, 'scope', [], { what: 'member', name: 'sam' });
  assert.match(member, /^Sam/);
  assert.match(member, /Roles: Admin, Regular/); // @everyone filtered, sorted by position
  assert.match(member, /Key permissions: Administrator, BanMembers/);
  assert.match(member, /Joined: 12 Mar 2023/);

  assert.match(await performLookup({ guild: null }, 'scope', [], { what: 'info' }), /DM/);
  assert.match(await performLookup(channel, 'scope', [], { what: 'member', name: 'ghost' }), /no member called/);
});

test('announcements dedupe, list newest first and prune', () => {
  const guildId = `test-g-${process.pid}`;
  const mk = (i) => ({ guildId, messageId: `m-${guildId}-${i}`, author: 'Admin', text: `news ${i}`, ts: 1000 + i });
  assert.equal(addAnnouncement(mk(1)), true);
  assert.equal(addAnnouncement(mk(1)), false); // duplicate message id
  for (let i = 2; i <= MAX_ANNOUNCEMENTS + 3; i++) addAnnouncement(mk(i));
  const list = listAnnouncements(guildId, 100);
  assert.equal(list.length, MAX_ANNOUNCEMENTS); // oldest fell off
  assert.equal(list[0].text, `news ${MAX_ANNOUNCEMENTS + 3}`); // newest first
  assert.equal(list.at(-1).text, `news 4`);
});

test('announcement watch list persists per guild', () => {
  const guildId = `test-w-${process.pid}`;
  assert.deepEqual(getWatchList(guildId), []);
  setWatchList(guildId, ['111', '222']);
  assert.deepEqual(getWatchList(guildId), ['111', '222']);
  setWatchList(guildId, []);
  assert.deepEqual(getWatchList(guildId), []);
});

test('user stats and facts persist with a cap', () => {
  const scope = `test:${process.pid}:${Date.now()}`;
  bumpUser(scope, '42', 'Sam');
  bumpUser(scope, '42', 'Sam');
  assert.equal(getUserStats(scope, '42').interactions, 2);
  assert.equal(getUserStats(scope, '43').interactions, 0);
  assert.equal(listUserFacts(scope, '42').length, 0);
  for (let i = 0; i < MAX_FACTS_PER_USER + 2; i++) applyUserFacts(scope, '42', { add: [`fact ${i}`] });
  const facts = listUserFacts(scope, '42');
  assert.equal(facts.length, MAX_FACTS_PER_USER); // oldest fell off
  assert.equal(facts.at(-1).text, `fact ${MAX_FACTS_PER_USER + 1}`);
  applyUserFacts(scope, '42', { remove: [facts[0].id] });
  assert.equal(listUserFacts(scope, '42').length, MAX_FACTS_PER_USER - 1);
});

test('parseReply handles ignore, fenced json, and plain text', () => {
  assert.deepEqual(parseReply('{"action":"ignore"}'), { action: 'ignore', notes: none });
  assert.deepEqual(parseReply('```json\n{"action":"reply","messages":["hey","sup"]}\n```'), {
    action: 'reply',
    messages: ['hey', 'sup'],
    notes: none,
    rephrase: null,
  });
  assert.deepEqual(parseReply('just text'), { action: 'reply', messages: ['just text'], notes: none });
  assert.deepEqual(parseReply('[IGNORE]'), { action: 'ignore', notes: none });
});

test('parseReply repairs common JSON slips instead of leaking them', () => {
  assert.deepEqual(parseReply('{“action”:“reply”,“messages”:[“hey”]}'), { action: 'reply', messages: ['hey'], notes: none, rephrase: null });
  assert.deepEqual(parseReply('{"action":"reply","messages":["hey"],}'), { action: 'reply', messages: ['hey'], notes: none, rephrase: null });
});

test('parseReply never sends broken or nested JSON as chat text', () => {
  // Broken beyond repair: ignored, never posted literally.
  assert.deepEqual(parseReply('{"action":"reply","messages":["owner?? bro "i\'m" an anarchist"]}'), {
    action: 'ignore',
    notes: none,
  });
  // Model echoed its own format inside "messages": unwrap it.
  const nested = JSON.stringify({ action: 'reply', messages: [JSON.stringify({ action: 'reply', messages: ['hey'] })] });
  assert.deepEqual(parseReply(nested), { action: 'reply', messages: ['hey'], notes: none, rephrase: null });
});

test('parseReply keeps notes, even when ignoring', () => {
  const r = parseReply('{"action":"ignore","notes":{"add":["Sam likes cats"],"remove":["#2","x"]}}');
  assert.deepEqual(r, { action: 'ignore', notes: { add: ['Sam likes cats'], remove: [2] } });
});

test('voice action needs TTS enabled, otherwise it becomes a text reply', () => {
  const raw = '{"action":"voice","text":"hello there"}';
  assert.deepEqual(parseReply(raw), { action: 'reply', messages: ['hello there'], notes: none, rephrase: null });
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

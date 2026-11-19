import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';

process.env.DISCORD_TOKEN ||= 'x';
process.env.API_KEY ||= 'x';
// Scratch database: the live bot may be running and holding data/bot.db (SQLITE_BUSY otherwise).
process.env.BOT_DB = `data/test-${process.pid}.db`;
after(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb(); // Windows: unlink fails while the handle is open
  try {
    unlinkSync(process.env.BOT_DB);
  } catch {
    // already gone
  }
});

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
  assert.deepEqual(parseReply('{"action":"lookup","what":"structure"}'), { action: 'lookup', what: 'structure', name: null, notes: none });
  assert.deepEqual(parseReply('{"action":"lookup","what":"ROLES"}'), { action: 'lookup', what: 'roles', name: null, notes: none });
  assert.deepEqual(parseReply('{"action":"lookup","what":"images"}'), { action: 'lookup', what: 'images', name: null, notes: none });
});

test('performLookup reads channel structure and role details', async () => {
  const { ChannelType } = await import('discord.js');
  const ch = (id, name, type, parentId, rawPosition) => ({ id, name, type, parentId, rawPosition, isThread: () => false });
  const channels = new Map([
    ['cat1', ch('cat1', 'Events', ChannelType.GuildCategory, null, 0)],
    ['c1', ch('c1', 'general', ChannelType.GuildText, null, 1)],
    ['c2', ch('c2', 'vents', ChannelType.GuildText, 'cat1', 2)],
    ['c3', ch('c3', 'lounge', ChannelType.GuildVoice, 'cat1', 3)],
    ['t1', { id: 't1', name: 'hidden-thread', type: ChannelType.PublicThread, parentId: 'c1', isThread: () => true }],
  ]);
  const role = (id, name, position, hexColor, perms) => ({ id, name, position, hexColor, permissions: { toArray: () => perms } });
  const roles = new Map([
    ['r1', role('r1', 'Admin', 5, '#ff0000', ['Administrator', 'SendMessages'])],
    ['r2', role('r2', 'VIP', 2, '#ff8800', ['SendMessages'])],
    ['e1', role('e1', '@everyone', 0, '#000000', [])],
  ]);
  const guild = { id: 'g1', channels: { cache: channels }, roles: { everyone: { id: 'e1' }, cache: roles } };
  const channel = { guild };

  const structure = await performLookup(channel, 'scope', [], { what: 'structure' });
  assert.match(structure, /\[category\] Events: #vents, #lounge \[voice\]/);
  assert.match(structure, /No category: #general/);
  assert.ok(!structure.includes('hidden-thread')); // threads stay out

  const roleList = await performLookup(channel, 'scope', [], { what: 'roles' });
  assert.match(roleList, /^Admin — color #ff0000, position 5, key perms: Administrator$/m);
  assert.match(roleList, /^VIP — color #ff8800, position 2$/m); // no key perms -> no suffix
  assert.ok(!roleList.includes('@everyone'));

  assert.match(await performLookup({ guild: null }, 'scope', [], { what: 'structure' }), /DM/);
  assert.match(await performLookup({ guild: null }, 'scope', [], { what: 'roles' }), /DM/);
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

test('parseReply supports staff actions with hard clamps', () => {
  assert.deepEqual(parseReply('{"action":"staff","op":"timeout","user":"Sam","minutes":999,"reason":"spam"}'), {
    action: 'staff',
    op: 'timeout',
    channel: '',
    user: 'Sam',
    name: '',
    category: '',
    role: '',
    target: '',
    targetIndex: null,
    message: '',
    count: 5,
    color: '',
    allow: [],
    deny: [],
    type: 'text',
    topic: '',
    minutes: 60,
    seconds: 0,
    reason: 'spam',
    messages: [],
    notes: none,
  });
  assert.deepEqual(parseReply('{"action":"staff","op":"lock_channel","messages":["locking it"]}'), {
    action: 'staff',
    op: 'lock_channel',
    channel: '',
    user: '',
    name: '',
    category: '',
    role: '',
    target: '',
    targetIndex: null,
    message: '',
    count: 5,
    color: '',
    allow: [],
    deny: [],
    type: 'text',
    topic: '',
    minutes: 10,
    seconds: 0,
    reason: '',
    messages: ['locking it'],
    notes: none,
  });
  // Heavy ops do not exist: fall back to any text, otherwise silence.
  assert.deepEqual(parseReply('{"action":"staff","op":"ban","user":"Sam","messages":["nope"]}'), {
    action: 'reply',
    messages: ['nope'],
    notes: none,
    rephrase: null,
  });
  assert.deepEqual(parseReply('{"action":"staff","op":"ban","user":"Sam"}'), { action: 'ignore', notes: none });
  config.staffEnabled = false;
  try {
    assert.deepEqual(parseReply('{"action":"staff","op":"lock_channel","messages":["hi"]}'), {
      action: 'reply',
      messages: ['hi'],
      notes: none,
      rephrase: null,
    });
  } finally {
    config.staffEnabled = true;
  }
});

test('staff events buffer keeps the last five', async () => {
  const { recordStaffEvent, staffEventsLine } = await import('../src/staffFlow.js');
  const cid = `test-events-${process.pid}-${Date.now()}`;
  assert.equal(staffEventsLine(cid), null);
  for (let i = 1; i <= 8; i++) recordStaffEvent(cid, `event ${i}`);
  const line = staffEventsLine(cid);
  assert.ok(!line.includes('event 3')); // oldest fell off
  assert.ok(line.includes('event 8'));
});

test('staff confirm flow: wrong user, deny, double-click, confirm, expiry', async () => {
  const { startStaffConfirm, handleStaffButton, staffEventsLine } = await import('../src/staffFlow.js');
  const { PermissionFlagsBits } = await import('discord.js');
  const cid = `test-staff-${process.pid}-${Date.now()}`;
  const mkPerms = (bits) => ({ has: (b) => (Array.isArray(b) ? b.every((x) => bits.includes(x)) : bits.includes(b)) });
  const requester = {
    id: 'u1',
    displayName: 'Sam',
    permissions: mkPerms([PermissionFlagsBits.ManageChannels]),
    permissionsIn: () => mkPerms([PermissionFlagsBits.ManageChannels]),
    roles: { highest: { position: 3 } },
  };
  const me = { id: 'bot', permissions: mkPerms([PermissionFlagsBits.ManageRoles]), roles: { highest: { position: 5 } } };
  const edits = [];
  const overwrites = [];
  const lockChannel = {
    id: cid,
    name: 'general',
    guildId: 'g1',
    permissionsFor: () => mkPerms([PermissionFlagsBits.ManageRoles]),
    permissionOverwrites: {
      cache: { get: () => undefined },
      edit: async (...a) => overwrites.push(a),
      delete: async (...a) => overwrites.push(['del', ...a]),
    },
  };
  const guild = {
    id: 'g1',
    ownerId: 'o',
    members: { me, fetch: async () => requester },
    channels: { cache: { get: (id) => (id === cid ? lockChannel : null) }, fetch: async () => null },
    roles: { everyone: { id: 'e1' } },
  };
  lockChannel.guild = guild;
  const sent = [];
  const channel = { id: cid, guild, send: async (p) => { sent.push(p); return { edit: async (e) => edits.push(e), guild }; } };
  const plan = {
    op: 'lock_channel', guildId: 'g1', channelId: cid, channelName: 'general', targetId: null, targetName: null,
    minutes: 10, seconds: 0, reason: '', requesterId: 'u1', requesterName: 'Sam', summary: 'Lock #general',
  };
  const replies = [];
  const updates = [];
  const mkInteraction = (customId, userId) => ({
    customId,
    user: { id: userId },
    guild,
    reply: async (m) => replies.push(m),
    update: async (m) => updates.push(m),
    deferUpdate: async () => {},
    editReply: async (m) => updates.push(m),
  });
  const buttonId = (msg, i) => msg.components[0].components[i].data.custom_id;

  await startStaffConfirm(channel, plan, {});
  assert.match(staffEventsLine(cid), /WAITING for Sam/); // pending shows in the prompt block

  await handleStaffButton(mkInteraction(buttonId(sent[0], 0), 'u2'));
  assert.match(replies.at(-1).content, /Only the person who asked/);

  await handleStaffButton(mkInteraction(buttonId(sent[0], 1), 'u1'));
  assert.match(updates.at(-1).embeds[0].data.title, /Denied/);
  assert.match(staffEventsLine(cid), /DENIED by Sam/);
  assert.equal(overwrites.length, 0); // deny never touches Discord

  await handleStaffButton(mkInteraction(buttonId(sent[0], 1), 'u1'));
  assert.match(replies.at(-1).content, /expired/); // double-click cannot act twice

  await startStaffConfirm(channel, plan, {});
  await handleStaffButton(mkInteraction(buttonId(sent[1], 0), 'u1'));
  assert.equal(overwrites.length, 2);
  assert.deepEqual(overwrites[0][1], {
    SendMessages: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  });
  // The lock must not gag Mika herself: her own allow overwrite goes in second.
  assert.equal(overwrites[1][0], me);
  assert.deepEqual(overwrites[1][1], { ViewChannel: true, SendMessages: true, SendMessagesInThreads: true });
  assert.match(updates.at(-1).embeds[0].data.title, /Done/);
  assert.match(staffEventsLine(cid), /DONE/);

  await startStaffConfirm(channel, { ...plan, op: 'unlock_channel', summary: 'Unlock #general' }, {});
  await handleStaffButton(mkInteraction(buttonId(sent[2], 0), 'u1'));
  assert.equal(overwrites.length, 4);
  assert.deepEqual(overwrites[2][1], {
    SendMessages: null,
    SendMessagesInThreads: null,
    CreatePublicThreads: null,
    CreatePrivateThreads: null,
  });
  assert.equal(overwrites[3][0], 'del'); // bot exemption removed again on unlock
  assert.equal(overwrites[3][1], me);

  config.staffConfirmSeconds = 0.05;
  try {
    await startStaffConfirm(channel, plan, {});
    await new Promise((r) => setTimeout(r, 150));
    assert.match(edits.at(-1).embeds[0].data.title, /Expired/);
    assert.match(staffEventsLine(cid), /EXPIRED/);
  } finally {
    config.staffConfirmSeconds = 120;
  }
});

test('audit log posts to the configured channel and respects the guild override', async () => {
  const { auditStaff } = await import('../src/staffFlow.js');
  const { setSetting, deleteSetting } = await import('../src/db.js');
  const gid = `test-audit-${process.pid}-${Date.now()}`;
  const posts = [];
  const logChannel = { isTextBased: () => true, send: async (p) => posts.push(p) };
  const guild = { id: gid, channels: { cache: { get: (id) => (id === 'log1' ? logChannel : null) } } };
  const entry = { summary: 'Lock #general', requester: 'Sam', outcome: 'Done', detail: 'in #general' };

  auditStaff(guild, entry); // nothing configured: silent
  assert.equal(posts.length, 0);

  config.staffLogChannelId = 'log1';
  try {
    auditStaff(guild, entry);
    assert.equal(posts.length, 1);
    assert.match(posts[0].embeds[0].data.title, /Done/);
    assert.equal(posts[0].embeds[0].data.fields[0].value, 'Sam');

    setSetting(`staffLog:${gid}`, 'missing-channel');
    auditStaff(guild, entry); // override points nowhere: silent, no crash
    assert.equal(posts.length, 1);
  } finally {
    config.staffLogChannelId = '';
    deleteSetting(`staffLog:${gid}`);
  }
});

test('parseReply supports channel/category staff ops', () => {
  const r = parseReply('{"action":"staff","op":"create_channel","name":"Cool Vents!","category":"Events","type":"voice","topic":"hi"}');
  assert.equal(r.action, 'staff');
  assert.equal(r.name, 'Cool Vents!');
  assert.equal(r.type, 'voice');
  assert.equal(r.category, 'Events');
  assert.equal(parseReply('{"action":"staff","op":"create_channel"}').action, 'ignore'); // name required
  assert.equal(parseReply('{"action":"staff","op":"rename_channel","name":"x"}').action, 'ignore'); // channel required
  assert.equal(parseReply('{"action":"staff","op":"delete_category"}').action, 'ignore'); // category required
  assert.equal(parseReply('{"action":"staff","op":"set_topic","channel":"general","topic":"new"}').op, 'set_topic');
});

test('channel/category lifecycle: create, guards, delete, cooldown, caps', async () => {
  const { prepareStaff, executeStaff, parseStaff, sanitizeName, MAX_BOT_CHANNELS } = await import('../src/staff.js');
  const { PermissionFlagsBits, ChannelType } = await import('discord.js');
  assert.equal(sanitizeName('Cool Vents!', 'text'), 'cool-vents');
  assert.equal(sanitizeName('  #Events  ', 'category'), 'Events');
  assert.equal(sanitizeName('!!!', 'text'), '');

  const gid = `test-p2-${process.pid}-${Date.now()}`;
  const mkPerms = (bits) => ({ has: (b) => (Array.isArray(b) ? b.every((x) => bits.includes(x)) : bits.includes(b)) });
  const sam = {
    id: 'u1', displayName: 'Sam',
    permissions: mkPerms([PermissionFlagsBits.ManageChannels]),
    permissionsIn: () => mkPerms([PermissionFlagsBits.ManageChannels]),
    roles: { highest: { position: 3 } },
  };
  const me = { id: 'bot', permissions: mkPerms([PermissionFlagsBits.ManageChannels]), roles: { highest: { position: 5 } } };
  const cache = new Map();
  cache.find = (f) => [...cache.values()].find(f) ?? null;
  cache.some = (f) => [...cache.values()].some(f);
  const created = [];
  const deleted = [];
  const mkChannel = (id, name, type) => {
    const c = {
      id, name, type, guildId: gid, parentId: null, topic: null,
      isThread: () => false, isTextBased: () => true,
      permissionsFor: () => mkPerms([PermissionFlagsBits.ManageChannels]),
      delete: async () => { deleted.push(id); cache.delete(id); },
    };
    c.setName = async (n) => { c.name = n; };
    c.setTopic = async (t) => { c.topic = t; };
    return c;
  };
  const current = mkChannel(`c-cur-${gid}`, 'general', ChannelType.GuildText);
  cache.set(current.id, current);
  const guild = {
    id: gid, ownerId: 'o',
    members: { me, fetch: async () => sam, cache: { find: () => null } },
    channels: {
      cache,
      fetch: async (id) => cache.get(id) ?? null,
      create: async (opts) => {
        created.push(opts);
        const c = mkChannel(`new-${created.length}`, opts.name, opts.type);
        c.parentId = opts.parent ?? null;
        c.guild = guild;
        cache.set(c.id, c);
        return c;
      },
    },
    roles: { everyone: { id: 'e1' } },
  };
  current.guild = guild;
  const prep = (data, ch = current) => prepareStaff(parseStaff(data), { channel: ch, requester: sam });

  const oldLimit = config.staffOpsPerMinute;
  config.staffOpsPerMinute = 200;
  try {
    // create category + channel under it
    let r = await prep({ op: 'create_category', name: 'Events' });
    assert.ok(r.ok, r.reason);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.equal(created[0].type, ChannelType.GuildCategory);
    const catId = [...cache.values()].find((c) => c.type === ChannelType.GuildCategory).id;

    r = await prep({ op: 'create_channel', name: 'Cool Vents!', category: 'Events', topic: 'venting' });
    assert.ok(r.ok, r.reason);
    assert.equal(r.plan.name, 'cool-vents');
    assert.equal(r.plan.parentId, catId);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    const ventId = [...cache.values()].find((c) => c.name === 'cool-vents').id;

    // duplicates blocked
    assert.match((await prep({ op: 'create_category', name: 'events' })).reason, /already exists/);
    assert.match((await prep({ op: 'create_channel', name: 'cool vents' })).reason, /already exists/);
    assert.match((await prep({ op: 'create_channel', name: 'x', category: 'Ghost' })).reason, /no category/);

    // delete guards: not bot-made, own channel, non-empty category
    assert.match((await prep({ op: 'delete_channel', channel: 'general' })).reason, /not mine/);
    assert.match((await prep({ op: 'delete_channel', channel: 'cool-vents' }, cache.get(ventId))).reason, /talking in/);
    assert.match((await prep({ op: 'delete_category', category: 'Events' })).reason, /still has channels/);

    // delete the created channel, then the now-empty category
    r = await prep({ op: 'delete_channel', channel: 'cool-vents' });
    assert.ok(r.ok, r.reason);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.ok(deleted.includes(ventId));
    r = await prep({ op: 'delete_category', category: 'Events' });
    assert.ok(r.ok, r.reason);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.ok(deleted.includes(catId));

    // rename cooldown: 2 edits allowed, 3rd blocked
    assert.ok((await executeStaff((await prep({ op: 'rename_channel', channel: 'general', name: 'gen-1' })).plan, guild)).ok);
    assert.ok((await executeStaff((await prep({ op: 'set_topic', channel: 'gen-1', topic: 'hello' })).plan, guild)).ok);
    assert.match((await prep({ op: 'rename_channel', channel: 'gen-1', name: 'gen-2' })).reason, /2 edits per 10 minutes/);

    // channel cap
    for (let i = 0; i < MAX_BOT_CHANNELS; i++) {
      const p = await prep({ op: 'create_channel', name: `filler-${i}` });
      assert.ok(p.ok, p.reason);
      assert.ok((await executeStaff(p.plan, guild)).ok);
    }
    assert.match((await prep({ op: 'create_channel', name: 'one-too-many' })).reason, /my limit/);
  } finally {
    config.staffOpsPerMinute = oldLimit;
  }
});

test('parseReply supports role/perm staff ops', () => {
  const r = parseReply('{"action":"staff","op":"role_perms","role":"VIP","allow":["sendmessages","embedlinks"],"deny":["AddReactions"]}');
  assert.equal(r.action, 'staff');
  assert.deepEqual(r.allow, ['SendMessages', 'EmbedLinks']); // canonical Discord casing
  assert.deepEqual(r.deny, ['AddReactions']);
  // Unknown names stay raw so the whitelist can name the offender.
  assert.deepEqual(parseReply('{"action":"staff","op":"role_perms","role":"VIP","allow":["Fly"]}').allow, ['Fly']);
  assert.equal(parseReply('{"action":"staff","op":"role_perms","role":"VIP"}').action, 'ignore'); // needs allow or deny
  assert.equal(parseReply('{"action":"staff","op":"give_role","role":"VIP"}').action, 'ignore'); // user required
  assert.equal(parseReply('{"action":"staff","op":"give_role","user":"Sam"}').action, 'ignore'); // role required
  assert.equal(parseReply('{"action":"staff","op":"channel_perms","allow":["ViewChannel"]}').action, 'ignore'); // target required
  assert.equal(parseReply('{"action":"staff","op":"create_role"}').action, 'ignore'); // name required
  assert.equal(parseReply('{"action":"staff","op":"delete_message"}').action, 'ignore'); // message or [n] required
  assert.equal(parseReply('{"action":"staff","op":"purge","count":3}').action, 'ignore'); // user required
  assert.equal(parseReply('{"action":"staff","op":"purge","user":"Sam","count":99}').count, 10); // clamped
  const c = parseReply('{"action":"staff","op":"channel_perms","channel":"general","target":"@everyone","deny":["ViewChannel"]}');
  assert.equal(c.op, 'channel_perms');
  assert.equal(c.target, '@everyone');
  assert.deepEqual(c.deny, ['ViewChannel']);
});

test('role lifecycle: create, perms whitelist, give/remove, hierarchy, channel perms, delete, cap', async () => {
  const { prepareStaff, executeStaff, parseStaff, MAX_BOT_ROLES } = await import('../src/staff.js');
  const { PermissionFlagsBits, ChannelType } = await import('discord.js');

  const gid = `test-p3-${process.pid}-${Date.now()}`;
  const mkPerms = (bits) => ({ has: (b) => (Array.isArray(b) ? b.every((x) => bits.includes(x)) : bits.includes(b)) });
  const both = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles];
  const sam = {
    id: 'u1', displayName: 'Sam', user: { username: 'sam' },
    permissions: mkPerms(both), permissionsIn: () => mkPerms(both),
    roles: { highest: { position: 3 }, cache: new Set() },
  };
  const rae = {
    id: 'u2', displayName: 'Rae', user: { username: 'rae' },
    permissions: mkPerms([]),
    roles: {
      highest: { position: 1 },
      cache: new Set(),
      add: async (role) => { rae.roles.cache.add(role.id); },
      remove: async (role) => { rae.roles.cache.delete(role.id); },
    },
  };
  const me = { id: 'bot', permissions: mkPerms(both), roles: { highest: { position: 5 } } };

  const withHelpers = (map) => {
    map.find = (f) => [...map.values()].find(f) ?? null;
    map.some = (f) => [...map.values()].some(f);
    return map;
  };
  const roleCache = withHelpers(new Map());
  const createdRoles = [];
  const deletedRoles = [];
  const mkRole = (id, name, position, bits = 0n) => ({
    id, name, position,
    permissions: { bitfield: bits },
    setPermissions: async function (b) { this.permissions.bitfield = b; },
    delete: async () => { deletedRoles.push(id); roleCache.delete(id); },
  });
  const everyone = { id: 'e1', name: '@everyone' };
  const highRole = mkRole('r-high', 'Boss', 6); // above the bot
  const midRole = mkRole('r-mid', 'Mod', 4); // below bot, above Sam
  roleCache.set(highRole.id, highRole);
  roleCache.set(midRole.id, midRole);

  const channelCache = withHelpers(new Map());
  const overwriteEdits = [];
  const current = {
    id: `c-cur-${gid}`, name: 'general', type: ChannelType.GuildText, guildId: gid,
    isThread: () => false, isTextBased: () => true,
    permissionsFor: () => mkPerms(both),
    permissionOverwrites: {
      cache: new Map(),
      edit: async (target, options, opts) => { overwriteEdits.push({ targetId: target.id, options, reason: opts?.reason }); },
    },
  };
  channelCache.set(current.id, current);
  const guild = {
    id: gid, ownerId: 'o',
    members: {
      me,
      fetch: async (id) => (id === 'u1' ? sam : id === 'u2' ? rae : null),
      cache: { find: (f) => [sam, rae].find(f) ?? null },
    },
    channels: { cache: channelCache, fetch: async (id) => channelCache.get(id) ?? null },
    roles: {
      everyone,
      cache: roleCache,
      fetch: async (id) => roleCache.get(id) ?? null,
      create: async (opts) => {
        createdRoles.push(opts);
        const r = mkRole(`r-new-${createdRoles.length}`, opts.name, 2);
        roleCache.set(r.id, r);
        return r;
      },
    },
  };
  current.guild = guild;
  const prep = (data) => prepareStaff(parseStaff(data), { channel: current, requester: sam });

  const oldLimit = config.staffOpsPerMinute;
  config.staffOpsPerMinute = 200;
  try {
    // create with color normalization
    let r = await prep({ op: 'create_role', name: 'VIP', color: 'FF8800' });
    assert.ok(r.ok, r.reason);
    assert.equal(r.plan.color, '#ff8800');
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.equal(createdRoles[0].color, 0xff8800);
    const vip = [...roleCache.values()].find((x) => x.name === 'VIP');

    // duplicate + bad color blocked
    assert.match((await prep({ op: 'create_role', name: 'vip' })).reason, /already exists/);
    assert.match((await prep({ op: 'create_role', name: 'X', color: 'red' })).reason, /hex code/);

    // role perms: whitelist rejects power perms by name; overlap rejected
    assert.match((await prep({ op: 'role_perms', role: 'VIP', allow: ['Administrator'] })).reason, /never grant.*Administrator/);
    assert.match((await prep({ op: 'role_perms', role: 'VIP', allow: ['Speak'], deny: ['Speak'] })).reason, /both allowed and denied/);
    r = await prep({ op: 'role_perms', role: 'VIP', allow: ['sendmessages', 'EmbedLinks'], deny: ['AddReactions'] });
    assert.ok(r.ok, r.reason);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.equal(vip.permissions.bitfield, PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks);

    // give/remove with already-has guards
    r = await prep({ op: 'give_role', user: 'Rae', role: 'VIP' });
    assert.ok(r.ok, r.reason);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.ok(rae.roles.cache.has(vip.id));
    assert.match((await prep({ op: 'give_role', user: 'Rae', role: 'VIP' })).reason, /already has/);
    r = await prep({ op: 'remove_role', user: 'Rae', role: 'VIP' });
    assert.ok(r.ok, r.reason);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.ok(!rae.roles.cache.has(vip.id));
    assert.match((await prep({ op: 'remove_role', user: 'Rae', role: 'VIP' })).reason, /does not have/);

    // hierarchy: above bot, and above requester but below bot
    assert.match((await prep({ op: 'give_role', user: 'Rae', role: 'Boss' })).reason, /not below my top role/);
    assert.match((await prep({ op: 'give_role', user: 'Rae', role: 'Mod' })).reason, /not below Sam's top role/);
    assert.match((await prep({ op: 'role_perms', role: 'Boss', allow: ['Speak'] })).reason, /not below my top role/);

    // channel perms: @everyone loses ViewChannel (private-channel recipe)
    r = await prep({ op: 'channel_perms', channel: 'general', target: '@everyone', deny: ['ViewChannel'] });
    assert.ok(r.ok, r.reason);
    assert.equal(r.plan.permTargetKind, 'everyone');
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.deepEqual(overwriteEdits.at(-1).options, { ViewChannel: false });
    assert.equal(overwriteEdits.at(-1).targetId, 'e1');
    // member target resolves too
    r = await prep({ op: 'channel_perms', channel: 'general', target: 'Rae', allow: ['ViewChannel'] });
    assert.ok(r.ok, r.reason);
    assert.equal(r.plan.permTargetKind, 'member');
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.equal(overwriteEdits.at(-1).targetId, 'u2');
    // role target above the bot is refused
    assert.match((await prep({ op: 'channel_perms', channel: 'general', target: 'Boss', allow: ['ViewChannel'] })).reason, /above my top role/);

    // delete: only bot-made roles
    assert.match((await prep({ op: 'delete_role', role: 'Mod' })).reason, /not mine/);
    r = await prep({ op: 'delete_role', role: 'VIP' });
    assert.ok(r.ok, r.reason);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.ok(deletedRoles.includes(vip.id));

    // role cap
    for (let i = 0; i < MAX_BOT_ROLES; i++) {
      const p = await prep({ op: 'create_role', name: `fill-r-${i}` });
      assert.ok(p.ok, p.reason);
      assert.ok((await executeStaff(p.plan, guild)).ok);
    }
    assert.match((await prep({ op: 'create_role', name: 'one-too-many' })).reason, /my limit/);
  } finally {
    config.staffOpsPerMinute = oldLimit;
  }
});

test('auto-mod scans scams, invites and mention spam conservatively', async () => {
  const { scanMessage } = await import('../src/automod.js');
  const { PermissionFlagsBits } = await import('discord.js');
  const mk = (content, { staff = false, everyone = false, mentions = 0, bot = false } = {}) => ({
    guild: { id: 'g' },
    system: false,
    content,
    author: { bot, username: 'sam' },
    member: { permissions: { has: (b) => staff && (b === PermissionFlagsBits.ManageMessages || b === PermissionFlagsBits.ManageGuild) } },
    mentions: { users: { size: mentions }, everyone },
  });
  assert.equal(scanMessage(mk('mr beast crypto giveaway https://x.io/claim'))?.kind, 'scam');
  assert.equal(scanMessage(mk('lol mr beast would never do a crypto giveaway')), null); // joke without a link
  assert.equal(scanMessage(mk('check https://discord-nitro.com/free'))?.kind, 'scam'); // lookalike host
  assert.equal(scanMessage(mk('claim your free nitro https://x.io/n'))?.kind, 'scam');
  assert.equal(scanMessage(mk('join my server discord.gg/abc'))?.kind, 'invite');
  assert.equal(scanMessage(mk('join my server discord.gg/abc', { staff: true })), null); // staff may post invites
  assert.equal(scanMessage(mk('hey', { mentions: 6 }))?.kind, 'mentions');
  assert.equal(scanMessage(mk('hey', { mentions: 3 })), null);
  assert.equal(scanMessage(mk('@everyone look', { everyone: true }))?.kind, 'mentions');
  assert.equal(scanMessage(mk('hi')), null);
  assert.equal(scanMessage(mk('free nitro https://x.io', { bot: true })), null); // bots exempt
  assert.equal(scanMessage({ ...mk('free nitro https://x.io'), guild: null }), null); // DMs exempt
});

test('auto-mod deletes scams, timeouts, escalates and respects hierarchy', async () => {
  const { handleAutomod } = await import('../src/automod.js');
  const { PermissionFlagsBits } = await import('discord.js');
  const { deleteSetting } = await import('../src/db.js');
  const gid = `test-am-${process.pid}-${Date.now()}`;
  const mkPerms = (bits) => ({ has: (b) => bits.includes(b) });
  const deleted = [];
  const timeouts = [];
  const sent = [];
  const me = { id: 'bot', roles: { highest: { position: 5 } } };
  const mkMember = (id, position, admin = false) => ({
    id,
    displayName: id,
    permissions: mkPerms(admin ? [PermissionFlagsBits.Administrator] : []),
    roles: { highest: { position } },
    timeout: async (ms) => { timeouts.push([id, ms]); },
  });
  const victim = mkMember('u1', 1);
  const admin = mkMember('u2', 9, true);
  const guild = { id: gid, ownerId: 'o', members: { me, fetch: async (id) => (id === 'u1' ? victim : admin) } };
  const mkMsg = (member) => ({
    guild,
    system: false,
    author: { id: member.id, bot: false, username: member.id },
    member,
    content: 'mr beast crypto giveaway https://scam.io/x',
    mentions: { users: { size: 0 }, everyone: false },
    channel: {
      id: `c-${gid}`,
      permissionsFor: () => mkPerms([PermissionFlagsBits.ManageMessages]),
      send: async (o) => { sent.push(o.content); },
    },
    delete: async () => { deleted.push(member.id); },
  });
  const oldCap = config.automodActionsPerMinute;
  config.automodActionsPerMinute = 50;
  try {
    assert.equal(await handleAutomod(mkMsg(victim)), true);
    assert.deepEqual(deleted, ['u1']);
    assert.deepEqual(timeouts, [['u1', 10 * 60_000]]);
    assert.match(sent[0], /scam link/);
    await handleAutomod(mkMsg(victim)); // second strike inside the hour
    assert.equal(timeouts.at(-1)[1], 60 * 60_000);
    await handleAutomod(mkMsg(admin)); // hacked admin: deleted, never timed out
    assert.deepEqual(deleted, ['u1', 'u1', 'u2']);
    assert.equal(timeouts.length, 2);
    assert.match(sent.at(-1), /above my role/);
    const clean = mkMsg(victim);
    clean.content = 'hello friends';
    assert.equal(await handleAutomod(clean), false);
  } finally {
    config.automodActionsPerMinute = oldCap;
    deleteSetting(`automodStrike:${gid}:u1`);
  }
});

test('delete_message and purge: mirror, resolve by link/[n], execute', async () => {
  const { prepareStaff, executeStaff, parseStaff, MAX_PURGE } = await import('../src/staff.js');
  const { PermissionFlagsBits } = await import('discord.js');
  const gid = `test-p4-${process.pid}-${Date.now()}`;
  const mkPerms = (bits) => ({ has: (b) => bits.includes(b) });
  const mm = [PermissionFlagsBits.ManageMessages];
  const sam = {
    id: 'u1', displayName: 'Sam', user: { username: 'sam' },
    permissions: mkPerms(mm), permissionsIn: () => mkPerms(mm),
    roles: { highest: { position: 3 } },
  };
  const rae = { id: 'u2', displayName: 'Rae', user: { username: 'rae' }, permissions: mkPerms([]), roles: { highest: { position: 1 }, cache: new Set() } };
  const me = { id: 'bot', permissions: mkPerms(mm), roles: { highest: { position: 5 } } };
  const deleted = [];
  const store = new Map();
  const mkMsg = (id, authorId, ts) => ({
    id,
    channelId: 'c1',
    author: { id: authorId, username: authorId === 'u2' ? 'rae' : 'sam' },
    createdTimestamp: ts,
    delete: async () => { deleted.push(id); store.delete(id); },
  });
  store.set('101', mkMsg('101', 'u2', 100));
  store.set('102', mkMsg('102', 'u2', 200));
  store.set('103', mkMsg('103', 'u1', 300));
  store.set('104', mkMsg('104', 'u2', 400));
  const channel = {
    id: 'c1', name: 'general',
    messages: { fetch: async (q) => (typeof q === 'string' ? store.get(q) ?? null : store) },
    permissionsFor: () => mkPerms(mm),
  };
  const guild = {
    id: gid, ownerId: 'o',
    members: { me, fetch: async (id) => (id === 'u1' ? sam : id === 'u2' ? rae : null), cache: { find: (f) => [sam, rae].find(f) ?? null } },
    channels: { cache: new Map([['c1', channel]]) },
    roles: { everyone: { id: 'e1' }, cache: new Map() },
  };
  channel.guild = guild;
  const history = [{ id: '101', authorId: 'u2' }, { id: '103', authorId: 'u1' }, { id: '104', authorId: 'u2' }];
  const prep = (data) => prepareStaff(parseStaff(data), { channel, requester: sam, history });
  const oldLimit = config.staffOpsPerMinute;
  config.staffOpsPerMinute = 100;
  try {
    let r = await prep({ op: 'delete_message', target: 3 }); // [3] of the chat lines
    assert.ok(r.ok, r.reason);
    assert.equal(r.plan.messageId, '104');
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.ok(deleted.includes('104'));
    r = await prep({ op: 'delete_message', message: 'https://discord.com/channels/123456789012345678/123456789012345679/101' });
    assert.ok(r.ok, r.reason);
    assert.ok((await executeStaff(r.plan, guild)).ok);
    assert.ok(deleted.includes('101'));
    assert.match((await prep({ op: 'delete_message', message: '999999999999999999' })).reason, /not in this channel|already gone/);
    const nobody = { ...sam, id: 'u3', displayName: 'Nope', permissions: mkPerms([]), permissionsIn: () => mkPerms([]) };
    const denied = await prepareStaff(parseStaff({ op: 'purge', user: 'Rae' }), { channel, requester: nobody, history });
    assert.match(denied.reason, /Manage Messages/);
    r = await prep({ op: 'purge', user: 'Rae', count: 99 });
    assert.ok(r.ok, r.reason);
    assert.equal(r.plan.count, MAX_PURGE);
    assert.deepEqual(r.plan.messageIds, ['102']); // only Rae's surviving message
    const ex = await executeStaff(r.plan, guild);
    assert.ok(ex.ok, ex.reason);
    assert.match(ex.summary, /Purged 1 message from Rae/);
    assert.match((await prep({ op: 'purge', user: 'Rae' })).reason, /no recent messages/);
  } finally {
    config.staffOpsPerMinute = oldLimit;
  }
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

test('parseReply delivers replies despite trailing prose or cut-off generation', () => {
  // Complete JSON followed by prose with a stray brace: still delivered.
  assert.deepEqual(parseReply('{"action":"reply","messages":["hey"]} hope that helps }'), {
    action: 'reply',
    messages: ['hey'],
    notes: none,
    rephrase: null,
  });
  // A second object cut off by max_tokens after a complete one: the complete one wins.
  assert.deepEqual(parseReply('{"action":"reply","messages":["first"]}\n{"action":"reply","messages":["second, idk i do'), {
    action: 'reply',
    messages: ['first'],
    notes: none,
    rephrase: null,
  });
  // A single reply cut off mid-string: the surviving text is delivered.
  assert.deepEqual(parseReply('{"action":"reply","messages":["second, idk i do'), {
    action: 'reply',
    messages: ['second, idk i do'],
    notes: none,
    rephrase: null,
  });
  // Complete strings plus a cut-off last one.
  assert.deepEqual(parseReply('{"action":"reply","messages":["okay first of all, chill","and second'), {
    action: 'reply',
    messages: ['okay first of all, chill', 'and second'],
    notes: none,
    rephrase: null,
  });
  // Escapes survive the salvage.
  assert.deepEqual(parseReply('{"action":"reply","messages":["he said \\"lol\\" ok'), {
    action: 'reply',
    messages: ['he said "lol" ok'],
    notes: none,
    rephrase: null,
  });
  // Truncated non-reply actions stay silent (no half staff confirmations).
  assert.deepEqual(parseReply('{"action":"staff","op":"timeout","user":"Sam","minutes":'), { action: 'ignore', notes: none });
});

test('fetchHistory shows GIF links as text and keeps them out of vision', async () => {
  const { fetchHistory } = await import('../src/brain.js');
  const mkMsg = (id, attachments) => ({
    id,
    system: false,
    createdTimestamp: 1000 + Number(id),
    cleanContent: 'look',
    author: { id: 'u1', username: 'sam', displayName: 'Sam', bot: false },
    member: null,
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    reference: null,
  });
  const msgs = new Map([
    ['1', mkMsg('1', [{ url: 'https://cdn/x.gif', contentType: 'image/gif' }])],
    ['2', mkMsg('2', [{ url: 'https://cdn/y.png', contentType: 'image/png' }])],
  ]);
  const channel = { messages: { fetch: async () => msgs } };
  const { history } = await fetchHistory(channel, 'bot');
  assert.match(history[0].content, /\[sent a GIF: https:\/\/cdn\/x\.gif\]/);
  assert.deepEqual(history[0].images, []); // never sent to vision providers
  assert.ok(!history[0].content.includes('file(s)')); // not double-counted as a generic file
  assert.deepEqual(history[1].images, ['https://cdn/y.png']); // static images still go to vision
});

test('images are seen once: afterwards a stored description replaces the pixels', async () => {
  const { fetchHistory } = await import('../src/brain.js');
  const { setSetting, deleteSetting } = await import('../src/db.js');
  const cid = `test-img-${process.pid}-${Date.now()}`;
  const mkMsg = (id, ts, url) => ({
    id,
    system: false,
    createdTimestamp: ts,
    cleanContent: 'look',
    author: { id: 'u1', username: 'sam', displayName: 'Sam', bot: false },
    member: null,
    attachments: new Map([['0', { url, contentType: 'image/png' }]]),
    reference: null,
  });
  const msgs = new Map([
    ['1', mkMsg('1', 1500, 'https://cdn/old.png')],
    ['2', mkMsg('2', 2500, 'https://cdn/new.png')],
  ]);
  const channel = { id: cid, messages: { fetch: async () => msgs } };
  setSetting(`imgSeen:${cid}`, '2000');
  setSetting(`imgDesc:1:0`, 'a cat asleep on a sofa');
  try {
    const { history } = await fetchHistory(channel, 'bot');
    assert.match(history[0].content, /\[image: a cat asleep on a sofa\]/);
    assert.deepEqual(history[0].images, []); // seen: no pixels again
    assert.deepEqual(history[0].imageUrls, ['https://cdn/old.png']); // still re-readable via lookup
    assert.match(history[1].content, /\[sent an image\]/);
    assert.deepEqual(history[1].images, ['https://cdn/new.png']); // unseen: pixels this run
  } finally {
    deleteSetting(`imgSeen:${cid}`);
    deleteSetting(`imgDesc:1:0`);
  }
});

test('describeImageUrls returns one line per image and survives vision failures', async () => {
  const { describeImageUrls } = await import('../src/ai.js');
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'a cat on a sofa\na dog mid-jump' } }] }),
  });
  try {
    assert.deepEqual(await describeImageUrls(['https://cdn/a.png', 'https://cdn/b.png']), ['a cat on a sofa', 'a dog mid-jump']);
    assert.deepEqual(await describeImageUrls([]), []);
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'no vision here' });
    assert.deepEqual(await describeImageUrls(['https://cdn/a.png']), []); // silent fallback
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('llm falls through a rate-limited provider and skips it during cooldown', async () => {
  const { chat } = await import('../src/llm.js');
  const oldFetch = globalThis.fetch;
  const oldProviders = config.providers;
  const tag = `t${process.pid}`;
  const calls = [];
  config.providers = [
    { label: `${tag}-dead`, apiBase: 'https://dead/v1', apiKey: 'k', models: ['m1', 'm2'] },
    { label: `${tag}-live`, apiBase: 'https://live/v1', apiKey: 'k', models: ['m3'] },
  ];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.startsWith('https://dead')) {
      return { ok: false, status: 429, text: async () => '{"error":{"code":"rate_limit_exceeded","message":"today free-model token quota"}}' };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'alive' } }] }) };
  };
  try {
    assert.equal(await chat({ messages: [] }), 'alive');
    assert.equal(calls.filter((u) => u.startsWith('https://dead')).length, 2); // both tries of m1, then straight to next provider
    assert.equal(calls.filter((u) => u.startsWith('https://live')).length, 1);
    calls.length = 0;
    assert.equal(await chat({ messages: [] }), 'alive');
    assert.deepEqual(calls, ['https://live/v1/chat/completions']); // dead provider skipped while cooling down
  } finally {
    globalThis.fetch = oldFetch;
    config.providers = oldProviders;
  }
});

test('parseReply keeps notes, even when ignoring', () => {
  const r = parseReply('{"action":"ignore","notes":{"add":["Sam likes cats"],"remove":["#2","x"]}}');
  assert.deepEqual(r, { action: 'ignore', notes: { add: ['Sam likes cats'], remove: [2] } });
});

test('voice action needs TTS enabled, otherwise it becomes a text reply', () => {
  const raw = '{"action":"voice","text":"hello there"}';
  const wasEnabled = config.ttsEnabled;
  config.ttsEnabled = false;
  try {
    assert.deepEqual(parseReply(raw), { action: 'reply', messages: ['hello there'], notes: none, rephrase: null });
    config.ttsEnabled = true;
    assert.deepEqual(parseReply(raw), { action: 'voice', text: 'hello there', notes: none });
    assert.equal(parseReply(`{"action":"voice","text":"${'a'.repeat(999)}"}`).text.length, config.ttsMaxChars);
  } finally {
    config.ttsEnabled = wasEnabled;
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

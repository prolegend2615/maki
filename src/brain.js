import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import {
  addAnnouncement,
  applyNotes,
  applyUserFacts,
  bumpUser,
  deleteSetting,
  getSetting,
  getWatchList,
  getUserStats,
  listAnnouncements,
  listNotes,
  listSettings,
  listUserFacts,
  setSetting,
} from './db.js';
import { describeMood, describeUser, extractMemories, generateReply, getPersona, updateServerNotebook, updateSummary } from './ai.js';
import { searchGif } from './gifs.js';
import { selfCorrect, sendHuman, sendVoiceFile, sleep } from './humanizer.js';
import { synthesize } from './tts.js';

/**
 * channelId -> {
 *   timer, controller, mustAnswer, replyTo,
 *   activeUntil: whole channel is "live" until then (bot may chime in),
 *   engaged: Map<userId, expiry> users the bot is talking with; their follow-ups count as addressed
 * }
 */
const channels = new Map();

const rand = (min, max) => min + Math.random() * (max - min);
const chance = (p) => Math.random() < p;
const stateFor = (id) => {
  if (!channels.has(id)) {
    channels.set(id, { timer: null, controller: null, mustAnswer: false, replyTo: null, activeUntil: 0, engaged: new Map() });
  }
  return channels.get(id);
};

export const isEnabled = (channelId) => getSetting(`enabled:${channelId}`) !== 'off';

// --- Server announcements -----------------------------------------------------
// Native announcement channels and channels named announce*/news are always watched;
// /announce-watch can add any other channel. Announcements are recorded, occasionally
// reacted to, and (opt-in) commented on through the proactive limits.

const ANNOUNCE_NAME = /announce|news/i;
const fmtAnnouncement = (a) =>
  `- [${new Date(a.ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}] ${a.author}: ${a.text}`;

const isAnnouncementChannel = (channel) =>
  channel.type === ChannelType.GuildAnnouncement || ANNOUNCE_NAME.test(channel.name) || getWatchList(channel.guild.id).includes(channel.id);

function handleAnnouncement(message) {
  const text = (message.cleanContent || message.embeds[0]?.description || '').trim();
  if (!text) return; // image-only announcement: nothing to remember
  const added = addAnnouncement({
    guildId: message.guild.id,
    messageId: message.id,
    author: message.member?.displayName ?? message.author.displayName,
    text,
    ts: message.createdTimestamp,
  });
  if (!added) return; // already recorded
  console.log(`[announcements] ${message.guild.id}: recorded ${message.id}`);
  if (chance(config.announceReactChance)) void reactAnnouncement(message);
  if (config.announceCommentChance > 0 && chance(config.announceCommentChance)) {
    scheduleAnnouncementComment(message, text);
  }
}

async function reactAnnouncement(message) {
  try {
    await sleep(rand(2000, 6000));
    if (message.channel.permissionsFor(message.client.user)?.has(PermissionFlagsBits.AddReactions)) {
      await message.react('👀').catch(() => {});
    }
  } catch {
    // message deleted or bot left: nothing to do
  }
}

/** Opt-in: drops a "comment on the new announcement" nudge into her most recently active channel of that guild. */
function scheduleAnnouncementComment(message, text) {
  if (!clientRef) return;
  const topic = `the new server announcement: ${text.slice(0, 100)}`;
  const candidates = [...channels.entries()]
    .filter(([cid, st]) => clientRef.channels.cache.get(cid)?.guild?.id === message.guild.id && Date.now() - (st.activeUntil || 0) < 3 * 86_400_000)
    .sort((a, b) => b[1].activeUntil - a[1].activeUntil);
  const [targetId] = candidates[0] ?? [];
  if (!targetId) return;
  const at = Date.now() + rand(120_000, 600_000);
  setSetting(pendingKey(targetId), JSON.stringify({ topic, at }));
  armFollowUp(targetId, at, topic);
}

function isAddressedToBot(message, botId) {
  if (message.channel.type === ChannelType.DM) return true;
  if (message.mentions.has(botId, { ignoreEveryone: true, ignoreRoles: true })) return true;
  return message.mentions.repliedUser?.id === botId;
}

/** Called for every incoming message. Decides whether to engage, then debounces. */
export function onMessage(message) {
  const { client } = message;
  if (message.system || !message.channel.isTextBased()) return;

  // Announcement channels are read and remembered even when the channel toggle is off.
  if (message.guild && message.author.id !== client.user.id && isAnnouncementChannel(message.channel)) {
    handleAnnouncement(message);
  }

  if (message.author.bot || !isEnabled(message.channelId)) return;

  if (message.guild) {
    const perms = message.channel.permissionsFor(client.user);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return;
  }

  const state = stateFor(message.channelId);
  const now = Date.now();
  const pinged = isAddressedToBot(message, client.user.id);
  // Someone who pinged the bot recently can keep talking without pinging again.
  const followUp = (state.engaged.get(message.author.id) ?? 0) > now;
  const inWindow = now < state.activeUntil;
  if (!pinged && !followUp && !inWindow) return;

  if (pinged || followUp) {
    state.mustAnswer = true;
    state.replyTo = message;
    state.engaged.set(message.author.id, now + config.activeWindowMs);
    state.activeUntil = now + config.activeWindowMs;
    const name = message.member?.displayName ?? message.author.displayName;
    bumpUser(notebookScope(message.channel), message.author.id, name);
  }

  // A new message arrived: stop whatever we were typing and rethink with the full picture.
  clearTimeout(state.timer);
  state.controller?.abort();
  state.timer = setTimeout(() => void run(message.channel, state), rand(config.debounceMinMs, config.debounceMaxMs));
}

/**
 * Last N messages of the channel from EVERY user, so the whole server conversation is visible.
 * Also returns the distinct people who spoke (for the "who is here" section of the prompt).
 * `after` fetches messages newer than that message id instead (used by the memory passes).
 */
async function fetchHistory(channel, botId, { limit = config.historyLimit, after } = {}) {
  const fetched = await channel.messages.fetch({ limit, ...(after ? { after } : {}) });
  const msgs = [...fetched.values()]
    .filter((m) => !m.system)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const nameOf = (m) => m.member?.displayName ?? m.author.displayName;
  // Two different people sharing a display name would be ambiguous: add @username for those.
  const owners = new Map();
  for (const m of msgs) {
    const name = nameOf(m);
    if (!owners.has(name)) owners.set(name, new Set());
    owners.get(name).add(m.author.id);
  }
  const label = (m) =>
    m.author.id === botId ? 'you' : owners.get(nameOf(m)).size > 1 ? `${nameOf(m)} (@${m.author.username})` : nameOf(m);
  const byId = new Map(msgs.map((m) => [m.id, m]));

  const people = new Map();
  const history = msgs
    .map((m) => {
      const files = [...m.attachments.values()];
      const images = files.filter((a) => /^image\/(png|jpeg|gif|webp)/.test(a.contentType ?? ''));
      // The bot's own voice clips carry the spoken text as alt text; show that instead of "[sent a file]".
      const voiceClip = m.author.id === botId ? files.find((a) => a.contentType?.startsWith('audio/') && a.description) : null;
      let content = voiceClip ? voiceClip.description : m.cleanContent;
      if (images.length) content += ` [sent ${images.length} image(s)]`;
      if (!voiceClip && files.length > images.length) content += ` [sent ${files.length - images.length} file(s)]`;
      if (m.author.id !== botId) {
        people.set(m.author.id, { id: m.author.id, name: nameOf(m), username: m.author.username, bot: m.author.bot });
      }
      const parent = m.reference?.messageId ? byId.get(m.reference.messageId) : null;
      return {
        id: m.id,
        authorId: m.author.id,
        author: label(m),
        replyTo: parent ? label(parent) : null,
        content: content.trim(),
        ts: m.createdTimestamp,
        time: new Date(m.createdTimestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        voice: Boolean(voiceClip),
        images: m.author.id === botId ? [] : images.map((a) => a.url),
      };
    })
    .filter((m) => m.content);

  // Only the newest few images are actually sent to the model (cost); older ones stay as text.
  let budget = config.maxImages;
  for (let i = history.length - 1; i >= 0; i--) {
    history[i].images = history[i].images.slice(0, budget);
    budget -= history[i].images.length;
  }
  return { history, people: [...people.values()] };
}

/** Where the bot is and who it is talking to (with how well it knows them); goes into the system prompt. */
function describePlace(channel, profiles) {
  const list = profiles
    .slice(0, 15)
    .map((p) => {
      const name = `- ${p.name}${p.name === p.username ? '' : ` (@${p.username})`}${p.bot ? ' [bot]' : ''}`;
      const facts = p.facts.length ? ` You remember about them: ${p.facts.slice(-4).join('; ')}` : '';
      return `${name}: ${p.status}.${facts}`;
    })
    .join('\n');
  if (!channel.guild) {
    const p = profiles[0];
    const who = p ? `${p.name}${p.name === p.username ? '' : ` (@${p.username})`}` : 'a user';
    return `Private DM with ${who}${p ? ` — ${p.status}` : ''}.`;
  }
  const topic = channel.topic ? `\nChannel topic: ${channel.topic.slice(0, 200)}` : '';
  return (
    `Server: ${channel.guild.name} (${channel.guild.memberCount} members)\n` +
    `Channel: #${channel.name}${topic}\n` +
    `People in the recent chat:\n${list || '- (nobody yet)'}`
  );
}

/** Speaks `text` with Piper and posts the clip. Returns false (nothing sent) when the caller should fall back to text. */
async function sendVoice(channel, text, { replyTo, signal }) {
  if (!config.ttsEnabled) return false;
  const me = channel.client.user;
  if (channel.guild && !channel.permissionsFor(me)?.has(PermissionFlagsBits.AttachFiles)) return false;

  const typing = setInterval(() => void channel.sendTyping().catch(() => {}), 8000);
  try {
    await channel.sendTyping().catch(() => {});
    const wav = await synthesize(text, signal);
    signal.throwIfAborted();
    await sendVoiceFile(channel, wav, text, { replyTo });
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    console.error('[tts]', error.message);
    return false;
  } finally {
    clearInterval(typing);
  }
}

// Servers share one notebook; each DM gets its own.
const notebookScope = (channel) => (channel.guild ? `guild:${channel.guild.id}` : `dm:${channel.id}`);

async function run(channel, state, nudge = null) {
  const controller = new AbortController();
  state.controller = controller;
  state.timer = null;
  const { signal } = controller;
  // Not cleared yet: if a newer message aborts this run, the next run must still know it was addressed.
  const { mustAnswer, replyTo } = state;
  const settle = () => {
    if (signal.aborted) return;
    state.mustAnswer = false;
    state.replyTo = null;
  };

  try {
    // Chatting without being addressed: sometimes just don't care (a follow-up nudge always gets a real answer).
    if (!mustAnswer && !nudge && Math.random() < config.ignoreChance) return settle();

    const botId = channel.client.user.id;
    const scope = notebookScope(channel);
    const { history, people } = await fetchHistory(channel, botId);
    if (!history.length) return settle();

    const botName = channel.guild?.members.me?.displayName ?? channel.client.user.username;
    const now = new Date().toLocaleString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
    let storedMood = null;
    try {
      storedMood = JSON.parse(getSetting('mood') || 'null');
    } catch {
      // corrupt row: start from the default mood
    }
    const profiles = people.map((p) => ({
      ...p,
      status: describeUser(getUserStats(scope, p.id)),
      facts: listUserFacts(scope, p.id).map((f) => f.text),
    }));
    const base = {
      history,
      botId,
      botName,
      persona: getPersona(),
      mustAnswer,
      place: describePlace(channel, profiles),
      now,
      nudge,
      mood: describeMood(storedMood),
      signal,
    };
    // Lean prompt: the big memory blocks (server notebook, diary, notes, announcements)
    // are read on demand via lookup actions. Two lookups max, then she must answer or ignore.
    let result = await generateReply(base);
    for (let reads = 0; result.action === 'lookup' && reads < 2 && !signal.aborted; reads++) {
      result = await generateReply({ ...base, lookupContext: await performLookup(channel, scope, profiles, result) });
    }
    if (result.action === 'lookup') return settle(); // the model kept asking instead of answering

    // The notebook is saved even when the bot stays silent.
    applyNotes(scope, result.notes);
    settle();
    scheduleMemory(channel, botId);
    if (result.action === 'ignore') {
      // Sometimes "seen" is the whole answer: a subtle reaction instead of silence.
      if (!signal.aborted && chance(config.readChance)) void readWithoutReply(channel, history, botId, signal);
      return;
    }

    // Quote-reply only when other messages landed after the one we answer (never for a proactive nudge).
    const quote = !nudge && replyTo && history.at(-1)?.id !== replyTo.id ? replyTo : null;

    if (result.action === 'react') {
      if (channel.guild && !channel.permissionsFor(botId)?.has(PermissionFlagsBits.AddReactions)) return;
      await sleep(rand(600, 2500), signal); // read at human speed, then react
      const msg = await channel.messages.fetch(result.messageId).catch(() => null);
      if (msg) await msg.react(result.emoji).catch(() => {});
      if (nudge) recordProactive(channel.id);
      state.activeUntil = Date.now() + config.activeWindowMs;
      return;
    }

    if (result.action === 'voice') {
      // No text goes to Discord for a voice reply, unless voice fails: then say it as text instead.
      if (!(await sendVoice(channel, result.text, { replyTo: quote, signal }))) {
        await sendHuman(channel, result.text.slice(0, 2000), { replyTo: quote, signal });
      }
      if (nudge) recordProactive(channel.id);
      state.activeUntil = Date.now() + config.activeWindowMs;
      return;
    }

    if (result.action === 'gif') {
      for (const [i, text] of (result.messages ?? []).entries()) {
        if (i > 0) await sleep(rand(400, 1400), signal);
        await sendHuman(channel, text.slice(0, 2000), { replyTo: i === 0 ? quote : null, signal });
      }
      await sleep(rand(1200, 3000), signal);
      const url = await searchGif(result.query, signal);
      if (url) {
        await channel
          .send({ files: [{ attachment: url, name: 'mika.gif', description: result.query.slice(0, 1000) }], allowedMentions: { parse: [] } })
          .catch(() => {});
        if (nudge) recordProactive(channel.id);
        state.activeUntil = Date.now() + config.activeWindowMs;
      }
      return; // no gif found: the optional text above already carried the reply
    }

    const willSelfCorrect = Boolean(result.rephrase) && chance(config.selfCorrectChance);
    for (const [i, text] of result.messages.entries()) {
      if (i > 0) await sleep(rand(400, 1400), signal);
      if (i === 0 && willSelfCorrect) {
        // Send it, then reconsider the wording and edit it a few seconds later.
        const sent = await sendHuman(channel, text.slice(0, 2000), { replyTo: quote, signal, noTypo: true });
        void selfCorrect(sent, result.rephrase);
      } else {
        await sendHuman(channel, text.slice(0, 2000), { replyTo: i === 0 ? quote : null, signal });
      }
    }
    if (nudge) recordProactive(channel.id);
    state.activeUntil = Date.now() + config.activeWindowMs;
  } catch (error) {
    if (signal.aborted) return; // superseded by a newer message
    settle();
    console.error(`[brain] ${channel.id}:`, error.message);
  } finally {
    if (state.controller === controller) state.controller = null;
  }
}

// --- Automatic memory ---------------------------------------------------------
// A quiet-time background pass: rolls older chat into a per-channel summary and
// extracts durable facts (notebook + per-person) from messages not yet processed.

const memoryTimers = new Map(); // channelId -> pending timer
const memoryBusy = new Set();

const fmtLine = (m) => `${m.author} [${m.time}]: ${m.content}`;

/** Reads one slice of private memory or Discord data for a lookup action. Always returns something usable. */
export async function performLookup(channel, scope, profiles, result) {
  try {
    switch (result.what) {
      case 'server': {
        if (!channel.guild) return '(not available: this is a DM, not a server)';
        const nb = JSON.parse(getSetting(`serverNb:${channel.guild.id}`) || 'null');
        return nb?.text || '(the server notebook is still empty)';
      }
      case 'info': {
        if (!channel.guild) return '(not available: this is a DM, not a server)';
        const g = channel.guild;
        const owner = g.members?.cache?.get?.(g.ownerId);
        const lines = [
          `Owner: ${owner?.displayName ?? `user id ${g.ownerId}`}`,
          `Members: ${g.memberCount ?? 'unknown'}`,
          `Boosts: ${g.premiumSubscriptionCount ?? 0} (tier ${g.premiumTier ?? 0})`,
          `Created: ${g.createdTimestamp ? new Date(g.createdTimestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown'}`,
          `Channels: ${g.channels?.cache?.size ?? '?'}`,
          `Roles: ${g.roles?.cache?.size ?? '?'}`,
          `Emojis: ${g.emojis?.cache?.size ?? 0}`,
          `Verification level: ${g.verificationLevel ?? 'unknown'}`,
        ];
        if (g.description) lines.push(`Server description: ${g.description.slice(0, 200)}`);
        if (g.preferredLocale) lines.push(`Main language: ${g.preferredLocale}`);
        return lines.join('\n');
      }
      case 'member': {
        if (!channel.guild) return '(not available: this is a DM, not a server)';
        const name = (result.name || '').replace(/\s*\(@.*\)$/, '').toLowerCase();
        if (!name) return '(say who: {"action":"lookup","what":"member","name":"Sam"})';
        const member = await findMember(channel.guild, name);
        if (!member) return `(no member called "${result.name}" here)`;
        const roles = [...(member.roles?.cache?.values?.() ?? [])]
          .filter((r) => r.name !== '@everyone')
          .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
          .slice(0, 10)
          .map((r) => r.name);
        const perms = (member.permissions?.toArray?.() ?? []).filter((p) => KEY_PERMS.includes(p));
        return (
          `${member.displayName}${member.user?.bot ? ' [bot]' : ''}` +
          `\nRoles: ${roles.length ? roles.join(', ') : 'none'}` +
          `\nKey permissions: ${perms.length ? perms.join(', ') : 'none special'}` +
          (member.joinedTimestamp
            ? `\nJoined: ${new Date(member.joinedTimestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
            : '')
        );
      }
      case 'announcements': {
        if (!channel.guild) return '(not available: this is a DM, not a server)';
        const list = listAnnouncements(channel.guild.id, 5);
        return list.length ? list.map(fmtAnnouncement).join('\n') : '(no announcements recorded yet)';
      }
      case 'diary': {
        const diary = JSON.parse(getSetting(`summary:${channel.id}`) || 'null');
        return diary?.text || '(the diary is still empty)';
      }
      case 'notes': {
        const notes = listNotes(scope);
        return notes.length ? notes.map((n) => `#${n.id}: ${n.text}`).join('\n') : '(your notebook is empty)';
      }
      case 'person': {
        const name = (result.name || '').replace(/\s*\(@.*\)$/, '').toLowerCase();
        if (!name) return '(say who: {"action":"lookup","what":"person","name":"Sam"})';
        const person = profiles.find(
          (p) => !p.bot && (p.name.toLowerCase() === name || p.username?.toLowerCase() === name),
        );
        if (!person) return `(nobody called "${result.name}" in the recent chat)`;
        const facts = listUserFacts(scope, person.id).map((f) => f.text);
        return `${person.name}: ${describeUser(getUserStats(scope, person.id))}${facts.length ? `. You remember: ${facts.join('; ')}` : ''}`;
      }
      default:
        return '(that memory does not exist)';
    }
  } catch (error) {
    console.error('[lookup]', error.message);
    return '(memory is unavailable right now)';
  }
}

/** Permissions worth reporting in a member lookup; the long tail of minor perms stays out. */
const KEY_PERMS = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageMessages',
  'BanMembers',
  'KickMembers',
  'ModerateMembers',
  'MentionEveryone',
  'ManageWebhooks',
];

const matchesName = (member, base) =>
  (member.displayName || '').toLowerCase() === base || (member.user?.username || '').toLowerCase() === base;

/** Finds a guild member by name: cache first, then a server-side search as fallback. */
async function findMember(guild, base) {
  const cache = guild.members?.cache;
  let member = typeof cache?.find === 'function' ? cache.find((m) => matchesName(m, base)) : null;
  if (!member && typeof guild.members?.fetch === 'function') {
    try {
      const fetched = await guild.members.fetch({ query: base, limit: 10 });
      member = [...fetched.values()].find((m) => matchesName(m, base)) ?? null;
    } catch {
      // not found or network issue
    }
  }
  return member ?? null;
}

/** One maintenance run per channel at a time, shortly after the bot last spoke or chose to stay quiet. */
function scheduleMemory(channel, botId) {
  if (!config.autoMemory || memoryTimers.has(channel.id)) return;
  const timer = setTimeout(
    () => {
      memoryTimers.delete(channel.id);
      void maintainMemory(channel, botId);
    },
    rand(25_000, 50_000),
  );
  memoryTimers.set(channel.id, timer);
}

async function maintainMemory(channel, botId) {
  if (memoryBusy.has(channel.id)) return;
  memoryBusy.add(channel.id);
  try {
    const recent = await fetchHistory(channel, botId);
    if (recent.history.length) await refreshSummary(channel, botId, recent.history[0].ts);
    await extractNew(channel, botId);
  } catch (error) {
    console.error(`[memory] ${channel.id}:`, error.message);
  } finally {
    memoryBusy.delete(channel.id);
  }
}

/** Merges messages older than the live window into the channel's rolling diary. */
async function refreshSummary(channel, botId, boundaryTs) {
  const key = `summary:${channel.id}`;
  let state;
  try {
    state = JSON.parse(getSetting(key) || 'null') ?? { text: '', lastId: null };
  } catch {
    state = { text: '', lastId: null };
  }
  const { history } = await fetchHistory(channel, botId, { limit: 100, after: state.lastId || undefined });
  const older = history.filter((m) => m.ts < boundaryTs);
  if (!older.length) return; // nothing has aged out of the live window yet
  const botName = channel.guild?.members.me?.displayName ?? channel.client.user.username;
  const text = await updateSummary({
    botName,
    previous: state.text,
    lines: older.slice(-60).map(fmtLine),
    signal: AbortSignal.timeout(90_000),
  });
  if (text) setSetting(key, JSON.stringify({ text, lastId: older.at(-1).id }));
}

/** Extracts durable facts from messages that came in since the last extraction. */
async function extractNew(channel, botId) {
  const scope = notebookScope(channel);
  const key = `memory:${channel.id}`;
  const { history, people } = await fetchHistory(channel, botId, {
    limit: 100,
    after: getSetting(key) || undefined,
  });
  if (history.length < config.minExtractMessages) return; // not worth a call; watermark stays put

  const factsByUser = {};
  for (const p of people) {
    if (!p.bot) factsByUser[p.name] = listUserFacts(scope, p.id).map((f) => f.text);
  }
  const botName = channel.guild?.members.me?.displayName ?? channel.client.user.username;
  const result = await extractMemories({
    botName,
    lines: history.map(fmtLine),
    notes: listNotes(scope),
    factsByUser,
    signal: AbortSignal.timeout(90_000),
  });
  applyNotes(scope, result.notes);
  for (const [name, facts] of Object.entries(result.facts)) {
    const base = name.replace(/\s*\(@.*\)$/, '').toLowerCase();
    const person = people.find((p) => !p.bot && (p.name.toLowerCase() === base || p.username?.toLowerCase() === base));
    if (person) applyUserFacts(scope, person.id, facts);
  }
  if (result.followUp) scheduleFollowUp(channel.id, result.followUp);
  if (result.mood) applyMood(result.mood);
  setSetting(key, history.at(-1).id);
  // Throttled: the guild's server notebook gets rewritten at most once per SERVER_NOTEBOOK_HOURS.
  if (channel.guild) await maybeUpdateServerNotebook(channel, botName, history.map(fmtLine));
}

/** Rewrites the durable per-guild server notebook (throttled; feeds off chat + announcements). */
async function maybeUpdateServerNotebook(channel, botName, lines) {
  const key = `serverNb:${channel.guild.id}`;
  let nb = null;
  try {
    nb = JSON.parse(getSetting(key) || 'null');
  } catch {
    // corrupt row: start fresh
  }
  if (nb?.updated && Date.now() - nb.updated < config.serverNotebookHours * 3_600_000) return;
  let announcements = '';
  try {
    announcements = listAnnouncements(channel.guild.id, 5).map(fmtAnnouncement).join('\n');
  } catch {
    // none recorded
  }
  const text = await updateServerNotebook({
    botName,
    current: nb?.text || '',
    lines: lines.slice(-60),
    announcements,
    signal: AbortSignal.timeout(90_000),
  });
  if (text) {
    setSetting(key, JSON.stringify({ text, updated: Date.now() }));
    console.log(`[notebook] ${channel.guild.id}: updated (${text.length} chars)`);
  }
}

/** Mood is one global character state: extraction nudges it, prompt time blends it with the hour baseline. */
function applyMood({ energy = 0, irritability = 0 } = {}) {
  let cur = { energy: 0.5, irritability: 0.3 };
  try {
    cur = JSON.parse(getSetting('mood') || 'null') ?? cur;
  } catch {
    // corrupt row: start fresh
  }
  setSetting(
    'mood',
    JSON.stringify({
      energy: Math.min(1, Math.max(0, cur.energy + energy)),
      irritability: Math.min(1, Math.max(0, cur.irritability + irritability)),
      updated: Date.now(),
    }),
  );
}

// --- Read without replying -----------------------------------------------------

/** Reacts 👀 to the newest message instead of answering — the "seen, not replying" human move. */
async function readWithoutReply(channel, history, botId, signal) {
  try {
    const newest = [...history].reverse().find((m) => m.authorId !== botId && Date.now() - m.ts < 15 * 60_000);
    if (!newest) return;
    if (channel.guild && !channel.permissionsFor(channel.client.user)?.has(PermissionFlagsBits.AddReactions)) return;
    await sleep(rand(1500, 5000), signal); // read it at human speed
    const msg = await channel.messages.fetch(newest.id).catch(() => null);
    await msg?.react('👀').catch(() => {});
  } catch (error) {
    if (!signal.aborted) console.error('[read]', error.message);
  }
}

// --- Proactive follow-ups ------------------------------------------------------
// The memory pass may flag an open topic ("exam on monday"); the bot circles back
// hours later. Basic limits: per-channel per-day cap, minimum gap, quiet hours.

let clientRef = null;
const pendingKey = (channelId) => `followUp:${channelId}`;
const proactiveLog = (channelId) => {
  try {
    const list = JSON.parse(getSetting(`proactive:${channelId}`) || '[]');
    return Array.isArray(list) ? list.filter((t) => Number.isFinite(t)) : [];
  } catch {
    return [];
  }
};

/** Rate limit: at most proactivePerDay per rolling 24h, and proactiveMinHours between two. */
export function canProactive(channelId) {
  const now = Date.now();
  const recent = proactiveLog(channelId).filter((t) => now - t < 86_400_000);
  if (recent.length >= config.proactivePerDay) return false;
  return now - Math.max(...recent, 0) >= config.proactiveMinHours * 3_600_000;
}

export function recordProactive(channelId) {
  const now = Date.now();
  const recent = proactiveLog(channelId).filter((t) => now - t < 86_400_000);
  recent.push(now);
  setSetting(`proactive:${channelId}`, JSON.stringify(recent.slice(-10)));
}

const isQuietHour = () => {
  const h = new Date().getHours();
  const { proactiveQuietStart: s, proactiveQuietEnd: e } = config;
  return s > e ? h >= s || h < e : h >= s && h < e;
};

const nextAllowedAt = () => {
  const now = new Date();
  const at = new Date(now);
  at.setHours(config.proactiveQuietEnd, Math.floor(rand(0, 59)), 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
};

/** Stores (and replaces) the channel's single pending follow-up, then arms the timer. */
function scheduleFollowUp(channelId, followUp) {
  const hours = Number.isFinite(followUp.hours) && followUp.hours > 0 ? followUp.hours : rand(3, 8);
  const at = Date.now() + hours * 3_600_000;
  setSetting(pendingKey(channelId), JSON.stringify({ topic: followUp.topic, at }));
  armFollowUp(channelId, at, followUp.topic);
}

function armFollowUp(channelId, at, topic) {
  const timer = setTimeout(() => void fireFollowUp(channelId, topic), Math.max(1000, at - Date.now()));
  timer.unref?.(); // never keep the process alive just for a follow-up
}

async function fireFollowUp(channelId, topic) {
  const pending = JSON.parse(getSetting(pendingKey(channelId)) || 'null');
  if (!pending || pending.topic !== topic) return; // replaced by a newer topic, or already handled
  if (isQuietHour()) {
    if (!pending.deferred) {
      const at = nextAllowedAt(); // postponed once to after the bot "wakes up"
      setSetting(pendingKey(channelId), JSON.stringify({ topic, at, deferred: true }));
      armFollowUp(channelId, at, topic);
      return;
    }
    deleteSetting(pendingKey(channelId));
    return;
  }
  if (!canProactive(channelId)) {
    deleteSetting(pendingKey(channelId));
    return;
  }
  const channel = await clientRef?.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !isEnabled(channelId)) {
    deleteSetting(pendingKey(channelId));
    return;
  }
  if (channel.guild) {
    const perms = channel.permissionsFor(clientRef.user);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      deleteSetting(pendingKey(channelId));
      return;
    }
  }
  const state = stateFor(channelId);
  if (state.controller) {
    deleteSetting(pendingKey(channelId)); // mid-conversation: drop this one, limits will hold the line
    return;
  }
  deleteSetting(pendingKey(channelId));
  void run(channel, state, topic); // the model may still ignore; nothing is recorded unless it speaks
}

/** Re-arms follow-ups that were pending when the bot restarted. Call once on ClientReady. */
export function restoreFollowUps(client) {
  clientRef = client;
  for (const { key, value } of listSettings('followUp:')) {
    try {
      const pending = JSON.parse(value);
      if (pending?.topic && Number.isFinite(pending.at)) {
        armFollowUp(key.slice('followUp:'.length), pending.at, pending.topic);
      }
    } catch {
      // junk row: ignore
    }
  }
}

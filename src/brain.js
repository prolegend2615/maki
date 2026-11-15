import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import { applyNotes, getSetting, listNotes } from './db.js';
import { generateReply, getPersona } from './ai.js';
import { sendHuman, sendVoiceFile, sleep } from './humanizer.js';
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
const stateFor = (id) => {
  if (!channels.has(id)) {
    channels.set(id, { timer: null, controller: null, mustAnswer: false, replyTo: null, activeUntil: 0, engaged: new Map() });
  }
  return channels.get(id);
};

export const isEnabled = (channelId) => getSetting(`enabled:${channelId}`) !== 'off';

function isAddressedToBot(message, botId) {
  if (message.channel.type === ChannelType.DM) return true;
  if (message.mentions.has(botId, { ignoreEveryone: true, ignoreRoles: true })) return true;
  return message.mentions.repliedUser?.id === botId;
}

/** Called for every incoming message. Decides whether to engage, then debounces. */
export function onMessage(message) {
  const { client } = message;
  if (message.author.bot || message.system || !message.channel.isTextBased()) return;
  if (!isEnabled(message.channelId)) return;

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
  }

  // A new message arrived: stop whatever we were typing and rethink with the full picture.
  clearTimeout(state.timer);
  state.controller?.abort();
  state.timer = setTimeout(() => void run(message.channel, state), rand(config.debounceMinMs, config.debounceMaxMs));
}

/**
 * Last N messages of the channel from EVERY user, so the whole server conversation is visible.
 * Also returns the distinct people who spoke (for the "who is here" section of the prompt).
 */
async function fetchHistory(channel, botId) {
  const fetched = await channel.messages.fetch({ limit: config.historyLimit });
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
        people.set(m.author.id, { name: nameOf(m), username: m.author.username, bot: m.author.bot });
      }
      const parent = m.reference?.messageId ? byId.get(m.reference.messageId) : null;
      return {
        id: m.id,
        authorId: m.author.id,
        author: label(m),
        replyTo: parent ? label(parent) : null,
        content: content.trim(),
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

/** Where the bot is and who it is talking to; goes into the system prompt. */
function describePlace(channel, people) {
  const list = people
    .slice(0, 15)
    .map((p) => `- ${p.name}${p.name === p.username ? '' : ` (@${p.username})`}${p.bot ? ' [bot]' : ''}`)
    .join('\n');
  if (!channel.guild) return `Private DM with ${people[0]?.name ?? 'a user'}${people[0] ? ` (@${people[0].username})` : ''}.`;
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

async function run(channel, state) {
  const controller = new AbortController();
  state.controller = controller;
  const { signal } = controller;
  // Not cleared yet: if a newer message aborts this run, the next run must still know it was addressed.
  const { mustAnswer, replyTo } = state;
  const settle = () => {
    if (signal.aborted) return;
    state.mustAnswer = false;
    state.replyTo = null;
  };

  try {
    // Chatting without being addressed: sometimes just don't care.
    if (!mustAnswer && Math.random() < config.ignoreChance) return settle();

    const botId = channel.client.user.id;
    const scope = notebookScope(channel);
    const { history, people } = await fetchHistory(channel, botId);
    if (!history.length) return settle();

    const botName = channel.guild?.members.me?.displayName ?? channel.client.user.username;
    const result = await generateReply({
      history,
      botId,
      botName,
      persona: getPersona(),
      mustAnswer,
      place: describePlace(channel, people),
      notes: listNotes(scope),
      signal,
    });

    // The notebook is saved even when the bot stays silent.
    applyNotes(scope, result.notes);
    settle();
    if (result.action === 'ignore') return; // send nothing at all

    // Quote-reply only when other messages landed after the one we answer.
    const quote = replyTo && history.at(-1)?.id !== replyTo.id ? replyTo : null;

    if (result.action === 'voice') {
      // No text goes to Discord for a voice reply, unless voice fails: then say it as text instead.
      if (!(await sendVoice(channel, result.text, { replyTo: quote, signal }))) {
        await sendHuman(channel, result.text.slice(0, 2000), { replyTo: quote, signal });
      }
      state.activeUntil = Date.now() + config.activeWindowMs;
      return;
    }

    for (const [i, text] of result.messages.entries()) {
      if (i > 0) await sleep(rand(400, 1400), signal);
      await sendHuman(channel, text.slice(0, 2000), { replyTo: i === 0 ? quote : null, signal });
    }
    state.activeUntil = Date.now() + config.activeWindowMs;
  } catch (error) {
    if (signal.aborted) return; // superseded by a newer message
    settle();
    console.error(`[brain] ${channel.id}:`, error.message);
  } finally {
    if (state.controller === controller) state.controller = null;
  }
}

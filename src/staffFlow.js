import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { executeStaff } from './staff.js';
import { sendHuman, sleep } from './humanizer.js';

const COLORS = { pending: 0xfee75c, done: 0x57f287, muted: 0x99aab5, failed: 0xed4245 };
const MAX_EVENTS = 5;

const AUDIT_COLORS = {
  Requested: COLORS.pending,
  Done: COLORS.done,
  Denied: COLORS.muted,
  Expired: COLORS.muted,
  Failed: COLORS.failed,
  Blocked: COLORS.failed,
};

/** Fire-and-forget audit embed to the guild's log channel (setting overrides the env default). */
export function auditStaff(guild, { summary, requester, outcome, detail }) {
  const id = getSetting(`staffLog:${guild.id}`) || config.staffLogChannelId;
  if (!id) return;
  const channel = guild.channels.cache.get(id);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setTitle(`Staff action — ${outcome}`)
    .setDescription(`${summary}${detail ? `\n${detail}` : ''}`)
    .setColor(AUDIT_COLORS[outcome] ?? COLORS.muted)
    .addFields({ name: 'Requested by', value: requester, inline: true })
    .setTimestamp();
  void channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

// pendingId -> { plan, channelId, message, timer }. In-memory: after a restart,
// old buttons answer "expired" instead of executing something nobody re-validated.
const pending = new Map();

const eventsKey = (channelId) => `staffEvents:${channelId}`;

/** Appends one outcome to the channel's ring buffer; the prompt reads it so the AI never misreports. */
export function recordStaffEvent(channelId, text) {
  let list = [];
  try {
    const parsed = JSON.parse(getSetting(eventsKey(channelId)) || '[]');
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    // corrupt row: start fresh
  }
  list.push({ text, ts: Date.now() });
  setSetting(eventsKey(channelId), JSON.stringify(list.slice(-MAX_EVENTS)));
  console.log(`[staff] ${channelId}: ${text}`);
}

/** Prompt block: what is awaiting confirm right now, plus the last few outcomes. Null when nothing happened. */
export function staffEventsLine(channelId) {
  const lines = [];
  for (const p of pending.values()) {
    if (p.channelId === channelId) lines.push(`- ${p.plan.summary} — WAITING for ${p.plan.requesterName} to confirm, not done yet`);
  }
  try {
    const list = JSON.parse(getSetting(eventsKey(channelId)) || '[]');
    for (const e of Array.isArray(list) ? list : []) {
      const mins = Math.max(0, Math.round((Date.now() - e.ts) / 60_000));
      lines.push(`- ${e.text} (${mins < 1 ? 'just now' : `${mins}m ago`})`);
    }
  } catch {
    // corrupt row: show only pending
  }
  return lines.length ? lines.join('\n') : null;
}

const confirmButtons = (id) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`staff:confirm:${id}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`staff:deny:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );

const outcomeEmbed = (plan, status, detail, color) =>
  new EmbedBuilder()
    .setTitle(`Staff action — ${status}`)
    .setDescription(`${plan.summary}\n${detail}`)
    .setColor(color)
    .setFooter({ text: `Requested by ${plan.requesterName}` });

async function expirePending(id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  recordStaffEvent(p.channelId, `${p.plan.summary} — EXPIRED, nobody confirmed; nothing happened`);
  auditStaff(p.message.guild, { summary: p.plan.summary, requester: p.plan.requesterName, outcome: 'Expired', detail: 'Nobody confirmed in time.' });
  await p.message
    .edit({
      embeds: [outcomeEmbed(p.plan, 'Expired', 'Nobody confirmed in time. Nothing happened.', COLORS.muted)],
      components: [],
    })
    .catch(() => {});
}

/** Posts the in-character line(s) plus the Confirm/Deny embed and arms the expiry. */
export async function startStaffConfirm(channel, plan, { messages = [], replyTo = null, signal } = {}) {
  for (const [i, text] of messages.entries()) {
    if (i > 0) await sleep(800, signal);
    await sendHuman(channel, text.slice(0, 2000), { replyTo: i === 0 ? replyTo : null, signal });
  }
  const id = randomUUID().slice(0, 8);
  const embed = new EmbedBuilder()
    .setTitle('Staff action — confirm?')
    .setDescription(plan.summary)
    .setColor(COLORS.pending)
    .setFooter({ text: `Requested by ${plan.requesterName} • expires in ${config.staffConfirmSeconds}s` });
  const message = await channel.send({ embeds: [embed], components: [confirmButtons(id)], allowedMentions: { parse: [] } });
  const timer = setTimeout(() => void expirePending(id), config.staffConfirmSeconds * 1000);
  timer.unref?.();
  pending.set(id, { plan, channelId: channel.id, message, timer });
  auditStaff(channel.guild, { summary: plan.summary, requester: plan.requesterName, outcome: 'Requested', detail: `in #${plan.channelName}, awaiting confirm` });
}

/** Confirm/Deny clicks. No AI call here: outcomes go to the events buffer instead. */
export async function handleStaffButton(interaction) {
  const [, verb, id] = interaction.customId.split(':');
  const p = pending.get(id);
  if (!p) {
    await interaction.reply({ content: 'This confirmation expired — nothing happened.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== p.plan.requesterId) {
    await interaction.reply({ content: 'Only the person who asked can answer this.', flags: MessageFlags.Ephemeral });
    return;
  }
  clearTimeout(p.timer);
  pending.delete(id); // taken atomically: a double-click can never execute twice

  if (verb === 'deny') {
    recordStaffEvent(p.channelId, `${p.plan.summary} — DENIED by ${p.plan.requesterName}; nothing happened`);
    auditStaff(interaction.guild, { summary: p.plan.summary, requester: p.plan.requesterName, outcome: 'Denied', detail: 'Cancelled by the requester.' });
    await interaction.update({
      embeds: [outcomeEmbed(p.plan, 'Denied', `Cancelled by ${p.plan.requesterName}. Nothing happened.`, COLORS.muted)],
      components: [],
    });
    return;
  }

  await interaction.deferUpdate(); // execution can outlast the 3s interaction window
  const result = await executeStaff(p.plan, interaction.guild);
  if (result.ok) {
    recordStaffEvent(p.channelId, `${p.plan.summary} — DONE (requested by ${p.plan.requesterName})`);
    auditStaff(interaction.guild, { summary: p.plan.summary, requester: p.plan.requesterName, outcome: 'Done', detail: `in #${p.plan.channelName}` });
    await interaction.editReply({ embeds: [outcomeEmbed(p.plan, 'Done', 'Executed successfully.', COLORS.done)], components: [] });
  } else {
    recordStaffEvent(p.channelId, `${p.plan.summary} — FAILED: ${result.reason}; nothing happened`);
    auditStaff(interaction.guild, { summary: p.plan.summary, requester: p.plan.requesterName, outcome: 'Failed', detail: result.reason });
    await interaction.editReply({ embeds: [outcomeEmbed(p.plan, 'Failed', result.reason, COLORS.failed)], components: [] });
  }
}
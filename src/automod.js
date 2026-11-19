import { PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { auditStaff, recordStaffEvent } from './staffFlow.js';

// Conservative on purpose: a scam phrase alone is not enough, it needs a link (or a known
// lookalike scam host). Jokes about MrBeast without a link must never trigger this.
const SCAM_RULES = [
  { re: /mr\s?beast/i, need: /(crypto|giveaway|airdrop|double|bonus|promo|reward)/i },
  { re: /(free|claim|grab|get)\b[^.\n]{0,24}\bnitro/i },
  { re: /nitro\b[^.\n]{0,24}(generator|giveaway|free|claim)/i },
  { re: /steam\b[^.\n]{0,24}(gift|giveaway|free)/i },
  { re: /(crypto|bitcoin|btc|eth)\b[^.\n]{0,30}(double|2x|x2|giveaway|airdrop)/i },
];
const SCAM_HOST =
  /(^|\.)(discord-nitro|discordnitro|free-nitro|nitro-discord|discocrd|dlscord|discrod|steamcommunitry|steancommunity|discord-airdrop|crypto-giveaway)\./i;
const INVITE = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;
const LINK_HOST = /https?:\/\/([^\s/]+)/i;

const STRIKE_WINDOW_MS = 60 * 60_000;
const FIRST_TIMEOUT_MINUTES = 10;
const REPEAT_TIMEOUT_MINUTES = 60;

/** Which auto-mod rule a message breaks, or null. Pure: no Discord calls, easy to test. */
export function scanMessage(message) {
  if (!config.automodEnabled || !message.guild || message.author?.bot || message.system) return null;
  const text = message.content ?? '';
  const host = text.match(LINK_HOST)?.[1]?.toLowerCase() ?? '';
  if (host && (SCAM_HOST.test(host) || SCAM_RULES.some((r) => r.re.test(text) && (!r.need || r.need.test(text))))) {
    return { kind: 'scam' };
  }
  const perms = message.member?.permissions;
  const staff = perms?.has(PermissionFlagsBits.ManageMessages) || perms?.has(PermissionFlagsBits.ManageGuild);
  if (!staff && INVITE.test(text)) return { kind: 'invite' };
  const mentions = message.mentions?.users?.size ?? 0;
  if (mentions > 5 || (message.mentions?.everyone && !perms?.has(PermissionFlagsBits.MentionEveryone))) {
    return { kind: 'mentions' };
  }
  return null;
}

// Per-guild runaway guard, counted per executed action.
const actionLog = new Map();
function overCap(guildId) {
  const now = Date.now();
  const recent = (actionLog.get(guildId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= config.automodActionsPerMinute) return true;
  recent.push(now);
  actionLog.set(guildId, recent);
  return false;
}

function timeoutMinutes(guildId, userId) {
  const key = `automodStrike:${guildId}:${userId}`;
  const last = Number(getSetting(key) || 0);
  setSetting(key, String(Date.now()));
  return Date.now() - last < STRIKE_WINDOW_MS ? REPEAT_TIMEOUT_MINUTES : FIRST_TIMEOUT_MINUTES;
}

/**
 * Runs before the chat brain on every message. Returns true when the message was deleted
 * (the brain must not reply to it). Never throws for expected failures.
 */
export async function handleAutomod(message) {
  const hit = scanMessage(message);
  if (!hit) return false;
  const guild = message.guild;
  const me = guild.members.me;
  if (!message.channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) return false;
  if (overCap(guild.id)) return false;

  const deleted = await message.delete().then(() => true).catch(() => false);
  if (!deleted) return false;

  const name = message.member?.displayName ?? message.author.username;
  let timedOut = 0;
  if (hit.kind === 'scam') {
    const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
    const canTimeout =
      member &&
      member.id !== guild.ownerId &&
      !member.permissions.has(PermissionFlagsBits.Administrator) &&
      member.roles.highest.position < me.roles.highest.position;
    if (canTimeout) {
      timedOut = timeoutMinutes(guild.id, member.id);
      await member.timeout(timedOut * 60_000, 'auto-mod: scam link').catch(() => {
        timedOut = 0;
      });
    }
    const line = timedOut
      ? `yo ${name} just dropped a scam link — deleted it and timed them out for ${timedOut}m. don't click that stuff, their account is probably hacked`
      : `that scam link from ${name} is deleted. i can't timeout them (above my role), staff please check — account looks hacked`;
    await message.channel.send({ content: line, allowedMentions: { parse: [] } }).catch(() => {});
  }

  const detail = `deleted ${name}'s message (${hit.kind})${timedOut ? `, timeout ${timedOut}m` : ''}`;
  console.log(`[automod] #${message.channel.name ?? message.channel.id}: ${detail}`);
  recordStaffEvent(message.channel.id, `auto-mod: ${detail}`);
  auditStaff(guild, { summary: `Auto-mod ${hit.kind}`, requester: 'auto-mod', outcome: 'Done', detail });
  return true;
}
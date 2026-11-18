import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import { getSetting, setSetting, deleteSetting } from './db.js';

// Hard caps live in code, never in the prompt: the model can ask for more, it never gets more.
export const MAX_TIMEOUT_MINUTES = 60;
export const MAX_SLOWMODE_SECONDS = 120;
export const MAX_BOT_CHANNELS = 15;
export const MAX_BOT_CATEGORIES = 5;
export const MAX_BOT_ROLES = 10;
export const MAX_PURGE = 10;
// Discord's undocumented limit: ~2 name/topic edits per channel per 10 minutes.
const EDIT_COOLDOWN_MAX = 2;
const EDIT_COOLDOWN_MS = 10 * 60_000;

// The only permissions role_perms/channel_perms may ever touch. Power perms (admin, manage
// server/roles/channels, ban/kick, timeout, webhooks, mention-everyone) are never grantable.
const SAFE_PERMS = new Set([
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads',
  'EmbedLinks', 'AttachFiles', 'AddReactions', 'ReadMessageHistory', 'UseExternalEmojis', 'UseExternalStickers',
  'UseApplicationCommands', 'Connect', 'Speak', 'Stream', 'UseVAD', 'MuteMembers', 'DeafenMembers',
  'MoveMembers', 'ManageMessages', 'ChangeNickname',
]);
const PERM_NAMES = Object.keys(PermissionFlagsBits);

const OPS = new Set([
  'lock_channel', 'unlock_channel', 'slowmode', 'timeout', 'untimeout',
  'create_category', 'create_channel', 'rename_channel', 'set_topic', 'delete_channel', 'delete_category',
  'create_role', 'delete_role', 'give_role', 'remove_role', 'role_perms', 'channel_perms',
  'delete_message', 'purge',
]);
const CHANNEL_OPS = new Set(['lock_channel', 'unlock_channel', 'slowmode', 'rename_channel', 'set_topic', 'delete_channel', 'delete_category', 'channel_perms']);
const MEMBER_OPS = new Set(['timeout', 'untimeout', 'give_role', 'remove_role', 'purge']);
const ROLE_OPS = new Set(['delete_role', 'give_role', 'remove_role', 'role_perms']);
const CREATE_OPS = new Set(['create_category', 'create_channel']);
const EDIT_OPS = new Set(['rename_channel', 'set_topic']);
// Creations and role management are judged on guild-wide perms; channel ops on the target channel's perms.
const GUILD_LEVEL_OPS = new Set(['create_category', 'create_channel', 'timeout', 'untimeout', 'create_role', 'delete_role', 'give_role', 'remove_role', 'role_perms']);

const MIRROR_PERM = {
  lock_channel: PermissionFlagsBits.ManageChannels,
  unlock_channel: PermissionFlagsBits.ManageChannels,
  slowmode: PermissionFlagsBits.ManageChannels,
  timeout: PermissionFlagsBits.ModerateMembers,
  untimeout: PermissionFlagsBits.ModerateMembers,
  create_category: PermissionFlagsBits.ManageChannels,
  create_channel: PermissionFlagsBits.ManageChannels,
  rename_channel: PermissionFlagsBits.ManageChannels,
  set_topic: PermissionFlagsBits.ManageChannels,
  delete_channel: PermissionFlagsBits.ManageChannels,
  delete_category: PermissionFlagsBits.ManageChannels,
  create_role: PermissionFlagsBits.ManageRoles,
  delete_role: PermissionFlagsBits.ManageRoles,
  give_role: PermissionFlagsBits.ManageRoles,
  remove_role: PermissionFlagsBits.ManageRoles,
  role_perms: PermissionFlagsBits.ManageRoles,
  channel_perms: PermissionFlagsBits.ManageRoles,
  delete_message: PermissionFlagsBits.ManageMessages,
  purge: PermissionFlagsBits.ManageMessages,
};
// Editing permission overwrites needs Manage Permissions (ManageRoles), not Manage Channels.
const BOT_PERM = {
  lock_channel: PermissionFlagsBits.ManageRoles,
  unlock_channel: PermissionFlagsBits.ManageRoles,
  slowmode: PermissionFlagsBits.ManageChannels,
  timeout: PermissionFlagsBits.ModerateMembers,
  untimeout: PermissionFlagsBits.ModerateMembers,
  create_category: PermissionFlagsBits.ManageChannels,
  create_channel: PermissionFlagsBits.ManageChannels,
  rename_channel: PermissionFlagsBits.ManageChannels,
  set_topic: PermissionFlagsBits.ManageChannels,
  delete_channel: PermissionFlagsBits.ManageChannels,
  delete_category: PermissionFlagsBits.ManageChannels,
  create_role: PermissionFlagsBits.ManageRoles,
  delete_role: PermissionFlagsBits.ManageRoles,
  give_role: PermissionFlagsBits.ManageRoles,
  remove_role: PermissionFlagsBits.ManageRoles,
  role_perms: PermissionFlagsBits.ManageRoles,
  channel_perms: PermissionFlagsBits.ManageRoles,
  delete_message: PermissionFlagsBits.ManageMessages,
  purge: PermissionFlagsBits.ManageMessages,
};
const PERM_LABEL = {
  [PermissionFlagsBits.ManageChannels]: 'Manage Channels',
  [PermissionFlagsBits.ModerateMembers]: 'Moderate Members (timeout)',
  [PermissionFlagsBits.ManageRoles]: 'Manage Permissions',
  [PermissionFlagsBits.ManageMessages]: 'Manage Messages',
};

const LOCK_DENY = {
  SendMessages: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
};
const LOCK_NEUTRAL = {
  SendMessages: null,
  SendMessagesInThreads: null,
  CreatePublicThreads: null,
  CreatePrivateThreads: null,
};

const lockKey = (channelId) => `staffLock:${channelId}`;
const deny = (reason) => ({ ok: false, reason });
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Permission name lists: canonical Discord casing when recognized, raw otherwise (so the whitelist can name offenders). */
const permList = (v) =>
  (Array.isArray(v) ? v : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => PERM_NAMES.find((k) => k.toLowerCase() === s.toLowerCase()) ?? s)
    .slice(0, 12);

/** Shape-checks a model-proposed staff action and clamps numbers. Returns null when unusable. */
export function parseStaff(data) {
  const op = str(data?.op, 30).toLowerCase();
  if (!OPS.has(op)) return null;
  if (op === 'slowmode' && !Number.isFinite(Number(data.seconds))) return null;
  if (MEMBER_OPS.has(op) && !str(data.user, 60)) return null;
  if ((op === 'create_category' || op === 'create_channel' || op === 'rename_channel' || op === 'create_role') && !str(data.name, 100)) return null;
  if ((op === 'rename_channel' || op === 'set_topic' || op === 'delete_channel') && !str(data.channel, 100)) return null;
  if (op === 'delete_category' && !str(data.category, 100)) return null;
  if ((ROLE_OPS.has(op)) && !str(data.role, 100)) return null;
  if (op === 'channel_perms' && !str(data.target, 100)) return null;
  if (op === 'delete_message' && !str(data.message, 100) && !Number.isInteger(data.target)) return null;
  if (op === 'purge' && !str(data.user, 60)) return null;
  const allow = permList(data.allow);
  const deny = permList(data.deny);
  if ((op === 'role_perms' || op === 'channel_perms') && !allow.length && !deny.length) return null;
  const minutes = Math.min(MAX_TIMEOUT_MINUTES, Math.max(1, Math.round(Number(data.minutes) || 10)));
  const seconds = Math.min(MAX_SLOWMODE_SECONDS, Math.max(0, Math.round(Number(data.seconds) || 0)));
  const count = Math.min(MAX_PURGE, Math.max(1, Math.round(Number(data.count) || 5)));
  const messages = (Array.isArray(data.messages) ? data.messages : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
  return {
    op,
    channel: str(data.channel, 100),
    user: str(data.user, 60),
    name: str(data.name, 100),
    category: str(data.category, 100),
    role: str(data.role, 100),
    target: str(data.target, 100),
    targetIndex: Number.isInteger(data.target) ? data.target : null,
    message: str(data.message, 100),
    count,
    color: str(data.color, 20),
    allow,
    deny,
    type: str(data.type, 10).toLowerCase() === 'voice' ? 'voice' : 'text',
    topic: str(data.topic, 1024),
    minutes,
    seconds,
    reason: str(data.reason, 200),
    messages,
  };
}

/** Text channel names: lowercase, dashes for spaces, no punctuation. Categories keep spaces and case. */
export function sanitizeName(name, kind) {
  const trimmed = name.trim().replace(/^#/, '');
  if (kind === 'category') return trimmed.slice(0, 100);
  return trimmed.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 100);
}

// --- Bot-made channels/categories: only these may ever be deleted ----------------
const madeKey = (guildId) => `staffMade:${guildId}`;
function loadMade(guildId) {
  try {
    const m = JSON.parse(getSetting(madeKey(guildId)) || '{}');
    return {
      channels: Array.isArray(m.channels) ? m.channels : [],
      categories: Array.isArray(m.categories) ? m.categories : [],
      roles: Array.isArray(m.roles) ? m.roles : [],
    };
  } catch {
    return { channels: [], categories: [], roles: [] };
  }
}
const saveMade = (guildId, made) => setSetting(madeKey(guildId), JSON.stringify(made));
function trackMade(guildId, kind, id) {
  const made = loadMade(guildId);
  made[kind].push(id);
  saveMade(guildId, made);
}
function untrackMade(guildId, kind, id) {
  const made = loadMade(guildId);
  made[kind] = made[kind].filter((x) => x !== id);
  saveMade(guildId, made);
}

// --- Rename/topic cooldown (Discord's undocumented ~2 per 10 min per channel) ----
const editKey = (channelId) => `staffEdit:${channelId}`;
function recentEdits(channelId) {
  try {
    const list = JSON.parse(getSetting(editKey(channelId)) || '[]');
    return (Array.isArray(list) ? list : []).filter((t) => Date.now() - t < EDIT_COOLDOWN_MS);
  } catch {
    return [];
  }
}
function editCooldownMinutes(channelId) {
  const recent = recentEdits(channelId);
  if (recent.length < EDIT_COOLDOWN_MAX) return 0;
  return Math.max(1, Math.ceil((EDIT_COOLDOWN_MS - (Date.now() - Math.min(...recent))) / 60_000));
}
function recordEdit(channelId) {
  setSetting(editKey(channelId), JSON.stringify([...recentEdits(channelId), Date.now()].slice(-EDIT_COOLDOWN_MAX)));
}

function resolveCategory(guild, query) {
  const id = query.match(/^<#(\d+)>$/)?.[1] ?? (/^\d{17,20}$/.test(query) ? query : null);
  const found = id
    ? guild.channels.cache.get(id)
    : guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === query.toLowerCase());
  return found?.type === ChannelType.GuildCategory && found.guildId === guild.id ? found : null;
}

/** Roles by name, <@&id> mention or raw id; @everyone is never addressable. */
function resolveRole(guild, query) {
  const id = query.match(/^<@&(\d+)>$/)?.[1] ?? (/^\d{17,20}$/.test(query) ? query : null);
  const found = id
    ? guild.roles.cache.get(id)
    : guild.roles.cache.find((r) => r.name.toLowerCase() === query.toLowerCase());
  return found && found.id !== guild.roles.everyone.id ? found : null;
}

function resolveChannel(guild, current, query) {
  if (!query) return current;
  const id = query.match(/^<#(\d+)>$/)?.[1] ?? (/^\d{17,20}$/.test(query) ? query : null);
  const found = id
    ? guild.channels.cache.get(id)
    : guild.channels.cache.find((c) => c.name.toLowerCase() === query.replace(/^#/, '').toLowerCase());
  if (!found || found.guildId !== guild.id || found.isThread() || !found.isTextBased()) return null;
  return found;
}

async function resolveMember(guild, query) {
  const id = query.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d{17,20}$/.test(query) ? query : null);
  if (id) return guild.members.fetch(id).catch(() => null);
  const base = query.replace(/\s*\(@.*\)$/, '').toLowerCase();
  const match = (m) => m.displayName.toLowerCase() === base || m.user?.username?.toLowerCase() === base;
  const cached = guild.members.cache.find(match);
  if (cached) return cached;
  return guild.members
    .fetch({ query: base, limit: 10 })
    .then((ms) => ms.find(match) ?? null)
    .catch(() => null);
}

// Per-user abuse limit, counted when an action is proposed (even if later denied).
const opLog = new Map();
function rateLimited(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const recent = (opLog.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= config.staffOpsPerMinute) return true;
  recent.push(now);
  opLog.set(key, recent);
  return false;
}

/**
 * Every rule that can block an action, in one place so prepare and execute enforce
 * the exact same checks. Returns a human-readable reason (fed back to the model so
 * it can decline in character) or null when allowed.
 */
function blockReason({ op, requester, me, guild, channel, target, role, permTarget, parsed, originId }) {
  const mirror = MIRROR_PERM[op];
  const requesterHas = GUILD_LEVEL_OPS.has(op)
    ? requester.permissions.has(mirror)
    : requester.permissionsIn(channel).has(mirror);
  if (!requesterHas) return `${requester.displayName} does not have ${PERM_LABEL[mirror]} here, so they cannot ask for this`;

  const botNeed = BOT_PERM[op];
  const botHas = GUILD_LEVEL_OPS.has(op) ? me.permissions.has(botNeed) : channel.permissionsFor(me)?.has(botNeed);
  if (!botHas) return `I lack ${PERM_LABEL[botNeed]} myself, so I cannot do this even though ${requester.displayName} may ask`;

  if (op === 'lock_channel' && getSetting(lockKey(channel.id))) {
    return `I already locked #${channel.name} earlier; unlock it first`;
  }

  if (CREATE_OPS.has(op)) {
    const made = loadMade(guild.id);
    const isCategory = op === 'create_category';
    const name = sanitizeName(parsed.name, isCategory ? 'category' : 'text');
    if (!name) return 'that name is empty after cleaning; pick a real name';
    if (isCategory) {
      if (made.categories.length >= MAX_BOT_CATEGORIES) return `I already made ${MAX_BOT_CATEGORIES} categories here; that is my limit`;
      if (guild.channels.cache.some((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase())) {
        return `a category called "${parsed.name}" already exists`;
      }
    } else {
      if (made.channels.length >= MAX_BOT_CHANNELS) return `I already made ${MAX_BOT_CHANNELS} channels here; that is my limit`;
      if (guild.channels.cache.some((c) => c.type !== ChannelType.GuildCategory && !c.isThread() && c.name.toLowerCase() === name)) {
        return `a channel called #${name} already exists`;
      }
      if (parsed.category && !resolveCategory(guild, parsed.category)) return `no category called "${parsed.category}" exists here`;
    }
    return null;
  }

  if (EDIT_OPS.has(op)) {
    const left = editCooldownMinutes(channel.id);
    if (left) return `#${channel.name} had its name/topic changed too recently; Discord allows about 2 edits per 10 minutes, try again in ~${left} minute${left === 1 ? '' : 's'}`;
    if (op === 'rename_channel' && !sanitizeName(parsed.name, 'text')) return 'that name is empty after cleaning; pick a real name';
    return null;
  }

  if (op === 'delete_channel' || op === 'delete_category') {
    const made = loadMade(guild.id);
    const kind = op === 'delete_channel' ? 'channels' : 'categories';
    if (!made[kind].includes(channel.id)) {
      return `I can only delete ${kind} I created myself, and that one is not mine`;
    }
    if (op === 'delete_channel' && channel.id === originId) {
      return 'I cannot delete the channel we are talking in right now; ask me from a different channel';
    }
    if (op === 'delete_category' && guild.channels.cache.some((c) => c.parentId === channel.id)) {
      return 'that category still has channels in it; move or delete them first';
    }
    return null;
  }

  if (op === 'lock_channel' || op === 'unlock_channel' || op === 'slowmode' || op === 'delete_message' || op === 'purge') return null;

  if (op === 'create_role') {
    const made = loadMade(guild.id);
    if (made.roles.length >= MAX_BOT_ROLES) return `I already made ${MAX_BOT_ROLES} roles here; that is my limit`;
    if (guild.roles.cache.some((r) => r.name.toLowerCase() === parsed.name.toLowerCase())) {
      return `a role called "${parsed.name}" already exists`;
    }
    if (parsed.color && !/^#?[0-9a-fA-F]{6}$/.test(parsed.color)) return 'the color must be a hex code like #ff8800';
    return null;
  }

  if (op === 'delete_role') {
    if (!loadMade(guild.id).roles.includes(role.id)) return 'I can only delete roles I created myself, and that one is not mine';
    if (role.position >= me.roles.highest.position) return `"${role.name}" is not below my top role, so Discord will not let me delete it`;
    return null;
  }

  if (op === 'give_role' || op === 'remove_role') {
    if (!target) return 'that member could not be found';
    if (role.position >= me.roles.highest.position) return `"${role.name}" is not below my top role, so Discord will not let me manage it`;
    if (requester.id !== guild.ownerId && role.position >= requester.roles.highest.position) {
      return `"${role.name}" is not below ${requester.displayName}'s top role, so they cannot manage it`;
    }
    if (op === 'give_role' && target.roles.cache.has(role.id)) return `${target.displayName} already has "${role.name}"`;
    if (op === 'remove_role' && !target.roles.cache.has(role.id)) return `${target.displayName} does not have "${role.name}"`;
    return null;
  }

  if (op === 'role_perms' || op === 'channel_perms') {
    const bad = [...parsed.allow, ...parsed.deny].filter((p) => !SAFE_PERMS.has(p));
    if (bad.length) return `I never grant or revoke these permissions: ${bad.join(', ')}. Only everyday chat/voice permissions and Manage Messages are allowed`;
    const both = parsed.allow.filter((p) => parsed.deny.includes(p));
    if (both.length) return `a permission cannot be both allowed and denied: ${both.join(', ')}`;
    if (op === 'role_perms') {
      if (role.position >= me.roles.highest.position) return `"${role.name}" is not below my top role, so I cannot edit its permissions`;
      if (requester.id !== guild.ownerId && role.position >= requester.roles.highest.position) {
        return `"${role.name}" is not below ${requester.displayName}'s top role, so they cannot edit it`;
      }
    } else if (permTarget && permTarget.position !== undefined && permTarget.id !== guild.roles.everyone.id && permTarget.position >= me.roles.highest.position) {
      return `"${permTarget.name}" is above my top role; I will not edit its channel permissions`;
    }
    return null;
  }

  if (!target) return 'that member could not be found';
  if (op === 'timeout' || op === 'untimeout') {
    if (target.id === me.id) return 'that would target me; I am not going to time myself out';
    if (target.id === requester.id) return `${requester.displayName} cannot ask to time themselves out`;
    if (target.id === guild.ownerId) return 'that is the server owner; nobody can time them out';
    if (target.permissions.has(PermissionFlagsBits.Administrator)) return `${target.displayName} is an admin; they cannot be timed out`;
    if (target.roles.highest.position >= me.roles.highest.position) {
      return `${target.displayName}'s top role is not below mine, so Discord will not let me time them out`;
    }
    if (requester.id !== guild.ownerId && target.roles.highest.position >= requester.roles.highest.position) {
      return `${target.displayName}'s top role is not below ${requester.displayName}'s, so they cannot moderate them`;
    }
    if (op === 'untimeout' && !(target.communicationDisabledUntilTimestamp > Date.now())) {
      return `${target.displayName} is not timed out right now`;
    }
  }
  return null;
}

function summarize(plan) {
  switch (plan.op) {
    case 'lock_channel':
      return `Lock #${plan.channelName} — @everyone loses Send Messages and thread creation`;
    case 'unlock_channel':
      return `Unlock #${plan.channelName} — restore its previous permissions`;
    case 'slowmode':
      return plan.seconds ? `Set ${plan.seconds}s slowmode in #${plan.channelName}` : `Turn off slowmode in #${plan.channelName}`;
    case 'timeout':
      return `Timeout ${plan.targetName} for ${plan.minutes} minute${plan.minutes === 1 ? '' : 's'}${plan.reason ? ` (${plan.reason})` : ''}`;
    case 'untimeout':
      return `Remove ${plan.targetName}'s timeout`;
    case 'create_category':
      return `Create category "${plan.name}"`;
    case 'create_channel':
      return (
        `Create ${plan.type} channel #${plan.name}` +
        (plan.parentName ? ` under "${plan.parentName}"` : '') +
        (plan.topic ? ` (topic: ${plan.topic.slice(0, 80)})` : '')
      );
    case 'rename_channel':
      return `Rename #${plan.channelName} to #${plan.name}`;
    case 'set_topic':
      return `Set #${plan.channelName} topic to "${plan.topic.slice(0, 100)}"`;
    case 'delete_channel':
      return `Delete #${plan.channelName} (I created it)`;
    case 'delete_category':
      return `Delete category "${plan.channelName}" (I created it)`;
    case 'create_role':
      return `Create role "${plan.name}"${plan.color ? ` (${plan.color})` : ''}`;
    case 'delete_role':
      return `Delete role "${plan.roleName}" (I created it)`;
    case 'give_role':
      return `Give role "${plan.roleName}" to ${plan.targetName}`;
    case 'remove_role':
      return `Remove role "${plan.roleName}" from ${plan.targetName}`;
    case 'role_perms':
      return (
        `Edit role "${plan.roleName}" permissions` +
        (plan.allow.length ? ` — allow: ${plan.allow.join(', ')}` : '') +
        (plan.deny.length ? ` — deny: ${plan.deny.join(', ')}` : '')
      );
    case 'channel_perms':
      return (
        `#${plan.channelName} permissions for "${plan.permTargetName}"` +
        (plan.allow.length ? ` — allow: ${plan.allow.join(', ')}` : '') +
        (plan.deny.length ? ` — deny: ${plan.deny.join(', ')}` : '')
      );
    case 'delete_message':
      return `Delete ${plan.messageAuthor}'s message in #${plan.channelName}`;
    case 'purge':
      return `Purge up to ${plan.count} recent messages from ${plan.targetName} in #${plan.channelName}`;
  }
}

/**
 * Validates a parsed staff action against the live Discord state and builds an
 * executable plan. { ok: true, plan } or { ok: false, reason } — never throws for
 * expected failures (missing perms, unknown target, rate limit).
 */
export async function prepareStaff(parsed, { channel, requester, history = [] }) {
  if (!config.staffEnabled) return deny('staff actions are turned off in my config');
  if (!channel.guild) return deny('this is a DM; staff actions only work inside a server');
  const guild = channel.guild;
  const me = guild.members.me;

  let targetChannel = channel;
  if (parsed.op === 'delete_category') {
    targetChannel = resolveCategory(guild, parsed.category);
    if (!targetChannel) return deny(`no category called "${parsed.category}" exists here`);
  } else if (CHANNEL_OPS.has(parsed.op)) {
    targetChannel = resolveChannel(guild, channel, parsed.channel);
    if (!targetChannel) return deny(`no channel called "${parsed.channel}" exists here`);
  }

  let target = null;
  if (MEMBER_OPS.has(parsed.op)) {
    target = await resolveMember(guild, parsed.user);
    if (!target) return deny(`no member called "${parsed.user}" was found in this server`);
  }

  let role = null;
  if (ROLE_OPS.has(parsed.op)) {
    role = resolveRole(guild, parsed.role);
    if (!role) return deny(`no role called "${parsed.role}" exists here`);
  }

  let permTarget = null;
  let permTargetKind = null;
  if (parsed.op === 'channel_perms') {
    if (parsed.target.toLowerCase() === '@everyone') {
      permTarget = guild.roles.everyone;
      permTargetKind = 'everyone';
    } else {
      permTarget = resolveRole(guild, parsed.target);
      permTargetKind = 'role';
      if (!permTarget) {
        permTarget = await resolveMember(guild, parsed.target);
        permTargetKind = 'member';
      }
    }
    if (!permTarget) return deny(`no role or member called "${parsed.target}" was found here`);
  }

  let messageId = null;
  let messageAuthor = null;
  if (parsed.op === 'delete_message') {
    const link = parsed.message.match(/channels\/\d+\/\d+\/(\d+)/);
    const id = link?.[1] ?? (/^\d{17,20}$/.test(parsed.message) ? parsed.message : null);
    if (id) messageId = id;
    else if (parsed.targetIndex) {
      const others = history.filter((m) => m.authorId !== me.id);
      messageId = others[parsed.targetIndex - 1]?.id ?? null;
    }
    if (!messageId) return deny('which message? give a message link, its id, or the [n] of a chat line');
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg || msg.channelId !== channel.id) return deny('that message is not in this channel (or is already gone)');
    messageAuthor = msg.author?.username ?? 'someone';
  }

  let messageIds = null;
  if (parsed.op === 'purge') {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    messageIds = recent
      ? [...recent.values()]
          .filter((m) => m.author.id === target.id)
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .slice(0, parsed.count)
          .map((m) => m.id)
      : [];
    if (!messageIds.length) return deny(`${target.displayName} has no recent messages in #${channel.name}`);
  }

  const reason = blockReason({ op: parsed.op, requester, me, guild, channel: targetChannel, target, role, permTarget, parsed, originId: channel.id });
  if (reason) return deny(reason);
  if (rateLimited(guild.id, requester.id)) {
    return deny(`${requester.displayName} is asking for too many staff actions at once (limit ${config.staffOpsPerMinute} per minute)`);
  }

  const parent = parsed.op === 'create_channel' && parsed.category ? resolveCategory(guild, parsed.category) : null;
  const plan = {
    op: parsed.op,
    guildId: guild.id,
    channelId: targetChannel.id,
    channelName: targetChannel.name,
    originChannelId: channel.id,
    targetId: target?.id ?? null,
    targetName: target?.displayName ?? null,
    roleId: role?.id ?? null,
    roleName: role?.name ?? null,
    permTargetId: permTarget?.id ?? null,
    permTargetKind,
    permTargetName: permTarget ? (permTargetKind === 'member' ? permTarget.displayName : permTarget.name) : null,
    messageId,
    messageAuthor,
    messageIds,
    count: parsed.count,
    name: sanitizeName(parsed.name, parsed.op === 'create_category' || parsed.op === 'create_role' ? 'category' : 'text'),
    color: parsed.color ? (parsed.color.startsWith('#') ? parsed.color : `#${parsed.color}`).toLowerCase() : '',
    allow: parsed.allow,
    deny: parsed.deny,
    parentId: parent?.id ?? null,
    parentName: parent?.name ?? null,
    type: parsed.type,
    topic: parsed.topic,
    minutes: parsed.minutes,
    seconds: parsed.seconds,
    reason: parsed.reason,
    requesterId: requester.id,
    requesterName: requester.displayName,
  };
  plan.summary = summarize(plan);
  return { ok: true, plan };
}

/**
 * Executes a prepared plan. Re-fetches fresh state and re-runs every check first
 * (permissions may have changed since the button was posted). Returns
 * { ok: true, summary } or { ok: false, reason }; API failures are never retried
 * (403s count toward Discord's invalid-request ban).
 */
export async function executeStaff(plan, guild) {
  try {
    const requester = await guild.members.fetch(plan.requesterId).catch(() => null);
    if (!requester) return deny('the person who asked for this left the server');
    const channel = CREATE_OPS.has(plan.op)
      ? null
      : guild.channels.cache.get(plan.channelId) ?? (await guild.channels.fetch(plan.channelId).catch(() => null));
    if (!CREATE_OPS.has(plan.op) && !channel) return deny(`#${plan.channelName} no longer exists`);
    const target = plan.targetId ? await guild.members.fetch(plan.targetId).catch(() => null) : null;
    if (plan.targetId && !target) return deny(`${plan.targetName} left the server`);
    const role = plan.roleId ? guild.roles.cache.get(plan.roleId) ?? (await guild.roles.fetch(plan.roleId).catch(() => null)) : null;
    if (plan.roleId && !role) return deny(`the role "${plan.roleName}" no longer exists`);
    let permTarget = null;
    if (plan.permTargetId) {
      permTarget =
        plan.permTargetKind === 'everyone'
          ? guild.roles.everyone
          : plan.permTargetKind === 'role'
            ? guild.roles.cache.get(plan.permTargetId)
            : await guild.members.fetch(plan.permTargetId).catch(() => null);
      if (!permTarget) return deny(`"${plan.permTargetName}" no longer exists`);
    }

    const reason = blockReason({
      op: plan.op, requester, me: guild.members.me, guild, channel, target, role, permTarget, parsed: plan, originId: plan.originChannelId,
    });
    if (reason) return deny(reason);
    if (plan.op === 'create_channel' && plan.parentId && guild.channels.cache.get(plan.parentId)?.type !== ChannelType.GuildCategory) {
      return deny(`the category "${plan.parentName}" was deleted before this was confirmed`);
    }

    const audit = `by ${plan.requesterName} via chat${plan.reason ? `: ${plan.reason}` : ''}`;
    const everyone = guild.roles.everyone;

    switch (plan.op) {
      case 'lock_channel': {
        const current = channel.permissionOverwrites.cache.get(everyone.id);
        setSetting(
          lockKey(channel.id),
          current ? JSON.stringify({ allow: current.allow.bitfield.toString(), deny: current.deny.bitfield.toString() }) : 'none',
        );
        await channel.permissionOverwrites.edit(everyone, LOCK_DENY, { reason: audit });
        break;
      }
      case 'unlock_channel': {
        const saved = getSetting(lockKey(channel.id));
        if (saved && saved !== 'none') {
          const { allow, deny: denied } = JSON.parse(saved);
          await channel.permissionOverwrites.edit(everyone, { allow: BigInt(allow), deny: BigInt(denied) }, { reason: audit });
        } else {
          // No saved state (locked by someone else): only neutralize the lock bits, keep everything else.
          await channel.permissionOverwrites.edit(everyone, LOCK_NEUTRAL, { reason: audit });
        }
        deleteSetting(lockKey(channel.id));
        break;
      }
      case 'slowmode':
        await channel.setRateLimitPerUser(plan.seconds, audit);
        break;
      case 'timeout':
        await target.timeout(plan.minutes * 60_000, audit);
        break;
      case 'untimeout':
        await target.timeout(null, audit);
        break;
      case 'create_category': {
        const created = await guild.channels.create({ name: plan.name, type: ChannelType.GuildCategory, reason: audit });
        trackMade(guild.id, 'categories', created.id);
        break;
      }
      case 'create_channel': {
        const created = await guild.channels.create({
          name: plan.name,
          type: plan.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
          parent: plan.parentId ?? undefined,
          topic: plan.type === 'voice' ? undefined : plan.topic || undefined,
          reason: audit,
        });
        trackMade(guild.id, 'channels', created.id);
        break;
      }
      case 'rename_channel':
        await channel.setName(plan.name, audit);
        recordEdit(channel.id);
        break;
      case 'set_topic':
        await channel.setTopic(plan.topic, audit);
        recordEdit(channel.id);
        break;
      case 'delete_channel':
        await channel.delete(audit);
        untrackMade(guild.id, 'channels', channel.id);
        deleteSetting(lockKey(channel.id));
        deleteSetting(editKey(channel.id));
        break;
      case 'delete_category':
        await channel.delete(audit);
        untrackMade(guild.id, 'categories', channel.id);
        break;
      case 'create_role': {
        const created = await guild.roles.create({
          name: plan.name,
          color: plan.color ? parseInt(plan.color.slice(1), 16) : undefined,
          reason: audit,
        });
        trackMade(guild.id, 'roles', created.id);
        break;
      }
      case 'delete_role':
        await role.delete(audit);
        untrackMade(guild.id, 'roles', role.id);
        break;
      case 'give_role':
        await target.roles.add(role, audit);
        break;
      case 'remove_role':
        await target.roles.remove(role, audit);
        break;
      case 'role_perms': {
        let bits = role.permissions.bitfield;
        for (const p of plan.allow) bits |= PermissionFlagsBits[p];
        for (const p of plan.deny) bits &= ~PermissionFlagsBits[p];
        await role.setPermissions(bits, audit);
        break;
      }
      case 'channel_perms': {
        const options = {};
        for (const p of plan.allow) options[p] = true;
        for (const p of plan.deny) options[p] = false;
        await channel.permissionOverwrites.edit(permTarget, options, { reason: audit });
        break;
      }
      case 'delete_message': {
        const msg = await channel.messages.fetch(plan.messageId).catch(() => null);
        if (!msg) return deny('that message is already gone');
        await msg.delete(audit);
        break;
      }
      case 'purge': {
        let n = 0;
        for (const id of plan.messageIds) {
          const msg = await channel.messages.fetch(id).catch(() => null);
          if (msg && (await msg.delete(audit).then(() => true).catch(() => false))) n++;
        }
        if (!n) return deny('those messages are already gone');
        return { ok: true, summary: `Purged ${n} message${n === 1 ? '' : 's'} from ${plan.targetName} in #${plan.channelName}` };
      }
    }
    return { ok: true, summary: plan.summary };
  } catch (error) {
    return deny(`Discord refused the action: ${error.message}`);
  }
}

/** One prompt line telling the model what the person it is talking to may ask for. */
export function staffPermsLine(member, channel) {
  const channels = member.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels);
  const roles = member.permissions.has(PermissionFlagsBits.ManageRoles);
  const moderate = member.permissions.has(PermissionFlagsBits.ModerateMembers);
  const messages = member.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages);
  return (
    `${member.displayName} ${channels ? 'CAN' : 'CANNOT'} manage channels here, ` +
    `${roles ? 'CAN' : 'CANNOT'} manage roles, ${moderate ? 'CAN' : 'CANNOT'} timeout members, and ` +
    `${messages ? 'CAN' : 'CANNOT'} delete messages here. ` +
    `Never do staff actions for someone lacking the matching permission.`
  );
}
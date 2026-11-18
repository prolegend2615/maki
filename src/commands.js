import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, ChannelType, MessageFlags } from 'discord.js';
import { deleteSetting, getSetting, getWatchList, setWatchList, setSetting } from './db.js';
import { config } from './config.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('toggle')
    .setDescription('Turn the bot on or off in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts([InteractionContextType.Guild])
    .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('announce-watch')
    .setDescription('Manage which channels Mika reads announcements from')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts([InteractionContextType.Guild])
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Also read announcements from a channel')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel to watch')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Stop watching a channel (auto-detected ones stay watched)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel to stop watching')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show manually watched channels'))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('server-notebook')
    .setDescription('Show the notebook Mika keeps about this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts([InteractionContextType.Guild])
    .toJSON(),
  new SlashCommandBuilder()
    .setName('staff-log')
    .setDescription('Where Mika logs staff actions (lock, slowmode, timeout)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts([InteractionContextType.Guild])
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Log every staff action to a channel')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Show the current log channel'))
    .addSubcommand((s) => s.setName('clear').setDescription('Stop logging to the configured channel'))
    .toJSON(),
];

const notebookOf = (guildId) => {
  try {
    return JSON.parse(getSetting(`serverNb:${guildId}`) || 'null')?.text ?? '';
  } catch {
    return '';
  }
};

export async function handleCommand(interaction) {
  if (interaction.commandName === 'toggle') {
    const on = interaction.options.getBoolean('enabled', true);
    setSetting(`enabled:${interaction.channelId}`, on ? 'on' : 'off');
    await interaction.reply({ content: `Bot is now ${on ? 'on' : 'off'} in this channel.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === 'announce-watch') {
    const sub = interaction.options.getSubcommand();
    const list = getWatchList(interaction.guildId);
    if (sub === 'add') {
      const channel = interaction.options.getChannel('channel', true);
      if (!list.includes(channel.id)) list.push(channel.id);
      setWatchList(interaction.guildId, list);
      await interaction.reply({ content: `Now also reading announcements from <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
    } else if (sub === 'remove') {
      const channel = interaction.options.getChannel('channel', true);
      setWatchList(interaction.guildId, list.filter((id) => id !== channel.id));
      await interaction.reply({
        content: `Removed <#${channel.id}> from the manual watch list (native announcement channels stay watched).`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      const watched = list.length ? list.map((id) => `- <#${id}> (manual)`).join('\n') : '- (none manually watched)';
      await interaction.reply({
        content: `**Watched announcement channels**\n${watched}\n- native announcement channels and channels named announce*/news are always watched`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (interaction.commandName === 'staff-log') {
    const sub = interaction.options.getSubcommand();
    const key = `staffLog:${interaction.guildId}`;
    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel', true);
      setSetting(key, channel.id);
      await interaction.reply({ content: `Staff actions will be logged in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
    } else if (sub === 'clear') {
      deleteSetting(key);
      const fallback = config.staffLogChannelId ? ' The STAFF_LOG_CHANNEL env default still applies.' : '';
      await interaction.reply({ content: `Cleared the log channel.${fallback}`, flags: MessageFlags.Ephemeral });
    } else {
      const id = getSetting(key) || config.staffLogChannelId;
      await interaction.reply({
        content: id ? `Logging staff actions in <#${id}>.` : 'No log channel set — use `/staff-log set` to pick one.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (interaction.commandName === 'server-notebook') {
    const text = notebookOf(interaction.guildId);
    if (!text) {
      await interaction.reply({
        content: 'The server notebook is still empty — it fills up as Mika chats and announcements come in.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // The notebook can be up to ~2000 chars; a file avoids Discord's message length limit.
    const files =
      text.length > 1800
        ? [{ attachment: Buffer.from(text, 'utf8'), name: 'server-notebook.txt' }]
        : undefined;
    await interaction.reply({
      content: files ? '**Current server notebook** (attached)' : `**Current server notebook**\n${text}`,
      files,
      flags: MessageFlags.Ephemeral,
    });
  }
}

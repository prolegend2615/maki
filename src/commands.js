import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js';
import { setSetting } from './db.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('toggle')
    .setDescription('Turn the bot on or off in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts([InteractionContextType.Guild])
    .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
    .toJSON(),
];

export async function handleCommand(interaction) {
  if (interaction.commandName !== 'toggle') return;
  const on = interaction.options.getBoolean('enabled', true);
  setSetting(`enabled:${interaction.channelId}`, on ? 'on' : 'off');
  await interaction.reply({
    content: `Bot is now ${on ? 'on' : 'off'} in this channel.`,
    flags: MessageFlags.Ephemeral,
  });
}

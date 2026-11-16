import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { onMessage, restoreFollowUps } from './brain.js';
import { commands, handleCommand } from './commands.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent, // privileged: enable in the Developer Portal
  ],
  partials: [Partials.Channel], // required to receive DMs
  // Safety net: nothing the bot sends can ping @everyone, @here, roles or users, even if a send forgets the option.
  allowedMentions: { parse: [], repliedUser: false },
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  restoreFollowUps(c); // re-arm follow-ups that were pending before a restart
  try {
    if (config.guildId) {
      await c.guilds.cache.get(config.guildId)?.commands.set(commands);
    } else {
      await c.application.commands.set(commands);
    }
    console.log('Slash commands registered');
  } catch (error) {
    console.error('Command registration failed:', error.message);
  }
});

client.on(Events.MessageCreate, (message) => {
  try {
    onMessage(message);
  } catch (error) {
    console.error('[messageCreate]', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (error) {
    console.error('[interaction]', error);
    const msg = { content: 'Something went wrong.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));

await client.login(config.discordToken);

'use strict';

const { Client, GatewayIntentBits, Events } = require('discord.js');
const sodium = require('libsodium-wrappers');

const { config, validate } = require('./src/config');
const ytdlp = require('./src/ytdlp');
const cache = require('./src/cache');
const { getManager, managers } = require('./src/musicQueue');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const HELP = [
  '**🎵 Music commands**',
  `\`${config.prefix}play <youtube url | search terms>\` — play or queue a song`,
  `\`${config.prefix}skip\` (\`${config.prefix}next\`) — skip the current song`,
  `\`${config.prefix}stop\` — stop and leave the channel`,
  `\`${config.prefix}queue\` (\`${config.prefix}q\`) — show the queue`,
  `\`${config.prefix}help\` — show this message`,
].join('\n');

async function handlePlay(message, query) {
  if (!query) {
    return message.reply('❌ Usage: `' + config.prefix + 'play <youtube url | search terms>`');
  }
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply('🔊 Join a voice channel first.');
  }
  const me = message.guild.members.me;
  const perms = voiceChannel.permissionsFor(me);
  if (!perms?.has('Connect') || !perms?.has('Speak')) {
    return message.reply('❌ I need **Connect** and **Speak** permissions in that voice channel.');
  }

  const thinking = await message.channel.send('🔎 Resolving…');
  let track;
  try {
    track = await ytdlp.resolve(query);
  } catch (err) {
    console.error('Resolve failed:', err.message);
    return thinking.edit(`❌ Couldn't find that: ${err.message.split('\n')[0]}`).catch(() => {});
  }
  track.requestedBy = message.author.username;

  thinking.delete().catch(() => {});

  const manager = getManager(message.guild, true);
  try {
    await manager.enqueue(track, { voiceChannel, textChannel: message.channel });
  } catch (err) {
    return message.channel.send(`❌ Failed to join voice: ${err.message}`).catch(() => {});
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  try {
    switch (cmd) {
      case 'play':
      case 'p':
        await handlePlay(message, args.join(' ').trim());
        break;

      case 'skip':
      case 'next': {
        const mgr = getManager(message.guild);
        if (!mgr || !mgr.current) {
          await message.reply('❌ Nothing is playing.');
        } else {
          mgr.skip();
          await message.channel.send('⏭️ Skipped.');
        }
        break;
      }

      case 'stop':
      case 'leave': {
        const mgr = getManager(message.guild);
        if (!mgr) {
          await message.reply('❌ Nothing is playing.');
        } else {
          mgr.stop();
          await message.channel.send('🛑 Stopped and left the channel.');
        }
        break;
      }

      case 'queue':
      case 'q': {
        const mgr = getManager(message.guild);
        await message.channel.send(mgr ? mgr.describeQueue() : 'The queue is empty.');
        break;
      }

      case 'help':
        await message.channel.send(HELP);
        break;

      default:
        break;
    }
  } catch (err) {
    console.error('Command handler error:', err);
    message.reply('❌ Something went wrong handling that command.').catch(() => {});
  }
});

// Leave automatically when the bot is left alone in a voice channel.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const channel = oldState.channel;
  if (!channel) return;
  if (!channel.members.has(client.user.id)) return;

  const humans = channel.members.filter((m) => !m.user.bot).size;
  if (humans === 0) {
    const mgr = managers.get(oldState.guild.id);
    if (mgr) {
      console.log(`👋 Alone in guild ${oldState.guild.id} — leaving.`);
      mgr.stop();
    }
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

async function main() {
  validate();
  await sodium.ready; // required by @discordjs/voice for packet encryption

  cache.ensureDir();
  cache.startSweeper();

  try {
    const v = await ytdlp.version();
    console.log(`🛠️  yt-dlp version: ${v}`);
    if (config.autoUpdateYtDlp) {
      const result = await ytdlp.selfUpdate();
      console.log(`🔄 yt-dlp update: ${result}`);
    }
  } catch (err) {
    console.error(`⚠️  ${err.message}`);
    console.error('Playback will fail until yt-dlp is available.');
  }

  await client.login(config.token);
}

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  for (const mgr of managers.values()) mgr.stop();
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

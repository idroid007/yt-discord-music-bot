const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const play = require('play-dl');
require('dotenv').config();
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '!';
const TIMEOUT = 5 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const queues = new Map();
const activeTempFiles = new Set();

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || !message.content.startsWith(PREFIX) || message.author.bot) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift()?.toLowerCase();
  const voiceChannel = message.member?.voice.channel;
  const guildId = message.guild.id;

  if (cmd === 'play') {
    let inputUrl = args[0];
    if (!inputUrl) return message.reply('❌ Please provide a YouTube URL.');

    // Normalize the YouTube video URL
    try {
      const urlObj = new URL(inputUrl);
      const videoId = urlObj.searchParams.get('v');
      if (!videoId) {
        return message.reply('❌ Could not extract video ID from the URL.');
      }
      inputUrl = `https://www.youtube.com/watch?v=${videoId}`;
    } catch (err) {
      return message.reply('❌ Invalid URL format.');
    }

    const isValid = await play.yt_validate(inputUrl);
    if (!isValid) return message.reply('❌ Not a valid YouTube video URL.');

    if (!voiceChannel) return message.reply('🔊 Join a voice channel first.');

    let queue = queues.get(guildId);
    if (!queue || !Array.isArray(queue.songs)) {
      queue = { songs: [], playing: false, timeout: null, tempFilePath: null };
    }

    queue.songs.push({ url: inputUrl, requestedBy: message.author.username });
    queue.playing = queue.playing || false;
    queues.set(guildId, queue);

    message.channel.send(`🎶 Added to queue: ${inputUrl}`);

    if (!queue.playing || !getVoiceConnection(guildId)) {
      playSong(message.guild, voiceChannel);
    }
  }

  if (cmd === 'stop') {
    stopPlayback(message.guild);
    message.channel.send('🛑 Stopped playback and left the channel.');
  }
});

async function playSong(guild, voiceChannel) {
  const guildId = guild.id;
  const queue = queues.get(guildId);

  if (!queue || queue.songs.length === 0) {
    disconnectAfterTimeout(guildId);
    return;
  }

  const song = queue.songs.shift();
  if (!song?.url) {
    playSong(guild, voiceChannel);
    return;
  }

  const isValid = await play.yt_validate(song.url);
  if (!isValid) {
    playSong(guild, voiceChannel);
    return;
  }

  queue.playing = true;
  clearTimeout(queue.timeout);
  const connection =
    getVoiceConnection(guildId) ||
    joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

  try {
    const ytdlp = require('yt-dlp-exec');
    const path = require('path');
    const fs = require('fs');
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const tempFilePath = path.join(tempDir, `discordbot_${guildId}_${Date.now()}.webm`);
    await ytdlp(song.url, {
      output: tempFilePath,
      format: '251/bestaudio',
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      ],
    });
    if (!fs.existsSync(tempFilePath)) throw new Error('yt-dlp did not create the temp file');

    queue.tempFilePath = tempFilePath;
    queues.set(guildId, queue);
    activeTempFiles.add(tempFilePath);

    const resource = createAudioResource(fs.createReadStream(tempFilePath), {
      inputType: 'webm/opus',
    });

    const player = createAudioPlayer();
    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
      if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
        fs.unlink(queue.tempFilePath, (err) => {
          if (err) console.error('Temp delete failed:', err);
        });
        activeTempFiles.delete(queue.tempFilePath);
        queue.tempFilePath = null;
        queues.set(guildId, queue);
      }
      playSong(guild, voiceChannel);
    });

    player.on('error', (err) => {
      console.error('Playback error:', err);
      if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
        fs.unlink(queue.tempFilePath, (err) => {
          if (err) console.error('Temp delete failed:', err);
        });
        activeTempFiles.delete(queue.tempFilePath);
        queue.tempFilePath = null;
        queues.set(guildId, queue);
      }
      playSong(guild, voiceChannel);
    });

  } catch (err) {
    console.error('Streaming error:', err);
    const textChannel = guild.channels.cache.find(
      (ch) => ch.type === 0 && ch.permissionsFor(client.user).has('SendMessages')
    );
    if (textChannel) {
      textChannel.send(`❌ Error streaming: ${song.url}\n${err.message}`);
    }
    playSong(guild, voiceChannel);
  }
}

function stopPlayback(guild) {
  const guildId = guild.id;
  const queue = queues.get(guildId);
  const fs = require('fs');

  if (queue) {
    if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
      fs.unlink(queue.tempFilePath, (err) => {
        if (err) console.error('Temp delete failed:', err);
      });
      activeTempFiles.delete(queue.tempFilePath);
      queue.tempFilePath = null;
    }
    queue.songs = [];
    queue.playing = false;
    clearTimeout(queue.timeout);
    queues.set(guildId, queue);
  }

  const connection = getVoiceConnection(guildId);
  if (connection) connection.destroy();

  queues.delete(guildId);
}

function disconnectAfterTimeout(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  queue.timeout = setTimeout(() => {
    console.log(`💤 Inactive. Leaving guild ${guildId}`);
    stopPlayback({ id: guildId });
  }, TIMEOUT);
  queues.set(guildId, queue);
}

client.on('voiceStateUpdate', (oldState, newState) => {
  const botId = client.user.id;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  if (oldChannel && oldChannel.members.has(botId)) {
    const humanCount = oldChannel.members.filter(m => !m.user.bot).size;
    const botCount = oldChannel.members.filter(m => m.user.bot).size;
    if (humanCount === 0 && botCount === 1) {
      stopPlayback(oldState.guild);
      return;
    }
  }

  if (oldState.id === botId) {
    if (oldChannel && oldChannel.members.has(botId) && (!newChannel || !newChannel.members.has(botId))) {
      stopPlayback(oldState.guild);
    }
  }
});

client.on('guildDelete', (guild) => {
  const guildId = guild.id;
  const queue = queues.get(guildId);
  if (queue && queue.tempFilePath) {
    const fs = require('fs');
    if (fs.existsSync(queue.tempFilePath)) {
      fs.unlink(queue.tempFilePath, (err) => {
        if (err) console.error('Temp delete on guildDelete failed:', err);
        else console.log(`Deleted temp file on guildDelete for ${guildId}`);
      });
      activeTempFiles.delete(queue.tempFilePath);
    }
    queue.tempFilePath = null;
    queues.set(guildId, queue);
  }
});

setInterval(() => {
  const fs = require('fs');
  const path = require('path');
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) return;

  fs.readdir(tempDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      if (!activeTempFiles.has(filePath)) {
        fs.unlink(filePath, (err) => {
          if (!err) console.log('Deleted unused temp file:', filePath);
        });
      }
    });
  });
}, 10 * 60 * 1000);

client.login(TOKEN);

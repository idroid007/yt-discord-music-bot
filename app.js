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
const TOKEN = process.env.DISCORD_TOKEN; // Loaded from .env file
const PREFIX = '!';
const TIMEOUT = 5 * 60 * 1000; // 5 minutes

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const queues = new Map();
// Track temp files currently in use
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
    const url = args[0];
    if (!url || !play.yt_validate(url)) {
      return message.reply('❌ Please provide a valid YouTube URL.');
    }

    if (!voiceChannel) {
      return message.reply('🔊 Join a voice channel first.');
    }

    const queue = queues.get(guildId) || { songs: [], playing: false, timeout: null };
    queue.songs.push({ url, requestedBy: message.author.username });
    queues.set(guildId, queue);

    message.channel.send(`🎶 Added to queue: ${url}`);

    if (!queue.playing) {
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

  if (!song || !song.url) {
    console.warn('⚠️ Skipping invalid or undefined song URL.');
    playSong(guild, voiceChannel);
    return;
  }

  // Log the URL and validation result
  const isValid = await play.yt_validate(song.url);
  console.log(`Checking URL: ${song.url}, yt_validate: ${isValid}`);
  if (!isValid) {
    console.warn('⚠️ Skipping song: yt_validate returned false.');
    playSong(guild, voiceChannel);
    return;
  }

  queue.playing = true;
  clearTimeout(queue.timeout);

  console.log(`▶️ Now playing: ${song.url} (requested by ${song.requestedBy})`);

  const connection =
    getVoiceConnection(guildId) ||
    joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

  try {
    console.log(`Attempting to stream (yt-dlp fallback only): ${song.url}`);
    const ytdlp = require('yt-dlp-exec');
    const path = require('path');
    const fs = require('fs');
    // Ensure temp directory exists in project root
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempFilePath = path.join(tempDir, `discordbot_${guildId}_${Date.now()}.webm`);
    console.log('Downloading opus audio to', tempFilePath);
    await ytdlp(song.url, {
      output: tempFilePath,
      format: '251/bestaudio', // 251 is opus/webm
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
      ]
    });
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('yt-dlp did not create the temp file');
    }
    // Store temp file path in queue for cleanup
    queue.tempFilePath = tempFilePath;
    queues.set(guildId, queue);
    // Mark file as in use
    activeTempFiles.add(tempFilePath);
    const stream = {
      stream: fs.createReadStream(tempFilePath),
      type: 'webm/opus',
    };
    // If stream.stream is a URL or stream, createAudioResource can accept it directly
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
      // Clean up temp file if used
      if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
        fs.unlink(queue.tempFilePath, (err) => {
          if (err) console.error('Failed to delete temp file:', err);
        });
        activeTempFiles.delete(queue.tempFilePath);
        queue.tempFilePath = null;
        queues.set(guildId, queue);
      }
      playSong(guild, voiceChannel);
    });

    player.on('error', (err) => {
      console.error('Playback error:', err);
      // Clean up temp file if used
      if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
        fs.unlink(queue.tempFilePath, (err) => {
          if (err) console.error('Failed to delete temp file:', err);
        });
        activeTempFiles.delete(queue.tempFilePath);
        queue.tempFilePath = null;
        queues.set(guildId, queue);
      }
      playSong(guild, voiceChannel); // Skip on error
    });

  } catch (err) {
    console.error('Streaming error:', err);
    // Optionally notify the user in the channel
    try {
      const textChannel = guild.channels.cache.find(
        (ch) => ch.type === 0 && ch.permissionsFor(client.user).has('SendMessages')
      );
      if (textChannel) {
        textChannel.send(`❌ Error streaming: ${song.url}\n${err.message}`);
      }
    } catch (notifyErr) {
      console.error('Failed to notify channel of streaming error:', notifyErr);
    }
    playSong(guild, voiceChannel); // Skip to next
  }
}

function stopPlayback(guild) {
  const guildId = guild.id;
  const queue = queues.get(guildId);

  if (queue) {
    // Clean up temp file if used
    const fs = require('fs');
    if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
      fs.unlink(queue.tempFilePath, (err) => {
        if (err) console.error('Failed to delete temp file:', err);
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
  if (connection) {
    connection.destroy();
  }

  queues.delete(guildId);
}

function disconnectAfterTimeout(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  queue.timeout = setTimeout(() => {
    console.log(`💤 Inactive for 5 minutes, leaving guild ${guildId}`);
    stopPlayback({ id: guildId });
  }, TIMEOUT);

  queues.set(guildId, queue);
}



// Auto leave if bot is alone or bot is disconnected from a voice channel
client.on('voiceStateUpdate', (oldState, newState) => {
  const botId = client.user.id;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;



  // Only disconnect if the bot is the only member left in the old channel (no humans)
  if (oldChannel && oldChannel.members.has(botId)) {
    // Exclude the bot itself from the count
    const humanCount = oldChannel.members.filter(m => !m.user.bot).size;
    const botCount = oldChannel.members.filter(m => m.user.bot).size;
    console.log(`[DEBUG] voiceStateUpdate: oldChannel=${oldChannel.id}, humanCount=${humanCount}, botCount=${botCount}`);
    // If only the bot is left (no humans), disconnect
    if (humanCount === 0 && botCount === 1) {
      console.log('[DEBUG] Bot is the only member left, disconnecting...');
      stopPlayback(oldState.guild);
      return;
    }
  }

  // Bot was disconnected from a voice channel (kicked or left by user action)
  // Only run this if the state update is for the bot itself
  if (oldState.id === botId) {
    if (
      oldChannel &&
      oldChannel.members.has(botId) &&
      (!newChannel || !newChannel.members.has(botId))
    ) {
      console.log('[DEBUG] Bot itself was disconnected from the channel, cleaning up.');
      stopPlayback(oldState.guild);
      return;
    }
  }
});

// Clean up temp file if bot is disconnected or kicked from a guild
client.on('guildDelete', (guild) => {
  const guildId = guild.id;
  const queue = queues.get(guildId);
  if (queue && queue.tempFilePath) {
    const fs = require('fs');
    if (fs.existsSync(queue.tempFilePath)) {
      fs.unlink(queue.tempFilePath, (err) => {
        if (err) console.error('Failed to delete temp file on guildDelete:', err);
        else console.log(`Deleted temp file for guild ${guildId} on guildDelete.`);
      });
      activeTempFiles.delete(queue.tempFilePath);
    }
    queue.tempFilePath = null;
    queues.set(guildId, queue);
  }
});

// Periodically clean up unused temp files (every 10 minutes)
setInterval(() => {
  const fs = require('fs');
  const path = require('path');
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) return;
  fs.readdir(tempDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      // Only delete if not in use
      if (!activeTempFiles.has(filePath)) {
        fs.unlink(filePath, (err) => {
          if (!err) console.log('Deleted unused temp file:', filePath);
        });
      }
    });
  });
}, 10 * 60 * 10000); // 10 minutes

client.login(TOKEN);

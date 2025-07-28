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
const preDownloadedFiles = new Map(); // Map to store pre-downloaded files: url -> filePath

// Helper function to extract video ID from YouTube URL
function getVideoId(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get('v');
  } catch {
    return null;
  }
}

// Helper function to get cached file path
function getCachedFilePath(url) {
  const videoId = getVideoId(url);
  if (!videoId) return null;
  
  const path = require('path');
  const tempDir = path.join(__dirname, 'temp');
  return path.join(tempDir, `${videoId}.webm`);
}

// Helper function to check if song is cached
function isSongCached(url) {
  const cachedPath = getCachedFilePath(url);
  if (!cachedPath) return false;
  
  const fs = require('fs');
  return fs.existsSync(cachedPath);
}

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

async function preDownloadSong(url, guildId) {
  try {
    // Check if already cached
    if (isSongCached(url)) {
      console.log(`✅ Song already cached: ${url}`);
      return getCachedFilePath(url);
    }

    const videoId = getVideoId(url);
    if (!videoId) {
      console.error(`❌ Could not extract video ID from: ${url}`);
      return null;
    }

    const ytdlp = require('yt-dlp-exec');
    const path = require('path');
    const fs = require('fs');
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const tempFilePath = path.join(tempDir, `${videoId}.webm`);
    
    console.log(`🔄 Pre-downloading: ${url}`);
    await ytdlp(url, {
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

    if (fs.existsSync(tempFilePath)) {
      preDownloadedFiles.set(url, tempFilePath);
      activeTempFiles.add(tempFilePath);
      console.log(`✅ Pre-downloaded and cached: ${url}`);
      return tempFilePath;
    }
  } catch (err) {
    console.error(`❌ Pre-download failed for ${url}:`, err.message);
  }
  return null;
}

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

    // Clear any existing timeout when adding a new song
    if (queue.timeout) {
      clearTimeout(queue.timeout);
      queue.timeout = null;
    }

    queue.songs.push({ url: inputUrl, requestedBy: message.author.username });
    queue.playing = queue.playing || false;
    queues.set(guildId, queue);

    message.channel.send(`🎶 Added to queue: ${inputUrl}`);

    // Pre-download the song if it's not the first in queue (will be played immediately) and not already cached
    if ((queue.songs.length > 1 || queue.playing) && !isSongCached(inputUrl)) {
      preDownloadSong(inputUrl, guildId);
    }

    if (!queue.playing || !getVoiceConnection(guildId)) {
      playSong(message.guild, voiceChannel);
    }
  }

  if (cmd === 'next' || cmd === 'skip') {
    if (!voiceChannel) return message.reply('🔊 Join a voice channel first.');
    
    const queue = queues.get(guildId);
    if (!queue || !queue.playing) {
      return message.reply('❌ No song is currently playing.');
    }

    // Check if there are any songs in the queue
    if (!queue.songs || queue.songs.length === 0) {
      return message.reply('❌ No next song is available in the queue.');
    }

    // Clean up current temp file (but preserve cached songs)
    if (queue.tempFilePath) {
      const fs = require('fs');
      const path = require('path');
      if (fs.existsSync(queue.tempFilePath)) {
        const fileName = path.basename(queue.tempFilePath);
        // Check if this is a cached file (format: {videoId}.webm)
        const isCachedFile = /^[a-zA-Z0-9_-]{11}\.webm$/.test(fileName);
        
        if (!isCachedFile) {
          // Only delete if it's NOT a cached file
          fs.unlink(queue.tempFilePath, (err) => {
            if (err) console.error('Temp delete failed:', err);
          });
          activeTempFiles.delete(queue.tempFilePath);
        }
      }
      queue.tempFilePath = null;
    }

    // Stop current player and play next song
    const connection = getVoiceConnection(guildId);
    if (connection && connection.state.subscription) {
      connection.state.subscription.player.stop();
    }
    
    message.channel.send('⏭️ Skipped to next song.');
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
  queue.timeout = null;
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

    let tempFilePath;
    
    // First, check if song is already cached
    if (isSongCached(song.url)) {
      tempFilePath = getCachedFilePath(song.url);
      console.log(`🎵 Using cached file: ${song.url}`);
    }
    // Then check if we have a pre-downloaded file for this song
    else if (preDownloadedFiles.has(song.url)) {
      tempFilePath = preDownloadedFiles.get(song.url);
      preDownloadedFiles.delete(song.url);
      console.log(`🎵 Using pre-downloaded file: ${song.url}`);
    } 
    // Finally, download the song now with cached filename
    else {
      const videoId = getVideoId(song.url);
      if (!videoId) {
        throw new Error('Could not extract video ID from URL');
      }
      
      tempFilePath = path.join(tempDir, `${videoId}.webm`);
      console.log(`🔄 Downloading and caching: ${song.url}`);
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
      console.log(`✅ Downloaded and cached: ${song.url}`);
    }
    
    if (!fs.existsSync(tempFilePath)) throw new Error('Audio file not available');

    queue.tempFilePath = tempFilePath;
    queues.set(guildId, queue);
    activeTempFiles.add(tempFilePath);

    // Pre-download next song in queue if available and not cached
    if (queue.songs.length > 0) {
      const nextSong = queue.songs[0];
      if (!isSongCached(nextSong.url) && !preDownloadedFiles.has(nextSong.url)) {
        preDownloadSong(nextSong.url, guildId);
      }
    }

    const resource = createAudioResource(fs.createReadStream(tempFilePath), {
      inputType: 'webm/opus',
    });

    const player = createAudioPlayer();
    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
      // Don't delete cached files (files with video ID names), only delete temporary files
      if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
        const fileName = path.basename(queue.tempFilePath);
        const videoId = getVideoId(song.url);
        
        // Only delete if it's NOT a cached file (doesn't match video ID pattern)
        if (!videoId || fileName !== `${videoId}.webm`) {
          fs.unlink(queue.tempFilePath, (err) => {
            if (err) console.error('Temp delete failed:', err);
          });
          activeTempFiles.delete(queue.tempFilePath);
        }
        queue.tempFilePath = null;
        queues.set(guildId, queue);
      }
      playSong(guild, voiceChannel);
    });

    player.on('error', (err) => {
      console.error('Playback error:', err);
      // Don't delete cached files (files with video ID names), only delete temporary files
      if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
        const fileName = path.basename(queue.tempFilePath);
        const videoId = getVideoId(song.url);
        
        // Only delete if it's NOT a cached file (doesn't match video ID pattern)
        if (!videoId || fileName !== `${videoId}.webm`) {
          fs.unlink(queue.tempFilePath, (err) => {
            if (err) console.error('Temp delete failed:', err);
          });
          activeTempFiles.delete(queue.tempFilePath);
        }
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
  const path = require('path');

  if (queue) {
    // Only clean up non-cached temp files
    if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
      const fileName = path.basename(queue.tempFilePath);
      // Check if this is a cached file (format: {videoId}.webm)
      const isCachedFile = /^[a-zA-Z0-9_-]{11}\.webm$/.test(fileName);
      
      if (!isCachedFile) {
        // Only delete if it's NOT a cached file
        fs.unlink(queue.tempFilePath, (err) => {
          if (err) console.error('Temp delete failed:', err);
        });
        activeTempFiles.delete(queue.tempFilePath);
      }
      queue.tempFilePath = null;
    }
    
    // Only clean up pre-downloaded files (not permanently cached ones)
    queue.songs.forEach(song => {
      if (preDownloadedFiles.has(song.url)) {
        const filePath = preDownloadedFiles.get(song.url);
        if (fs.existsSync(filePath)) {
          const fileName = path.basename(filePath);
          // Check if this is a cached file
          const isCachedFile = /^[a-zA-Z0-9_-]{11}\.webm$/.test(fileName);
          
          if (!isCachedFile) {
            // Only delete pre-download temp files, not cached songs
            fs.unlink(filePath, (err) => {
              if (err) console.error('Pre-downloaded file delete failed:', err);
            });
            activeTempFiles.delete(filePath);
          }
        }
        preDownloadedFiles.delete(song.url);
      }
    });
    
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
  const fs = require('fs');
  const path = require('path');
  
  if (queue) {
    // Only delete non-cached temp files
    if (queue.tempFilePath && fs.existsSync(queue.tempFilePath)) {
      const fileName = path.basename(queue.tempFilePath);
      // Check if this is a cached file (format: {videoId}.webm)
      const isCachedFile = /^[a-zA-Z0-9_-]{11}\.webm$/.test(fileName);
      
      if (!isCachedFile) {
        fs.unlink(queue.tempFilePath, (err) => {
          if (err) console.error('Temp delete on guildDelete failed:', err);
          else console.log(`Deleted temp file on guildDelete for ${guildId}`);
        });
        activeTempFiles.delete(queue.tempFilePath);
      } else {
        console.log(`Preserved cached file on guildDelete: ${fileName}`);
      }
    }
    
    // Only clean up pre-downloaded files (not permanently cached ones)
    queue.songs.forEach(song => {
      if (preDownloadedFiles.has(song.url)) {
        const filePath = preDownloadedFiles.get(song.url);
        if (fs.existsSync(filePath)) {
          const fileName = path.basename(filePath);
          // Check if this is a cached file
          const isCachedFile = /^[a-zA-Z0-9_-]{11}\.webm$/.test(fileName);
          
          if (!isCachedFile) {
            fs.unlink(filePath, (err) => {
              if (err) console.error('Pre-downloaded file delete on guildDelete failed:', err);
              else console.log(`Deleted pre-downloaded file on guildDelete: ${filePath}`);
            });
            activeTempFiles.delete(filePath);
          } else {
            console.log(`Preserved cached file on guildDelete: ${fileName}`);
          }
        }
        preDownloadedFiles.delete(song.url);
      }
    });
    
    queue.tempFilePath = null;
    queues.set(guildId, queue);
  }
});


// Weekly cleanup - Delete everything in temp folder every 7 days
setInterval(() => {
  const fs = require('fs');
  const path = require('path');
  const tempDir = path.join(__dirname, 'temp');
  
  console.log('🧹 Starting weekly cleanup of temp folder...');
  
  if (!fs.existsSync(tempDir)) {
    console.log('✅ Temp folder doesn\'t exist, skipping weekly cleanup.');
    return;
  }

  fs.readdir(tempDir, (err, files) => {
    if (err) {
      console.error('❌ Error reading temp directory for weekly cleanup:', err);
      return;
    }

    let deletedCount = 0;
    let failedCount = 0;

    if (files.length === 0) {
      console.log('✅ Temp folder is already empty.');
      return;
    }

    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(`❌ Failed to delete ${file}:`, err.message);
          failedCount++;
        } else {
          console.log(`🗑️ Deleted: ${file}`);
          deletedCount++;
          
          // Remove from tracking maps
          activeTempFiles.delete(filePath);
          for (const [url, path] of preDownloadedFiles.entries()) {
            if (path === filePath) {
              preDownloadedFiles.delete(url);
              break;
            }
          }
        }
        
        // Log summary when all files are processed
        if (deletedCount + failedCount === files.length) {
          console.log(`✅ Weekly cleanup completed: ${deletedCount} deleted, ${failedCount} failed`);
        }
      });
    });
  });
}, 7 * 24 * 60 * 60 * 1000); // 7 days in milliseconds

client.login(TOKEN);

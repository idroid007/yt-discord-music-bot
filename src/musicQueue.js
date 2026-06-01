'use strict';

const fs = require('fs');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const { config } = require('./config');
const cache = require('./cache');

const managers = new Map(); // guildId -> GuildMusic

/** Format seconds as m:ss for display. */
function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return ` \`${m}:${s}\``;
}

class GuildMusic {
  constructor(guild) {
    this.guild = guild;
    this.songs = []; // { id, title, url, durationSec, requestedBy }
    this.current = null;
    this.currentFile = null;
    this.connection = null;
    this.voiceChannelId = null;
    this.textChannel = null;
    this.idleTimer = null;
    this.destroyed = false;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on(AudioPlayerStatus.Idle, () => this._onTrackEnd());
    this.player.on('error', (err) => {
      console.error(`Player error in guild ${guild.id}:`, err.message);
      this._onTrackEnd();
    });
  }

  say(content) {
    if (this.textChannel) this.textChannel.send(content).catch(() => {});
  }

  /** Add a track and start playback if nothing is playing yet. */
  async enqueue(track, { voiceChannel, textChannel }) {
    this.textChannel = textChannel;
    this.voiceChannelId = voiceChannel.id;
    this._clearIdleTimer();
    this.songs.push(track);

    const position = this.songs.length + (this.current ? 1 : 0);
    if (!this.current) {
      await this._connect(voiceChannel);
      this._playNext();
    } else {
      this.say(`➕ Queued **${track.title}**${fmtDuration(track.durationSec)} (position ${position - 1})`);
      this._prefetch();
    }
  }

  async _connect(voiceChannel) {
    const existing = this.connection;
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
      return existing;
    }
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      // Helps when the host is behind NAT / cannot determine its own UDP address.
      selfDeaf: true,
    });
    connection.subscribe(this.player);

    connection.on('error', (err) => {
      console.error(`Voice error in guild ${this.guild.id}:`, err?.message || err);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Could be a move/reconnect — give it a moment before tearing down.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.stop();
      }
    });

    this.connection = connection;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      console.error(`Voice connection failed in guild ${this.guild.id}: ${err.message}`);
      this.stop();
      throw new Error('could not establish a voice connection');
    }
    return connection;
  }

  async _playNext() {
    if (this.destroyed) return;

    this._releaseCurrentFile();
    const track = this.songs.shift();
    if (!track) {
      this.current = null;
      this._scheduleIdleDisconnect();
      return;
    }

    this.current = track;
    let filePath;
    try {
      this.say(`⬇️ Loading **${track.title}**…`);
      filePath = await cache.getOrDownload(track);
    } catch (err) {
      console.error(`Download failed for ${track.url}:`, err.message);
      this.say(`❌ Couldn't load **${track.title}** — skipping.`);
      return this._playNext();
    }

    if (this.destroyed) return;

    cache.markInUse(filePath);
    this.currentFile = filePath;

    try {
      const resource = createAudioResource(fs.createReadStream(filePath), {
        inlineVolume: true,
      });
      this.player.play(resource);
      this.say(`🎶 Now playing **${track.title}**${fmtDuration(track.durationSec)} — requested by ${track.requestedBy}`);
    } catch (err) {
      console.error(`Failed to start playback for ${track.url}:`, err.message);
      this.say(`❌ Playback error on **${track.title}** — skipping.`);
      return this._playNext();
    }

    this._prefetch();
  }

  /** Warm the cache for the next queued song so transitions are gapless. */
  _prefetch() {
    const next = this.songs[0];
    if (!next) return;
    cache.getOrDownload(next).catch((err) => {
      console.error(`Prefetch failed for ${next.url}:`, err.message);
    });
  }

  _onTrackEnd() {
    if (this.destroyed) return;
    this._playNext();
  }

  skip() {
    if (!this.current) return false;
    // Stopping the player triggers Idle -> _playNext().
    this.player.stop(true);
    return true;
  }

  _releaseCurrentFile() {
    if (this.currentFile) {
      cache.releaseInUse(this.currentFile);
      this.currentFile = null;
    }
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _scheduleIdleDisconnect() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      console.log(`💤 Idle timeout in guild ${this.guild.id} — leaving.`);
      this.stop();
    }, config.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  stop() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._clearIdleTimer();
    this.songs = [];
    this.current = null;
    this._releaseCurrentFile();

    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        this.connection.destroy();
      } catch {
        /* ignore */
      }
    }
    this.connection = null;
    managers.delete(this.guild.id);
  }

  describeQueue() {
    const lines = [];
    if (this.current) {
      lines.push(`**Now playing:** ${this.current.title}${fmtDuration(this.current.durationSec)}`);
    }
    if (this.songs.length) {
      lines.push('**Up next:**');
      this.songs.slice(0, 10).forEach((s, i) => {
        lines.push(`${i + 1}. ${s.title}${fmtDuration(s.durationSec)} — ${s.requestedBy}`);
      });
      if (this.songs.length > 10) lines.push(`…and ${this.songs.length - 10} more`);
    }
    return lines.length ? lines.join('\n') : 'The queue is empty.';
  }
}

function getManager(guild, create = false) {
  let mgr = managers.get(guild.id);
  if (mgr && mgr.destroyed) mgr = undefined;
  if (!mgr && create) {
    mgr = new GuildMusic(guild);
    managers.set(guild.id, mgr);
  }
  return mgr;
}

module.exports = { getManager, managers };

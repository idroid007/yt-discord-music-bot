'use strict';

const path = require('path');
require('dotenv').config();

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  // Discord
  token: process.env.DISCORD_TOKEN,
  prefix: process.env.PREFIX || '!',

  // yt-dlp
  // Path to the yt-dlp binary. Defaults to whatever is on PATH.
  ytDlpPath: process.env.YT_DLP_PATH || 'yt-dlp',
  // Optional Netscape-format cookies file (helps with age-gated / bot-checked videos).
  cookiesFile: process.env.YT_DLP_COOKIES || null,
  // Run `yt-dlp -U` on startup so the binary stays current (fixes most 403s).
  autoUpdateYtDlp: process.env.YT_DLP_AUTO_UPDATE !== 'false',

  // Cache
  cacheDir: process.env.CACHE_DIR || path.join(__dirname, '..', 'temp'),
  // How long a downloaded file lives before the sweeper deletes it (ms). Default 24h.
  cacheTtlMs: intFromEnv('CACHE_TTL_HOURS', 24) * 60 * 60 * 1000,
  // How often the sweeper runs (ms). Default 1h.
  sweepIntervalMs: intFromEnv('CACHE_SWEEP_MINUTES', 60) * 60 * 1000,

  // Playback
  // Leave the voice channel after this much idle time with an empty queue (ms). Default 5 min.
  idleTimeoutMs: intFromEnv('IDLE_TIMEOUT_MINUTES', 5) * 60 * 1000,
};

function validate() {
  if (!config.token) {
    throw new Error('DISCORD_TOKEN is missing. Set it in your .env file.');
  }
}

module.exports = { config, validate };

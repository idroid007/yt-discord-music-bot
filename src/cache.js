'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { config } = require('./config');
const ytdlp = require('./ytdlp');

// Paths currently being played/queued — never swept while in use.
const inUse = new Set();
// videoId -> Promise<string> de-duplicates concurrent downloads of the same video.
const inFlight = new Map();

function ensureDir() {
  fs.mkdirSync(config.cacheDir, { recursive: true });
}

/** Find an existing, non-empty cached file for a video id, or null. */
function findCached(videoId) {
  ensureDir();
  let entries;
  try {
    entries = fs.readdirSync(config.cacheDir);
  } catch {
    return null;
  }
  const match = entries.find((name) => name.startsWith(`${videoId}.`));
  if (!match) return null;

  const full = path.join(config.cacheDir, match);
  try {
    const stat = fs.statSync(full);
    if (stat.isFile() && stat.size > 1024) return full;
  } catch {
    /* fall through */
  }
  return null;
}

function markInUse(filePath) {
  if (filePath) inUse.add(filePath);
}

function releaseInUse(filePath) {
  if (filePath) inUse.delete(filePath);
}

/**
 * Return the path to a cached audio file for the track, downloading it if needed.
 * Concurrent calls for the same video share a single download.
 */
async function getOrDownload(track) {
  const cached = findCached(track.id);
  if (cached) return cached;

  if (inFlight.has(track.id)) return inFlight.get(track.id);

  const promise = (async () => {
    ensureDir();
    const template = path.join(config.cacheDir, `${track.id}.%(ext)s`);
    const filePath = await ytdlp.download(track.url, template);
    // Stamp mtime to "now" so the 24h TTL is measured from download time.
    const now = new Date();
    await fsp.utimes(filePath, now, now).catch(() => {});
    return filePath;
  })();

  inFlight.set(track.id, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(track.id);
  }
}

/** Delete cached files older than the TTL, skipping any that are in use. */
async function sweep() {
  ensureDir();
  let entries;
  try {
    entries = await fsp.readdir(config.cacheDir);
  } catch {
    return;
  }

  const cutoff = Date.now() - config.cacheTtlMs;
  let deleted = 0;
  for (const name of entries) {
    const full = path.join(config.cacheDir, name);
    if (inUse.has(full)) continue;
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(full);
        deleted += 1;
      }
    } catch {
      /* ignore individual file errors */
    }
  }
  if (deleted > 0) {
    console.log(`🧹 Cache sweep removed ${deleted} expired file(s).`);
  }
}

let sweeper = null;
function startSweeper() {
  if (sweeper) return;
  sweep().catch((err) => console.error('Initial cache sweep failed:', err));
  sweeper = setInterval(() => {
    sweep().catch((err) => console.error('Cache sweep failed:', err));
  }, config.sweepIntervalMs);
  sweeper.unref?.();
}

module.exports = {
  ensureDir,
  findCached,
  getOrDownload,
  markInUse,
  releaseInUse,
  sweep,
  startSweeper,
};

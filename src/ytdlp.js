'use strict';

const { execFile } = require('child_process');
const { config } = require('./config');

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Run yt-dlp with the given arguments. Resolves with { stdout, stderr }.
 * Rejects with an Error whose .stderr contains yt-dlp's diagnostics.
 */
function run(args, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      config.ytDlpPath,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const wrapped = new Error(
            `yt-dlp failed (${err.code ?? err.signal ?? 'unknown'}): ${(stderr || err.message).trim()}`
          );
          wrapped.stderr = stderr;
          wrapped.stdout = stdout;
          wrapped.cause = err;
          return reject(wrapped);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/** Arguments shared by every invocation, including reliability/anti-403 tweaks. */
function commonArgs() {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--no-check-certificates',
    '--retries',
    '5',
    '--fragment-retries',
    '5',
    // Use multiple player clients; if one is blocked yt-dlp falls back to another.
    '--extractor-args',
    'youtube:player_client=default,web_safari,android',
  ];
  if (config.cookiesFile) {
    args.push('--cookies', config.cookiesFile);
  }
  return args;
}

/** Print the installed yt-dlp version, throwing a clear error if it isn't found. */
async function version() {
  try {
    const { stdout } = await run(['--version'], { timeoutMs: 30 * 1000 });
    return stdout.trim();
  } catch (err) {
    throw new Error(
      `Could not run yt-dlp at "${config.ytDlpPath}". Install it (pip install -U yt-dlp) ` +
        `or set YT_DLP_PATH. Original error: ${err.message}`
    );
  }
}

/** Best-effort self-update so YouTube changes don't break playback. */
async function selfUpdate() {
  try {
    const { stdout } = await run(['-U'], { timeoutMs: 60 * 1000 });
    return stdout.trim();
  } catch (err) {
    // pip-installed yt-dlp can't self-update; that's fine — just log and move on.
    return `update skipped: ${err.message.split('\n')[0]}`;
  }
}

/**
 * Resolve a URL or free-text search into a normalized track.
 * Returns { id, title, url, durationSec, uploader }.
 */
async function resolve(query) {
  const trimmed = query.trim();
  const isUrl = /^https?:\/\//i.test(trimmed);
  const target = isUrl ? trimmed : `ytsearch1:${trimmed}`;

  const { stdout } = await run([
    ...commonArgs(),
    '--dump-single-json',
    '--skip-download',
    target,
  ]);

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp returned no parseable result for that query.');
  }

  // ytsearch returns a playlist-style object with an entries array.
  if (Array.isArray(info.entries)) {
    info = info.entries.find(Boolean);
    if (!info) throw new Error('No results found.');
  }

  if (!info.id || !YOUTUBE_ID_RE.test(info.id)) {
    throw new Error('Resolved item is not a standard YouTube video.');
  }

  return {
    id: info.id,
    title: info.title || info.id,
    url: `https://www.youtube.com/watch?v=${info.id}`,
    durationSec: typeof info.duration === 'number' ? info.duration : null,
    uploader: info.uploader || info.channel || null,
  };
}

/**
 * Download bestaudio for a video to `outputTemplate` (a yt-dlp -o template).
 * Returns the absolute path of the file that was written.
 */
async function download(url, outputTemplate) {
  const { stdout } = await run([
    ...commonArgs(),
    '-f',
    'bestaudio/best',
    '-o',
    outputTemplate,
    // Print the final filepath so we don't have to guess the extension.
    '--print',
    'after_move:filepath',
    '--no-simulate',
    url,
  ]);

  const filepath = stdout.trim().split('\n').filter(Boolean).pop();
  if (!filepath) {
    throw new Error('Download finished but yt-dlp did not report a file path.');
  }
  return filepath;
}

module.exports = { run, version, selfUpdate, resolve, download, YOUTUBE_ID_RE };

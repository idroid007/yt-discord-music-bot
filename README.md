# 🎵 YouTube Discord Music Bot

A personal Discord music bot. You give it a YouTube URL (or search terms), it
downloads the audio with **yt-dlp**, caches the file for a day so it never
re-downloads the same song, and streams it into your voice channel.

## How it works

1. `!play <url | search>` — joins your voice channel and plays the song.
2. `!play` again while something is playing — adds the song to the queue.
3. Each song is downloaded to `temp/` (named by its YouTube video id) the first
   time it's requested. Subsequent plays reuse the cached file instantly.
4. Cached files are **auto-deleted ~24h after download** by a background sweeper.
5. The next queued song is pre-downloaded in the background for gapless playback.
6. The bot leaves when it's alone in the channel or after 5 minutes idle.

## Commands

| Command | Aliases | Description |
| --- | --- | --- |
| `!play <url \| search terms>` | `!p` | Play or queue a song |
| `!skip` | `!next` | Skip the current song |
| `!stop` | `!leave` | Stop playback and leave |
| `!queue` | `!q` | Show the current queue |
| `!help` | | Show command help |

## Why the rewrite (the HTTP 403 fix)

The old version relied on `yt-dlp-exec`, which ships a **bundled yt-dlp binary
that goes stale**. When YouTube changes its player/signature logic, an outdated
yt-dlp starts failing with `HTTP Error 403: Forbidden`.

This version calls a **system yt-dlp binary** and runs `yt-dlp -U` on startup so
it stays current. In Docker the binary is the official self-updating standalone
release. Keeping yt-dlp fresh is what prevents the 403s.

## Running with Docker (recommended)

```bash
# 1. Create .env with your bot token
echo "DISCORD_TOKEN=your_token_here" > .env

# 2. Build and run
docker compose up -d --build
```

The audio cache is stored in a named volume (`music-cache`) so it survives
restarts. yt-dlp self-updates each time the container starts.

## Running locally

Prerequisites:

- **Node.js 20+**
- **Python 3** and **yt-dlp** on your PATH (`pip install -U yt-dlp`)
- A C/C++ toolchain (needed to build `@discordjs/opus`)
- ffmpeg is provided via `ffmpeg-static`, so no separate install is required.

```bash
npm install
echo "DISCORD_TOKEN=your_token_here" > .env
npm start
```

## Configuration (.env)

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | _(required)_ | Your Discord bot token |
| `PREFIX` | `!` | Command prefix |
| `YT_DLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `YT_DLP_COOKIES` | _(none)_ | Path to a Netscape `cookies.txt` for age-gated / bot-checked videos |
| `YT_DLP_AUTO_UPDATE` | `true` | Run `yt-dlp -U` on startup (set `false` to skip) |
| `CACHE_DIR` | `./temp` | Where downloaded audio is cached |
| `CACHE_TTL_HOURS` | `24` | Hours a cached file lives before deletion |
| `CACHE_SWEEP_MINUTES` | `60` | How often the cleanup sweeper runs |
| `IDLE_TIMEOUT_MINUTES` | `5` | Idle minutes before the bot leaves the channel |

### Using cookies

If some videos still fail (age restrictions, "sign in to confirm you're not a
bot"), export your YouTube cookies to a Netscape-format `cookies.txt` and point
`YT_DLP_COOKIES` at it (or mount it in `docker-compose.yml`).

## Creating a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and create a New Application.
2. Under **Bot**, create a bot and copy its token into `.env`.
3. Enable the **Message Content Intent**.
4. Under **OAuth2 → URL Generator**, select the `bot` scope with **Connect**,
   **Speak**, **Send Messages**, and **Read Message History** permissions, then
   invite the bot to your server.

## Project layout

```
index.js            Discord client + command handling + startup
src/config.js       Environment configuration
src/ytdlp.js        yt-dlp wrapper (resolve / search / download / self-update)
src/cache.js        Cache paths, download de-duplication, 24h TTL sweeper
src/musicQueue.js   Per-guild queue, audio player, voice connection
Dockerfile          Standalone self-updating yt-dlp + ffmpeg + Node
docker-compose.yml  One-command deploy with a persistent cache volume
```

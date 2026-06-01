FROM node:20-bookworm-slim

WORKDIR /app

# Runtime deps: python3 + ffmpeg for yt-dlp, build tools for @discordjs/opus native addon.
# yt-dlp is installed as the standalone binary so `yt-dlp -U` self-updates at startup
# (this is what keeps YouTube 403 errors away).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ffmpeg ca-certificates curl build-essential \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
         -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    CACHE_DIR=/app/temp

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Cache directory for downloaded audio (mount a volume here to persist across restarts).
VOLUME ["/app/temp"]

CMD ["node", "index.js"]

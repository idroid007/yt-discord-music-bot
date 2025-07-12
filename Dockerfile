FROM node:20

WORKDIR /app

# Install Python for yt-dlp-exec
RUN apt-get update && apt-get install -y python3

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["node", "app.js"]

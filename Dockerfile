FROM node:20

WORKDIR /app

# Install Python for yt-dlp-exec and create a symlink for 'python'
RUN apt-get update && apt-get install -y python3 && ln -s /usr/bin/python3 /usr/bin/python

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["node", "app.js"]

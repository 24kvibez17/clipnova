FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates && pip3 install --break-system-packages --no-cache-dir yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/clips
ENV NODE_ENV=production
EXPOSE 4173
CMD ["npm", "start"]

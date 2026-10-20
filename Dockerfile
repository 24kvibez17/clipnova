
FROM node:20-bookworm-slim

ENV DENO_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
    unzip \
    && pip3 install --break-system-packages --no-cache-dir --upgrade "yt-dlp[default]" \
    && curl -fsSL https://deno.land/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /app/clips

ENV NODE_ENV=production

EXPOSE 4173

CMD ["npm", "start"]

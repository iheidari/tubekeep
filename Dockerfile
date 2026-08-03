# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    PATH=/usr/local/bin:/usr/bin:/bin \
    DOWNLOADS_DIR=/data/downloads

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force

COPY backend/ ./backend/
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /data/downloads

# yt-dlp needs frequent updates — YouTube breaks extraction every few weeks.
# Installed LAST so the daily cache-bust below only invalidates this layer, not
# the apt/npm layers above it. The scheduled build passes a fresh YTDLP_BUST
# (the workflow run id), which changes the RUN's cache key so pip always pulls
# the newest release instead of reusing a stale cached layer.
ARG YTDLP_BUST=none
RUN echo "yt-dlp build bust: ${YTDLP_BUST}" \
 && pip install --break-system-packages --no-cache-dir --upgrade "yt-dlp[default]" \
 && yt-dlp --version

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "backend/src/server.js"]

# Headless-режим: стрим торрента в браузер (без VLC, нет дисплея в контейнере).
# VLC-плеер остаётся для локального запуска на хосте.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY wtui.js ./
EXPOSE 8123
# docker run -p 8123:8123 -v ~/torrent-cache:/cache torrent-online \
#   node wtui.js <magnet|torrent> --lan --no-vlc --port=8123
CMD ["node", "wtui.js", "--lan", "--no-vlc", "--port=8123"]

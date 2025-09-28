# TorrentOnline

Стрим из `.torrent` и `magnet:` в **VLC**. Один процесс VLC на весь плейлист. Кэш чистится после выхода (можно отключить).

## Быстрый старт
```bash
git clone https://github.com/IamCaptainPepe/torrent-online.git
cd torrent-online
npm i
node wtui.js
```
Флаги:
- `--keep-cache` — не удалять кэш после закрытия VLC
- `--network-caching=<ms>` — прокинуть в VLC (по умолчанию 1500)

Кэш по умолчанию: `~/Movies/WebTorrent` (`/Users/<you>/Movies/WebTorrent`).

## .app (macOS)
`.app` открывает **Terminal** и запускает скрипт.
```bash
./build/app.sh
open dist/TorrentOnline.app
```
DMG по желанию:
```bash
brew install create-dmg
./build/app.sh
open dist/TorrentOnline.dmg
```

## Требования
- macOS 11+
- Node.js ≥ 18
- VLC (`/Applications/VLC.app` или в PATH)

## Что внутри
- локальный HTTP‑сервер (fallback) с Range
- сортировка `.torrent` в меню — новые сверху
- очистка кэша после выхода (отключается флагом)

## Структура
```
.
├─ wtui.js          # основной скрипт (ESM)
├─ package.json
├─ build/
│  └─ app.sh        # сборка .app (Terminal launcher)
├─ dist/
│  └─ TorrentOnline.app  # результат сборки (после build)
└─ README.md
```

## Частые вопросы
- **Node не виден из .app** — .app запускает `zsh -l`, PATH подтянется. Если нет — проверь `which node`.
- **«Writable stream closed prematurely»** — VLC рвёт пробные коннекты; мы их игнорим.
- **Порт занят** — авто‑поиск в диапазоне 8123..10122.

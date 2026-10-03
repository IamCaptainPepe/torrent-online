# TorrentOnline

Стрим из `.torrent` и `magnet:` в **VLC** или прямо в **браузер**. Один процесс VLC на весь плейлист. Кэш чистится после выхода (можно отключить).

## Быстрый старт
```bash
git clone https://github.com/IamCaptainPepe/torrent-online.git
cd torrent-online
npm i
node wtui.js
```

CLI без меню (играют все видеофайлы торрента):
```bash
node wtui.js film.torrent
node wtui.js "magnet:?xt=urn:btih:..."
```

## Флаги
| Флаг | Что делает |
|---|---|
| `--keep-cache` | не удалять кэш после закрытия VLC |
| `--network-caching=<ms>` | прокинуть в VLC (по умолчанию 3000) |
| `--resume` | продолжить с прошлой позиции (VLC `--start-time`) |
| `--lan` | слушать 0.0.0.0 + токен в URL — смотреть с телефона/ТВ в сети |
| `--no-vlc` | только браузер-стриминг, без VLC |
| `--port=<N>` | фиксированный порт (иначе авто-поиск 8123..10122) |
| `--help` | справка |

Кэш по умолчанию: `~/Movies/WebTorrent`. **Внимание: папка кэша удаляется после выхода** (кроме `--keep-cache`) — промпт об этом предупреждает.

## Возможности (v1.4)
- 🔎 Поиск торрентов прямо в меню (1337x API, fallback TPB RSS) → magnet
- 🌐 Стрим в браузер: страница с плеером на `/`, режим `--lan` с токеном
- 📺 Субтитры из торрента (`.srt/.ass/.ssa/.vtt`) → `--sub-file=` в VLC
- ▶️ `--resume`: позиция сохраняется в `~/.config/torrent-online/state.json`
- 📥 Watch-папка: `~/Downloads/torrent-online-watch` — бросил `.torrent`, подхватился в меню
- Прогресс-строка: `%`, скорость, пиры; таймаут метаданных magnet (60 с)
- Фильтр по имени (подстрока или `/regex/`) перед выбором файлов
- Проверка VLC на старте с внятной ошибкой

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

## Linux
```bash
# ярлык в меню приложений
cp build/torrent-online.desktop ~/.local/share/applications/
# поправь Exec= на путь к проекту (или замени %h на абсолютный путь)
```

## Docker (headless, стрим в браузер)
```bash
docker build -t torrent-online .
docker run -p 8123:8123 torrent-online node wtui.js "magnet:?xt=..." --lan --no-vlc --port=8123
# открой напечатанный URL (токен в нём)
```

## Требования
- macOS 11+ / Linux
- Node.js ≥ 18
- VLC (`/Applications/VLC.app` или в PATH) — не нужен с `--no-vlc`

## Частые вопросы
- **Node не виден из .app** — .app запускает `zsh -l`, PATH подтянется. Если нет — проверь `which node`.
- **«Writable stream closed prematurely»** — VLC рвёт пробные коннекты; мы их игнорим.
- **Порт занят** — авто-поиск в диапазоне 8123..10122 или `--port=`.
- **Magnet без пиров** — приложение отвалится через 60 с с понятной ошибкой, не будет висеть вечно.

## Структура
```
.
├─ wtui.js          # основной скрипт (ESM)
├─ package.json
├─ LICENSE          # MIT
├─ Dockerfile
├─ build/
│  ├─ app.sh        # сборка .app (Terminal launcher)
│  └─ torrent-online.desktop
└─ README.md
```

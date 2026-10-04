# TorrentOnline

**RU:** Стрим из `.torrent`, `magnet:` и ссылки на `.torrent` в **VLC** или прямо в **браузер**. Один процесс VLC на весь плейлист. Кэш чистится после выхода (отключается флагом).
**EN:** Stream from `.torrent`, `magnet:` and `.torrent` URLs to **VLC** or straight to the **browser**. One VLC process for the whole playlist. Cache is wiped on exit (disable with a flag).

[Русский](#русский) · [English](#english)

![Меню / Menu](docs/menu.png)

---

# Русский

## Быстрый старт
```bash
npx torrent-online
```
Глобально один раз:
```bash
npm i -g torrent-online && torrent-online
```
Из исходников:
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
node wtui.js "https://example.com/file.torrent"
```

## Флаги
| Флаг | Что делает |
|---|---|
| `--keep-cache` | не удалять кэш после закрытия VLC |
| `--network-caching=<ms>` | прокинуть в VLC (по умолчанию 3000) |
| `--resume` | продолжить с прошлой позиции (VLC `--start-time`) |
| `--lan` | слушать 0.0.0.0 + токен в URL — смотреть с телефона/ТВ в сети |
| `--no-vlc` | только браузер-стриминг, без VLC |
| `--web` | окно в браузере. Это же происходит при запуске без торрента |
| `--cli` | старое меню в терминале |
| `--port=<N>` | фиксированный порт (иначе авто-поиск 8123..10122) |
| `--help` | справка |

Кэш по умолчанию: `~/Movies/WebTorrent`. В окне он остаётся после выхода и после кнопки «Закрыть». Стирает его только «Очистить кэш». Язык страницы — кнопки RU и EN (по умолчанию русский). В режиме `--cli` папка по-прежнему удаляется при выходе, если нет `--keep-cache`.

## Возможности (v1.4)
- 🔎 Поиск торрентов прямо в меню: **Rutor.info (по-русски)**, TPB.party (по-английски), опционально 1337x API
- 🌐 Стрим в браузер: страница с плеером на `/`, режим `--lan` с токеном
- 📺 Субтитры из торрента (`.srt/.ass/.ssa/.vtt`) → `--sub-file=` в VLC
- ▶️ `--resume`: позиция сохраняется в `~/.config/torrent-online/state.json`
- 📥 Watch-папка: `~/Downloads/torrent-online-watch` — бросил `.torrent`, подхватился в меню
- Прогресс-строка: `%`, скорость, пиры; таймаут метаданных magnet (60 с)
- Фильтр по имени (подстрока или `/regex/`) перед выбором файлов
- Проверка VLC на старте с внятной ошибкой

## Веб-GUI (`--web`)
```bash
node wtui.js --web
```
Тот же процесс, тот же порт. В браузере: поиск, поле magnet, кнопка файла `.torrent`, карточки с прогрессом, у каждого файла кнопки VLC и Браузер. VLC играет исходник. Браузер играет тот же поток со звуком: обычная шкала, перемотка и смена дорожки. Кнопки RU и EN меняют язык страницы и плеера. «Закрыть» останавливает сервер и не трогает кэш. Следующий двойной щелчок по приложению поднимает страницу снова. С телефона в Wi-Fi — через `--lan` (токен в URL).

## Нативное приложение (Tauri, macOS)
Окошко с иконкой, без терминала: над тем же веб-GUI.
```bash
# один раз: Rust (https://rustup.rs) + Xcode CLT
cd desktop && ./build-mac.sh
# → desktop/src-tauri/target/release/bundle/macos/TorrentOnline.app
```

## .app (macOS)
Скачай готовый `TorrentOnline.app.zip` из [релизов](../../releases), распакуй и перетащи в `/Applications`.
Приложение не подписано, поэтому macOS повесит карантин — сними его один раз:
```bash
xattr -dr com.apple.quarantine /Applications/TorrentOnline.app
open /Applications/TorrentOnline.app
```
Своя сборка (двойной щелчок открывает страницу в браузере, Terminal не нужен):
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
- **Node не виден из .app** — .app ищет `node` в `/opt/homebrew/bin` и `/usr/local/bin`. Если нет — `brew install node`.
- **«Writable stream closed prematurely»** — VLC рвёт пробные коннекты; мы их игнорим.
- **Порт занят** — авто-поиск в диапазоне 8123..10122 или `--port=`.
- **Magnet без пиров** — приложение отвалится через 60 с с понятной ошибкой, не будет висеть вечно.
- **Поиск по-русски** — Rutor ищет по кириллице сразу; TPB — только по-английски (транслит пробуем сами).

---

# English

## Quick Start
```bash
npx torrent-online
```
Install globally:
```bash
npm i -g torrent-online && torrent-online
```
From source:
```bash
git clone https://github.com/IamCaptainPepe/torrent-online.git
cd torrent-online
npm i
node wtui.js
```

CLI without the menu (all video files of the torrent play):
```bash
node wtui.js film.torrent
node wtui.js "magnet:?xt=urn:btih:..."
node wtui.js "https://example.com/file.torrent"
```

## Flags
| Flag | What it does |
|---|---|
| `--keep-cache` | don't delete the cache after VLC closes |
| `--network-caching=<ms>` | passed to VLC (default 3000) |
| `--resume` | continue from the last position (VLC `--start-time`) |
| `--lan` | listen on 0.0.0.0 + token in URL — watch from phone/TV on your network |
| `--no-vlc` | browser streaming only, no VLC |
| `--web` | browser window. This is also what a launch with no torrent does |
| `--cli` | the old terminal menu |
| `--port=<N>` | fixed port (otherwise auto-scan 8123..10122) |
| `--help` | help |

Default cache: `~/Movies/WebTorrent`. The window keeps it after exit and after Quit. Only Clear cache deletes it. The page language is the RU and EN buttons (Russian by default). In `--cli` mode the folder is still removed on exit unless `--keep-cache` is set.

## Features (v1.4)
- 🔎 Built-in torrent search: **Rutor.info (Russian)**, TPB.party (English), optional 1337x API
- 🌐 Browser streaming: player page at `/`, `--lan` mode with a token
- 📺 Subtitles from the torrent (`.srt/.ass/.ssa/.vtt`) → `--sub-file=` in VLC
- ▶️ `--resume`: playback position saved in `~/.config/torrent-online/state.json`
- 📥 Watch folder: `~/Downloads/torrent-online-watch` — drop a `.torrent`, it shows up in the menu
- Progress line: %, speed, peers; magnet metadata timeout (60 s)
- Name filter (substring or `/regex/`) before picking files
- VLC presence checked at startup with a clear error

## Web GUI (`--web`)
```bash
node wtui.js --web
```
Same process, same port. The browser has search, a magnet field, a `.torrent` file button, progress cards, and VLC / Browser buttons on each file. VLC plays the original. The browser plays one stream with sound: a normal timeline, seek, and an audio-track switch. The RU and EN buttons switch the page and the player. Quit stops the server and leaves the cache. The next double-click of the app brings the page back. From a phone on your Wi-Fi — use `--lan` (token in URL).

## Native app (Tauri, macOS)
A window with an icon, no terminal — wraps the same web GUI.
```bash
# once: Rust (https://rustup.rs) + Xcode CLT
cd desktop && ./build-mac.sh
# → desktop/src-tauri/target/release/bundle/macos/TorrentOnline.app
```

## .app (macOS)
Download the prebuilt `TorrentOnline.app.zip` from [releases](../../releases), unzip and drag it to `/Applications`.
The app is unsigned, so macOS adds a quarantine flag — clear it once:
```bash
xattr -dr com.apple.quarantine /Applications/TorrentOnline.app
open /Applications/TorrentOnline.app
```
Build it yourself (a double-click opens the page in the browser, no Terminal window):
```bash
./build/app.sh
open dist/TorrentOnline.app
```
Optional DMG:
```bash
brew install create-dmg
./build/app.sh
open dist/TorrentOnline.dmg
```

## Linux
```bash
# app menu shortcut
cp build/torrent-online.desktop ~/.local/share/applications/
# fix Exec= to your project path (or replace %h with an absolute path)
```

## Docker (headless, stream to browser)
```bash
docker build -t torrent-online .
docker run -p 8123:8123 torrent-online node wtui.js "magnet:?xt=..." --lan --no-vlc --port=8123
# open the printed URL (token included)
```

## Requirements
- macOS 11+ / Linux
- Node.js ≥ 18
- VLC (`/Applications/VLC.app` or in PATH) — not needed with `--no-vlc`

## FAQ
- **Node not visible from the .app** — the .app looks for `node` in `/opt/homebrew/bin` and `/usr/local/bin`. If it is missing, run `brew install node`.
- **"Writable stream closed prematurely"** — VLC drops probe connections; we ignore them.
- **Port busy** — auto-scan in 8123..10122 or use `--port=`.
- **Magnet with no peers** — the app fails after 60 s with a clear error instead of hanging forever.
- **Search in Russian** — Rutor searches Cyrillic directly; TPB is English-only (we try transliteration too).

## Структура / Structure
```
.
├─ wtui.js          # основной скрипт / main script (ESM)
├─ package.json
├─ LICENSE          # MIT
├─ Dockerfile
├─ build/
│  ├─ app.sh        # сборка .app (Terminal launcher)
│  └─ torrent-online.desktop
└─ README.md
```

## Лицензия / License
MIT

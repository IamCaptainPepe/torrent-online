# Changelog / История изменений

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [Semantic Versioning](https://semver.org/lang/ru/).

## [1.7.10] — 2026-10-04
**RU:** На странице есть кнопка «Закрыть»: она гасит фоновый сервер и не удаляет кэш. Язык переключается кнопками RU и EN.
**EN:** The page has a Quit button. It stops the background server and does not delete the cache. The language switches with the RU and EN buttons.
- ➕ `POST /api/quit` останавливает процесс. Скачанное в `~/Movies/WebTorrent` остаётся
- ➕ Переключатель языка в шапке и в плеере. Выбор запоминается в браузере. По умолчанию русский

## [1.7.9] — 2026-10-04
**RU:** В браузере звук больше не идёт рывками и не отстаёт от картинки.
**EN:** In the browser, audio no longer stutters or drifts off the picture.
- 🐛 Поток резался на MPEG-TS, и каждый кусок обнулял время. Браузер ставил звук не на ту секунду. Теперь фрагменты fMP4 с одной шкалой времени
- ➕ В релиз снова положен `TorrentOnline.app.zip`: двойной щелчок открывает страницу, окно Терминала не появляется

## [1.7.8] — 2026-10-04
**RU:** `npm i -g` снова доходит до конца. Зависимость `ip-set` больше не вызывает `npx only-allow pnpm` и не роняет установку.
**EN:** `npm i -g` finishes again. The `ip-set` dependency no longer runs `npx only-allow pnpm` and no longer aborts the install.

## [1.7.7] — 2026-10-04
**RU:** Поиск снова живой. Страница больше не падает с `Invalid regular expression: /+/g`.
**EN:** Search works again. The page no longer dies on `Invalid regular expression: /+/g`.
- 🐛 С 1.7.3 имя из magnet писалось через `/+/g` внутри шаблона, слэш съедался, и браузер отказывался выполнять весь скрипт страницы. Кнопка «Искать» из-за этого молчала и в Chrome, и в Safari

## [1.7.6] — 2026-10-04
**RU:** Браузер играет как обычный ролик: стабильное время, перемотка, смена дорожки. Окно с поиском открывается само. Кэш стирает кнопка.
**EN:** The browser plays a normal VOD title: stable duration, seek, and audio-track switch. The search window opens on launch. Cache is cleared by a button.
- 🐛 Плейлист больше не «прямой эфир» (`EVENT` без конца). Теперь `VOD` + `ENDLIST`, длительность берётся из файла и не прыгает
- 🐛 Смена дорожки и перемотка не сбрасывают воспроизведение в ноль
- 🐛 В браузере всегда H.264 + AAC, поэтому Chrome и Safari играют один и тот же поток. VLC по-прежнему открывает исходный файл
- 🐛 `hls.js` подключается через `createRequire` (раньше `require` в ESM не находился, и Chrome оставался без плеера)
- ➕ Запуск без аргументов открывает окно: поиск, magnet, файл `.torrent`, у каждого файла кнопки VLC и Браузер
- ➕ Кнопка «Очистить кэш». В окне скачанное больше не удаляется при выходе

## [1.4.3] — 2026-10-03
**RU:** .app распространяется как артефакт релиза.
**EN:** The .app ships as a release artifact.
- ➕ `build/app.sh`: в .app больше не бандлится `node_modules` — зависимости ставятся при первом запуске в `~/Library/Application Support/TorrentOnline` (один раз, потом мгновенный старт)
- ➕ Артефакт релиза: `TorrentOnline.app.zip` — качай и запускай без `git clone`

## [1.4.2] — 2026-10-03
**RU:** Русский поиск через Rutor.info.
**EN:** Russian-language search via Rutor.info.
- ➕ `searchRutor`: RSS `rutor.info/rss.php?search=` — находит по кириллице сразу («человек паук» → 26 результатов)
- ➕ CLI принимает `https://…file.torrent` как источник
- 🔀 Результаты Rutor всегда вверху списка, TPB — ниже
- ➖ 1337x убран из дефолта (за Cloudflare), остался опциональной заметкой

## [1.4.1] — 2026-10-03
**RU:** Починен поиск индексаторов.
**EN:** Indexer search fixed.
- 🐛 TPB: RSS отдавал HTML вместо XML → парсер видел 0 результатов; теперь парсится страница поиска (magnet + имя + размер + сиды)
- 🐛 1337x: подставной API-ключ → настоящий; кривой путь запроса; поле `magnetLink` вместо `magnet_link`
- ➕ Авто-транслит кириллицы: «человек паук» → ищет и кириллицей, и `chelovek pauk`
- ➕ Дедуп по btih, сортировка по сидам, в списке: `источник · имя · размер · 🌱сиды`
- ➕ Честные заметки об ошибках источников (`⚠ 1337x: HTTP 403 (Cloudflare)`) вместо молчаливого «0 результатов»

## [1.4.0] — 2026-10-03
**RU:** Большой релиз: фиксы ревью + фичи.
**EN:** Big release: review fixes + features.

### Fixed
- 🐛 `makeServer`: бесконечная рекурсия (мёртвая строка с `createServer`) удалена
- 🐛 Суффиксные Range-запросы `bytes=-N` теперь корректные 206; битый range → 416
- 🐛 Ctrl+C: VLC убивается (`vlc.kill()`), больше не остаётся зомби-процесс
- 🐛 `uncaughtException` логируется и ведёт к корректному shutdown, а не глушится
- 🐛 Имена файлов экранируются в HTML-индексе
- 🐛 Magnet без пиров: таймаут метаданных 60 с с понятной ошибкой, вместо вечного висения
- 🐛 `nameToIdx` — Map по индексу, а не по имени
- 🔧 Промпт кэша предупреждает: папка кэша удаляется после выхода
- 🔧 Фильтр по имени (подстрока/`/regex/`) был мёртвым — подключён
- 🔧 `build/app.sh` читает версию из `package.json`
- 🔧 Дефолтный `--network-caching` поднят 1500 → 3000

### Added
- 🌐 Стрим в браузер: страница с `<video>` на `/view/<i>`, `--no-vlc` без VLC
- 🌐 `--lan`: слушать 0.0.0.0 + случайный токен в URL (смотреть с телефона/ТВ)
- 🔎 Поиск торрентов в меню (TPB.party RSS + 1337x API) → magnet
- 📺 Субтитры из торрента (`.srt/.ass/.ssa/.vtt`) → VLC через `--sub-file=`
- ▶️ `--resume`: продолжение с прошлой позиции (`--start-time`), состояние в `~/.config/torrent-online/state.json`
- 📦 CLI-режим без меню: `node wtui.js film.torrent|magnet:`
- 📥 Watch-папка `~/Downloads/torrent-online-watch` — `.torrent` подхватываются в меню
- 📊 Прогресс-строка: %, скорость, пиры
- ✅ Проверка наличия VLC на старте с внятной ошибкой
- ⚙️ Флаги: `--keep-cache`, `--port=<N>`, `--network-caching=<ms>`, `--help`
- 📄 LICENSE (MIT), Dockerfile (headless-стрим на NAS), `torrent-online.desktop` для Linux

### Changed
- 🔁 `inquirer ^8` (не дружит с Node 22+) → `@inquirer/prompts ^7`
- 🔒 `webtorrent` зафиксирован на `2.8.4`

## [1.3.2] — 2025-09-28
**RU:** Базовая версия: TUI-меню, стрим в VLC.
**EN:** Baseline: TUI menu, VLC streaming.
- Меню выбора `.torrent` / magnet
- Стрим в VLC через локальный HTTP-сервер с Range-поддержкой
- Кэш `~/Movies/WebTorrent`, удаление после выхода
- Авто-поиск порта в диапазоне 8123..10122
- Сборка `.app` для macOS (`build/app.sh`)

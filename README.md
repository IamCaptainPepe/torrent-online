# TorrentOnline

Стрим `.torrent`/`magnet:` в VLC. Один процесс VLC на весь плейлист. Кэш чистится после выхода.

## Возможности
- Плейлист одним запуском VLC.
- Локальный HTTP-сервер (fallback, с Range).
- Очистка кэша по завершении (`--keep-cache` чтобы не чистить).
- Сортировка `.torrent` по дате (новые сверху).
- CLI и `.app` (открывает Terminal).

## Требования
- macOS 11+ (Node 24 тест)
- Node.js ≥ 18
- VLC (`/Applications/VLC.app` или в PATH)

## Установка
npm i

## Запуск (CLI)
node wtui.js
# флаги:
# --keep-cache                не удалять кэш после выхода VLC
# --network-caching=<ms>      прокинуть в VLC (по умолчанию 1500)

**Кэш по умолчанию:** `~/Movies/WebTorrent`.

## Сборка .app (macOS)
./build/app.sh
open dist/TorrentOnline.app

> DMG по желанию: `brew install create-dmg` и снова `./build/app.sh`.

## Релиз
node -e "const fs=require(\"fs\");const p=JSON.parse(fs.readFileSync(\"package.json\",\"utf8\"));p.version=\"1.3.2\";fs.writeFileSync(\"package.json\",JSON.stringify(p,null,2)+\"\\n\")"
git add -A && git commit -m "release: 1.3.2 app bundle + Terminal launcher" && git tag v1.3.2
git push -u origin main --tags

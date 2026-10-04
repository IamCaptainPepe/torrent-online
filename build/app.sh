#!/usr/bin/env bash
set -euo pipefail

APP_NAME="TorrentOnline"
APP_DIR="dist/${APP_NAME}.app"
RES_DIR="${APP_DIR}/Contents/Resources/app"
MACOS_DIR="${APP_DIR}/Contents/MacOS"

APP_VERSION="$(node -p "require(\"./package.json\").version")"

echo "[1/5] Чистим dist…"
rm -rf "dist"
mkdir -p "${RES_DIR}" "${MACOS_DIR}"

echo "[2/5] Кладём код (зависимости ставятся при первом запуске)…"
rm -rf build/stage
mkdir -p build/stage
cp wtui.js package.json package-lock.json build/stage/
cp -R vendor build/stage/vendor
cp -R build/stage/* "${RES_DIR}/"

echo "[3/5] Info.plist и запускалка…"
cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>                <string>TorrentOnline</string>
  <key>CFBundleDisplayName</key>        <string>TorrentOnline</string>
  <key>CFBundleExecutable</key>         <string>TorrentOnline</string>
  <key>CFBundleIdentifier</key>         <string>com.captainpepe.torrentonline</string>
  <key>CFBundleVersion</key>            <string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key> <string>${APP_VERSION}</string>
  <key>CFBundlePackageType</key>        <string>APPL</string>
  <key>LSMinimumSystemVersion</key>     <string>11.0</string>
</dict>
</plist>
PLIST

cat > "${MACOS_DIR}/TorrentOnline" <<'BASH'
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RES_APP="${SELF_DIR}/../Resources/app"
DEPS="${HOME}/Library/Application Support/TorrentOnline"
URL="http://127.0.0.1:8123/"
LOG="${DEPS}/server.log"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  osascript -e 'display alert "TorrentOnline" message "Не найден Node.js. Поставь его: brew install node" as warning'
  exit 1
fi
mkdir -p "${DEPS}/vendor"
cp "${RES_APP}/wtui.js" "${RES_APP}/package.json" "${DEPS}/"
if [ -f "${RES_APP}/package-lock.json" ]; then cp "${RES_APP}/package-lock.json" "${DEPS}/"; fi
rm -rf "${DEPS}/vendor/ip-set"
cp -R "${RES_APP}/vendor/ip-set" "${DEPS}/vendor/"
VER="$(node -p "require(process.argv[1]).version" "${DEPS}/package.json")"
OLD=""
if [ -f "${DEPS}/.app-version" ]; then OLD="$(cat "${DEPS}/.app-version")"; fi
if [ ! -d "${DEPS}/node_modules/webtorrent" ] || [ "${OLD}" != "${VER}" ]; then
  osascript -e 'display notification "Первый запуск: ставятся компоненты, подожди минуту" with title "TorrentOnline"' || true
  if ! (cd "${DEPS}" && npm i --omit=dev >> "${LOG}" 2>&1); then
    osascript -e 'display alert "TorrentOnline" message "Не удалось поставить компоненты. Лог: Library/Application Support/TorrentOnline/server.log" as warning'
    exit 1
  fi
  printf '%s\n' "${VER}" > "${DEPS}/.app-version"
fi
if ! curl -sf -o /dev/null --max-time 1 "${URL}"; then
  (cd "${DEPS}" && nohup node wtui.js --web --port=8123 --no-open >> "${LOG}" 2>&1 & echo $! > "${DEPS}/server.pid")
  i=0
  while [ "${i}" -lt 40 ]; do
    if curl -sf -o /dev/null --max-time 1 "${URL}"; then break; fi
    i=$((i + 1))
    sleep 0.25
  done
fi
open "${URL}"
exit 0
BASH
chmod +x "${MACOS_DIR}/TorrentOnline"

echo "[4/5] .app готово: ${APP_DIR}"
echo "[5/5] (опц.) DMG…"
if command -v create-dmg >/dev/null 2>&1; then
  rm -f "dist/${APP_NAME}.dmg"
  create-dmg --overwrite --dmg-title "${APP_NAME}" --app-drop-link 600 185 \
    "dist/${APP_NAME}.dmg" "dist" >/dev/null 2>&1 || true
  echo "DMG: dist/${APP_NAME}.dmg"
else
  echo "Пропустил DMG (нет create-dmg)."
fi
echo "OK"

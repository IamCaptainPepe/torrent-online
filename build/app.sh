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
UI=ru
if command -v defaults >/dev/null 2>&1; then
  PRIMARY="$(defaults read -g AppleLanguages 2>/dev/null | awk 'NR==2 { gsub(/[^A-Za-z_-]/, ""); print; exit }')"
  case "$PRIMARY" in
    en*) UI=en ;;
  esac
fi
alert() { osascript -e "display alert \"TorrentOnline\" message \"$1\" as warning"; }
notify() { osascript -e "display notification \"$1\" with title \"TorrentOnline\"" || true; }
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if [ "$UI" = en ]; then
    alert "Node.js was not found. Install it with: brew install node"
  else
    alert "Не найден Node.js. Поставь его: brew install node"
  fi
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
  if [ "$UI" = en ]; then
    notify "First launch: installing components, wait a minute"
  else
    notify "Первый запуск: ставятся компоненты, подожди минуту"
  fi
  if ! (cd "${DEPS}" && npm i --omit=dev >> "${LOG}" 2>&1); then
    if [ "$UI" = en ]; then
      alert "Could not install components. Log: Library/Application Support/TorrentOnline/server.log"
    else
      alert "Не удалось поставить компоненты. Лог: Library/Application Support/TorrentOnline/server.log"
    fi
    exit 1
  fi
  printf '%s\n' "${VER}" > "${DEPS}/.app-version"
fi
health() { curl -sf --max-time 1 "${URL}api/health" || true; }
up() { curl -sf -o /dev/null --max-time 1 "${URL}"; }
port_busy() {
  command -v lsof >/dev/null 2>&1 && lsof -ti tcp:8123 >/dev/null 2>&1
}
stop_old() {
  if [ -f "${DEPS}/server.pid" ]; then kill "$(cat "${DEPS}/server.pid")" 2>/dev/null || true; fi
  if command -v lsof >/dev/null 2>&1; then lsof -ti tcp:8123 | xargs kill 2>/dev/null || true; fi
}
HV="$(health)"
case "${HV}" in
  *"\"version\":\"${VER}\""*) ;;
  "") ;;
  *)
    stop_old
    i=0
    while up && [ "${i}" -lt 20 ]; do i=$((i + 1)); sleep 0.25; done
    ;;
esac
start_server() {
  cd "${DEPS}" || return 1
  rm -f "${DEPS}/server.pid"
  export WTUI_PIDFILE="${DEPS}/server.pid"
  # setsid отделяет node от .app: иначе macOS гасит сервер вместе с запускалкой.
  if [ -x /usr/bin/perl ]; then
    /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die $!' node wtui.js --web --port=8123 --no-open >> "${LOG}" 2>&1 &
  else
    nohup node wtui.js --web --port=8123 --no-open >> "${LOG}" 2>&1 &
  fi
  disown $! 2>/dev/null || true
}
FRESH=0
if ! up; then
  FRESH=1
  i=0
  while port_busy && [ "${i}" -lt 20 ]; do i=$((i + 1)); sleep 0.25; done
  start_server
  i=0
  while [ "${i}" -lt 40 ]; do
    if up; then break; fi
    i=$((i + 1))
    sleep 0.25
  done
fi
if up; then
  # Новый адрес, чтобы браузер не показал старую вкладку «сервер остановлен».
  if [ "${FRESH}" = 1 ]; then open "${URL}?t=$(date +%s)"; else open "${URL}"; fi
else
  if [ "${UI}" = en ]; then
    alert "The page did not start. Log: Library/Application Support/TorrentOnline/server.log"
  else
    alert "Страница не поднялась. Лог: Library/Application Support/TorrentOnline/server.log"
  fi
  exit 1
fi
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

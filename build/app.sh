#!/usr/bin/env bash
set -euo pipefail

APP_NAME="TorrentOnline"
APP_DIR="dist/${APP_NAME}.app"
RES_DIR="${APP_DIR}/Contents/Resources/app"
MACOS_DIR="${APP_DIR}/Contents/MacOS"

echo "[1/5] Чистим dist…"
rm -rf "dist"
mkdir -p "${RES_DIR}" "${MACOS_DIR}"

echo "[2/5] Кладём код и прод-зависимости…"
rm -rf build/stage
mkdir -p build/stage
cp wtui.js package.json build/stage/
npm i --omit=dev --prefix build/stage
cp -R build/stage/* "${RES_DIR}/"

echo "[3/5] Info.plist и запускалка…"
cat > "${APP_DIR}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>                <string>TorrentOnline</string>
  <key>CFBundleDisplayName</key>        <string>TorrentOnline</string>
  <key>CFBundleIdentifier</key>         <string>com.captainpepe.torrentonline</string>
  <key>CFBundleVersion</key>            <string>1.3.2</string>
  <key>CFBundleShortVersionString</key> <string>1.3.2</string>
  <key>CFBundlePackageType</key>        <string>APPL</string>
  <key>LSMinimumSystemVersion</key>     <string>11.0</string>
</dict>
</plist>
PLIST

cat > "${MACOS_DIR}/TorrentOnline" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="${SELF_DIR}/.."
RES_APP="${APP_ROOT}/Resources/app"
osascript <<OSA
tell application "Terminal"
  do script "/bin/zsh -l -c 'cd \"${RES_APP}\"; node wtui.js'"
  activate
end tell
OSA
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

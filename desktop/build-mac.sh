#!/usr/bin/env bash
# Сборка TorrentOnline.app (Tauri) — только на macOS
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Нужен Node.js ≥ 18"; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "Нужен Rust: curl https://sh.rustup.rs -sSf | sh"; exit 1; }
echo "[1/3] Кладём wtui.js в resources…"
mkdir -p app && cp ../wtui.js ../package.json app/
echo "[2/3] Иконки из icon-source.png…"
npx --yes @tauri-apps/cli@latest icon icon-source.png
echo "[3/3] Сборка (первый раз — долгие компиляции)…"
npx --yes @tauri-apps/cli@latest build
echo "Готово: src-tauri/target/release/bundle/macos/TorrentOnline.app"
echo "На чужих Маках: xattr -dr com.apple.quarantine /Applications/TorrentOnline.app"

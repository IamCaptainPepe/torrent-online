# torrent-online - WebTorrent -> VLC TUI

A minimal terminal UI to stream selected files from a .torrent or a magnet: link into VLC, downloading only what you pick.
Uses the WebTorrent library for playback (not only CLI), supports .torrent v1/v2, natural numeric sorting (E1, E2, ...), and auto-cleans cache after each playback.

Tested on Node.js 24 (macOS). Should work on Linux/Windows if vlc is in PATH.

## Features

- Source selection: choose a .torrent from current dir or ~/Downloads, paste a magnet:, or enter a custom path.
- Natural sorting: file list sorted by name with numeric awareness (S01E02 after S01E01).
- Pick only what you want: multi-select episodes; plays sequentially (by name).
- Precise targeting: deselects the whole torrent, selects only the chosen file — avoids full downloads.
- Auto cache cleanup: wipes the cache directory after each VLC exit and on abnormal exit (Ctrl+C / SIGTERM).
- Robust matching: matches by relative path (with torrent root), with fallbacks by basename and size.
- VLC integration: local HTTP streaming, --play-and-exit, visible --meta-title.
- .torrent v1 & v2: local bdecoder for v1 info.files, v2 info["file tree"], and single-file torrents.
- Magnet listing fallback: uses "webtorrent info" (CLI) read-only if listing is needed for magnets.

## Requirements

- Node.js >= 18 (tested with 24.x)
- VLC media player
  - macOS: auto-detected at /Applications/VLC.app; otherwise vlc must be in PATH
  - Linux/Windows: vlc must be in PATH

## Installation

    git clone https://github.com/<your-username>/torrent-online.git
    cd torrent-online
    [ -f package.json ] || npm init -y
    npm i inquirer@8 webtorrent webtorrent-cli
    chmod +x wtui.js  # optional on Unix

Note: webtorrent-cli is used only to read info for magnets. Playback uses the WebTorrent library.

## Usage

    node wtui.js
    # or
    ./wtui.js

Flow:
1) Pick a source (.torrent from current dir/~/Downloads, a magnet:, or a manual path).
2) Choose sorting and optionally filter by substring or /regex/.
3) Select one or more files (the list is naturally sorted).
4) Confirm the cache directory (default: ~/Movies/WebTorrent).
5) VLC opens and plays the first selection; when you close VLC, the cache is wiped, then the next selection starts.

## Optional macOS launcher

Ad-hoc run (no app bundle):

    osascript <<'OSA'
    set homePath to POSIX path of (path to home folder)
    set wtuiDir to homePath & "torrent-online"
    set envPath to "export PATH=" & wtuiDir & "/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH;"
    set cmd to envPath & " cd " & quoted form of wtuiDir & " && node wtui.js"
    tell application "Terminal"
      do script cmd
      activate
    end tell
    OSA

Install /Applications/TorrentOnline.app:

    cat > "$HOME/TorrentOnline.applescript" <<'OSA'
    set homePath to POSIX path of (path to home folder)
    set wtuiDir to homePath & "torrent-online"
    set envPath to "export PATH=" & wtuiDir & "/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH;"
    set cmd to envPath & " cd " & quoted form of wtuiDir & " && node wtui.js"
    tell application "Terminal"
      do script cmd
      activate
    end tell
    OSA
    osacompile -o "/Applications/TorrentOnline.app" "$HOME/TorrentOnline.applescript"
    rm "$HOME/TorrentOnline.applescript"
    open "/Applications/TorrentOnline.app"

## Troubleshooting

- VLC not found: install VLC and ensure it’s in PATH (macOS: /Applications/VLC.app).
- Port already in use: the local server picks a random port in 8123..10122; re-run if needed.
- Firewall prompts: allow local (127.0.0.1) connections for VLC/Node.
- Magnet listing missing: ensure webtorrent or "npx -y webtorrent-cli" works for "webtorrent info".
- Cache not cleaned: the app wipes cache on each VLC exit and process exit; after a hard OS kill, clean manually.

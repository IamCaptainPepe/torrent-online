#!/usr/bin/env node
import http from 'node:http';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { select, checkbox, input, confirm, Separator } from '@inquirer/prompts';
import WebTorrent from 'webtorrent';

/*
  torrent-online — WebTorrent → VLC / браузер (ESM)
  TLA-совместимо с WebTorrent 2.x на Node 18+.
*/

// ---- CLI ----
const HELP = `torrent-online — стрим торрента в VLC или браузер

Использование:
  torrent-online                       интерактивное меню
  torrent-online <file.torrent| magnet:...>   без меню (играют все видеофайлы)

Флаги:
  --keep-cache              не удалять кэш после выхода
  --network-caching=<ms>    кэш VLC (по умолчанию 3000)
  --resume                  продолжить с прошлой позиции (VLC --start-time)
  --lan                     слушать 0.0.0.0 + токен в URL (смотреть с телефона)
  --no-vlc                  только браузер-стриминг, без VLC
  --port=<N>                фиксированный порт (иначе авто 8123..10122)
  --help, -h                эта справка`;

function parseCli() {
  const opts = { keepCache: false, resume: false, lan: false, noVlc: false, caching: 3000, port: 0 };
  const positional = [];
  for (const a of process.argv.slice(2)) {
    if (a === '--keep-cache') opts.keepCache = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--lan') opts.lan = true;
    else if (a === '--no-vlc') opts.noVlc = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a.startsWith('--network-caching=')) opts.caching = Number(a.split('=')[1]) || 0;
    else if (a.startsWith('--port=')) opts.port = Number(a.split('=')[1]) || 0;
    else if (a.startsWith('--')) { console.error(`Неизвестный флаг: ${a}\n${HELP}`); process.exit(1); }
    else positional.push(a);
  }
  if (positional.length > 1) { console.error('Только один источник: .torrent или magnet:'); process.exit(1); }
  const srcArg = positional[0] || null;
  if (srcArg && !srcArg.startsWith('magnet:') && !srcArg.endsWith('.torrent')) {
    console.error('Нужен файл .torrent или ссылка magnet:'); process.exit(1);
  }
  return { opts, srcArg };
}

// ---- Константы ----
const PORT_MIN = 8123;
const PORT_MAX = 10122;
const META_TIMEOUT_MS = 60_000;
const DEFAULT_CACHE = path.join(os.homedir(), 'Movies', 'WebTorrent');
const WATCH_DIR = path.join(os.homedir(), 'Downloads', 'torrent-online-watch');
const STATE_FILE = path.join(os.homedir(), '.config', 'torrent-online', 'state.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) torrent-online/1.4';

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.mov', '.avi', '.webm', '.mpg', '.mpeg']);
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt']);

// ---- Утилиты ----
const sleep = ms => new Promise(r => setTimeout(r, ms));

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function localIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return '127.0.0.1';
}

async function listTorrentFiles(dir) {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    return items.filter(d => d.isFile() && d.name.endsWith('.torrent')).map(d => path.join(dir, d.name));
  } catch { return []; }
}

async function listTorrentFilesSortedByMtime(dir) {
  const files = await listTorrentFiles(dir);
  const detailed = await Promise.all(files.map(async full => {
    try { return { full, mtime: (await fsp.stat(full)).mtimeMs }; }
    catch { return { full, mtime: 0 }; }
  }));
  detailed.sort((a, b) => b.mtime - a.mtime);
  return detailed.map(x => x.full);
}

async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }

async function loadState() {
  try { return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}
async function saveState(st) {
  await ensureDir(path.dirname(STATE_FILE));
  await fsp.writeFile(STATE_FILE, JSON.stringify(st, null, 2));
}

// ---- Порты ----
function pickRandomPort() {
  const span = PORT_MAX - PORT_MIN + 1;
  return PORT_MIN + Math.floor(Math.random() * span);
}

async function listenOnFreePort(server, host, fixedPort) {
  if (fixedPort) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', () => { server.off('error', reject); resolve(); });
      server.listen(fixedPort, host);
    });
    return fixedPort;
  }
  let port = pickRandomPort();
  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => { server.off('listening', onListening); reject(err); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return port;
    } catch {
      port = port + 1; if (port > PORT_MAX) port = PORT_MIN;
      await sleep(10);
    }
  }
  throw new Error('Не удалось занять порт для HTTP-сервера');
}

// ---- VLC ----
function detectVLCPath() {
  const macVLC = '/Applications/VLC.app/Contents/MacOS/VLC';
  if (fs.existsSync(macVLC)) return macVLC;
  return 'vlc';
}

function checkVlc(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) {
    throw new Error(`VLC не найден/не запускается ("${bin}"). Установите VLC или смотрите в браузере: --no-vlc (а при --no-vlc уже открыта страница).`);
  }
}

function buildVLCArgs({ urls, caching, subs, startAt }) {
  const args = [...urls];
  args.push('--play-and-exit', '--no-video-title-show');
  if (caching > 0) args.push(`--network-caching=${caching}`);
  for (const s of subs) args.push(`--sub-file=${s}`);
  if (startAt > 0) args.push(`--start-time=${startAt}`);
  return args;
}

// ---- HTTP-сервер ----
function contentTypeByExt(ext) {
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.m4v': return 'video/x-m4v';
    case '.mkv': return 'video/x-matroska';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.avi': return 'video/x-msvideo';
    case '.mpg': case '.mpeg': return 'video/mpeg';
    default: return 'application/octet-stream';
  }
}

function makeServer(torrent, base) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let p = u.pathname;
    if (base) {
      if (p !== base && !p.startsWith(base + '/')) { res.statusCode = 404; res.end('not found'); return; }
      p = p.slice(base.length) || '/';
    }

    if (p === '/' || p === '') {
      const list = torrent.files.map((f, i) =>
        `<li><a href="${base}/view/${i}">${esc(f.path)}</a> — ${fmtBytes(f.length)}</li>`).join('');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>TorrentOnline</title>
<style>body{font-family:sans-serif;margin:2em;background:#111;color:#eee}a{color:#7fd}</style>
<h2>TorrentOnline</h2><ul>${list}</ul>`);
      return;
    }

    const mView = /^\/view\/(\d+)$/.exec(p);
    if (mView) {
      const i = Number(mView[1]);
      const f = torrent.files[i];
      if (!f) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>${esc(f.name)}</title>
<style>body{margin:0;background:#000}video{width:100vw;height:100vh}</style>
<video controls autoplay src="${base}/${i}"></video>`);
      return;
    }

    const mFile = /^\/(\d+)$/.exec(p);
    if (!mFile) { res.statusCode = 404; res.end('not found'); return; }
    const file = torrent.files[Number(mFile[1])];
    if (!file) { res.statusCode = 404; res.end('not found'); return; }

    const total = file.length;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentTypeByExt(path.extname(file.name).toLowerCase()));

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return;
      }
      let start, end;
      if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, total - n); end = total - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Number(m[2]); }
      if (total === 0 || start >= total || end >= total || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1
      });
      file.createReadStream({ start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', total);
      file.createReadStream().pipe(res);
    }
  });
}

// ---- Поиск индексаторов ----
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function translit(s) { return s.toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join(''); }
function btihKey(mag) { const m = /btih:([0-9a-fA-F]{40}|[0-9a-fA-F]{32})/.exec(mag); return m ? m[1].toLowerCase() : mag.slice(0, 90); }

async function search1337x(q) {
  const r = await fetch(`https://1337x.st/api/v1/search/${encodeURIComponent(q)}/1/1/`, {
    headers: { 'x-api-key': 'sk1337x73871873371873', 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`1337x: HTTP ${r.status}${/Just a moment/.test(text) ? ' (Cloudflare)' : ''}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('1337x: не JSON'); }
  const out = [];
  for (const it of j.data || []) {
    const mag = it.magnetLink || it.magnet_link || it.torrent_magnet;
    if (mag && mag.startsWith('magnet:'))
      out.push({ name: String(it.name || ''), mag, size: String(it.size || ''), seeds: Number(it.seeders) || 0, src: '1337x' });
  }
  return out;
}

async function searchTPB(q, host = 'https://tpb.party') {
  const r = await fetch(`${host}/s/?q=${encodeURIComponent(q)}&page=0&sort=0`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error(`TPB: HTTP ${r.status}`);
  const html = await r.text();
  const out = [];
  for (const row of html.split('<tr>').slice(1)) {
    const magRaw = /href="(magnet:[^"]+)"/.exec(row)?.[1];
    const name = decodeXml(/title="Details for ([^"]*)"/.exec(row)?.[1] || '');
    if (!magRaw || !name) continue;
    const mag = decodeXml(magRaw);
    const cells = [...row.matchAll(/<td[^>]*align="right"[^>]*>([^<]*)</g)]
      .map(m => decodeXml(m[1]).replace(/&nbsp;/g, ' ').trim());
    out.push({ name, mag, size: cells[0] || '', seeds: Number(cells[1]) || 0, src: 'TPB' });
    if (out.length >= 25) break;
  }
  return out;
}

async function searchIndexers(q) {
  const queries = [...new Set([q.trim(), translit(q.trim())].filter(Boolean))];
  const results = [];
  const notes = [];
  const jobs = [];
  for (const qq of queries) {
    jobs.push(searchTPB(qq).then(rs => results.push(...rs), e => notes.push(e.message)));
    jobs.push(search1337x(qq).then(rs => results.push(...rs), e => notes.push(e.message)));
  }
  await Promise.allSettled(jobs);
  const seen = new Set();
  const out = [];
  for (const it of results) {
    const k = btihKey(it.mag);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  out.sort((a, b) => b.seeds - a.seeds);
  return { items: out.slice(0, 40), notes: [...new Set(notes)] };
}

// ---- Промпты ----
async function promptSource() {
  const groups = [
    ['Текущая папка (новые сверху)', await listTorrentFilesSortedByMtime(process.cwd())],
    ['~/Downloads (новые сверху)', await listTorrentFilesSortedByMtime(path.join(os.homedir(), 'Downloads'))],
    ['Watch-папка', await listTorrentFilesSortedByMtime(WATCH_DIR)],
  ];
  const choices = [];
  for (const [label, files] of groups) {
    if (!files.length) continue;
    choices.push(new Separator(label));
    for (const f of files) choices.push({ name: path.basename(f), value: f });
  }
  choices.push(new Separator());
  choices.push({ name: '🔎 Поиск (1337x / TPB)', value: 'SEARCH' });
  choices.push({ name: 'Вставить magnet-ссылку', value: 'MAGNET' });
  choices.push({ name: 'Указать путь к .torrent', value: 'PATH' });

  const src = await select({ message: 'Источник', choices, pageSize: 15 });
  if (src === 'SEARCH') {
    const q = await input({ message: 'Запрос (по-английски; транслит ищем сам)' });
    process.stdout.write('Ищу… ');
    const { items, notes } = await searchIndexers(q);
    process.stdout.write(`\r${items.length} результатов        \n`);
    for (const n of notes.slice(0, 3)) console.log(`⚠ ${n}`);
    if (!items.length) throw new Error('Ничего не найдено. Индексаторы англоязычные: «spider man», а не «человек паук»');
    return await select({
      message: 'Найденное',
      pageSize: 15,
      choices: items.map(r => ({
        name: `${r.src} · ${r.name.slice(0, 64)}${r.size ? ' · ' + r.size : ''}${r.seeds ? ' · 🌱' + r.seeds : ''}`,
        value: r.mag,
      })),
    });
  }
  if (src === 'MAGNET') {
    const mag = await input({ message: 'magnet:' });
    if (!mag.startsWith('magnet:')) throw new Error('Нужна ссылка, которая начинается с magnet:');
    return mag;
  }
  if (src === 'PATH') {
    const p = await input({ message: 'Путь к .torrent' });
    if (!p.endsWith('.torrent')) throw new Error('Нужен файл .torrent');
    return p;
  }
  return src;
}

async function promptFilter(files) {
  const useFilter = await confirm({ message: 'Фильтр по имени?', default: false });
  if (!useFilter) return files;
  const f = await input({ message: 'Подстрока или /regex/' });
  try {
    if (f.length > 1 && f.startsWith('/') && f.endsWith('/')) {
      const re = new RegExp(f.slice(1, -1), 'i');
      return files.filter(x => re.test(x.name));
    }
    const s = f.toLowerCase();
    return files.filter(x => x.name.toLowerCase().includes(s));
  } catch {
    console.error('Некорректный regex, игнорируем.');
    return files;
  }
}

async function promptSelect(shown) {
  const picked = await checkbox({
    message: 'Выбери файлы для проигрывания',
    pageSize: 20,
    choices: shown.map((f, i) => ({ name: `${f.name} (${fmtBytes(f.length)})`, value: i })),
  });
  if (!picked.length) throw new Error('Ничего не выбрано');
  return picked.map(i => shown[i].idx);
}

async function promptCacheDir() {
  const dir = await input({
    message: 'Куда складывать кэш? ВНИМАНИЕ: папка будет удалена после выхода (кроме --keep-cache)',
    default: DEFAULT_CACHE,
  });
  await ensureDir(dir);
  return dir;
}

// ---- Торрент ----
async function addTorrent(client, source, cacheDir) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(
      () => reject(new Error(`Метаданные не получены за ${META_TIMEOUT_MS / 1000} с — проверьте magnet/трекеры`)),
      META_TIMEOUT_MS
    );
    client.add(source, { path: cacheDir }, t => {
      if (t.ready) { clearTimeout(to); return resolve(t); }
      const spin = setInterval(() => {
        process.stdout.write(`\r⏳ Метаданные: пиры ${t.peers.length}, получено ${fmtBytes(t.received)}   `);
      }, 1000);
      t.once('ready', () => { clearInterval(spin); process.stdout.write('\x1b[K'); clearTimeout(to); resolve(t); });
    });
    client.on('error', e => { clearTimeout(to); reject(e); });
  });
}

function startProgress(torrent) {
  const t = setInterval(() => {
    process.stdout.write(
      `\r⏬ ${(torrent.progress * 100).toFixed(1)}% · ${fmtBytes(torrent.downloadSpeed)}/s · пиры: ${torrent.peers.length}   `
    );
  }, 1000);
  return () => { clearInterval(t); process.stdout.write('\x1b[K\n'); };
}

async function collectSubtitles(torrent, chosenIdx) {
  const subs = torrent.files.filter(f => SUB_EXT.has(path.extname(f.name).toLowerCase()));
  if (!subs.length) return [];
  const videos = chosenIdx.map(i => path.basename(torrent.files[i].name, path.extname(torrent.files[i].name)).toLowerCase());
  const wanted = subs.filter(s => {
    const sb = path.basename(s.name, path.extname(s.name)).toLowerCase();
    return videos.some(v => v === sb || v.startsWith(sb) || sb.startsWith(v)) || ['subs', 'subtitles', 'субтитры'].includes(sb);
  });
  const subDir = path.join(os.tmpdir(), 'torrent-online-subs');
  await ensureDir(subDir);
  const out = [];
  for (const s of wanted.slice(0, 4)) {
    const dest = path.join(subDir, path.basename(s.name));
    try {
      await Promise.race([s.downloadToPath(dest), sleep(20000).then(() => { throw new Error('sub timeout'); })]);
      out.push(dest);
    } catch {}
  }
  return out;
}

async function cleanCache(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }); }
  catch (e) { console.warn('Не удалось удалить кэш:', e.message); }
}

// ---- Watch folder ----
function watchFolder() {
  ensureDir(WATCH_DIR).then(() => {
    try {
      fs.watch(WATCH_DIR, { persistent: false }, (ev, file) => {
        if (file && file.endsWith('.torrent')) console.log(`📥 Новый торрент в watch-папке: ${WATCH_DIR}/${file}`);
      });
    } catch {}
  }).catch(() => {});
}

// ---- Main ----
async function main() {
  const { opts, srcArg } = parseCli();
  watchFolder();

  const source = srcArg || await promptSource();
  let cacheDir;
  if (srcArg) { cacheDir = DEFAULT_CACHE; await ensureDir(cacheDir); console.log(`Кэш: ${cacheDir}`); }
  else cacheDir = await promptCacheDir();

  const client = new WebTorrent({ destroyStoreOnDestroy: true });
  const torrent = await addTorrent(client, source, cacheDir);

  const files = torrent.files
    .map((f, idx) => ({ name: f.path, idx, ext: path.extname(f.name).toLowerCase(), length: f.length }))
    .filter(f => VIDEO_EXT.has(f.ext))
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (!files.length) throw new Error('Видео файлов не найдено');

  let chosenTorrentIdx;
  if (srcArg) {
    chosenTorrentIdx = files.map(f => f.idx);
    console.log(`Плейлист: ${files.map(f => f.name).join(', ')}`);
  } else {
    const shown = await promptFilter(files);
    if (!shown.length) throw new Error('После фильтра не осталось файлов');
    chosenTorrentIdx = await promptSelect(shown);
  }

  torrent.files.forEach(f => f.deselect());
  chosenTorrentIdx.forEach(i => torrent.files[i].select());

  // Resume
  const state = await loadState();
  let startAt = 0;
  if (opts.resume && chosenTorrentIdx.length === 1) {
    const key = `${torrent.infoHash}:${chosenTorrentIdx[0]}`;
    startAt = state[key]?.seconds || 0;
    if (startAt) console.log(`▶️ Продолжаю с ${Math.floor(startAt / 60)}:${String(startAt % 60).padStart(2, '0')}`);
  }

  // Субтитры (для VLC)
  const host = opts.lan ? '0.0.0.0' : '127.0.0.1';
  const token = opts.lan ? crypto.randomBytes(8).toString('hex') : '';
  const base = token ? `/t/${token}` : '';

  const server = makeServer(torrent, base);
  const port = await listenOnFreePort(server, host, opts.port);
  const urls = chosenTorrentIdx.map(i => `http://127.0.0.1:${port}${base}/${i}`);

  let vlc = null, vlcStart = 0;
  let subs = [];
  if (!opts.noVlc) {
    const vlcBin = detectVLCPath();
    checkVlc(vlcBin);
    subs = await collectSubtitles(torrent, chosenTorrentIdx);
    if (subs.length) console.log('Субтитры:', subs.map(s => path.basename(s)).join(', '));
    const args = buildVLCArgs({ urls, caching: opts.caching, subs, startAt: chosenTorrentIdx.length === 1 ? startAt : 0 });
    console.log('VLC args:', args.join(' '));
    vlc = spawn(vlcBin, args, { stdio: 'ignore' });
    vlc.on('error', e => console.error('Не удалось запустить VLC:', e.message));
    vlcStart = Date.now();
  }

  console.log(`🌐 Страница: http://127.0.0.1:${port}${base}/`);
  if (opts.lan) console.log(`📱 В сети:   http://${localIP()}:${port}${base}/  (токен в URL)`);

  const stopProgress = startProgress(torrent);

  let cleaning = false;
  async function shutdown(reason, code = 0) {
    if (cleaning) return; cleaning = true;
    stopProgress();
    try { vlc?.kill(); } catch {}
    try { server.close(); } catch {}
    if (vlc) {
      const elapsed = Math.round((Date.now() - vlcStart) / 1000);
      for (const i of chosenTorrentIdx) {
        const key = `${torrent.infoHash}:${i}`;
        state[key] = { seconds: (state[key]?.seconds || 0) + elapsed, ts: Date.now() };
      }
      await saveState(state).catch(() => {});
    }
    try { await new Promise(r => torrent.destroy(r)); } catch {}
    try { await new Promise(r => client.destroy(r)); } catch {}
    if (!opts.keepCache) await cleanCache(cacheDir);
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  const NET_NOISE = /premature|aborted|EPIPE|ECONNRESET|ETIMEDOUT|socket|stream/i;
  process.on('unhandledRejection', e => {
    const msg = (e && (e.message || e)) + '';
    if (NET_NOISE.test(msg)) return;
    console.error('unhandledRejection:', msg);
  });
  process.on('uncaughtException', e => {
    const msg = (e && (e.message || e)) + '';
    if (NET_NOISE.test(msg)) return;
    console.error('uncaughtException:', msg);
    shutdown('uncaught', 1);
  });
  if (vlc) vlc.on('exit', () => shutdown('VLC exit'));
  if (opts.noVlc) {
    console.log('Смотрите в браузере; Ctrl+C — выход.');
    process.on('SIGINT', () => {}); // shutdown уже зарегистрирован выше
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(err => { console.error('Ошибка:', err?.stack || err?.message || err); process.exit(1); });

export { makeServer, naturalCompare, fmtBytes, esc, buildVLCArgs, contentTypeByExt, searchIndexers, searchTPB, translit };


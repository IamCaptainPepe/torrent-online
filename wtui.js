#!/usr/bin/env node
import http from 'node:http';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, spawnSync, execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';
import { select, checkbox, input, confirm, Separator } from '@inquirer/prompts';
import WebTorrent from 'webtorrent';

const require = createRequire(import.meta.url);
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

/*
  torrent-online — WebTorrent → VLC / браузер (ESM)
  TLA-совместимо с WebTorrent 2.x на Node 18+.
*/

// ---- CLI ----
const HELP = `torrent-online — стрим торрента в VLC или браузер

Использование:
  torrent-online                       окно: поиск, magnet, файл, VLC или браузер
  torrent-online <file.torrent|magnet:...>   сразу в VLC, без окна
  torrent-online --cli                 старое меню в терминале

Флаги:
  --web                     то же окно, что и запуск без аргументов
  --cli                     меню в терминале
  --keep-cache              в режиме --cli не удалять кэш после выхода
  --network-caching=<ms>    кэш VLC (по умолчанию 3000)
  --resume                  продолжить с прошлой позиции (VLC --start-time)
  --lan                     слушать 0.0.0.0 + токен в URL (смотреть с телефона)
  --no-vlc                  только браузер-стриминг, без VLC
  --port=<N>                фиксированный порт (иначе авто 8123..10122)
  --no-open                 не открывать браузер самой
  --help, -h                эта справка`;

function parseCli() {
  const opts = { keepCache: false, resume: false, lan: false, noVlc: false, web: false, cli: false, noOpen: false, caching: 3000, port: 0 };
  const positional = [];
  for (const a of process.argv.slice(2)) {
    if (a === '--keep-cache') opts.keepCache = true;
    else if (a === '--web') opts.web = true;
    else if (a === '--cli') opts.cli = true;
    else if (a === '--no-open') opts.noOpen = true;
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
  if (srcArg && !srcArg.startsWith('magnet:') && !/^https?:\/\//.test(srcArg) && !srcArg.endsWith('.torrent')) {
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
    const deadline = Date.now() + 8000;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => { server.off('listening', onListening); reject(err); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(fixedPort, host);
        });
        return fixedPort;
      } catch (err) {
        lastErr = err;
        if (err?.code !== 'EADDRINUSE') throw err;
        await sleep(250);
      }
    }
    throw lastErr || new Error('Порт занят: ' + fixedPort);
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
function detectFFBin(name) {
  const cands = ['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, '/usr/bin/' + name];
  for (const c of cands) if (fs.existsSync(c)) return c;
  const r = spawnSync('which', [name], { encoding: 'utf8', timeout: 3000 });
  const p = (r.stdout || '').trim();
  return p && fs.existsSync(p) ? p : null;
}

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
    try {
      handleReq(req, res, torrent, base);
    } catch (e) {
      if (!res.headersSent) { res.statusCode = 500; res.end('stream error'); }
      console.error('server:', e?.stack || e);
    }
  });
}
function handleReq(req, res, torrent, base) {
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

    serveFile(req, res, file);
}

function serveFile(req, res, file) {
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
}

// ---- Поиск индексаторов ----
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function translit(s) { return s.toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join(''); }

// RU->EN словарь популярных названий для TPB
const RU_EN = {
  'пацаны': 'the boys', 'во все тяжкие': 'breaking bad', 'лучше звонка сола': 'better call saul',
  'игра престолов': 'game of thrones', 'странные дела': 'stranger things', 'ведьмак': 'the witcher',
  'ходячие мертвецы': 'the walking dead', 'теория большого взрыва': 'the big bang theory',
  'клиника': 'scrubs', 'друзья': 'friends', 'голодные игры': 'the hunger games',
  'мистер робот': 'mr robot', 'шерлок': 'sherlock', 'южный парк': 'south park',
  'гриффины': 'family guy', 'симпсоны': 'the simpsons', 'футурама': 'futurama',
  'рик и морти': 'rick and morty', 'арчер': 'archer', 'американская история ужасов': 'american horror story',
  'сумерки': 'twilight', 'властелин колец': 'the lord of the rings', 'хоббит': 'the hobbit',
  'гарри поттер': 'harry potter', 'человек-паук': 'spider-man', 'бэтмен': 'batman',
  'супермен': 'superman', 'мстители': 'avengers', 'флэш': 'the flash', 'стрела': 'arrow',
  'тёмный рыцарь': 'the dark knight', 'диванный псих': 'divan', 'дэдпул': 'deadpool',
  'стражи галактики': 'guardians of the galaxy', 'человек-муравей': 'ant-man',
  'доктор стрэндж': 'doctor strange', 'веном': 'venom', 'джон уик': 'john wick',
  'терминатор': 'terminator', 'матрица': 'the matrix', 'чужой': 'alien',
  'хищник': 'predator', 'трансформеры': 'transformers', 'форсаж': 'fast and furious',
  'крид': 'creed', 'рокки': 'rocky', 'рамбо': 'rambo', 'неудержимые': 'the expendables',
  'миссия': 'mission impossible', 'индиана джонс': 'indiana jones', 'парк юрского периода': 'jurassic park',
  'аватар': 'avatar', 'титаник': 'titanic', 'оно': 'it', 'сияние': 'the shining',
  'мир дикого запада': 'westworld', 'наркос': 'narcos', 'элита': 'elite',
  'бумажный дом': 'la casa de papel', 'декстер': 'dexter', 'монк': 'monk',
  'последний богатырь': 'the last hero', 'чучело': 'scarecrow', 'фонари': 'lanterns',
  'гангстерленд': 'mobland', 'сердце пармы': 'heart of parma', 'метро 2033': 'metro',
};
function ruToEn(q) {
  let s = q.toLowerCase().replace(/[«»\/]/g, ' ');
  for (const k of Object.keys(RU_EN).sort((a, b) => b.length - a.length))
    s = s.split(k).join(RU_EN[k]);
  s = s.replace(/(\d+)\s*сезон/g, (m, n) => 's' + n.padStart(2, '0')).replace(/серия\b/g, 'episode');
  return s.replace(/\s+/g, ' ').trim();
}
function btihKey(mag) { const m = /btih:([0-9a-fA-F]{40}|[0-9a-fA-F]{32})/.exec(mag); return m ? m[1].toLowerCase() : mag.slice(0, 90); }


async function searchTPB(q, host = '') {
  const hosts = ['https://tpb.party', 'https://piratebay.live', 'https://tpbay.site', 'https://piratebay6.org', 'https://thepiratebay3.org'];
  let html = '', lastErr = new Error('TPB: нет ответа');
  for (const h of (host ? [host] : hosts)) {
    try {
      const r = await fetch(`${h}/search/${encodeURIComponent(q)}/0/99/0/`, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(9000),
      });
      if (r.ok) { html = await r.text(); lastErr = null; break; }
      lastErr = new Error(`TPB: HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
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

async function searchRutor(q) {
  const hosts = ['https://rutor.info', 'https://rutor.is', 'https://newrutor.info'];
  let html = '', lastErr = new Error('Rutor: нет ответа');
  for (const h of hosts) {
    try {
      const r = await fetch(`${h}/search/0/0/0/0/${encodeURIComponent(q)}/`, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(9000),
      });
      if (r.ok) { html = await r.text(); lastErr = null; break; }
      lastErr = new Error(`Rutor: HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  const out = [];
  for (const row of html.split('<tr class="gai">').slice(1, 26)) {
    const magRaw = /href="(magnet:[^"]+)"/.exec(row)?.[1];
    const name = decodeXml(/<a href="\/torrent\/\d+\/[^"]*">([^<]+)<\/a>/.exec(row)?.[1] || '');
    if (!magRaw || !name) continue;
    const size = decodeXml(/<td align="right">([\d.,]+)&nbsp;(GB|MB|KB|TB)/.exec(row)?.[0].replace('<td align="right">', '') || '')
      .replace(/&nbsp;/g, ' ').trim();
    const seeds = Number(decodeXml(/<td align="center">\s*<img[^>]*u\.png[^>]*>\s*([\d.,]+)/.exec(row)?.[1] || '0').replace(/[^\d]/g, '')) || 0;
    out.push({ name, mag: decodeXml(magRaw), size, seeds, src: 'Rutor' });
  }
  return out;
}

async function searchIndexers(q) {
  const queries = [...new Set([q.trim(), translit(q.trim()), ruToEn(q.trim())].filter(Boolean))];
  const results = [];
  const notes = [];
  const jobs = [];
  jobs.push(searchRutor(queries[0]).then(rs => results.push(...rs), e => notes.push(e.message)));
  for (const qq of queries) {
    jobs.push(searchTPB(qq).then(rs => results.push(...rs), e => notes.push(e.message)));
  }
  await Promise.allSettled(jobs);
  const seen = new Set();
  const out = [];
  for (const it of results) {
    const k = btihKey(it.mag);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  out.sort((a, b) => (a.src === 'Rutor' ? 0 : 1) - (b.src === 'Rutor' ? 0 : 1) || b.seeds - a.seeds);
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
  choices.push({ name: '🔎 Поиск (Rutor / TPB)', value: 'SEARCH' });
  choices.push({ name: 'Вставить magnet-ссылку', value: 'MAGNET' });
  choices.push({ name: 'Указать путь к .torrent', value: 'PATH' });

  const src = await select({ message: 'Источник', choices, pageSize: 15 });
  if (src === 'SEARCH') {
    const q = await input({ message: 'Запрос (по-русски — Rutor, по-английски — TPB)' });
    process.stdout.write('Ищу… ');
    const { items, notes } = await searchIndexers(q);
    process.stdout.write(`\r${items.length} результатов        \n`);
    for (const n of notes.slice(0, 3)) console.log(`⚠ ${n}`);
    if (!items.length) throw new Error('Ничего не найдено');
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
      t.files.forEach(f => f.deselect()); // не качаем всё подряд до выбора пользователя
      if (t.ready) { clearTimeout(to); return resolve(t); }
      const spin = setInterval(() => {
        process.stdout.write(`\r⏳ Метаданные: пиры ${(t.peers?.length ?? 0)}, получено ${fmtBytes(t.received)}   `);
      }, 1000);
      t.once('ready', () => { clearInterval(spin); process.stdout.write('\x1b[K'); clearTimeout(to); resolve(t); });
    });
    client.on('error', e => { clearTimeout(to); reject(e); });
  });
}

function startProgress(torrent) {
  const t = setInterval(() => {
    process.stdout.write(
      `\r⏬ ${(torrent.progress * 100).toFixed(1)}% · ${fmtBytes(torrent.downloadSpeed)}/s · пиры: ${(torrent._peers?.size ?? 0)}   `
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

// ---- WEB GUI (--web) ----
const WEB_HTML = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>TorrentOnline</title><style>
:root{--bg:#0f1115;--card:#171a21;--line:#232833;--txt:#e8ecf1;--mut:#8a93a3;--acc:#7fd4ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.45 -apple-system,'Segoe UI',Roboto,sans-serif}
header{display:flex;gap:10px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(15,17,21,.92);backdrop-filter:blur(6px);flex-wrap:wrap}
header b{font-size:18px}
#langs{margin-left:auto;display:flex;gap:4px}
#langs button{min-width:44px;padding:6px 10px}
#langs button.on{background:#2a3c58;color:#fff;border-color:var(--acc)}
#clr{color:#ffd7a8;border-color:#5a4630;background:#2a241c}
#quit{color:#ffb4b4;border-color:#5a3038;background:#2a1c22}
.wrap{max-width:900px;margin:0 auto;padding:16px}
.search{display:flex;gap:8px}
input#q{flex:1;min-width:0;background:#1d222c;border:1px solid #2a3140;color:var(--txt);padding:10px 12px;border-radius:8px;font-size:15px}
input#q:focus{outline:none;border-color:var(--acc)}
button{background:#223046;color:var(--acc);border:1px solid #2f4160;padding:9px 14px;border-radius:8px;cursor:pointer;font-size:14px}
button:hover{background:#2a3c58}
.note{color:var(--mut);margin:8px 0;font-size:13px}
.row{display:flex;gap:10px;align-items:baseline;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0;cursor:pointer}
.row:hover{border-color:#33415e}
.tag{background:#223046;color:var(--acc);border-radius:6px;padding:1px 7px;font-size:12px;flex:none}
.meta{color:var(--mut);font-size:12px;flex:none}
.rname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.tname{font-weight:600;margin-bottom:4px;word-break:break-word}
.tmeta{color:var(--mut);font-size:13px}
.bar{height:6px;background:#232a36;border-radius:3px;margin:8px 0;overflow:hidden}
.bar div{height:100%;background:linear-gradient(90deg,#3b82f6,#7fd4ff);border-radius:3px}
.fin{display:block;padding:4px 2px;cursor:pointer;color:var(--mut);font-size:14px}
.fin input{margin-right:8px;accent-color:#3b82f6}
.fin .play{margin-left:6px;padding:0 8px;font-size:12px}
.picks{margin:6px 0 2px}
.picks button{font-size:12px;padding:3px 10px}
body.drop{outline:3px dashed #3b82f6;outline-offset:-10px;background:rgba(59,130,246,.06)}
.fin .play{margin-left:6px;padding:0 8px;font-size:12px}
.picks{margin:6px 0 2px}
.picks button{font-size:12px;padding:3px 10px}
.acts{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
.acts .del{margin-left:auto;color:#ff8a8a;border-color:#4a2a33;background:#2a1c22}
h3{color:var(--mut);font-size:14px;margin:18px 0 4px;font-weight:500}
video{width:100vw;height:100vh;background:#000;display:block;margin:0}
</style></head><body>
<header>🦀 <b>TorrentOnline</b><span id=langs><button type=button id=lang-ru class=on>RU</button><button type=button id=lang-en>EN</button></span><button id=clr type=button>Очистить кэш</button><button id=quit type=button>Закрыть</button></header>
<div class=wrap>
<div class=search><input id=q placeholder="Поиск: пацаны 4 сезон · breaking bad" autocomplete=off><button id=go type=button>Искать</button></div>
<div class=search style="margin-top:8px"><input id=magin placeholder="Вставь magnet:?xt=urn:btih:…" autocomplete=off><button id=mag type=button>Добавить magnet</button><button id=tpath type=button>Файл .torrent</button><input type=file id=tt accept=".torrent,application/x-bittorrent" style=display:none></div>
<div class=note id=lead>Поток идёт сразу, целиком ждать не нужно. У каждого файла кнопки VLC и Браузер. Кэш при выходе не удаляется — только кнопкой «Очистить кэш». «Закрыть» останавливает сервер и не трогает скачанное.</div>
<div id=notes></div>
<div id=results></div>
<h3 id=th>Торренты</h3>
<div id=torrents></div>
</div>
<script>
var BASE="__BASE__";
var BOOT="__BOOT__";
var DICT={
ru:{phSearch:'Поиск: пацаны 4 сезон · breaking bad',search:'Искать',phMag:'Вставь magnet:?xt=urn:btih:…',addMag:'Добавить magnet',fileBtn:'Файл .torrent',lead:'Поток идёт сразу, целиком ждать не нужно. У каждого файла кнопки VLC и Браузер. Кэш при выходе не удаляется — только кнопкой «Очистить кэш». «Закрыть» останавливает сервер и не трогает скачанное.',clear:'Очистить кэш',quit:'Закрыть',torrents:'Торренты',adding:'добавляю в клиент…',torrent:'торрент',searching:'Ищу…',emptyFind:'Ничего не найдено',searchErr:'Ошибка поиска',needMag:'Нужна ссылка, которая начинается с magnet:',clearAsk:'Удалить скачанные файлы из кэша? Список торрентов тоже очистится.',cleared:'Кэш очищен',clearFail:'Не удалось очистить кэш',uploading:'Загружаю',uploadErr:'Ошибка загрузки',empty:'Пусто. Найди торрент и кликни по строке.',browser:'Браузер',all:'выбрать все',none:'снять все',waitMeta:'ждём метаданные…',peers:'пиры',hint:'Отметь серии галочками — ▶ VLC / ▶ Браузер запустят выбранное. Одна серия стартует автоматически.',del:'✕ удалить',quitAsk:'Остановить сервер? Скачанные файлы останутся в кэше.',quitDone:'Сервер остановлен. Открой TorrentOnline ещё раз — откроется новая вкладка. Эту можно закрыть. Скачанное на месте.',quitFail:'Сервер всё ещё отвечает.',quitSoon:'Сервер только открылся. Нажми «Закрыть» ещё раз через пару секунд.',addErr:'Ошибка /api/add','empty-file':'пустой файл','need-source':'нужна ссылка или файл','no-torrent':'нет торрента','no-file':'нет файла','pick-files':'выбери файлы','no-vlc':'VLC не найден'},
en:{phSearch:'Search: the boys season 4 · breaking bad',search:'Search',phMag:'Paste magnet:?xt=urn:btih:…',addMag:'Add magnet',fileBtn:'.torrent file',lead:'Playback starts right away. You do not wait for the full download. Each file has VLC and Browser buttons. Exit does not delete the cache. Only Clear cache does. Quit stops the server and leaves downloads on disk.',clear:'Clear cache',quit:'Quit',torrents:'Torrents',adding:'adding to the client…',torrent:'torrent',searching:'Searching…',emptyFind:'Nothing found',searchErr:'Search failed',needMag:'The link must start with magnet:',clearAsk:'Delete downloaded files from the cache? The torrent list will be cleared too.',cleared:'Cache cleared',clearFail:'Could not clear the cache',uploading:'Uploading',uploadErr:'Upload failed',empty:'Nothing here yet. Search for a torrent and click a row.',browser:'Browser',all:'select all',none:'select none',waitMeta:'waiting for metadata…',peers:'peers',hint:'Tick the episodes. VLC and Browser play the selection. A single episode starts on its own.',del:'✕ remove',quitAsk:'Stop the server? Downloaded files stay in the cache.',quitDone:'Server stopped. Open TorrentOnline again and a new tab will open. You can close this one. Downloads stay on disk.',quitFail:'The server is still running.',quitSoon:'The server just opened. Press Quit again in a couple of seconds.',addErr:'/api/add error','empty-file':'empty file','need-source':'a link or a file is required','no-torrent':'no such torrent','no-file':'no such file','pick-files':'pick files first','no-vlc':'VLC was not found'}
};
function lang(){try{return localStorage.getItem('to-lang')==='en'?'en':'ru'}catch(e){return 'ru'}}
function tr(k){var d=DICT[lang()]||DICT.ru;if(d&&d[k]!=null)return d[k];return (DICT.ru&&DICT.ru[k]!=null)?DICT.ru[k]:k}
function errText(code){if(code==null||code==='')return '';var s=tr(String(code));return s===String(code)?String(code):s}
function applyLang(){var L=lang();document.documentElement.lang=L;var ruB=document.getElementById('lang-ru'),enB=document.getElementById('lang-en');if(ruB)ruB.className=L==='ru'?'on':'';if(enB)enB.className=L==='en'?'on':'';document.getElementById('clr').textContent=tr('clear');document.getElementById('quit').textContent=tr('quit');document.getElementById('go').textContent=tr('search');document.getElementById('mag').textContent=tr('addMag');document.getElementById('tpath').textContent=tr('fileBtn');document.getElementById('q').placeholder=tr('phSearch');document.getElementById('magin').placeholder=tr('phMag');document.getElementById('lead').textContent=tr('lead');document.getElementById('th').textContent=tr('torrents');}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function api(p,body){var o=body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined;return fetch(BASE+p,o).then(function(r){return r.json();});}
function addTorrent(mag){
var box=document.getElementById('torrents');
var dn=(/dn=([^&]*)/.exec(mag)||[,''])[1];try{dn=decodeURIComponent(dn.replace(/\\+/g,' '))}catch(e){}
var ph=document.createElement('div');ph.className='card';
ph.innerHTML='<div class=tname>⏳ '+esc(dn||tr('torrent'))+'</div><div class=tmeta>'+esc(tr('adding'))+'</div>';
box.prepend(ph);
api('/api/add',{source:mag}).then(function(d){if(d&&d.error){ph.innerHTML='<div class=tname>⚠ '+esc(errText(d.error))+'</div>';}poll();toTorrents();}).catch(function(e){ph.innerHTML='<div class=tname>⚠ '+esc(tr('addErr'))+': '+esc(e&&e.message||e)+'</div>';});
}
function doSearch(){var q=document.getElementById('q').value.trim();if(!q)return;if(q.indexOf('magnet:')===0){addTorrent(q);document.getElementById('q').value='';return;}var box=document.getElementById('results');box.innerHTML='<div class=note>'+esc(tr('searching'))+'</div>';
api('/api/search?q='+encodeURIComponent(q)).then(function(d){
var h='';(d.notes||[]).forEach(function(n){h+='<div class=note>⚠ '+esc(n)+'</div>';});
if(!d.items.length){box.innerHTML=h+'<div class=note>'+esc(tr('emptyFind'))+'</div>';return;}
h+=d.items.map(function(it){return '<div class=row data-mag="'+esc(it.mag)+'"><span class=tag>'+esc(it.src)+'</span><span class=rname>'+esc(it.name)+'</span>'+(it.size?'<span class=meta>'+esc(it.size)+'</span>':'')+(it.seeds?'<span class=meta>🌱 '+it.seeds+'</span>':'')+'</div>';}).join('');
box.innerHTML=h;
[].forEach.call(box.querySelectorAll('.row'),function(r){r.onclick=function(){addTorrent(r.getAttribute('data-mag'));};});
}).catch(function(){box.innerHTML='<div class=note>'+esc(tr('searchErr'))+'</div>';});}
document.getElementById('go').onclick=doSearch;
document.getElementById('q').addEventListener('keydown',function(e){if(e.key==='Enter')doSearch();});
document.getElementById('mag').onclick=function(){var m=document.getElementById('magin').value.trim();var nb=document.getElementById('notes');if(m.indexOf('magnet:')!==0){nb.innerHTML='<div class=note>'+esc(tr('needMag'))+'</div>';return;}nb.innerHTML='';addTorrent(m);document.getElementById('magin').value='';};
document.getElementById('magin').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('mag').click();});
document.getElementById('clr').onclick=function(){if(!confirm(tr('clearAsk')))return;api('/api/clear-cache',{ok:1}).then(function(){document.getElementById('notes').innerHTML='<div class=note>'+esc(tr('cleared'))+'</div>';poll();}).catch(function(){document.getElementById('notes').innerHTML='<div class=note>'+esc(tr('clearFail'))+'</div>';});};
function showStopped(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}document.body.innerHTML='<p style="margin:0;padding:28px;font:16px/1.45 -apple-system,sans-serif;color:#e8ecf1">'+esc(tr('quitDone'))+'</p>';document.body.style.background='#0f1115';}
document.getElementById('quit').onclick=function(ev){if(ev&&ev.isTrusted===false)return;if(!confirm(tr('quitAsk')))return;var send=function(){fetch(BASE+'/api/quit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({boot:BOOT})}).then(function(r){if(r.status===409){return r.json().then(function(d){if(d&&d.error==='starting'){if(!send.retried){send.retried=1;setTimeout(send,2000);return;}var n=document.getElementById('notes');if(n)n.innerHTML='<div class=note>'+esc(tr('quitSoon'))+'</div>';return;}var n2=document.getElementById('notes');if(n2)n2.innerHTML='<div class=note>'+esc(tr('quitFail'))+'</div>';});}showStopped();}).catch(function(){showStopped();});};send();};
function setLang(code){try{localStorage.setItem('to-lang',code)}catch(e){}applyLang();poll();}
document.getElementById('lang-ru').onclick=function(){setLang('ru');};
document.getElementById('lang-en').onclick=function(){setLang('en');};
document.getElementById('tpath').onclick=function(){document.getElementById('tt').click();};
document.getElementById('tt').onchange=function(){if(this.files&&this.files[0])uploadFile(this.files[0]);this.value='';};
function uploadFile(f){var nb=document.getElementById('notes');nb.innerHTML='<div class=note>⏳ '+esc(tr('uploading'))+' '+esc(f.name)+'…</div>';
fetch(BASE+'/api/add-file',{method:'POST',headers:{'content-type':'application/octet-stream'},body:f}).then(function(r){return r.json()}).then(function(d){nb.innerHTML=d.error?'<div class=note>⚠ '+esc(errText(d.error))+'</div>':'';poll();toTorrents();}).catch(function(){nb.innerHTML='<div class=note>⚠ '+esc(tr('uploadErr'))+'</div>';});}
document.addEventListener('dragover',function(e){e.preventDefault();document.body.classList.add('drop');});
document.addEventListener('dragleave',function(e){if(e.target===document.body||e.relatedTarget===null)document.body.classList.remove('drop');});
document.addEventListener('drop',function(e){e.preventDefault();document.body.classList.remove('drop');
var fs=e.dataTransfer.files||[];
for(var i=0;i<fs.length;i++){if(/\\.torrent$/i.test(fs[i].name)){uploadFile(fs[i]);return;}}
var t=(e.dataTransfer.getData('text/uri-list')||'')+(e.dataTransfer.getData('text/plain')||'');
var mm=t.match(/magnet:\\?[^\\s]+/);if(mm){addTorrent(mm[0]);}
});
function render(list){var box=document.getElementById('torrents');
if(!list.length){box.innerHTML='<div class=note>'+esc(tr('empty'))+'</div>';return;}
box.innerHTML=list.map(function(t){
var files=t.files.map(function(f){return '<div class=fin><label><input type=checkbox data-id='+t.id+' data-i='+f.i+(f.selected?' checked':'')+'> '+esc(f.name)+' <span class=meta>'+esc(f.size)+'</span></label> <button type=button class=play data-act=vlc data-id='+t.id+' data-i='+f.i+'>VLC</button> <button type=button class=play data-act=web data-id='+t.id+' data-i='+f.i+'>'+esc(tr('browser'))+'</button></div>';}).join('');
var first=t.files.filter(function(f){return f.selected;})[0];
var wi=first?first.i:0;
var nSel=t.files.filter(function(f){return f.selected;}).length;
var bar=t.ready?t.progress:0;
var hint=(t.ready&&nSel===0)?'<div class=note>'+esc(tr('hint'))+'</div>':'';
return '<div class=card><div class=tname>'+esc(t.name)+'</div><div class=tmeta>'+(t.ready?'⏬ '+t.progress+'% · '+esc(t.speed)+' · '+esc(tr('peers'))+' '+t.peers:'⏳ '+esc(tr('waitMeta')))+'</div><div class=bar><div style=width:'+bar+'%></div></div>'+(t.files.length>1?'<div class=picks><button data-act=all data-id='+t.id+'>'+esc(tr('all'))+'</button><button data-act=none data-id='+t.id+'>'+esc(tr('none'))+'</button></div>':'')+'<div class=files>'+files+'</div>'+hint+'<div class=acts><button data-act=vlc data-id='+t.id+'>▶ VLC'+(nSel?' ('+nSel+')':'')+'</button><button data-act=web data-id='+t.id+' data-i='+wi+'>▶ '+esc(tr('browser'))+'</button><button class=del data-act=del data-id='+t.id+'>'+esc(tr('del'))+'</button></div></div>';
}).join('');
[].forEach.call(box.querySelectorAll('.fin input'),function(cb){cb.onchange=function(){var id=+cb.getAttribute('data-id');var idx=[].filter.call(box.querySelectorAll('.fin input[data-id="'+id+'"]'),function(x){return x.checked;}).map(function(x){return +x.getAttribute('data-i');});api('/api/select',{id:id,indices:idx});};});
[].forEach.call(box.querySelectorAll('button[data-act]'),function(b){b.onclick=function(ev){ev.preventDefault();ev.stopPropagation();var id=+b.getAttribute('data-id');var act=b.getAttribute('data-act');
if(act==='vlc'){var one=b.getAttribute('data-i');var label=b.textContent;b.textContent='…';var body={id:id};if(one!=null&&one!=='')body.index=+one;api('/api/vlc',body).then(function(d){b.textContent=d.error?('⚠ '+errText(d.error).slice(0,80)):label;});}
if(act==='web'){window.open(BASE+'/view/'+id+'/'+b.getAttribute('data-i'));}
if(act==='del'){api('/api/remove',{id:id}).then(poll);}
if(act==='all'||act==='none'){var idx=act==='all'?[].map.call(box.querySelectorAll('.fin input[data-id="'+id+'"]'),function(x){return +x.getAttribute('data-i');}):[];api('/api/select',{id:id,indices:idx}).then(poll);}
};});
}
var pollTimer=null;
function poll(){api('/api/status').then(render).catch(function(){});}
function toTorrents(){var el=document.getElementById('torrents');el.scrollIntoView({behavior:'smooth',block:'start'});}
applyLang();
poll();
pollTimer=setInterval(poll,1500);
</script></body></html>`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const HLS_SEG = 4;

function hlsSegName(i) {
  return 'seg-' + String(i).padStart(5, '0') + '.m4s';
}

function listHlsSegs(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(n => /^seg-\d+\.m4s$/.test(n))
      .map(n => Number(n.slice(4, -4)))
      .filter(n => Number.isFinite(n))
      .sort((a, b) => a - b);
  } catch { return []; }
}

function hlsSegComplete(dir, index) {
  // temp_file: готовый фрагмент появляется атомарно, недописанный лежит как .tmp
  const fp = path.join(dir, hlsSegName(index));
  try { return fs.statSync(fp).size > 32; } catch { return false; }
}

async function probeSource(ffprobe, url) {
  const { stdout } = await execFileP(ffprobe, [
    '-hide_banner', '-loglevel', 'error', '-print_format', 'json',
    '-show_streams', '-show_format', '-probesize', '5000000', '-analyzeduration', '5000000', url,
  ], { maxBuffer: 8 * 1048576, timeout: 25000 });
  const j = JSON.parse(stdout);
  let ai = 0, si = 0;
  const tracks = [], subs = [];
  for (const s of (j.streams || [])) {
    const lang = (s.tags && s.tags.language) || '';
    const title = (s.tags && s.tags.title) || '';
    if (s.codec_type === 'audio') tracks.push({ a: ai++, lang, title, codec: s.codec_name });
    else if (s.codec_type === 'subtitle') subs.push({ s: si++, lang, title, codec: s.codec_name });
  }
  const vs = (j.streams || []).find(s => s.codec_type === 'video');
  const duration = Number(j.format && j.format.duration) || (vs && Number(vs.duration)) || 0;
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    vcodec: vs ? vs.codec_name : '',
    width: vs ? (vs.width || 0) : 0,
    height: vs ? (vs.height || 0) : 0,
    tracks,
    subs,
  };
}

async function getProbe(hls, ffprobe, key, url) {
  const hit = hls.probe.get(key);
  if (hit && hit.duration > 0) return hit;
  let pending = hls.inflight.get(key);
  if (!pending) {
    pending = probeSource(ffprobe, url).then(meta => {
      hls.inflight.delete(key);
      if (meta && meta.duration > 0) hls.probe.set(key, meta);
      return meta;
    }).catch(err => {
      hls.inflight.delete(key);
      throw err;
    });
    hls.inflight.set(key, pending);
  }
  return pending;
}

function killHlsJob(job, aborted) {
  if (!job || job.aborted || job.ended) return;
  job.aborted = !!aborted;
  try { job.proc.kill('SIGKILL'); } catch {}
  if (!aborted || !job.dir) return;
  try {
    for (const n of fs.readdirSync(job.dir)) {
      if (n.endsWith('.tmp')) fs.rmSync(path.join(job.dir, n));
    }
  } catch {}
}

function jobCovers(job, index) {
  if (!job || job.ended || job.aborted || job.proc.killed) return false;
  if (job.from > index) return false;
  const segs = listHlsSegs(job.dir);
  const tip = segs.length ? segs[segs.length - 1] : job.from;
  return index <= Math.max(job.from, tip) + 8;
}

function ensureHlsJob(hls, key, dir, ffmpeg, url, fromIndex, audioIndex, meta) {
  const cur = hls.procs.get(key);
  if (jobCovers(cur, fromIndex)) { cur.touched = Date.now(); return cur; }
  if (cur) killHlsJob(cur, true);
  const target = fromIndex * HLS_SEG;
  const pre = target > 8 ? target - 8 : 0;
  const post = target - pre;
  const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-rw_timeout', '30000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  if (pre > 0.05) args.push('-ss', pre.toFixed(3));
  args.push('-i', url);
  if (post > 0.05) args.push('-ss', post.toFixed(3));
  if (target > 0.05) args.push('-output_ts_offset', target.toFixed(3));
  args.push('-map', '0:v:0');
  const hasAudio = meta.tracks.length > 0;
  const a = hasAudio ? Math.max(0, Math.min(audioIndex, meta.tracks.length - 1)) : 0;
  if (hasAudio) args.push('-map', '0:a:' + a);
  // MPEG-TS сбрасывал PTS каждого куска в ноль, браузер ставил звук не на то время.
  // fMP4 держит одну шкалу: картинка и звук без разрывов на границах.
  // VLC по-прежнему открывает исходный файл как есть.
  const big = (meta.height || 0) > 1080 || (meta.width || 0) > 1920;
  const scale = big
    ? 'scale=trunc(min(1920\\,iw)/2)*2:trunc(min(1080\\,ih)/2)*2'
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const initName = (fs.existsSync(path.join(dir, 'init.mp4')) && fs.statSync(path.join(dir, 'init.mp4')).size > 200)
    ? 'init-extra.mp4' : 'init.mp4';
  args.push(
    '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'main', '-crf', '22',
    '-vf', scale + ',format=yuv420p',
    '-g', '1000', '-keyint_min', '1000', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*' + HLS_SEG + ')'
  );
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
  else args.push('-an');
  args.push(
    '-muxdelay', '0', '-muxpreload', '0',
    '-max_muxing_queue_size', '9999',
    '-f', 'hls', '-hls_time', String(HLS_SEG),
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', initName,
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_list_size', '0',
    '-start_number', String(fromIndex),
    '-hls_segment_filename', path.join(dir, 'seg-%05d.m4s'),
    path.join(dir, 'ffmpeg.m3u8')
  );
  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const job = { proc, dir, from: fromIndex, touched: Date.now(), ended: false, aborted: false, err: '' };
  proc.stderr.on('data', d => {
    const s = String(d);
    if (job.err.length < 500) job.err += s;
    if (!job.logged) { job.logged = true; console.error('hls:', s.trim().slice(0, 240)); }
  });
  proc.on('exit', () => { job.ended = true; });
  proc.on('error', e => { job.ended = true; job.err += e.message; });
  hls.procs.set(key, job);
  return job;
}

function vodPlaylist(duration, audio) {
  const n = Math.max(1, Math.ceil(duration / HLS_SEG - 1e-6));
  let pl = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:' + HLS_SEG + '\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n';
  const qs = '?a=' + encodeURIComponent(String(audio));
  pl += '#EXT-X-MAP:URI="init.mp4' + qs + '"\n';
  for (let i = 0; i < n; i++) {
    const segDur = Math.min(HLS_SEG, Math.max(0.001, duration - i * HLS_SEG));
    pl += '#EXTINF:' + segDur.toFixed(3) + ',\n' + hlsSegName(i) + qs + '\n';
  }
  pl += '#EXT-X-ENDLIST\n';
  return pl;
}

async function waitForSeg(dir, index, job, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hlsSegComplete(dir, index, job)) return path.join(dir, hlsSegName(index));
    if (job && job.ended && !job.aborted && job.err && !fs.existsSync(path.join(dir, hlsSegName(index)))) return null;
    await sleep(200);
  }
  return null;
}

function dropHlsFor(hls, prefix) {
  for (const [k, h] of [...hls.procs]) {
    if (!k.startsWith(prefix)) continue;
    killHlsJob(h, true);
    hls.procs.delete(k);
    try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch {}
  }
  for (const k of [...hls.probe.keys()]) if (k.startsWith(prefix)) hls.probe.delete(k);
  for (const k of [...hls.inflight.keys()]) if (k.startsWith(prefix)) hls.inflight.delete(k);
}

function makeWebServer(client, st, opts, cacheDir, base) {
  const hls = {
    procs: new Map(),
    root: path.join(os.tmpdir(), 'wtui-hls-' + process.pid),
    probe: new Map(),
    inflight: new Map(),
  };
  st.hls = hls;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, h] of hls.procs) {
      if (now - h.touched < 180000) continue;
      killHlsJob(h, true);
      hls.procs.delete(k);
      try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch {}
    }
  }, 30000);
  sweep.unref();
  return http.createServer((req, res) => {
    Promise.resolve(webReq(req, res, client, st, opts, cacheDir, base)).catch(e => {
      if (!res.headersSent) { res.statusCode = 500; res.end('error'); }
      console.error('web:', e?.message || e);
    });
  });
}

const PLAYER_I18N = {
  ru: {
    sound: '▶ со звуком',
    prep: 'готовлю файл к стриму…',
    ffmpeg: 'нужен ffmpeg',
    nodur: 'не вижу длительность файла',
    noplayer: 'плеер браузера не загрузился',
    track: 'дорожка',
    nosub: 'без субтитров',
    sub: 'субтитры',
    peers: 'пиры',
  },
  en: {
    sound: '▶ with sound',
    prep: 'preparing the stream…',
    ffmpeg: 'ffmpeg is required',
    nodur: 'cannot read the duration',
    noplayer: 'the browser player did not load',
    track: 'track',
    nosub: 'no subtitles',
    sub: 'subtitles',
    peers: 'peers',
  },
};

async function webReq(req, res, client, st, opts, cacheDir, base) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const ensureSel = (e, i) => { const f = e?.t.files[i]; if (f && !e.sel.has(i)) { e.sel.add(i); try { f.select(); } catch {} } };
  const hls = st.hls;
  let p = u.pathname;
  if (base) {
    if (p !== base && !p.startsWith(base + '/')) { res.statusCode = 404; res.end('not found'); return; }
    p = p.slice(base.length) || '/';
  }
  const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };

  if (p === '/' || p === '') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(WEB_HTML.replaceAll('__BASE__', base).replaceAll('__BOOT__', st.boot));
    return;
  }
  if (p === '/hls.min.js') {
    try {
      const b = fs.readFileSync(require.resolve('hls.js/dist/hls.min.js'));
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(b);
    } catch { res.statusCode = 404; res.end('no hls.js'); }
    return;
  }
  if (p === '/api/health') return json(200, { ok: true, version: PKG_VERSION });
  if (p === '/api/quit' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    // Сразу после старта старая вкладка ещё может прислать «Закрыть». Это не клик пользователя.
    if (Date.now() - (st.startedAt || 0) < 8000) {
      console.log('quit ignored: starting');
      return json(409, { error: 'starting' });
    }
    if (!b || b.boot !== st.boot) {
      console.log('quit ignored: stale');
      return json(409, { error: 'stale' });
    }
    console.log('quit accepted');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Connection', 'close');
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      if (typeof st.quit === 'function') st.quit();
      else process.exit(0);
    }, 80);
    return;
  }
  if (p === '/api/search') {
    const q = u.searchParams.get('q') || '';
    const { items, notes } = await searchIndexers(q);
    return json(200, { items, notes });
  }
  if (p === '/api/add-file' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      req.on('data', c => { chunks.push(c); size += c.length; if (size > 5e6) { req.destroy(); reject(new Error('файл слишком большой')); } });
      req.on('end', resolve);
      req.on('error', reject);
    });
    const buf = Buffer.concat(chunks);
    if (!buf.length) return json(400, { error: 'empty-file' });
    const id = st.nextId++;
    st.pending.push(id);
    try { client.add(buf, { path: cacheDir }); }
    catch (e) { st.pending.pop(); return json(400, { error: String((e && e.message) || e) }); }
    return json(200, { id });
  }
  if (p === '/api/add' && req.method === 'POST') {
    const b = await readBody(req);
    const source = String(b.source || '');
    if (!source) return json(400, { error: 'need-source' });
    const btih = (source.match(/btih:([0-9a-f]{40})/i) || [])[1];
    if (btih) {
      const ex = [...st.torrents.values()].find(e => e.t.infoHash === btih.toLowerCase());
      if (ex) return json(200, { id: ex.id, dup: true });
    }
    const id = st.nextId++;
    st.pending.push(id);
    try { client.add(source, { path: cacheDir }); }
    catch (e) { st.pending.pop(); return json(400, { error: String((e && e.message) || e) }); }
    return json(200, { id });
  }
  if (p === '/api/status') {
    const list = [...st.torrents.values()].map(e => ({
      id: e.id,
      name: e.t.name || '…',
      ready: !!e.t.ready,
      progress: Math.round((e.t.progress || 0) * 100),
      speed: fmtBytes(e.t.downloadSpeed) + '/s',
      peers: e.t._peers?.size ?? 0,
      files: e.t.files
        .map((f, i) => ({ i, name: f.path, size: fmtBytes(f.length), selected: e.sel.has(i), video: VIDEO_EXT.has(path.extname(f.name).toLowerCase()) }))
        .filter(f => f.video),
    }));
    return json(200, list);
  }
  if (p === '/api/select' && req.method === 'POST') {
    const b = await readBody(req);
    const e = st.torrents.get(Number(b.id));
    if (!e) return json(404, { error: 'no-torrent' });
    e.t.files.forEach(f => f.deselect());
    e.sel = new Set((b.indices || []).map(Number));
    e.sel.forEach(i => e.t.files[i]?.select());
    return json(200, { ok: true });
  }
  if (p === '/api/vlc' && req.method === 'POST') {
    const b = await readBody(req);
    const e = st.torrents.get(Number(b.id));
    if (!e) return json(404, { error: 'no-torrent' });
    let idx;
    if (b.index != null && b.index !== '' && Number.isFinite(Number(b.index))) {
      const i = Number(b.index);
      if (!e.t.files[i]) return json(400, { error: 'no-file' });
      e.sel.add(i);
      try { e.t.files[i].select(); } catch {}
      idx = [i];
    } else idx = [...e.sel];
    if (!idx.length) return json(400, { error: 'pick-files' });
    const vlcBin = detectVLCPath();
    if (!vlcBin) return json(500, { error: 'no-vlc' });
    const subs = await collectSubtitles(e.t, idx);
    const urls = idx.map(i => 'http://127.0.0.1:' + st.port + base + '/s/' + e.id + '/' + i);
    const args = buildVLCArgs({ urls, caching: opts.caching, subs, startAt: 0 });
    const v = spawn(vlcBin, args, { stdio: 'ignore' });
    v.on('error', () => {});
    st.vlc.push(v);
    return json(200, { ok: true, subs: subs.length });
  }
  if (p === '/api/remove' && req.method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    const e = st.torrents.get(id);
    if (e) { st.torrents.delete(id); try { await new Promise(r => e.t.destroy(r)); } catch {} }
    dropHlsFor(hls, id + '-');
    return json(200, { ok: true });
  }
  if (p === '/api/clear-cache' && req.method === 'POST') {
    await readBody(req).catch(() => ({}));
    for (const h of hls.procs.values()) killHlsJob(h, true);
    hls.procs.clear();
    hls.probe.clear();
    hls.inflight.clear();
    try { fs.rmSync(hls.root, { recursive: true, force: true }); } catch {}
    st.torrents.clear();
    st.pending.length = 0;
    for (const t of [...(client.torrents || [])]) { try { await new Promise(r => t.destroy({ destroyStore: true }, r)); } catch {} }
    try { await fsp.rm(cacheDir, { recursive: true, force: true }); } catch {}
    await ensureDir(cacheDir);
    return json(200, { ok: true });
  }
  const mS = /^\/s\/(\d+)\/(\d+)$/.exec(p);
  if (mS) {
    const e = st.torrents.get(Number(mS[1]));
    const f = e?.t.files[Number(mS[2])];
    if (!f) { res.statusCode = 404; res.end('not found'); return; }
    ensureSel(e, Number(mS[2]));
    return serveFile(req, res, f);
  }
  const mT = /^\/api\/tracks\/(\d+)\/(\d+)$/.exec(p);
  if (mT) {
    const e = st.torrents.get(Number(mT[1]));
    const f = e?.t.files[Number(mT[2])];
    if (!f) return json(404, { error: 'no-file' });
    ensureSel(e, Number(mT[2]));
    const ffprobe = detectFFBin('ffprobe');
    if (!ffprobe) return json(200, { ffmpeg: false, tracks: [] });
    const url = 'http://127.0.0.1:' + st.port + base + '/s/' + mT[1] + '/' + mT[2];
    try {
      const meta = await getProbe(hls, ffprobe, mT[1] + '-' + mT[2], url);
      if (!meta || !(meta.duration > 0)) return json(200, { ffmpeg: true, tracks: meta?.tracks || [], subs: meta?.subs || [], retry: true });
      return json(200, { ffmpeg: true, tracks: meta.tracks, subs: meta.subs, duration: meta.duration, vcodec: meta.vcodec });
    } catch { return json(200, { ffmpeg: true, tracks: [], subs: [], retry: true }); }
  }
  const mR = /^\/remux\/(\d+)\/(\d+)$/.exec(p);
  if (mR && req.method === 'HEAD') { res.statusCode = 200; res.setHeader('Content-Type', 'video/mp4'); res.end(); return; }
  if (mR) {
    const e = st.torrents.get(Number(mR[1]));
    const f = e?.t.files[Number(mR[2])];
    if (!f) { res.statusCode = 404; res.end('not found'); return; }
    ensureSel(e, Number(mR[2]));
    const ffmpeg = detectFFBin('ffmpeg');
    if (!ffmpeg) { res.statusCode = 500; res.end('ffmpeg не найден'); return; }
    const a = u.searchParams.get('a') || '0';
    const sb = u.searchParams.get('s');
    const url = 'http://127.0.0.1:' + st.port + base + '/s/' + mR[1] + '/' + mR[2];
    const args = ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '30000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', url, '-map', '0:v:0', '-map', '0:a:' + a, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-max_muxing_queue_size', '9999'];
    if (sb !== null && sb !== '') args.push('-map', '0:s:' + sb, '-c:s', 'mov_text');
    args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-');
    res.setHeader('Content-Type', 'video/mp4');
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let ffErr = 0;
    proc.stderr.on('data', d => { if (ffErr < 3) { console.error('ffm:', String(d).trim().slice(0, 200)); ffErr++; } });
    // пребуфер: копим ~2 МБ выхода ffmpeg, чтобы браузер стартанул с запасом, а не по кусочкам
    const PRE = 2 * 1048576;
    const chunks = [];
    let buffered = 0, piping = false;
    const startPipe = () => {
      if (piping) return;
      piping = true;
      proc.stdout.removeListener('data', onData);
      for (const c of chunks) res.write(c);
      chunks.length = 0;
      proc.stdout.pipe(res);
    };
    const onData = c => {
      if (piping) return;
      chunks.push(c); buffered += c.length;
      if (buffered >= PRE) startPipe();
    };
    proc.stdout.on('data', onData);
    proc.stdout.on('end', () => { if (!piping) { for (const c of chunks) res.write(c); chunks.length = 0; } try { res.end(); } catch {} });
    setTimeout(startPipe, 5000);
    proc.on('error', () => { try { res.end(); } catch {} });
    req.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
    res.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
    return;
  }
  const mH = /^\/hls\/(\d+)\/(\d+)\/([\w.-]+)$/.exec(p);
  if (mH) {
    const e = st.torrents.get(Number(mH[1]));
    const f = e?.t.files[Number(mH[2])];
    if (!f) { res.statusCode = 404; res.end('not found'); return; }
    ensureSel(e, Number(mH[2]));
    const ffmpeg = detectFFBin('ffmpeg');
    const ffprobe = detectFFBin('ffprobe');
    if (!ffmpeg || !ffprobe) { res.statusCode = 500; res.end('ffmpeg не найден'); return; }
    const name = mH[3];
    if (name.includes('..')) { res.statusCode = 400; res.end('bad'); return; }
    const aRaw = Number(u.searchParams.get('a') || '0');
    const audioAsk = Number.isFinite(aRaw) ? Math.max(0, Math.min(31, Math.floor(aRaw))) : 0;
    const url = 'http://127.0.0.1:' + st.port + base + '/s/' + mH[1] + '/' + mH[2];
    const pkey = mH[1] + '-' + mH[2];
    let meta = null;
    try { meta = await getProbe(hls, ffprobe, pkey, url); } catch { meta = null; }
    if (!meta || !(meta.duration > 0)) {
      res.statusCode = 503;
      res.setHeader('Retry-After', '2');
      res.setHeader('Cache-Control', 'no-store');
      res.end('not ready');
      return;
    }
    const a = meta.tracks.length ? Math.min(audioAsk, meta.tracks.length - 1) : 0;
    if (name === 'sub.vtt') {
      const siRaw = Number(u.searchParams.get('si'));
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (!Number.isFinite(siRaw) || siRaw < 0) { res.end('WEBVTT\n\n'); return; }
      const si = Math.min(15, Math.floor(siRaw));
      const sdir = path.join(hls.root, pkey + '-sub-' + si);
      const dest = path.join(sdir, 'sub.vtt');
      const skey = pkey + '-sub-' + si;
      await ensureDir(sdir);
      if (!fs.existsSync(dest)) {
        let subJob = hls.procs.get(skey);
        if (!subJob || subJob.ended) {
          const sp = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', url, '-map', '0:s:' + si, '-c:s', 'webvtt', '-f', 'webvtt', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
          subJob = { proc: sp, dir: sdir, from: 0, touched: Date.now(), ended: false, aborted: false, err: '' };
          sp.on('exit', () => { subJob.ended = true; });
          hls.procs.set(skey, subJob);
        }
        subJob.touched = Date.now();
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && !fs.existsSync(dest)) {
          if (subJob.ended) break;
          await sleep(200);
        }
      }
      let sb = '';
      try { sb = fs.readFileSync(dest, 'utf8'); } catch {}
      res.end(sb || 'WEBVTT\n\n');
      return;
    }
    const key = pkey + '-a' + a;
    const dir = path.join(hls.root, key);
    if (name === 'index.m3u8' || name === 'master.m3u8') {
      const job = hls.procs.get(key);
      if (job) job.touched = Date.now();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.end(vodPlaylist(meta.duration, a));
      return;
    }
    if (name === 'init.mp4') {
      await ensureDir(dir);
      const initFp = path.join(dir, 'init.mp4');
      if (!fs.existsSync(initFp) || fs.statSync(initFp).size < 200) {
        const running = hls.procs.get(key);
        const job = (running && !running.ended && !running.aborted)
          ? running
          : ensureHlsJob(hls, key, dir, ffmpeg, url, 0, a, meta);
        job.touched = Date.now();
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          try { if (fs.statSync(initFp).size > 200) break; } catch {}
          if (job.ended && job.err) break;
          await sleep(100);
        }
      }
      let initBuf = null;
      try { if (fs.statSync(initFp).size > 200) initBuf = fs.readFileSync(initFp); } catch {}
      if (!initBuf) {
        res.statusCode = 503;
        res.setHeader('Retry-After', '1');
        res.setHeader('Cache-Control', 'no-store');
        res.end('init');
        return;
      }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', initBuf.length);
      res.end(initBuf);
      return;
    }
    const segM = /^seg-(\d+)\.m4s$/.exec(name);
    if (!segM) { res.statusCode = 404; res.end('no'); return; }
    const index = Number(segM[1]);
    const nSeg = Math.max(1, Math.ceil(meta.duration / HLS_SEG - 1e-6));
    if (index < 0 || index >= nSeg) { res.statusCode = 404; res.end('range'); return; }
    await ensureDir(dir);
    let fp = null;
    const existing = hls.procs.get(key);
    if (hlsSegComplete(dir, index, existing)) {
      fp = path.join(dir, hlsSegName(index));
      if (existing) existing.touched = Date.now();
    } else {
      const job = ensureHlsJob(hls, key, dir, ffmpeg, url, index, a, meta);
      job.touched = Date.now();
      fp = await waitForSeg(dir, index, job, 55000);
    }
    if (!fp) {
      res.statusCode = 503;
      res.setHeader('Retry-After', '1');
      res.setHeader('Cache-Control', 'no-store');
      const job = hls.procs.get(key);
      res.end(job && job.err ? job.err.slice(0, 300) : 'segment timeout');
      return;
    }
    const buf = fs.readFileSync(fp);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
    return;
  }
  const mV = /^\/view\/(\d+)\/(\d+)$/.exec(p);
  if (mV) {
    const e = st.torrents.get(Number(mV[1]));
    const f = e?.t.files[Number(mV[2])];
    if (!f) { res.statusCode = 404; res.end('not found'); return; }
    ensureSel(e, Number(mV[2]));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset=utf-8><title>${esc(f.name)}</title>
<style>body{margin:0;background:#000;color:#ddd;font:14px system-ui;display:flex;flex-direction:column;height:100vh;box-sizing:border-box}
.bar{display:flex;gap:10px;align-items:center;padding:6px 10px;flex-wrap:wrap}
select{background:#1b1b1f;color:#ddd;border:1px solid #333;border-radius:6px;padding:4px;max-width:340px}
#tm{font-variant-numeric:tabular-nums;min-width:9em}
video{flex:1;width:100%;min-height:0;background:#000}
#n{color:#9ab}
#ov{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);cursor:pointer;font-size:28px;color:#fff}
#langs{display:flex;gap:4px}#langs button{background:#1b1b1f;color:#ddd;border:1px solid #333;border-radius:6px;padding:2px 8px;cursor:pointer}#langs button.on{border-color:#7fd4ff;color:#fff}</style>
<div class=bar><b>${esc(f.name)}</b><span id=langs><button type=button id=lru>RU</button><button type=button id=len>EN</button></span><select id=a style=display:none></select><select id=s style=display:none></select><span id=tm>00:00 / --:--</span><span id=n></span></div>
<video id=v controls autoplay playsinline></video>
<div id=ov>▶ со звуком</div>
<script src="${base}/hls.min.js"></script>
<script>
var B=${JSON.stringify(base)},ID=${mV[1]},I=${mV[2]};
var PK=${JSON.stringify(PLAYER_I18N)};
var v=document.getElementById("v"),aS=document.getElementById("a"),sS=document.getElementById("s"),n=document.getElementById("n"),tm=document.getElementById("tm"),ov=document.getElementById("ov");
function LG(){try{return localStorage.getItem("to-lang")==="en"?"en":"ru"}catch(e){return "ru"}}
function pt(k){var d=PK[LG()]||PK.ru;return (d&&d[k])||(PK.ru&&PK.ru[k])||k}
function paintLang(){var L=LG();document.documentElement.lang=L;var a=document.getElementById("lru"),b=document.getElementById("len");if(a)a.className=L==="ru"?"on":"";if(b)b.className=L==="en"?"on":"";ov.textContent=pt("sound")}
document.getElementById("lru").onclick=function(){try{localStorage.setItem("to-lang","ru")}catch(e){}paintLang();fillTracks()};
document.getElementById("len").onclick=function(){try{localStorage.setItem("to-lang","en")}catch(e){}paintLang();fillTracks()};
paintLang();
v.muted=false;v.volume=1;
ov.onclick=function(){v.muted=false;v.volume=1;v.play().catch(function(){});ov.style.display="none"};
var tries=0,player=null,cues=[],subUrl="",armed=false;
function fmt(t){if(!isFinite(t)||t<0)return"--:--";t=Math.floor(t);var s=t%60,m=Math.floor(t/60)%60,h=Math.floor(t/3600);function z(n){return (n<10?"0":"")+n}return h?h+":"+z(m)+":"+z(s):z(m)+":"+z(s)}
function tick(){tm.textContent=fmt(v.currentTime)+" / "+fmt(v.duration)}
var cueDiv=document.createElement("div");cueDiv.style.cssText="position:fixed;left:5%;right:5%;bottom:8%;text-align:center;color:#fff;font-size:clamp(14px,2.5vw,28px);text-shadow:0 1px 4px #000;pointer-events:none;z-index:5";document.body.appendChild(cueDiv);
var parseVtt=function(txt){var NL=String.fromCharCode(10);var C=[];txt.split(NL+NL).forEach(function(b){var m=b.match(/([0-9]+):([0-9]+):([0-9]+).([0-9]+) --> ([0-9]+):([0-9]+):([0-9]+).([0-9]+)/);if(!m)return;var t=function(h,mi,s,ms){return h*3600+mi*60+s+parseFloat("0."+ms)};var x=b.split(NL).filter(function(l){return l&&l.indexOf("-->")<0&&l.indexOf("WEBVTT")<0&&!/^[a-zA-Z-]+:/.test(l)}).join("<br>");C.push([t(+m[1],+m[2],+m[3],m[4]),t(+m[5],+m[6],+m[7],m[8]),x])});cues=C};
var pollSub=function(){if(!subUrl)return;fetch(subUrl).then(function(r){return r.text()}).then(parseVtt).catch(function(){})};
v.addEventListener("timeupdate",function(){tick();var t=v.currentTime,a="";for(var i=cues.length-1;i>=0;i--){if(t>=cues[i][0]&&t<=cues[i][1]){a=cues[i][2];break}}cueDiv.innerHTML=a});
v.addEventListener("durationchange",tick);
v.addEventListener("seeked",tick);
setInterval(pollSub,20000);
var play=function(u,at){var want=(isFinite(at)&&at>0.4)?at:0;
if(player){try{player.destroy()}catch(e){}player=null}
var start=function(){v.muted=false;v.volume=1;if(want>0.4){try{v.currentTime=want}catch(e){}}v.play().catch(function(){ov.style.display="flex"})};
if(window.Hls&&Hls.isSupported()){player=new Hls({enableWorker:true,lowLatencyMode:false,startPosition:want,maxBufferLength:24,manifestLoadingTimeOut:20000,fragLoadingTimeOut:60000,fragLoadingMaxRetry:8});
player.loadSource(u);player.attachMedia(v);
player.on(Hls.Events.MANIFEST_PARSED,start);
player.on(Hls.Events.ERROR,function(ev,d){if(!d.fatal)return;if(d.type===Hls.ErrorTypes.NETWORK_ERROR){player.startLoad(v.currentTime||want);return}n.textContent="HLS: "+(d.details||d.type)})}
else{var once=function(){v.removeEventListener("loadedmetadata",once);start()};v.addEventListener("loadedmetadata",once);v.src=u}};
var lastD=null,filling=false;
function fillTracks(){if(!lastD)return;filling=true;var d=lastD;var prevA=aS.value,prevS=sS.value;var A=d.tracks||[],S=d.subs||[];aS.innerHTML="";sS.innerHTML="";
var SI=S.filter(function(t){return ["subrip","ass","ssa","srt","mov_text","webvtt","text"].indexOf(t.codec)>=0}).map(function(t){return t.s});
A.forEach(function(t){var o=document.createElement("option");o.value=t.a;o.textContent=(t.lang&&t.lang!=="und"?t.lang:pt("track")+" "+(t.a+1))+(t.title?" — "+t.title:"")+" ["+t.codec+"]";aS.appendChild(o)});
if(A.length){aS.value=(prevA!==""&&A.some(function(t){return String(t.a)===prevA}))?prevA:String(A[0].a);aS.style.display="";if(A.length<2)aS.disabled=true}
if(SI.length){var o0=document.createElement("option");o0.value="";o0.textContent=pt("nosub");sS.appendChild(o0);
S.filter(function(t){return SI.indexOf(t.s)>=0}).forEach(function(t){var o=document.createElement("option");o.value=t.s;o.textContent=(t.lang&&t.lang!=="und"?t.lang:pt("sub")+" "+(t.s+1))+(t.title?" — "+t.title:"");sS.appendChild(o)});sS.value=prevS||"";sS.style.display=""}
filling=false}
var load=function(){fetch(B+"/api/tracks/"+ID+"/"+I).then(function(r){return r.json()}).then(function(d){
if((d.retry||!(d.duration>0))&&tries++<20){n.textContent=pt("prep");setTimeout(load,2000);return;}
if(!d.ffmpeg){n.textContent=pt("ffmpeg");return;}
if(!(d.duration>0)){n.textContent=pt("nodur");return;}
var nativeHls=!!v.canPlayType("application/vnd.apple.mpegurl");
if(!(window.Hls&&Hls.isSupported())&&!nativeHls){n.textContent=pt("noplayer");return;}
tm.textContent="00:00 / "+fmt(d.duration);
lastD=d;fillTracks();
var go=function(keep){var a=aS.options.length?aS.value:0;var t=0;if(keep){t=v.currentTime;if(!isFinite(t)||t<0)t=0}play(B+"/hls/"+ID+"/"+I+"/index.m3u8?a="+encodeURIComponent(a),t)};
aS.onchange=function(){if(filling)return;go(true)};
sS.onchange=function(){if(filling)return;var s=sS.value;cues=[];cueDiv.innerHTML="";subUrl=s!==""?B+"/hls/"+ID+"/"+I+"/sub.vtt?si="+encodeURIComponent(s):"";if(subUrl)pollSub()};
if(!armed){armed=true;go(false)}
}).catch(function(){if(tries++<20)setTimeout(load,2000)})};
v.addEventListener("playing",function(){n.textContent="";ov.style.display="none";tick()});
setInterval(function(){fetch(B+"/api/status").then(function(r){return r.json()}).then(function(list){var t=list.find(function(x){return x.id===ID});if(t&&v.readyState<2)n.textContent=t.speed+" · "+pt("peers")+" "+t.peers+(t.progress>0?" · "+t.progress+"%":"")}).catch(function(){})},2000);
load();
</script>`);
    return;
  }
  res.statusCode = 404; res.end('not found');
}

async function startWeb(opts, srcArg) {
  const cacheDir = DEFAULT_CACHE;
  await ensureDir(cacheDir);
  const client = new WebTorrent({ destroyStoreOnDestroy: false });
  const token = opts.lan ? crypto.randomBytes(8).toString('hex') : '';
  const base = token ? '/t/' + token : '';
  const st = { torrents: new Map(), nextId: 1, vlc: [], port: 0, pending: [], autoSelect: !!srcArg, boot: crypto.randomBytes(8).toString('hex') };
  client.on('torrent', t => {
    t.on('error', () => {});
    const id = st.pending.shift();
    if (id == null) { try { t.destroy(); } catch {} return; }
    const dup = [...st.torrents.values()].find(e => e.t.infoHash === t.infoHash);
    if (dup) { try { t.destroy(); } catch {} return; }
    t.files.forEach(f => f.deselect()); // webtorrent по умолчанию выбирает все файлы
    try { t.fileSelector = (tt, index, file) => (file._selections && file._selections.length ? 2 : 0); } catch {}
    const sel = new Set();
    const vids = t.files.map((f, i) => ({ f, i })).filter(x => VIDEO_EXT.has(path.extname(x.f.name).toLowerCase()));
    if (st.autoSelect) {
      st.autoSelect = false;
      vids.forEach(x => sel.add(x.i));
    } else if (vids.length === 1) {
      sel.add(vids[0].i); // фильм один — авто-старт
    }
    sel.forEach(i => t.files[i]?.select());
    st.torrents.set(id, { id, t, sel });
  });
  const server = makeWebServer(client, st, opts, cacheDir, base);
  const host = opts.lan ? '0.0.0.0' : '127.0.0.1';
  st.port = await listenOnFreePort(server, host, opts.port);
  st.startedAt = Date.now();
  if (process.env.WTUI_PIDFILE) {
    try { fs.writeFileSync(process.env.WTUI_PIDFILE, String(process.pid)); } catch {}
  }
  const url = 'http://127.0.0.1:' + st.port + base + '/';
  console.log('🌐 GUI: ' + url);
  if (opts.lan) console.log('📱 В сети: http://' + localIP() + ':' + st.port + base + '/  (токен в URL)');
  if (!opts.noOpen) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { spawn(opener, [url], { stdio: 'ignore' }); } catch {}
  }
  if (srcArg) { st.pending.push(st.nextId++); client.add(srcArg, { path: cacheDir }); }
  let cleaning = false;
  async function shutdown(reason, code = 0) {
    if (cleaning) return; cleaning = true;
    console.log('выход: ' + reason);
    st.vlc.forEach(v => { try { v.kill(); } catch {} });
    try { server.close(); } catch {}
    try { server.closeAllConnections(); } catch {}
    if (st.hls) for (const h of st.hls.procs.values()) { try { h.proc.kill('SIGKILL'); } catch {} }
    try { fs.rmSync(path.join(os.tmpdir(), 'wtui-hls-' + process.pid), { recursive: true, force: true }); } catch {}
    // Порт отдаём сразу. Кэш не стираем. destroy не ждём: на macOS он может повиснуть и держать процесс.
    setTimeout(() => process.exit(code), 100);
    try { client.destroy(() => process.exit(code)); } catch { process.exit(code); }
  }
  st.quit = () => { shutdown('quit', 0); };
  process.on('SIGHUP', () => { console.log('SIGHUP ignored'); });
  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  const NET_NOISE = /premature|aborted|EPIPE|ECONNRESET|ETIMEDOUT|socket|stream|duplicate torrent/i;
  process.on('unhandledRejection', e => { const m = (e && (e.message || e)) + ''; if (!NET_NOISE.test(m)) console.error('unhandledRejection:', m); });
  process.on('uncaughtException', e => { const m = (e && (e.message || e)) + ''; if (NET_NOISE.test(m)) return; console.error('uncaughtException:', m); console.error((e && e.stack || '').split('\\n').slice(0, 8).join('\\n')); });
  console.log('Выход: кнопка «Закрыть» на странице или Ctrl+C. Скачанное остаётся в ' + cacheDir + '. Стирает его только кнопка «Очистить кэш».');
}

// ---- Main ----
async function main() {
  const { opts, srcArg } = parseCli();
  watchFolder();
  if (opts.web || (!srcArg && !opts.cli)) return startWeb(opts, srcArg);

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
    console.error((e && e.stack || '').split('\n').slice(0, 8).join('\n'));
    shutdown('uncaught', 1);
  });
  if (vlc) vlc.on('exit', () => shutdown('VLC exit'));
  if (opts.noVlc) {
    console.log('Смотрите в браузере; Ctrl+C — выход.');
    process.on('SIGINT', () => {}); // shutdown уже зарегистрирован выше
  }
}

const isMain = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(path.resolve(fileURLToPath(import.meta.url)));
if (isMain) main().catch(err => { console.error('Ошибка:', err?.stack || err?.message || err); process.exit(1); });

export { makeServer, naturalCompare, fmtBytes, esc, buildVLCArgs, contentTypeByExt, searchIndexers, searchTPB, translit };


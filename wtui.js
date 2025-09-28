#!/usr/bin/env node
/*
  torrent-online — WebTorrent → VLC TUI (ESM)
  Исправляет ERR_REQUIRE_ASYNC_MODULE с WebTorrent 2.x (TLA) на Node 24.
*/

import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import inquirer from 'inquirer';
import WebTorrent from 'webtorrent';

// ---- Константы / флаги ----
const argv = process.argv.slice(2);
const KEEP_CACHE = argv.includes('--keep-cache');
const NC_ARG = argv.find(a => a.startsWith('--network-caching='));
const VLC_NETWORK_CACHING = NC_ARG ? Number(NC_ARG.split('=')[1]) : 1500;
const PORT_MIN = 8123;
const PORT_MAX = 10122;

const DEFAULT_CACHE = path.join(os.homedir(), 'Movies', 'WebTorrent');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.mov', '.avi', '.webm', '.mpg', '.mpeg']);

// ---- Утилиты ----
const sleep = ms => new Promise(r => setTimeout(r, ms));

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function listTorrentFiles(dir) {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    return items
      .filter(d => d.isFile() && d.name.endsWith('.torrent'))
      .map(d => path.join(dir, d.name));
  } catch {
    return [];
  }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function pickRandomPort() {
  const span = PORT_MAX - PORT_MIN + 1;
  return PORT_MIN + Math.floor(Math.random() * span);
}

async function listenOnFreePort(server) {
  let port = pickRandomPort();
  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (e) {
      // EADDRINUSE → пробуем следующий порт
      port = port + 1; if (port > PORT_MAX) port = PORT_MIN;
      await sleep(10);
    }
  }
  throw new Error('Не удалось занять порт для HTTP‑сервера');
}

function detectVLCPath() {
  const macVLC = '/Applications/VLC.app/Contents/MacOS/VLC';
  if (fs.existsSync(macVLC)) return macVLC;
  return 'vlc'; // в PATH
}

function buildVLCArgs(urls) {
  const args = [];
  for (const u of urls) args.push(u);
  args.push('--play-and-exit');
  if (VLC_NETWORK_CACHING > 0) args.push(`--network-caching=${VLC_NETWORK_CACHING}`);
  // убрать всплывающий тайтл
  args.push('--no-video-title-show');
  return args;
}


async function listTorrentFilesSortedByMtime(dir) {
  try {
    // используем уже имеющийся listTorrentFiles(dir), он возвращает список путей
    const files = await listTorrentFiles(dir);
    const detailed = await Promise.all(files.map(async full => {
      try {
        const st = await fsp.stat(full);
        return { full, mtime: st.mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    }));
    detailed.sort((a, b) => b.mtime - a.mtime); // новые сверху
    return detailed.map(x => x.full);
  } catch {
    return [];
  }
}

async function promptSource() {
  const cwdTorrents = await listTorrentFilesSortedByMtime(process.cwd());
  const dlTorrents = await listTorrentFilesSortedByMtime(path.join(os.homedir(), 'Downloads'));
  const choices = [];
  if (cwdTorrents.length) {
    choices.push(new inquirer.Separator('— Текущая папка (новые сверху) —'));
    for (const f of cwdTorrents) choices.push({ name: path.basename(f), value: f });
  }
  if (dlTorrents.length) {
    choices.push(new inquirer.Separator('— ~/Downloads (новые сверху) —'));
    for (const f of dlTorrents) choices.push({ name: path.basename(f), value: f });
  }
  choices.push(new inquirer.Separator());
  choices.push({ name: 'Вставить magnet: ссылку', value: 'MAGNET' });
  choices.push({ name: 'Указать путь к .torrent', value: 'PATH' });

  const { src } = await inquirer.prompt([{ type: 'list', name: 'src', message: 'Источник', choices }]);
  if (src === 'MAGNET') {
    const { mag } = await inquirer.prompt([{ type: 'input', name: 'mag', message: 'magnet:' }]);
    if (!mag.startsWith('magnet:')) throw new Error('Нужна ссылка, которая начинается с magnet:');
    return mag;
  }
  if (src === 'PATH') {
    const { p } = await inquirer.prompt([{ type: 'input', name: 'p', message: 'Путь к .torrent' }]);
    if (!p.endsWith('.torrent')) throw new Error('Нужен файл .torrent');
    return p;
  }
  return src; // выбран файл из списка
}

async function promptSortAndFilter(fileNames) {
  const { useFilter } = await inquirer.prompt([{ type: 'confirm', name: 'useFilter', message: 'Фильтр по имени?', default: false }]);
  let filtered = [...fileNames];
  if (useFilter) {
    const { f } = await inquirer.prompt([{ type: 'input', name: 'f', message: 'Подстрока или /regex/' }]);
    try {
      if (f.startsWith('/') && f.endsWith('/')) {
        const re = new RegExp(f.slice(1, -1), 'i');
        filtered = filtered.filter(n => re.test(n));
      } else {
        const s = f.toLowerCase();
        filtered = filtered.filter(n => n.toLowerCase().includes(s));
      }
    } catch {
      console.error('Некорректный regex, игнорируем.');
    }
  }
  filtered.sort(naturalCompare);
  return filtered;
}

async function promptSelect(files) {
  const { picked } = await inquirer.prompt([
    { type: 'checkbox', name: 'picked', message: 'Выбери файлы для проигрывания', pageSize: 20, choices: files.map((n, i) => ({ name: n, value: i })) }
  ]);
  if (!picked.length) throw new Error('Ничего не выбрано');
  return picked; // индексы по массиву filtered
}

async function promptCacheDir() {
  const { dir } = await inquirer.prompt([{ type: 'input', name: 'dir', message: 'Куда складывать кэш?', default: DEFAULT_CACHE }]);
  await ensureDir(dir);
  return dir;
}

async function cleanCache(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn('Не удалось удалить кэш:', e.message);
  }
}

async function main() {
  const source = await promptSource();
  const cacheDir = await promptCacheDir();

  const client = new WebTorrent({ destroyStoreOnDestroy: true });

  const torrent = await new Promise((resolve, reject) => {
    client.add(source, { path: cacheDir }, t => resolve(t));
    client.on('error', reject);
  });

  // ждём метаданные (на всякий случай)
  if (!torrent.ready) await new Promise(res => torrent.once('ready', res));

  // Список видео-файлов
  const files = torrent.files
    .map((f, idx) => ({ name: f.path, idx, ext: path.extname(f.name).toLowerCase(), length: f.length }))
    .filter(f => VIDEO_EXT.has(f.ext))
    .sort((a, b) => naturalCompare(a.name, b.name));

  if (!files.length) throw new Error('Видео файлов не найдено');

  // Фильтр и выбор
  const filteredNames = await promptSortAndFilter(files.map(f => f.name));
  const nameToIdx = new Map(files.map(f => [f.name, f.idx]));
  const pickedFilteredIdx = await promptSelect(filteredNames);
  const chosenTorrentIdx = pickedFilteredIdx.map(i => nameToIdx.get(filteredNames[i]));

  // Приоритизируем выбранные файлы
  torrent.files.forEach(f => f.deselect());
  chosenTorrentIdx.forEach(i => torrent.files[i].select());

  // Поднимаем HTTP‑сервер для torrent
  const server = torrent.createServer();
  const port = await listenOnFreePort(server);

  // Готовим плейлист из ссылок вида /<index>
  const urls = chosenTorrentIdx.map(i => `http://127.0.0.1:${port}/${i}`);

  // Спавним VLC один раз на все URL
  const vlcBin = detectVLCPath();
  const vlcArgs = buildVLCArgs(urls);
  console.log('VLC args:', vlcArgs.join(' '));
  const vlc = spawn(vlcBin, vlcArgs, { stdio: 'ignore' });

  // Акуратные выходы
  let cleaning = false;
  async function shutdown(reason) {
    if (cleaning) return; cleaning = true;
    console.log(`\nВыходим (${reason})…`);
    try { server.close(); } catch {}
    try { await new Promise(r => torrent.destroy(r)); } catch {}
    try { await new Promise(r => client.destroy(r)); } catch {}
    if (!KEEP_CACHE) await cleanCache(cacheDir);
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', e => { console.error(e); shutdown('uncaughtException'); });
  process.on('unhandledRejection', e => { console.error(e); shutdown('unhandledRejection'); });

  vlc.on('exit', async (code, sig) => {
    console.log(`VLC завершился (${code ?? ''} ${sig ?? ''}).`);
    await shutdown('VLC exit');
  });
}

main().catch(err => { console.error('Ошибка:', err?.stack || err?.message || err); process.exit(1); });

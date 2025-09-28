import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';

const file = '/Users/captainpepe/Downloads/torrent-online/wtui.js';

async function main() {
  let src = await fsp.readFile(file, 'utf8');

  // уже патчено?
  if (src.includes('function listTorrentFilesSortedByMtime')) {
    console.log('уже есть listTorrentFilesSortedByMtime — ничего не делаю');
    return;
  }

  // 1) заменить вызовы в promptSource на сортированную версию
  src = src
    .replace(
      /await\s+listTorrentFiles\(\s*process\.cwd\(\)\s*\)/,
      'await listTorrentFilesSortedByMtime(process.cwd())'
    )
    .replace(
      /await\s+listTorrentFiles\(\s*path\.join\(os\.homedir\(\),\s*'Downloads'\)\s*\)/,
      "await listTorrentFilesSortedByMtime(path.join(os.homedir(), 'Downloads'))"
    );

  // 2) убрать .sort(naturalCompare) в списках, чтобы не перебивало порядок по дате
  src = src
    .replace(/cwdTorrents\.sort\(naturalCompare\)/g, 'cwdTorrents')
    .replace(/dlTorrents\.sort\(naturalCompare\)/g, 'dlTorrents');

  // 3) пометки в заголовках (не обязательно, просто удобнее)
  src = src
    .replace('— Текущая папка —', '— Текущая папка (новые сверху) —')
    .replace('— ~/Downloads —', '— ~/Downloads (новые сверху) —');

  // 4) добавить функцию, которая сортирует .torrent по mtime ↓, но возвращает те же пути (string[])
  const fn = `
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
`;

  // куда вставить: перед promptSource, если найдём, иначе — в конец файла
  const anchor = /async\s+function\s+promptSource\s*\(/;
  if (anchor.test(src)) {
    src = src.replace(anchor, fn + '\n' + 'async function promptSource(');
  } else {
    src += '\n' + fn + '\n';
  }

  // бэкап
  const bak = file + '.bak';
  try { await fsp.copyFile(file, bak); } catch {}

  await fsp.writeFile(file, src, 'utf8');
  console.log('готово: отсортировано по дате (новые сверху). бэкап:', bak);
}

main().catch(e => { console.error(e); process.exit(1); });

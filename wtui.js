#!/usr/bin/env node
// wtui.js — VLC + WebTorrent (Node 24)
// Новое: Жёсткая очистка кэша после КАЖДОГО запуска (после закрытия VLC) и при завершении процесса (SIGINT/SIGTERM/exit).

const os = require('os');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const inquirer = require('inquirer');

function hasCmd(cmd){ try{return spawnSync(cmd,['--version'],{stdio:'ignore'}).status===0;}catch{return false;} }
function fmtBytes(n){ if(!Number.isFinite(n))return '-'; const u=['Б','КБ','МБ','ГБ','ТБ']; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return `${n.toFixed(n>=10||i===0?0:1)} ${u[i]}`; }
function fmtDate(ts){ if(!ts)return '-'; try{return new Date(ts).toLocaleString('ru-RU');}catch{return String(new Date(ts));} }
function safeStat(p){ try{return fs.statSync(p);}catch{return null;} }
function vlcPath(){ const p='/Applications/VLC.app/Contents/MacOS/VLC'; return fs.existsSync(p)?p:'vlc'; }

// ---- bdecode (минимальный)
function bdecode(buf){
  let i=0; const b=Buffer.isBuffer(buf)?buf:Buffer.from(buf);
  function num(stop){ let j=i,s=1; if(b[j]===45){s=-1;j++;} let v=0; for(;j<b.length&&b[j]!==stop;j++){const c=b[j]; if(c<48||c>57) throw 0; v=v*10+(c-48);} if(j>=b.length) throw 0; i=j+1; return s*v;}
  function str(){ if(b[i]<48||b[i]>57) throw 0; let len=0; while(b[i]!==58){const c=b[i]; if(c<48||c>57) throw 0; len=len*10+(c-48); i++;} i++; const end=i+len; if(end>b.length) throw 0; const s=b.slice(i,end).toString('utf8'); i=end; return s;}
  function any(){ const c=b[i]; if(c===105){i++;return num(101);} if(c===108){i++;const a=[];while(b[i]!==101)a.push(any()); i++;return a;} if(c===100){i++;const o={};while(b[i]!==101){const k=str(); o[k]=any();} i++;return o;} if(c>=48&&c<=57) return str(); throw 0;}
  return any();
}

// ---- .torrent → список (v1/v2/single)
function listFromTorrentFile(fp){
  try{
    const raw=fs.readFileSync(fp);
    const tor=bdecode(raw), info=tor&&tor.info; if(!info) return [];
    if(Array.isArray(info.files) && info.files.length){ // v1
      return info.files.map((f,i)=>{
        const parts=Array.isArray(f.path)?f.path:[]; const rel=parts.join('/')||`file_${i}`;
        const len=Number(f.length)||0; return { rel, size:len, label:`${rel}  [${fmtBytes(len)}]` };
      });
    }
    if(info['file tree'] && typeof info['file tree']==='object'){ // v2
      const out=[]; (function walk(node, parts){
        for(const k of Object.keys(node)){ const v=node[k];
          if(v && typeof v==='object'){
            if(Object.prototype.hasOwnProperty.call(v,'')){ const meta=v['']||{}; out.push({ rel:[...parts,k].join('/'), size:Number(meta.length)||0 }); }
            else walk(v,[...parts,k]);
          }
        }
      })(info['file tree'],[]);
      return out.map(f=>({ rel:f.rel, size:f.size, label:`${f.rel}  [${fmtBytes(f.size)}]` }));
    }
    const name=typeof info.name==='string'?info.name:'file'; const len=Number(info.length)||0; // single
    return [{ rel:name, size:len, label:`${name}  [${fmtBytes(len)}]` }];
  }catch{ return []; }
}

// ---- magnet/.torrent → список через webtorrent-cli (fallback для magnet)
function listFromCli(src){
  const cmd = hasCmd('webtorrent')?'webtorrent':'npx';
  const prefix = (cmd==='webtorrent')?[]:['-y','webtorrent-cli'];
  const r=spawnSync(cmd,[...prefix,'info',src],{encoding:'utf8'});
  if(r.status!==0) return [];
  const items=[];
  for(const line of r.stdout.split(/\r?\n/)){
    const m=line.match(/^\s*\d+\s*:\s*(.+?)(?:\s*\((?:\d+(?:\.\d+)?\s*[KMG]B|.+)\))?\s*$/i); // убираем " (3.7 GB)"
    if(m){ const rel=m[1].trim(); items.push({ rel, size:NaN, label:rel }); }
  }
  return items;
}

// ---- поиск .torrent
function scanTorrents(){
  const home=os.homedir(), dirs=[process.cwd(), path.join(home,'Downloads')];
  const out=[]; for(const d of dirs){ let ls=[]; try{ls=fs.readdirSync(d);}catch{continue;}
    for(const e of ls) if(e.toLowerCase().endsWith('.torrent')){
      const full=path.join(d,e), st=safeStat(full); if(!st) continue;
      out.push({name:e, dir:d, full, ts:st.birthtimeMs||st.mtimeMs||0, size:st.size||0});
    }
  } return out;
}

const SORTS=[
  {k:'date_desc', n:'Дата ↓ (новые сверху)', f:(a,b)=>b.ts-a.ts},
  {k:'name_asc',  n:'Имя A→Z',               f:(a,b)=>a.name.localeCompare(b.name)},
  {k:'size_desc', n:'Размер ↓',              f:(a,b)=>b.size-a.size},
  {k:'size_asc',  n:'Размер ↑',              f:(a,b)=>a.size-b.size},
  {k:'date_asc',  n:'Дата ↑ (старые сверху)',f:(a,b)=>a.ts-b.ts},
];

// ---- естественная сортировка имён
const NAME_COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

// ---- очистка кэша (жёсткая)
function safeCleanDir(dir){
  try{
    const home=os.homedir(), norm=path.resolve(dir);
    if(!norm.startsWith(home)) return;
    if(norm.length < home.length+5) return;
    for(const name of fs.readdirSync(norm)){ fs.rmSync(path.join(norm,name),{recursive:true,force:true}); }
  }catch(e){ console.error('Очистка кэша:', e.message||e); }
}

// ---- глобальные ссылки для аварийной очистки
const G = { client:null, server:null, outDir:null };
function installExitHandlers(){
  const handler = (sig)=>{ try{
    if(G.server){ try{ G.server.close(); }catch{} }
    if(G.client){ try{ G.client.destroy(); }catch{} }
    if(G.outDir){ safeCleanDir(G.outDir); }
  } finally { process.exit(sig ? 0 : 0); } };
  process.on('SIGINT', ()=>handler('SIGINT'));
  process.on('SIGTERM', ()=>handler('SIGTERM'));
  process.on('exit', ()=>handler(null));
}

// ---- выбор источника
async function pickSource(){
  const found=scanTorrents();
  const choices=[];
  if(found.length) choices.push({name:'Выбрать из найденных .torrent (сорт/поиск)', value:'__FOUND__'});
  choices.push({name:'Вставить magnet', value:'__MAGNET__'});
  choices.push({name:'Указать .torrent вручную', value:'__MANUAL__'});
  const {mode}=await inquirer.prompt([{type:'list',name:'mode',message:'Источник',choices}]);
  if(mode==='__FOUND__'){
    const {sortk}=await inquirer.prompt([{type:'list',name:'sortk',message:'Сортировка',default:'date_desc',choices:SORTS.map(s=>({name:s.n,value:s.k}))}]);
    found.sort((SORTS.find(s=>s.k===sortk)||SORTS[0]).f);
    const {q}=await inquirer.prompt([{type:'input',name:'q',message:'Фильтр (строка или /regex/)',default:''}]);
    let list=found;
    if(q.trim()){
      const s=q.trim();
      if(s.startsWith('/')&&s.endsWith('/')&&s.length>2){ try{const rx=new RegExp(s.slice(1,-1),'i'); list=found.filter(it=>rx.test(it.name)); }catch{ list=found.filter(it=>it.name.toLowerCase().includes(s.toLowerCase())); } }
      else list=found.filter(it=>it.name.toLowerCase().includes(s.toLowerCase()));
      if(!list.length) throw new Error('По фильтру пусто');
    }
    const {pick}=await inquirer.prompt([{type:'list',name:'pick',message:'Файл .torrent',choices:list.map(it=>({name:`${it.name} — ${it.dir} [${fmtDate(it.ts)}, ${fmtBytes(it.size)}]`,value:it.full})),pageSize:12}]);
    return pick;
  }
  if(mode==='__MAGNET__'){
    const {mag}=await inquirer.prompt([{type:'input',name:'mag',message:'magnet:'}]);
    if(!mag.startsWith('magnet:')) throw new Error('Неверный magnet');
    return mag;
  }
  const {p}=await inquirer.prompt([{type:'input',name:'p',message:'Путь к .torrent:'}]);
  const abs=path.resolve(p); if(!fs.existsSync(abs)) throw new Error('Файл не найден'); return abs;
}

// ---- список файлов
function listFromTorrentCliOrFile(src){
  let items=[];
  if(!src.startsWith('magnet:') && fs.existsSync(src)) items = listFromTorrentFile(src);
  if(!items.length) items = listFromCli(src);
  if(!items.length) return [{ rel:'__ALL__', size:NaN, label:'[Запустить весь торрент]' }];
  items.sort((a,b)=>NAME_COLLATOR.compare(String(a.rel), String(b.rel)));
  return items;
}

async function listFiles(src){ return listFromTorrentCliOrFile(src); }

async function pickFiles(items){
  const choices = items.map((it,idx)=>{
    if(it.rel==='__ALL__') return {name:'[ВСЕ]', value:{ALL:true}};
    return {name:`${idx+1}: ${it.label}`, value:{REL:it.rel, SIZE:it.size}};
  });
  const {sel}=await inquirer.prompt([{type:'checkbox',name:'sel',message:'Отметьте файлы',choices,loop:false,pageSize:20}]);
  if(!sel.length) throw new Error('Ничего не выбрано');
  const out = sel.slice().sort((a,b)=>{
    if(a.ALL) return 1; if(b.ALL) return -1;
    return NAME_COLLATOR.compare(String(a.REL), String(b.REL));
  });
  return out;
}

// ---- HTTP сервер (Range) → VLC
function serveFile(file, port){
  return new Promise((resolve,reject)=>{
    const server=http.createServer((req,res)=>{
      const size=file.length, name=path.basename(file.path||file.name||'stream');
      res.setHeader('Accept-Ranges','bytes'); res.setHeader('Content-Type','video/*');
      res.setHeader('Content-Disposition',`inline; filename="${name}"`);
      let start=0,end=size-1,code=200; const range=req.headers.range;
      if(range){ const m=/bytes=(\d*)-(\d*)/.exec(range); if(m){ if(m[1]) start=parseInt(m[1]); if(m[2]) end=parseInt(m[2]); code=206; } }
      if(start> end || start>=size){ res.statusCode=416; res.end(); return; }
      res.statusCode=code; res.setHeader('Content-Length', String(end-start+1));
      if(code===206) res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
      const s=file.createReadStream({start,end}); s.on('error',e=>{try{res.destroy(e);}catch{}}); s.pipe(res);
    }).listen(port,'127.0.0.1',()=>resolve(server));
    server.on('error',reject);
  });
}

// ---- нормализация и выбор файла
function norm(p){ return String(p||'').replace(/\\/g,'/').replace(/^\.?\/*/,'').toLowerCase(); }
function buildFileMaps(torrent){
  const map=new Map(), baseMap=new Map();
  const root = norm(torrent.name||'');
  for(const f of torrent.files){
    const full = String(f.path||f.name||'').replace(/\\/g,'/');
    const noRoot = full.toLowerCase().startsWith(root?root+'/': '___never___') ? full.slice((torrent.name||'').length+1) : full;
    const keys = [full, noRoot, f.name];
    for(const k of keys){
      const n = norm(k);
      if(n) map.set(n, f);
    }
    const base=path.basename(full).toLowerCase();
    if(!baseMap.has(base)) baseMap.set(base, []);
    baseMap.get(base).push(f);
  }
  return { map, baseMap, root };
}
function chooseFile(torrent, sel){
  if(sel.ALL){
    const vids = torrent.files.filter(f=>/\.(mp4|mkv|avi|mov|m4v|ts|webm)$/i.test(f.name||f.path||''));
    return (vids.sort((a,b)=>b.length-a.length)[0]) || torrent.files[0];
  }
  const { map, baseMap } = buildFileMaps(torrent);
  const relN = norm(sel.REL);
  if(map.has(relN)) return map.get(relN);
  const relBase = path.basename(sel.REL).toLowerCase();
  const arr = baseMap.get(relBase) || [];
  if(arr.length===1) return arr[0];
  if(arr.length>1 && Number.isFinite(sel.SIZE)){
    let best=arr[0], bestDiff=Infinity;
    for(const f of arr){ const d=Math.abs((f.length||0) - sel.SIZE); if(d<bestDiff){ best=f; bestDiff=d; } }
    return best;
  }
  for(const f of torrent.files){
    const full=norm(f.path||f.name||'');
    if(full.endsWith('/'+relN) || full.endsWith(relN) || full.includes('/'+relN)) return f;
  }
  return torrent.files[0];
}

// ---- воспроизведение выбранного файла (с очисткой кэша ПОСЛЕ закрытия VLC)
async function playWithLib(src, sel, outDir){
  const { default: WebTorrent } = await import('webtorrent'); // ESM → CJS
  const client = new WebTorrent({ dht:true });
  G.client = client; G.outDir = outDir;

  const opts = { path: outDir };
  const t = (typeof src==='string' && src.startsWith('magnet:')) ? client.add(src, opts) : client.add(fs.readFileSync(src), opts);

  let torrent;
  await new Promise((resolve, reject)=>{
    t.once('ready', ()=>{ torrent=t; resolve(); });
    t.once('error', reject);
  });

  torrent.deselect(0, torrent.pieces.length-1, false);
  torrent.files.forEach(f=>f.deselect());
  const file = chooseFile(torrent, sel);
  if(!file){ try{client.destroy(()=>{});}catch{} safeCleanDir(outDir); return 1; }
  file.select();

  const port = 8123 + Math.floor(Math.random()*2000);
  const server = await serveFile(file, port);
  G.server = server;

  const vlc = vlcPath();
  const metaTitle = path.basename(file.path || file.name || 'stream');
  const p = spawn(vlc, ['--play-and-exit', '--meta-title', metaTitle, `http://127.0.0.1:${port}/`], { stdio:'ignore' });

  await new Promise(res=>p.on('close', res));

  // закрываем сервер, уничтожаем клиент
  await new Promise(res=>server.close(res));
  G.server = null;
  await new Promise(res=>client.destroy(res));
  G.client = null;

  // ЖЁСТКАЯ ОЧИСТКА КЭША ПОСЛЕ ЗАКРЫТИЯ VLC
  safeCleanDir(outDir);

  return 0;
}

async function playSequential(src, selections, outDir){
  for(let i=0;i<selections.length;i++){
    const sel = selections[i];
    const label = sel.ALL ? 'ВСЕ' : sel.REL;
    console.log(`\n=== ${i+1}/${selections.length}: ${label} ===`);
    const code = await playWithLib(src, sel, outDir);
    if(code!==0) console.error('Не удалось воспроизвести этот файл.');
  }
  console.log('\nГотово.');
}

(async function main(){
  try{
    installExitHandlers();

    // источник
    const found=scanTorrents();
    const choices=[];
    if(found.length) choices.push({name:'Выбрать из найденных .torrent (сорт/поиск)', value:'__FOUND__'});
    choices.push({name:'Вставить magnet', value:'__MAGNET__'});
    choices.push({name:'Указать .torrent вручную', value:'__MANUAL__'});
    const {mode}=await inquirer.prompt([{type:'list',name:'mode',message:'Источник',choices}]);
    let src;
    if(mode==='__FOUND__'){
      const {sortk}=await inquirer.prompt([{type:'list',name:'sortk',message:'Сортировка',default:'date_desc',choices:SORTS.map(s=>({name:s.n,value:s.k}))}]);
      found.sort((SORTS.find(s=>s.k===sortk)||SORTS[0]).f);
      const {q}=await inquirer.prompt([{type:'input',name:'q',message:'Фильтр (строка или /regex/)',default:''}]);
      let list=found;
      if(q.trim()){
        const s=q.trim();
        if(s.startsWith('/')&&s.endsWith('/')&&s.length>2){ try{const rx=new RegExp(s.slice(1,-1),'i'); list=found.filter(it=>rx.test(it.name)); }catch{ list=found.filter(it=>it.name.toLowerCase().includes(s.toLowerCase())); } }
        else list=found.filter(it=>it.name.toLowerCase().includes(s.toLowerCase()));
        if(!list.length) throw new Error('По фильтру пусто');
      }
      const {pick}=await inquirer.prompt([{type:'list',name:'pick',message:'Файл .torrent',choices:list.map(it=>({name:`${it.name} — ${it.dir} [${fmtDate(it.ts)}, ${fmtBytes(it.size)}]`,value:it.full})),pageSize:12}]);
      src = pick;
    } else if(mode==='__MAGNET__'){
      const {mag}=await inquirer.prompt([{type:'input',name:'mag',message:'magnet:'}]);
      if(!mag.startsWith('magnet:')) throw new Error('Неверный magnet'); src = mag;
    } else {
      const {p}=await inquirer.prompt([{type:'input',name:'p',message:'Путь к .torrent:'}]);
      const abs=path.resolve(p); if(!fs.existsSync(abs)) throw new Error('Файл не найден'); src = abs;
    }

    // файлы и выбор
    const items = await listFiles(src);
    const selections = await pickFiles(items);

    // кэш папка
    const outDir = (await inquirer.prompt([{type:'input',name:'outDir',message:'Папка кэша/загрузки',default:path.join(os.homedir(),'Movies','WebTorrent')}])).outDir;
    fs.mkdirSync(outDir,{recursive:true});
    G.outDir = outDir;

    await playSequential(src, selections, outDir);
  }catch(e){
    console.error('Ошибка:', e.message||e); process.exit(1);
  }
})();

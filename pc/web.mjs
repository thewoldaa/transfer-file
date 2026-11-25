// Web UI lokal untuk KabelLink: browser <-> server lokal <-> HP.
// Semua panggilan /api wajib header X-UI (cegah CSRF dari situs lain), server hanya di 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

let server = null, url = '';

const jobs = new Map();
let seq = 0;
function newJob(kind, name, mode) {
  const id = ++seq;
  const j = {
    id, kind, name, mode, total: 0, done: 0, status: 'jalan', error: null, dest: '',
    deleted: false, verified: false, at: Date.now(),
    remote: null, tmp: null, resumable: false,
  };
  jobs.set(id, j);
  for (const [k, v] of jobs) if (jobs.size > 120 && v.status !== 'jalan') jobs.delete(k);
  return j;
}

const safeSegs = rel => String(rel || '').split('/').filter(s => s && s !== '.' && s !== '..');

async function pullOne(remote, job) {
  const dest = path.join(apiRef.state.localDir, ...safeSegs(remote));
  job.dest = dest;
  job.name = path.posix.basename(remote);
  job.mode = 'file';
  const r = await apiRef.download(remote, dest, {
    cutOff: apiRef.state.cutOff,
    verify: apiRef.state.verify,
    label: job.name,
    onProgress: (d, t) => { job.done = d; job.total = t; },
  });
  job.total = job.total || r.size;
  job.done = r.size;
  job.deleted = r.deleted;
  job.verified = r.verified;
}

async function countFiles(rd) {
  const j = await apiRef.list(rd);
  if (j.error) return 0;
  let n = 0;
  for (const e of j.entries || []) n += e.dir ? await countFiles(e.path) : 1;
  return n;
}

async function pullPath(remote, job) {
  const meta = await apiRef.list(remote);
  if (meta && !meta.error) {
    job.mode = 'folder';
    job.total = await countFiles(remote);
    let doneCount = 0;
    async function walkDir(rd) {
      const j = await apiRef.list(rd);
      if (j.error) throw new Error(j.error);
      for (const e of j.entries || []) {
        if (e.dir) await walkDir(e.path);
        else {
          await pullOne(e.path, { ...job, mode: 'file' });
          doneCount++;
          job.done = doneCount;
          const st = await fsp.stat(path.join(apiRef.state.localDir, ...safeSegs(e.path))).catch(() => ({ size: 0 }));
          job.bytes = (job.bytes || 0) + st.size;
        }
      }
    }
    await walkDir(remote);
    if (apiRef.state.cutOff) {
      await apiRef.prune(remote);
      job.deleted = true;
    }
    job.verified = job.verified || apiRef.state.verify || apiRef.state.cutOff;
    job.done = job.total;
    return;
  }
  await pullOne(remote, job);
}

function openBrowser(u) {
  const cmd = process.platform === 'win32' ? `start "" "${u}"`
    : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
  exec(cmd, { shell: true }, () => {});
}

/** Jalankan unduhan (file atau folder) sebagai job; gagal => bisa dilanjutkan. */
function runPull(j) {
  (async () => {
    try { await pullPath(j.remote, j); j.status = 'selesai'; }
    catch (e) { j.status = 'gagal'; j.error = e.message; j.resumable = true; }
  })();
}

function openFolder(dir) {
  const cmd = process.platform === 'win32' ? `explorer "${dir}"`
    : process.platform === 'darwin' ? `open "${dir}"` : `xdg-open "${dir}"`;
  exec(cmd, { shell: true }, () => {});
}

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
};

async function readJson(req) {
  let n = 0; const parts = [];
  for await (const c of req) { n += c.length; if (n > 1048576) throw new Error('body terlalu besar'); parts.push(c); }
  if (!parts.length) return {};
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

const loopback = req => {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

let apiRef = null;

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  if (!loopback(req)) { json(res, 403, { error: 'hanya lokal' }); return; }

  if (u.pathname === '/' || u.pathname === '/index.html') {
    const b = Buffer.from(PAGE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
    return;
  }
  if (!u.pathname.startsWith('/api/')) { json(res, 404, { error: 'not found' }); return; }
  if (req.headers['x-ui'] !== '1') { json(res, 403, { error: 'header X-UI wajib' }); return; }

  try {
    const p = u.pathname;

    if (p === '/api/state' && req.method === 'GET') return json(res, 200, apiRef.state);

    if (p === '/api/list' && req.method === 'GET') {
      const j = await apiRef.list(u.searchParams.get('dir') || '');
      return json(res, 200, j);
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      return json(res, 200, [...jobs.values()].sort((a, b) => b.id - a.id).slice(0, 40));
    }

    if (p === '/api/pull' && req.method === 'POST') {
      const { path: remote } = await readJson(req);
      if (!remote) return json(res, 400, { error: 'path kosong' });
      const j = newJob('unduh', path.posix.basename(remote), 'file');
      j.remote = remote;
      runPull(j);
      return json(res, 200, j);
    }

    if (p === '/api/resume' && req.method === 'POST') {
      const { id } = await readJson(req);
      const j = jobs.get(Number(id));
      if (!j) return json(res, 404, { error: 'transfer tidak ada' });
      if (j.status === 'jalan') return json(res, 400, { error: 'masih berjalan' });
      if (j.kind === 'unduh' && j.remote) {
        Object.assign(j, { status: 'jalan', error: null, done: 0, resumable: false });
        runPull(j);
        return json(res, 200, j);
      }
      if (j.kind === 'kirim' && j.tmp) {
        const tmp = j.tmp;
        if (!(await fsp.stat(tmp).catch(() => null))) return json(res, 400, { error: 'salinan sementara sudah hilang' });
        Object.assign(j, { status: 'jalan', error: null, done: 0, resumable: false });
        (async () => {
          try {
            await apiRef.upload(tmp, j.remote, { onProgress: d => { j.done = d; } });
            j.status = 'selesai';
            await fsp.rm(tmp, { force: true });
            j.tmp = null;
          } catch (e) { j.status = 'gagal'; j.error = e.message; j.resumable = true; }
        })();
        return json(res, 200, j);
      }
      return json(res, 400, { error: 'transfer ini tidak bisa dilanjutkan' });
    }

    if (p === '/api/ul' && req.method === 'POST') {
      const dir = u.searchParams.get('dir') || '';
      let name = '';
      try { name = decodeURIComponent(String(req.headers['x-name'] || '')); } catch {}
      if (!name || /[/\\]/.test(name)) return json(res, 400, { error: 'nama file tidak valid' });
      const tmp = path.join(os.tmpdir(), `kl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const len = Number(req.headers['content-length'] || 0);
      let got = 0;
      req.on('data', c => { got += c.length; });
      const ws = fs.createWriteStream(tmp);
      await new Promise((ok, bad) => { req.pipe(ws); ws.on('close', ok); ws.on('error', bad); req.on('error', bad); });
      if (len && got !== len) { await fsp.rm(tmp, { force: true }); return json(res, 400, { error: `upload terputus (${got}/${len})` }); }
      const j = newJob('kirim', name, 'file');
      j.total = (await fsp.stat(tmp)).size;
      j.remote = apiRef.join(dir, name);
      j.tmp = tmp;
      (async () => {
        try {
          await apiRef.upload(tmp, j.remote, { onProgress: (d) => { j.done = d; } });
          j.status = 'selesai';
          await fsp.rm(tmp, { force: true });
          j.tmp = null;
        } catch (e) { j.status = 'gagal'; j.error = e.message; j.resumable = true; }
      })();
      return json(res, 200, j);
    }

    if (p === '/api/rm' && req.method === 'POST') {
      return json(res, 200, await apiRef.remove(u.searchParams.get('path') || ''));
    }

    if (p === '/api/cutoff' && req.method === 'POST') {
      const { on } = await readJson(req);
      await apiRef.setCutOff(on);
      return json(res, 200, apiRef.state);
    }

    if (p === '/api/verify' && req.method === 'POST') {
      const { on } = await readJson(req);
      await apiRef.setVerify(on);
      return json(res, 200, apiRef.state);
    }

    if (p === '/api/limit' && req.method === 'POST') {
      const { kbps } = await readJson(req);
      await apiRef.setLimit(kbps);
      return json(res, 200, apiRef.state);
    }

    if (p === '/api/token' && req.method === 'POST') {
      const { token } = await readJson(req);
      await apiRef.setToken(token);
      await apiRef.reconnect();
      return json(res, 200, apiRef.state);
    }

    if (p === '/api/reconnect' && req.method === 'POST') {
      return json(res, 200, await apiRef.reconnect());
    }

    if (p === '/api/open' && req.method === 'POST') {
      const dir = apiRef.state.localDir;
      await fsp.mkdir(dir, { recursive: true });
      openFolder(dir);
      return json(res, 200, { ok: true, dir });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

function listen(srv, port) {
  return new Promise((ok, bad) => {
    const onErr = e => { srv.removeListener('listening', onOk); bad(e); };
    const onOk = () => { srv.removeListener('error', onErr); ok(srv.address().port); };
    srv.once('error', onErr);
    srv.once('listening', onOk);
    srv.listen(port, '127.0.0.1');
  });
}

export async function startUi(api, opts = {}) {
  apiRef = api;
  const open = opts.open !== false;
  if (server) { if (open) openBrowser(url); return url; }
  const srv = http.createServer((req, res) => { route(req, res); });
  let port = 8767;
  for (; port < 8780; port++) {
    try { await listen(srv, port); break; } catch { if (port === 8779) throw new Error('port 8767-8779 penuh'); }
  }
  server = srv;
  url = `http://127.0.0.1:${port}`;
  console.log(`Web UI: ${url}  (tutup dengan Ctrl+C atau biarkan)`);
  if (open) openBrowser(url);
  return url;
}

const PAGE = `<!doctype html>
<html lang="id"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KabelLink — transfer file</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b35;--txt:#e7eaf0;--dim:#8b94a5;--acc:#4c8dff;--ok:#38d39f;--bad:#ff6b6b;--warn:#ffc857}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;gap:14px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:#12151b;position:sticky;top:0;z-index:5;flex-wrap:wrap}
h1{font-size:16px;margin:0;letter-spacing:.3px}
.pill{display:inline-flex;gap:7px;align-items:center;padding:4px 10px;border:1px solid var(--line);border-radius:999px;color:var(--dim);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--bad)}
.dot.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.spacer{flex:1}
button{font:inherit;color:var(--txt);background:#1e232c;border:1px solid var(--line);border-radius:8px;padding:7px 12px;cursor:pointer}
button:hover{border-color:#3a4353;background:#232936}
button.primary{background:var(--acc);border-color:var(--acc);color:#08101f;font-weight:600}
button.ghost{background:transparent}
button:disabled{opacity:.45;cursor:not-allowed}
main{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,.65fr);gap:18px;padding:18px 20px;max-width:1500px;margin:0 auto}
@media(max-width:960px){main{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.card h2{margin:0;padding:12px 14px;font-size:13px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
.crumb{display:flex;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap;font-size:13px}
.crumb a{color:var(--acc);cursor:pointer;text-decoration:none}
.crumb span{color:var(--dim)}
table{width:100%;border-collapse:collapse}
td,th{padding:9px 14px;border-bottom:1px solid #1d222b;text-align:left;vertical-align:middle}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);font-weight:600}
tr:hover td{background:#1a1f27}
td.n{font-variant-numeric:tabular-nums;color:var(--dim);white-space:nowrap}
.name{display:flex;align-items:center;gap:9px;min-width:0}
.name b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ico{width:18px;text-align:center;opacity:.8;flex:none}
.acts{display:flex;gap:6px;justify-content:flex-end;flex-wrap:nowrap}
.acts button{padding:4px 9px;font-size:12px;border-radius:7px;white-space:nowrap}
.drop{margin:14px;border:2px dashed #2f3745;border-radius:12px;padding:26px 16px;text-align:center;color:var(--dim);transition:.15s}
.drop.hot{border-color:var(--acc);background:#16203a;color:var(--txt)}
.drop b{color:var(--txt)}
.row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #1d222b;font-size:13px}
.row:last-child{border-bottom:0}
.row .t{flex:1;min-width:0}
.row .t b{display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .t small{color:var(--dim)}
.bar{height:4px;background:#232936;border-radius:99px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;width:0;background:var(--acc);transition:width .25s}
.bar i.ok{background:var(--ok)}.bar i.bad{background:var(--bad)}
.tags{display:flex;flex-direction:column;gap:10px;padding:14px}
.tag{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#141821}
.tag small{display:block;color:var(--dim);font-size:11px}
.sw{position:relative;width:42px;height:23px;border-radius:99px;background:#2a3040;border:1px solid var(--line);cursor:pointer;flex:none}
.sw i{position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#8b94a5;transition:.18s}
.sw.on{background:#1d3b2f;border-color:#2a6b52}
.sw.on i{left:21px;background:var(--ok)}
.muted{color:var(--dim)}
.warnbox{margin:14px;padding:10px 12px;border:1px solid #5a4620;background:#2a2113;color:var(--warn);border-radius:10px;font-size:12.5px}
input[type=text]{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#12151b;color:var(--txt);font:inherit}
select{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#12151b;color:var(--txt);font:inherit;margin-top:8px}
select:focus{outline:1px solid var(--acc)}
.hint{font-size:11.5px;color:var(--dim);margin-top:6px}
.empty{padding:22px;text-align:center;color:var(--dim)}
.toast{position:fixed;right:18px;top:70px;background:#20262f;border:1px solid var(--line);padding:10px 14px;border-radius:10px;opacity:0;transform:translateY(-8px);transition:.2s;max-width:380px;z-index:20}
.toast.on{opacity:1;transform:none}
</style></head><body>
<header>
  <h1>KabelLink</h1>
  <span class="pill"><span class="dot" id="dot"></span><span id="via">menghubungkan…</span></span>
  <span class="pill" id="free">sisa: —</span>
  <span class="spacer"></span>
  <button id="openFolder" class="ghost">Buka folder PC</button>
  <button id="btnToken" class="ghost">Token</button>
  <button id="reconnect" class="ghost">Cari HP</button>
</header>
<main>
  <section class="card">
    <h2>Isi HP <span class="spacer"></span><button id="refresh" class="ghost" style="padding:3px 9px;font-size:12px">Muat ulang</button></h2>
    <div class="crumb" id="crumb"></div>
    <table><thead><tr><th>Nama</th><th style="width:92px">Ukuran</th><th style="width:232px"></th></tr></thead>
    <tbody id="files"><tr><td colspan="3" class="empty">memuat…</td></tr></tbody></table>
  </section>

  <aside style="display:flex;flex-direction:column;gap:18px;min-width:0">
    <section class="card">
      <h2>Kirim ke HP</h2>
      <div class="drop" id="drop">
        <b>Taruh file di sini</b><br>atau klik untuk pilih file<br>
        <small id="dropTarget">tujuan: folder akar</small>
        <input type="file" id="picker" multiple hidden>
      </div>
      <div class="tags">
        <div class="tag">
          <div><b>Cut-off</b><small>hapus di HP setelah unduhan lolos SHA-256</small></div>
          <div class="sw" id="swCut"><i></i></div>
        </div>
        <div class="tag">
          <div><b>Verifikasi SHA-256</b><small>cek isi file setelah diunduh</small></div>
          <div class="sw" id="swVer"><i></i></div>
        </div>
        <div class="tag" style="display:block">
          <b style="font-size:13px">Folder simpan di PC</b>
          <div class="hint" id="localDir" style="word-break:break-all">—</div>
        </div>
        <div id="tokenBox" style="display:none">
          <b style="font-size:13px">Token dari layar HP</b>
          <input type="text" id="token" placeholder="8 karakter" autocomplete="off">
          <div class="hint">Sekali saja; disimpan di config PC.</div>
          <button class="primary" id="saveToken" style="margin-top:8px;width:100%">Simpan token</button>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Mode transmisi lambat</h2>
      <div class="tags">
        <div class="tag" style="display:block">
          <b style="font-size:13px">Batas kecepatan</b>
          <select id="limit">
            <option value="0">Penuh (tanpa batas)</option>
            <option value="128">128 KB/detik — paling dingin</option>
            <option value="256">256 KB/detik</option>
            <option value="512">512 KB/detik</option>
            <option value="1024">1 MB/detik</option>
            <option value="2048">2 MB/detik</option>
            <option value="4096">4 MB/detik</option>
          </select>
          <div class="hint">Untuk transfer besar semalam: pilih lambat supaya HP dan PC tidak panas. Progress tetap jalan, dan kalau koneksi putus transfer bisa dilanjutkan.</div>
        </div>
        <div class="tag" style="display:block">
          <div><b style="font-size:13px">Jalan di latar belakang</b>
          <div class="hint">Transfer tetap berjalan walau jendela ini ditutup. Dari terminal: <b>bg</b> untuk mulai, <b>stop</b> untuk berhenti, <b>autostart on</b> supaya ikut menyala bersama Windows.</div></div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Antrean</h2>
      <div id="jobs"><div class="empty">belum ada transfer</div></div>
    </section>
  </aside>
</main>
<div class="toast" id="toast"></div>
<script>
var H={'x-ui':'1'}, dir='', state=null, listing=null, timer=null, showToken=false;
function $(s){return document.querySelector(s)}
function esc(t){return String(t)}
function bytes(n){if(!n)return '0 B';var u=['B','KB','MB','GB','TB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return (i?n.toFixed(1):n)+' '+u[i]}
function toast(m){var t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('on')},2600)}
function api(u,o){o=o||{};o.headers=Object.assign({},H,o.headers||{});return fetch(u,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j})})}
function post(u,body){return api(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})}

function paintState(){
  if(!state)return;
  $('#dot').className='dot'+(state.connected?' on':'');
  $('#via').textContent=state.via||'belum terhubung';
  $('#swCut').className='sw'+(state.cutOff?' on':'');
  $('#swVer').className='sw'+(state.verify?' on':'');
  $('#localDir').textContent=state.localDir;
  $('#tokenBox').style.display=(!state.tokenSet||showToken)?'block':'none';
  if(state.cutOff)$('#swVer').classList.add('on');
  setLimitSelect(state.limitKBps||0);
}

function setLimitSelect(v){
  var sel=$('#limit');
  if(!sel||document.activeElement===sel)return;
  v=String(v||0);
  if(!Array.prototype.some.call(sel.options,function(o){return o.value===v})){
    var o=document.createElement('option');o.value=v;o.textContent=v+' KB/detik';sel.appendChild(o);
  }
  sel.value=v;
}

function paintCrumb(){
  var el=$('#crumb');el.textContent='';
  var a=document.createElement('a');a.textContent='HP';a.onclick=function(){dir='';loadDir()};el.appendChild(a);
  var parts=dir?dir.split('/'):[];
  var acc='';
  parts.forEach(function(p){acc=acc?acc+'/'+p:p;var s=document.createElement('span');s.textContent='/';el.appendChild(s);
    var l=document.createElement('a');l.textContent=p;var target=acc;l.onclick=function(){dir=target;loadDir()};el.appendChild(l)});
}

function rowFile(e){
  var tr=document.createElement('tr');
  var td=document.createElement('td');var d=document.createElement('div');d.className='name';
  var i=document.createElement('span');i.className='ico';i.textContent=e.dir?'📁':'📄';
  var b=document.createElement('b');b.textContent=e.name;
  d.appendChild(i);d.appendChild(b);td.appendChild(d);tr.appendChild(td);
  var sz=document.createElement('td');sz.className='n';sz.textContent=e.dir?'—':bytes(e.size);tr.appendChild(sz);
  var ac=document.createElement('td');var w=document.createElement('div');w.className='acts';
  if(e.dir){
    var o=document.createElement('button');o.textContent='Buka';o.onclick=function(){dir=e.path;loadDir()};w.appendChild(o);
    var g=document.createElement('button');g.textContent='Unduh folder';g.onclick=function(){pull(e.path)};w.appendChild(g);
  } else {
    var g2=document.createElement('button');g2.className='primary';g2.textContent='Unduh';g2.onclick=function(){pull(e.path)};w.appendChild(g2);
  }
  var x=document.createElement('button');x.className='ghost';x.textContent='Hapus';x.onclick=function(){del(e.path,e.name)};w.appendChild(x);
  ac.appendChild(w);tr.appendChild(ac);
  return tr;
}

function loadDir(){
  paintCrumb();
  api('/api/list?dir='+encodeURIComponent(dir)).then(function(j){
    listing=j;
    if(typeof j.free==='number')$('#free').textContent='sisa HP: '+bytes(j.free);
    var tb=$('#files');tb.textContent='';
    if(j.error){var tr=document.createElement('tr');var td=document.createElement('td');td.colSpan=3;td.className='empty';td.textContent=j.error;tr.appendChild(td);tb.appendChild(tr);
      if(/token/i.test(j.error)){showToken=true;paintState();toast('token salah — masukkan token dari layar HP')}
      return}
    if(!j.entries||!j.entries.length){var tr2=document.createElement('tr');var td2=document.createElement('td');td2.colSpan=3;td2.className='empty';td2.textContent='folder kosong';tr2.appendChild(td2);tb.appendChild(tr2);return}
    j.entries.forEach(function(e){tb.appendChild(rowFile(e))});
    $('#dropTarget').textContent='tujuan: '+(dir||'folder akar');
  }).catch(function(e){toast('gagal daftar: '+e.message)});
}

function pull(p){
  api('/api/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})})
    .then(function(){toast('mulai mengunduh');loadJobs(true)}).catch(function(e){toast('gagal: '+e.message)});
}
function del(p,name){
  if(!confirm('Hapus "'+name+'" dari HP?'))return;
  api('/api/rm?path='+encodeURIComponent(p),{method:'POST'}).then(function(r){
    if(r.error)toast('gagal: '+r.error);else{toast('dihapus: '+name);loadDir()}
  }).catch(function(e){toast('gagal: '+e.message)});
}

function jobRow(j){
  var el=document.createElement('div');el.className='row';
  var t=document.createElement('div');t.className='t';
  var b=document.createElement('b');b.textContent=(j.kind==='unduh'?'↓ ':'↑ ')+j.name;
  var s=document.createElement('small');
  var pct=j.total?Math.min(100,Math.floor(j.done*100/j.total)):0;
  if(j.status==='jalan'){s.textContent=j.mode==='folder'?('folder '+j.done+'/'+j.total+' file'):(bytes(j.done)+' / '+bytes(j.total||0)+' · '+pct+'%')}
  else if(j.status==='selesai'){s.textContent=(j.mode==='folder'?'folder selesai · ':'')+bytes(j.done)+' · selesai'+(j.deleted?' · dihapus di HP':'')+(j.verified?' · sha256 ok':'')}
  else{s.textContent='gagal: '+(j.error||'?')}
  t.appendChild(b);t.appendChild(s);
  var bar=document.createElement('div');bar.className='bar';var fill=document.createElement('i');
  fill.style.width=(j.status==='selesai'?100:pct)+'%';
  if(j.status==='selesai')fill.className='ok';if(j.status==='gagal')fill.className='bad';
  bar.appendChild(fill);t.appendChild(bar);
  el.appendChild(t);
  if(j.status==='selesai'&&j.mode==='file'){var o=document.createElement('button');o.className='ghost';o.textContent='Buka';o.onclick=function(){post('/api/open')};el.appendChild(o)}
  if(j.status==='gagal'&&j.resumable){var rb=document.createElement('button');rb.className='primary';
    rb.textContent=j.kind==='unduh'?'Lanjutkan':'Kirim ulang';
    rb.onclick=function(){post('/api/resume',{id:j.id}).then(function(){toast('melanjutkan…');loadJobs(true)}).catch(function(e){toast('gagal: '+e.message)})};el.appendChild(rb)}
  return el;
}

function loadJobs(spin){
  api('/api/jobs').then(function(list){
    var box=$('#jobs');box.textContent='';
    if(!list.length){var d=document.createElement('div');d.className='empty';d.textContent='belum ada transfer';box.appendChild(d);return}
    list.forEach(function(j){box.appendChild(jobRow(j))});
    var running=list.some(function(j){return j.status==='jalan'});
    if(running&&!timer)timer=setTimeout(function(){timer=null;loadJobs()},700);
    if(!running&&spin){timer=setTimeout(function(){timer=null;loadJobs()},700)}
    if(!running&&list.some(function(j){return j.status==='selesai'}))loadDir();
  }).catch(function(){});
}

function uploadFiles(files){
  if(!files||!files.length)return;
  Array.prototype.forEach.call(files,function(f){
    var xhr=new XMLHttpRequest();
    xhr.open('POST','/api/ul?dir='+encodeURIComponent(dir));
    xhr.setRequestHeader('x-ui','1');
    xhr.setRequestHeader('x-name',encodeURIComponent(f.name));
    xhr.upload.onprogress=function(e){if(e.lengthComputable)toast('mengirim '+f.name+' '+Math.floor(e.loaded*100/e.total)+'%')};
    xhr.onload=function(){loadJobs(true);toast('terkirim: '+f.name)};
    xhr.onerror=function(){toast('gagal kirim: '+f.name)};
    xhr.send(f);
  });
}

$('#swCut').onclick=function(){post('/api/cutoff',{on:!state.cutOff}).then(function(s){state=s;paintState();toast('cut-off '+(s.cutOff?'AKTIF':'mati'))})};
$('#swVer').onclick=function(){post('/api/verify',{on:!state.verify}).then(function(s){state=s;paintState()})};
$('#limit').onchange=function(){var v=Number(this.value)||0;
  post('/api/limit',{kbps:v}).then(function(s){state=s;paintState();toast(v>0?'transmisi dibatasi '+v+' KB/detik':'batas kecepatan dimatikan')}).catch(function(e){toast('gagal: '+e.message)})};
$('#reconnect').onclick=function(){toast('mencari HP…');post('/api/reconnect').then(function(s){state=s;paintState();loadDir()})};
$('#btnToken').onclick=function(){showToken=!showToken;paintState();if(showToken)$('#token').focus()};
$('#openFolder').onclick=function(){post('/api/open').then(function(r){toast('folder: '+r.dir)})};
$('#refresh').onclick=function(){loadDir()};
$('#saveToken').onclick=function(){var v=$('#token').value.trim();if(!v)return toast('token kosong');
  post('/api/token',{token:v}).then(function(s){state=s;paintState();toast(s.connected?'terhubung':'token disimpan, menunggu HP');loadDir()}).catch(function(e){toast('gagal: '+e.message)})};

var drop=$('#drop'),picker=$('#picker');
drop.onclick=function(){picker.click()};
picker.onchange=function(){uploadFiles(picker.files);picker.value=''};
['dragenter','dragover'].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add('hot')})});
['dragleave','drop'].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove('hot')})});
drop.addEventListener('drop',function(e){uploadFiles(e.dataTransfer.files)});

api('/api/state').then(function(s){state=s;paintState();loadDir();loadJobs()}).catch(function(e){toast(e.message)});
setInterval(function(){api('/api/state').then(function(s){state=s;paintState()}).catch(function(){})},4000);
</script></body></html>`;

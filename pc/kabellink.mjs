#!/usr/bin/env node
// KabelLink (PC) — Node >= 24, tanpa dependensi. Jalankan sebagai root / Administrator.
// Urutan: jaringan dulu (APK di HP) -> pantau kabel USB -> kalau kabel ada, pakai kabel.
// Transfer file:  ls | get <jarak> [lokal] | put <lokal> [folder jarak] | ui
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

const run = promisify(execFile);
const HOME = process.env.KABELLINK_HOME || path.join(os.homedir(), '.transfer-file');
const CFG = path.join(HOME, 'config.json');
const HTTP_PORT = 8765, UDP_PORT = 8766, FWD_PORT = 18765, SAMSUNG = '04e8', PKG = 'app.kabellink';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

let cfg = { token: '', ip: '', cutOff: false, verify: true, localDir: path.join(os.homedir(), 'Downloads', 'transfer-file') };
const save = () => fs.mkdir(HOME, { recursive: true })
  .then(() => fs.writeFile(CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 }))
  .catch(e => log('gagal simpan config:', e.message));

// ---------- hak akses ----------
async function isElevated() {
  if (process.platform === 'win32') return run('net', ['session']).then(() => true, () => false);
  return process.getuid() === 0;
}

// ---------- adb ----------
async function adb(...args) {
  try {
    const { stdout } = await run('adb', args, { timeout: 20000 });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT', out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message };
  }
}

async function adbDevices() {
  const r = await adb('devices', '-l');
  if (!r.ok) return { missing: r.missing, list: [] };
  const list = r.out.split('\n').slice(1).map(l => l.trim()).filter(Boolean).map(l => {
    const p = l.split(/\s+/);
    return {
      serial: p[0],
      state: l.includes('no permissions') ? 'no permissions' : p[1],
      usb: !/:|^adb-|^emulator-/.test(p[0]), // serial berbentuk ip:port / mDNS = bukan kabel
    };
  });
  return { list };
}

// Apakah PC "melihat" perangkat Samsung di bus USB? (bedakan kabel cas-saja vs. debugging mati)
async function usbSeen() {
  try {
    if (process.platform === 'linux') {
      for (const d of await fs.readdir('/sys/bus/usb/devices')) {
        const v = await fs.readFile(`/sys/bus/usb/devices/${d}/idVendor`, 'utf8').catch(() => '');
        if (v.trim() === SAMSUNG) return d;
      }
      return null;
    }
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command',
        "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like '*VID_04E8*' } | Select-Object -ExpandProperty FriendlyName"]);
      return stdout.trim() || null;
    }
    const { stdout } = await run('system_profiler', ['SPUSBDataType']);
    return /0x04e8/i.test(stdout) ? 'usb' : null;
  } catch { return undefined; } // tidak bisa dicek
}

// Perbaikan khusus Linux (butuh root): aturan udev + "cabut-colok" virtual
async function linuxFix(dev) {
  if (!(await fs.stat('/etc/udev/rules.d').catch(() => null))) return; // tidak ada udev (mis. WSL/container)
  const rule = '/etc/udev/rules.d/51-kabellink.rules';
  const want = `SUBSYSTEM=="usb", ATTR{idVendor}=="${SAMSUNG}", MODE="0666"\n`;
  if ((await fs.readFile(rule, 'utf8').catch(() => '')) !== want) {
    await fs.writeFile(rule, want);
    await run('udevadm', ['control', '--reload-rules']);
    await run('udevadm', ['trigger']);
    log('aturan udev Samsung dipasang');
  }
  if (dev) {
    const a = `/sys/bus/usb/devices/${dev}/authorized`;
    await fs.writeFile(a, '0'); await sleep(600); await fs.writeFile(a, '1');
    log('port USB di-reset (cabut-colok virtual)');
  }
}

let ROOT = false;
async function tryCable() {
  const d = await adbDevices();
  if (d.missing) return { hint: 'adb tidak ditemukan — pasang platform-tools (Linux: apt install adb)' };
  const usbs = d.list.filter(x => x.usb);
  const u = usbs.find(x => x.state === 'device') ?? usbs[0];
  if (u?.state === 'device') return { serial: u.serial };
  if (u?.state === 'unauthorized') return { hint: 'Di HP: tap "Izinkan" pada dialog USB debugging (centang "Selalu izinkan")' };
  if (u?.state === 'offline') {
    await adb('kill-server'); await adb('start-server');
    return { hint: 'adb offline — server di-restart' };
  }
  if (u?.state === 'no permissions') {
    if (ROOT && process.platform === 'linux') {
      await linuxFix(null); await adb('kill-server'); await adb('start-server');
      return { hint: 'izin USB diperbaiki, mencoba lagi' };
    }
    return { hint: 'izin USB kurang — jalankan sebagai root' };
  }
  const seen = await usbSeen();
  if (seen === null) return { hint: 'PC tidak melihat HP di USB: kabel hanya-cas/rusak, port bermasalah, atau HP belum tercolok' };
  return { seen, hint: 'HP terlihat di USB tapi adb belum: USB debugging mati atau driver Samsung belum terpasang' };
}

// ---------- jaringan ----------
const ifaces = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal);
const toInt = ip => ip.split('.').reduce((a, o) => ((a << 8) | +o) >>> 0, 0);
const toIp = n => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

async function pingHost(ip, ms = 1200, port = HTTP_PORT) {
  try {
    const r = await fetch(`http://${ip}:${port}/ping`, { signal: AbortSignal.timeout(ms) });
    return (await r.json()).app === 'kabellink';
  } catch { return false; }
}

function udpDiscover(ms = 1500) {
  return new Promise(res => {
    const s = dgram.createSocket('udp4');
    let t, done = false;
    const end = v => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch {} res(v); };
    t = setTimeout(() => end(null), ms);
    s.on('error', () => end(null));
    s.on('message', (m, r) => {
      try { if (JSON.parse(m).app === 'kabellink') end({ ip: r.address, port: HTTP_PORT }); } catch {}
    });
    s.bind(0, () => {
      s.setBroadcast(true);
      for (const i of ifaces()) s.send('KABELLINK?', UDP_PORT, toIp((toInt(i.address) | ~toInt(i.netmask)) >>> 0));
    });
  });
}

async function scanSubnet() {
  for (const i of ifaces()) {
    const pre = i.address.split('.').slice(0, 3).join('.');
    const hits = await Promise.all(Array.from({ length: 254 }, (_, k) => `${pre}.${k + 1}`)
      .map(async ip => (await pingHost(ip, 700)) ? ip : null));
    const ip = hits.find(Boolean);
    if (ip) return { ip, port: HTTP_PORT };
  }
  return null;
}

async function findNet() {
  if (cfg.ip && await pingHost(cfg.ip)) return { ip: cfg.ip, port: HTTP_PORT };
  return (await udpDiscover()) ?? (await scanSubnet());
}

// ---------- transport: kabel (via adb forward) diutamakan, Wi-Fi cadangan ----------
const st = { serial: null, net: null };
const bases = () => [
  st.serial && `http://127.0.0.1:${FWD_PORT}`,
  st.net && `http://${st.net.ip}:${st.net.port}`,
].filter(Boolean);

async function phoneFetch(p, init) {
  let err = new Error('belum terhubung — nyalakan APK atau colok kabel');
  for (const b of bases()) {
    try { return await fetch(b + p, init); } catch (e) { err = e; }
  }
  throw err;
}

async function call(p, body) {
  const r = await phoneFetch(p, {
    method: body === undefined ? 'GET' : 'POST', body,
    headers: { 'X-Token': cfg.token }, signal: AbortSignal.timeout(20000),
  });
  return await r.json();
}

// ---------- pemantau ----------
let lastMsg = '';
const say = m => { if (m !== lastMsg) { log(m); lastMsg = m; } };
let busy = false, tries = 0, lastNet = 0, apkKicked = false, debugTried = false;
let ready = null; // selesai koneksi pertama; perintah user menunggu ini

async function tick() {
  if (busy) return; busy = true;
  try {
    // 1) kabel
    const c = await tryCable();
    if (c.serial) {
      if (st.serial !== c.serial) {
        st.serial = c.serial; apkKicked = false; tries = 0;
        await adb('-s', c.serial, 'forward', `tcp:${FWD_PORT}`, `tcp:${HTTP_PORT}`);
      }
      if (!apkKicked && !(await pingHost('127.0.0.1', 1500, FWD_PORT))) {
        apkKicked = true; // nyalakan service APK lewat kabel
        await adb('-s', c.serial, 'shell', 'am', 'start-foreground-service', '-n', `${PKG}/.LinkService`);
      }
    } else {
      st.serial = null; tries++;
      if (c.seen && tries === 3 && ROOT && process.platform === 'linux') await linuxFix(c.seen).catch(e => log('reset gagal:', e.message));
    }

    // 2) jaringan
    if (st.net && !(await pingHost(st.net.ip, 1500))) { st.net = null; debugTried = false; }
    if (!st.net && Date.now() - lastNet > 8000) {
      lastNet = Date.now();
      st.net = await findNet();
      if (st.net && st.net.ip !== cfg.ip) { cfg.ip = st.net.ip; await save(); }
    }

    // 3) lewat jaringan: nyalakan USB debugging di HP supaya kabel bisa langsung terbaca
    if (st.net && cfg.token && !debugTried) {
      debugTried = true;
      const info = await call('/info').catch(() => null);
      if (info?.error) log(`APK menolak: ${info.error} (ketik: token <kode dari layar HP>)`);
      else if (info && !info.adb_enabled) {
        const r = await call('/adb-on', '').catch(e => ({ ok: false, error: e.message }));
        log(r.ok ? 'USB debugging dinyalakan lewat jaringan' : `adb-on gagal: ${r.error}`);
      }
    }

    const via = st.serial ? `KABEL (${st.serial})${st.net ? ' + Wi-Fi cadangan' : ''}` : st.net ? `Wi-Fi (${st.net.ip}) — menunggu kabel` : null;
    say(via ? `terhubung via ${via}` : `belum terhubung — ${c.hint ?? 'mencari...'}`);
  } catch (e) { log('error:', e.message); }
  busy = false;
}

// ---------- ukuran & progress ----------
const fmt = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)}G`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}B`;
let lineLen = 0;
function draw(text) {
  if (!process.stdout.isTTY) return; // output dipipe/log: jangan spam \r
  const pad = Math.max(0, lineLen - text.length);
  process.stdout.write(`\r${text}${' '.repeat(pad)}`);
  lineLen = text.length;
}
function done() { if (lineLen) { process.stdout.write('\n'); lineLen = 0; } }
const drawProgress = (label, sent, total) => {
  const pct = total ? Math.floor(sent * 100 / total) : 0;
  draw(`${label}  ${pct}%  ${fmt(sent)}${total ? '/' + fmt(total) : ''}`);
};

function meter(total, label, onTick) {
  let sent = 0, last = 0;
  const tickFn = onTick || ((d, t) => drawProgress(label, d, t));
  return new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      const now = Date.now();
      if (now - last > 150) { last = now; tickFn(sent, total); }
      cb(null, chunk);
    },
    flush(cb) { tickFn(sent, total); if (!onTick && process.stdout.isTTY) done(); cb(); },
  });
}

// ---------- transfer file ----------
const enc = encodeURIComponent;
const joinRemote = (dir, name) => `${String(dir || '').replace(/^\/+|\/+$/g, '') ? String(dir).replace(/^\/+|\/+$/g, '') + '/' : ''}${name}`;

async function listRemote(dir = '') {
  return call('/files?dir=' + enc(dir));
}

async function deleteRemote(remote) {
  const r = await phoneFetch(`/file?path=${enc(remote)}`, {
    method: 'DELETE', headers: { 'X-Token': cfg.token }, signal: AbortSignal.timeout(20000),
  });
  return r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}

async function hashRemote(remote) {
  const r = await phoneFetch(`/hash?path=${enc(remote)}`, { headers: { 'X-Token': cfg.token } });
  return r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}

async function localHash(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/**
 * Unduh satu file. Mendukung lanjut-unduh (.part + Range), verifikasi SHA-256,
 * dan mode cut-off (hapus di HP hanya setelah ukuran + checksum cocok).
 */
async function downloadOne(remote, localFile, opt = {}) {
  const { cutOff = false, verify = false, label = path.basename(localFile), onProgress } = opt;
  const part = `${localFile}.part`;
  let restarted = false;
  let err = new Error('belum terhubung');
  for (const b of bases()) {
    try {
      let have = 0;
      try { have = (await fs.stat(part)).size; } catch {}
      const headers = { 'X-Token': cfg.token };
      if (have > 0) headers.Range = `bytes=${have}-`;
      const r = await fetch(`${b}/file?path=${enc(remote)}`, { headers });
      if (r.status === 416) {
        await fs.rm(part, { force: true });
        if (restarted) throw new Error('range ditolak HP');
        restarted = true;
        return downloadOne(remote, localFile, opt);
      }
      if (!r.ok) {
        let m = `HTTP ${r.status}`;
        try { m = (await r.json()).error || m; } catch {}
        throw new Error(m);
      }
      const clen = Number(r.headers.get('content-length') || 0);
      const total = r.status === 206 ? have + clen : clen;
      if (r.status !== 206) have = 0;
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      let got = have;
      const tick = onProgress || ((d, t) => drawProgress(label, d, t));
      await pipeline(
        Readable.fromWeb(r.body),
        new Transform({ transform(c, _e, cb) { got += c.length; tick(got, total); cb(null, c); } }),
        createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }),
      );
      const size = (await fs.stat(part)).size;
      if (total && size !== total) throw new Error(`ukuran tidak cocok: ${size}/${total}`);

      const needCheck = verify || cutOff;
      if (needCheck) {
        tick(size, size);
        const rh = await hashRemote(remote);
        if (!rh || rh.error) throw new Error(`cek SHA-256 di HP gagal: ${rh?.error || '?'}`);
        const lh = await localHash(part);
        if (rh.sha256 !== lh) {
          const e = new Error('SHA-256 tidak cocok — file TIDAK dihapus dari HP');
          e.fatal = true;
          throw e;
        }
      }
      await fs.rename(part, localFile);

      let deleted = false;
      if (cutOff) {
        const d = await deleteRemote(remote);
        deleted = !!d.ok;
        if (!deleted) log(`peringatan: gagal hapus ${remote}: ${d.error || '?'}`);
      }
      return { size, deleted, verified: needCheck };
    } catch (e) {
      err = e;
      if (e.fatal) throw e;
    }
  }
  throw err;
}

async function uploadOne(localFile, remote, opt = {}) {
  const size = (await fs.stat(localFile)).size;
  const { onProgress, label = path.basename(localFile) } = opt;
  let err = new Error('belum terhubung');
  for (const b of bases()) {
    try {
      const r = await fetch(`${b}/file?path=${enc(remote)}`, {
        method: 'PUT',
        headers: { 'X-Token': cfg.token, 'Content-Length': String(size) },
        body: createReadStream(localFile).pipe(meter(size, label, onProgress)),
        duplex: 'half',
      });
      const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      return j.size ?? size;
    } catch (e) { err = e; }
  }
  throw err;
}

const safeName = n => (typeof n === 'string' && n && n !== '.' && n !== '..' && !/[/\\]/.test(n)) ? n : null;

async function pruneDirs(remoteDir) {
  if (!remoteDir) return;
  const j = await listRemote(remoteDir).catch(() => null);
  if (j && !j.error) for (const e of j.entries || []) if (e.dir) await pruneDirs(e.path);
  await deleteRemote(remoteDir).catch(() => null);
}

async function get(remote, local, opt = {}) {
  const rel = String(remote || '').replace(/^\/+/, '');
  const cutOff = opt.cutOff ?? cfg.cutOff;
  const verify = opt.verify ?? cfg.verify;
  const meta = await listRemote(rel).catch(() => null);
  if (meta && !meta.error) { // folder
    const target = path.resolve(local || path.basename(rel) || 'phone');
    let files = 0, bytes = 0, deleted = 0;
    async function walk(rd, ld) {
      const j = await listRemote(rd);
      if (j.error) throw new Error(j.error);
      await fs.mkdir(ld, { recursive: true });
      for (const e of j.entries || []) {
        const name = safeName(e.name);
        if (!name) continue;
        if (e.dir) await walk(e.path, path.join(ld, name));
        else {
          const r = await downloadOne(e.path, path.join(ld, name), { cutOff, verify });
          bytes += r.size; files++; if (r.deleted) deleted++;
        }
      }
    }
    await walk(rel, target);
    if (cutOff) await pruneDirs(rel);
    done();
    console.log(`selesai: ${files} file, ${fmt(bytes)} -> ${target}${deleted ? ` (${deleted} file dihapus dari HP)` : ''}`);
    return;
  }
  const name = safeName(path.posix.basename(rel));
  if (!name) throw new Error('nama file tidak valid');
  const target = path.resolve(local || name);
  const r = await downloadOne(rel, target, { cutOff, verify });
  console.log(`selesai: ${target} (${fmt(r.size)})${r.verified ? ' · SHA-256 cocok' : ''}${r.deleted ? ' · dihapus dari HP' : ''}`);
}

async function put(local, remoteDir = '', opt = {}) {
  const src = path.resolve(local);
  const s = await fs.stat(src).catch(() => null);
  if (!s) throw new Error(`tidak ada: ${src}`);
  if (!s.isDirectory()) {
    const r = await uploadOne(src, joinRemote(remoteDir, path.basename(src)), opt);
    console.log(`selesai: ${joinRemote(remoteDir, path.basename(src))} (${fmt(r)})`);
    return;
  }
  let files = 0;
  async function walk(dir, rd) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const lp = path.join(dir, e.name), rp = joinRemote(rd, e.name);
      if (e.isDirectory()) await walk(lp, rp);
      else if (e.isFile()) { await uploadOne(lp, rp, opt); files++; }
    }
  }
  await walk(src, joinRemote(remoteDir, path.basename(src)));
  done();
  console.log(`selesai: ${files} file -> ${joinRemote(remoteDir, path.basename(src))}`);
}

async function ls(dir = '') {
  const j = await listRemote(dir);
  if (j.error) throw new Error(`${j.error} (${j.path ?? (dir || '/')})`);
  console.log(`HP: ${j.base}${j.all_files ? '' : '  [akses semua file belum aktif]'}`
    + (typeof j.free === 'number' ? `  · sisa ${fmt(j.free)}` : ''));
  console.log(`/${j.path ? j.path + '/' : ''}`);
  const list = j.entries || [];
  if (!list.length) console.log('  (kosong)');
  for (const e of list) {
    console.log(`  ${e.dir ? 'd' : '-'}  ${fmt(e.size).padStart(7)}  ${e.name}${e.dir ? '/' : ''}`);
  }
}

async function showBase() {
  const info = await call('/info');
  console.log(JSON.stringify(info, null, 2));
}

// ---------- perintah ----------
async function handover() {
  if (!st.serial) return console.log('butuh kabel dulu');
  const r = await adb('-s', st.serial, 'shell', 'ip -f inet addr show wlan0');
  const ip = r.out.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) return console.log('HP tidak terhubung ke Wi-Fi');
  await adb('-s', st.serial, 'tcpip', '5555'); await sleep(1500);
  console.log((await adb('connect', `${ip}:5555`)).out);
}

const HELP = `perintah: ui | ls [folder] | get <jarak> [lokal] | put <lokal> [folder jarak] | rm <jarak>
          cutoff [on|off] | verify [on|off] | status | info | sh <perintah> | adb-on | adb <args> | wifi | token <kode> | exit
  ui     -> buka Web UI di browser (paling mudah untuk salin file)
  ls     -> daftar isi HP (folder relatif: Download, DCIM/Camera, ...)
  get    -> ambil file ATAU folder dari HP (folder: DCIM/Camera .)
  put    -> kirim file ATAU folder ke HP (default: folder akar)
  rm     -> hapus file di HP
  cutoff -> mode potong: file yang berhasil diunduh + lolos SHA-256 DIHAPUS dari HP
  verify -> cek SHA-256 setiap unduhan (default: on)
  sh     -> dijalankan di HP sebagai user biasa (bukan root)
  adb    -> teruskan ke adb (otomatis -s <serial kabel>)
  wifi   -> dari kabel, aktifkan adb-over-Wi-Fi (tcpip 5555) lalu connect`;

async function exec(line, rl, closed) {
  const [cmd, ...rest] = splitArgs(line.trim());
  const arg = rest.join(' ');
  try {
    if (ready) await ready;
    if (cmd === 'ui') {
      const { startUi } = await import('./web.mjs');
      await startUi(api);
    }
    else if (cmd === 'ls') await ls(rest[0] ?? '');
    else if (cmd === 'get') { if (!rest[0]) return console.log('pakai: get <jarak> [lokal]'); await get(rest[0], rest[1]); }
    else if (cmd === 'put') { if (!rest[0]) return console.log('pakai: put <lokal> [folder jarak]'); await put(rest[0], rest[1]); }
    else if (cmd === 'rm') { if (!rest[0]) return console.log('pakai: rm <jarak>'); console.log(await deleteRemote(rest[0])); }
    else if (cmd === 'cutoff') {
      cfg.cutOff = rest[0] ? /^(on|1|ya|true)$/i.test(rest[0]) : !cfg.cutOff;
      await save();
      console.log(`mode cut-off: ${cfg.cutOff ? 'AKTIF — file yang berhasil diunduh dihapus dari HP (setelah SHA-256 cocok)' : 'mati'}`);
    }
    else if (cmd === 'verify') {
      cfg.verify = rest[0] ? /^(on|1|ya|true)$/i.test(rest[0]) : !cfg.verify;
      await save();
      console.log(`verifikasi SHA-256: ${cfg.verify ? 'AKTIF' : 'mati'}${cfg.cutOff ? ' (cut-off selalu verifikasi)' : ''}`);
    }
    else if (cmd === 'status') console.log(JSON.stringify({ kabel: st.serial, wifi: st.net, cutOff: cfg.cutOff, verify: cfg.verify, folder: cfg.localDir }));
    else if (cmd === 'info') await showBase();
    else if (cmd === 'sh') console.log((await call('/shell', arg)).out);
    else if (cmd === 'adb-on') console.log(await call('/adb-on', ''));
    else if (cmd === 'adb') console.log((await adb(...(st.serial ? ['-s', st.serial] : []), ...rest)).out);
    else if (cmd === 'wifi') await handover();
    else if (cmd === 'token') { cfg.token = arg; await save(); debugTried = false; console.log('token disimpan'); }
    else if (cmd === 'exit' || cmd === 'quit') { process.exitCode = 0; return rl.close(); }
    else if (cmd) console.log(HELP);
  } catch (e) { done(); console.log('gagal:', e.message); }
  if (!closed()) rl.prompt();
}

// Pisah baris perintah, hormati tanda kutip:  get "DCIM/Camera/foto 1.jpg" "D:\foto"
function splitArgs(line) {
  const out = [];
  let cur = '', q = null, has = false;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

// ---------- jembatan untuk Web UI ----------
const api = {
  get state() {
    return {
      connected: !!(st.serial || st.net),
      via: st.serial ? `KABEL (${st.serial})` : st.net ? `Wi-Fi (${st.net.ip})` : null,
      cutOff: !!cfg.cutOff,
      verify: cfg.verify !== false,
      tokenSet: !!cfg.token,
      localDir: cfg.localDir,
    };
  },
  list: listRemote,
  remove: deleteRemote,
  hash: hashRemote,
  localHash,
  download: downloadOne,
  upload: uploadOne,
  join: joinRemote,
  prune: pruneDirs,
  async save() { await save(); },
  setCutOff(v) { cfg.cutOff = !!v; return save(); },
  setVerify(v) { cfg.verify = !!v; return save(); },
  setToken(t) { cfg.token = String(t || '').trim(); debugTried = false; return save(); },
  async reconnect() { lastNet = 0; st.net = null; await tick(); return api.state; },
  fmt,
};

// ---------- main ----------
async function main() {
  if (+process.versions.node.split('.')[0] < 24) console.log('catatan: dirancang untuk Node 24+, versi kamu', process.version);
  try { cfg = { ...cfg, ...JSON.parse(await fs.readFile(CFG, 'utf8')) }; } catch {}
  if (!cfg.localDir) cfg.localDir = path.join(os.homedir(), 'Downloads', 'transfer-file');

  ROOT = await isElevated();
  log(ROOT ? 'hak akses: root/Administrator ✔' : 'PERINGATAN: bukan root/Administrator — perbaikan izin USB dimatikan');
  if (ROOT && process.platform === 'linux') await linuxFix(null).catch(e => log('udev gagal:', e.message));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'kabellink> ' });
  let closed = false;
  let chain = Promise.resolve();
  const ended = new Promise(res => rl.on('close', () => { closed = true; res(); }));
  rl.on('line', l => { chain = chain.then(() => exec(l, rl, () => closed)); });

  if (!cfg.token) {
    cfg.token = (await rl.question('Token dari layar APK di HP (Enter jika APK belum terpasang): ')).trim();
    await save();
  }
  ready = tick(); await ready;
  setInterval(tick, 3000).unref();
  console.log(HELP);

  if (process.argv.slice(2).includes('--ui')) {
    const { startUi } = await import('./web.mjs');
    await startUi(api);
    setInterval(() => {}, 1 << 30); // tetap hidup selama Web UI dipakai
    return;
  }

  if (!closed) rl.prompt();

  await ended;
  await chain;
  done();
}

main().catch(e => { done(); console.error('fatal:', e.message); process.exit(1); });

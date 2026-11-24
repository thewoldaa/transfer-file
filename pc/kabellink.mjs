#!/usr/bin/env node
// KabelLink (PC) — Node >= 24, tanpa dependensi. Jalankan sebagai root / Administrator.
// Urutan: jaringan dulu (APK di HP) -> pantau kabel USB -> kalau kabel ada, pakai kabel.
// Transfer file:  ls | get <jarak> [lokal] | put <lokal> [folder jarak]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, createWriteStream } from 'node:fs';
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

let cfg = { token: '', ip: '' };
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

async function call(p, body) {
  let err = new Error('belum terhubung — nyalakan APK atau colok kabel');
  for (const b of bases()) {
    try {
      const r = await fetch(b + p, {
        method: body === undefined ? 'GET' : 'POST', body,
        headers: { 'X-Token': cfg.token }, signal: AbortSignal.timeout(20000),
      });
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
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
const W = () => process.stdout.columns || 80;
let lineLen = 0;
function draw(text) {
  if (!process.stdout.isTTY) return; // output dipipe/log: jangan spam \r
  const pad = Math.max(0, lineLen - text.length);
  process.stdout.write(`\r${text}${' '.repeat(pad)}`);
  lineLen = text.length;
}
function done() { if (lineLen) { process.stdout.write('\n'); lineLen = 0; } }

function meter(total, label) {
  let sent = 0, last = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      const now = Date.now();
      if (now - last > 150) {
        last = now;
        const pct = total ? Math.floor(sent * 100 / total) : 0;
        draw(`${label}  ${pct}%  ${fmt(sent)}${total ? '/' + fmt(total) : ''}`);
      }
      cb(null, chunk);
    },
    flush(cb) { if (process.stdout.isTTY) { draw(`${label}  100%  ${fmt(sent)}`); done(); } cb(); },
  });
}

// ---------- transfer file ----------
const enc = encodeURIComponent;
const joinRemote = (dir, name) => `${String(dir || '').replace(/^\/+|\/+$/g, '') ? String(dir).replace(/^\/+|\/+$/g, '') + '/' : ''}${name}`;

async function listRemote(dir = '') {
  return call('/files?dir=' + enc(dir));
}

async function downloadOne(remote, localFile) {
  let err = new Error('belum terhubung');
  for (const b of bases()) {
    try {
      const r = await fetch(`${b}/file?path=${enc(remote)}`, { headers: { 'X-Token': cfg.token } });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const total = Number(r.headers.get('content-length') || 0);
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      const tmp = `${localFile}.part`;
      await pipeline(
        Readable.fromWeb(r.body),
        meter(total, path.basename(localFile)),
        createWriteStream(tmp),
      );
      await fs.rename(tmp, localFile);
      return total;
    } catch (e) { err = e; }
  }
  throw err;
}

async function uploadOne(localFile, remote) {
  const size = (await fs.stat(localFile)).size;
  let err = new Error('belum terhubung');
  for (const b of bases()) {
    try {
      const r = await fetch(`${b}/file?path=${enc(remote)}`, {
        method: 'PUT',
        headers: { 'X-Token': cfg.token, 'Content-Length': String(size) },
        body: createReadStream(localFile).pipe(meter(size, path.basename(localFile))),
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

async function get(remote, local) {
  const rel = String(remote || '').replace(/^\/+/, '');
  const meta = await listRemote(rel).catch(() => null);
  if (meta && !meta.error) { // folder
    const target = path.resolve(local || path.basename(rel) || 'phone');
    let files = 0, bytes = 0;
    async function walk(rd, ld) {
      const j = await listRemote(rd);
      if (j.error) throw new Error(j.error);
      await fs.mkdir(ld, { recursive: true });
      for (const e of j.entries || []) {
        const name = safeName(e.name);
        if (!name) continue;
        if (e.dir) await walk(e.path, path.join(ld, name));
        else { bytes += await downloadOne(e.path, path.join(ld, name)); files++; }
      }
    }
    await walk(rel, target);
    done();
    console.log(`selesai: ${files} file, ${fmt(bytes)} -> ${target}`);
    return;
  }
  const name = safeName(path.posix.basename(rel));
  if (!name) throw new Error('nama file tidak valid');
  const target = path.resolve(local || name);
  const n = await downloadOne(rel, target);
  console.log(`selesai: ${target} (${fmt(n)})`);
}

async function put(local, remoteDir = '') {
  const src = path.resolve(local);
  const s = await fs.stat(src).catch(() => null);
  if (!s) throw new Error(`tidak ada: ${src}`);
  if (!s.isDirectory()) {
    const r = await uploadOne(src, joinRemote(remoteDir, path.basename(src)));
    console.log(`selesai: ${joinRemote(remoteDir, path.basename(src))} (${fmt(r)})`);
    return;
  }
  let files = 0;
  async function walk(dir, rd) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const lp = path.join(dir, e.name), rp = joinRemote(rd, e.name);
      if (e.isDirectory()) await walk(lp, rp);
      else if (e.isFile()) { await uploadOne(lp, rp); files++; }
    }
  }
  await walk(src, joinRemote(remoteDir, path.basename(src)));
  done();
  console.log(`selesai: ${files} file -> ${joinRemote(remoteDir, path.basename(src))}`);
}

async function ls(dir = '') {
  const j = await listRemote(dir);
  if (j.error) throw new Error(`${j.error} (${j.path ?? (dir || '/')})`);
  console.log(`HP: ${j.base}${j.all_files ? '' : '  [akses semua file belum aktif]'}`);
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

const HELP = `perintah: ls [folder] | get <jarak> [lokal] | put <lokal> [folder jarak]
          status | info | sh <perintah> | adb-on | adb <args> | wifi | token <kode> | exit
  ls   -> daftar isi HP (folder relatif: Download, DCIM/Camera, ...)
  get  -> ambil file ATAU folder dari HP (folder: DCIM/Camera .)
  put  -> kirim file ATAU folder ke HP (default: folder akar)
  sh   -> dijalankan di HP sebagai user biasa (bukan root)
  adb  -> teruskan ke adb (otomatis -s <serial kabel>)
  wifi -> dari kabel, aktifkan adb-over-Wi-Fi (tcpip 5555) lalu connect`;

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

async function exec(line, rl, closed) {
  const [cmd, ...rest] = splitArgs(line.trim());
  const arg = rest.join(' ');
  try {
    if (ready) await ready;
    if (cmd === 'ls') await ls(rest[0] ?? '');
    else if (cmd === 'get') { if (!rest[0]) return console.log('pakai: get <jarak> [lokal]'); await get(rest[0], rest[1]); }
    else if (cmd === 'put') { if (!rest[0]) return console.log('pakai: put <lokal> [folder jarak]'); await put(rest[0], rest[1]); }
    else if (cmd === 'status') console.log(JSON.stringify({ kabel: st.serial, wifi: st.net }));
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

// ---------- main ----------
async function main() {
  if (+process.versions.node.split('.')[0] < 24) console.log('catatan: dirancang untuk Node 24+, versi kamu', process.version);
  try { cfg = { ...cfg, ...JSON.parse(await fs.readFile(CFG, 'utf8')) }; } catch {}

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
  if (!closed) rl.prompt();

  await ended;
  await chain;
  done();
}

main().catch(e => { done(); console.error('fatal:', e.message); process.exit(1); });

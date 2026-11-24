// Tiruan APK untuk uji PC tanpa HP:  node mock-apk.mjs   (token: TESTTOKN)
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'TESTTOKN';
const BASE = path.join(os.tmpdir(), 'transfer-file-mock');
fs.mkdirSync(path.join(BASE, 'Download'), { recursive: true });
fs.mkdirSync(path.join(BASE, 'DCIM', 'Camera'), { recursive: true });
if (!fs.existsSync(path.join(BASE, 'Download', 'halo.txt')))
  fs.writeFileSync(path.join(BASE, 'Download', 'halo.txt'), 'halo dari mock\n');

const resolve = rel => {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const f = path.resolve(BASE, r);
  return f === BASE || f.startsWith(BASE + path.sep) ? f : null;
};
const relOf = f => path.relative(BASE, f).replace(/\\/g, '/');
const enc = s => JSON.stringify(s);

http.createServer(async (q, r) => {
  const url = new URL(q.url, 'http://x');
  const send = (c, o) => { r.writeHead(c, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
  if (url.pathname === '/ping') return send(200, { app: 'kabellink', ok: true });
  if (q.headers['x-token'] !== TOKEN) return send(401, { error: 'token salah' });

  if (url.pathname === '/info') return send(200, {
    model: 'SM-A125F', maker: 'samsung', android: '13', sdk: 33, battery: 80,
    usb_connected: false, adb_enabled: false, base: BASE, all_files: true,
  });
  if (url.pathname === '/adb-on') return send(200, { ok: true });
  if (url.pathname === '/shell') {
    let b = ''; for await (const d of q) b += d;
    return send(200, { code: 0, out: 'mock-run: ' + b });
  }
  if (url.pathname === '/files') {
    const d = resolve(url.searchParams.get('dir'));
    if (!d) return send(200, { base: BASE, all_files: true, error: 'path tidak valid' });
    if (!fs.existsSync(d)) return send(200, { base: BASE, all_files: true, path: relOf(d), error: 'tidak ada' });
    if (!fs.statSync(d).isDirectory()) return send(200, { base: BASE, all_files: true, path: relOf(d), error: 'bukan folder' });
    const entries = fs.readdirSync(d, { withFileTypes: true })
      .map(e => {
        const f = path.join(d, e.name);
        return { name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : fs.statSync(f).size, path: relOf(f) };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return send(200, { base: BASE, all_files: true, path: relOf(d), entries });
  }
  if (url.pathname === '/file') {
    const f = resolve(url.searchParams.get('path'));
    if (!f) return send(403, { error: 'path tidak valid' });
    if (q.method === 'GET' || q.method === 'HEAD') {
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return send(404, { error: 'bukan file' });
      r.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(f).size });
      if (q.method === 'HEAD') return r.end();
      return fs.createReadStream(f).pipe(r);
    }
    if (q.method === 'PUT' || q.method === 'POST') {
      const len = Number(q.headers['content-length'] || 0);
      if (!len) return send(400, { error: 'isi file kosong (butuh Content-Length)' });
      await fsp.mkdir(path.dirname(f), { recursive: true });
      const ws = fs.createWriteStream(f);
      let got = 0;
      for await (const chunk of q) { got += chunk.length; if (!ws.write(chunk)) await new Promise(res => ws.once('drain', res)); }
      ws.end();
      await new Promise(res => ws.on('close', res));
      if (got !== len) return send(400, { error: `transfer terputus (${got}/${len})` });
      return send(200, { ok: true, path: relOf(f), size: got });
    }
    return send(405, { error: 'method tidak didukung' });
  }
  send(404, { error: 'not found' });
}).listen(8765, () => console.log(`mock HTTP :8765 (folder ${BASE})`));

const u = dgram.createSocket({ type: 'udp4', reuseAddr: true });
u.on('message', (m, r) => {
  if (m.toString().trim() === 'KABELLINK?') u.send(JSON.stringify({ app: 'kabellink', name: 'SM-A125F', port: 8765 }), r.port, r.address);
});
u.bind(8766, () => console.log('mock UDP :8766'));

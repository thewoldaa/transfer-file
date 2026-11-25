// Tiruan APK untuk uji PC tanpa HP:  node mock-apk.mjs   (token: TESTTOKN)
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
const sha256 = async f => {
  const h = createHash('sha256');
  await new Promise((ok, bad) => fs.createReadStream(f).on('data', d => h.update(d)).on('end', ok).on('error', bad));
  return h.digest('hex');
};

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
    const free = fs.statfsSync(BASE).bavail * fs.statfsSync(BASE).bsize;
    if (!d) return send(200, { base: BASE, all_files: true, free, error: 'path tidak valid' });
    if (!fs.existsSync(d)) return send(200, { base: BASE, all_files: true, free, path: relOf(d), error: 'tidak ada' });
    if (!fs.statSync(d).isDirectory()) return send(200, { base: BASE, all_files: true, free, path: relOf(d), error: 'bukan folder' });
    const entries = fs.readdirSync(d, { withFileTypes: true })
      .map(e => {
        const f = path.join(d, e.name);
        return { name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : fs.statSync(f).size, path: relOf(f) };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return send(200, { base: BASE, all_files: true, free, path: relOf(d), entries });
  }
  if (url.pathname === '/hash') {
    const f = resolve(url.searchParams.get('path'));
    if (!f) return send(403, { error: 'path tidak valid' });
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return send(404, { error: 'bukan file' });
    return send(200, { sha256: await sha256(f), size: fs.statSync(f).size });
  }
  if (url.pathname === '/stat') {
    const rel = url.searchParams.get('path');
    const f = resolve(rel);
    if (!f) return send(403, { error: 'path tidak valid' });
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) return send(200, { path: relOf(f), exists: true, dir: true, size: 0 });
    if (!fs.existsSync(f)) return send(200, { path: rel || '', exists: false, dir: false, size: 0 });
    return send(200, { path: relOf(f), exists: true, dir: false, size: fs.statSync(f).size, modified: fs.statSync(f).mtimeMs });
  }
  if (url.pathname === '/rename') {
    const a = resolve(url.searchParams.get('from'));
    const b = resolve(url.searchParams.get('to'));
    if (!a || !b) return send(403, { error: 'path tidak valid' });
    if (!fs.existsSync(a) || !fs.statSync(a).isFile()) return send(200, { error: 'tidak ada' });
    if (fs.existsSync(b) && fs.statSync(b).isDirectory()) return send(200, { error: 'target adalah folder' });
    await fsp.mkdir(path.dirname(b), { recursive: true });
    if (fs.existsSync(b)) fs.unlinkSync(b);
    fs.renameSync(a, b);
    return send(200, { ok: true, path: relOf(b), size: fs.statSync(b).size });
  }
  if (url.pathname === '/file') {
    const f = resolve(url.searchParams.get('path'));
    if (!f) return send(403, { error: 'path tidak valid' });
    if (q.method === 'GET' || q.method === 'HEAD') {
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return send(404, { error: 'bukan file' });
      const size = fs.statSync(f).size;
      let start = 0;
      const range = /^bytes=(\d+)-/.exec(String(q.headers.range || ''));
      if (range) start = Number(range[1]);
      if (start > size) return send(416, { error: 'range di luar ukuran file', size });
      const part = start > 0 && start < size;
      r.writeHead(part ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size - start,
        ...(part ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}),
      });
      if (q.method === 'HEAD') return r.end();
      return fs.createReadStream(f, { start }).pipe(r);
    }
    if (q.method === 'PUT' || q.method === 'POST') {
      const len = Number(q.headers['content-length'] || 0);
      if (!len) return send(400, { error: 'isi file kosong (butuh Content-Length)' });
      const offset = Number(url.searchParams.get('offset') || 0);
      const have = fs.existsSync(f) && fs.statSync(f).isFile() ? fs.statSync(f).size : 0;
      if (offset > 0) {
        if (have !== offset) return send(200, { error: 'offset tidak cocok', size: have, offset });
      } else if (have > 0) {
        fs.unlinkSync(f);
      }
      await fsp.mkdir(path.dirname(f), { recursive: true });
      const ws = fs.createWriteStream(f, { flags: offset > 0 ? 'a' : 'w' });
      let got = 0;
      for await (const chunk of q) { got += chunk.length; if (!ws.write(chunk)) await new Promise(res => ws.once('drain', res)); }
      ws.end();
      await new Promise(res => ws.on('close', res));
      if (got !== len) return send(200, { error: `transfer terputus (${got}/${len} byte)`, size: fs.statSync(f).size, partial: true });
      return send(200, { ok: true, path: relOf(f), size: fs.statSync(f).size });
    }
    if (q.method === 'DELETE') {
      if (!fs.existsSync(f)) return send(404, { error: 'tidak ada' });
      if (f === BASE) return send(403, { error: 'tidak boleh hapus akar' });
      const size = fs.statSync(f).isDirectory() ? 0 : fs.statSync(f).size;
      try {
        if (fs.statSync(f).isDirectory()) fs.rmdirSync(f);
        else fs.unlinkSync(f);
      } catch (e) { return send(400, { error: 'gagal menghapus (folder tidak kosong?)' }); }
      return send(200, { ok: true, path: relOf(f), size });
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

#!/usr/bin/env node
// Bangun EXE tunggal (Node Single Executable Application) dari pc/kabellink.mjs.
// Dipakai di GitHub Actions (windows-latest) dan bisa juga lokal di Windows.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const ESBUILD = process.env.ESBUILD_VERSION || '0.28.2';
const POSTJECT = process.env.POSTJECT_VERSION || '1.0.0-alpha.6';
const NAME = process.env.EXE_NAME || 'transfer-file';

// shell hanya untuk npx (.cmd di Windows); argumen npx sengaja relatif (tanpa spasi)
const sh = (cmd, args, shell = false) => {
  console.log('>', cmd, args.join(' '));
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell });
};

fs.rmSync(BUILD, { recursive: true, force: true });
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// 1) bundel ESM -> CJS (SEA hanya menerima CommonJS)
sh('npx', ['--yes', `esbuild@${ESBUILD}`, 'pc/kabellink.mjs',
  '--bundle', '--platform=node', '--format=cjs', '--target=node24',
  '--outfile=build/transfer-file.cjs'], true);

// 2) blob SEA
const cfgFile = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  main: path.join(BUILD, 'transfer-file.cjs'),
  output: path.join(BUILD, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));
sh(process.execPath, ['--experimental-sea-config', cfgFile]);

// 3) salin node.exe, buang tanda tangan (wajib di Windows sebelum disuntik)
const exeRel = path.join('dist', `${NAME}.exe`);
const exe = path.join(ROOT, exeRel);
fs.copyFileSync(process.execPath, exe);
try {
  sh('signtool', ['remove', '/s', exeRel]);
} catch {
  console.warn('catatan: signtool tidak ada — lanjut tanpa membuang tanda tangan');
}

// 4) suntik blob
sh('npx', ['--yes', `postject@${POSTJECT}`, exeRel, 'NODE_SEA_BLOB',
  'build/sea-prep.blob', '--sentinel-fuse', FUSE], true);

const mb = (fs.statSync(exe).size / 1048576).toFixed(1);
console.log(`\nselesai: ${exe} (${mb} MB)`);

'use strict';
/*
 * Ukur biaya render per halaman di LOKAL (tanpa jaringan platform):
 *  - "--cold": image-cache dikosongkan (salinan di /tmp) → mensimulasikan cache gambar kosong
 *  - default: memakai image-cache yang ada
 * Hasil: TTFB tiap halaman + jumlah permintaan /media yang dibuat ulang.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = '/home/vibecoderco/workspace/dlyvisualcreative/dlygraduation';
const COLD = process.argv.includes('--cold');
const DATA = path.join(os.tmpdir(), 'dly-perf-' + process.pid);
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  const src = path.join(APP, 'data', dir);
  const dst = path.join(DATA, dir);
  if (COLD) { fs.mkdirSync(dst, { recursive: true }); continue; }
  try { fs.cpSync(src, dst, { recursive: true }); } catch (e) { fs.mkdirSync(dst, { recursive: true }); }
}

const PORT = 4781;
const BASE = `http://127.0.0.1:${PORT}`;
const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1' },
  stdio: ['ignore', 'ignore', 'pipe']
});
app.stderr.on('data', (d) => process.stderr.write('[app] ' + d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 200; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) {} await sleep(200); }
  const pages = ['/', '/gallery', '/pricelist', '/city', '/booking', '/faq', '/artikel'];
  for (const p of pages) {
    const t0 = Date.now();
    const r = await fetch(BASE + p);
    const body = await r.text();
    const html = Date.now() - t0;
    // ambil URL /media dari HTML dan ukur total waktu mengambil salah satu yang belum ada
    const media = Array.from(body.matchAll(/(?:src|href)="([^"]*\/media\/[^"]+)"/g)).map((m) => m[1]);
    const uniq = Array.from(new Set(media.map((u) => u.replace(/&amp;/g, '&'))));
    let mediaMs = 0;
    let slowest = { url: '', ms: 0 };
    for (const u of uniq.slice(0, 6)) {
      const url = u.startsWith('http') ? u : BASE + u;
      const t1 = Date.now();
      const rr = await fetch(url);
      await rr.arrayBuffer();
      const ms = Date.now() - t1;
      mediaMs += ms;
      if (ms > slowest.ms) slowest = { url: u.slice(0, 70), ms };
    }
    console.log(`${p.padEnd(11)} html=${String(html).padStart(6)}ms  media(${uniq.length} uniq, sampled ${Math.min(6, uniq.length)})=${String(mediaMs).padStart(6)}ms  slowest=${slowest.ms}ms ${slowest.url}`);
  }
  app.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
})();

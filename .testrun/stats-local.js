'use strict';
/* Distribusi waktu render LOKAL untuk halaman berat (60 request per halaman). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = '/home/vibecoderco/workspace/dlyvisualcreative/dlygraduation';
const DATA = path.join(os.tmpdir(), 'dly-stats-' + process.pid);
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}
const PORT = 4791;
const BASE = `http://127.0.0.1:${PORT}`;
const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1' },
  stdio: ['ignore', 'ignore', 'pipe']
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

(async () => {
  for (let i = 0; i < 200; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) {} await sleep(200); }
  await sleep(2500); // biarkan warm-up boot selesai (dimensi + turunan)
  for (const p of ['/', '/gallery', '/pricelist']) {
    const times = [];
    for (let i = 0; i < 60; i++) {
      const t0 = process.hrtime.bigint();
      const r = await fetch(BASE + p);
      await r.arrayBuffer();
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    console.log(`${p.padEnd(11)} min=${pct(times, 0).toFixed(0)}ms p50=${pct(times, 0.5).toFixed(0)}ms p95=${pct(times, 0.95).toFixed(0)}ms max=${Math.max(...times).toFixed(0)}ms`);
  }
  app.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
})();

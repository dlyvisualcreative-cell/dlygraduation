'use strict';
/* AUDIT/VERIFY — boot dua kali pada SALINAN yang sama: apakah identify berhenti diulang? */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-boot2-' + process.pid);
const PORT = 4850;
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(label) {
  const OUT = path.join(DATA, `audit-${label}.json`);
  const t0 = Date.now();
  const app = spawn(process.execPath, ['--require', path.join(__dirname, 'audit-instrument.js'), path.join(APP, 'server.js')], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: DATA, AUDIT_OUT: OUT, DLY_DISABLE_PUSH_SCHEDULER: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let first = null;
  for (let i = 0; i < 400; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) { await r.text(); first = Date.now() - t0; break; } } catch (e) { /* belum */ }
    await sleep(100);
  }
  const second = Date.now();
  await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  const secondMs = Date.now() - second;
  await sleep(12000);
  app.kill('SIGTERM');
  await sleep(1500);
  const a = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  console.log(`${label}: request pertama ${first}ms · kedua ${secondMs}ms · spawn ${a.boot.spawnCount} ${JSON.stringify(a.boot.spawnsByLabel)} · syncBlock ${a.boot.syncBlocks.length} (${a.boot.syncBlocks.reduce((s, x) => s + x.ms, 0)}ms)`);
  return a;
}

(async () => {
  await boot('boot-1');
  await boot('boot-2');
  const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'image-cache', 'dimensions.json'), 'utf8'));
  const keys = Object.keys(idx);
  console.log(`index: ${keys.length} entri · gagal permanen: ${keys.filter((k) => idx[k].failed).length} · punya ukuran: ${keys.filter((k) => idx[k].width).length}`);
  fs.rmSync(DATA, { recursive: true, force: true });
})();

'use strict';
/* AUDIT ONLY — biaya nyata membuat turunan gambar (/media) + verifikasi URL dari HTML. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-media-' + process.pid);
const OUT = path.join(os.tmpdir(), 'dly-media-' + process.pid + '.json');
const PORT = 4836;
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
fs.mkdirSync(path.join(DATA, 'image-cache'), { recursive: true });
try { fs.cpSync(path.join(APP, 'data', 'logo-cache'), path.join(DATA, 'logo-cache'), { recursive: true }); } catch (e) { /* opsional */ }

const app = spawn(process.execPath, ['--require', path.join(__dirname, 'audit-instrument.js'), path.join(APP, 'server.js')], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: DATA, AUDIT_OUT: OUT, DLY_DISABLE_PUSH_SCHEDULER: '1' },
  stdio: ['ignore', 'ignore', 'pipe']
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 400; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(6000);
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  const gallery = await (await fetch(`http://127.0.0.1:${PORT}/gallery`)).text();
  const urls = Array.from(new Set((html + gallery).match(/\/media\/[A-Za-z0-9_.-]+/g) || []));
  console.log(`URL /media di HTML: ${urls.length}`);

  // 1) varian yang BELUM ada (cache gambar kosong) → biaya pembuatan nyata
  console.log('\n=== membuat turunan pertama kali (cache kosong) ===');
  for (const u of urls.slice(0, 5)) {
    const t = Date.now();
    const r = await fetch(`http://127.0.0.1:${PORT}${u}`);
    const b = await r.arrayBuffer();
    console.log(`  ${String(Date.now() - t).padStart(5)}ms ${r.status} ${String(Math.round(b.byteLength / 1024)).padStart(4)}KB ${u.slice(0, 50)}`);
  }
  // 2) klik kedua (sudah ter-cache)
  console.log('\n=== permintaan ulang (sudah ada di cache) ===');
  for (const u of urls.slice(0, 3)) {
    const t = Date.now();
    const r = await fetch(`http://127.0.0.1:${PORT}${u}`);
    await r.arrayBuffer();
    console.log(`  ${String(Date.now() - t).padStart(5)}ms ${r.status} ${u.slice(0, 50)}`);
  }

  app.kill('SIGTERM');
  await sleep(1500);
  if (fs.existsSync(OUT)) {
    const a = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const media = a.requests.filter((r) => r.url.startsWith('/media/'));
    console.log(`\nspawn saat melayani /media: convert=${media.reduce((s, r) => s + r.convert, 0)} identify=${media.reduce((s, r) => s + r.identify, 0)}`);
    const spawns = a.boot.spawns.filter((s) => s.label === 'convert' || s.label === 'identify').slice(0, 8);
    spawns.forEach((s) => console.log(`  ${String(s.ms).padStart(5)}ms ${s.label} ${s.arg0.slice(0, 70)}`));
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(OUT, { force: true });
})();

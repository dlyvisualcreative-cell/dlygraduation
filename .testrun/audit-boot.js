'use strict';
/*
 * AUDIT ONLY — ukur boot & biaya per-request memakai preload instrumentasi.
 * Menjalankan aplikasi dari SALINAN data di /tmp (produksi tidak disentuh).
 *
 *   node .testrun/audit-boot.js [--cold-cache]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..');
const COLD = process.argv.includes('--cold-cache');
const DATA = path.join(os.tmpdir(), 'dly-audit-' + process.pid);
const OUT = path.join(os.tmpdir(), 'dly-audit-boot-' + process.pid + '.json');
const PORT = 4801;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache', 'preview-cache']) {
  const src = path.join(APP, 'data', dir);
  const dst = path.join(DATA, dir);
  if (COLD) { fs.mkdirSync(dst, { recursive: true }); continue; }
  try { fs.cpSync(src, dst, { recursive: true }); } catch (e) { fs.mkdirSync(dst, { recursive: true }); }
}

const t0 = Date.now();
const app = spawn(process.execPath, [
  '--require', path.join(__dirname, 'audit-instrument.js'),
  path.join(APP, 'server.js')
], {
  env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA, AUDIT_OUT: OUT, DLY_DISABLE_PUSH_SCHEDULER: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const log = [];
app.stdout.on('data', (d) => log.push(String(d).trim()));
app.stderr.on('data', (d) => log.push(String(d).trim()));

(async () => {
  // Waktu sampai request pertama bisa dilayani.
  let firstOk = null;
  for (let i = 0; i < 400; i++) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) { await r.text(); firstOk = Date.now() - t0; break; }
    } catch (e) { /* belum siap */ }
    await sleep(100);
  }
  console.log(`\n=== BOOT ${COLD ? '(cache gambar KOSONG)' : '(cache gambar ADA)'} ===`);
  console.log(`request pertama berhasil dilayani: ${firstOk} ms setelah spawn`);

  // Halaman-halaman utama: ukur waktu & biaya.
  const pages = ['/', '/gallery', '/pricelist', '/cara-order', '/city', '/booking', '/faq'];
  for (const p of pages) {
    const s = Date.now();
    const r = await fetch(BASE + p);
    await r.text();
    console.log(`  ${p.padEnd(12)} ${String(Date.now() - s).padStart(5)} ms  HTTP ${r.status}`);
  }

  // Klik kedua: apakah masih ada kerja gambar?
  const again = Date.now();
  await (await fetch(BASE + '/gallery')).text();
  console.log(`  /gallery (klik ke-2) ${Date.now() - again} ms`);

  // Tunggu warm-up boot selesai, lalu ukur lagi.
  await sleep(20000);
  const after = Date.now();
  await (await fetch(BASE + '/')).text();
  console.log(`  / setelah warm-up (20 s)  ${Date.now() - after} ms`);

  app.kill('SIGTERM');
  await sleep(1200);
  if (fs.existsSync(OUT)) {
    const a = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    console.log('\n--- spawn proses gambar selama BOOT ---');
    console.log(`  total spawn: ${a.boot.spawnCount}  ${JSON.stringify(a.boot.spawnsByLabel)}`);
    console.log(`  total waktu menunggu proses: ${a.boot.spawnMsTotal} ms`);
    console.log(`  panggilan SINKRON (memblokir event loop): ${a.boot.syncBlocks.length}` +
      (a.boot.syncBlocks.length ? ` → total ${a.boot.syncBlocks.reduce((s, x) => s + x.ms, 0)} ms` : ''));
    (a.boot.slowest || []).slice(0, 6).forEach((s) => console.log(`    ${String(s.ms).padStart(5)}ms ${s.label} ${s.arg0.slice(0, 60)}`));
    console.log('  syncBlocks:', JSON.stringify(a.boot.syncBlocks));
    console.log('\n--- per request (SQL & spawn) ---');
    a.requests.slice(0, 14).forEach((r) => {
      console.log(`  ${String(r.ms).padStart(5)}ms ${String(r.status)} ${r.url.padEnd(20)} stmt=${String(r.stmts).padStart(3)} rows=${String(r.rows).padStart(4)} convert=${r.convert} identify=${r.identify} spawn=${r.spawnMs}ms`);
    });
    console.log(`\n  TOTAL: prepare=${a.totals.prepare} stmt=${a.totals.stmts} convert=${a.totals.convert} identify=${a.totals.identify}`);
  } else {
    console.log('!! hasil instrumentasi tidak ditemukan');
  }
  console.log('\n--- log aplikasi (boot) ---');
  console.log(log.slice(0, 14).join('\n'));
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(OUT, { force: true });
})();

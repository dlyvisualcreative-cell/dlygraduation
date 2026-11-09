'use strict';
/*
 * AUDIT ONLY — biaya per-request untuk halaman portal & admin (sesi disuntik di SALINAN DB).
 * Juga mengukur biaya pembuatan turunan gambar (/media) saat cache kosong.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const APP = path.join(__dirname, '..');
const COLD = process.argv.includes('--cold-cache');
const DATA = path.join(os.tmpdir(), 'dly-audit-req-' + process.pid);
const OUT = path.join(os.tmpdir(), 'dly-audit-req-' + process.pid + '.json');
const PORT = 4805;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* --- sesi portal & admin disuntik langsung ke salinan DB --- */
const db = new Database(path.join(DATA, 'app.sqlite'));
const booking = db.prepare(`SELECT * FROM bookings WHERE status = 'confirmed' ORDER BY id DESC LIMIT 1`).get();
const portalSid = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT OR REPLACE INTO portal_sessions (id, booking_id, expires_at) VALUES (?,?,datetime('now','+2 day'))")
  .run(portalSid, booking.id);
const admin = db.prepare('SELECT * FROM admins ORDER BY id LIMIT 1').get();
const adminSid = crypto.randomBytes(32).toString('hex');
const csrf = crypto.randomBytes(16).toString('hex');
const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
const row = { id: adminSid, admin_id: admin.id, csrf };
if (cols.includes('created_at')) row.created_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
db.prepare(`INSERT OR REPLACE INTO sessions (${Object.keys(row).join(',')}, expires_at)
            VALUES (${Object.keys(row).map(() => '?').join(',')}, datetime('now','+2 day'))`)
  .run(...Object.values(row));
const mediaSamples = db.prepare("SELECT image FROM portfolio WHERE is_active = 1 AND image IS NOT NULL LIMIT 3").all()
  .map((r) => r.image);
db.close();

const app = spawn(process.execPath, ['--require', path.join(__dirname, 'audit-instrument.js'), path.join(APP, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA, AUDIT_OUT: OUT, DLY_DISABLE_PUSH_SCHEDULER: '1' },
  stdio: ['ignore', 'ignore', 'pipe']
});

(async () => {
  for (let i = 0; i < 400; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(COLD ? 25000 : 8000); // beri warm-up boot selesai

  const get = async (p, headers = {}) => {
    const t = Date.now();
    const r = await fetch(BASE + p, { headers, redirect: 'manual' });
    const body = await r.text();
    return { ms: Date.now() - t, status: r.status, len: body.length, loc: r.headers.get('location') || '' };
  };
  const cookiePortal = { cookie: `dly_portal=${portalSid}` };
  const cookieAdmin = { cookie: `dly_sid=${adminSid}` };

  const targets = [
    ['/api/availability?bulan=2026-12', {}],
    ['/portal', cookiePortal],
    ['/portal/ringkasan', cookiePortal],
    ['/portal/pantau-order', cookiePortal],
    ['/portal/upgrade', cookiePortal],
    ['/portal/reschedule', cookiePortal],
    ['/portal/drive', cookiePortal],
    ['/portal/pilih-foto', cookiePortal],
    ['/portal/status', cookiePortal],
    ['/admin', cookieAdmin],
    ['/admin/bookings', cookieAdmin],
    [`/admin/bookings/${booking.id}`, cookieAdmin],
    ['/admin/editing', cookieAdmin],
    ['/admin/settings', cookieAdmin]
  ];
  console.log(`\n=== BIAYA PER REQUEST (${COLD ? 'cache gambar kosong' : 'cache ada'}) ===`);
  for (const [p, h] of targets) {
    const r = await get(p, h);
    console.log(`  ${String(r.ms).padStart(5)}ms ${String(r.status)} ${p.padEnd(34)} ${String(r.len).padStart(6)}B ${r.loc ? '→ ' + r.loc.slice(0, 40) : ''}`);
  }

  if (COLD) {
    console.log('\n=== BIAYA MEMBUAT TURUNAN GAMBAR (/media) saat cache kosong ===');
    for (const src of mediaSamples) {
      for (const w of [480, 1200, 2000]) {
        const file = path.basename(src);
        const url = `/media/${file.replace(/\.[^.]+$/, '')}-${w}.webp`;
        const r = await get(url);
        console.log(`  ${String(r.ms).padStart(6)}ms ${String(r.status)} ${String(Math.round(r.len / 1024)).padStart(4)}KB ${url.slice(0, 46)}`);
      }
    }
  }

  app.kill('SIGTERM');
  await sleep(1500);
  if (fs.existsSync(OUT)) {
    const a = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    console.log('\n--- per request: query & spawn ---');
    a.requests.filter((r) => r.method === 'GET').forEach((r) => {
      console.log(`  ${String(r.ms).padStart(5)}ms ${String(r.status)} ${r.url.padEnd(28)} stmt=${String(r.stmts).padStart(3)} rows=${String(r.rows).padStart(4)} convert=${r.convert} identify=${r.identify}`);
    });
    const slow = a.requests.slice().sort((x, y) => y.stmts - x.stmts)[0];
    if (slow) {
      console.log(`\n  query terbanyak: ${slow.url} (${slow.stmts} statement)`);
      const counts = {};
      (slow.sql || []).forEach((q) => { counts[q] = (counts[q] || 0) + 1; });
      Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 6)
        .forEach(([q, n]) => console.log(`    ${String(n).padStart(3)}× ${q.slice(0, 110)}`));
    }
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(OUT, { force: true });
})();

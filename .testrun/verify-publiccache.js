'use strict';
/* Verifikasi mikro-cache: publik HIT, privat SELALU render ulang, invalidasi jalan. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-cache-' + process.pid);
const PORT = 4870;
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}
const db = new Database(path.join(DATA, 'app.sqlite'));
const booking = db.prepare("SELECT id FROM bookings WHERE status='confirmed' ORDER BY id DESC LIMIT 1").get();
const psid = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT OR REPLACE INTO portal_sessions (id, booking_id, expires_at) VALUES (?,?,datetime('now','+1 day'))").run(psid, booking.id);
db.close();

const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1' },
  stdio: ['ignore', 'ignore', 'pipe']
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p, h = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: h, redirect: 'manual' });
  const body = await r.text();
  return { status: r.status, cache: r.headers.get('x-public-cache') || '-', cc: r.headers.get('cache-control'), len: body.length, body };
};

(async () => {
  for (let i = 0; i < 300; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(3000);

  const first = await get('/');
  const second = await get('/');
  console.log(`beranda     1: ${first.status} ${first.cache} ${first.cc}`);
  console.log(`beranda     2: ${second.status} ${second.cache} ${second.cc} (isi sama: ${first.body === second.body})`);
  const gal1 = await get('/gallery'); const gal2 = await get('/gallery');
  console.log(`gallery     1: ${gal1.cache}  2: ${gal2.cache}`);
  const pr1 = await get('/pricelist'); const pr2 = await get('/pricelist');
  console.log(`pricelist   1: ${pr1.cache}  2: ${pr2.cache}`);
  const q1 = await get('/?utm_source=x'); const q2 = await get('/?utm_source=x');
  console.log(`dengan query: ${q1.cache} / ${q2.cache}  (harus MISS/MISS)`);
  const p1 = await get('/portal/ringkasan', { cookie: `dly_portal=${psid}` });
  const p2 = await get('/portal/ringkasan', { cookie: `dly_portal=${psid}` });
  console.log(`portal:       ${p1.status} ${p1.cache} / ${p2.cache}  cc=${p2.cc} (harus tidak HIT)`);
  const a1 = await get('/admin/login'); const a2 = await get('/admin/login');
  console.log(`admin login:  ${a1.cache} / ${a2.cache} (harus tidak HIT)`);
  const b1 = await get('/booking'); const b2 = await get('/booking');
  console.log(`booking:      ${b1.cache} / ${b2.cache} (harus tidak HIT)`);
  const s1 = await get('/sitemap.xml'); console.log(`sitemap:      ${s1.status} ${s1.cache} (bukan HTML → tidak di-cache)`);

  // invalidasi: ubah data lewat admin? cukup pastikan TTL habis → MISS lagi
  await sleep(16000);
  const three = await get('/');
  console.log(`beranda setelah 16s: ${three.cache} (harus MISS lagi)`);
  app.kill('SIGTERM');
  await sleep(600);
  fs.rmSync(DATA, { recursive: true, force: true });
})();

'use strict';
/* AUDIT ONLY — CPU per request (1 pengguna, tanpa kongesti) → batas kapasitas 1 core. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-cpu-' + process.pid);
const PORT = 4820;
const CPU_OUT = path.join(DATA, 'cpu.jsonl');
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}

const db = new Database(path.join(DATA, 'app.sqlite'));
const booking = db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' ORDER BY id DESC LIMIT 1").get();
const psid = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT OR REPLACE INTO portal_sessions (id, booking_id, expires_at) VALUES (?,?,datetime('now','+2 day'))").run(psid, booking.id);
const admin = db.prepare('SELECT * FROM admins ORDER BY id LIMIT 1').get();
const asid = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT OR REPLACE INTO sessions (id, admin_id, csrf, created_at, expires_at) VALUES (?,?,?,datetime('now'),datetime('now','+2 day'))")
  .run(asid, admin.id, crypto.randomBytes(16).toString('hex'));
db.close();

const app = spawn(process.execPath, ['--require', path.join(__dirname, 'cpu-probe.js'), path.join(APP, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1', CPU_OUT },
  stdio: ['ignore', 'ignore', 'pipe']
});
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (p, cookie, enc) => new Promise((resolve) => {
  const t = process.hrtime.bigint();
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (enc) headers['accept-encoding'] = enc;
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, headers, agent }, (res) => {
    let bytes = 0;
    res.on('data', (c) => { bytes += c.length; });
    res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t) / 1e6, status: res.statusCode, bytes }));
  });
  req.on('error', () => resolve({ ms: 0, status: 0, bytes: 0 }));
  req.end();
});

const cpuBetween = (from, to) => {
  try {
    return fs.readFileSync(CPU_OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.at >= from && r.at <= to).reduce((s, r) => s + r.cpuMs, 0);
  } catch (e) { return 0; }
};

(async () => {
  for (let i = 0; i < 400; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(10000);
  const targets = [
    ['/', null, 'gzip, br'],
    ['/', null, null],
    ['/gallery', null, 'gzip, br'],
    ['/pricelist', null, 'gzip, br'],
    ['/cara-order', null, 'gzip, br'],
    ['/api/availability?bulan=2026-12', null, 'gzip, br'],
    ['/portal/ringkasan', `dly_portal=${psid}`, 'gzip, br'],
    ['/portal/pantau-order', `dly_portal=${psid}`, 'gzip, br'],
    ['/portal/upgrade', `dly_portal=${psid}`, 'gzip, br'],
    ['/portal/status', `dly_portal=${psid}`, 'gzip, br'],
    ['/admin/bookings', `dly_sid=${asid}`, 'gzip, br'],
    ['/admin/bookings/' + booking.id, `dly_sid=${asid}`, 'gzip, br'],
    ['/media/30234573-320.webp', null, 'gzip, br'],
    ['/assets/app.css', null, 'gzip, br']
  ];
  console.log('=== CPU PER REQUEST (1 pengguna berurutan, 60 request) ===\n');
  console.log('  endpoint                          status  rata-rata   CPU/req   batas 1 core   KB/resp');
  for (const [p, cookie, enc] of targets) {
    let ok = 0; const lens = [];
    for (let i = 0; i < 5; i++) await get(p, cookie, enc); // pemanasan
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      const r = await get(p, cookie, enc);
      if (r.status === 200) ok += 1;
      lens.push(r.ms);
    }
    const wall = Date.now() - t0;
    const cpuMs = cpuBetween(t0, Date.now());
    const perReq = cpuMs / 60;
    lens.sort((a, b) => a - b);
    console.log(`  ${p.slice(0, 32).padEnd(33)} ${String(ok).padStart(3)}  ${String(Math.round(wall / 60)).padStart(6)}ms ${perReq.toFixed(1).padStart(8)}ms ${String(Math.round(1000 / Math.max(perReq, 0.01))).padStart(9)} rps`);
  }
  app.kill('SIGTERM');
  agent.destroy();
  await sleep(800);
  fs.rmSync(DATA, { recursive: true, force: true });
})();

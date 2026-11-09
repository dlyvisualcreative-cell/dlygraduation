'use strict';
/*
 * AUDIT ONLY — load test bertahap di SALINAN LOKAL (bukan produksi).
 * Tahap: 10 / 25 / 50 / 100 / 200 pengguna bersamaan, 15 detik per tahap.
 *
 * Skenario campuran (mendekati pemakaian nyata):
 *   30% beranda · 12% gallery · 10% pricelist · 8% cara-order
 *   14% portal klien (ringkasan/pantau-order/reschedule) · 18% aset gambar /media
 *    4% API ketersediaan ·  2% tulis (pengajuan extra time portal)
 *
 * Hasil: p50/p95/p99, RPS, error rate, CPU & RAM proses aplikasi.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-load-' + process.pid);
const PORT = 4810;
const STAGES = (process.env.STAGES || '10,25,50,100,200').split(',').map(Number);
const DURATION = Number(process.env.DURATION || 15000);

fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}

/* --- siapkan sesi portal untuk beberapa booking + 1 sesi admin --- */
const db = new Database(path.join(DATA, 'app.sqlite'));
const bookings = db.prepare("SELECT id FROM bookings WHERE status IN ('confirmed','completed') ORDER BY id DESC LIMIT 40").all();
if (!bookings.length) throw new Error('tidak ada booking terkonfirmasi untuk diuji');
const portalSids = bookings.map((b) => {
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO portal_sessions (id, booking_id, expires_at) VALUES (?,?,datetime('now','+2 day'))").run(sid, b.id);
  return sid;
});
const admin = db.prepare('SELECT * FROM admins ORDER BY id LIMIT 1').get();
const adminSid = crypto.randomBytes(32).toString('hex');
const adminCsrf = crypto.randomBytes(16).toString('hex');
db.prepare("INSERT OR REPLACE INTO sessions (id, admin_id, csrf, created_at, expires_at) VALUES (?,?,?,datetime('now'),datetime('now','+2 day'))")
  .run(adminSid, admin.id, adminCsrf);
const mediaUrls = db.prepare('SELECT image FROM portfolio WHERE is_active = 1 LIMIT 4').all().map((r) => r.image)
  .concat(db.prepare('SELECT image_url FROM hero_slides WHERE is_active = 1 LIMIT 2').all().map((r) => r.image_url));
const bookingIdForWrite = bookings[0].id;
db.close();

const CPU_OUT = path.join(DATA, 'cpu.jsonl');
try { fs.rmSync(CPU_OUT, { force: true }); } catch (e) { /* baru */ }
const app = spawn(process.execPath, ['--require', path.join(__dirname, 'cpu-probe.js'), path.join(APP, 'server.js')], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1', CPU_OUT },
  stdio: ['ignore', 'ignore', 'pipe']
});
app.stderr.on('data', (d) => {
  const t = String(d);
  if (!/listening|VAPID|images|push/.test(t)) process.stderr.write('[app] ' + t);
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 400 });
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(pathname, { cookie, method = 'GET', body } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const headers = { 'accept-encoding': 'gzip, br' };
    if (cookie) headers.cookie = cookie;
    let payload = null;
    if (body) {
      payload = Buffer.from(new URLSearchParams(body).toString());
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = payload.length;
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers, agent }, (res) => {
      res.resume();
      res.on('end', () => resolve({
        ms: Number(process.hrtime.bigint() - started) / 1e6, status: res.statusCode, path: pathname
      }));
    });
    req.on('error', (err) => resolve({
      ms: Number(process.hrtime.bigint() - started) / 1e6, status: 0, path: pathname, error: err.code
    }));
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* --- metrik proses dari probe internal Node (bukan /proc) --- */
const cpuSample = [];
function readCpu(sinceMs) {
  try {
    const rows = fs.readFileSync(CPU_OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const picked = rows.filter((r) => r.at >= sinceMs);
    return picked;
  } catch (e) { return []; }
}
let lastCpu = null;
let lastAt = null;
function sampleCpu() {
  try {
    const stat = fs.readFileSync(`/proc/${app.pid}/stat`, 'utf8').split(' ');
    const ticks = Number(stat[13]) + Number(stat[14]);
    const now = Date.now();
    if (lastCpu !== null) {
      cpuSample.push((ticks - lastCpu) / ((now - lastAt) / 1000) * 10); // %CPU (100 = 1 core)
    }
    lastCpu = ticks;
    lastAt = now;
    const status = fs.readFileSync(`/proc/${app.pid}/status`, 'utf8');
    const rss = /VmRSS:\s+(\d+) kB/.exec(status);
    return rss ? Number(rss[1]) / 1024 : 0;
  } catch (e) { return 0; }
}

const SCENARIOS = [];
const add = (weight, fn) => { for (let i = 0; i < weight; i++) SCENARIOS.push(fn); };
const anyCookie = () => 'dly_portal=' + portalSids[Math.floor(Math.random() * portalSids.length)];
add(30, () => request('/'));
add(12, () => request('/gallery'));
add(10, () => request('/pricelist'));
add(8, () => request('/cara-order'));
add(7, () => request('/portal/ringkasan', { cookie: anyCookie() }));
add(7, () => request('/portal/pantau-order', { cookie: anyCookie() }));
add(6, () => request('/portal/upgrade', { cookie: anyCookie() }));
add(10, () => {
  const img = mediaUrls[Math.floor(Math.random() * mediaUrls.length)];
  const w = [320, 480, 800][Math.floor(Math.random() * 3)];
  const name = path.basename(String(img)).replace(/\.[^.]+$/, '');
  return request(`/media/${name}-${w}.webp`);
});
add(8, () => {
  const img = mediaUrls[Math.floor(Math.random() * mediaUrls.length)];
  const name = path.basename(String(img)).replace(/\.[^.]+$/, '');
  return request(`/media/${name}-1200.jpg`);
});
add(4, () => request('/api/availability?bulan=2026-12'));
add(2, () => request('/portal/upgrade/extra', {
  cookie: anyCookie(), method: 'POST', body: { minutes: '30' }
}));

(async () => {
  for (let i = 0; i < 400; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(12000); // warm-up boot selesai (agar tidak mengukur stampede startup)
  console.log('=== LOAD TEST (salinan lokal, 1 proses Node) ===');
  console.log(`durasi per tahap: ${DURATION / 1000}s · campuran: beranda 30%, gallery 12%, pricelist 10%, cara-order 8%,`);
  console.log('portal 20%, gambar /media 18%, API 4%, tulis 2%\n');

  const summary = [];
  for (const vus of STAGES) {
    const lat = [];
    const errors = [];
    const perPath = {};
    let running = true;
    cpuSample.length = 0;
    const t0 = Date.now();

    const worker = async () => {
      while (running) {
        const fn = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
        const r = await fn();
        lat.push(r.ms);
        if (r.status === 0 || r.status >= 500) errors.push(`${r.status}${r.error ? ':' + r.error : ''} ${r.path}`);
        const key = r.path.split('?')[0];
        perPath[key] = perPath[key] || { n: 0, sum: 0, max: 0 };
        perPath[key].n += 1;
        perPath[key].sum += r.ms;
        perPath[key].max = Math.max(perPath[key].max, r.ms);
        if (Math.random() < 0.35) await sleep(60 + Math.random() * 240); // think time
      }
    };
    const workers = Array.from({ length: vus }, worker);
    await sleep(DURATION);
    running = false;
    await Promise.all(workers);
    const elapsed = (Date.now() - t0) / 1000;
    const samples = readCpu(t0 + 600);
    const cpuVals = samples.map((s) => s.cpuPct);
    const rssVals = samples.map((s) => s.rss);

    const sorted = lat.slice().sort((a, b) => a - b);
    const q = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0);
    const cpuAvg = cpuVals.length ? Math.round(cpuVals.reduce((s, x) => s + x, 0) / cpuVals.length) : 0;
    const cpuMax = cpuVals.length ? Math.max(...cpuVals) : 0;
    const rss = rssVals.length ? Math.round(rssVals.reduce((s, x) => s + x, 0) / rssVals.length) : 0;
    const errRate = (errors.length / Math.max(lat.length, 1) * 100);
    const row = {
      vus, requests: lat.length, rps: Math.round(lat.length / elapsed),
      p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(sorted[sorted.length - 1] || 0),
      errRate: Number(errRate.toFixed(2)), errSample: errors.slice(0, 3),
      cpuAvg, cpuMax, rssMB: rss
    };
    summary.push(row);
    console.log(`${String(vus).padStart(3)} pengguna | ${String(row.requests).padStart(5)} req  ${String(row.rps).padStart(4)} rps | p50 ${String(row.p50).padStart(4)}ms  p95 ${String(row.p95).padStart(4)}ms  p99 ${String(row.p99).padStart(4)}ms  max ${String(row.max).padStart(5)}ms | error ${row.errRate}% | CPU avg ${row.cpuAvg}% max ${row.cpuMax}% | RAM ${row.rssMB}MB`);
    if (row.errSample.length) console.log('      contoh error:', row.errSample.join(' | '));
    const hottest = Object.entries(perPath).sort((a, b) => b[1].n - a[1].n).slice(0, 4)
      .map(([p, v]) => `${p} ${v.n}× avg ${Math.round(v.sum / v.n)}ms max ${Math.round(v.max)}ms`);
    console.log('      endpoint tersibuk:', hottest.join(' · '));
    await sleep(3000); // jeda antar tahap
  }

  console.log('\n=== RINGKASAN UNTUK LAPORAN ===');
  summary.forEach((s) => console.log(JSON.stringify(s)));
  console.log('\ncatatan keterbatasan: semua pengguna uji berasal dari localhost (tanpa latensi internet),');
  console.log('satu mesin dipakai bersama aplikasi lain; hasil = kapasitas server, bukan pengalaman jaringan.');

  app.kill('SIGTERM');
  agent.destroy();
  await sleep(1000);
  fs.rmSync(DATA, { recursive: true, force: true });
})().catch((err) => {
  console.error('FATAL', err);
  app.kill('SIGTERM');
});

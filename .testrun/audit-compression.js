'use strict';
/* AUDIT ONLY — berapa biaya kompresi per request? Bandingkan throughput dengan/tanpa Accept-Encoding. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-bench-' + process.pid);
const PORT = 4815;
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}
const CPU_OUT = path.join(DATA, 'cpu.jsonl');
const app = spawn(process.execPath, ['--require', path.join(__dirname, 'cpu-probe.js'), path.join(APP, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1', CPU_OUT },
  stdio: ['ignore', 'ignore', 'pipe']
});
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (pathname, enc) => new Promise((resolve) => {
  const t = process.hrtime.bigint();
  const headers = enc ? { 'accept-encoding': enc } : {};
  const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, headers, agent }, (res) => {
    let bytes = 0;
    res.on('data', (c) => { bytes += c.length; });
    res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t) / 1e6, status: res.statusCode, bytes }));
  });
  req.on('error', () => resolve({ ms: 0, status: 0, bytes: 0 }));
  req.end();
});

async function bench(pathname, enc, vus, ms) {
  const t0 = Date.now();
  const lat = [];
  let bytes = 0;
  let running = true;
  const worker = async () => {
    while (running) {
      const r = await get(pathname, enc);
      lat.push(r.ms);
      bytes += r.bytes;
      await sleep(40 + Math.random() * 160);
    }
  };
  const workers = Array.from({ length: vus }, worker);
  await sleep(ms);
  running = false;
  await Promise.all(workers);
  const secs = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const q = (p) => Math.round(lat[Math.floor(lat.length * p)] || 0);
  const samples = (() => {
    try {
      return fs.readFileSync(CPU_OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        .filter((r) => r.at >= t0 && r.at <= Date.now());
    } catch (e) { return []; }
  })();
  const cpu = samples.length ? Math.round(samples.reduce((s, x) => s + x.cpuPct, 0) / samples.length) : 0;
  return { pathname, enc: enc || 'tanpa', rps: Math.round(lat.length / secs), p50: q(0.5), p95: q(0.95), cpu, kbPerReq: Math.round(bytes / lat.length / 1024) };
}

(async () => {
  for (let i = 0; i < 400; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(10000);
  console.log('=== BIAYA KOMPRESI (25 pengguna, halaman dinamis vs statis) ===');
  for (const [p, label] of [['/', 'beranda (dinamis)'], ['/portal/ringkasan', 'portal (dinamis)'], ['/assets/app.css', 'CSS (statis)']]) {
    for (const enc of ['gzip, br', 'gzip', null]) {
      const r = await bench(p, enc, 25, 8000);
      console.log(`  ${label.padEnd(18)} ${String(r.enc).padEnd(10)} ${String(r.rps).padStart(4)} rps  p50 ${String(r.p50).padStart(4)}ms p95 ${String(r.p95).padStart(4)}ms  CPU ${String(r.cpu).padStart(3)}%  ${r.kbPerReq}KB/req`);
    }
  }
  app.kill('SIGTERM');
  agent.destroy();
  await sleep(800);
  fs.rmSync(DATA, { recursive: true, force: true });
})();

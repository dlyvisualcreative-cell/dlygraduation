'use strict';
/* AUDIT ONLY — profil CPU (--cpu-prof) halaman beranda, agregat self-time per fungsi. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-prof-' + process.pid);
const PROFDIR = path.join(DATA, 'prof');
const PORT = 4825;
fs.mkdirSync(PROFDIR, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}
const TARGET = process.argv[2] || '/';
const N = Number(process.argv[3] || 300);

const app = spawn(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${PROFDIR}`,
  path.join(__dirname, 'audit-prof-run.js')], {
  env: {
    ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: DATA,
    DLY_DISABLE_PUSH_SCHEDULER: '1', PROF_EXIT_MS: String(Number(process.env.PROF_EXIT_MS || 14000))
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, headers: { 'accept-encoding': 'gzip, br' }, agent }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', () => resolve(0)); req.end();
});

(async () => {
  for (let i = 0; i < 400; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(10000);
  for (let i = 0; i < 20; i++) await get(TARGET); // pemanasan
  const t0 = Date.now();
  for (let i = 0; i < N; i++) await get(TARGET);
  const elapsed = Date.now() - t0;
  console.log(`${TARGET}: ${N} request dalam ${elapsed}ms → ${(elapsed / N).toFixed(1)}ms/req (1 pengguna berurutan)`);
  app.kill('SIGTERM');
  for (let i = 0; i < 40 && !fs.readdirSync(PROFDIR).some((f) => f.endsWith('.cpuprofile')); i++) await sleep(500);

  const files = fs.readdirSync(PROFDIR).filter((f) => f.endsWith('.cpuprofile'));
  if (!files.length) { console.log('profil tidak ditemukan'); app.kill(); return; }
  const prof = JSON.parse(fs.readFileSync(path.join(PROFDIR, files[0]), 'utf8'));
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  // hitCount = sampel yang jatuh di node itu
  prof.nodes.forEach((n) => {
    const key = `${n.callFrame.functionName || '(anonim)'} @ ${(n.callFrame.url || '').replace(/^file:\/\//, '').replace(APP, '')}:${n.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (n.hitCount || 0));
  });
  const total = Array.from(self.values()).reduce((s, x) => s + x, 0) || 1;
  const rows = Array.from(self.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`\ntotal sampel: ${total}  (≈ ${(total)} × 1ms)`);
  console.log('\n  %     fungsi');
  rows.slice(0, 22).forEach(([k, v]) => {
    const pct = (v / total * 100);
    if (pct < 0.7) return;
    console.log(`  ${pct.toFixed(1).padStart(5)}%  ${k.slice(0, 110)}`);
  });
  // kelompokkan berdasarkan file
  const byFile = new Map();
  rows.forEach(([k, v]) => {
    const file = (k.split(' @ ')[1] || '').split(':')[0] || '(internal)';
    byFile.set(file, (byFile.get(file) || 0) + v);
  });
  console.log('\n  per file:');
  Array.from(byFile.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([f, v]) => console.log(`  ${(v / total * 100).toFixed(1).padStart(5)}%  ${f.slice(0, 100)}`));
  fs.rmSync(DATA, { recursive: true, force: true });
})();

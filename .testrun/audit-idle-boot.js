'use strict';
/* AUDIT ONLY — berapa lama server "sibuk sendiri" setelah restart (tanpa pengunjung)? */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-idle-' + process.pid);
const CPU_OUT = path.join(DATA, 'cpu.jsonl');
const PORT = 4840;
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}
const t0 = Date.now();
const app = spawn(process.execPath, ['--require', path.join(__dirname, 'cpu-probe.js'), path.join(APP, 'server.js')], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: DATA, CPU_OUT, DLY_DISABLE_PUSH_SCHEDULER: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let listening = null;
app.stdout.on('data', (d) => {
  const t = String(d);
  if (!listening && /listening/i.test(t)) listening = Date.now() - t0;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // biarkan berjalan TANPA pengunjung selama 35 detik
  await sleep(35000);
  const rows = (() => {
    try {
      return fs.readFileSync(CPU_OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { return []; }
  })();
  app.kill('SIGTERM');
  console.log(`listening setelah: ${listening} ms`);
  console.log('\n  detik  CPU%  RAM');
  rows.forEach((r, i) => {
    if (i % 2) return;
    console.log(`  ${String(((r.at - rows[0].at) / 1000).toFixed(0)).padStart(5)}  ${String(r.cpuPct).padStart(4)}  ${r.rss}MB${r.cpuPct > 20 ? '  ← masih bekerja' : ''}`);
  });
  const busy = rows.filter((r) => r.cpuPct > 20);
  if (busy.length) {
    const last = busy[busy.length - 1];
    console.log(`\nserver sibuk sendiri (CPU>20%) selama ≈ ${((last.at - rows[0].at) / 1000).toFixed(1)} detik setelah start`);
  }
  const totalCpu = rows.reduce((s, r) => s + r.cpuMs, 0);
  console.log(`total CPU terpakai saat idle-boot: ${Math.round(totalCpu)} ms`);
  await sleep(800);
  fs.rmSync(DATA, { recursive: true, force: true });
})();

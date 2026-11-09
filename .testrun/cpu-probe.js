'use strict';
/* AUDIT ONLY — probe CPU/RAM proses aplikasi (ditulis ke JSONL). Tidak mengubah aplikasi. */
const fs = require('fs');
const OUT = process.env.CPU_OUT || '/tmp/dly-cpu.jsonl';
let last = process.cpuUsage();
let lastAt = Date.now();
setInterval(() => {
  const now = process.cpuUsage(last);
  const at = Date.now();
  const cpuMs = (now.user + now.system) / 1000;
  const wall = at - lastAt;
  const rss = process.memoryUsage().rss / 1024 / 1024;
  try {
    fs.appendFileSync(OUT, JSON.stringify({ at, wall, cpuMs, cpuPct: Math.round((cpuMs / wall) * 100), rss: Math.round(rss) }) + '\n');
  } catch (e) { /* abaikan */ }
  last = process.cpuUsage();
  lastAt = at;
}, 500).unref();

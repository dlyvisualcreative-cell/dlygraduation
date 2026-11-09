'use strict';
/* Karakterisasi latensi live: 40 request berurutan + 10 request paralel, catat ekor lambat. */
const BASE = process.env.BASE || 'https://dlygraduation.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const times = [];
  for (let i = 0; i < 40; i++) {
    const t0 = Date.now();
    const r = await fetch(BASE + '/');
    await r.text();
    times.push(Date.now() - t0);
    await sleep(150);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  console.log(`berurutan: p50=${p(0.5)}ms p90=${p(0.9)}ms p95=${p(0.95)}ms max=${Math.max(...times)}ms  >1s=${times.filter((t) => t > 1000).length}/40`);

  // Burst paralel 10 (seperti satu halaman memuat 10 aset sekaligus).
  const burst = async (n, path) => {
    const t0 = Date.now();
    await Promise.all(Array.from({ length: n }, async (_, i) => {
      const r = await fetch(BASE + path);
      await r.arrayBuffer();
    }));
    return Date.now() - t0;
  };
  for (const n of [5, 10]) {
    const ms = await burst(n, '/');
    console.log(`paralel ${String(n).padStart(2)}× HTML: total ${ms}ms (rata-rata ${Math.round(ms / n)}ms/req)`);
  }
  const media = await Promise.all(['/media/30234573-480.webp', '/media/c2c0c893-320.webp', '/media/bcc4fa9b-320.webp',
    '/assets/app.css', '/assets/app.js', '/logo/a2VlcHwvdXBsb2Fkcy9ETFktR1JBRFVBVElPTi0yLTE3OTM5MjY3MzgzOTAtYzZjMzYxLnBuZw.png',
    '/media/760eeb30-320.webp', '/media/46d4ede5-480.webp'].map(async (p) => {
    const t0 = Date.now();
    const r = await fetch(BASE + p);
    const b = await r.arrayBuffer();
    return { p, ms: Date.now() - t0, kb: Math.round(b.byteLength / 1024) };
  }));
  media.forEach((m) => console.log(`  ${String(m.ms).padStart(5)}ms ${String(m.kb).padStart(4)}KB ${m.p.slice(0, 60)}`));
})();

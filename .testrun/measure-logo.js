'use strict';
/* Ukur lebar logo yang benar-benar dirender (untuk memilih `sizes` yang tepat). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-logo-' + process.pid);
const PORT = 4865;
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
for (const dir of ['image-cache', 'logo-cache']) {
  try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA, dir), { recursive: true }); } catch (e) { fs.mkdirSync(path.join(DATA, dir), { recursive: true }); }
}
const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1' },
  stdio: ['ignore', 'ignore', 'ignore']
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 300; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(3000);
  const b = await chromium.launch();
  for (const [w, dpr] of [[390, 2], [390, 3], [1366, 1], [1366, 2]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    const sizes = [];
    page.on('response', (r) => {
      if (/\/logo\/.*\.(webp|png)$/.test(r.url())) {
        const h = r.headers();
        sizes.push({ url: r.url().replace(/^.*\/logo\//, '').slice(-24), len: Number(h['content-length'] || 0) });
      }
    });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const box = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.logo img, .logo picture img, .logo__img, header img'));
      if (!els.length) return { count: 0, html: document.querySelector('.logo') ? document.querySelector('.logo').innerHTML.slice(0, 200) : 'no .logo' };
      const solid = els.find((e) => getComputedStyle(e).display !== 'none') || els[0];
      const r = solid.getBoundingClientRect();
      return { count: els.length, w: Math.round(r.width), h: Math.round(r.height), natural: solid.naturalWidth };
    });
    const total = sizes.reduce((s, x) => s + x.len, 0);
    console.log(`${w}px @${dpr}x → ${JSON.stringify(box)} · unduhan ${sizes.length} file ${Math.round(total / 1024)}KB`);
    sizes.forEach((s) => console.log(`     ${String(Math.round(s.len / 1024)).padStart(3)}KB ${s.url}`));
    await ctx.close();
  }
  await b.close();
  app.kill('SIGTERM');
  await sleep(600);
  fs.rmSync(DATA, { recursive: true, force: true });
})();

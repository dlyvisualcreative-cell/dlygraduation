'use strict';
/**
 * One-off probe: which network requests own the critical path on a throttled mobile
 * homepage? Prints resource timings (start → end, bytes) sorted by end time.
 *
 *   node scripts/probe-lcp.js [path]
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = 4519;
const DATA_DIR = '/tmp/dly-probe';
const TARGET = process.argv[2] || '/';

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) {}

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch (e) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const DPR = Number(process.env.DPR || 3);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: DPR, isMobile: DPR > 1, hasTouch: DPR > 1 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8
    });
    await page.goto(`http://127.0.0.1:${PORT}${TARGET}`, { waitUntil: 'load', timeout: 120000 });
    const rows = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => ({
      name: r.name.split('/').pop().slice(0, 40),
      start: Math.round(r.startTime),
      end: Math.round(r.responseEnd),
      kb: Math.round((r.transferSize || 0) / 1024),
      type: r.initiatorType
    })).sort((a, b) => b.end - a.end).slice(0, 12));
    rows.forEach((r) => console.log(`${String(r.end).padStart(6)}ms end (start ${String(r.start).padStart(6)}) ${String(r.kb).padStart(4)}KB  ${r.type.padEnd(9)} ${r.name}`));
  } finally {
    await browser.close();
    app.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });

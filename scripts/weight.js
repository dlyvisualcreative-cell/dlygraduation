'use strict';

/**
 * Per-request weight breakdown for one page (V10). Boots the app against a DB copy in
 * /tmp, loads a page in Chromium, and lists every response with its transfer size so a
 * regression can be traced to the exact file.
 *
 *   node scripts/weight.js [path] [--mobile]
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.WEIGHT_PORT || 4496);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-weight';
const TARGET = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/';
const MOBILE = process.argv.includes('--mobile');
const THROTTLE = process.argv.includes('--slow');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  try {
    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: MOBILE ? 3 : 1,
      isMobile: MOBILE,
      hasTouch: MOBILE
    });
    const page = await context.newPage();
    if (THROTTLE) {
      const client = await context.newCDPSession(page);
      await client.send('Network.enable');
      await client.send('Network.emulateNetworkConditions', {
        offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8
      });
    }
    const rows = [];
    page.on('response', async (res) => {
      const req = res.request();
      let size = 0;
      try { size = (await res.body()).length; } catch (e) { size = Number(res.headers()['content-length'] || 0); }
      rows.push({ type: req.resourceType(), url: res.url(), size });
    });
    await page.goto(`${BASE}${TARGET}`, { waitUntil: 'load', timeout: 120000 }).catch(() => {});
    await sleep(2500);
    await browser.close();

    rows.sort((a, b) => b.size - a.size);
    const total = rows.reduce((n, r) => n + r.size, 0);
    console.log(`\n${TARGET}${MOBILE ? ' (mobile 390)' : ' (desktop)'}${THROTTLE ? ' + Slow3G' : ''}`);
    console.log(`total ${Math.round(total / 1024)}KB in ${rows.length} requests\n`);
    rows.slice(0, 18).forEach((r) => {
      const name = r.url.replace(BASE, '').replace(/^\/media\/([a-f0-9]{8})-/, '/media/$1-');
      console.log(`  ${String(Math.round(r.size / 1024)).padStart(5)}KB  ${r.type.padEnd(10)} ${name.slice(0, 84)}`);
    });
  } finally {
    app.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

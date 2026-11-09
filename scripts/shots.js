'use strict';

/**
 * Visual snapshots for manual review (V10). Boots the app against a DB copy in /tmp and
 * writes PNGs to scripts/.shots/ for desktop (1440) and mobile (390).
 *
 *   node scripts/shots.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const OUT = path.join(__dirname, '.shots');
const PORT = Number(process.env.SHOT_PORT || 4505);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  // Carry the image dimension index over: without it every tile falls back to its CSS
  // ratio and a "natural ratio" audit would measure the fallback instead of the truth.
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'image-cache'), { recursive: true });
    fs.copyFileSync(path.join(APP, 'data', 'image-cache', 'dimensions.json'),
      path.join(DATA_DIR, 'image-cache', 'dimensions.json'));
  } catch (err) { /* first run: the app will warm it at boot */ }

  const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
  const token = (db.prepare('SELECT token FROM photo_selections LIMIT 1').get() || {}).token || '';
  const pkg = (db.prepare('SELECT slug FROM packages LIMIT 1').get() || {}).slug || '';
  db.close();

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }

    const pages = ['/', '/gallery', '/pricelist', `/paket/${pkg}`, '/booking', '/ulasan'];
    if (token) pages.push(`/selection/${token}`);

    for (const [label, viewport] of [['desktop', { width: 1440, height: 950 }], ['mobile', { width: 390, height: 844 }]]) {
      // One tab per browser instance: a fresh context per size keeps them sequential.
      const context = await browser.newContext({ viewport, isMobile: label === 'mobile', hasTouch: label === 'mobile', deviceScaleFactor: label === 'mobile' ? 2 : 1 });
      const page = await context.newPage();
      for (const url of pages) {
        await page.goto(`${BASE}${url}`, { waitUntil: 'load' }).catch(() => {});
        await sleep(1200);
        // Force lazy images in view by scrolling once, then back to top.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(900);
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(400);
        const name = url === '/' ? 'home' : url.replace(/\//g, '_').replace(/^_/, '');
        const file = path.join(OUT, `${label}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log('shot', path.basename(file));
      }
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
    app.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

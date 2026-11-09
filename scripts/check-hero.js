'use strict';

/**
 * Hero slideshow behaviour check (V10) — the deferred-image optimisation must not break
 * the carousel: slide 1 must paint immediately, later slides must appear when the show
 * advances (or when the visitor clicks), and there must be no console errors.
 *
 *   node scripts/check-hero.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.HERO_PORT || 4498);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-hero';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

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

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(600);

    check('slide 1 has a real <img>', (await page.locator('.hero__slide.is-active img').count()) === 1);
    const firstSrc = await page.locator('.hero__slide.is-active img').getAttribute('src');
    check('slide 1 uses a responsive variant', /\/media\/[a-f0-9]{8}-\d+\.jpg$/.test(String(firstSrc)), String(firstSrc));
    check('slide 1 <picture> offers WebP',
      (await page.locator('.hero__slide.is-active source[type="image/webp"]').count()) === 1);
    check('slide 1 is webp after resolution',
      String(await page.locator('.hero__slide.is-active img').evaluate((i) => i.currentSrc)).endsWith('.webp'),
      String(await page.locator('.hero__slide.is-active img').evaluate((i) => i.currentSrc)));

    const deferred = await page.locator('template[data-hero-defer]').count();
    check('later slides are deferred (no <img> at load)', deferred >= 1, String(deferred));
    const imgsAtLoad = await page.locator('.hero__slide img').count();
    const slidesTotal = await page.locator('.hero__slide').count();
    check('not every slide ships an <img> at load', imgsAtLoad < slidesTotal,
      `${imgsAtLoad} img / ${slidesTotal} slides (${deferred} deferred)`);

    // Advance with the "next" control: the target slide must paint.
    await page.click('[data-hero-next]');
    await sleep(900);
    const activeImg = page.locator('.hero__slide.is-active img');
    check('advancing to the next slide injects its image', (await activeImg.count()) === 1);
    const natural = await activeImg.evaluate((i) => i.naturalWidth);
    check('injected image actually loads', natural > 0, String(natural));
    // Advance a second time: at least one more slide must get hydrated. (Counts alone are
    // timing-dependent because the show autoplays every 3s and pre-fetches its next slide.)
    await page.click('[data-hero-next]');
    await sleep(900);
    const imgsAfter = await page.locator('.hero__slide img').count();
    check('advancing hydrates more slides', imgsAfter > imgsAtLoad, `${imgsAtLoad} → ${imgsAfter}`);
    check('each shown slide has a loaded image',
      await page.locator('.hero__slide.is-active img').evaluate((i) => i.naturalWidth > 0));

    // Back to the previous slide.
    await page.click('[data-hero-prev]');
    await sleep(500);
    check('previous control works', (await page.locator('.hero__slide.is-active img').count()) === 1);

    // Dots still navigate.
    const dots = await page.locator('[data-hero-dot]').count();
    if (dots > 2) {
      await page.click('[data-hero-dot="2"]');
      await sleep(700);
      check('dot navigation works', (await page.locator('.hero__slide.is-active img').count()) === 1);
    }

    check('no console/page errors on the homepage', errors.length === 0, errors.slice(0, 2).join(' | '));

    // Mobile: hero still paints. (One tab per browser instance — close the desktop page.)
    await page.close();
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await mobile.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(600);
    const mSrc = await mobile.locator('.hero__slide.is-active img').evaluate((i) => i.currentSrc);
    check('mobile hero paints a webp', /\.webp$/.test(mSrc), mSrc);
    const metrics = await mobile.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth
    }));
    check('mobile homepage has no horizontal overflow', metrics.scroll <= metrics.client + 1, JSON.stringify(metrics));
    await mobile.close();
  } finally {
    await browser.close();
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

'use strict';

/**
 * Layout sanity audit (Tahap 3B).
 *
 * Boots the app against a COPY of the database and reports, for one page:
 *   - horizontal overflow (must be 0 at every width)
 *   - section heights
 *   - any <img> rendered much taller than the box that contains it (the classic
 *     "width/height attribute won over aspect-ratio" bug — a 1800px carousel tile)
 *   - the box of a few key components, so "looks off" becomes numbers.
 *
 *   node scripts/measure-layout.js /gallery            # desktop 1440
 *   node scripts/measure-layout.js /pricelist --mobile  # 390
 *   node scripts/measure-layout.js / --width=768
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.MEASURE_PORT || 4515);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-measure';
const TARGET = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/';
const MOBILE = process.argv.includes('--mobile');
const WIDTH_ARG = process.argv.find((a) => a.startsWith('--width='));
const WIDTH = WIDTH_ARG ? Number(WIDTH_ARG.split('=')[1]) : (MOBILE ? 390 : 1440);
const HEIGHT = WIDTH < 600 ? 844 : 950;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seedDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, 'image-cache'), { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  // The dimension index is what lets tiles use their natural aspect ratio.
  try {
    fs.copyFileSync(path.join(APP, 'data', 'image-cache', 'dimensions.json'),
      path.join(DATA_DIR, 'image-cache', 'dimensions.json'));
  } catch (err) { /* first run */ }
}

(async () => {
  seedDataDir();
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
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      isMobile: WIDTH < 600, hasTouch: WIDTH < 600, deviceScaleFactor: 1
    });
    const page = await context.newPage();
    await page.goto(`${BASE}${TARGET}`, { waitUntil: 'load' });
    // Give lazy images below the fold a chance to be laid out, then measure at the top.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1600);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(600);

    const report = await page.evaluate(() => {
      const rect = (el) => el.getBoundingClientRect();
      const box = (el) => ({ w: Math.round(rect(el).width), h: Math.round(rect(el).height) });
      const doc = document.documentElement;
      const out = {
        viewport: { w: doc.clientWidth, h: window.innerHeight },
        overflow: doc.scrollWidth - doc.clientWidth,
        height: doc.scrollHeight,
        sections: [],
        tallImages: [],
        components: {}
      };

      document.querySelectorAll('main > section, main > div, body > section').forEach((s) => {
        out.sections.push({ cls: String(s.className).slice(0, 58), ...box(s) });
      });

      // An image taller than 1.35× the box that contains it is almost always the
      // attribute-height bug, not a design choice.
      document.querySelectorAll('img').forEach((img) => {
        if (!img.complete || !img.naturalWidth) return;
        const r = rect(img);
        if (!r.width || !r.height) return;
        out.tallImages.push({
          cls: String(img.className || '').slice(0, 40),
          src: String(img.currentSrc || img.src).split('/').pop().slice(0, 34),
          w: Math.round(r.width), h: Math.round(r.height),
          natural: `${img.naturalWidth}x${img.naturalHeight}`
        });
      });

      const grab = (sel, extra) => {
        const els = Array.from(document.querySelectorAll(sel)).slice(0, 6);
        if (!els.length) return;
        out.components[sel] = els.map((el) => ({ ...box(el), ...(extra ? extra(el) : {}) }));
      };
      grab('.pkg-feature');
      grab('.pkg-feature__media');
      grab('.pkg-feature__body');
      grab('.carousel__item');
      grab('.carousel__img');
      grab('.portfolio-card');
      grab('.portfolio-card__img', (el) => ({ ar: getComputedStyle(el).aspectRatio }));
      grab('.intro__media');
      grab('.intro__media img');

      return out;
    });

    console.log(`\n=== ${TARGET} @ ${WIDTH}px ===`);
    console.log(`page ${report.viewport.w}px wide · ${report.height}px tall · overflow ${report.overflow}px`);
    console.log('sections:');
    report.sections.forEach((s) => console.log(`  ${s.h.toString().padStart(5)}px  ${s.cls}`));
    const suspicious = report.tallImages.filter((i) => i.h > 1.35 * report.viewport.h || i.h > 1200);
    console.log(`images: ${report.tallImages.length} loaded, ${suspicious.length} suspiciously tall`);
    suspicious.slice(0, 8).forEach((i) => console.log(`  !! ${i.w}x${i.h} (natural ${i.natural}) ${i.cls} ${i.src}`));
    Object.keys(report.components).forEach((sel) => {
      const rows = report.components[sel];
      console.log(`${sel}: ${rows.map((r) => `${r.w}x${r.h}${r.ar ? ' ar=' + r.ar : ''}`).join(' | ')}`);
    });
  } finally {
    await browser.close();
    app.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });

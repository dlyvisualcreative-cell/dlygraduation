'use strict';

/**
 * Visual/geometry audit for the public pages (Tahap 3B).
 * Measures real rendered boxes so "looks wrong" becomes numbers:
 * image aspect vs card aspect, text column width, overflow, stroke widths, etc.
 *
 *   node scripts/audit-visual.js [path] [--mobile]
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.AUDIT_PORT || 4510);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-audit';
const TARGET = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/pricelist';
const MOBILE = process.argv.includes('--mobile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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
    const page = await browser.newPage({
      viewport: MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 950 },
      isMobile: MOBILE, hasTouch: MOBILE, deviceScaleFactor: MOBILE ? 3 : 1
    });
    await page.goto(`${BASE}${TARGET}`, { waitUntil: 'load' });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(400);

    const report = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      const out = { page: {}, items: [] };

      const doc = document.documentElement;
      out.page.scrollWidth = doc.scrollWidth;
      out.page.clientWidth = doc.clientWidth;
      out.page.overflow = doc.scrollWidth - doc.clientWidth;
      out.page.height = doc.scrollHeight;

      // package cards
      document.querySelectorAll('.pkg-feature').forEach((card) => {
        const media = card.querySelector('.pkg-feature__media');
        const img = card.querySelector('.pkg-feature__img');
        const body = card.querySelector('.pkg-feature__body');
        const title = card.querySelector('.pkg-feature__title');
        const cta = card.querySelector('.pkg-feature__cta');
        const durations = card.querySelectorAll('.dur-card');
        const cs = getComputedStyle(card);
        const kids = body ? Array.from(body.children).map((el) => ({
          cls: el.className.toString().split(' ')[0] || el.tagName.toLowerCase(),
          ...box(el)
        })) : [];
        out.items.push({
          kind: 'package',
          card: box(card),
          cols: cs.gridTemplateColumns,
          radius: cs.borderRadius,
          border: cs.borderTopWidth + ' ' + cs.borderTopColor,
          media: media ? box(media) : null,
          imgNatural: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
          imgShown: img ? box(img) : null,
          imgFit: img ? getComputedStyle(img).objectFit : null,
          body: body ? box(body) : null,
          titleSize: title ? getComputedStyle(title).fontSize : null,
          durations: Array.from(durations).map((d) => ({ text: d.innerText.replace(/\n/g, ' | '), ...box(d) })),
          cta: cta ? { ...box(cta), text: cta.innerText.trim() } : null,
          benefitIcons: card.querySelectorAll('.benefit-list__icon svg').length,
          hasPrice: /Rp/.test(card.innerText),
          kids
        });
      });

      // portfolio cards
      document.querySelectorAll('.portfolio-card').forEach((card) => {
        const btn = card.querySelector('.portfolio-card__btn');
        const img = card.querySelector('.portfolio-card__img');
        const name = card.querySelector('.portfolio-card__name');
        const cs = getComputedStyle(card);
        out.items.push({
          kind: 'portfolio',
          card: box(card),
          radius: cs.borderRadius,
          shadow: cs.boxShadow.slice(0, 60),
          btn: btn ? box(btn) : null,
          imgNatural: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
          imgShown: img ? box(img) : null,
          aspect: img ? getComputedStyle(img).aspectRatio : null,
          objectFit: img ? getComputedStyle(img).objectFit : null,
          nameSize: name ? getComputedStyle(name).fontSize : null,
          caption: card.querySelector('.portfolio-card__caption')?.innerText.replace(/\n/g, ' | ')
        });
      });

      out.grid = (() => {
        const g = document.querySelector('.gallery-masonry') || document.querySelector('.portfolio-grid');
        if (!g) return null;
        const cs = getComputedStyle(g);
        return { cls: g.className, columns: cs.columnCount, gap: cs.columnGap, display: cs.display, grid: cs.gridTemplateColumns };
      })();

      out.filters = (() => {
        const f = document.querySelector('.filter-bar') || document.querySelector('.pricelist-toolbar');
        return f ? { ...box(f), text: f.innerText.replace(/\n/g, ' | ').slice(0, 160) } : null;
      })();

      return out;
    });

    console.log(`\n=== ${TARGET} ${MOBILE ? '(mobile 390)' : '(desktop 1440)'} ===`);
    console.log(`page: ${report.page.scrollWidth}px wide, overflow=${report.page.overflow}px, height=${report.page.height}px`);
    console.log('grid:', JSON.stringify(report.grid));
    console.log('filters:', report.filters ? `${report.filters.w}x${report.filters.h} "${report.filters.text}"` : 'none');
    report.items.slice(0, 8).forEach((it, i) => {
      if (it.kind === 'package') {
        console.log(`\n[pkg ${i}] card ${it.card.w}x${it.card.h} cols="${it.cols}" radius=${it.radius} border=${it.border}`);
        console.log(`  media ${it.media ? it.media.w + 'x' + it.media.h : '—'} | img ${it.imgShown ? it.imgShown.w + 'x' + it.imgShown.h : '—'} natural ${it.imgNatural}`);
        console.log(`  body ${it.body ? it.body.w + 'x' + it.body.h : '—'} | title ${it.titleSize} | benefitIcons=${it.benefitIcons} hasPrice=${it.hasPrice}`);
        console.log(`  durations: ${it.durations.map((d) => `${d.w}x${d.h}`).join(' ')}`);
        console.log(`  cta ${it.cta ? it.cta.w + 'x' + it.cta.h + ' "' + it.cta.text + '"' : '—'}`);
        console.log(`  img fit=${it.imgFit}`);
        console.log(`  body children: ${(it.kids || []).map((k) => `${k.cls} ${k.w}x${k.h}`).join(' | ')}`);
      } else {
        console.log(`\n[portfolio ${i}] card ${it.card.w}x${it.card.h} radius=${it.radius}`);
        console.log(`  img ${it.imgShown ? it.imgShown.w + 'x' + it.imgShown.h : '—'} natural ${it.imgNatural} aspect=${it.aspect} fit=${it.objectFit}`);
        console.log(`  name ${it.nameSize} | caption "${it.caption}"`);
      }
    });
    const aspectMismatch = report.items.filter((it) => it.kind === 'portfolio'
      && it.imgNatural && it.imgShown
      && Math.abs((Number(it.imgNatural.split('x')[0]) / Number(it.imgNatural.split('x')[1]))
        - (it.imgShown.w / it.imgShown.h)) > 0.25);
    if (aspectMismatch.length) {
      console.log(`\n!! ${aspectMismatch.length} portfolio image(s) cropped far from their natural ratio`);
    }
  } finally {
    await browser.close();
    app.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

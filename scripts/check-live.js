'use strict';

/**
 * Checks the PUBLISHED app (no local server): key pages must answer 200, must not
 * overflow horizontally, must not render an image taller than its container, and the
 * public design markers (natural-ratio portfolio tiles, pricelist shot/thumbs) must be
 * present. Read-only — it never writes to the app.
 *
 *   BASE=https://user.vibecoder.co.id/dlygraduation node scripts/check-live.js
 */

const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://dlyvisualcreative.vibecoder.co.id/dlygraduation';
const APP_ROOT = new URL(BASE).pathname.replace(/\/$/, '') + '/';
const PAGES = (process.env.PAGES || '/,/pricelist,/gallery,/paket/individual,/booking,/admin/login')
  .split(',').map((s) => s.trim()).filter(Boolean);

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${label}`); }
  else { failures.push(label); console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

/**
 * Tahap 4 — the PWA has to work on the PUBLISHED address, not just locally: manifest at the
 * app subpath, icons reachable, worker scope covering the app, and the three public pages
 * actually opening with the network switched off.
 */
async function checkPwa(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  try {
    const manRes = await page.request.get(`${BASE}/manifest.webmanifest`);
    const manifest = await manRes.json();
    ok('Live manifest is served with the right content type',
      (manRes.headers()['content-type'] || '').includes('manifest'));
    ok('Live manifest start_url/scope include the app subpath',
      manifest.start_url === APP_ROOT && manifest.scope === APP_ROOT,
      `${manifest.start_url} | ${manifest.scope}`);
    // `icon.src` already carries the app subpath, so resolve it against the ORIGIN.
    const origin = new URL(BASE).origin;
    for (const icon of manifest.icons) {
      const r = await page.request.get(origin + icon.src);
      ok(`Live icon ${icon.sizes} (${icon.purpose}) loads`, r.ok(), `${r.status()} ${icon.src}`);
    }

    await page.goto(BASE + '/', { waitUntil: 'load' });
    const sw = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const timeout = new Promise((r) => setTimeout(() => r(null), 20000));
      const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
      return { supported: true, scope: reg ? reg.scope : '' };
    });
    ok('Live service worker registers', sw.supported && Boolean(sw.scope), JSON.stringify(sw));
    ok('Live worker scope is the app subpath (not the whole domain)',
      !sw.scope || new URL(sw.scope).pathname === APP_ROOT, sw.scope);

    for (const url of ['/pricelist', '/gallery']) {
      await page.goto(BASE + url, { waitUntil: 'load' });
      await page.waitForTimeout(900);
    }
    const keys = await page.evaluate(async () => {
      const names = await caches.keys();
      const out = [];
      for (const n of names) {
        const c = await caches.open(n);
        (await c.keys()).forEach((req) => out.push(new URL(req.url).pathname));
      }
      return out;
    });
    ok('Live: public pages are cached', [APP_ROOT + 'pricelist', APP_ROOT + 'gallery'].every((p) => keys.includes(p)),
      keys.filter((k) => !k.includes('assets')).join(', '));
    ok('Live: no admin or client-portal URL is cached',
      !keys.some((k) => k.includes('/admin') || k.includes('/selection/')),
      keys.filter((k) => k.includes('/admin') || k.includes('/selection/')).join(', '));

    await context.setOffline(true);
    await page.goto(BASE + '/pricelist', { waitUntil: 'load' }).catch(() => {});
    ok('Live: pricelist opens offline', (await page.locator('.pkg-feature').count()) > 0);
    await page.goto(BASE + '/gallery', { waitUntil: 'load' }).catch(() => {});
    ok('Live: portfolio opens offline', (await page.locator('.portfolio-card').count()) > 0);
    await page.goto(BASE + '/', { waitUntil: 'load' }).catch(() => {});
    ok('Live: home opens offline', (await page.locator('body').count()) === 1);
    await context.setOffline(false);
  } finally {
    await page.close();
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const size of [{ width: 1440, height: 950, label: 'desktop' }, { width: 390, height: 844, label: 'mobile' }]) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        isMobile: size.label === 'mobile', hasTouch: size.label === 'mobile'
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      for (const url of PAGES) {
        const res = await page.goto(BASE + url, { waitUntil: 'load' });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1200);
        const info = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          tall: Array.from(document.images)
            .filter((i) => i.complete && i.naturalWidth)
            .map((i) => ({ h: Math.round(i.getBoundingClientRect().height), cls: String(i.className) }))
            .filter((i) => i.h > 1400).slice(0, 3),
          naturalTiles: document.querySelectorAll('.portfolio-card--natural').length,
          shots: document.querySelectorAll('.pkg-feature__shot').length
        }));
        ok(`[${size.label}] ${url} → ${res.status()}`, res.status() === 200, String(res.status()));
        ok(`[${size.label}] ${url} no horizontal overflow`, info.overflow <= 0, `${info.overflow}px`);
        ok(`[${size.label}] ${url} no giant image`, info.tall.length === 0, JSON.stringify(info.tall));
        if (url === '/gallery') ok(`[${size.label}] gallery uses natural-ratio tiles`, info.naturalTiles > 0, String(info.naturalTiles));
        if (url === '/pricelist') ok(`[${size.label}] pricelist renders the photo-led card`, info.shots > 0, String(info.shots));
      }
      ok(`[${size.label}] no JavaScript errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
      await context.close();
    }

    if (process.env.SKIP_PWA !== '1') await checkPwa(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

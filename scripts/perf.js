'use strict';

/**
 * Performance measurement harness (V10).
 *
 * Boots the app on its own port against a COPY of the database, then measures real
 * page loads in Chromium at desktop and mobile sizes, including CDP network throttling
 * (Slow 3G). Reports transfer bytes per resource type, request count and LCP/CLS.
 *
 *   node scripts/perf.js            # humans readable report
 *   node scripts/perf.js --json     # machine readable (for before/after diffing)
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PERF_PORT || 4460);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.PERF_DATA_DIR || '/tmp/dly-perf';
const JSON_OUT = process.argv.includes('--json');
const LABEL = process.env.PERF_LABEL || 'run';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  // Carry the derivative cache + dimension index over, like a real deploy where
  // DATA_DIR survives a restart. Without it every image is built during the measured
  // run and LCP looks like 16s for reasons that have nothing to do with the page.
  try {
    fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true });
  } catch (err) { /* cold cache run */ }
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
  const token = (db.prepare('SELECT token FROM photo_selections LIMIT 1').get() || {}).token || '';
  db.close();
  return { token };
}

const THROTTLE = {
  // Slow 3G-ish, what a client on a weak mobile connection sees.
  slow: { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 },
  fast4g: { offline: false, latency: 40, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (1 * 1024 * 1024) / 8 },
  none: null
};

async function measure(browser, { url, viewport, throttle, waitMs = 1200 }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: viewport.width < 500 ? 3 : 1,
    isMobile: viewport.width < 500,
    hasTouch: viewport.width < 500
  });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  const t = THROTTLE[throttle];
  if (t) {
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', t);
  }

  const byType = {};
  let requests = 0;
  let bytes = 0;
  page.on('response', async (res) => {
    requests += 1;
    const req = res.request();
    const type = req.resourceType();
    let len = 0;
    try {
      const buf = await res.body();
      len = buf.length;
    } catch (err) {
      const h = res.headers();
      len = Number(h['content-length'] || 0);
    }
    bytes += len;
    byType[type] = byType[type] || { n: 0, bytes: 0 };
    byType[type].n += 1;
    byType[type].bytes += len;
  });

  const started = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 }).catch(() => {});
  const loadMs = Date.now() - started;
  await sleep(waitMs);

  const metrics = await page.evaluate(() => new Promise((resolve) => {
    const out = { lcp: 0, cls: 0, dcl: 0, fcp: 0, lcpEl: '' };
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) out.dcl = Math.round(nav.domContentLoadedEventEnd);
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      if (fcp) out.fcp = Math.round(fcp.startTime);
    } catch (e) { /* ignore */ }
    let cls = 0;
    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => { if (!e.hadRecentInput) cls += e.value; });
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* ignore */ }
    let lcp = 0;
    // Which element was reported? Without this, a late-loading lazy image can look like
    // a terrible LCP when the real hero painted in 3s.
    let lcpEl = '';
    try {
      new PerformanceObserver((list) => {
        const last = list.getEntries().slice(-1)[0];
        if (last) {
          lcp = Math.round(last.startTime);
          const el = last.element;
          lcpEl = el
            ? `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]} ${last.size ? Math.round(last.size) + 'px²' : ''}`.trim()
            : '';
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) { /* ignore */ }
    setTimeout(() => {
      out.cls = Math.round(cls * 1000) / 1000;
      out.lcp = lcp;
      out.lcpEl = lcpEl;
      resolve(out);
    }, 600);
  }));

  const imgs = await page.evaluate(() => Array.from(document.images).map((i) => ({
    src: i.currentSrc || i.src,
    natural: `${i.naturalWidth}x${i.naturalHeight}`,
    shown: `${Math.round(i.getBoundingClientRect().width)}x${Math.round(i.getBoundingClientRect().height)}`,
    loading: i.loading,
    bytes: 0
  })));

  await context.close();

  return {
    url,
    viewport: `${viewport.width}x${viewport.height}`,
    throttle,
    requests,
    kb: Math.round(bytes / 1024),
    loadMs,
    ...metrics,
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { n: v.n, kb: Math.round(v.bytes / 1024) }])),
    oversizedImages: imgs.filter((i) => {
      const [nw] = String(i.natural).split('x').map(Number);
      const [sw] = String(i.shown).split('x').map(Number);
      return nw > 0 && sw > 0 && nw > sw * 2 + 40;
    }).map((i) => ({ src: path.basename(String(i.src).split('?')[0]), natural: i.natural, shown: i.shown }))
  };
}

async function main() {
  const { token } = prepare();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* wait */ }
    await sleep(250);
  }

  const browser = await chromium.launch();
  const cases = [
    { url: `${BASE}/`, viewport: { width: 1440, height: 900 }, throttle: 'none', name: 'Home desktop (no throttle)' },
    { url: `${BASE}/`, viewport: { width: 390, height: 844 }, throttle: 'none', name: 'Home mobile (no throttle)' },
    { url: `${BASE}/`, viewport: { width: 390, height: 844 }, throttle: 'slow', name: 'Home mobile (Slow 3G)', waitMs: 2500 },
    { url: `${BASE}/gallery`, viewport: { width: 390, height: 844 }, throttle: 'slow', name: 'Gallery mobile (Slow 3G)', waitMs: 2500 },
    { url: `${BASE}/pricelist`, viewport: { width: 390, height: 844 }, throttle: 'none', name: 'Pricelist mobile' }
  ];
  if (token) {
    cases.push({ url: `${BASE}/selection/${token}`, viewport: { width: 390, height: 844 }, throttle: 'slow', name: 'Portal mobile (Slow 3G, 45 photos)', waitMs: 4000 });
  }

  const results = [];
  for (const c of cases) {
    const r = await measure(browser, c);
    results.push({ name: c.name, ...r });
  }
  await browser.close();
  app.kill();

  if (JSON_OUT) {
    fs.writeFileSync(path.join(APP, 'scripts', `.perf-${LABEL}.json`), JSON.stringify(results, null, 2));
  }

  console.log(`\n=== PERF ${LABEL} ===`);
  for (const r of results) {
    console.log(`\n${r.name} [${r.viewport}${r.throttle !== 'none' ? ', ' + r.throttle : ''}]`);
    console.log(`  requests=${r.requests}  transfer=${r.kb}KB  load=${r.loadMs}ms  DCL=${r.dcl}ms  FCP=${r.fcp}ms  LCP=${r.lcp}ms  CLS=${r.cls}${r.lcpEl ? '  LCP=' + r.lcpEl : ''}`);
    console.log('  by type: ' + Object.entries(r.byType).map(([k, v]) => `${k} ${v.n}/${v.kb}KB`).join('  '));
    if (r.oversizedImages.length) {
      console.log(`  oversized images (natural > 2× displayed): ${r.oversizedImages.length}`);
      r.oversizedImages.slice(0, 6).forEach((i) => console.log(`    - ${i.src} ${i.natural} shown at ${i.shown}`));
    }
  }
  console.log('');
}

main().catch((err) => { console.error(err); process.exit(1); });

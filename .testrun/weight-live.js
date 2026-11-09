'use strict';
/* Rincian berat halaman LIVE (tanpa throttle): semua request + byte + durasi. */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'https://dlygraduation.com';
const TARGET = process.argv[2] || '/';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await ctx.newPage();
  const rows = [];
  const cache = {};
  page.on('response', async (res) => {
    const req = res.request();
    const h = res.headers();
    const len = Number(h['content-length'] || 0);
    cache[req.url()] = { cache: h['cache-control'] || '(none)', enc: h['content-encoding'] || '-', status: res.status() };
    rows.push({ url: req.url().replace(BASE, ''), type: req.resourceType(), len, ct: (h['content-type'] || '').split(';')[0] });
  });
  const t0 = Date.now();
  await page.goto(BASE + TARGET, { waitUntil: 'load', timeout: 90000 });
  const load = Date.now() - t0;
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource');
    return {
      ttfb: Math.round(nav.responseStart || 0),
      dcl: Math.round(nav.domContentLoadedEventEnd || 0),
      load: Math.round(nav.loadEventEnd || 0),
      htmlKB: Math.round((nav.transferSize || 0) / 1024),
      resKB: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
      resN: res.length,
      fonts: res.filter((r) => /fonts\.(googleapis|gstatic)/.test(r.name)).map((r) => r.name.replace('https://', '').slice(0, 60)),
      blockedByCss: res.filter((r) => r.initiatorType === 'link').length,
      imgTag: res.filter((r) => r.initiatorType === 'img').length
    };
  });
  console.log(`\n${TARGET} load=${load}ms  TTFB=${timing.ttfb}ms  DCL=${timing.dcl}ms  load=${timing.load}ms`);
  console.log(`HTML(br)=${timing.htmlKB}KB  resource=${timing.resN} (${timing.resKB}KB)  img=${timing.imgTag}  font=${timing.fonts.length}`);
  console.log(`cache-control:`);
  const uniq = Array.from(new Set(Object.entries(cache).map(([u, v]) => `${v.cache} | ${v.enc}`)));
  uniq.forEach((u) => console.log('   ' + u));
  console.log('requests:');
  rows.sort((a, b) => b.len - a.len).forEach((r) => {
    console.log(`  ${String(r.len).padStart(7)}B  ${r.type.padEnd(8)} ${r.url.slice(0, 76)}`);
  });
  if (timing.fonts.length) console.log('fonts:', timing.fonts);
  await browser.close();
})();

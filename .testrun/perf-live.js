'use strict';
/*
 * Ukur pengalaman nyata pengunjung di URL LIVE: navigasi HTML, jumlah & ukuran resource,
 * LCP, dan 5 resource paling berat. Mobile 390px, throttle 4G (1.6Mbps/750ms RTT).
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://dlygraduation.com';
const PAGES = ['/', '/pricelist', '/gallery', '/cara-order'];
const THROTTLE = !process.argv.includes('--fast');

(async () => {
  const browser = await chromium.launch();
  for (const p of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    if (THROTTLE) {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 150, downloadThroughput: Math.round(1.6 * 1024 * 1024 / 8), uploadThroughput: 750 * 1024 / 8
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    const resources = [];
    page.on('response', async (res) => {
      try {
        const req = res.request();
        const type = req.resourceType();
        const len = Number(res.headers()['content-length'] || 0);
        resources.push({ url: req.url(), type, status: res.status(), len });
      } catch (e) { /* abaikan */ }
    });
    const t0 = Date.now();
    await page.goto(BASE + p, { waitUntil: 'load', timeout: 90000 }).catch((e) => console.log('  goto error', e.message));
    const loadMs = Date.now() - t0;
    const m = await page.evaluate(() => new Promise((resolve) => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = performance.getEntriesByType('paint').map((x) => [x.name, Math.round(x.startTime)]);
      const res = performance.getEntriesByType('resource').map((r) => ({
        name: r.name.replace(location.origin, ''), type: r.initiatorType,
        dur: Math.round(r.duration), transfer: r.transferSize || 0, size: r.encodedBodySize || 0
      }));
      const finish = (lcp) => resolve({
        ttfb: Math.round(nav.responseStart || 0),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
        loadEvent: Math.round(nav.loadEventEnd || 0),
        paints, lcp: lcp ? Math.round(lcp.startTime) : null,
        count: res.length,
        transferKB: Math.round(res.reduce((s, r) => s + r.transfer, 0) / 1024),
        bytesKB: Math.round(res.reduce((s, r) => s + r.size, 0) / 1024),
        heaviest: res.sort((a, b) => b.transfer - a.transfer).slice(0, 5)
      });
      let lcp = null;
      try {
        new PerformanceObserver((list) => {
          const e = list.getEntries();
          lcp = e[e.length - 1];
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) { /* dukungan */ }
      setTimeout(() => finish(lcp), 1200);
    }));
    console.log(`\n=== ${p}  (load ${loadMs}ms${THROTTLE ? ', 4G + CPU 4x' : ''})`);
    console.log(`  TTFB=${m.ttfb}ms  DCL=${m.domContentLoaded}ms  load=${m.loadEvent}ms  LCP=${m.lcp}ms`);
    console.log(`  paint=${JSON.stringify(m.paints)}  resource=${m.count}  transfer=${m.transferKB}KB`);
    m.heaviest.forEach((h) => console.log(`   ${String(h.transfer).padStart(7)}B ${String(h.dur).padStart(5)}ms ${h.type.padEnd(8)} ${h.name.slice(0, 78)}`));
    await ctx.close();
  }
  await browser.close();
})();

'use strict';
/* AUDIT ONLY — ukur CLS, LCP, berat halaman di LIVE (mobile 4G & desktop), tanpa menulis apa pun. */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'https://dlygraduation.com';
const PAGES = ['/', '/gallery', '/pricelist'];

(async () => {
  const browser = await chromium.launch();
  for (const vp of [{ name: 'mobile 390', width: 390, height: 844, mobile: true, throttle: true },
    { name: 'desktop 1440', width: 1440, height: 900, mobile: false, throttle: false }]) {
    for (const p of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile });
      const page = await ctx.newPage();
      if (vp.throttle) {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false, latency: 150, downloadThroughput: Math.round(1.6 * 1024 * 1024 / 8), uploadThroughput: 750 * 1024 / 8
        });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      }
      const resp = [];
      page.on('response', (r) => {
        const h = r.headers();
        resp.push({ url: r.url(), type: r.request().resourceType(), len: Number(h['content-length'] || 0) });
      });
      await page.goto(BASE + p, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const m = await page.evaluate(() => new Promise((resolve) => {
        const nav = performance.getEntriesByType('navigation')[0] || {};
        let cls = 0;
        let lcp = 0;
        try {
          new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) cls += e.value; }))
            .observe({ type: 'layout-shift', buffered: true });
          new PerformanceObserver((l) => { const e = l.getEntries(); lcp = e[e.length - 1].startTime; })
            .observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (e) { /* dukungan */ }
        setTimeout(() => {
          const res = performance.getEntriesByType('resource');
          resolve({
            ttfb: Math.round(nav.responseStart || 0),
            fcp: Math.round((performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0),
            load: Math.round(nav.loadEventEnd || 0),
            lcp: Math.round(lcp),
            cls: Number(cls.toFixed(3)),
            bytesKB: Math.round(res.reduce((s, r) => s + (r.encodedBodySize || 0), 0) / 1024),
            n: res.length
          });
        }, 800);
      }));
      const imgs = resp.filter((r) => r.type === 'image').sort((a, b) => b.len - a.len);
      console.log(`${vp.name.padEnd(14)} ${p.padEnd(11)} TTFB=${String(m.ttfb).padStart(4)} FCP=${String(m.fcp).padStart(5)} LCP=${String(m.lcp).padStart(5)} load=${String(m.load).padStart(5)} CLS=${String(m.cls).padStart(6)} ${m.n} req / ${m.bytesKB}KB`);
      imgs.slice(0, 3).forEach((i) => console.log(`      gambar terbesar ${String(Math.round(i.len / 1024)).padStart(4)}KB ${i.url.replace(BASE, '').slice(0, 62)}`));
      await ctx.close();
    }
  }
  await browser.close();
})();

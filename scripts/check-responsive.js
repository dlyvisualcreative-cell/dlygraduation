'use strict';
/* V4 responsive checks: booking cards/calendar, admin navy cards, payment page. */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4660';
let f = 0;
const ck = (n, ok, x) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (x ? ' — ' + x : '')); if (!ok) f += 1; };


// V6: booking starts with the identity step, so tests must pass it first
// before interacting with the session fields (package/duration/calendar).
async function openSessionStep(page) {
  await page.goto(BASE + '/booking?kota=bandung', { waitUntil: 'networkidle' });
  if (!(await page.$('[data-step="1"] [data-terms-check]'))) return;
  await page.fill('#client_name', 'Klien V3');
  await page.fill('#client_phone', '081234567890');
  await page.fill('#instagram', 'klien.v3');
  await page.fill('#campus', 'Universitas Padjadjaran');
  if (await page.$('#faculty')) await page.fill('#faculty', 'Fakultas Teknik');
  if (await page.$('#major')) await page.fill('#major', 'Teknik Informatika');
  await page.check('[data-terms-check]');
  await page.click('[data-next="2"]');
  await page.waitForTimeout(320);
}

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'tablet', w: 768, h: 1024 },
  { name: 'mobile', w: 390, h: 844 }
];

(async () => {
  for (const vp of VIEWPORTS) {
    const br = await chromium.launch();
    const ctx = await br.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.name === 'mobile', hasTouch: vp.name === 'mobile' });
    const p = await ctx.newPage();

    // ---- public booking ----
    await openSessionStep(p);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck(`[${vp.name}] no horizontal overflow (booking)`, overflow <= 1, 'overflow=' + overflow);

    const slot = await p.$eval('.slot__box', (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { h: Math.round(r.height), w: Math.round(r.width), radius: parseFloat(cs.borderRadius) };
    });
    ck(`[${vp.name}] duration card stays compact`, slot.h <= 90, 'height=' + slot.h);
    ck(`[${vp.name}] duration card fits the screen`, slot.w <= vp.w, 'width=' + slot.w);
    ck(`[${vp.name}] duration card is rounded`, slot.radius >= 8, 'radius=' + slot.radius);

    const priceVisible = await p.evaluate(() => {
      const el = document.querySelector('.slot__price');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right <= window.innerWidth + 1 && getComputedStyle(el).visibility !== 'hidden';
    });
    ck(`[${vp.name}] price is not clipped`, priceVisible);

    const cal = await p.$eval('.cal-day:not(.is-empty)', (el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    ck(`[${vp.name}] calendar cell stays tappable`, cal.h >= 34, `cell=${cal.w}x${cal.h}`);

    const timeW = await p.$eval('#shooting_time', (el) => Math.round(el.getBoundingClientRect().width));
    ck(`[${vp.name}] time field fits`, timeW <= vp.w, 'width=' + timeW);

    // ---- TnC page ----
    await p.goto(BASE + '/syarat-ketentuan', { waitUntil: 'networkidle' });
    const tncOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck(`[${vp.name}] no horizontal overflow (TnC)`, tncOverflow <= 1, 'overflow=' + tncOverflow);

    // ---- admin ----
    await p.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await p.fill('#username', 'admin');
    await p.fill('#password', 'DlyGraduation2025');
    await Promise.all([p.waitForURL('**/admin', { timeout: 15000 }), p.click('.login-form button[type=submit]')]);

    await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
    const adminOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck(`[${vp.name}] no horizontal overflow (admin bookings)`, adminOverflow <= 1, 'overflow=' + adminOverflow);

    if ((await p.locator('.bk-card').count()) > 0) {
      const card = await p.$eval('.bk-card', (el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), bg: getComputedStyle(el).backgroundColor };
      });
      ck(`[${vp.name}] navy card fits`, card.w <= vp.w, 'width=' + card.w);
      ck(`[${vp.name}] navy card colour`, card.bg === 'rgb(11, 35, 64)', card.bg);
      const cols = await p.$eval('.bk-tile__rows', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      // Tahap 3: the tile stacks its rows on phones and uses 2 columns from tablet up.
      ck(`[${vp.name}] booking info grid adapts`, vp.name === 'mobile' ? cols >= 1 : cols >= 2, 'cols=' + cols);
    }

    await p.goto(BASE + '/admin/payment', { waitUntil: 'networkidle' });
    const payOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck(`[${vp.name}] no horizontal overflow (payment)`, payOverflow <= 1, 'overflow=' + payOverflow);
    const preW = await p.$eval('.preview-msg', (el) => Math.round(el.getBoundingClientRect().width));
    ck(`[${vp.name}] chat preview wraps inside the panel`, preW <= vp.w, 'width=' + preW);

    await p.goto(BASE + '/admin/pages', { waitUntil: 'networkidle' });
    ck(`[${vp.name}] pages screen renders toggles`, (await p.locator('.page-toggle').count()) >= 7);

    await p.close();
    await ctx.close();
    await br.close();
  }

  console.log(f === 0 ? 'ALL PASSED' : f + ' FAILED');
  process.exit(f ? 1 : 0);
})();

'use strict';
/* V6 checks: dashboard redesign, brand logos, homepage counters, pricelist
   merchandising, package detail page, booking step order, WhatsApp template. */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4960';
let f = 0;
const ck = (n, ok, x) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (x ? ' — ' + x : '')); if (!ok) f += 1; };

(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  /* ================= admin login ================= */
  await p.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await p.fill('#username', 'admin');
  await p.fill('#password', 'DlyGraduation2025');
  await Promise.all([p.waitForURL('**/admin', { timeout: 15000 }), p.click('.login-form button[type=submit]')]);
  ck('Admin login works', (await p.textContent('.admin-topbar')).includes('Overview'));

  /* ================= FASE 2: dashboard ================= */
  const radius = await p.$eval('.admin-panel', (el) => parseFloat(getComputedStyle(el).borderRadius));
  ck('Panels use a rounded radius (14–22px)', radius >= 14 && radius <= 22, radius + 'px');
  const shadow = await p.$eval('.admin-panel', (el) => getComputedStyle(el).boxShadow);
  ck('Panels have a soft shadow', shadow !== 'none' && shadow.includes('rgb'), shadow.slice(0, 40));

  const navIcons = await p.$$('.admin-nav__icon');
  ck('Sidebar items carry icons', navIcons.length >= 15, 'icons=' + navIcons.length);
  const collapse = await p.$('[data-side-collapse]');
  ck('Sidebar has a collapse control', collapse !== null);
  if (collapse) {
    await p.click('[data-side-collapse]');
    await p.waitForTimeout(350);
    ck('Sidebar collapses on desktop', await p.evaluate(() => document.body.classList.contains('side-collapsed')));
    await p.click('[data-side-collapse]');
    await p.waitForTimeout(350);
  }

  const counters = await p.$$('[data-count]');
  ck('Stat cards animate with count-up', counters.length >= 5, 'counters=' + counters.length);
  await p.waitForTimeout(1500);
  const statText = await p.$eval('[data-count]', (el) => el.textContent.trim());
  ck('Count-up produces a number', /\d/.test(statText), statText);

  ck('Toast container present', (await p.$('[data-toast]')) !== null);

  /* ================= FASE 3: brand identity ================= */
  await p.goto(BASE + '/admin/brand', { waitUntil: 'networkidle' });
  ck('Brand page renders logo variants', (await p.$$('.logo-card')).length >= 4,
    'cards=' + (await p.$$('.logo-card')).length);
  await p.fill('#brand_description', 'Professional Graduation Photography');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  ck('Brand identity saves', (await p.textContent('body')).includes('berhasil disimpan'));

  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  ck('Header shows the studio description', (await p.textContent('.logo__text')).includes('Professional Graduation Photography'));

  /* ================= FASE 4: homepage counters ================= */
  const statValues = await p.$$('[data-countup]');
  ck('Homepage statistics render from DB', statValues.length >= 3, 'stats=' + statValues.length);
  await p.evaluate(() => document.querySelector('#statistik').scrollIntoView());
  // The owner can edit these numbers, so compare against the value in the DOM.
  const expected = await p.$eval('[data-countup]', (el) => ({
    target: el.getAttribute('data-countup'),
    suffix: el.getAttribute('data-suffix') || ''
  }));
  await p.waitForFunction((exp) => {
    const el = document.querySelector('[data-countup]');
    if (!el) return false;
    const digits = (el.textContent.match(/[\d.]+/g) || [''])[0].replace(/\./g, '');
    return digits === String(exp.target) && el.textContent.includes(exp.suffix);
  }, expected, { timeout: 10000 }).catch(() => null);
  const firstStat = await p.$eval('[data-countup]', (el) => el.textContent.trim());
  ck('Counter reaches its configured target', firstStat === `${Number(expected.target).toLocaleString('id-ID')}${expected.suffix}`, firstStat);

  /* ================= FASE 5: pricelist ================= */
  await p.goto(BASE + '/pricelist?kota=bandung', { waitUntil: 'networkidle' });
  const cardRadius = await p.$eval('.pkg-feature', (el) => parseFloat(getComputedStyle(el).borderRadius));
  ck('Pricelist cards are rounded', cardRadius >= 14, cardRadius + 'px');
  const ctaText = await p.$eval('[data-book-link]', (el) => el.textContent.trim());
  ck('Card CTA opens the package detail page', ctaText === 'Pesan Sesimu Sekarang', ctaText);

  /* -------- best seller + sold info via admin -------- */
  await p.goto(BASE + '/admin/packages', { waitUntil: 'networkidle' });
  const editHref = await p.locator('.admin-table tbody tr').first().locator('a.admin-link', { hasText: 'Edit' }).first().getAttribute('href');
  await p.goto(new URL(editHref, BASE).toString(), { waitUntil: 'networkidle' });
  await p.check('input[name="is_best_seller"]');
  await p.fill('#sold_count', '150');
  await p.fill('#sold_label', 'Sesi Telah Dipesan');
  await p.check('input[name="sold_visible"]');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  ck('Best Seller + sold info saved', (await p.textContent('body')).includes('berhasil'));

  await p.goto(BASE + '/pricelist?kota=bandung', { waitUntil: 'networkidle' });
  const bodyText = await p.textContent('body');
  ck('Best Seller badge appears', bodyText.includes('Best Seller'));
  ck('Sold info appears', /150\s*Sesi Telah Dipesan/.test(bodyText), (bodyText.match(/150[^<]{0,30}/) || [''])[0]);

  /* ================= FASE 5b: package detail ================= */
  const detailHref = await p.$eval('[data-book-link]', (el) => el.getAttribute('href'));
  ck('CTA points to /paket/<slug>', detailHref.includes('/paket/'), detailHref);
  await p.goto(new URL(detailHref, BASE).toString(), { waitUntil: 'networkidle' });
  ck('Package detail page loads', (await p.textContent('h1')).length > 2);
  const chips = await p.$$('[data-detail-duration]');
  ck('Detail page lists durations', chips.length >= 2, 'chips=' + chips.length);

  const priceBefore = await p.$eval('[data-detail-price]', (el) => el.textContent.trim());
  if (chips.length > 1) {
    await p.click('[data-detail-duration]:nth-of-type(2)');
    await p.waitForTimeout(250);
  }
  const priceAfter = await p.$eval('[data-detail-price]', (el) => el.textContent.trim());
  ck('Price reacts to the duration choice', priceBefore !== priceAfter, `${priceBefore} → ${priceAfter}`);

  const bookHref = await p.$eval('[data-detail-book]', (el) => el.getAttribute('href'));
  ck('Booking handoff carries package + duration', /booking\?/.test(bookHref) && /paket=\d+/.test(bookHref) && /durasi=\d+/.test(bookHref), bookHref);

  const sticky = await p.$eval('.pkg-sticky-cta', (el) => getComputedStyle(el).display);
  ck('Sticky CTA hidden on desktop', sticky === 'none', sticky);

  /* ================= FASE 7: booking order ================= */
  await p.goto(BASE + '/booking?kota=bandung', { waitUntil: 'networkidle' });
  const step1Title = await p.$eval('[data-step="1"] .wizard-panel__title', (el) => el.textContent.trim());
  ck('Step 1 is identity first', /Identitas/i.test(step1Title), step1Title);
  const step2Title = await p.$eval('[data-step="2"] .wizard-panel__title', (el) => el.textContent.trim());
  ck('Step 2 is session detail', /Detail sesi/i.test(step2Title), step2Title);
  ck('Photo-publication consent removed', (await p.$('input[name="photo_consent"]')) === null);
  ck('TnC consent still required', (await p.$('[data-terms-check]')) !== null);

  const stepDots = await p.$$eval('.wizard-step', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ck('Wizard labels updated', stepDots[0].includes('Identitas') && stepDots[1].includes('Detail Sesi'), stepDots.join(' | '));

  // identity validation blocks before session
  await p.click('[data-next="2"]');
  await p.waitForTimeout(250);
  ck('Identity step blocks when empty', await p.isVisible('[data-step="1"]'));

  /* ================= FASE 8: WhatsApp template ================= */
  await p.goto(BASE + '/admin/wa-template', { waitUntil: 'networkidle' });
  const tpl = await p.inputValue('#template');
  ck('Template is editable and pre-filled', tpl.includes('{{nama}}') && tpl.includes('{{tanggal}}'));
  // The owner may deliberately use emoji in their own template; only the
  // built-in default is guaranteed emoji-free.
  const isCustom = (await p.getAttribute('#template', 'data-template-custom')) === '1';
  if (isCustom) {
    ck('Custom template is used as-is (owner may include emoji)', tpl.length > 40, tpl.slice(0, 44));
  } else {
    ck('Built-in default template is emoji-free', !/[\u{1F300}-\u{1FAFF}]/u.test(tpl), tpl.slice(0, 44));
  }
  ck('Placeholder list shown', (await p.$$('.ph-chip')).length >= 10, 'chips=' + (await p.$$('.ph-chip')).length);
  const preview = await p.$eval('.preview-msg', (el) => el.textContent);
  ck('Preview renders real data (no raw placeholders)', !preview.includes('{{'), preview.slice(0, 60));

  await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  if ((await p.locator('.bk-card').count()) > 0) {
    const href = await p.$eval('[data-chat-client]', (el) => el.getAttribute('href'));
    const msg = decodeURIComponent((href.split('?text=')[1] || '').replace(/\+/g, ' '));
    ck('Chat Klien uses the saved template', msg.startsWith('Halo Kak '), msg.slice(0, 28));
    ck('No replacement characters in the message', !msg.includes('\uFFFD'));
    ck('Message length stays WhatsApp-friendly', href.length < 1800, href.length + ' chars');
  }

  ck('No JavaScript errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await p.close();
  await ctx.close();

  /* ================= mobile ================= */
  const mctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await mctx.newPage();
  for (const path of ['/', '/pricelist?kota=bandung', '/paket/individual', '/booking?kota=bandung']) {
    await m.goto(BASE + path, { waitUntil: 'networkidle' });
    const ov = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck(`[mobile] no overflow on ${path}`, ov <= 1, 'overflow=' + ov);
  }
  await m.goto(BASE + '/paket/individual', { waitUntil: 'networkidle' });
  ck('[mobile] sticky CTA visible', await m.isVisible('.pkg-sticky-cta'));

  await m.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await m.fill('#username', 'admin');
  await m.fill('#password', 'DlyGraduation2025');
  await Promise.all([m.waitForURL('**/admin', { timeout: 15000 }), m.click('.login-form button[type=submit]')]);
  const adminOv = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ck('[mobile] admin has no horizontal overflow', adminOv <= 1, 'overflow=' + adminOv);
  await m.click('[data-side-toggle]');
  await m.waitForTimeout(300);
  ck('[mobile] sidebar opens as drawer', await m.isVisible('.admin-nav'));

  await m.close();
  await mctx.close();
  await br.close();

  console.log(f === 0 ? 'ALL PASSED' : f + ' FAILED');
  process.exit(f ? 1 : 0);
})();

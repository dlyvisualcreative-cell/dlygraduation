'use strict';
/**
 * V8 acceptance suite — testimonials (rating order), package benefits with icons,
 * and the editorial portfolio (cover info, multi-photo lightbox, city visibility).
 *
 * Run against a throwaway DB copy:
 *   rm -rf /tmp/t && mkdir -p /tmp/t && cp data/app.sqlite* /tmp/t/
 *   DLY_DATA_DIR=/tmp/t PORT=4420 node server.js &
 *   BASE=http://127.0.0.1:4420 node scripts/check-v8.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:4420';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';

let pass = 0;
const failures = [];
function ck(label, ok, detail) {
  if (ok) { pass += 1; console.log('PASS  ' + label); }
  else { failures.push(label); console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

// A 3×3 PNG is enough for upload paths that only need a valid image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const tmpPng = path.join(require('os').tmpdir(), 'dly-v8-test.png');
fs.writeFileSync(tmpPng, PNG);

const TEST_TS = Date.now().toString().slice(-6);
const TST_NAME = 'Klien Uji V8 ' + TEST_TS;
const PF_NAME = 'Uji Portfolio ' + TEST_TS;
const BENEFIT_TEXT = 'Benefit Uji ' + TEST_TS;
const BENEFIT_EDITED = 'Benefit Uji Edit ' + TEST_TS;

async function login(page) {
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type="submit"]')]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  // Delete forms ask for confirmation; accept it (headless would otherwise dismiss).
  page.on('dialog', (d) => d.accept());

  await login(page);
  ck('Admin login works', page.url().includes('/admin'), page.url());

  /* ================================================================
     1. TESTIMONI — rating 1..5, urutan bintang, hover preview, edit
     ================================================================ */
  await page.goto(BASE + '/admin/testimonials/new', { waitUntil: 'networkidle' });
  const adminStarValues = await page.$$eval('.star-picker__item input', (els) => els.map((e) => Number(e.value)));
  ck('Admin star picker has 5 options', adminStarValues.length === 5, String(adminStarValues.length));

  const adminStarLeftToRight = await page.$$eval('.star-picker__item', (els) =>
    els.map((el) => ({ value: Number(el.querySelector('input').value), x: Math.round(el.getBoundingClientRect().x) }))
      .sort((a, b) => a.x - b.x).map((o) => o.value));
  ck('Admin star order is 1→5 left to right', adminStarLeftToRight.join(',') === '1,2,3,4,5', adminStarLeftToRight.join(','));

  await page.fill('#client_name', TST_NAME);
  await page.fill('#campus', 'Universitas Uji V8');
  await page.fill('#quote', 'Testimoni otomatis untuk pengujian rating 1 sampai 5 bintang.');
  // pick 5 stars by clicking the 5th-from-left star
  await page.$eval('.star-picker__item input[value="5"]', (el) => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('.admin-form__actions button[type="submit"]')
  ]);
  ck('Testimonial created from admin', (await page.textContent('body')).includes('Testimoni berhasil ditambahkan'));

  const editHref = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.admin-table tbody tr'))
      .find((tr) => tr.textContent.includes('Klien Uji V8'));
    return row ? row.querySelector('a.admin-link').getAttribute('href') : null;
  });
  ck('New testimonial is listed with an edit link', Boolean(editHref), String(editHref));

  // Loop the rating 1..5 through the admin form and assert the public rendering.
  for (const rating of [5, 4, 3, 2, 1]) {
    await page.goto(BASE + editHref, { waitUntil: 'networkidle' });
    await page.$eval(`.star-picker__item input[value="${rating}"]`, (el) => {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('.admin-form__actions button[type="submit"]')
    ]);

    await page.goto(BASE + '/ulasan', { waitUntil: 'networkidle' });
    const card = await page.evaluate((name) => {
      const fig = Array.from(document.querySelectorAll('.testimonial'))
        .find((f) => f.textContent.includes(name));
      if (!fig) return null;
      const stars = Array.from(fig.querySelectorAll('.rating__star'));
      return {
        total: stars.length,
        filled: stars.filter((s) => s.classList.contains('is-on')).length,
        label: fig.querySelector('.rating') ? fig.querySelector('.rating').getAttribute('aria-label') : '',
        campus: (fig.querySelector('.testimonial__campus') || {}).textContent || '',
        date: (fig.querySelector('.testimonial__date') || {}).textContent || '',
        radius: getComputedStyle(fig).borderTopLeftRadius,
        shadow: getComputedStyle(fig).boxShadow
      };
    }, TST_NAME);

    ck(`Rating ${rating} renders 5 stars with ${rating} filled`,
      card && card.total === 5 && card.filled === rating,
      card ? `${card.filled}/${card.total}` : 'card missing');
    ck(`Rating ${rating} aria-label is "${rating} dari 5 bintang"`,
      card && card.label === `${rating} dari 5 bintang`, card ? card.label : '-');
    if (rating === 3) {
      ck('Testimonial card shows campus', Boolean(card && card.campus.includes('Universitas Uji V8')), card && card.campus);
      ck('Testimonial card shows a date', Boolean(card && /\d{4}/.test(card.date)), card && card.date);
      ck('Testimonial card is rounded (≥12px)', Boolean(card && parseFloat(card.radius) >= 12), card && card.radius);
      ck('Testimonial card has a soft shadow', Boolean(card && card.shadow && card.shadow !== 'none'), card && card.shadow);
    }
  }

  // Public form: star order + hover preview + click selection
  const token = process.env.TST_TOKEN || (await (async () => {
    await page.goto(BASE + '/admin/testimonial-link', { waitUntil: 'networkidle' });
    return page.inputValue('#testimonial-link').then((v) => v.split('/testimoni/')[1]);
  })());
  await page.goto(`${BASE}/testimoni/${token}`, { waitUntil: 'networkidle' });
  const publicOrder = await page.$$eval('.tst-star', (els) =>
    els.map((el) => ({ value: Number(el.querySelector('input').value), x: Math.round(el.getBoundingClientRect().x) }))
      .sort((a, b) => a.x - b.x).map((o) => o.value));
  ck('Public star order is 1→5 left to right', publicOrder.join(',') === '1,2,3,4,5', publicOrder.join(','));

  const goldBefore = await page.$$eval('.tst-star span[aria-hidden]', (els) => els.filter((e) => getComputedStyle(e).color === 'rgb(217, 169, 63)').length);
  ck('No stars are filled before choosing', goldBefore === 0, String(goldBefore));

  const third = page.locator('.tst-star:has(input[value="3"])');
  await third.hover();
  await page.waitForTimeout(220);
  const hoverState = await page.$$eval('.tst-star', (els) =>
    els.map((el) => ({
      value: Number(el.querySelector('input').value),
      gold: getComputedStyle(el.querySelector('span[aria-hidden]')).color === 'rgb(217, 169, 63)'
    })).sort((a, b) => a.value - b.value));
  ck('Hover preview fills 1..3 only',
    hoverState.filter((s) => s.gold).map((s) => s.value).join(',') === '1,2,3',
    hoverState.filter((s) => s.gold).map((s) => s.value).join(','));

  await page.click('.tst-star:has(input[value="4"]) span[aria-hidden]');
  await page.waitForTimeout(200);
  const clicked = await page.$eval('.tst-star:has(input[value="4"]) input', (el) => el.checked);
  ck('Clicking the 4th star selects rating 4', clicked === true);
  const readout = await page.textContent('[data-star-readout]');
  ck('Ratings readout mirrors the chosen value', readout.includes('4 dari 5'), readout);

  /* ================================================================
     2. BENEFIT PAKET — ikon default, icon picker, tampil di 2 halaman
     ================================================================ */
  await page.goto(BASE + '/admin/packages', { waitUntil: 'networkidle' });
  const pkgEdit = await page.getAttribute('.admin-table a.admin-link[href*="/edit"]', 'href');
  await page.goto(BASE + pkgEdit, { waitUntil: 'networkidle' });

  const rowsBefore = await page.locator('[data-benefit-row]').count();
  ck('Benefit editor starts with the migrated rows', rowsBefore >= 1, String(rowsBefore));
  ck('Icon picker offers a full library', (await page.locator('.icon-picker__opt').count()) >= 17,
    String(await page.locator('.icon-picker__opt').count()));

  // First migrated row must default to the check icon
  const firstIcon = await page.$eval('[data-benefit-row] input[type="radio"]:checked', (el) => el.value);
  ck('Migrated benefits default to the check icon', firstIcon === 'check', firstIcon);

  // Show the picker grid for the new row and pick "clock"
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    (async () => {
      await page.click('[data-add-benefit]');
      const rows = page.locator('[data-benefit-row]');
      const last = rows.nth(await rows.count() - 1);
      await last.locator('input[name^="benefit_text_"]').fill(BENEFIT_TEXT);
      await last.locator('input[name^="benefit_order_"]').fill('1');
      await last.locator('.icon-picker').evaluate((el) => { el.open = true; });
      await last.locator('input[value="clock"]').check();
      await page.click('.admin-form__actions button[type="submit"]');
    })()
  ]);
  ck('Benefit saved', (await page.textContent('body')).includes('berhasil diperbarui'));

  await page.goto(BASE + pkgEdit, { waitUntil: 'networkidle' });
  const benefitRowCount = await page.locator('[data-benefit-row]').count();
  ck('New benefit row persisted', benefitRowCount === rowsBefore + 1, String(benefitRowCount));

  const clockIconStored = await page.evaluate((text) => {
    const row = Array.from(document.querySelectorAll('[data-benefit-row]'))
      .find((r) => r.querySelector('input[name^="benefit_text_"]').value === text);
    if (!row) return null;
    const checked = row.querySelector('input[type="radio"]:checked');
    return checked ? checked.value : null;
  }, BENEFIT_TEXT);
  ck('Icon choice is stored as "clock"', clockIconStored === 'clock', String(clockIconStored));

  // Visible on pricelist AND package detail (same data source)
  await page.goto(BASE + '/pricelist', { waitUntil: 'networkidle' });
  const onPricelist = await page.evaluate((text) => {
    const li = Array.from(document.querySelectorAll('.benefit-list li'))
      .find((el) => el.textContent.includes(text));
    if (!li) return null;
    const svg = li.querySelector('.benefit-list__icon svg');
    return { hasIcon: Boolean(svg), circle: Boolean(svg && svg.innerHTML.includes('circle')) };
  }, BENEFIT_TEXT);
  ck('Benefit appears on the pricelist', Boolean(onPricelist), 'not found');
  ck('Benefit is rendered with an icon inside a circle', Boolean(onPricelist && onPricelist.hasIcon && onPricelist.circle),
    JSON.stringify(onPricelist));

  const noDashBullets = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.benefit-list li'))
      .every((li) => !/^\s*[—–-]/.test(li.textContent.trim())));
  ck('Benefits no longer use a dash bullet', noDashBullets === true);

  const pkgHref = await page.getAttribute('.pkg-feature__title a', 'href');
  await page.goto(BASE + pkgHref, { waitUntil: 'networkidle' });
  const onDetail = await page.evaluate((text) =>
    Boolean(Array.from(document.querySelectorAll('.benefit-list li')).find((el) => el.textContent.includes(text))), BENEFIT_TEXT);
  ck('The same benefit appears on the package detail page', onDetail === true);

  // Edit + order + deactivate
  await page.goto(BASE + pkgEdit, { waitUntil: 'networkidle' });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    (async () => {
      const rows = page.locator('[data-benefit-row]');
      const target = rows.filter({ has: page.locator(`input[value="${BENEFIT_TEXT}"]`) });
      await target.locator('input[name^="benefit_text_"]').fill(BENEFIT_EDITED);
      // Move it to the top: it gets Urutan 1, the current first row moves down to 9.
      await target.locator('input[name^="benefit_order_"]').fill('1');
      await rows.nth(0).locator('input[name^="benefit_order_"]').fill('9');
      await page.click('.admin-form__actions button[type="submit"]');
    })()
  ]);
  await page.goto(BASE + '/pricelist', { waitUntil: 'networkidle' });
  const orderCheck = await page.evaluate((text) => {
    const card = Array.from(document.querySelectorAll('.pkg-feature'))
      .find((el) => el.textContent.includes(text));
    const list = card ? card.querySelector('.benefit-list') : null;
    if (!list) return null;
    const texts = Array.from(list.querySelectorAll('li')).map((li) => li.textContent.trim());
    return { first: texts[0], has: texts.some((t) => t.includes(text)) };
  }, BENEFIT_EDITED);
  ck('Edited benefit text reaches the website', Boolean(orderCheck && orderCheck.has), JSON.stringify(orderCheck));
  ck('Reordering by the Urutan column moves the benefit first', Boolean(orderCheck && orderCheck.first.includes(BENEFIT_EDITED)), orderCheck && orderCheck.first);

  await page.goto(BASE + pkgEdit, { waitUntil: 'networkidle' });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    (async () => {
      const rows = page.locator('[data-benefit-row]');
      const target = rows.filter({ has: page.locator(`input[value="${BENEFIT_EDITED}"]`) });
      await target.locator('input[name^="benefit_active_"]').uncheck();
      await page.click('.admin-form__actions button[type="submit"]');
    })()
  ]);
  await page.goto(BASE + '/pricelist', { waitUntil: 'networkidle' });
  const hiddenNow = await page.evaluate((text) =>
    !Array.from(document.querySelectorAll('.benefit-list li')).some((el) => el.textContent.includes(text)), BENEFIT_EDITED);
  ck('Inactive benefit is hidden from the website', hiddenNow === true);

  // Cleanup: delete the test benefit row
  await page.goto(BASE + pkgEdit, { waitUntil: 'networkidle' });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    (async () => {
      const rows = page.locator('[data-benefit-row]');
      const target = rows.filter({ has: page.locator(`input[value="${BENEFIT_EDITED}"]`) });
      await target.locator('[data-remove-benefit]').click();
      await page.click('.admin-form__actions button[type="submit"]');
    })()
  ]);
  await page.goto(BASE + pkgEdit, { waitUntil: 'networkidle' });
  const cleanedRows = await page.locator('[data-benefit-row]').count();
  ck('Test benefit removed', cleanedRows === rowsBefore, `${cleanedRows} vs ${rowsBefore}`);

  /* ================================================================
     3. PORTFOLIO — cover info, kota tersembunyi, galeri, lightbox
     ================================================================ */
  await page.goto(BASE + '/admin/portfolio/new', { waitUntil: 'networkidle' });
  await page.fill('#client_name', PF_NAME);
  await page.fill('#client_degree', 'S.Kom.');
  await page.fill('#campus', 'Institut Uji V8');
  await page.fill('#taken_at', '2026-10-12');
  await page.selectOption('#category', 'individual');
  const cityOption = await page.$eval('#city_id option:nth-child(2)', (el) => el.value).catch(() => '');
  if (cityOption) await page.selectOption('#city_id', cityOption);
  await page.fill('#description', 'Portfolio otomatis untuk pengujian V8.');
  await page.setInputFiles('#image_file', tmpPng);
  await page.check('input[name="is_featured"]');
  await page.check('input[name="is_active"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('.admin-form__actions button[type="submit"]')
  ]);
  ck('Portfolio created', (await page.textContent('body')).includes('Portfolio berhasil ditambahkan'));
  ck('New portfolio opens its edit page', page.url().includes('/admin/portfolio/') && page.url().includes('/edit'), page.url());

  const pfEditUrl = page.url();

  // Kota tetap tersimpan di database/dashboard
  await page.goto(BASE + '/admin/portfolio', { waitUntil: 'networkidle' });
  const adminRow = await page.evaluate((name) => {
    const card = Array.from(document.querySelectorAll('.portfolio-admin-card'))
      .find((c) => c.textContent.includes(name));
    return card ? card.textContent.replace(/\s+/g, ' ') : null;
  }, PF_NAME);
  ck('Admin list still stores/shows the city', Boolean(adminRow && !adminRow.includes('Tanpa kota')), adminRow);
  ck('Admin list shows featured badge', Boolean(adminRow && adminRow.includes('Unggulan')), adminRow);

  // Cover: nama + gelar, kampus, tanggal — tanpa kota
  await page.goto(BASE + '/gallery', { waitUntil: 'networkidle' });
  const cover = await page.evaluate((name) => {
    const card = Array.from(document.querySelectorAll('.portfolio-card'))
      .find((c) => c.textContent.includes(name));
    if (!card) return null;
    const cs = getComputedStyle(card);
    return {
      text: card.textContent.replace(/\s+/g, ' ').trim(),
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow,
      height: Math.round(card.getBoundingClientRect().height),
      lightbox: Boolean(card.querySelector('[data-lightbox]'))
    };
  }, PF_NAME);
  ck('Portfolio cover found on the gallery page', Boolean(cover), 'missing');
  ck('Cover shows "Nama, Gelar"', Boolean(cover && cover.text.includes(PF_NAME + ', S.Kom.')), cover && cover.text);
  ck('Cover shows the campus', Boolean(cover && cover.text.includes('Institut Uji V8')), cover && cover.text);
  ck('Cover shows the shoot date', Boolean(cover && cover.text.includes('12 Oktober 2026')), cover && cover.text);
  ck('Cover does NOT show the city', Boolean(cover && !cover.text.includes('Bandung')), cover && cover.text);
  ck('Portfolio card is rounded (≥12px)', Boolean(cover && parseFloat(cover.radius) >= 12), cover && cover.radius);
  ck('Portfolio card has a soft shadow', Boolean(cover && cover.shadow && cover.shadow !== 'none'), cover && cover.shadow);

  // Revisi carousel (dokumen revisi 11/12): gallery publik = SATU jalur carousel
  // horizontal, bukan grid/masonry. Kartu memakai crop portrait 4:5.
  const galleryRow = await page.evaluate(() => {
    const root = document.querySelector('.pf-carousel--gallery');
    const cards = root ? Array.from(root.querySelectorAll('.portfolio-card')) : [];
    const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
    const img = cards[0] ? cards[0].querySelector('.portfolio-card__img') : null;
    const r = img ? img.getBoundingClientRect() : null;
    const vp = root ? root.querySelector('[data-pf-viewport]') : null;
    return {
      cards: cards.length,
      singleRow: new Set(tops).size === 1,
      dots: root ? root.querySelectorAll('.pf-carousel__dot').length : 0,
      scrollable: vp ? vp.scrollWidth - vp.clientWidth : 0,
      ratio: r ? Math.round((r.width / r.height) * 100) / 100 : 0,
      objectFit: img ? getComputedStyle(img).objectFit : ''
    };
  });
  ck('Gallery publik = carousel horizontal satu jalur', galleryRow.cards >= 2 && galleryRow.singleRow,
    `${galleryRow.cards} kartu, singleRow=${galleryRow.singleRow}`);
  ck('Gallery punya dots + bisa digeser', galleryRow.dots >= 2 && galleryRow.scrollable > 20,
    `dots=${galleryRow.dots} scrollable=${galleryRow.scrollable}`);
  ck('Kartu gallery memakai crop portrait konsisten (4:5, object-fit cover)',
    Math.abs(galleryRow.ratio - 0.8) < 0.04 && galleryRow.objectFit === 'cover',
    `${galleryRow.ratio} / ${galleryRow.objectFit}`);

  // Multi-photo gallery + lightbox (Tahap 7: the admin grid class is now .pf-photo and the
  // upload form previews + submits the selected files itself).
  await page.goto(pfEditUrl, { waitUntil: 'networkidle' });
  await page.setInputFiles('#photo_files', [tmpPng, tmpPng]);
  await page.waitForTimeout(300);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('[data-upload-submit]')
  ]);
  const photoCards = await page.locator('.pf-photo').count();
  ck('Two extra photos stored for the portfolio', photoCards === 2, String(photoCards));

  // Tahap 6 changed the interaction: a gallery card now OPENS THE CLIENT PAGE, and the
  // lightbox lives on that page (where the whole photo set is available). The check below
  // follows the new flow end to end.
  await page.goto(BASE + '/gallery', { waitUntil: 'networkidle' });
  const cardHref = await page.evaluate((name) => {
    const card = Array.from(document.querySelectorAll('.portfolio-card'))
      .find((c) => c.textContent.includes(name));
    const link = card && card.querySelector('a');
    return link ? link.getAttribute('href') : '';
  }, PF_NAME);
  ck('Gallery card links to the client page', /^\/portfolio\//.test(cardHref || ''), cardHref || '(none)');
  await page.goto(BASE + cardHref, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    document.querySelector('[data-lightbox]').click();
  });
  await page.waitForTimeout(400);
  ck('Lightbox opens from the client page', await page.isVisible('[data-lightbox-modal]'));
  const counter1 = await page.textContent('[data-lb-counter]');
  ck('Lightbox counter shows 1 / 3', counter1.trim() === '1 / 3', counter1);
  ck('Lightbox renders 3 thumbnails', (await page.locator('.lightbox__thumb').count()) === 3,
    String(await page.locator('.lightbox__thumb').count()));
  await page.click('[data-lb-next]');
  await page.waitForTimeout(250);
  const counter2 = await page.textContent('[data-lb-counter]');
  ck('Next moves to 2 / 3', counter2.trim() === '2 / 3', counter2);
  await page.click('[data-lb-prev]');
  await page.waitForTimeout(250);
  ck('Previous returns to 1 / 3', (await page.textContent('[data-lb-counter]')).trim() === '1 / 3');
  await page.click('[data-lb-close]');
  await page.waitForTimeout(250);
  ck('Lightbox closes', !(await page.isVisible('[data-lightbox-modal]')));

  // Global city switch
  await page.goto(BASE + '/admin/portfolio', { waitUntil: 'networkidle' });
  await page.check('input[name="portfolio_show_city"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('.portfolio-city-toggle button[type="submit"]')
  ]);
  await page.goto(BASE + '/gallery', { waitUntil: 'networkidle' });
  const cityVisible = await page.evaluate((name) => {
    const card = Array.from(document.querySelectorAll('.portfolio-card'))
      .find((c) => c.textContent.includes(name));
    return card ? card.textContent.replace(/\s+/g, ' ') : '';
  }, PF_NAME);
  ck('City appears on the cover once the owner enables it', cityVisible.includes('Bandung'), cityVisible);

  await page.goto(BASE + '/admin/portfolio', { waitUntil: 'networkidle' });
  await page.uncheck('input[name="portfolio_show_city"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('.portfolio-city-toggle button[type="submit"]')
  ]);

  // Featured portfolio reaches the homepage section (enable → publish → restore).
  // When the owner already has it on there is no draft to save/publish, so the
  // Publish button stays disabled — never click it blind.
  await page.goto(BASE + '/admin/sections', { waitUntil: 'networkidle' });
  const featuredWasOff = !(await page.isChecked('input[name="active_featured"]'));
  if (featuredWasOff) {
    await page.check('input[name="active_featured"]');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-sticky-actions button[type="submit"]')]);
    if (!(await page.isDisabled('.publish-bar form[action$="/publish"] button'))) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('.publish-bar form[action$="/publish"] button')
      ]);
    }
  }
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  // Revisi carousel + v12/v13: homepage featured = carousel autoplay satu jalur yang
  // HANYA berisi karya unggulan pilihan admin (bukan seluruh portfolio).
  const homeCard = await page.evaluate((name) => {
    const root = document.querySelector('.section--featured .pf-carousel--featured');
    if (!root) return null;
    const cards = Array.from(root.querySelectorAll('.portfolio-card'));
    const card = cards.find((c) => c.textContent.includes(name));
    const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
    return card ? {
      text: card.textContent.replace(/\s+/g, ' ').trim(),
      lead: Boolean(root.querySelector('.portfolio-card--lead')),
      cards: cards.length,
      singleRow: new Set(tops).size === 1,
      featuredOnly: cards.every((c) => {
        const a = c.querySelector('a.portfolio-card__btn');
        return a && a.getAttribute('href');
      })
    } : null;
  }, PF_NAME);
  ck('Homepage featured section merender carousel horizontal', Boolean(homeCard) && homeCard.cards >= 2 && homeCard.singleRow,
    homeCard ? `${homeCard.cards} kartu, singleRow=${homeCard.singleRow}` : 'no carousel');
  ck('Homepage card shows name+degree, campus, date', Boolean(homeCard && homeCard.text.includes('S.Kom.') &&
    homeCard.text.includes('Institut Uji V8') && homeCard.text.includes('12 Oktober 2026')), homeCard && homeCard.text);
  ck('Homepage carousel has uniform cards (no cropped lead tile)',
    Boolean(homeCard && !homeCard.lead), homeCard && String(homeCard.lead));

  if (featuredWasOff) {
    await page.goto(BASE + '/admin/sections', { waitUntil: 'networkidle' });
    await page.uncheck('input[name="active_featured"]');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-sticky-actions button[type="submit"]')]);
    if (!(await page.isDisabled('.publish-bar form[action$="/publish"] button'))) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('.publish-bar form[action$="/publish"] button')
      ]);
    }
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    ck('Featured section restored to its original state', (await page.$('.section--featured')) === null);
  }

  /* ================================================================
     4. MOBILE
     ================================================================ */
  const mobileBrowser = await chromium.launch();
  const mobile = await mobileBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', (e) => jsErrors.push(String(e)));

  await mobile.goto(BASE + '/gallery', { waitUntil: 'networkidle' });
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ck('No horizontal overflow on mobile gallery', mobileOverflow <= 1, String(mobileOverflow));
  const mobileCard = await mobile.evaluate((name) => {
    const card = Array.from(document.querySelectorAll('.portfolio-card')).find((c) => c.textContent.includes(name));
    if (!card) return null;
    const cs = getComputedStyle(card);
    const img = card.querySelector('img');
    return {
      radius: parseFloat(cs.borderTopLeftRadius),
      textSize: parseFloat(getComputedStyle(card.querySelector('.portfolio-card__name')).fontSize),
      naturalRatio: img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null,
      objectFit: getComputedStyle(img).objectFit
    };
  }, PF_NAME);
  ck('Mobile portfolio card keeps its rounded corners', Boolean(mobileCard && mobileCard.radius >= 12), mobileCard && mobileCard.radius);
  ck('Mobile cover text stays comfortably sized', Boolean(mobileCard && mobileCard.textSize >= 14), mobileCard && mobileCard.textSize);
  ck('Photos use object-fit: cover (no distortion)', Boolean(mobileCard && mobileCard.objectFit === 'cover'), mobileCard && mobileCard.objectFit);

  await mobile.goto(BASE + '/ulasan', { waitUntil: 'networkidle' });
  const mobileOverflow2 = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ck('No horizontal overflow on mobile reviews page', mobileOverflow2 <= 1, String(mobileOverflow2));
  const mobileStars = await mobile.evaluate(() => {
    const fig = document.querySelector('.testimonial');
    if (!fig) return null;
    return { total: fig.querySelectorAll('.rating__star').length, radius: getComputedStyle(fig).borderTopLeftRadius };
  });
  ck('Mobile testimonial card renders 5 stars', Boolean(mobileStars && mobileStars.total === 5), JSON.stringify(mobileStars));

  await mobile.goto(BASE + '/', { waitUntil: 'networkidle' });
  await mobile.waitForTimeout(700);
  const tstNav = await mobile.evaluate(() => {
    const nav = document.querySelector('[data-tst-nav]');
    return nav ? { hidden: nav.hidden, cards: document.querySelectorAll('.tst-carousel__track .testimonial').length } : null;
  });
  ck('Homepage testimonial carousel renders cards', Boolean(tstNav && tstNav.cards >= 1), JSON.stringify(tstNav));
  await mobile.close();
  await mobileBrowser.close();

  /* ================================================================
     5. CLEANUP
     ================================================================ */
  await page.goto(BASE + '/admin/portfolio', { waitUntil: 'networkidle' });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.evaluate((name) => {
      const card = Array.from(document.querySelectorAll('.portfolio-admin-card')).find((c) => c.textContent.includes(name));
      card.querySelector('form[action$="/delete"] button').click();
    }, PF_NAME)
  ]);
  const pfGone = !(await page.textContent('body')).includes(PF_NAME);
  ck('Test portfolio removed', pfGone === true);

  await page.goto(BASE + '/admin/testimonials', { waitUntil: 'networkidle' });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.evaluate((name) => {
      const row = Array.from(document.querySelectorAll('.admin-table tbody tr')).find((tr) => tr.textContent.includes(name));
      row.querySelector('form[action$="/delete"] button').click();
    }, TST_NAME)
  ]);
  const tstGone = !(await page.textContent('body')).includes(TST_NAME);
  ck('Test testimonial removed', tstGone === true);

  ck('No JavaScript errors on the tested pages', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  await browser.close();
  try { fs.unlinkSync(tmpPng); } catch (err) { /* ignore */ }

  console.log('\n' + (failures.length ? `${failures.length} OF ${pass + failures.length} CHECKS FAILED` : `ALL ${pass} CHECKS PASSED`));
  if (failures.length) { console.log('Failed: ' + failures.join(' | ')); process.exit(1); }
})().catch((err) => {
  console.error('SUITE CRASHED:', err);
  process.exit(1);
});

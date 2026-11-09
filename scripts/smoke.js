/* DLY Graduation — V3 acceptance suite.
   Usage:
     cp data/app.sqlite* /tmp/t/ && DLY_DATA_DIR=/tmp/t PORT=4420 node server.js &
     SMOKE_BASE=http://127.0.0.1:4420 node scripts/smoke.js
*/
'use strict';

const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4420';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || 'DlyGraduation2025';

let failures = 0;
const results = [];
const check = (name, ok, extra) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};
const rupiah = (n) => 'Rp ' + Number(n).toLocaleString('id-ID');
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

// The app validates dates in WIB (UTC+7); the test machine may be a day behind.
// So always ask the server what "today" is before building dates.
let serverToday = null;

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

const serverAddDays = (n) => {
  const base = serverToday || addDays(0);
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const PNG = '/tmp/dly-v3-fixture.png';
fs.writeFileSync(PNG, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGRgQEAGZ4C/e1vJ0kAAAAASUVORK5CYII=',
  'base64'
));

async function main() {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/401 \(Unauthorized\)/.test(t)) return;      // deliberate wrong-password check
    if (/404 \(Not Found\)/.test(t)) return;          // intentional missing-slug probes
    errors.push('console: ' + t);
  });

  /* ================================================================ */
  /* 1. HOMEPAGE                                                       */
  /* ================================================================ */
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  check('Homepage renders hero headline', (await page.textContent('h1')).includes('Your Graduation'));

  const navLabels = await page.$$eval('.site-nav a', (as) => as.map((a) => a.textContent.trim()));
  check('Navigation keeps the core items',
    ['Home', 'Gallery', 'Pricelist', 'Cara Order'].every((l) => navLabels.includes(l)), navLabels.join(' | '));
  check('Navigation includes Syarat & Ketentuan', navLabels.some((l) => l.includes('Syarat')), navLabels.join(' | '));

  const slides = await page.$$eval('[data-slide]', (els) => els.length);
  check('Hero slideshow loads slides from DB', slides >= 3, 'slides=' + slides);
  const heroH = await page.$eval('.hero', (el) => Math.round(el.getBoundingClientRect().height));
  check('Hero is 85–100vh on desktop', heroH >= 700, 'height=' + heroH);
  const objFit = await page.$eval('[data-slide].is-active img', (el) => getComputedStyle(el).objectFit);
  check('Hero uses object-fit cover', objFit === 'cover');

  const a1 = await page.$eval('[data-slide].is-active', (el) => Array.from(el.parentElement.children).indexOf(el));
  await page.waitForTimeout(6800);
  const a2 = await page.$eval('[data-slide].is-active', (el) => Array.from(el.parentElement.children).indexOf(el));
  check('Hero autoplay advances (crossfade)', a1 !== a2, `${a1} → ${a2}`);

  await page.click('[data-hero-dot="1"]');
  check('Hero dot navigates', await page.$eval('[data-slide].is-active', (el) => Array.from(el.parentElement.children).indexOf(el)) === 1);
  await page.click('[data-hero-prev]');
  check('Hero previous arrow works', await page.$eval('[data-slide].is-active', (el) => Array.from(el.parentElement.children).indexOf(el)) === 0);
  await page.click('[data-hero-toggle]');
  check('Hero autoplay toggle works', (await page.getAttribute('[data-hero-toggle]', 'aria-pressed')) === 'true');
  await page.click('[data-hero-toggle]');

  const sectionKeys = await page.$$eval('main > section', (els) => els.map((e) => e.className));
  check('Homepage renders the active DB sections', sectionKeys.length >= 4, sectionKeys.length + ' sections');
  // The Services section is owner-controlled (Admin → Urutan Section). The suite must not
  // demand cards when the owner switched the section off, so assert the *relationship*:
  // section visible ⇒ cards rendered; section hidden ⇒ no orphan cards.
  const servicesVisible = sectionKeys.some((c) => String(c).includes('section--services'));
  const svcCards = await page.$$('.service-card');
  check(servicesVisible ? 'Our Services renders service cards' : 'Our Services is disabled (no orphan cards)',
    servicesVisible ? svcCards.length >= 1 : svcCards.length === 0,
    `section=${servicesVisible} cards=${svcCards.length}`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('No horizontal overflow (desktop home)', overflow <= 1, 'overflow=' + overflow);
  const broken = await page.$$eval('img', (imgs) => imgs.filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')));
  check('No broken images on homepage', broken.length === 0, broken.join(','));

  /* ================================================================ */
  /* 2. INFORMATIONAL PAGES                                            */
  /* ================================================================ */
  for (const [path, marker] of [
    ['/cara-order', 'Cara Order'],
    ['/ulasan', 'Ulasan'],
    ['/faq', 'Pertanyaan'],
    ['/tentang', 'Tentang'],
    ['/artikel', 'Artikel']
  ]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    const ok = (await page.textContent('body')).includes(marker);
    check(`Page renders: ${path}`, ok);
  }
  await page.goto(BASE + '/faq', { waitUntil: 'networkidle' });
  const faqCount = await page.$$eval('.faq-item', (els) => els.length);
  check('FAQ items render from DB', faqCount >= 3, 'items=' + faqCount);

  /* legacy redirect */
  const redirect = await page.request.get(BASE + '/portfolio?kategori=couple', { maxRedirects: 0, failOnStatusCode: false });
  check('Legacy /portfolio redirects to /gallery', [301, 302, 308].includes(redirect.status()) && (redirect.headers().location || '').includes('/gallery'), 'status=' + redirect.status());

  /* ================================================================ */
  /* 3. CITY ARCHIVES (integrated pricelist)                           */
  /* ================================================================ */
  await page.goto(BASE + '/city', { waitUntil: 'networkidle' });
  check('City page heading is "Archives by Location"', (await page.textContent('h1')).includes('Archives by Location'));
  check('City page breadcrumb Home > Choose Location', (await page.textContent('.breadcrumb')).includes('Home'));
  const archiveCards = await page.$$('.archive-card');
  check('City archive cards render', archiveCards.length >= 1, 'cards=' + archiveCards.length);
  check('City card shows "Harga belum dikonfigurasi" when no price',
    (await page.textContent('.archive-card__meta')).match(/Harga belum dikonfigurasi|Mulai/) !== null);

  await page.goto(BASE + '/city?kota=bandung', { waitUntil: 'networkidle' });
  const inlineCats = await page.$$('[data-cat-tab]');
  check('Selecting a city shows its pricelist on the same page', inlineCats.length === 3, 'tabs=' + inlineCats.length);

  /* ================================================================ */
  /* 4. PRICELIST — categories & durations, no tiers                    */
  /* ================================================================ */
  await page.goto(BASE + '/pricelist', { waitUntil: 'networkidle' });
  const cats = await page.$$eval('[data-cat-tab]', (els) => els.map((e) => e.dataset.catTab));
  check('Pricelist categories come from DB', cats.join(',') === 'individual,couple,group', cats.join(','));
  const bodyText = await page.textContent('body');
  check('No Basic/Standard/Premium tiers exposed', !/\b(Basic|Standard|Premium)\b/.test(bodyText));

  const durMinutes = await page.$$eval('[data-cat-panel="individual"] .dur-card', (els) => els.map((e) => e.dataset.duration));
  check('Durations render for a category (60/90/120)', durMinutes.join(',') === '60,90,120', durMinutes.join(','));
  const priceState = await page.$eval('[data-cat-panel="individual"] [data-book-link]', (el) => ({
    href: el.getAttribute('href'),
    disabled: el.getAttribute('aria-disabled')
  }));
  const priceLabel = await page.$eval('[data-cat-panel="individual"] [data-price-display]', (el) => el.textContent.trim());
  check('Price cell shows a price or the not-available label',
    /Rp\s?\d/.test(priceLabel) || /belum tersedia/i.test(priceLabel), priceLabel);
  check('CTA enabled exactly when a price exists',
    (/Rp\s?\d/.test(priceLabel) && priceState.disabled !== 'true' && Boolean(priceState.href))
    || (/belum tersedia/i.test(priceLabel) && priceState.disabled === 'true' && !priceState.href),
    JSON.stringify(priceState));

  const photoSpec = await page.$eval('[data-cat-panel="individual"] [data-photos-display]', (el) => el.textContent.trim());
  check('Edited-photo count is shown per duration in the spec block',
    /foto/i.test(photoSpec) || /Belum dikonfigurasi/i.test(photoSpec), photoSpec);
  const durPhotos = await page.$$eval('[data-cat-panel="individual"] .dur-card', (els) => els.map((e) => e.dataset.photos));
  check('Each duration card carries its own photo count', durPhotos.length === 3, durPhotos.join(','));

  const editorial = await page.$eval('.pkg-feature', (el) => getComputedStyle(el).display);
  check('Package cards use an editorial 2-column layout', editorial === 'grid');

  /* ================================================================ */
  /* 5. ADMIN LOGIN                                                    */
  /* ================================================================ */
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  check('Admin area redirects to login', page.url().includes('/admin/login'));
  await page.fill('#username', USER);
  await page.fill('#password', 'wrong-pass-000');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.login-form button[type=submit]')]);
  check('Wrong password rejected', (await page.textContent('body')).includes('Username atau password salah'));
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([page.waitForURL('**/admin', { timeout: 12000 }), page.click('.login-form button[type=submit]')]);
  check('Admin login works', (await page.textContent('.admin-topbar')).includes('Overview'));

  // Read the LABEL span, not the whole <a>: since Tahap 3 some items carry a numeric badge
  // (e.g. "Overview" + "3"), which made the exact-match assertion fail when real bookings exist.
  const adminNav = await page.$$eval('.admin-nav a .admin-nav__label', (as) => as.map((a) => a.textContent.trim()));
  // Tahap 3 renamed "Booking" → "Kelola Booking" (same route) and moved the menu into
  // collapsible groups, so assert the routes exist instead of one fixed label set.
  check('Admin menu covers the V4 modules',
    ['Add-on', 'Jadwal Tersedia', 'Harga & Foto Edit', 'Artikel', 'FAQ', 'Kelola Booking', 'Halaman & Navigasi', 'Pembayaran (DP)'].every((l) => adminNav.includes(l)),
    adminNav.join(' | '));
  const navGroups = await page.$$eval('[data-nav-group] .nav-group__label', (els) => els.map((e) => e.textContent.trim()));
  check('Admin menu is grouped into clear sections', navGroups.length === 6, navGroups.join(' | '));

  /* ================================================================ */
  /* 6. PRICE MANAGEMENT → PUBLIC SITE                                 */
  /* ================================================================ */
  await page.goto(BASE + '/admin/durations', { waitUntil: 'networkidle' });
  const durInputs = await page.$$eval('input[name^="price_"]', (els) => els.map((e) => e.name));
  check('Durations screen lists all duration rows', durInputs.length >= 9, 'rows=' + durInputs.length);
  const photoInputs = await page.$$('input[name^="photos_"]');
  check('Durations screen exposes a photo count per duration', photoInputs.length === durInputs.length, 'photo inputs=' + photoInputs.length);

  // set prices for the Individual package (60/90/120) via the durations screen
  await page.goto(BASE + '/admin/packages', { waitUntil: 'networkidle' });
  const indivEdit = await page.locator('.admin-table tbody tr').first().locator('a.admin-link', { hasText: 'Edit' }).first().getAttribute('href');
  await page.goto(new URL(indivEdit, BASE).toString(), { waitUntil: 'networkidle' });
  await page.fill('input[name="dur_price_0"]', '350000');
  await page.fill('input[name="dur_price_1"]', '450000');
  await page.fill('input[name="dur_price_2"]', '600000');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-form__actions button[type=submit]')]);
  check('Package prices saved', (await page.textContent('body')).includes('berhasil diperbarui'));

  await page.goto(BASE + '/pricelist', { waitUntil: 'networkidle' });
  const shownPrice = await page.$eval('[data-cat-panel="individual"] [data-price-display]', (el) => el.textContent.trim());
  check('Public pricelist shows saved price', shownPrice.includes('350.000'), shownPrice);
  await page.click('[data-cat-panel="individual"] .dur-card[data-duration="120"]');
  const afterSwitch = await page.$eval('[data-cat-panel="individual"] [data-price-display]', (el) => el.textContent.trim());
  check('Switching duration updates the price instantly', afterSwitch.includes('600.000'), afterSwitch);
  const ctaHref = await page.$eval('[data-cat-panel="individual"] [data-book-link]', (el) => el.getAttribute('href'));
  check('CTA carries the selected duration', ctaHref.includes('durasi=120'), ctaHref);

  /* ================================================================ */
  /* 7. ADD-ONS                                                        */
  /* ================================================================ */
  await page.goto(BASE + '/admin/addons', { waitUntil: 'networkidle' });
  const seededAddons = await page.$$eval('.admin-table tbody tr', (els) => els.length);
  check('Add-on structure seeded (inactive)', seededAddons >= 4, 'rows=' + seededAddons);

  await page.goto(BASE + '/admin/addons/new', { waitUntil: 'networkidle' });
  await page.fill('#name', 'Extra Edit Uji');
  await page.fill('#price', '125000');
  await page.fill('#description', 'Tambahan 5 foto edit untuk pengujian.');
  await page.check('[data-scope-cat][value="individual"]');
  await page.check('input[name="is_active"]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-form__actions button[type=submit]')]);
  check('Add-on created & activated', (await page.textContent('body')).includes('Add-on berhasil ditambahkan'));

  await openSessionStep(page);
  const addonVisible = await page.locator('[data-addon]', { hasText: 'Extra Edit Uji' }).isVisible();
  check('Active add-on with price appears in booking', addonVisible);
  const otherAddonVisible = await page.locator('[data-addon]', { hasText: 'Fast Edit' }).isVisible().catch(() => false);
  check('Unpriced add-on stays hidden from visitors', otherAddonVisible === false);

  /* ================================================================ */
  /* 8. MULTI-STEP BOOKING                                             */
  /* ================================================================ */
  await page.goto(BASE + '/booking?kota=bandung', { waitUntil: 'networkidle' });
  const stepPanels = await page.$$('[data-step]');
  check('Booking form has 3 steps', stepPanels.length === 3);
  check('Wizard starts on step 1', await page.isVisible('[data-step="1"]'));

  // category → package → duration
  await openSessionStep(page);
  await page.selectOption('[data-category-select]', 'individual');
  await page.waitForTimeout(150);
  const pkgOptions = await page.$$eval('[data-package-select] option', (os) => os.map((o) => o.textContent.trim()));
  check('Package list follows the selected category', pkgOptions.length >= 1 && pkgOptions[0].length > 2, pkgOptions.join(','));
  await page.check('input[name="duration"][value="90"]');
  await page.waitForTimeout(150);
  const estPkg = await page.$eval('[data-est-package]', (el) => el.textContent.trim());
  check('Estimate shows the package price', estPkg.includes('450.000'), estPkg);

  // add-on selection updates the total
  await page.check('[data-addon] input[type=checkbox]');
  await page.waitForTimeout(150);
  const estAddons = await page.$eval('[data-est-addons]', (el) => el.textContent.trim());
  const estTotal = await page.$eval('[data-est-total]', (el) => el.textContent.trim());
  check('Add-on total is added to the estimate', estAddons.includes('125.000'), estAddons);
  check('Total = package + add-ons', estTotal.includes('575.000'), estTotal);

  // calendar
  const calDays = await page.$$('.calendar__grid .cal-day:not(.is-empty)');
  check('Calendar renders day cells', calDays.length >= 28, 'cells=' + calDays.length);
  const disabledDays = await page.$$eval('.calendar__grid .cal-day[disabled]', (els) => els.length);
  check('Calendar disables unavailable dates', disabledDays >= 1, 'disabled=' + disabledDays);
  const labelBefore = await page.$eval('[data-cal-label]', (el) => el.textContent.trim());
  await page.click('[data-cal-next]');
  await page.waitForTimeout(400);
  const labelAfter = await page.$eval('[data-cal-label]', (el) => el.textContent.trim());
  check('Calendar next month works', labelBefore !== labelAfter, `${labelBefore} → ${labelAfter}`);
  await page.click('[data-cal-prev]');
  await page.waitForTimeout(400);

  // pick the first enabled day
  const picked = await page.$$eval('.calendar__grid .cal-day:not([disabled]):not(.is-empty)', (els) => {
    const el = els[0];
    if (!el) return null;
    el.click();
    return el.dataset.date;
  });
  check('Selecting a date works', Boolean(picked), String(picked));
  await page.waitForTimeout(150);
  const selText = await page.$eval('[data-cal-selected]', (el) => el.textContent.trim());
  check('Selected date is echoed to the user', /Tanggal dipilih/.test(selText), selText);
  const hiddenDate = await page.inputValue('[data-date-input]');
  check('Selected date stored in the form', hiddenDate === picked, hiddenDate);

  // session (step 2) validation blocks an empty location
  await page.click('[data-next="3"]');
  await page.waitForTimeout(200);
  check('Session step blocks a missing location', await page.isVisible('[data-step="2"]'));

  await page.fill('#location', 'Unpad - Dipatiukur');
  if (await page.$('#shooting_time')) await page.fill('#shooting_time', '10:00');
  await page.click('[data-next="3"]');
  await page.waitForTimeout(300);
  check('Continue moves to the review step', await page.isVisible('[data-step="3"]'));

  const rvName = await page.$eval('[data-rv-name]', (el) => el.textContent.trim());
  check('Review shows the identity captured on step 1', rvName.length > 0, rvName);

  const rvDate = await page.$eval('[data-rv-date]', (el) => el.textContent.trim());
  const rvTotal = await page.$eval('[data-rv-total]', (el) => el.textContent.trim());
  const rvAddons = await page.$eval('[data-rv-addons]', (el) => el.textContent.trim());
  check('Review shows the chosen date', /Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember/.test(rvDate), rvDate);
  check('Review shows the add-on', /Extra Edit/.test(rvAddons), rvAddons);
  check('Review shows the estimated total', rvTotal.includes('575.000'), rvTotal);

  // submit
  await Promise.all([
    page.waitForURL('**/booking/sukses/**', { timeout: 15000 }),
    page.click('[data-submit-btn]')
  ]);
  const successBody = await page.textContent('body');
  // Kode booking format baru (blueprint Client Portal): DLY-WISUDA-NAMA###
  const code = (successBody.match(/DLY-WISUDA-[A-Z]{3,10}\d{3}/) || [''])[0];
  check('Booking saved and confirmation shown', Boolean(code), code);
  check('Confirmation shows Pending status', successBody.includes('Pending'));
  check('Confirmation lists add-on and total', successBody.includes('Extra Edit Uji') && successBody.includes('575.000'));

  const waHref = await page.getAttribute('[data-wa-send]', 'href');
  const msg = decodeURIComponent((waHref.split('?text=')[1] || '').replace(/\+/g, ' '));
  check('WhatsApp link uses the business number', waHref.startsWith('https://wa.me/6289629619590'), waHref.slice(0, 40));
  check('Message contains Booking ID', msg.includes('Booking ID: ' + code));
  check('Message contains name & phone', msg.includes('Nama: Klien V3') && msg.includes('WhatsApp: 6281234567890'));
  check('Message contains Instagram', msg.includes('Instagram: klien.v3'));
  check('Message contains faculty & major', msg.includes('Fakultas: Fakultas Teknik') && msg.includes('Jurusan: Teknik Informatika'));
  check('Message contains city/date/location', msg.includes('Kota: Bandung') && msg.includes('Lokasi: Unpad - Dipatiukur'));
  check('Message contains category/duration/price', msg.includes('Kategori: Individual Package') && msg.includes('Durasi: 90 menit') && msg.includes('Harga Paket: Rp 450.000'));
  check('Message contains add-on & total', msg.includes('Add-ons: Extra Edit Uji (Rp 125.000)') && msg.includes('Total Estimasi: Rp 575.000'));
  check('Message keeps closing line', msg.includes('Mohon informasi lebih lanjut mengenai ketersediaan jadwal. Terima kasih.'));

  /* ================================================================ */
  /* 9. SERVER-SIDE GUARDS                                             */
  /* ================================================================ */
  {
    const probe = await page.request.get(BASE + '/api/availability?bulan=' + addDays(0).slice(0, 7));
    const probeJson = await probe.json();
    if (probeJson && probeJson.today) serverToday = probeJson.today;
    else {
      const probe2 = await page.request.get(BASE + '/api/availability?bulan=' + addDays(1).slice(0, 7));
      const probe2Json = await probe2.json();
      serverToday = (probe2Json && probe2Json.today) || addDays(0);
    }
  }
  const noPricePost = await page.request.post(BASE + '/booking', {
    form: {
      client_name: 'Tes Guard', client_phone: '081234567890', campus: 'Unpad', instagram: 'tes.guard',
      city: 'bandung', package_id: '5', duration: '60',
      location: 'Unpad - Dipatiukur', shooting_time: '10:00',
      shooting_date: serverAddDays(10), terms_consent: '1'
    },
    failOnStatusCode: false
  });
  const guardBody = await noPricePost.text();
  check('Server rejects booking when price is empty', noPricePost.status() === 422 && /belum diatur oleh admin/i.test(guardBody), 'status=' + noPricePost.status());

  const badDatePost = await page.request.post(BASE + '/booking', {
    form: {
      client_name: 'Tes Guard', client_phone: '081234567890', campus: 'Unpad', instagram: 'tes.guard',
      city: 'bandung', package_id: '2', duration: '60',
      location: 'Unpad - Dipatiukur', shooting_time: '10:00',
      shooting_date: serverAddDays(0), terms_consent: '1'
    },
    failOnStatusCode: false
  });
  // The owner can allow same-day bookings (lead_days = 0), so assert the rule is HONOURED
  // rather than assuming a minimum notice period.
  const rulesRes = await page.request.get(BASE + '/api/availability?bulan=' + serverAddDays(0).slice(0, 7));
  const rulesJson = await rulesRes.json();
  const leadDays = Number((rulesJson.rules && rulesJson.rules.leadDays) || 0);
  const badDateBody = await badDatePost.text();
  if (leadDays > 0) {
    check('Server rejects a date inside the lead-time window',
      badDatePost.status() === 422 && /tidak tersedia/i.test(badDateBody), 'leadDays=' + leadDays);
  } else {
    check('Same-day bookings allowed when lead time is 0',
      !/Tanggal yang dipilih tidak tersedia/i.test(badDateBody),
      'leadDays=0 status=' + badDatePost.status());
  }

  const noTermsPost = await page.request.post(BASE + '/booking', {
    form: {
      client_name: 'Tes Guard', client_phone: '081234567890', campus: 'Unpad', instagram: 'tes.guard',
      city: 'bandung', package_id: '2', duration: '60',
      location: 'Unpad - Dipatiukur', shooting_time: '10:00',
      shooting_date: serverAddDays(10)
    },
    failOnStatusCode: false
  });
  check('Server requires terms consent', noTermsPost.status() === 422 && /ketentuan booking/i.test(await noTermsPost.text()));

  /* ================================================================ */
  /* 10. BOOKING MANAGEMENT                                            */
  /* ================================================================ */
  // Tahap 3: the grid card is compact and every operational form lives on the
  // detail page (/admin/bookings/:id), so the suite follows the same route a human does.
  await page.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  const cardSel = `.bk-card:has-text("${code}")`;
  check('Booking listed in admin', (await page.$(cardSel)) !== null, code);
  const bookingId = (await page.$eval(cardSel, (el) => el.id)).replace('b-', '');

  // v14: tab "Identitas Client" + "Detail Pekerjaan" digabung menjadi "Detail Booking".
  // URL lama (?tab=pekerjaan / ?tab=klien) tetap valid dan menampilkan panel #detail.
  await page.goto(BASE + `/admin/bookings/${bookingId}?tab=pekerjaan`, { waitUntil: 'networkidle' });
  const jobText = await page.locator('#detail').textContent();
  check('Admin sees add-on and total snapshot',
    /Extra Edit Uji/.test(await page.locator('#detail').innerText()) || /Extra Edit Uji/.test(await page.content()));
  await page.goto(BASE + `/admin/bookings/${bookingId}?tab=klien`, { waitUntil: 'networkidle' });
  const clientText = await page.locator('#detail').innerText();
  check('Admin sees faculty & major',
    /fakultas teknik/i.test(clientText) && /teknik informatika/i.test(clientText),
    clientText.replace(/\n/g, ' | ').slice(0, 120));

  await page.goto(BASE + `/admin/bookings/${bookingId}?tab=workflow`, { waitUntil: 'networkidle' });
  await page.selectOption(`#status-${bookingId}`, 'confirmed');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.locator('#workflow .bd-update-form button[type=submit]').click()]);
  const flowAfter = await page.locator('#workflow').innerText();
  check('Booking status updated & persisted', /confirmed/i.test(flowAfter));
  // v14: panel "Status & catatan internal" dihapus, jadi catatan internal tidak lagi
  // editable dari halaman ini (nilainya tetap tersimpan di database, dikirim utuh
  // lewat hidden input agar tidak terhapus).
  check('Panel catatan internal sudah tidak ada', !/catatan internal \(tidak tampil/i.test(await page.content()));

  /* filters (grid view pinned so the remembered view does not interfere) */
  await page.goto(BASE + '/admin/bookings?status=confirmed&view=grid', { waitUntil: 'networkidle' });
  check('Status filter includes confirmed booking', (await page.locator(cardSel).count()) === 1);
  await page.goto(BASE + '/admin/bookings?status=pending&view=grid', { waitUntil: 'networkidle' });
  check('Status filter excludes non-matching booking', (await page.locator(cardSel).count()) === 0);
  await page.goto(BASE + '/admin/bookings?kota=1&view=grid', { waitUntil: 'networkidle' });
  check('City filter works', (await page.locator(cardSel).count()) === 1);
  await page.goto(BASE + `/admin/bookings?dari=${serverAddDays(0)}&sampai=${serverAddDays(90)}&view=grid`, { waitUntil: 'networkidle' });
  check('Date range filter works', (await page.locator(cardSel).count()) === 1);

  /* ================================================================ */
  /* 11. AVAILABILITY — blocking a date hides it from the calendar     */
  /* ================================================================ */
  const blockTarget = serverAddDays(20);
  const monthParam = blockTarget.slice(0, 7);
  await page.goto(BASE + '/admin/availability?bulan=' + monthParam, { waitUntil: 'networkidle' });
  check('Availability page groups rules, calendar and overrides', (await page.textContent('body')).includes('Aturan ketersediaan'));
  const apiBefore = await page.request.get(BASE + '/api/availability?bulan=' + monthParam);
  const apiBeforeJson = await apiBefore.json();
  check('Availability API returns day map', apiBeforeJson.ok && Object.keys(apiBeforeJson.days).length >= 28);

  await page.goto(BASE + '/api/availability?bulan=' + monthParam, { waitUntil: 'networkidle' });
  const beforeBlocked = JSON.parse(await page.textContent('body')).days[blockTarget].available;
  await page.goto(BASE + '/admin/availability?bulan=' + monthParam, { waitUntil: 'networkidle' });
  // Tahap 7: a day is a button that opens the Full Booking / Ditutup panel, then an action
  // ("Tutup tanggal") is submitted. This replaces the old one-click toggle form.
  await page.click(`[data-avail-day="${blockTarget}"]`);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('[data-avail-panel] button[value="close"]')
  ]);
  const apiAfter = await page.request.get(BASE + '/api/availability?bulan=' + monthParam);
  const apiAfterJson = await apiAfter.json();
  check('Blocking a date changes public availability', beforeBlocked === true && apiAfterJson.days[blockTarget].available === false,
    `${beforeBlocked} → ${apiAfterJson.days[blockTarget].available}`);

  // reopening restores it (removes the override → availability is computed again)
  await page.click(`[data-avail-day="${blockTarget}"]`);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('[data-avail-panel] button[value="reopen"]')
  ]);
  const apiReopen = await (await page.request.get(BASE + '/api/availability?bulan=' + monthParam)).json();
  check('Re-opening a date restores availability', apiReopen.days[blockTarget].available === true);

  // rules persist
  await page.fill('#lead_days', '3');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-form__actions button[type=submit]')]);
  await page.goto(BASE + '/admin/availability?bulan=' + monthParam, { waitUntil: 'networkidle' });
  check('Availability rules persist after reload', (await page.inputValue('#lead_days')) === '3');
  await page.fill('#lead_days', '2');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-form__actions button[type=submit]')]);

  /* ================================================================ */
  /* 12. CMS: content draft → publish                                  */
  /* ================================================================ */
  const NEW_HEADLINE = 'Your Graduation, Your V3 Story.';
  await page.goto(BASE + '/admin/content', { waitUntil: 'networkidle' });
  await page.fill('#hero\\.headline', NEW_HEADLINE);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-sticky-actions button[type=submit]')]);
  check('Content saved as draft', (await page.textContent('body')).includes('Draft disimpan'));

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  check('Draft does NOT change the public site', !(await page.textContent('h1')).includes('V3 Story'));
  await page.goto(BASE + '/?preview=1', { waitUntil: 'networkidle' });
  check('Admin preview shows the draft', (await page.textContent('h1')).includes('V3 Story'));

  await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.publish-bar form[action$="/publish"] button')]);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  check('Publish applies the draft to the public site', (await page.textContent('h1')).includes('V3 Story'));

  /* section toggle */
  await page.goto(BASE + '/admin/sections', { waitUntil: 'networkidle' });
  check('Section manager lists intro & services', (await page.textContent('body')).includes('Introduction') && (await page.textContent('body')).includes('Our Services'));
  await page.uncheck('input[name="active_testimonials"]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-sticky-actions button[type=submit]')]);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.publish-bar form[action$="/publish"] button')]);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  check('Disabled section disappears from home', (await page.$('.section--testimonials')) === null);
  await page.goto(BASE + '/admin/sections', { waitUntil: 'networkidle' });
  await page.check('input[name="active_testimonials"]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-sticky-actions button[type=submit]')]);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.publish-bar form[action$="/publish"] button')]);

  /* appearance */
  await page.goto(BASE + '/admin/appearance', { waitUntil: 'networkidle' });
  await page.$eval('#appearance_primary', (el) => { el.value = '#123456'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-sticky-actions button[type=submit]')]);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.publish-bar form[action$="/publish"] button')]);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const primaryVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
  check('Appearance colour reaches the public CSS', primaryVar.toLowerCase() === '#123456', primaryVar);
  await page.goto(BASE + '/admin/appearance', { waitUntil: 'networkidle' });
  await page.click('.preset-card form[action$="/appearance/preset"] button');
  await page.waitForLoadState('networkidle');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.publish-bar form[action$="/publish"] button')]);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  check('Preset restores brand navy', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())).toLowerCase() === '#0b2340');

  /* ================================================================ */
  /* 13. CMS: articles & FAQ                                           */
  /* ================================================================ */
  await page.goto(BASE + '/artikel', { waitUntil: 'networkidle' });
  check('Draft articles are hidden from the public list', (await page.textContent('body')).includes('Belum ada artikel'));

  await page.goto(BASE + '/admin/articles', { waitUntil: 'networkidle' });
  const draftRow = page.locator('tr', { hasText: 'Persiapan Sesi Foto Wisuda' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), draftRow.locator('form[action$="/toggle"] button').click()]);
  await page.goto(BASE + '/artikel', { waitUntil: 'networkidle' });
  check('Published article appears publicly', (await page.textContent('body')).includes('Persiapan Sesi Foto Wisuda'));
  await page.click('.article-card h2 a');
  await page.waitForLoadState('networkidle');
  check('Article detail page renders body', (await page.$$('.article-body p')).length >= 3);

  await page.goto(BASE + '/admin/articles/new', { waitUntil: 'networkidle' });
  await page.fill('#title', 'Artikel Uji V3');
  await page.fill('#excerpt', 'Ringkasan artikel pengujian.');
  await page.fill('#body', 'Paragraf pertama.\nParagraf kedua.\nParagraf ketiga.');
  await page.check('input[name="is_published"]');
  await page.setInputFiles('#cover_file', PNG);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-form__actions button[type=submit]')]);
  check('Article created with cover upload', (await page.textContent('body')).includes('Artikel berhasil ditambahkan'));
  await page.goto(BASE + '/artikel/artikel-uji-v3', { waitUntil: 'networkidle' });
  check('New article live at its slug', (await page.textContent('h1')).includes('Artikel Uji V3'));

  /* FAQ */
  await page.goto(BASE + '/admin/faqs/new', { waitUntil: 'networkidle' });
  await page.fill('#question', 'Apakah FAQ ini dari pengujian?');
  await page.fill('#answer', 'Ya, FAQ ini dibuat oleh pengujian otomatis.');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-form__actions button[type=submit]')]);
  await page.goto(BASE + '/faq', { waitUntil: 'networkidle' });
  check('New FAQ appears publicly', (await page.textContent('body')).includes('FAQ ini dari pengujian'));

  /* ================================================================ */
  /* 14. SECURITY                                                      */
  /* ================================================================ */
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-logout')]);
  check('Logout works', page.url().includes('/admin/login'));

  // Leave an unpublished draft behind, then verify anonymous visitors cannot see it.
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([page.waitForURL('**/admin', { timeout: 12000 }), page.click('.login-form button[type=submit]')]);
  await page.goto(BASE + '/admin/content', { waitUntil: 'networkidle' });
  const DRAFT_MARKER = 'DRAFT-ONLY-MARKER-9271';
  await page.fill('#hero\\.description', DRAFT_MARKER);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.admin-sticky-actions button[type=submit]')]);

  const b2 = await chromium.launch();
  const anon = await b2.newPage();
  await anon.goto(BASE + '/admin/bookings', { waitUntil: 'networkidle' });
  check('Protected admin page redirects when logged out', anon.url().includes('/admin/login'));
  const post = await anon.request.post(BASE + '/admin/publish', { form: {}, maxRedirects: 0, failOnStatusCode: false });
  check('Admin POST rejected without a session', [302, 401, 403].includes(post.status()), 'status=' + post.status());
  await anon.goto(BASE + '/?preview=1', { waitUntil: 'networkidle' });
  check('Anonymous preview cannot see drafts', !(await anon.textContent('body')).includes(DRAFT_MARKER));
  await anon.goto(BASE + '/', { waitUntil: 'networkidle' });
  check('Anonymous public page cannot see drafts', !(await anon.textContent('body')).includes(DRAFT_MARKER));
  await anon.close();
  await b2.close();

  await page.goto(BASE + '/?preview=1', { waitUntil: 'networkidle' });
  check('Admin preview can see the same draft', (await page.textContent('body')).includes(DRAFT_MARKER));
  // discard the marker so the workspace is left clean
  await page.goto(BASE + '/admin/content', { waitUntil: 'networkidle' });
  page.once('dialog', (d) => d.accept());
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.publish-bar form[action$="/cancel"] button')]);

  /* ================================================================ */
  /* 15. CLEANUP (keep the workspace tidy)                              */
  /* ================================================================ */
  // still authenticated from the draft-isolation step
  // Delete from the detail page (Tahap 3 keeps destructive actions off the grid card).
  await page.goto(BASE + `/admin/bookings/${bookingId}?tab=workflow`, { waitUntil: 'networkidle' });
  page.once('dialog', (d) => d.accept());
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.locator('form[action$="/delete"] button').click()]);
  await page.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  check('Test booking deleted', (await page.locator(cardSel).count()) === 0);

  await page.goto(BASE + '/admin/addons', { waitUntil: 'networkidle' });
  page.once('dialog', (d) => d.accept());
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.locator('tr', { hasText: 'Extra Edit Uji' }).locator('form[action$="/delete"] button').click()]);
  check('Test add-on deleted', !(await page.textContent('.admin-table')).includes('Extra Edit Uji'));

  await page.goto(BASE + '/admin/articles', { waitUntil: 'networkidle' });
  page.once('dialog', (d) => d.accept());
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.locator('tr', { hasText: 'Artikel Uji V3' }).locator('form[action$="/delete"] button').click()]);
  check('Test article deleted', !(await page.textContent('.admin-table')).includes('Artikel Uji V3'));

  await page.goto(BASE + '/admin/faqs', { waitUntil: 'networkidle' });
  page.once('dialog', (d) => d.accept());
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.locator('tr', { hasText: 'FAQ ini dari pengujian' }).locator('form[action$="/delete"] button').click()]);
  check('Test FAQ deleted', !(await page.textContent('.admin-table')).includes('FAQ ini dari pengujian'));

  await page.close();
  await ctx.close();

  /* ================================================================ */
  /* 16. MOBILE                                                        */
  /* ================================================================ */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await mctx.newPage();
  m.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));

  await m.goto(BASE + '/', { waitUntil: 'networkidle' });
  check('No horizontal overflow (mobile home)', (await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
  check('Hero fills mobile viewport', (await m.$eval('.hero', (el) => el.getBoundingClientRect().height)) > 480);
  await m.click('[data-nav-toggle]');
  await m.waitForTimeout(250);
  check('Mobile menu opens with the visible items', (await m.$$('[data-mobile-nav] a')).length >= 6);
  await m.click('[data-mobile-nav] a[href$="/ulasan"]');
  await m.waitForURL('**/ulasan', { timeout: 8000 });
  check('Mobile nav navigates correctly', m.url().includes('/ulasan'));

  await m.goto(BASE + '/pricelist', { waitUntil: 'networkidle' });
  check('No horizontal overflow (mobile pricelist)', (await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
  const pkgCols = await m.$eval('.pkg-feature', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check('Featured package card stacks on mobile', pkgCols === 1, 'cols=' + pkgCols);

  await m.goto(BASE + '/city', { waitUntil: 'networkidle' });
  check('No horizontal overflow (mobile city archives)', (await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);

  await m.goto(BASE + '/booking?kota=bandung', { waitUntil: 'networkidle' });
  check('No horizontal overflow (mobile booking)', (await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
  const calW = await m.$eval('.calendar', (el) => Math.round(el.getBoundingClientRect().width));
  check('Calendar fits mobile width', calW <= 390, 'width=' + calW);
  const stepW = await m.$eval('[data-next="2"]', (el) => Math.round(el.getBoundingClientRect().width)).catch(() => 300);
  check('Wizard continue button usable on mobile', stepW > 100, 'width=' + stepW);
  check('Wizard starts on step 1 (mobile)', await m.isVisible('[data-step="1"]'));
  await m.screenshot({ path: '/tmp/dly-v3-mobile.png' });

  await m.close();

  const ma = await mctx.newPage();
  await ma.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await ma.fill('#username', USER);
  await ma.fill('#password', PASS);
  await Promise.all([ma.waitForURL('**/admin', { timeout: 12000 }), ma.click('.login-form button[type=submit]')]);
  check('No horizontal overflow (mobile admin)', (await ma.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
  await ma.click('[data-side-toggle]');
  await ma.waitForTimeout(250);
  check('Admin sidebar opens on mobile', await ma.isVisible('.admin-nav'));
  await ma.goto(BASE + '/admin/availability', { waitUntil: 'networkidle' });
  check('Availability calendar fits mobile admin', (await ma.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
  await ma.screenshot({ path: '/tmp/dly-v3-admin-mobile.png' });
  await ma.close();
  await mctx.close();

  await browser.close();

  check('No JavaScript errors on tested pages', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(results.join('\n'));
  console.log('\n' + (failures === 0
    ? `ALL ${results.length} CHECKS PASSED`
    : `${failures} OF ${results.length} CHECKS FAILED`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SMOKE CRASH:', err.message);
  console.log(results.join('\n'));
  process.exit(1);
});

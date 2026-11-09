'use strict';
/* V4 focused checks: TnC page, nav visibility, duration cards, shooting time,
   simplified form, TnC consent, admin navy cards, Chat Klien template, payment settings. */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4620';
const MOCK = process.env.MOCK || '';
let f = 0;
const ck = (n, ok, x) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (x ? ' — ' + x : '')); if (!ok) f += 1; };
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

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

// V6: booking starts with the identity step, so tests must pass it first
// before interacting with the session fields (package/duration/calendar).
async function openSessionStep(page) {
  await page.goto(BASE + '/booking?kota=bandung', { waitUntil: 'networkidle' });
  if (!(await page.$('[data-step="1"] [data-terms-check]'))) return;
  await page.fill('#client_name', 'Klien V4');
  await page.fill('#client_phone', '081234567890');
  await page.fill('#instagram', 'klien.v4');
  await page.fill('#campus', 'Unpad');
  if (await page.$('#faculty')) await page.fill('#faculty', 'Teknik');
  if (await page.$('#major')) await page.fill('#major', 'Informatika');
  await page.check('[data-terms-check]');
  await page.click('[data-next="2"]');
  await page.waitForTimeout(320);
}


(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  /* ---------------- public: navigation ---------------- */
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  const nav = await p.$$eval('.site-nav a', (as) => as.map((a) => a.textContent.trim()));
  ck('Nav hides Artikel', !nav.includes('Artikel'), nav.join('|'));
  ck('Nav hides FAQ', !nav.includes('FAQ'));
  ck('Nav hides Tentang Kami', !nav.includes('Tentang Kami'));
  ck('Nav shows Syarat & Ketentuan', nav.some((t) => t.includes('Syarat')));
  ck('Nav keeps core items', ['Home', 'Gallery', 'Pricelist', 'Cara Order'].every((x) => nav.includes(x)), nav.join('|'));

  /* ---------------- public: TnC page ---------------- */
  const tnc = await p.request.get(BASE + '/syarat-ketentuan');
  ck('TnC page returns 200', tnc.status() === 200);
  await p.goto(BASE + '/syarat-ketentuan', { waitUntil: 'networkidle' });
  ck('TnC page renders the heading', (await p.textContent('h1')).includes('Syarat'));
  const tncItems = await p.$$('.tnc__list li');
  ck('TnC lists the terms', tncItems.length >= 5, 'items=' + tncItems.length);

  /* ---------------- public: hidden pages still reachable ---------------- */
  for (const path of ['/artikel', '/faq', '/tentang']) {
    const r = await p.request.get(BASE + path);
    ck(`Hidden page ${path} still loads (data preserved)`, r.status() === 200, 'status=' + r.status());
  }

  /* ---------------- booking: duration cards ---------------- */
  await openSessionStep(p);
  const slots = await p.$$eval('.slot', (els) => els.map((e) => ({
    text: e.querySelector('.slot__box').textContent.replace(/\s+/g, ' ').trim(),
    radius: getComputedStyle(e.querySelector('.slot__box')).borderRadius,
    checked: e.querySelector('input').checked
  })));
  ck('Duration cards render', slots.length === 3, 'cards=' + slots.length);
  ck('Cards are rounded (not boxy)', slots.every((s) => parseFloat(s.radius) >= 8), slots[0] && slots[0].radius);
  ck('Card shows duration + price + photos inline',
    /Menit/.test(slots[0].text) && /Rp/.test(slots[0].text) && /Foto Edit/.test(slots[0].text), slots[0].text);

  const activeBg = await p.$eval('.slot input:checked + .slot__box', (el) => getComputedStyle(el).backgroundColor);
  const activeColor = await p.$eval('.slot input:checked + .slot__box', (el) => getComputedStyle(el).color);
  ck('Active card is Deep Navy', activeBg === 'rgb(11, 35, 64)', activeBg);
  ck('Active card text is white', activeColor === 'rgb(255, 255, 255)', activeColor);
  const inactiveBg = await p.$$eval('.slot__box', (els) => {
    const el = els.find((e) => !e.previousElementSibling.checked);
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  ck('Inactive card stays light', inactiveBg === 'rgb(255, 255, 255)', inactiveBg);

  // click another duration → active state moves
  await p.click('.slot:nth-of-type(2) .slot__box');
  await p.waitForTimeout(450); // allow the colour transition to finish
  const movedBg = await p.$eval('.slot:nth-of-type(2) input:checked + .slot__box', (el) => getComputedStyle(el).backgroundColor);
  ck('Selecting another duration moves the navy state', movedBg === 'rgb(11, 35, 64)', movedBg);

  /* ---------------- booking: location + time ---------------- */
  const locLabel = await p.$eval('label[for="location"]', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  ck('Location label simplified to "Lokasi"', locLabel.startsWith('Lokasi'), locLabel);
  const locPlaceholder = await p.getAttribute('#location', 'placeholder');
  ck('Location placeholder is "Unpad - Dipatiukur"', locPlaceholder === 'Unpad - Dipatiukur', locPlaceholder);
  ck('Full address field removed from the form', (await p.$('#location_address')) === null);
  ck('Shooting time field exists', (await p.$('#shooting_time')) !== null);
  const timeType = await p.getAttribute('#shooting_time', 'type');
  ck('Shooting time uses a time picker', timeType === 'time', timeType);

  /* ---------------- booking: simplified personal data ---------------- */
  ck('Instagram MUA field removed', (await p.$('#mu_instagram')) === null);
  ck('Wardrobe field removed', (await p.$('#wardrobe_instagram')) === null);
  const igRequired = await p.getAttribute('#instagram', 'required');
  ck('Instagram is required', igRequired !== null);
  ck('Faculty is optional', (await p.getAttribute('#faculty', 'required')) === null);
  ck('Major is optional', (await p.getAttribute('#major', 'required')) === null);

  /* ---------------- booking: TnC consent ---------------- */
  const consentText = await p.$eval('[data-terms-check] + span', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  ck('Consent wording matches the brief',
    consentText.includes('Saya telah menyetujui ketentuan booking') && consentText.includes('Syarat & Ketentuan'), consentText.slice(0, 90));
  const tncLink = await p.$eval('.consent__link', (el) => ({ text: el.textContent.trim(), href: el.getAttribute('href') }));
  ck('Consent has "Baca TnC di sini" link', tncLink.text.includes('Baca TnC di sini'), tncLink.text);
  ck('Link points to the TnC page', (tncLink.href || '').includes('/syarat-ketentuan'), tncLink.href);
  const linkColor = await p.$eval('.consent__link', (el) => getComputedStyle(el).color);
  const rgb = (linkColor.match(/\d+/g) || []).map(Number);
  ck('TnC link is blue', rgb.length === 3 && rgb[2] > rgb[0] + 40 && rgb[2] > rgb[1] + 40, linkColor);
  // V6: the public form no longer asks for photo-publication consent (owner request).
  ck('Photo-publication consent removed from the public form', (await p.$('[name="photo_consent"]')) === null);

  /* ---------------- booking: validation ---------------- */
  await openSessionStep(p);   // session fields live on step 2
  const noDate = await p.evaluate(() => {
    const form = document.querySelector('[data-booking-form]');
    form.querySelector('#shooting_time').value = '';
    const ev = new Event('submit', { cancelable: true, bubbles: true });
    form.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  ck('Missing shooting time blocks continue', noDate);
  const timeErr = await p.$eval('[data-error-for="shooting_time"]', (el) => el.textContent.trim());
  ck('Time error message is shown', timeErr.length > 0, timeErr);

  /* ---------------- full happy path ---------------- */
  const picked = await p.$$eval('.calendar__grid .cal-day:not([disabled]):not(.is-empty)', (els) => {
    if (!els.length) return null;
    els[0].click();
    return els[0].dataset.date;
  });
  ck('A bookable date exists', Boolean(picked), String(picked));
  await p.fill('#shooting_time', '13:30');
  await p.fill('#location', 'Unpad - Dipatiukur');
  await p.click('[data-next="3"]');   // step 2 (session) → review
  await p.waitForTimeout(300);
  ck('Session step passes with location + time', await p.isVisible('[data-step="3"]'));

  // Identity was already completed by openSessionStep(); review must be reachable.
  ck('Reached review step', await p.isVisible('[data-step="3"]'));

  // Instagram validation still works (checked on the identity step):
  // review → session → identity.
  await p.click('[data-back="2"]');
  await p.waitForTimeout(250);
  await p.click('[data-back="1"]');
  await p.waitForTimeout(250);
  await p.fill('#instagram', '');
  await p.click('[data-next="2"]');
  await p.waitForTimeout(250);
  const igErr = await p.$eval('[data-error-for="instagram"]', (el) => el.textContent.trim());
  ck('Instagram validation blocks the identity step', await p.isVisible('[data-step="1"]') && igErr.length > 0, igErr);
  await p.fill('#instagram', 'klien.v3');
  await p.click('[data-next="2"]');
  await p.waitForTimeout(250);
  await p.click('[data-next="3"]');
  await p.waitForTimeout(300);

  const rvTime = await p.$eval('[data-rv-time]', (el) => el.textContent.trim());
  ck('Review shows the chosen time', rvTime.includes('13:30'), rvTime);
  const submitLabel = await p.$eval('[data-submit-btn]', (el) => el.textContent.trim());
  ck('Review submit button reads "Lanjut"', submitLabel === 'Lanjut', submitLabel);

  await Promise.all([
    p.waitForURL('**/booking/sukses/**', { timeout: 15000 }),
    p.click('[data-submit-btn]')
  ]);
  const success = await p.textContent('body');
  // V16 mengubah format kode booking menjadi DLY-[LAYANAN]-[NAMA]###.
  const code = (success.match(/DLY-[A-Z]+-[A-Z0-9]{3,}\d{3}/) || [''])[0];
  ck('Booking saved', Boolean(code), code);
  ck('Confirmation shows the shooting time', /13:30/.test(success));
  const waHref = await p.getAttribute('[data-wa-send]', 'href');
  const waMsg = decodeURIComponent((waHref.split('?text=')[1] || '').replace(/\+/g, ' '));
  ck('WhatsApp button uses the admin number', waHref.startsWith('https://wa.me/6289629619590'), waHref.slice(0, 42));
  ck('WhatsApp message includes the time', waMsg.includes('Jam: 13:30 WIB'), waMsg.match(/Jam: [^\n]*/)?.[0]);
  const waBtnText = await p.$eval('[data-wa-send]', (el) => el.textContent.trim());
  ck('Thank-you WhatsApp button present', /Kirim ke WhatsApp Admin/.test(waBtnText), waBtnText);

  /* ---------------- admin: payment settings ---------------- */
  await p.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await p.fill('#username', 'admin');
  await p.fill('#password', 'DlyGraduation2025');
  await Promise.all([p.waitForURL('**/admin', { timeout: 12000 }), p.click('.login-form button[type=submit]')]);

  await p.goto(BASE + '/admin/payment', { waitUntil: 'networkidle' });
  await p.fill('#bank_name', 'BCA');
  await p.fill('#account_number', '1234567890');
  await p.fill('#account_holder', 'DLY Visual Creative');
  await p.fill('#dp_amount', '150000');
  await p.fill('#notes', 'Cantumkan kode booking pada berita transfer.');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  ck('Payment settings saved', (await p.textContent('body')).includes('berhasil disimpan'));
  const preview = await p.$eval('.preview-msg', (el) => el.textContent);
  ck('Preview reflects DP amount', preview.includes('Rp150.000'), 'preview ok');
  ck('Preview reflects bank details', preview.includes('BCA') && preview.includes('1234567890'));

  /* ---------------- admin: navy booking card ---------------- */
  await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  const cardSel = `.bk-card:has-text("${code}")`;
  ck('Booking card exists', (await p.$(cardSel)) !== null, code);
  const cardStyle = await p.$eval(cardSel, (el) => ({
    bg: getComputedStyle(el).backgroundColor,
    color: getComputedStyle(el).color,
    radius: getComputedStyle(el).borderRadius
  }));
  ck('Card background is Deep Navy', cardStyle.bg === 'rgb(11, 35, 64)', cardStyle.bg);
  ck('Card text is white', cardStyle.color === 'rgb(255, 255, 255)', cardStyle.color);
  ck('Card has rounded corners', parseFloat(cardStyle.radius) >= 10, cardStyle.radius);

  // Tahap 3 splits the old single card into a compact tile + a tabbed detail page,
  // so the full field list is asserted across the detail page's four tabs.
  const v4BookingId = (await p.$eval(cardSel, (el) => el.id)).replace('b-', '');
  let detailText = '';
  for (const tabName of ['klien', 'pekerjaan', 'pembayaran', 'workflow']) {
    await p.goto(BASE + `/admin/bookings/${v4BookingId}?tab=${tabName}`, { waitUntil: 'networkidle' });
    detailText += ' ' + (await p.textContent('body'));
  }
  for (const label of ['WhatsApp', 'Instagram', 'Kampus', 'Kota', 'Tanggal', 'Jam', 'Lokasi',
    'Kategori', 'Paket', 'Durasi', 'Add-on']) {
    ck(`Detail shows "${label}"`, new RegExp(label, 'i').test(detailText));
  }
  ck('Detail shows the total bill snapshot',
    /total tagihan/i.test(detailText) && /Rp/.test(detailText));
  ck('Detail shows the shooting time', /13:30/.test(detailText));
  ck('Detail shows Google Calendar status', /Calendar|kalender/i.test(detailText));
  ck('Detail shows Google Drive status', /Drive/i.test(detailText));

  /* ---------------- admin: Chat Klien template ---------------- */
  await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  const chatHref = await p.$eval(`${cardSel} [data-chat-client]`, (el) => el.getAttribute('href'));
  const chatMsg = decodeURIComponent((chatHref.split('?text=')[1] || '').replace(/\+/g, ' '));
  ck('Chat Klien targets the client number', chatHref.startsWith('https://wa.me/6281234567890'), chatHref.slice(0, 40));
  // The template text is editable by the owner, so assert the DATA contract:
  // the client's details must actually reach the message.
  ck('Template greets the client by name', /Halo Kak Klien V4/.test(chatMsg), chatMsg.slice(0, 46));
  ck('Template includes the formatted date',
    /Tanggal:.*\d{4}/.test(chatMsg)
    && /(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)/.test(chatMsg),
    (chatMsg.match(/Tanggal:.*/) || [''])[0].slice(0, 44));
  ck('Template includes the time', /13:30 WIB/.test(chatMsg), (chatMsg.match(/Jam.*/) || [''])[0].slice(0, 40));
  // The default confirm template asks for the DP instead of repeating the full order,
  // so assert the payment contract (which is what the owner's template actually promises).
  ck('Template includes the DP amount', /Rp100\.000|Rp150\.000/.test(chatMsg), (chatMsg.match(/DP.*/) || [''])[0].slice(0, 40));
  ck('Template includes the bank name', /BCA/.test(chatMsg), (chatMsg.match(/Bank.*/) || [''])[0].slice(0, 40));
  ck('No damaged characters in the message', !chatMsg.includes('\uFFFD'));
  const lineBreaks = (chatMsg.match(/\n/g) || []).length;
  ck('Template keeps line breaks (WhatsApp friendly)', lineBreaks >= 6, 'newlines=' + lineBreaks);

  /* ---------------- admin: operations still work ---------------- */
  await p.goto(BASE + `/admin/bookings/${v4BookingId}?tab=workflow`, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${v4BookingId}`, 'confirmed');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }),
    p.locator('#workflow .bd-update-form button[type=submit]').click()]);
  ck('Status update still works', /confirmed/i.test(await p.locator('#workflow').innerText()));

  /* ---------------- admin: page visibility ---------------- */
  await p.goto(BASE + '/admin/pages', { waitUntil: 'networkidle' });
  ck('Pages screen lists the toggles', (await p.$$('.page-toggle')).length >= 7);
  await p.check('input[name="page_faq_visible"]');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  ck('Page visibility saved', (await p.textContent('body')).includes('berhasil disimpan'));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  const navAfter = await p.$$eval('.site-nav a', (as) => as.map((a) => a.textContent.trim()));
  ck('Enabling FAQ shows it in the nav', navAfter.includes('FAQ'), navAfter.join('|'));
  // restore the requested state (hidden)
  await p.goto(BASE + '/admin/pages', { waitUntil: 'networkidle' });
  await p.uncheck('input[name="page_faq_visible"]');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);

  /* ---------------- cleanup ---------------- */
  await p.goto(BASE + `/admin/bookings/${v4BookingId}?tab=workflow`, { waitUntil: 'networkidle' });
  p.once("dialog", (d) => d.accept());
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }),
    p.locator('form[action$="/delete"] button').click()]);
  await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  ck('Test booking deleted', (await p.locator(`.bk-card:has-text("${code}")`).count()) === 0);

  ck('No JavaScript errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await p.close();
  await ctx.close();
  await br.close();

  console.log(f === 0 ? `ALL ${'PASSED'}` : f + ' FAILED');
  process.exit(f ? 1 : 0);
})();

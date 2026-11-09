'use strict';
/* Focused check: edited-photo count is per duration (client + admin). */
const { chromium } = require('playwright');
const B = process.env.BASE || 'http://127.0.0.1:4472';
let f = 0;
const ck = (n, ok, x) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (x ? ' — ' + x : '')); if (!ok) f += 1; };

(async () => {
  const br = await chromium.launch();
  const p = await br.newPage();
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await p.goto(B + '/pricelist?kota=bandung', { waitUntil: 'networkidle' });
  const cards = await p.$$eval('[data-pkg-card]', (els) => els.map((e) => ({
    name: e.querySelector('.pkg-feature__title').textContent.trim(),
    durs: Array.from(e.querySelectorAll('.dur-card')).map((d) => d.dataset.duration + 'm/' + d.dataset.photos + 'foto')
  })));
  console.log('cards:', JSON.stringify(cards));
  const first = await p.$eval('[data-pkg-card] [data-photos-display]', (el) => el.textContent.trim());
  ck('Spec block shows a photo count', first.includes('foto'), first);

  await p.click('[data-pkg-card] .dur-card[data-duration="90"]');
  await p.waitForTimeout(200);
  const note = await p.$eval('[data-pkg-card] [data-price-note]', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  ck('Price note includes photo count', /foto edit/.test(note), note);

  await p.goto(B + '/admin/login');
  await p.fill('#username', 'admin');
  await p.fill('#password', 'DlyGraduation2025');
  await Promise.all([p.waitForURL('**/admin'), p.click('.login-form button[type=submit]')]);
  // Tahap 3 replaced the flat grouped list with 6 collapsible `.nav-group` blocks.
  const groups = await p.$$eval('[data-nav-group]', (els) => els.map((e) => e.getAttribute('data-nav-group')));
  ck('Sidebar is grouped', groups.length === 6, groups.join(' | '));

  await p.goto(B + '/admin/durations', { waitUntil: 'networkidle' });
  ck('Durations screen exposes photo inputs', (await p.$$('input[name^="photos_"]')).length === 9);

  await p.goto(B + '/admin/packages/2/edit', { waitUntil: 'networkidle' });
  ck('Package form uses the duration table', (await p.$$('[data-duration-row]')).length === 3);
  await p.fill('input[name="dur_photos_0"]', '20');
  await p.fill('input[name="dur_photos_1"]', '35');
  await p.fill('input[name="dur_photos_2"]', '50');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  ck('Package saved', (await p.textContent('body')).includes('berhasil'));

  await p.goto(B + '/pricelist?kota=bandung', { waitUntil: 'networkidle' });
  const per = await p.$$eval('[data-pkg-card] .dur-card', (els) => els.slice(0, 3).map((d) => d.dataset.duration + '→' + d.dataset.photos));
  console.log('after edit:', per.join(' , '));
  ck('60m = 20 photos', per[0].endsWith('→20'), per[0]);
  ck('90m = 35 photos', per[1].endsWith('→35'), per[1]);
  ck('120m = 50 photos', per[2].endsWith('→50'), per[2]);

  await p.click('[data-pkg-card] .dur-card[data-duration="120"]');
  await p.waitForTimeout(200);
  const spec120 = await p.$eval('[data-pkg-card] [data-photos-display]', (el) => el.textContent.trim());
  ck('Selecting 120m shows the 50-photo value', spec120.includes('50'), spec120);

  await p.goto(B + '/booking?kota=bandung&paket=2&durasi=90', { waitUntil: 'networkidle' });
  const optText = await p.$$eval('[data-duration-options] .slot', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ck('Booking durations show photo count', optText.some((t) => /35\s*foto\s*edit/i.test(t)), optText.join(' | '));

  // durations screen must also persist photo values
  await p.goto(B + '/admin/durations', { waitUntil: 'networkidle' });
  const photoName = await p.$$eval('input[name^="photos_"]', (els) => els[0].name);
  await p.fill(`input[name="${photoName}"]`, '22');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-sticky-actions button[type=submit]')]);
  await p.goto(B + '/pricelist?kota=bandung', { waitUntil: 'networkidle' });
  const afterScreen = await p.$eval('[data-pkg-card] .dur-card', (d) => d.dataset.photos);
  ck('Durations screen saves photo count', afterScreen === '22', afterScreen);

  await p.close();
  await br.close();
  console.log(f === 0 ? 'ALL PASSED' : f + ' FAILED');
  process.exit(f ? 1 : 0);
})();

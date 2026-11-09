'use strict';
/* V5 checks: calendar description (no price/photos), team assignment + invitee,
   scroll reveal, private testimonial form. */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4810';
let f = 0;
const ck = (n, ok, x) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (x ? ' — ' + x : '')); if (!ok) f += 1; };

const PNG = '/tmp/dly-v5.png';
fs.writeFileSync(PNG, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGRgQEAGZ4C/e1vJ0kAAAAASUVORK5CYII=',
  'base64'
));

(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  /* ---------------- admin login ---------------- */
  await p.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await p.fill('#username', 'admin');
  await p.fill('#password', 'DlyGraduation2025');
  await Promise.all([p.waitForURL('**/admin', { timeout: 15000 }), p.click('.login-form button[type=submit]')]);

  /* ---------------- team CRUD ---------------- */
  await p.goto(BASE + '/admin/team/new', { waitUntil: 'networkidle' });
  await p.fill('#name', 'Fadhli Uji');
  await p.fill('#email', 'fadhli.uji@example.com');
  await p.fill('#role', 'Fotografer');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  ck('Team member created', (await p.textContent('body')).includes('berhasil ditambahkan'));
  await p.goto(BASE + '/admin/team', { waitUntil: 'networkidle' });
  ck('Team list shows the member', (await p.textContent('.admin-table')).includes('Fadhli Uji'));
  ck('Team list shows the email', (await p.textContent('.admin-table')).includes('fadhli.uji@example.com'));

  await p.goto(BASE + '/admin/team/new', { waitUntil: 'networkidle' });
  await p.fill('#name', 'Tanpa Email');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  await p.goto(BASE + '/admin/team', { waitUntil: 'networkidle' });
  ck('Member without email is flagged', (await p.textContent('.admin-table')).includes('email kosong'));

  /* ---------------- assign team on a booking ---------------- */
  await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  const hasBooking = (await p.locator('.bk-card').count()) > 0;
  ck('A booking exists to assign', hasBooking);
  if (hasBooking) {
    const card = p.locator('.bk-card').first();
    const id = (await card.getAttribute('id')).replace('b-', '');
    // Tahap 3: the team selector lives on the booking detail page (Workflow tab).
    await p.goto(BASE + `/admin/bookings/${id}?tab=workflow`, { waitUntil: 'networkidle' });
    ck('Team selector present on the booking detail page', (await p.$(`#team-${id}`)) !== null);

    const options = await p.$$eval(`#team-${id} option`, (os) => os.map((o) => o.textContent.trim()));
    ck('Team options come from the team list', options.some((o) => o.includes('Fadhli Uji')), options.join(' | '));

    const teamValue = await p.$eval(`#team-${id}`, (sel) => {
      const opt = Array.from(sel.options).find((o) => o.textContent.includes('Fadhli Uji'));
      return opt ? opt.value : '';
    });
    await p.selectOption(`#team-${id}`, teamValue);
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }),
      p.locator('#workflow .bd-update-form button[type=submit]').click()]);
    const detailText = await p.locator('#workflow').textContent();
    ck('Assigned team is shown on the detail page', detailText.includes('Fadhli Uji'), detailText.match(/Fadhli[^\n]{0,40}/)?.[0]);
    ck('Invitation email is shown on the detail page', detailText.includes('fadhli.uji@example.com'));
    await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
    const cardText = await p.locator('.bk-card').first().textContent();
    ck('Assigned team is shown on the grid tile', cardText.includes('Fadhli Uji'));
  }

  /* ---------------- scroll reveal ---------------- */
  await p.goto(BASE + '/pricelist', { waitUntil: 'networkidle' });
  const revealCount = await p.locator('.reveal').count();
  ck('Scroll reveal classes applied', revealCount >= 3, 'elements=' + revealCount);
  const inViewVisible = await p.$$eval('.reveal', (els) => els.filter((e) => e.getBoundingClientRect().top < window.innerHeight).every((e) => e.classList.contains('is-in')));
  ck('Content already in view is visible immediately', inViewVisible);

  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(900);
  const afterScroll = await p.$$eval('.reveal', (els) => els.filter((e) => e.getBoundingClientRect().top < window.innerHeight - 40).every((e) => e.classList.contains('is-in')));
  ck('Elements reveal after scrolling', afterScroll);

  const anyHiddenForever = await p.$$eval('.reveal', (els) => els.some((e) => {
    const cs = getComputedStyle(e);
    return cs.opacity === '0' && e.getBoundingClientRect().top < window.innerHeight;
  }));
  ck('No visible element stays invisible', !anyHiddenForever);

  /* ---------------- private testimonial link ---------------- */
  await p.goto(BASE + '/admin/testimonial-link', { waitUntil: 'networkidle' });
  const linkValue = await p.inputValue('#testimonial-link');
  ck('Testimonial link is generated', /\/testimoni\/[a-f0-9]{16,}/.test(linkValue), linkValue);
  const path = new URL(linkValue).pathname;

  // must NOT appear anywhere on the public site
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  const homeHtml = await p.content();
  const token = path.split('/').pop();
  ck('Private link is not exposed on the public site', !homeHtml.includes(token));

  // open the form (as a visitor would, in its own browser instance: 1 tab per instance)
  const vbr = await chromium.launch();
  const vctx = await vbr.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const v = await vctx.newPage();
  const res = await v.goto(BASE + path, { waitUntil: 'networkidle' });
  ck('Private testimonial page loads', res.status() === 200);
  ck('Private page is noindex', (await v.content()).includes('noindex, nofollow'));
  const fields = await v.$$eval('[name]', (els) => [...new Set(els.map((e) => e.name))]);
  ck('Form has name/campus/quote/rating/photo',
    ['name', 'campus', 'quote', 'rating', 'photo'].every((x) => fields.includes(x)), fields.join(','));

  const badToken = await v.goto(BASE + '/testimoni/token-palsu', { waitUntil: 'networkidle' });
  ck('Wrong token is rejected', badToken.status() === 404, 'status=' + badToken.status());

  await v.goto(BASE + path, { waitUntil: 'networkidle' });
  await v.fill('#name', 'Klien Testimoni, S.Pd');
  await v.fill('#campus', 'Universitas Padjadjaran');
  await v.fill('#quote', 'Sesi fotonya santai, arahan fotografernya jelas, dan hasil editnya memuaskan sekali.');
  await v.click('.tst-star:has(input[value="5"]) span[aria-hidden]');
  ck('Star rating selectable', await v.isChecked('input[name="rating"][value="5"]'));
  await v.setInputFiles('#photo', PNG);
  await Promise.all([v.waitForNavigation({ waitUntil: 'networkidle' }), v.click('.tst-form__actions button[type=submit]')]);
  ck('Submission shows the thank-you state', (await v.textContent('body')).includes('Terima kasih'));

  // moderation default: hidden until approved
  await p.goto(BASE + '/ulasan', { waitUntil: 'networkidle' });
  ck('Pending testimonial is NOT public yet', !(await p.textContent('body')).includes('Klien Testimoni'));
  await p.goto(BASE + '/admin/testimonials', { waitUntil: 'networkidle' });
  const row = p.locator('tr', { hasText: 'Klien Testimoni' });
  ck('Submission listed in admin', (await row.count()) === 1);
  const rowText = await row.textContent();
  ck('Admin sees it as a client submission awaiting approval', rowText.includes('Klien') && rowText.includes('Menunggu'), rowText.replace(/\s+/g, ' ').slice(0, 80));
  ck('Admin sees the uploaded photo', (await row.locator('img').count()) === 1);

  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), row.locator('form[action$="/toggle"] button').click()]);
  await p.goto(BASE + '/ulasan', { waitUntil: 'networkidle' });
  const rv = await p.textContent('body');
  ck('Approved testimonial appears publicly', rv.includes('Klien Testimoni'));
  ck('Public card shows the campus', rv.includes('Universitas Padjadjaran'));
  ck('Public card shows the photo', (await p.locator('.testimonial__avatar img').count()) >= 1);

  /* ---------------- auto-approve setting ---------------- */
  await p.goto(BASE + '/admin/testimonial-link', { waitUntil: 'networkidle' });
  await p.check('input[name="auto_approve"]');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  await p.goto(BASE + path, { waitUntil: 'networkidle' });
  await p.fill('#name', 'Otomatis Tampil, S.Kom');
  await p.fill('#campus', 'ITB');
  await p.fill('#quote', 'Pengalaman kedua yang juga menyenangkan, hasil fotonya rapi dan cepat dikirim.');
  await p.click('.tst-star:has(input[value="4"]) span[aria-hidden]');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.tst-form__actions button[type=submit]')]);
  await p.goto(BASE + '/ulasan', { waitUntil: 'networkidle' });
  ck('Auto-approve publishes immediately', (await p.textContent('body')).includes('Otomatis Tampil'));
  // restore default (moderated)
  await p.goto(BASE + '/admin/testimonial-link', { waitUntil: 'networkidle' });
  await p.uncheck('input[name="auto_approve"]');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);

  /* ---------------- cleanup ---------------- */
  await p.goto(BASE + '/admin/testimonials', { waitUntil: 'networkidle' });
  for (const name of ['Klien Testimoni', 'Otomatis Tampil']) {
    const r = p.locator('tr', { hasText: name });
    if (await r.count()) {
      p.once('dialog', (d) => d.accept());
      await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), r.locator('form[action$="/delete"] button').click()]);
    }
  }
  ck('Test testimonial submissions removed', !(await p.textContent('.admin-table')).includes('Klien Testimoni'));

  await p.goto(BASE + '/admin/team', { waitUntil: 'networkidle' });
  for (const name of ['Fadhli Uji', 'Tanpa Email']) {
    const r = p.locator('tr', { hasText: name });
    if (await r.count()) {
      p.once('dialog', (d) => d.accept());
      await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), r.locator('form[action$="/delete"] button').click()]);
    }
  }
  ck('Test team members removed', !(await p.textContent('.admin-table')).includes('Fadhli Uji'));

  ck('No JavaScript errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await v.close();
  await vctx.close();
  await vbr.close();
  await p.close();
  await ctx.close();
  await br.close();
  console.log(f === 0 ? 'ALL PASSED' : f + ' FAILED');
  process.exit(f ? 1 : 0);
})();

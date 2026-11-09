'use strict';

/**
 * Tahap 7 — review screenshots.
 *
 * Runs against a COPY of the database plus scripts/mock-google.js, so the Google Calendar
 * event and Drive folder can be shown without touching the owner's real calendar.
 * Every Google screenshot is labelled as coming from the test environment.
 *
 *   node scripts/review-shots7.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.R7_PORT || 4545);
const MOCK_PORT = Number(process.env.R7_MOCK_PORT || 4597);
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const DATA_DIR = '/tmp/dly-review7';
const OUT = path.join(APP, 'public', process.env.REVIEW7_OUT || 'review-t7');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [];

const pad = (n) => String(n).padStart(2, '0');
const iso = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) {}
}

function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const stamp = Date.now().toString().slice(-6);
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
  const members = db.prepare('SELECT id, name, email FROM team_members WHERE is_active = 1 ORDER BY sort_order').all();

  // Clean, demo-looking fixture (the owner's real booking is left untouched in the copy).
  db.prepare("UPDATE bookings SET client_name = 'Vieke Melani', client_phone = '6281200000001', instagram = 'vieke.melani', campus = 'ITB', location = 'Gedung Sate, Bandung', status = 'pending', gcal_event_id = NULL, gcal_event_url = NULL, drive_folder_url = NULL, drive_folder_id = NULL, shooting_date = ?, shooting_time = '09:00', total_price_snapshot = 550000").run(iso(6));
  const id = db.prepare("SELECT id FROM bookings ORDER BY id LIMIT 1").get().id;
  db.prepare('DELETE FROM booking_team WHERE booking_id = ?').run(id);
  db.prepare('DELETE FROM booking_payments WHERE booking_id = ?').run(id);

  // Portfolio with a gallery for the public screenshots.
  const ups = fs.readdirSync(path.join(APP, 'public', 'uploads')).filter((f) => /\.(jpe?g)$/i.test(f)).slice(0, 6).map((f) => `/uploads/${f}`);
  const pf = db.prepare('SELECT id, slug FROM portfolio WHERE is_active = 1 ORDER BY sort_order LIMIT 1').get();
  const insPf = db.prepare("INSERT INTO portfolio_images (portfolio_id, image, caption, is_primary, sort_order) VALUES (?, ?, '', 0, ?)");
  const have = db.prepare('SELECT COUNT(*) AS n FROM portfolio_images WHERE portfolio_id = ?').get(pf.id).n;
  if (have < 4 && ups.length >= 4) [0, 1, 2, 3].forEach((i) => insPf.run(pf.id, ups[i], have + i));

  // Package gallery for the pricelist carousel.
  const insPkg = db.prepare("INSERT INTO package_images (package_id, image, caption, is_primary, sort_order) VALUES (?, ?, '', 0, ?)");
  const havePkg = db.prepare('SELECT COUNT(*) AS n FROM package_images WHERE package_id = ?').get(pkg.id).n;
  if (havePkg < 2 && ups.length >= 2) [0, 1].forEach((i) => insPkg.run(pkg.id, ups[i], havePkg + i));

  db.close();
  return { id, pf, members, pkg, stamp };
}

const shot = async (page, file, label, opts = {}) => {
  await sleep(opts.wait || 500);
  const target = path.join(OUT, file);
  if (opts.clip) await page.locator(opts.clip).screenshot({ path: target });
  else await page.screenshot({ path: target, fullPage: Boolean(opts.full) });
  SHOTS.push({ file, label });
  console.log('shot', file);
};

(async () => {
  prepareDataDir();
  fs.mkdirSync(OUT, { recursive: true });

  const mock = spawn(process.execPath, [path.join(APP, 'scripts', 'mock-google.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1',
      GCAL_TOKEN_URL: `${MOCK}/token`, GCAL_AUTH_URL: `${MOCK}/auth`,
      GCAL_API_BASE: `${MOCK}/calendar/v3`, GDRIVE_API_BASE: `${MOCK}/drive/v3`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  let eventSnapshot = null;
  try {
    for (let i = 0; i < 120; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    await fetch(`${MOCK}/__reset`).catch(() => {});

    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.on('dialog', (d) => d.accept());

    /* ---------- public site ---------- */
    await page.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    await sleep(1200);
    await shot(page, '30-pricelist-icons.png', 'Pricelist — ikon kategori + tombol kota', { full: true });
    await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    await sleep(1000);
    await shot(page, '31-gallery-identity.png', 'Gallery — identitas client pada thumbnail', { full: true });
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(1200);
    await shot(page, '32-featured-identity.png', 'Featured Portfolio — identitas client', { full: true });
    await page.goto(`${BASE}/portfolio/${seedSlug(0)}`, { waitUntil: 'load' }).catch(() => {});
    await sleep(800);
    await shot(page, '33-portfolio-client.png', 'Halaman detail portfolio client', { full: true });

    /* ---------- login + google connect ---------- */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    await page.goto(`${BASE}/admin/google`, { waitUntil: 'load' });
    await page.fill('#client_id', 'test-client.apps.googleusercontent.com');
    await page.fill('#client_secret', 'test-secret');
    await page.fill('#calendar_id', 'primary');
    await page.fill('#timezone', 'Asia/Jakarta');
    await Promise.all([page.waitForNavigation(), page.click('.admin-form__actions button[type=submit]')]);

    const csrf1 = await page.inputValue('input[name="_csrf"]');
    const cr = await page.request.post(`${BASE}/admin/google/connect`, { form: { _csrf: csrf1 }, maxRedirects: 0, failOnStatusCode: false });
    await page.goto(`${BASE}/admin/google/callback?code=test-auth-code&state=${new URL(cr.headers().location, BASE).searchParams.get('state')}`, { waitUntil: 'load' });
    await page.goto(`${BASE}/admin/google`, { waitUntil: 'load' });
    const csrf2 = await page.inputValue('input[name="_csrf"]');
    const dr = await page.request.post(`${BASE}/admin/google/connect-drive`, { form: { _csrf: csrf2 }, maxRedirects: 0, failOnStatusCode: false });
    await page.goto(`${BASE}/admin/google/callback?code=test-drive-code&state=${new URL(dr.headers().location, BASE).searchParams.get('state')}`, { waitUntil: 'load' });

    await fetch(`${MOCK}/__reset`).catch(() => {});
    const fx = seed();
    const detail = `${BASE}/admin/bookings/${fx.id}?tab=workflow`;

    /* ---------- team + confirmation ---------- */
    await page.goto(detail, { waitUntil: 'load' });
    await shot(page, '01-workflow-before.png', 'Workflow sebelum konfirmasi (pilih tim)', { full: true });
    await page.click(`.bd-team-pick:has(input[value="${fx.members[0].id}"])`);
    await page.click(`.bd-team-pick:has(input[value="${fx.members[1].id}"])`);
    await shot(page, '02-team-picker.png', 'Pemilihan tim yang bertugas', { clip: '#tim' });
    await Promise.all([page.waitForNavigation(), page.click('#tim button[type="submit"]')]);
    await shot(page, '03-team-saved.png', 'Tim tersimpan pada booking', { clip: '#tim' });

    await Promise.all([page.waitForNavigation(), page.click('[data-confirm-summary] [data-confirm-btn]')]);
    await shot(page, '04-workflow-confirmed.png', 'Workflow setelah konfirmasi (kalender + Drive)', { full: true });

    const mockState = await (await fetch(`${MOCK}/__state`)).json();
    eventSnapshot = mockState.events[0] || null;
    fs.writeFileSync(path.join(OUT, 'calendar-event.json'), JSON.stringify(eventSnapshot, null, 2));
    fs.writeFileSync(path.join(OUT, 'drive-folders.json'), JSON.stringify(mockState.folders || [], null, 2));

    /* ---------- team change after confirmation ---------- */
    await page.goto(detail, { waitUntil: 'load' });
    await page.click(`.bd-team-pick:has(input[value="${fx.members[1].id}"])`);
    await page.click(`.bd-team-pick:has(input[value="${fx.members[2].id}"])`);
    await Promise.all([page.waitForNavigation(), page.click('#tim button[type="submit"]')]);
    await shot(page, '05-team-changed.png', 'Ganti anggota tim setelah konfirmasi', { clip: '#tim' });
    const afterSwap = await (await fetch(`${MOCK}/__state`)).json();
    fs.writeFileSync(path.join(OUT, 'calendar-attendees-after-swap.json'),
      JSON.stringify((afterSwap.events[0] && afterSwap.events[0].attendees) || [], null, 2));

    /* ---------- payments ---------- */
    await page.goto(`${BASE}/admin/bookings/${fx.id}?tab=pembayaran`, { waitUntil: 'load' });
    await shot(page, '06-payment-before.png', 'Pembayaran — sebelum DP', { full: true });
    await Promise.all([page.waitForNavigation(), page.click('form[action$="/payments/quick"] button')]);
    await shot(page, '07-payment-dp.png', 'Pembayaran — DP Rp100.000 tercatat', { full: true });
    await Promise.all([page.waitForNavigation(), page.click('form[action$="/payments/quick"] button')]);
    await shot(page, '08-payment-paid.png', 'Pembayaran — Lunas', { full: true });

    /* ---------- reschedule ---------- */
    await page.goto(detail, { waitUntil: 'load' });
    await page.click('[data-toggle-reschedule]');
    await page.fill('#rs-date', iso(13));
    await page.fill('#rs-time', '14:30');
    await page.fill('#rs-loc', 'Gedung Sate, Bandung');
    await page.fill('#rs-reason', 'Permintaan client');
    await sleep(300);
    await shot(page, '09-reschedule-form.png', 'Formulir Reschedule Booking', { clip: '#reschedule' });
    await Promise.all([page.waitForNavigation(), page.click('[data-reschedule-form] button[type="submit"]')]);
    await shot(page, '10-reschedule-history.png', 'Riwayat reschedule + tombol WhatsApp', { full: true });
    const afterRs = await (await fetch(`${MOCK}/__state`)).json();
    fs.writeFileSync(path.join(OUT, 'calendar-after-reschedule.json'), JSON.stringify(afterRs.events[0] || {}, null, 2));

    /* ---------- availability ---------- */
    await page.goto(`${BASE}/admin/availability`, { waitUntil: 'load' });
    await shot(page, '11-availability.png', 'Kalender Tersedia / Full Booking / Ditutup', { full: true });
    await page.evaluate((d) => {
      const cell = document.querySelector(`[data-avail-day="${d}"]`);
      if (cell) cell.scrollIntoView({ block: 'center' });
      if (cell) cell.click();
    }, iso(20));
    await shot(page, '12-availability-panel.png', 'Panel Full Booking manual', { clip: '.avail-day' });

    /* ---------- sidebar ---------- */
    await page.goto(`${BASE}/admin/bookings`, { waitUntil: 'load' });
    const heads = page.locator('[data-nav-group] [data-nav-toggle-group]');
    const count = await heads.count();
    for (let i = 0; i < count; i += 1) {
      const open = await page.locator('[data-nav-group]').nth(i).evaluate((el) => el.classList.contains('is-open'));
      if (!open) await heads.nth(i).click();
    }
    await sleep(500);
    await page.locator('[data-side]').screenshot({ path: path.join(OUT, '13-sidebar-open.png') });
    SHOTS.push({ file: '13-sidebar-open.png', label: 'Sidebar — semua grup terbuka' });
    await page.click('[data-nav-group="konten"] [data-nav-toggle-group]');
    await sleep(600);
    await page.locator('[data-side]').screenshot({ path: path.join(OUT, '14-sidebar-collapsed-group.png') });
    SHOTS.push({ file: '14-sidebar-collapsed-group.png', label: 'Sidebar — satu grup ditutup (menu di bawah naik)' });

    /* ---------- portfolio admin ---------- */
    await page.goto(`${BASE}/admin/portfolio/${fx.pf.id}/edit`, { waitUntil: 'load' });
    await shot(page, '15-portfolio-form.png', 'Form Edit Portfolio (3 bagian)', { full: true });
    const realImgs = fs.readdirSync(path.join(APP, 'public', 'uploads')).filter((f) => /\.(jpe?g)$/i.test(f)).slice(0, 3);
    const files = realImgs.map((f, i) => {
      const to = path.join(require('os').tmpdir(), `r7-${i}-${f}`);
      fs.copyFileSync(path.join(APP, 'public', 'uploads', f), to);
      return to;
    });
    await page.setInputFiles('#photo_files', files);
    await sleep(600);
    await shot(page, '16-portfolio-upload-preview.png', 'Pratinjau multi-file sebelum diunggah', { clip: '.pf-upload' });

    /* ---------- mobile ---------- */
    const mobBrowser = await chromium.launch();
    const mob = await mobBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await mob.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await mob.fill('input[name="username"]', 'admin');
    await mob.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([mob.waitForNavigation(), mob.click('button[type="submit"]')]);
    await mob.goto(detail, { waitUntil: 'load' });
    await shot(mob, '20-mobile-workflow.png', 'Workflow booking — mobile', { full: true, wait: 800 });
    await mob.goto(`${BASE}/admin/bookings/${fx.id}?tab=pembayaran`, { waitUntil: 'load' });
    await shot(mob, '21-mobile-payment.png', 'Pembayaran — mobile', { full: true, wait: 600 });
    await mob.goto(`${BASE}/admin/availability`, { waitUntil: 'load' });
    await shot(mob, '22-mobile-availability.png', 'Jadwal Tersedia — mobile', { full: true, wait: 600 });
    await mob.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    await sleep(900);
    await shot(mob, '23-mobile-pricelist.png', 'Pricelist — mobile (ikon kategori)', { wait: 400 });
    await mob.goto(`${BASE}/portfolio/${seedSlug(0)}`, { waitUntil: 'load' }).catch(() => {});
    await shot(mob, '24-mobile-portfolio-client.png', 'Halaman portfolio client — mobile', { full: true, wait: 700 });
    await mobBrowser.close();

    await page.close();
  } finally {
    await browser.close();
    app.kill();
    mock.kill();
  }

  /* ---------------- review page ---------------- */
  const groups = [
    ['Booking & operasional', ['01-workflow-before.png', '02-team-picker.png', '03-team-saved.png', '04-workflow-confirmed.png', '05-team-changed.png']],
    ['Pembayaran', ['06-payment-before.png', '07-payment-dp.png', '08-payment-paid.png']],
    ['Reschedule', ['09-reschedule-form.png', '10-reschedule-history.png']],
    ['Jadwal & Full Booking', ['11-availability.png', '12-availability-panel.png']],
    ['Sidebar accordion', ['13-sidebar-open.png', '14-sidebar-collapsed-group.png']],
    ['Portfolio (admin & publik)', ['15-portfolio-form.png', '16-portfolio-upload-preview.png', '31-gallery-identity.png', '32-featured-identity.png', '33-portfolio-client.png']],
    ['Pricelist', ['30-pricelist-icons.png']],
    ['Mobile', ['20-mobile-workflow.png', '21-mobile-payment.png', '22-mobile-availability.png', '23-mobile-pricelist.png', '24-mobile-portfolio-client.png']]
  ];
  const labelFor = (f) => (SHOTS.find((s) => s.file === f) || {}).label || f;
  const ev = eventSnapshot ? JSON.stringify(eventSnapshot, null, 2) : '(tidak ada)';
  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DLY Graduation — Review Tahap 7</title>
<meta name="robots" content="noindex, nofollow">
<style>
  :root { --navy:#0B2340; --teal:#2C5E73; --warm:#F7F6F2; --line:#E3E5E7; }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 20px 80px; background:var(--warm); color:#252A30; font:15px/1.6 Inter,system-ui,sans-serif; }
  .wrap { max-width:1240px; margin:0 auto; }
  h1 { font-size:clamp(1.7rem,4vw,2.5rem); margin:8px 0 10px; color:var(--navy); }
  .eyebrow { font-size:.62rem; letter-spacing:.22em; text-transform:uppercase; color:var(--teal); }
  p.lede { color:#5F6B7A; max-width:760px; }
  h2 { font-size:1.05rem; margin:36px 0 14px; color:var(--navy); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:20px; }
  figure { margin:0; background:#fff; border:1px solid var(--line); border-radius:16px; overflow:hidden;
           box-shadow:0 2px 6px rgba(11,35,64,.05),0 16px 34px rgba(11,35,64,.07); }
  figure img { display:block; width:100%; height:auto; max-height:540px; object-fit:cover; object-position:top; }
  figcaption { padding:11px 14px; font-size:.8rem; display:flex; justify-content:space-between; gap:10px; }
  figcaption a { color:var(--teal); font-size:.74rem; }
  pre { background:#0B2340; color:#E7EEF5; padding:16px; border-radius:12px; overflow:auto; font-size:.72rem; line-height:1.5; }
  .note { margin-top:36px; padding:14px 16px; border:1px dashed #C9CDD1; border-radius:12px; color:#5F6B7A; font-size:.82rem; }
</style></head><body><div class="wrap">
<header>
  <span class="eyebrow">DLY Graduation · Tahap 7</span>
  <h1>Booking, Tim, Google, Pembayaran, Reschedule, Full Booking</h1>
  <p class="lede">Tangkapan layar hasil pekerjaan Tahap 7. Halaman Google Calendar &amp; Google Drive
  diambil dari <strong>lingkungan uji (mock Google)</strong> supaya kalender asli Anda tidak tersentuh;
  isi event dan nama folder di bawah adalah payload yang benar-benar dikirim aplikasi.</p>
</header>
${groups.map(([title, files]) => `<h2>${title}</h2><div class="grid">
${files.map((f) => `<figure><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="${labelFor(f)}" loading="lazy"></a>
<figcaption><span>${labelFor(f)}</span><a href="${f}" target="_blank" rel="noopener">Buka</a></figcaption></figure>`).join('\n')}
</div>`).join('\n')}
<h2>Payload event Google Calendar (lingkungan uji)</h2>
<pre>${ev.replace(/</g, '&lt;')}</pre>
<div class="note">Halaman review ini hanya untuk pemeriksaan hasil dan boleh dihapus kapan saja
(folder <code>public/review-t7</code>) tanpa memengaruhi website.</div>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\nReview page: ${OUT}/index.html`);
})().catch((e) => { console.error(e); process.exit(1); });

function seedSlug() {
  try {
    const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const row = db.prepare('SELECT slug FROM portfolio WHERE is_active = 1 ORDER BY sort_order LIMIT 1').get();
    db.close();
    return row ? row.slug : '';
  } catch (err) { return ''; }
}

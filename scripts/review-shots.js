'use strict';

/**
 * Tahap 3 review screenshots.
 *
 * Boots the app on a COPY of the database (never the live one) with DEMO bookings —
 * the real client's name/phone are replaced, so nothing personal ends up in a PNG that
 * gets shared for review. Captures the public pages and the admin dashboard / Kelola
 * Booking (4 view modes) / detail tabs, at desktop and mobile, then writes a small
 * index.html gallery next to the images.
 *
 *   node scripts/review-shots.js            # → public/review-t3/index.html
 *   REVIEW_OUT=public/review-x node scripts/review-shots.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.REVIEW_PORT || 4533);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-review';
const OUT = path.join(APP, process.env.REVIEW_OUT || 'public/review-t6-7509d4b7343d');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Throwaway DB copy with demo data                                    */
/* ------------------------------------------------------------------ */
function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, 'image-cache'), { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try {
    fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true });
  } catch (err) { /* cold cache is fine */ }

}

/** Demo rows are written AFTER the app boots, because the additive migrations that
 *  create booking_payments / booking_events run on boot (the live file predates them). */
function seedDemo() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const city = db.prepare('SELECT id, name FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare("SELECT * FROM packages WHERE is_active = 1 ORDER BY id LIMIT 1").get();
  const day = (offset) => {
    const d = new Date(Date.now() + offset * 86400000);
    return d.toISOString().slice(0, 10);
  };

  // Anonymise whatever the owner's real data holds before it can reach a screenshot.
  db.prepare(`UPDATE bookings SET client_name = 'Nabila Puspita', client_phone = '6281200000001',
              instagram = 'nabila.p', campus = 'Institut Teknologi Bandung', location = 'Gedung Sate',
              faculty = 'Fakultas Teknik', major = 'Teknik Informatika', status = 'confirmed',
              shooting_date = ?, shooting_time = '09:00',
              total_price_snapshot = COALESCE(total_price_snapshot, 450000)`)
    .run(day(0));

  const insert = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date, shooting_time,
     location, package_id, category_id, duration, duration_minutes, price, package_price_snapshot,
     total_price_snapshot, status, terms_consent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 60, 60, ?, ?, ?, ?, 1, datetime('now', ?))`);

  const demos = [
    { code: 'DLY-DEMO-1001', name: 'Vieke Melani Deza', campus: 'UPI', date: day(1), time: '13:00', status: 'pending', price: 375000, loc: 'Kampus UPI', created: '-2 days' },
    { code: 'DLY-DEMO-1002', name: 'Sri Ayuni', campus: 'Digitech University', date: day(3), time: '10:30', status: 'confirmed', price: 675000, loc: 'Taman Hutan Raya', created: '-6 days' },
    { code: 'DLY-DEMO-1003', name: 'Herlisa', campus: 'UNJANI', date: day(-9), time: '08:00', status: 'completed', price: 450000, loc: 'Kampus UNJANI', created: '-21 days' },
    { code: 'DLY-DEMO-1004', name: 'Rangga Pratama', campus: 'ITB', date: day(6), time: '15:00', status: 'cancelled', price: 375000, loc: 'Gedung Sate', created: '-11 days' },
    { code: 'DLY-DEMO-1005', name: 'Alya Rahmani', campus: 'Universitas Padjadjaran', date: day(-2), time: '11:00', status: 'completed', price: 675000, loc: 'Kampus Unpad', created: '-17 days' }
  ];
  const ids = [];
  demos.forEach((d, i) => {
    const info = insert.run(d.code, `tok-demo-${i}`, d.name, `62812000000${10 + i}`, `demo.${i}`,
      d.campus, city.id, d.date, d.time, d.loc, pkg ? pkg.id : null, pkg ? pkg.category_id : null,
      d.price, d.price, d.price, d.status, d.created);
    ids.push({ ...d, id: Number(info.lastInsertRowid) });
  });

  // Payments + activity so the payment tab and the dashboard feed are not empty.
  const pay = db.prepare('INSERT INTO booking_payments (booking_id, amount, paid_at, method, note) VALUES (?, ?, ?, ?, ?)');
  const event = db.prepare(`INSERT INTO booking_events (booking_id, kind, from_status, to_status, actor, note, created_at)
                            VALUES (?, ?, ?, ?, 'admin', ?, datetime('now', ?))`);
  const completed = ids.find((x) => x.status === 'completed');
  pay.run(completed.id, 150000, day(-14), 'Transfer BCA', 'DP');
  pay.run(completed.id, 300000, day(-4), 'Transfer BCA', 'Pelunasan');
  event.run(completed.id, 'status', 'pending', 'confirmed', '', '-14 days');
  event.run(completed.id, 'payment', '', '', 'Pembayaran Rp 150.000 dicatat', '-14 days');
  event.run(completed.id, 'status', 'confirmed', 'completed', '', '-4 days');
  event.run(completed.id, 'payment', '', '', 'Pembayaran Rp 300.000 dicatat', '-4 days');
  const pending = ids.find((x) => x.status === 'pending');
  pay.run(pending.id, 100000, day(-1), 'Transfer Mandiri', 'DP awal');
  event.run(pending.id, 'payment', '', '', 'Pembayaran Rp 100.000 dicatat', '-1 days');

  // Tahap 6 — package photo gallery (so the pricelist carousel has more than one frame).
  try {
    const withPhoto = db.prepare("SELECT id, image FROM packages WHERE is_active = 1 AND image IS NOT NULL AND image <> '' ORDER BY id LIMIT 1").get();
    const uploads = fs.readdirSync(path.join(APP, 'public', 'uploads'))
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).slice(0, 4).map((f) => `/uploads/${f}`);
    if (withPhoto && uploads.length >= 2) {
      const ins = db.prepare("INSERT INTO package_images (package_id, image, caption, is_primary, sort_order) VALUES (?, ?, '', 0, ?)");
      uploads.filter((u) => u !== withPhoto.image).slice(0, 2).forEach((u, i) => ins.run(withPhoto.id, u, i));
    }
  } catch (err) { /* optional */ }

  // Tahap 5 — one queued job and one in-progress job so the board has content.
  const queuedBooking = ids[0];
  const jobStmt = db.prepare(`INSERT INTO editing_jobs
      (booking_id, status, editor_id, editor_name, due_at, note, photo_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now'))`);
  const editor = db.prepare('SELECT id, name FROM team_members WHERE is_active = 1 ORDER BY sort_order LIMIT 1').get();
  jobStmt.run(queuedBooking.id, 'queued', null, '', day(2), '', 30, '-1 days');
  jobStmt.run(completed.id, 'editing', editor ? editor.id : null, editor ? editor.name : '',
    day(1), 'Retouch warna & pembersihan latar.', 20, '-3 days');

  // The owner's real portal is submitted; give it an in-progress job in this COPY so the
  // editing-status card can be captured (its photos are never part of the screenshot).
  const realPortal = db.prepare('SELECT * FROM photo_selections ORDER BY id LIMIT 1').get();
  if (realPortal) {
    db.prepare(`INSERT INTO editing_jobs
        (booking_id, portal_id, status, editor_id, editor_name, due_at, note, photo_count, created_at, updated_at)
        VALUES (?, ?, 'editing', ?, ?, ?, 'internal', 40, datetime('now'), datetime('now'))`)
      .run(realPortal.booking_id, realPortal.id, editor ? editor.id : null, editor ? editor.name : '', day(2));
  }

  const row = db.prepare('SELECT id FROM bookings ORDER BY shooting_date LIMIT 1').get();
  const pfRow = db.prepare('SELECT slug FROM portfolio WHERE is_active = 1 AND slug IS NOT NULL ORDER BY sort_order LIMIT 1').get();
  db.close();
  return {
    detailId: (completed || row).id,
    citySlug: city.slug,
    portalToken: realPortal ? realPortal.token : '',
    portfolioSlug: (pfRow && pfRow.slug) || 'vieke-melani-deza'
  };
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */
const SHOTS = [];

async function shoot(page, { file, label, url, full = false, wait = 900, clip }) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(wait);
  const target = path.join(OUT, file);
  if (clip) await page.locator(clip).screenshot({ path: target });
  else await page.screenshot({ path: target, fullPage: full });
  SHOTS.push({ file, label });
  console.log('shot', file);
}

(async () => {
  prepareDataDir();
  fs.mkdirSync(OUT, { recursive: true });

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const seed = seedDemo();

    /* ---------------- public (desktop) ---------------- */
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await desktop.newPage();
    page.on('dialog', (d) => d.accept());
    await shoot(page, { file: '10-pricelist.png', label: 'Pricelist — desktop', url: '/pricelist', full: true, wait: 1200 });
    await shoot(page, { file: '11-portfolio.png', label: 'Portfolio / Gallery — desktop', url: '/gallery', full: true, wait: 1200 });
    await shoot(page, { file: '12-home.png', label: 'Homepage — desktop', url: '/', wait: 1200 });

    /* ---------------- admin (desktop) ---------------- */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', ADMIN_USER);
    await page.fill('input[name="password"]', ADMIN_PASS);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    await shoot(page, { file: '01-dashboard.png', label: 'Dashboard admin — Overview', url: '/admin' });

    // Sidebar with every group expanded, then the icon-only collapsed state.
    await page.goto(`${BASE}/admin`, { waitUntil: 'load' });
    const heads = page.locator('.nav-group');
    const headCount = await heads.count();
    for (let i = 0; i < headCount; i += 1) {
      const group = heads.nth(i);
      const open = await group.evaluate((el) => el.classList.contains('is-open'));
      if (!open) { await group.locator('[data-nav-toggle-group]').click(); await sleep(150); }
    }
    await sleep(400);
    await page.locator('[data-side]').screenshot({ path: path.join(OUT, '02-sidebar-groups.png') });
    SHOTS.push({ file: '02-sidebar-groups.png', label: 'Sidebar — semua grup terbuka' });
    console.log('shot 02-sidebar-groups.png');

    await page.locator('[data-side-collapse]').click();
    await sleep(500);
    await page.locator('[data-side]').screenshot({ path: path.join(OUT, '03-sidebar-collapsed.png') });
    SHOTS.push({ file: '03-sidebar-collapsed.png', label: 'Sidebar — mode ringkas (ikon)' });
    await page.evaluate(() => document.body.classList.remove('side-collapsed'));
    console.log('shot 03-sidebar-collapsed.png');

    await shoot(page, { file: '04-kelola-grid.png', label: 'Kelola Booking — Grid', url: '/admin/bookings?view=grid' });
    await shoot(page, { file: '05-kelola-kalender.png', label: 'Kelola Booking — Kalender', url: '/admin/bookings?view=calendar' });
    await shoot(page, { file: '06-kelola-daftar.png', label: 'Kelola Booking — Daftar', url: '/admin/bookings?view=list' });
    await shoot(page, { file: '07-kelola-kanban.png', label: 'Kelola Booking — Kanban', url: '/admin/bookings?view=kanban' });
    await shoot(page, { file: '08-detail-booking.png', label: 'Detail Booking — tab Client', url: `/admin/bookings/${seed.detailId}?tab=klien`, full: true });
    await shoot(page, { file: '09-detail-pembayaran.png', label: 'Detail Booking — tab Pembayaran', url: `/admin/bookings/${seed.detailId}?tab=pembayaran`, full: true });
    await shoot(page, { file: '13-notifikasi.png', label: 'Pusat Notifikasi', url: '/admin/notifications', full: true });
    await shoot(page, { file: '28-push-settings.png', label: 'Notifikasi HP (Web Push)', url: '/admin/push', full: true });
    await shoot(page, { file: '29-portfolio-detail.png', label: 'Halaman portfolio klien', url: `/portfolio/${seed.portfolioSlug}`, full: true, wait: 1200 });
    await shoot(page, { file: '14-antrean-editing.png', label: 'Antrean Editing (3 tahap)', url: '/admin/editing', full: true });
    await shoot(page, { file: '15-detail-workflow.png', label: 'Detail Booking — tab Workflow (status editing)', url: `/admin/bookings/${seed.detailId}?tab=workflow`, full: true });
    await page.close();
    await desktop.close();

    /* ---------------- mobile ---------------- */
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2
    });
    const m = await mobile.newPage();
    m.on('dialog', (d) => d.accept());
    await shoot(m, { file: '20-mobile-pricelist.png', label: 'Pricelist — mobile 390px', url: '/pricelist', full: true, wait: 1200 });
    await shoot(m, { file: '21-mobile-portfolio.png', label: 'Portfolio — mobile 390px', url: '/gallery', full: true, wait: 1200 });
    // Client portal: capture ONLY the status card — the client's photos never appear in it.
    if (seed.portalToken) {
      await m.goto(`${BASE}/selection/${seed.portalToken}`, { waitUntil: 'load' });
      await sleep(900);
      const card = m.locator('.sel-edit');
      if (await card.count()) {
        await card.first().screenshot({ path: path.join(OUT, '16-mobile-status-editing.png') });
        SHOTS.push({ file: '16-mobile-status-editing.png', label: 'Portal klien — status editing (hanya kartu status)' });
        console.log('shot 16-mobile-status-editing.png');
      }
    }

    await m.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await m.fill('input[name="username"]', ADMIN_USER);
    await m.fill('input[name="password"]', ADMIN_PASS);
    await Promise.all([m.waitForNavigation(), m.click('button[type="submit"]')]);
    await shoot(m, { file: '22-mobile-dashboard.png', label: 'Dashboard admin — mobile', url: '/admin' });
    await shoot(m, { file: '23-mobile-kelola.png', label: 'Kelola Booking — mobile', url: '/admin/bookings?view=grid' });
    await shoot(m, { file: '30-mobile-portfolio-detail.png', label: 'Halaman portfolio klien — mobile', url: `/portfolio/${seed.portfolioSlug}`, full: true, wait: 1200 });
    // Dropdown mobile in its open state.
    await m.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    await m.locator('[data-nav-toggle]').click();
    await sleep(500);
    await m.screenshot({ path: path.join(OUT, '31-mobile-menu.png') });
    SHOTS.push({ file: '31-mobile-menu.png', label: 'Dropdown menu — mobile (terbuka)' });
    console.log('shot 31-mobile-menu.png');
    await shoot(m, { file: '25-mobile-notifikasi.png', label: 'Notifikasi — mobile', url: '/admin/notifications' });
    await shoot(m, { file: '26-mobile-antrean.png', label: 'Antrean Editing — mobile', url: '/admin/editing', full: true });

    // Drawer open (sidebar as an overlay on phones).
    await m.goto(`${BASE}/admin`, { waitUntil: 'load' });
    await m.locator('[data-side-toggle]').click();
    await sleep(600);
    await m.screenshot({ path: path.join(OUT, '24-mobile-sidebar.png') });
    SHOTS.push({ file: '24-mobile-sidebar.png', label: 'Sidebar drawer — mobile' });
    console.log('shot 24-mobile-sidebar.png');
    await m.close();
    await mobile.close();
  } finally {
    await browser.close();
    app.kill();
  }

  /* ---------------- index.html ---------------- */
  const groups = [
    ['Tahap 6 — Portfolio klien & Pricelist', ['29-portfolio-detail.png', '30-mobile-portfolio-detail.png', '31-mobile-menu.png', '28-push-settings.png']],
    ['Dashboard admin', ['01-dashboard.png', '02-sidebar-groups.png', '03-sidebar-collapsed.png', '24-mobile-sidebar.png', '22-mobile-dashboard.png']],
    ['Kelola Booking', ['04-kelola-grid.png', '05-kelola-kalender.png', '06-kelola-daftar.png', '07-kelola-kanban.png', '23-mobile-kelola.png']],
    ['Detail & pembayaran', ['08-detail-booking.png', '09-detail-pembayaran.png', '15-detail-workflow.png']],
    ['Tahap 4 & 5 — Notifikasi, Antrean Editing, PWA', ['13-notifikasi.png', '14-antrean-editing.png', '25-mobile-notifikasi.png', '26-mobile-antrean.png', '16-mobile-status-editing.png']],
    ['Website publik', ['10-pricelist.png', '11-portfolio.png', '20-mobile-pricelist.png', '21-mobile-portfolio.png', '12-home.png']]
  ];
  const labelFor = (file) => (SHOTS.find((s) => s.file === file) || {}).label || file;
  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DLY Graduation — Review Tahap 3</title>
<meta name="robots" content="noindex, nofollow">
<style>
  :root { --navy:#0B2340; --teal:#2C5E73; --warm:#F7F6F2; --line:#E3E5E7; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 80px; background:var(--warm); color:#252A30; font:15px/1.6 Inter,system-ui,sans-serif; }
  .wrap { max-width:1240px; margin:0 auto; }
  header { margin-bottom:36px; }
  .eyebrow { font-size:.62rem; letter-spacing:.22em; text-transform:uppercase; color:var(--teal); }
  h1 { font-size:clamp(1.8rem,4vw,2.6rem); margin:8px 0 10px; color:var(--navy); }
  p.lede { color:#5F6B7A; max-width:720px; }
  h2 { font-size:1.1rem; margin:38px 0 16px; color:var(--navy); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:20px; }
  figure { margin:0; background:#fff; border:1px solid var(--line); border-radius:16px; overflow:hidden;
           box-shadow:0 2px 6px rgba(11,35,64,.05),0 16px 34px rgba(11,35,64,.07); }
  figure a { display:block; background:#EDEBE6; }
  figure img { display:block; width:100%; height:auto; max-height:520px; object-fit:cover; object-position:top; }
  figcaption { padding:12px 14px 14px; font-size:.82rem; color:#3C434B; display:flex; justify-content:space-between; gap:10px; }
  figcaption a { color:var(--teal); font-size:.74rem; }
  .note { margin-top:40px; padding:16px 18px; border:1px dashed #C9CDD1; border-radius:12px; color:#5F6B7A; font-size:.82rem; }
</style></head>
<body><div class="wrap">
<header>
  <span class="eyebrow">DLY Graduation · Tahap 3</span>
  <h1>Dashboard Admin &amp; Tampilan Website</h1>
  <p class="lede">Tangkapan layar hasil pekerjaan Tahap 3. Semua data booking pada gambar ini adalah data demo
  dari salinan database (nama klien asli tidak ditampilkan). Klik gambar untuk melihat ukuran penuh.</p>
</header>
${groups.map(([title, files]) => `<h2>${title}</h2><div class="grid">
${files.map((f) => `<figure><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="${labelFor(f)}" loading="lazy"></a>
<figcaption><span>${labelFor(f)}</span><a href="${f}" target="_blank" rel="noopener">Buka</a></figcaption></figure>`).join('\n')}
</div>`).join('\n')}
<div class="note">Halaman review ini hanya untuk melihat hasil pekerjaan dan bisa dihapus kapan saja
(folder <code>public/review-t3-c3fcc682f33c77b7</code>) tanpa memengaruhi website.</div>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\nReview page: ${path.join(OUT, 'index.html')}`);
  console.log(`Open at   : ${BASE}/review-t3-c3fcc682f33c77b7/ (local) → /review-t3-c3fcc682f33c77b7/ on the published app`);
})().catch((e) => { console.error(e); process.exit(1); });

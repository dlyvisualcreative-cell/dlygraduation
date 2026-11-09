'use strict';

/**
 * Screenshot Client Portal (blueprint) — untuk review pemilik.
 *
 * Menjalankan aplikasi pada SALINAN database, menyiapkan satu booking demo (kode baru,
 * PIN 1234, portal sortir berisi foto), lalu memotret:
 *   login · ringkasan · pilih foto · terpilih · modal konfirmasi · terkunci ·
 *   pantau order (timeline) · link Google Drive final · mobile · admin (kartu portal).
 *
 *   node scripts/review-shots-portal.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.RP_PORT || 4620);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-review-portal';
const OUT = path.join(APP, 'public', process.env.REVIEW_PORTAL_OUT || 'review-portal');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [];

const prepare = () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) {}
};

function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  // Booking demo (nama & data konsisten dengan blueprint: Vieke Melani / ITB).
  db.prepare("DELETE FROM bookings WHERE code LIKE 'DLY-WISUDA-VIEKE%'").run();
  const info = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, faculty, major, city_id,
     shooting_date, shooting_time, location, package_id, category_id, duration, duration_minutes,
     price, package_price_snapshot, total_price_snapshot, status, terms_consent, terms_consent_at,
     portal_pin, created_at, confirmed_at)
    VALUES ('DLY-WISUDA-VIEKE001', 'tok-review-portal', 'Vieke Melani', '6281200000001', 'vieke.melani',
            'Institut Teknologi Bandung', 'Fakultas Teknik', 'Teknik Informatika', ?, ?, '09:00',
            'Gedung Sate, Bandung', ?, ?, 60, 60, 450000, 450000, 550000, 'confirmed', 1,
            datetime('now'), '1234', datetime('now', '-3 days'), datetime('now', '-2 days'))`)
    .run(city.id, today, pkg.id, pkg.category_id).lastInsertRowid;
  const bookingId = Number(info);

  // Portal sortir dengan foto dari uploads yang ada di repo.
  db.prepare('DELETE FROM photo_selections WHERE booking_id = ?').run(bookingId);
  const uploads = fs.readdirSync(path.join(APP, 'public', 'uploads')).filter((f) => /\.(jpe?g|png)$/i.test(f)).slice(0, 10);
  // Token portal WAJIB hex 48 karakter (validasi portalByToken)
  const token = require('crypto').randomBytes(24).toString('hex');
  const portalId = Number(db.prepare(`INSERT INTO photo_selections
      (booking_id, token, quota, instructions, is_open, status, deadline, created_at, updated_at)
      VALUES (?, ?, 40, '', 1, 'waiting', date('now','+30 days'), datetime('now'), datetime('now'))`)
    .run(bookingId, token).lastInsertRowid);
  // `image` menunjuk file NYATA di public/uploads supaya pratinjau ber-watermark bisa dibuat.
  const insPhoto = db.prepare(`INSERT INTO photo_selection_photos
      (portal_id, code, image, file_name, source, is_primary, sort_order, is_highlight, created_at)
      VALUES (?, ?, ?, ?, 'upload', ?, ?, ?, datetime('now'))`);
  uploads.forEach((f, i) => insPhoto.run(portalId, String(i + 1).padStart(3, '0'),
    `/uploads/${f}`, `DLY${String(100 + i).padStart(4, '0')}.jpg`, i === 0 ? 1 : 0, i, i < 3 ? 1 : 0));
  db.prepare('DELETE FROM booking_timeline WHERE booking_id = ?').run(bookingId);

  db.close();
  return { bookingId, token, code: 'DLY-WISUDA-VIEKE001' };
}

const shot = async (page, file, label, opts = {}) => {
  await sleep(opts.wait || 400);
  const target = path.join(OUT, file);
  if (opts.clip) await page.locator(opts.clip).screenshot({ path: target });
  else await page.screenshot({ path: target, fullPage: Boolean(opts.full) });
  SHOTS.push({ file, label });
  console.log('shot', file);
};

(async () => {
  prepare();
  fs.mkdirSync(OUT, { recursive: true });
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 120; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const fx = seed();

    /* ---------------- admin: kartu Client Portal ---------------- */
    const adminBrowser = await chromium.launch();
    const admin = await adminBrowser.newPage({ viewport: { width: 1440, height: 1100 } });
    admin.on('dialog', (d) => d.accept());
    await admin.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await admin.fill('input[name="username"]', 'admin');
    await admin.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([admin.waitForNavigation(), admin.click('button[type="submit"]')]);
    await admin.goto(`${BASE}/admin/bookings/${fx.bookingId}?tab=workflow`, { waitUntil: 'load' });
    await shot(admin, '30-admin-portal-card.png', 'Admin — kartu Client Portal (kode, PIN, akses, timeline)', { clip: '#client-portal', wait: 700 });
    await admin.goto(`${BASE}/admin/bookings/${fx.bookingId}/portal`, { waitUntil: 'load' });
    await shot(admin, '31-admin-buat-portal.png', 'Admin — form Buat Portal Seleksi Foto', { full: true, wait: 700 });
    await adminBrowser.close();

    /* ---------------- client portal (desktop) ---------------- */
    const deskBrowser = await chromium.launch();
    const desk = await deskBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
    desk.on('pageerror', (e) => console.log('[client] pageerror', e.message));
    desk.on('response', async (r) => {
      if (r.url().includes('/pick')) {
        console.log('[pick]', r.status(), (await r.text().catch(() => '')).slice(0, 90));
      }
    });
    desk.on('console', (m) => { if (m.type() === 'error') console.log('[client console]', m.text().slice(0, 120)); });
    await desk.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await shot(desk, '01-login.png', 'Halaman masuk — Kode Booking + PIN');

    await desk.fill('input[name="code"]', fx.code);
    await desk.fill('input[name="pin"]', '1234');
    await Promise.all([desk.waitForNavigation(), desk.click('.cp-login__btn')]);
    await shot(desk, '02-ringkasan.png', 'Ringkasan — identitas client + status terbaru', { full: true, wait: 700 });

    await desk.goto(`${BASE}/portal/pilih-foto`, { waitUntil: 'domcontentloaded' });
    await desk.waitForSelector('[data-selection-app]');
    await sleep(1500);
    await shot(desk, '03-pilih-foto.png', 'Pilih Foto Favorit — galeri + kuota', { wait: 600 });

    // pilih 5 foto
    const ids = await desk.evaluate(() => Array.from(document.querySelectorAll('.sel-tile'))
      .slice(0, 5).map((t) => t.getAttribute('data-photo')));
    for (const id of ids) {
      await desk.evaluate((p) => document.querySelector(`.sel-tile[data-photo="${p}"] .sel-tile__pick`).click(), id);
      await sleep(220);
    }
    await shot(desk, '04-terpilih.png', 'Foto terpilih — border teal, centang, nomor urut', { wait: 500 });

    await desk.click('[data-sel-send]');
    await desk.waitForSelector('[data-sel-modal]:not([hidden])');
    await shot(desk, '05-konfirmasi.png', 'Konfirmasi Kirim Pilihan — daftar nama file bersih', { wait: 400 });

    // kirim (simpan dulu → WhatsApp)
    const popupPromise = desk.context().waitForEvent('page', { timeout: 6000 }).catch(() => null);
    await desk.click('[data-sel-submit]');
    const popup = await popupPromise;
    if (popup) await popup.close().catch(() => {});
    await desk.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(1200);
    await shot(desk, '06-terkirim.png', 'Setelah dikirim — pilihan terkunci', { full: true, wait: 600 });

    await desk.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    await shot(desk, '07-pantau-order.png', 'Pantau Order — timeline tahap yang tercapai', { full: true, wait: 700 });

    await desk.goto(`${BASE}/portal/drive`, { waitUntil: 'load' });
    await shot(desk, '08-drive-belum.png', 'Orderanmu Siap — belum tersedia', { wait: 400 });

    // admin menyelesaikan order → link final muncul
    const adminBrowser2 = await chromium.launch();
    const admin2 = await adminBrowser2.newPage({ viewport: { width: 1440, height: 1000 } });
    await admin2.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await admin2.fill('input[name="username"]', 'admin');
    await admin2.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([admin2.waitForNavigation(), admin2.click('button[type="submit"]')]);
    await admin2.goto(`${BASE}/admin/bookings/${fx.bookingId}?tab=workflow`, { waitUntil: 'load' });
    await admin2.fill('input[name="final_url"]', 'https://drive.google.com/drive/folders/CONTOH-HASIL-FINAL');
    await admin2.click('#client-portal button:has-text("Selesaikan Order")');
    await admin2.waitForLoadState('load').catch(() => {});
    await sleep(900);
    await shot(admin2, '32-admin-selesai.png', 'Admin — Selesaikan Order + link final', { clip: '.cp-admin-final', wait: 400 });
    await adminBrowser2.close();

    await desk.goto(`${BASE}/portal/drive`, { waitUntil: 'load' });
    await shot(desk, '09-drive-siap.png', 'Orderanmu Siap — foto final siap + tombol ulasan', { wait: 500 });
    await desk.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    await shot(desk, '10-timeline-lengkap.png', 'Pantau Order — tahap 08 muncul', { full: true, wait: 500 });
    await deskBrowser.close();

    /* ---------------- mobile ---------------- */
    const mobBrowser = await chromium.launch();
    const mob = await mobBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await mob.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await shot(mob, '20-mobile-login.png', 'Mobile — halaman masuk');
    await mob.fill('input[name="code"]', fx.code);
    await mob.fill('input[name="pin"]', '1234');
    await Promise.all([mob.waitForNavigation(), mob.click('.cp-login__btn')]);
    await shot(mob, '21-mobile-ringkasan.png', 'Mobile — ringkasan', { full: true, wait: 600 });
    await mob.click('[data-cp-toggle]');
    await sleep(500);
    await shot(mob, '22-mobile-drawer.png', 'Mobile — sidebar drawer');
    await mob.keyboard.press('Escape');
    await mob.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    await shot(mob, '23-mobile-timeline.png', 'Mobile — pantau order', { full: true, wait: 600 });
    await mob.goto(`${BASE}/portal/pilih-foto`, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await shot(mob, '24-mobile-terkirim.png', 'Mobile — status pilihan terkirim', { full: true, wait: 600 });
    await mobBrowser.close();
  } finally {
    await browser.close();
    app.kill();
  }

  const groups = [
    ['Halaman masuk', ['01-login.png', '20-mobile-login.png']],
    ['Ringkasan', ['02-ringkasan.png', '21-mobile-ringkasan.png']],
    ['Pilih Foto Favorit', ['03-pilih-foto.png', '04-terpilih.png', '05-konfirmasi.png', '06-terkirim.png', '24-mobile-terkirim.png']],
    ['Pantau Order', ['07-pantau-order.png', '10-timeline-lengkap.png', '23-mobile-timeline.png']],
    ['Orderanmu Siap', ['08-drive-belum.png', '09-drive-siap.png']],
    ['Admin', ['30-admin-portal-card.png', '31-admin-buat-portal.png', '32-admin-selesai.png']],
    ['Mobile (navigasi)', ['22-mobile-drawer.png']]
  ];
  const labelFor = (f) => (SHOTS.find((s) => s.file === f) || {}).label || f;
  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DLY Graduation — Review Client Portal</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body{margin:0;padding:30px 18px 70px;background:#F7F6F2;color:#252A30;font:15px/1.6 Inter,system-ui,sans-serif}
  .wrap{max-width:1240px;margin:0 auto}
  h1{font-size:clamp(1.6rem,3.6vw,2.3rem);color:#0B2340;margin:6px 0 8px}
  .eyebrow{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:#2C5E73}
  p.lede{color:#5F6B7A;max-width:800px}
  h2{font-size:1.05rem;color:#0B2340;margin:34px 0 14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px}
  figure{margin:0;background:#fff;border:1px solid #E3E5E7;border-radius:16px;overflow:hidden;
         box-shadow:0 2px 6px rgba(11,35,64,.05),0 16px 34px rgba(11,35,64,.07)}
  figure img{display:block;width:100%;height:auto;max-height:560px;object-fit:cover;object-position:top}
  figcaption{padding:11px 14px;font-size:.8rem;display:flex;justify-content:space-between;gap:10px}
  .note{margin-top:30px;padding:14px 16px;border:1px dashed #C9CDD1;border-radius:12px;color:#5F6B7A;font-size:.82rem}
</style></head><body><div class="wrap">
<header>
  <span class="eyebrow">DLY Graduation · Client Portal</span>
  <h1>Portal Client — Hasil Implementasi Blueprint</h1>
  <p class="lede">Akses dengan Kode Booking + PIN (tanpa akun), sidebar empat menu, ringkasan identitas,
  galeri pemilihan foto dengan submit dua jalur, timeline order dinamis, dan halaman link Google Drive final.
  Semua data pada tangkapan layar adalah data demo dari salinan database.</p>
</header>
${groups.map(([t, files]) => `<h2>${t}</h2><div class="grid">
${files.map((f) => `<figure><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="${labelFor(f)}" loading="lazy"></a>
<figcaption><span>${labelFor(f)}</span><a href="${f}" target="_blank" rel="noopener">Buka</a></figcaption></figure>`).join('\n')}
</div>`).join('\n')}
<div class="note">Halaman review ini hanya untuk pemeriksaan dan boleh dihapus kapan saja.</div>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\nReview page: ${OUT}/index.html`);
})().catch((e) => { console.error(e); process.exit(1); });

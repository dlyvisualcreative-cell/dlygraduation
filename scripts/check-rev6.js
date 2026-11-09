'use strict';

/**
 * REVISI 3 — suite penerimaan (permintaan pemilik setelah V22).
 *
 * Cakupan:
 *   1. Favicon bertoken versi (tab browser ikut berubah saat logo/cara buat berubah)
 *   2. Kode portal booking PENDING hanya berlaku 24 jam sejak booking dikirim
 *   3. Tahap 03 timeline: "Menunggu sesi foto" / "Sesi foto dimulai" (badge kedap-kedip) /
 *      "Sesimu sudah selesai"
 *   4. Gallery: filter KATEGORI (bukan paket), kategori dikelola admin, Event dihapus
 *   5. Pricelist: label "Recommended" dengan ikon bintang vector
 *   6. Syarat & Ketentuan bertingkat (poin di dalam poin)
 *   7. Template Chat: semua template WA bisa diubah admin
 *   8. Upgrade Paket (hanya lebih mahal) + Extra Time 30/60 menit terkunci sampai sesi DIMULAI
 *
 * Jalankan: node scripts/check-rev6.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4434);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(require('os').tmpdir(), `dly-rev6-${process.pid}`);
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';

let pass = 0;
const failures = [];
const ck = (label, ok, detail) => {
  if (ok) { pass += 1; console.log('  ok  ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Klik submit lalu tunggu sampai halaman benar-benar selesai memuat ulang. */
async function submitAndSettle(page, clickFn) {
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await clickFn();
  await nav;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(300);
}

function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']
    .filter((f) => fs.existsSync(path.join(APP, 'data', f)))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try {
    fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true });
  } catch (e) { /* opsional */ }
}

const openDb = () => new Database(path.join(DATA_DIR, 'app.sqlite'));

const wibToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function seed() {
  const db = openDb();
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const city2 = db.prepare('SELECT id FROM cities ORDER BY id DESC LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
  const stamp = Date.now().toString().slice(-6);
  const today = wibToday();

  // Harga paket: pastikan ada durasi berharga supaya perbandingan upgrade masuk akal.
  db.prepare(`UPDATE package_durations SET price = CASE duration_minutes
                WHEN 60 THEN 400000 WHEN 90 THEN 525000 WHEN 120 THEN 725000
                ELSE COALESCE(NULLIF(price, 0), 350000) END
              WHERE package_id = ?`).run(pkg.id);

  // Paket kedua yang lebih mahal + satu paket murah untuk menguji penolakan downgrade.
  const insPkg = db.prepare(`INSERT INTO packages (name, slug, city_id, category_id, is_active, sort_order, terms, tagline)
                             VALUES (?, ?, ?, ?, 1, ?, '', '')`);
  const premium = Number(insPkg.run(`Premium Uji ${stamp}`, `premium-uji-${stamp}`, city.id, pkg.category_id, 90).lastInsertRowid);
  const cheap = Number(insPkg.run(`Hemat Uji ${stamp}`, `hemat-uji-${stamp}`, city.id, pkg.category_id, 91).lastInsertRowid);
  const insDur = db.prepare(`INSERT INTO package_durations (package_id, duration_minutes, price, description, is_active, sort_order, edited_photos)
                             VALUES (?, ?, ?, '', 1, 0, 20)`);
  insDur.run(premium, 90, 900000);
  insDur.run(cheap, 60, 150000);

  const insertBooking = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date,
     shooting_time, location, package_id, category_id, duration, duration_minutes, price,
     package_price_snapshot, total_price_snapshot, status, terms_consent, terms_consent_at,
     portal_pin, created_at, confirmed_at)
    VALUES (?, ?, ?, '6281200000009', 'uji.rev6', 'Institut Uji', ?, ?, ?, 'Gedung Uji',
            ?, ?, 60, 60, ?, ?, ?, ?, 1, datetime('now'), '1357', ?, ?)`);

  // A. pending BARU (masih dalam 24 jam)
  const fresh = Number(insertBooking.run(`DLY-WISUDA-FRS${stamp.slice(-3)}`, `tok-f-${stamp}`,
    'Klien Pending Baru', city.id, today, '09:00', pkg.id, pkg.category_id,
    400000, 400000, 400000, 'pending', new Date().toISOString().slice(0, 19).replace('T', ' '), null).lastInsertRowid);

  // B. pending LAMA (25 jam) → akses portal harus ditolak
  const old = Number(insertBooking.run(`DLY-WISUDA-OLD${stamp.slice(-3)}`, `tok-o-${stamp}`,
    'Klien Pending Lama', city.id, today, '10:00', pkg.id, pkg.category_id,
    400000, 400000, 400000, 'pending', new Date().toISOString().slice(0, 19).replace('T', ' '), null).lastInsertRowid);
  // created_at = 25 jam lalu (dihitung SQL supaya zona waktunya sama dengan aplikasi).
  db.prepare("UPDATE bookings SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(old);

  // C. confirmed + sesi SUDAH selesai (kemarin, jam 08:00 WIB) + portal siap.
  // Sengaja memakai tanggal KEMARIN, bukan "hari ini 08:00": jam sandbox bisa siang/malam
  // sehingga sesi hari ini belum tentu lewat.
  const yesterday = new Date(Date.now() + 7 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const done = Number(insertBooking.run(`DLY-WISUDA-DON${stamp.slice(-3)}`, `tok-d-${stamp}`,
    'Klien Sesi Selesai', city.id, yesterday, '08:00', pkg.id, pkg.category_id,
    400000, 400000, 400000, 'confirmed', new Date().toISOString().slice(0, 19).replace('T', ' '), new Date().toISOString().slice(0, 19).replace('T', ' ')).lastInsertRowid);
  db.prepare("UPDATE bookings SET created_at = datetime('now', '-30 hours'), confirmed_at = datetime('now', '-30 hours') WHERE id = ?").run(done);

  // D. confirmed + sesi BESOK (Extra Time masih terkunci, timeline "akan dimulai")
  const tomorrow = new Date(Date.now() + 7 * 3600 * 1000 + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const soon = Number(insertBooking.run(`DLY-WISUDA-SON${stamp.slice(-3)}`, `tok-s-${stamp}`,
    'Klien Sesi Besok', city.id, tomorrow, '09:00', pkg.id, pkg.category_id,
    400000, 400000, 400000, 'confirmed', new Date().toISOString().slice(0, 19).replace('T', ' '), new Date().toISOString().slice(0, 19).replace('T', ' ')).lastInsertRowid);

  // E. confirmed + sesi +20 hari → dipakai untuk uji UPGRADE PAKET.
  // Revisi 5: upgrade paket/durasi DIKUNCI saat sudah masuk H-7, jadi uji upgrade
  // harus memakai booking yang sesinya masih jauh (bukan booking yang sesinya lewat).
  const later = new Date(Date.now() + 7 * 3600 * 1000 + 20 * 86400 * 1000).toISOString().slice(0, 10);
  const upgradeable = Number(insertBooking.run(`DLY-WISUDA-UPS${stamp.slice(-3)}`, `tok-u-${stamp}`,
    'Klien Upgrade Jauh', city.id, later, '09:00', pkg.id, pkg.category_id,
    400000, 400000, 400000, 'confirmed', new Date().toISOString().slice(0, 19).replace('T', ' '), new Date().toISOString().slice(0, 19).replace('T', ' ')).lastInsertRowid);

  // Portal pilih foto untuk booking C (supaya menu Upgrade bisa diuji end-to-end nanti)
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO photo_selections (booking_id, token, quota, is_open, status, submitted_at, created_at, updated_at)
              VALUES (?, ?, 10, 1, 'submitted', datetime('now'), datetime('now'), datetime('now'))`)
    .run(done, token);

  const codeOf = (id) => db.prepare('SELECT code FROM bookings WHERE id = ?').get(id).code;

  // Portfolio: satu karya per kategori (kategori dari tabel yang dikelola admin).
  const cityB = city2 ? city2.id : city.id;
  const insPf = db.prepare(`INSERT INTO portfolio
      (title, client_name, campus, image, image_url, alt_text, category, collection, city_id,
       is_active, is_featured, sort_order, slug)
      VALUES (?, ?, 'Institut Uji', '/assets/favicon.svg', '/assets/favicon.svg', 'Uji', ?,
              'portfolio', ?, 1, 0, ?, ?)`);
  db.prepare('SELECT 1').get();
  const catRow = db.prepare('SELECT slug FROM portfolio_categories ORDER BY sort_order LIMIT 1').get();
  insPf.run('Uji Kategori Satu', 'Uji Kategori Satu', catRow.slug, city.id, 1, `uji-kat-1-${stamp}`);
  insPf.run('Uji Kategori Dua', 'Uji Kategori Dua', catRow.slug, cityB, 2, `uji-kat-2-${stamp}`);

  const codes = {
    fresh: codeOf(fresh), old: codeOf(old), done: codeOf(done), soon: codeOf(soon),
    upgradeable: codeOf(upgradeable)
  };
  db.close();
  return {
    freshId: fresh, freshCode: codes.fresh,
    oldId: old, oldCode: codes.old,
    doneId: done, doneCode: codes.done,
    soonId: soon, soonCode: codes.soon,
    upgradeableId: upgradeable, upgradeableCode: codes.upgradeable,
    premiumId: premium, cheapId: cheap, pkgId: pkg.id, stamp
  };
}

(async () => {
  prepareDataDir();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    // PUBLIC_CACHE_MS=0: suite ini menulis konten publik LANGSUNG ke DB, jadi mikro-cache
    // halaman publik dimatikan agar hasilnya deterministik (cache diuji terpisah oleh
    // .testrun/verify-publiccache.js).
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1', PUBLIC_CACHE_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  const errors = [];
  try {
    for (let i = 0; i < 120; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const fx = seed();

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    /* ============================================================
       1. Favicon bertoken versi
       ============================================================ */
    await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    const favHref = await page.getAttribute('link[rel="icon"]', 'href');
    ck('Favicon memakai turunan logo (/favicon/)', /\/favicon\/[A-Za-z0-9_-]+\.png/.test(favHref), favHref);
    const favRes = await page.request.get(BASE + favHref);
    const favBuf = await favRes.body();
    ck('Favicon 200 & PNG 256x256',
      favRes.status() === 200 && `${favBuf.readUInt32BE(16)}x${favBuf.readUInt32BE(20)}` === '256x256',
      `${favRes.status()} ${favBuf.readUInt32BE(16)}x${favBuf.readUInt32BE(20)}`);

    /* ============================================================
       2. Portal pending hanya 24 jam
       ============================================================ */
    // Satu browser per instance: halaman klien memakai instance terpisah.
    const b1 = await chromium.launch();
    const c1 = await b1.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
    await c1.goto(`${BASE}/portal`, { waitUntil: 'load' });
    ck('Halaman masuk menjelaskan batas 24 jam untuk booking yang belum dikonfirmasi',
      /24 jam/i.test(await c1.locator('.cp-login').innerText()));

    await c1.fill('input[name="code"]', fx.oldCode);
    await c1.fill('input[name="pin"]', '1357');
    await Promise.all([c1.waitForNavigation().catch(() => {}), c1.click('button[type="submit"]')]);
    const oldLogin = await c1.locator('.cp-login').innerText().catch(() => '');
    ck('Booking pending > 24 jam DITOLAK masuk portal',
      /masa akses portal sudah berakhir/i.test(oldLogin), oldLogin.replace(/\n/g, ' ').slice(0, 120));

    await c1.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await c1.fill('input[name="code"]', fx.freshCode);
    await c1.fill('input[name="pin"]', '1357');
    await Promise.all([c1.waitForNavigation().catch(() => {}), c1.click('button[type="submit"]')]);
    ck('Booking pending BARU (dalam 24 jam) masih bisa masuk', c1.url().includes('/portal/ringkasan'), c1.url());

    const dbPend = openDb();
    const pinFresh = dbPend.prepare('SELECT status, created_at FROM bookings WHERE id = ?').get(fx.freshId);
    dbPend.close();
    ck('Data booking pending tidak diubah oleh aturan masa akses', pinFresh.status === 'pending', pinFresh.status);
    await b1.close();

    /* ============================================================
       3. Tahap 03: tiga keadaan keterangan
       ============================================================ */
    const b2 = await chromium.launch();
    const c2 = await b2.newPage({ viewport: { width: 390, height: 900 } });
    await c2.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await c2.fill('input[name="code"]', fx.soonCode);
    await c2.fill('input[name="pin"]', '1357');
    await Promise.all([c2.waitForNavigation().catch(() => {}), c2.click('button[type="submit"]')]);
    await c2.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const soonTl = await c2.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.cp-tl__item'));
      const target = items.find((li) => /Sesi/i.test(li.innerText));
      return {
        text: target ? target.innerText.replace(/\s+/g, ' ').trim() : '',
        upcoming: target ? target.classList.contains('is-upcoming') : false,
        checked: target ? Boolean(target.querySelector('.cp-tl__dot svg')) : false,
        body: document.body.innerText
      };
    });
    // Revisi 5: judul tahap 03 sebelum sesi = "Menunggu sesi foto" + jadwal lengkap.
    ck('Sebelum sesi: keterangan "Menunggu sesi foto" + jadwal',
      /Menunggu sesi foto/i.test(soonTl.text) && /Sesi fotomu dijadwalkan/i.test(soonTl.text),
      soonTl.text.slice(0, 160));
    ck('Sebelum sesi: menyebut tanggal & jam booking',
      /\d{1,2} \w+ \d{4}.*\d{2}:\d{2}/.test(soonTl.text), soonTl.text.slice(0, 160));
    ck('Sebelum sesi: ada pengingat "jangan telat"',
      /jangan telat/i.test(soonTl.text), soonTl.text);
    ck('Tahap yang belum mulai tidak dicentang (ring kosong)', soonTl.upcoming && !soonTl.checked);

    // Extra Time pada booking ini HARUS terkunci (sesi belum selesai).
    await c2.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const soonExtra = await c2.evaluate(() => Array.from(document.querySelectorAll('.cp-up__card--extra')).map((c) => ({
      locked: c.classList.contains('is-locked'),
      hasButton: Boolean(c.querySelector('form button')),
      text: c.innerText.replace(/\s+/g, ' ')
    })));
    ck('Extra Time TERKUNCI bila sesi foto belum selesai',
      soonExtra.length === 2 && soonExtra.every((c) => c.locked && !c.hasButton
        && /Terbuka saat sesi foto dimulai/i.test(c.text)),
      JSON.stringify(soonExtra));
    await b2.close();

    // Booking C: sesi sudah selesai → "Sesi Foto Selesai" + centang
    const b3 = await chromium.launch();
    const c3 = await b3.newPage({ viewport: { width: 390, height: 900 } });
    c3.on('pageerror', (e) => errors.push(String(e)));
    await c3.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await c3.fill('input[name="code"]', fx.doneCode);
    await c3.fill('input[name="pin"]', '1357');
    await Promise.all([c3.waitForNavigation().catch(() => {}), c3.click('button[type="submit"]')]);
    await c3.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const doneTl = await c3.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.cp-tl__item'));
      const target = items.find((li) => /Sesi/i.test(li.innerText));
      return {
        text: target ? target.innerText.replace(/\s+/g, ' ').trim() : '',
        checked: target ? Boolean(target.querySelector('.cp-tl__dot svg')) : false,
        lives: items.filter((li) => li.classList.contains('is-current')).length
      };
    });
    ck('Setelah sesi: keterangan "Sesimu sudah selesai" + centang',
      /Sesimu sudah selesai/i.test(doneTl.text) && doneTl.checked, doneTl.text.slice(0, 100));

    /* ============================================================
       8. Upgrade Paket & Extra Time (portal)
       ============================================================ */
    await c3.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const upText = await c3.locator('.cp-page').innerText();
    const menuUpgrade = await c3.locator('.cp-nav__label').allInnerTexts();
    ck('Sidebar portal punya menu "Upgrade Paket"',
      menuUpgrade.map((s) => s.trim()).includes('Upgrade Paket'), menuUpgrade.join(' | '));
    // Revisi 5: paket & durasi memakai kartu pricelist (.pkg-feature / .cp-pkgcard).
    ck('Halaman upgrade memakai kartu gaya pricelist (judul + harga)',
      await c3.locator('.cp-pkgcard.pkg-feature').count() >= 1 && /Harga/i.test(upText),
      String(await c3.locator('.cp-pkgcard').count()));

    const cards = await c3.evaluate(() => Array.from(document.querySelectorAll('.cp-up__card')).map((c) => ({
      title: (c.querySelector('.cp-up__title') || {}).textContent || '',
      locked: c.classList.contains('is-locked'),
      text: c.innerText.replace(/\s+/g, ' ').slice(0, 120)
    })));
    // Revisi 5: paket lebih murah TETAP tampil tapi DIKUNCI (downgrade tidak tersedia).
    const pkgCards = await c3.evaluate(() => Array.from(document.querySelectorAll('.cp-pkgcard')).map((c) => ({
      title: (c.querySelector('.pkg-feature__title') || {}).textContent || '',
      state: c.getAttribute('data-state'),
      locked: c.classList.contains('is-locked'),
      disabledCta: Boolean(c.querySelector('.cp-btn--disabled'))
    })));
    ck('Paket lebih mahal bisa diajukan, paket lebih murah DIKUNCI',
      pkgCards.some((c) => /Premium Uji/i.test(c.title) && c.state === 'upgrade')
      && pkgCards.some((c) => /Hemat Uji/i.test(c.title) && c.locked && c.disabledCta),
      JSON.stringify(pkgCards.map((c) => `${c.title}:${c.state}`)));
    ck('Extra Time tampil 2 pilihan (30 & 60 menit)',
      cards.filter((c) => /\+\d+ menit/.test(c.title)).length === 2,
      cards.map((c) => c.title).join(' | '));
    // (Kartu di halaman ini milik booking yang sesinya SUDAH selesai → tidak terkunci.)
    // Data-aware: harga Extra Time boleh sudah diisi admin (dashboard dipakai sungguhan).
    // Yang diuji adalah KONTRAK: kalau belum diatur → "Belum diatur admin", kalau sudah →
    // nominal rupiah tampil. Keduanya sah, tidak boleh mengasumsikan kosong.
    const extraTexts = cards.filter((c) => /\+\d+ menit/.test(c.title)).map((c) => c.text);
    const extraDb = (() => {
      const d = openDb();
      const rows = d.prepare("SELECT key, value FROM settings WHERE key LIKE 'extra_time_%_price'").all();
      d.close();
      return rows.reduce((acc, r) => { acc[r.key] = Number(r.value) || 0; return acc; }, {});
    })();
    const pricedNow = Object.values(extraDb).filter((n) => n > 0);
    ck('Harga Extra Time di portal mengikuti pengaturan admin (angka atau "belum diatur")',
      pricedNow.length === 0
        ? /Belum diatur admin/i.test(upText)
        : pricedNow.every((n) => upText.includes('Rp ' + n.toLocaleString('id-ID'))
          || upText.includes('Rp ' + n.toLocaleString('id-ID'))),
      `db=${JSON.stringify(extraDb)} · ${extraTexts.join(' || ').slice(0, 160)}`);

    // Admin menetapkan harga extra time → tombol terbuka untuk booking yang sesinya selesai.
    const adminBrowser = await chromium.launch();
    const admin = await adminBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
    admin.on('dialog', (d) => d.accept());
    await admin.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await admin.fill('input[name="username"]', USER);
    await admin.fill('input[name="password"]', PASS);
    await Promise.all([admin.waitForNavigation(), admin.click('button[type="submit"]')]);
    ck('Login admin berhasil', admin.url().includes('/admin'), admin.url());

    await admin.goto(`${BASE}/admin/extra-time`, { waitUntil: 'load' });
    await admin.fill('input[name="extra_time_30_price"]', '75000');
    await admin.fill('input[name="extra_time_60_price"]', '140000');
    // Tombol submit ada di dalam form halaman ini (bukan form sidebar).
    await submitAndSettle(admin, () => admin.locator('form[action$="/admin/extra-time"] button[type="submit"]').click());
    ck('Admin bisa mengubah harga Extra Time',
      /disimpan/i.test(await admin.locator('.admin-flash').first().innerText().catch(() => '')));

    await c3.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const nowText = await c3.locator('.cp-page').innerText();
    ck('Harga Extra Time dari admin tampil di portal',
      /Rp\s?75\.000/.test(nowText) && /Rp\s?140\.000/.test(nowText), nowText.replace(/\n/g, ' ').slice(0, 200));
    const extraCards = await c3.evaluate(() => Array.from(document.querySelectorAll('.cp-up__card--extra')).map((c) => ({
      locked: c.classList.contains('is-locked'),
      hasButton: Boolean(c.querySelector('form button'))
    })));
    ck('Sesi sudah selesai → Extra Time terbuka (tombol pengajuan muncul)',
      extraCards.length === 2 && extraCards.every((c) => !c.locked && c.hasButton),
      JSON.stringify(extraCards));

    // Ajukan Extra Time 30 menit → masuk daftar pengajuan (belum mengubah tagihan).
    const extraForm = c3.locator('.cp-up__card--extra form').first();
    await submitAndSettle(c3, () => extraForm.locator('button').click());
    const afterReq = openDb();
    const req = afterReq.prepare("SELECT * FROM booking_upgrades WHERE booking_id = ? AND kind = 'extra' ORDER BY id DESC LIMIT 1").get(fx.doneId);
    const billBefore = afterReq.prepare('SELECT total_price_snapshot, duration_minutes FROM bookings WHERE id = ?').get(fx.doneId);
    afterReq.close();
    ck('Pengajuan Extra Time tersimpan sebagai pending (tidak langsung menagih)',
      Boolean(req) && req.status === 'pending' && Number(req.price) === 75000,
      JSON.stringify(req || {}));
    ck('Tagihan booking belum berubah sebelum disetujui',
      Number(billBefore.total_price_snapshot) === 400000, String(billBefore.total_price_snapshot));

    // Server menolak Extra Time walau dipaksa lewat HTTP untuk booking yang sesinya belum selesai.
    const b4 = await chromium.launch();
    const c4 = await b4.newPage({ viewport: { width: 390, height: 900 } });
    const soonLogin = await c4.request.post(`${BASE}/portal/masuk`, {
      form: { code: fx.soonCode, pin: '1357' }, maxRedirects: 0
    });
    const soonCookie = (soonLogin.headers()['set-cookie'] || '').split(';')[0];
    const forced = await c4.request.post(`${BASE}/portal/upgrade/extra`, {
      form: { minutes: '60', _csrf: '' }, headers: { cookie: soonCookie }, maxRedirects: 0
    });
    const forcedLoc = decodeURIComponent(String(forced.headers().location || '').replace(/\+/g, ' '));
    ck('Extra Time DITOLAK server bila sesi foto belum dimulai',
      /baru bisa diajukan saat sesi foto/i.test(forcedLoc), forcedLoc);
    await b4.close();

    /* ---- admin menyetujui → harga & durasi berubah ---- */
    await admin.goto(`${BASE}/admin/upgrades`, { waitUntil: 'load' });
    const upAdminText = await admin.locator('.admin-page, body').first().innerText();
    ck('Halaman admin menampilkan pengajuan upgrade',
      /Extra Time/i.test(upAdminText) && /30 menit/i.test(upAdminText) && /Setujui/i.test(upAdminText),
      upAdminText.replace(/\n/g, ' ').slice(0, 200));
    const approveBtn = admin.locator('form[action$="/approve"] button').first();
    await submitAndSettle(admin, () => approveBtn.click());
    const afterApprove = openDb();
    const billAfter = afterApprove.prepare('SELECT total_price_snapshot, duration_minutes FROM bookings WHERE id = ?').get(fx.doneId);
    const reqAfter = afterApprove.prepare('SELECT status FROM booking_upgrades WHERE id = ?').get(req.id);
    afterApprove.close();
    ck('Setelah disetujui: durasi +30 menit & total bertambah',
      Number(billAfter.duration_minutes) === 90 && Number(billAfter.total_price_snapshot) === 475000,
      JSON.stringify(billAfter));
    ck('Status pengajuan menjadi approved', reqAfter.status === 'approved', reqAfter.status);

    /* ---- upgrade paket: hanya naik, dan disetujui mengubah paket ---- */
    // Upgrade DIKUNCI saat H-7 (Revisi 5) → uji pakai booking yang sesinya masih +20 hari.
    await c3.goto(`${BASE}/portal`, { waitUntil: 'load' }).catch(() => {});
    await c3.request.post(`${BASE}/portal/keluar`, { maxRedirects: 0 }).catch(() => {});
    await c3.context().clearCookies().catch(() => {});
    await c3.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await c3.fill('input[name="code"]', fx.upgradeableCode);
    await c3.fill('input[name="pin"]', '1357');
    await Promise.all([c3.waitForNavigation().catch(() => {}), c3.click('button[type="submit"]')]);

    const upPost = await c3.request.post(`${BASE}/portal/upgrade/package`, {
      form: { package_id: String(fx.cheapId) }, maxRedirects: 0
    });
    const upPostLoc = decodeURIComponent(String(upPost.headers().location || '').replace(/\+/g, ' '));
    ck('Server MENOLAK downgrade (paket lebih murah)',
      /hanya upgrade ke paket yang lebih mahal/i.test(upPostLoc), upPostLoc);

    const premiumPost = await c3.request.post(`${BASE}/portal/upgrade/package`, {
      form: { package_id: String(fx.premiumId) }, maxRedirects: 0
    });
    ck('Upgrade ke paket lebih mahal diterima (redirect sukses)',
      /msg=/.test(String(premiumPost.headers().location || '')), String(premiumPost.headers().location || ''));
    const pkgReq = (() => {
      const d = openDb();
      const row = d.prepare("SELECT * FROM booking_upgrades WHERE booking_id = ? AND kind = 'package' ORDER BY id DESC LIMIT 1").get(fx.upgradeableId);
      d.close();
      return row;
    })();
    ck('Pengajuan upgrade paket tersimpan dengan harga paket tujuan',
      Boolean(pkgReq) && Number(pkgReq.package_id) === fx.premiumId && Number(pkgReq.price) === 900000,
      JSON.stringify(pkgReq || {}));
    await b3.close();

    /* ============================================================
       4. Gallery: filter KATEGORI (bukan paket) + admin kelola kategori
       ============================================================ */
    await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    const filterInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('[data-gallery-filter] select'));
      return {
        names: selects.map((s) => s.name),
        labels: Array.from(document.querySelectorAll('.gf-select__label')).map((s) => s.textContent.trim()),
        options: (document.querySelector('select[name="kategori"]') || {}).options
          ? Array.from(document.querySelector('select[name="kategori"]').options).map((o) => o.textContent.trim())
          : []
      };
    });
    ck('Filter Gallery bernama KATEGORI & LOKASI', filterInfo.labels.join('|') === 'Kategori|Lokasi', filterInfo.labels.join('|'));
    ck('Tidak ada lagi filter bernama "Paket"', !filterInfo.names.includes('paket'), filterInfo.names.join(','));
    ck('Kategori "Graduation Event" sudah dihapus dari pilihan',
      !filterInfo.options.some((o) => /event/i.test(o)), filterInfo.options.join(' | '));

    await admin.goto(`${BASE}/admin/portfolio-categories`, { waitUntil: 'load' });
    ck('Halaman admin Kategori Gallery tersedia',
      /Kategori Gallery/i.test(await admin.locator('body').innerText()));
    await admin.fill('input[name="label"]', 'Wisuda Bersama');
    await submitAndSettle(admin, () => admin.locator('form[action$="/admin/portfolio-categories"] button[type="submit"]').click());
    await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    const afterAdd = await page.evaluate(() => Array.from(document.querySelectorAll('select[name="kategori"] option')).map((o) => o.textContent.trim()));
    ck('Kategori baru dari admin langsung muncul di filter Gallery',
      afterAdd.some((o) => /Wisuda Bersama/i.test(o)), afterAdd.join(' | '));

    const usedDelete = await admin.request.post(`${BASE}/admin/portfolio-categories/1/delete`, { form: { _csrf: '' }, maxRedirects: 0 }).catch(() => null);
    void usedDelete;
    const catCount = (() => {
      const d = openDb();
      const n = d.prepare("SELECT COUNT(*) AS n FROM portfolio_categories WHERE slug = 'individual'").get().n;
      d.close();
      return n;
    })();
    ck('Kategori yang dipakai karya tidak hilang (data aman)', catCount === 1, String(catCount));

    /* ============================================================
       5. Pricelist: label Recommended
       ============================================================ */
    await admin.goto(`${BASE}/admin/packages/${fx.pkgId}/edit`, { waitUntil: 'load' }).catch(async () => {
      await admin.goto(`${BASE}/admin/packages`, { waitUntil: 'load' });
      const href = await admin.getAttribute('.admin-table a.admin-link[href*="/edit"]', 'href');
      await admin.goto(BASE + href, { waitUntil: 'load' });
    });
    const recBox = admin.locator('input[name="is_recommended"]');
    ck('Form paket punya opsi "Recommended"', await recBox.count() === 1);
    // Simpan lewat form paket yang benar (halaman ini punya form kecil untuk gambar).
    const recFormCount = await admin.locator('form[action$="/admin/packages/save"]').count();
    const recChecked = await admin.evaluate(() => {
      const el = document.querySelector('input[name="is_recommended"]');
      if (el) { el.checked = true; }
      return el ? el.checked : false;
    });
    // Simpan lewat endpoint form (multipart) memakai data paket yang sudah ada di DB —
    // sama seperti yang dikirim form admin, tanpa bergantung pada isian file di browser.
    const pkgRow = (() => {
      const d = openDb();
      const row = d.prepare('SELECT * FROM packages WHERE id = ?').get(fx.pkgId);
      d.close();
      return row;
    })();
    const recCsrf = await admin.evaluate(() => {
      const el = document.querySelector('form[action$="/admin/packages/save"] input[name="_csrf"]');
      return el ? el.value : '';
    });
    const recSave = await admin.request.post(`${BASE}/admin/packages/save`, {
      multipart: {
        _csrf: recCsrf,
        id: String(pkgRow.id),
        city_id: String(pkgRow.city_id),
        category_id: String(pkgRow.category_id),
        name: pkgRow.name,
        slug: pkgRow.slug,
        image: pkgRow.image || '',
        label: pkgRow.label || '',
        tagline: pkgRow.tagline || '',
        terms: pkgRow.terms || '',
        description: pkgRow.description || '',
        facilities: pkgRow.facilities || '',
        edited_photos: String(pkgRow.edited_photos || ''),
        sold_count: pkgRow.sold_count == null ? '' : String(pkgRow.sold_count),
        sold_label: pkgRow.sold_label || '',
        sort_order: String(pkgRow.sort_order || 0),
        is_active: '1',
        is_recommended: '1',
        is_best_seller: pkgRow.is_best_seller ? '1' : '',
        sold_visible: pkgRow.sold_visible ? '1' : '',
        duration_rows: '0'
      },
      maxRedirects: 0
    });
    ck('Form paket terkirim tanpa error',
      recFormCount === 1 && recChecked && recSave.status() === 302,
      `forms=${recFormCount} checked=${recChecked} status=${recSave.status()}`);
    const recDb = (() => {
      const d = openDb();
      const row = d.prepare('SELECT id, name, is_recommended, is_active FROM packages WHERE id = ?').get(fx.pkgId);
      d.close();
      return row;
    })();
    ck('Pilihan Recommended tersimpan di database', Number(recDb.is_recommended) === 1,
      JSON.stringify(recDb));
    await page.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    const recBadge = page.locator('.pkg-best--recommended').first();
    ck('Badge Recommended tampil di pricelist', await recBadge.count() >= 1);
    const recHtml = await recBadge.innerHTML().catch(() => '');
    ck('Badge Recommended memakai ikon bintang vector (SVG), bukan emoji',
      /<svg/.test(recHtml) && !/✨/.test(recHtml), recHtml.slice(0, 80));

    /* ============================================================
       6. Syarat & Ketentuan bertingkat
       ============================================================ */
    await page.goto(`${BASE}/syarat-ketentuan`, { waitUntil: 'load' });
    const tnc = await page.evaluate(() => ({
      sections: document.querySelectorAll('.tnc__section').length,
      points: document.querySelectorAll('.tnc__point').length,
      subs: document.querySelectorAll('.tnc__subs li').length,
      text: document.querySelector('.tnc').innerText.replace(/\s+/g, ' ')
    }));
    ck('TnC punya judul bagian (A/B/C)', tnc.sections >= 3, String(tnc.sections));
    ck('TnC punya poin-poin di bawah bagian', tnc.points >= 6, String(tnc.points));
    ck('Teks ketentuan asli tidak hilang', /Klien wajib hadir tepat waktu/i.test(tnc.text), tnc.text.slice(0, 120));

    // Sub-poin (poin di dalam poin) dirender dari format "-- ".
    const d2 = openDb();
    const body = d2.prepare("SELECT live_value FROM site_content WHERE key = 'tnc.body'").get().live_value;
    d2.prepare("UPDATE site_content SET live_value = ?, draft_value = ? WHERE key = 'tnc.body'")
      .run(`${body}\n- Poin induk uji\n-- Sub-poin uji satu\n-- Sub-poin uji dua`, `${body}\n- Poin induk uji\n-- Sub-poin uji satu\n-- Sub-poin uji dua`);
    d2.close();
    await page.goto(`${BASE}/syarat-ketentuan`, { waitUntil: 'load' });
    const nested = await page.evaluate(() => ({
      subs: Array.from(document.querySelectorAll('.tnc__subs li')).map((li) => li.textContent.trim()),
      text: document.body.innerText
    }));
    ck('Poin di dalam poin dirender sebagai sub-poin',
      nested.subs.some((s) => /Sub-poin uji satu/i.test(s)) && nested.subs.some((s) => /Sub-poin uji dua/i.test(s)),
      nested.subs.join(' | '));

    /* ============================================================
       7. Template Chat — semua template WA editable
       ============================================================ */
    await admin.goto(`${BASE}/admin/wa-template`, { waitUntil: 'load' });
    const waText = await admin.locator('body').innerText();
    ck('Menu Template Chat memuat template chat klien, konfirmasi, portal, seleksi',
      /Template 1/.test(waText) && /Template 2/.test(waText) && /Template 3/.test(waText) && /Template 4/.test(waText));
    ck('Template reschedule, daftar foto klien, dan H-1 juga bisa diubah admin',
      /Template 5 — Konfirmasi Reschedule/.test(waText)
      && /Template 6 — Daftar Foto dari Klien/.test(waText)
      && /Template 7 — Pengingat H-1/.test(waText));
    ck('Setiap template punya daftar placeholder',
      (await admin.locator('.ph-chip').count()) >= 20, String(await admin.locator('.ph-chip').count()));

    await admin.fill('#tpl_submit', 'Daftar foto pilihan {{nama}} ({{jumlah}} foto):\n{{daftar_foto}}');
    await submitAndSettle(admin, () => admin.locator('#tpl-submit form button[type="submit"]').first().click());
    const savedSubmit = (() => {
      const d = openDb();
      const row = d.prepare("SELECT value FROM settings WHERE key = 'wa_submit_template'").get();
      d.close();
      return row ? row.value : '';
    })();
    ck('Isi template daftar foto tersimpan dari dashboard',
      /Daftar foto pilihan \{\{nama\}\}/.test(savedSubmit), savedSubmit.slice(0, 60));

    ck('Tidak ada error JavaScript di halaman yang diuji', errors.length === 0, errors.slice(0, 2).join(' | '));
    await adminBrowser.close();
  } finally {
    await browser.close();
    app.kill('SIGTERM');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

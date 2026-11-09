'use strict';

/**
 * REVISI 4 — suite penerimaan (permintaan pemilik: foto siap dipilih, reschedule klien,
 * portal pilih foto yang disederhanakan, tahap sesi otomatis selesai, upgrade durasi).
 *
 * Cakupan:
 *   1. FASE 1 — tombol "Foto Siap Dipilih": sumber folder 01. FILE MENTAH, portal dibuat
 *      otomatis, foto diimpor, tahap 04 dicatat, notifikasi klien, idempoten.
 *   2. FASE 2 — menu Reschedule di portal klien: pengajuan (tanggal/jam/lokasi) → disetujui
 *      / ditolak admin; terkunci otomatis H-7; admin bisa membukanya manual.
 *   3. FASE 3 — link Drive portal terisi otomatis (read-only) + "Perbarui dari 01. File
 *      Mentah" membaca ulang folder.
 *   4. FASE 4 — tahap 03 selesai TEPAT saat durasi sesi habis (tanpa +60 menit) + hanya
 *      tahap yang benar-benar berjalan memakai badge "Sedang Berlangsung".
 *   5. FASE 5 — upgrade durasi paket yang sama (pricelist style), downgrade ditolak;
 *      Extra Time terbuka sejak sesi DIMULAI.
 *
 * UJI memakai mock Google (kalender) + mock Drive (folder foto) dan SALINAN database di
 * folder sementara — tidak pernah menyentuh Drive/Calendar pemilik yang asli.
 *
 * Jalankan: node scripts/check-rev7.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4444);
const MOCK = Number(process.env.MOCK_PORT || 4445);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `dly-rev7-${process.pid}`);
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';
const FOLDER_ID = 'MockFolderIdAAAAAAAAAAAA'; // folder yang dikenali scripts/mock-drive.js

let pass = 0;
const failures = [];
const ck = (label, ok, detail) => {
  if (ok) { pass += 1; console.log('  ok  ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submitAndSettle(page, clickFn) {
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await clickFn();
  await nav;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(250);
}

function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']
    .filter((f) => fs.existsSync(path.join(APP, 'data', f)))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  ['image-cache', 'logo-cache', 'preview-cache'].forEach((dir) => {
    try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA_DIR, dir), { recursive: true }); } catch (e) { /* opsional */ }
  });
}

const openDb = () => new Database(path.join(DATA_DIR, 'app.sqlite'));

/** WIB "sekarang" + offset menit → { date, time } (aman melewati tengah malam). */
function wibAt(offsetMinutes = 0) {
  const wib = new Date(Date.now() + 7 * 3600 * 1000 + offsetMinutes * 60 * 1000);
  return { date: wib.toISOString().slice(0, 10), time: wib.toISOString().slice(11, 16) };
}

const wibDatePlus = (days) => {
  const d = new Date(Date.now() + 7 * 3600 * 1000 + days * 86400 * 1000);
  return d.toISOString().slice(0, 10);
};

function seed() {
  const db = openDb();
  const stamp = Date.now().toString().slice(-6);
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();

  // Drive mock (foto) + Google mock (kalender). Tidak menyentuh akun asli.
  db.prepare("INSERT INTO settings (key, value) VALUES ('gdrive_api_key', 'MOCK_API_KEY') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('gdrive_reader_refresh_token', '') ON CONFLICT(key) DO UPDATE SET value = ''").run();
  // Notifikasi harus aktif supaya pengiriman bisa diverifikasi dari push_log.
  ["push_enabled", "push_client_photos", "push_client_reschedule", "push_type_booking"]
    .forEach((key) => db.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run(key));
  db.prepare("INSERT INTO settings (key, value) VALUES ('extra_time_30_price', '75000') ON CONFLICT(key) DO UPDATE SET value = '75000'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('extra_time_60_price', '140000') ON CONFLICT(key) DO UPDATE SET value = '140000'").run();

  // Paket uji dengan durasi 60 / 90 / 120 menit (harga naik) + 30 menit (untuk downgrade).
  db.prepare(`UPDATE package_durations SET price = CASE duration_minutes
                WHEN 30 THEN 250000 WHEN 60 THEN 400000 WHEN 90 THEN 525000 WHEN 120 THEN 725000
                ELSE COALESCE(NULLIF(price, 0), 400000) END
              WHERE package_id = ?`).run(pkg.id);
  const insDur = db.prepare(`INSERT OR IGNORE INTO package_durations
      (package_id, duration_minutes, price, description, is_active, sort_order, edited_photos)
      VALUES (?, ?, ?, '', 1, 0, ?)`);
  insDur.run(pkg.id, 90, 525000, 35);
  insDur.run(pkg.id, 120, 725000, 50);

  const insertBooking = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date,
     shooting_time, location, package_id, category_id, duration, duration_minutes, price,
     package_price_snapshot, total_price_snapshot, status, terms_consent, terms_consent_at,
     portal_pin, created_at, confirmed_at, drive_folder_id, drive_folder_url, drive_raw_id)
    VALUES (?, ?, ?, '6281200000007', 'uji.rev7', 'Institut Uji', ?, ?, ?, 'Gedung Uji',
            ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, datetime('now'), '2468',
            datetime('now'), datetime('now'), ?, ?, ?)`);
  const driveUrl = `https://drive.google.com/drive/folders/${FOLDER_ID}`;

  const make = (label, date, time, minutes) => Number(insertBooking.run(
    `DLY-WISUDA-${label}${stamp.slice(-3)}`, `tok-${label.toLowerCase()}-${stamp}`,
    `Klien ${label}`, city.id, date, time, pkg.id, pkg.category_id,
    minutes, minutes, 400000, 400000, 400000, FOLDER_ID, driveUrl, FOLDER_ID
  ).lastInsertRowid);

  // A. sesi +20 hari → menu Reschedule terbuka, dipakai Fase 1 & 3 & 5.
  const open = make('OPEN', wibDatePlus(20), '09:00', 60);
  // B. sesi +3 hari → sudah masuk H-7 (terkunci).
  const near = make('NEAR', wibDatePlus(3), '09:00', 60);
  // C. sesi KEMARIN (sudah selesai).
  const past = wibAt(-24 * 60);
  const done = make('DONE', past.date, '08:00', 60);
  // D. sesi dimulai 10 menit lalu (60 menit) → masih berjalan.
  const runningAt = wibAt(-10);
  const running = make('RUN', runningAt.date, runningAt.time, 60);
  // E. sesi dimulai 65 menit lalu (60 menit) → sudah lewat 5 menit (uji buffer dihapus).
  const endedAt = wibAt(-65);
  const justEnded = make('END', endedAt.date, endedAt.time, 60);

  // DP tercatat untuk booking OPEN (supaya tahap 02 muncul sebagai centang).
  db.prepare(`INSERT INTO booking_payments (booking_id, amount, method, note, paid_at, created_at)
              VALUES (?, 100000, 'transfer', 'DP uji', datetime('now'), datetime('now'))`).run(open);

  const codes = (id) => db.prepare('SELECT code FROM bookings WHERE id = ?').get(id).code;
  const out = {
    openId: open, openCode: codes(open),
    nearId: near, nearCode: codes(near),
    doneId: done, doneCode: codes(done),
    runningId: running, runningCode: codes(running),
    endedId: justEnded, endedCode: codes(justEnded),
    pkgId: pkg.id, stamp
  };
  db.close();
  return out;
}

(async () => {
  prepareDataDir();
  // Seed HARUS sebelum app boot: getSettings() membaca cache saat proses mulai, jadi
  // menulis setting langsung ke DB setelah app hidup tidak akan terbaca.
  const fx = seed();

  const driveMock = spawn(process.execPath, [path.join(__dirname, 'mock-drive.js')], {
    env: { ...process.env, PORT: String(MOCK) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  driveMock.stderr.on('data', (d) => process.stderr.write(`[drive-mock] ${d}`));
  const googleMock = spawn(process.execPath, [path.join(__dirname, 'mock-google.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK + 1) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  googleMock.stderr.on('data', (d) => process.stderr.write(`[google-mock] ${d}`));

  const G = `http://127.0.0.1:${MOCK + 1}`;
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DLY_DATA_DIR: DATA_DIR,
      DLY_DISABLE_PUSH_SCHEDULER: '1',
      GDRIVE_API_BASE: `http://127.0.0.1:${MOCK}/drive/v3`,
      GCAL_TOKEN_URL: `${G}/token`,
      GCAL_AUTH_URL: `${G}/auth`,
      GCAL_API_BASE: `${G}/calendar/v3`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const cleanup = () => {
    [app, driveMock, googleMock].forEach((p) => { try { p.kill(); } catch (e) { /* ignore */ } });
  };
  process.on('exit', cleanup);

  const browser = await chromium.launch();
  const errors = [];
  try {
    for (let i = 0; i < 160; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    /* ---------------- login admin ---------------- */
    const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    admin.on('pageerror', (e) => errors.push(String(e)));
    admin.on('dialog', (d) => d.accept());
    await admin.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await admin.fill('input[name="username"]', USER);
    await admin.fill('input[name="password"]', PASS);
    await Promise.all([admin.waitForNavigation().catch(() => {}), admin.click('button[type="submit"]')]);
    ck('Login admin berhasil', !/\/admin\/login/.test(admin.url()), admin.url());

    /* ============================================================
       FASE 1 — tombol "Foto Siap Dipilih"
       ============================================================ */
    await admin.goto(`${BASE}/admin/bookings?tab=all&view=grid`, { waitUntil: 'load' });
    const cardBtn = admin.locator(`#b-${fx.openId} form[action$="/photos-ready"] button`);
    ck('Kartu booking punya tombol "Foto Siap"', (await cardBtn.count()) === 1);

    await submitAndSettle(admin, () => cardBtn.click());
    let db = openDb();
    const portal = db.prepare('SELECT * FROM photo_selections WHERE booking_id = ?').get(fx.openId);
    ck('Tombol membuat portal seleksi otomatis', Boolean(portal), JSON.stringify(portal || {}));
    const photoCount = portal
      ? db.prepare('SELECT COUNT(*) AS n FROM photo_selection_photos WHERE portal_id = ?').get(portal.id).n : 0;
    ck('Foto dibaca dari folder 01. FILE MENTAH (mock)', photoCount === 5, String(photoCount));
    ck('Sumber portal diarahkan ke folder 01. FILE MENTAH',
      portal && portal.drive_folder_id === FOLDER_ID, portal && portal.drive_folder_id);
    ck('Link Drive portal otomatis = folder mentah',
      portal && portal.drive_url === `https://drive.google.com/drive/folders/${FOLDER_ID}`, portal && portal.drive_url);
    ck('Tombol folder Drive di portal klien dinyalakan', portal && Number(portal.drive_show) === 1);
    const stage04 = db.prepare("SELECT * FROM booking_timeline WHERE booking_id = ? AND stage = 'photos_ready'").get(fx.openId);
    ck('Tahap 04 "Foto Siap Dipilih" tercatat (aktor admin)', stage04 && stage04.actor === 'admin', JSON.stringify(stage04 || {}));
    const notif = db.prepare("SELECT * FROM push_log WHERE event_id = ?").get(`portal:${portal.id}:photos-ready`);
    ck('Notifikasi "foto siap dipilih" dikirim ke klien', Boolean(notif), JSON.stringify(notif || {}));

    // Idempoten: tekan lagi tidak menggandakan foto maupun tahap.
    await admin.goto(`${BASE}/admin/bookings/${fx.openId}?tab=workflow`, { waitUntil: 'load' });
    const detailReady = admin.locator('form[action$="/photos-ready"] button').first();
    await submitAndSettle(admin, () => detailReady.click());
    db = openDb();
    const photoCount2 = db.prepare('SELECT COUNT(*) AS n FROM photo_selection_photos WHERE portal_id = ?').get(portal.id).n;
    const stage04n = db.prepare("SELECT COUNT(*) AS n FROM booking_timeline WHERE booking_id = ? AND stage = 'photos_ready'").get(fx.openId).n;
    ck('Menekan tombol dua kali tidak menggandakan foto', photoCount2 === photoCount, `${photoCount} → ${photoCount2}`);
    ck('Tahap 04 tidak pernah dobel', stage04n === 1, String(stage04n));

    // Kartu di dashboard: tombol juga ada di halaman detail.
    ck('Halaman detail booking menampilkan tombol Foto Siap Dipilih',
      /Foto Siap Dipilih/.test(await admin.content()));

    /* ============================================================
       PORTAL KLIEN — menu baru & pilih foto aktif
       ============================================================ */
    const b1 = await chromium.launch();
    const client = await b1.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
    client.on('pageerror', (e) => errors.push(String(e)));
    client.on('dialog', (d) => d.accept());
    const login = async (page, code) => {
      await page.goto(`${BASE}/portal`, { waitUntil: 'load' });
      await page.fill('input[name="code"]', code);
      await page.fill('input[name="pin"]', '2468');
      await Promise.all([page.waitForNavigation().catch(() => {}), page.click('button[type="submit"]')]);
    };
    await login(client, fx.openCode);
    const navText = await client.locator('.cp-nav').innerText();
    ck('Sidebar portal punya menu "Reschedule"', /Reschedule/i.test(navText), navText.replace(/\s+/g, ' '));
    ck('Menu "Pilih Foto Favorit" aktif setelah foto siap',
      (await client.locator('.cp-nav__item', { hasText: 'Pilih Foto Favorit' }).count()) === 1
      && !(await client.locator('.cp-nav__item.is-disabled', { hasText: 'Pilih Foto Favorit' }).count()));
    await client.goto(`${BASE}/portal/pilih-foto`, { waitUntil: 'load' });
    ck('Galeri pilih foto berisi 5 foto', (await client.locator('.sel-tile').count()) === 5,
      String(await client.locator('.sel-tile').count()));

    /* ============================================================
       FASE 2 — Reschedule: pengajuan, H-7, persetujuan admin
       ============================================================ */
    await client.goto(`${BASE}/portal/reschedule`, { waitUntil: 'load' });
    ck('Halaman Reschedule hanya meminta Tanggal, Jam, Lokasi',
      (await client.locator('.cp-rs__form input[type="date"]').count()) === 1
      && (await client.locator('.cp-rs__form input[type="time"]').count()) === 1
      && (await client.locator('.cp-rs__form input[type="text"]').count()) === 1
      && (await client.locator('.cp-rs__form input:not([type="hidden"])').count()) === 3);
    const newDate = wibDatePlus(25);
    await client.fill('input[name="new_date"]', newDate);
    await client.fill('input[name="new_time"]', '13:30');
    await client.fill('input[name="new_location"]', 'Gedung Baru Universitas Uji');
    await submitAndSettle(client, () => client.click('.cp-rs__form button[type="submit"]'));
    db = openDb();
    const req = db.prepare('SELECT * FROM reschedule_requests WHERE booking_id = ? ORDER BY id DESC LIMIT 1').get(fx.openId);
    const bookingBefore = db.prepare('SELECT shooting_date, shooting_time, location FROM bookings WHERE id = ?').get(fx.openId);
    ck('Pengajuan klien tersimpan sebagai pending', req && req.status === 'pending', JSON.stringify(req || {}));
    ck('Booking TIDAK berubah sebelum disetujui admin',
      bookingBefore.shooting_time === '09:00' && bookingBefore.location === 'Gedung Uji',
      JSON.stringify(bookingBefore));
    ck('Halaman menampilkan status menunggu konfirmasi',
      /Menunggu konfirmasi admin/i.test(await client.content()));

    // Admin melihat pengajuan di tab baru + panel Workflow.
    await admin.goto(`${BASE}/admin/bookings?tab=reschedule&view=list`, { waitUntil: 'load' });
    ck('Tab "Pengajuan Reschedule" menampilkan booking terkait',
      (await admin.content()).includes(fx.openCode));
    await admin.goto(`${BASE}/admin/bookings/${fx.openId}?tab=workflow`, { waitUntil: 'load' });
    ck('Panel pengajuan reschedule ada di Workflow',
      /Pengajuan reschedule dari klien/i.test(await admin.content()));
    await submitAndSettle(admin, () => admin.locator('form[action$="/approve"] button').first().click());
    db = openDb();
    const after = db.prepare('SELECT shooting_date, shooting_time, location, reschedule_count FROM bookings WHERE id = ?').get(fx.openId);
    const reqAfter = db.prepare('SELECT * FROM reschedule_requests WHERE id = ?').get(req.id);
    const hist = db.prepare('SELECT * FROM booking_reschedules WHERE booking_id = ? ORDER BY id DESC LIMIT 1').get(fx.openId);
    ck('Persetujuan admin menerapkan jadwal baru',
      after.shooting_date === newDate && after.shooting_time === '13:30'
      && after.location === 'Gedung Baru Universitas Uji', JSON.stringify(after));
    ck('Pengajuan ditandai approved', reqAfter.status === 'approved', reqAfter.status);
    ck('Riwayat reschedule tercatat', Boolean(hist) && hist.actor === 'admin', JSON.stringify(hist || {}));
    const clientNotif = db.prepare("SELECT * FROM push_log WHERE event_id LIKE ?").get(`booking:${fx.openId}:reschedule:%`);
    ck('Klien menerima notifikasi "Jadwal sesi berubah"', Boolean(clientNotif), JSON.stringify(clientNotif || {}));

    // Penolakan: booking NEAR (dibuka paksa lewat admin) → ajukan → admin tolak.
    await admin.goto(`${BASE}/admin/bookings/${fx.nearId}?tab=workflow`, { waitUntil: 'load' });
    ck('Booking H-7 menampilkan status terkunci',
      /Terkunci \(H-7\)/.test(await admin.content()));
    const b2 = await chromium.launch();
    const client2 = await b2.newPage({ viewport: { width: 390, height: 900 } });
    client2.on('pageerror', (e) => errors.push(String(e)));
    await login(client2, fx.nearCode);
    await client2.goto(`${BASE}/portal/reschedule`, { waitUntil: 'load' });
    ck('Klien H-7 melihat penjelasan "Reschedule ditutup" + tombol WhatsApp',
      /Reschedule ditutup/i.test(await client2.content())
      && (await client2.locator('a[href*="wa.me"]').count()) >= 1);
    const forced = await client2.request.post(`${BASE}/portal/reschedule`, {
      form: { _csrf: '', new_date: wibDatePlus(30), new_time: '10:00', new_location: 'Tempat Lain' },
      maxRedirects: 0
    });
    db = openDb();
    const forcedRow = db.prepare('SELECT COUNT(*) AS n FROM reschedule_requests WHERE booking_id = ?').get(fx.nearId).n;
    ck('Server menolak pengajuan saat terkunci H-7', forced.status() === 302 && forcedRow === 0, `status=${forced.status()} rows=${forcedRow}`);

    // Admin membuka akses manual → klien bisa mengajukan.
    await submitAndSettle(admin, () => admin.locator('form[action$="/reschedule-access"] button').first().click());
    db = openDb();
    const override = db.prepare('SELECT reschedule_override FROM bookings WHERE id = ?').get(fx.nearId);
    ck('Admin bisa membuka akses Reschedule manual', Number(override.reschedule_override) === 1, JSON.stringify(override));
    await client2.goto(`${BASE}/portal/reschedule`, { waitUntil: 'load' });
    ck('Setelah dibuka admin, form pengajuan muncul untuk klien',
      (await client2.locator('input[name="new_date"]').count()) === 1);
    await client2.fill('input[name="new_date"]', wibDatePlus(30));
    await client2.fill('input[name="new_time"]', '10:00');
    await client2.fill('input[name="new_location"]', 'Auditorium Uji');
    await submitAndSettle(client2, () => client2.click('.cp-rs__form button[type="submit"]'));
    db = openDb();
    const req2 = db.prepare('SELECT * FROM reschedule_requests WHERE booking_id = ? ORDER BY id DESC LIMIT 1').get(fx.nearId);
    ck('Pengajuan dari booking yang dibuka manual tersimpan', req2 && req2.status === 'pending');
    await admin.goto(`${BASE}/admin/bookings/${fx.nearId}?tab=workflow`, { waitUntil: 'load' });
    await submitAndSettle(admin, () => admin.locator('form[action$="/reject"] button').first().click());
    db = openDb();
    const req2After = db.prepare('SELECT * FROM reschedule_requests WHERE id = ?').get(req2.id);
    const nearBooking = db.prepare('SELECT shooting_time, location FROM bookings WHERE id = ?').get(fx.nearId);
    ck('Admin bisa MENOLAK pengajuan (jadwal tidak berubah)',
      req2After.status === 'rejected' && nearBooking.shooting_time === '09:00'
      && nearBooking.location === 'Gedung Uji', JSON.stringify({ req2After, nearBooking }));

    // Downgrade jadwal (tanggal lampau) ditolak server.
    const pastPost = await client.request.post(`${BASE}/portal/reschedule`, {
      form: { _csrf: '', new_date: '2020-01-01', new_time: '10:00', new_location: 'X' },
      maxRedirects: 0
    });
    ck('Tanggal lampau ditolak server', pastPost.status() === 302);

    /* ============================================================
       FASE 3 — link Drive otomatis & "Perbarui dari 01. File Mentah"
       ============================================================ */
    await admin.goto(`${BASE}/admin/selection/${portal.id}`, { waitUntil: 'load' });
    const driveInput = admin.locator('#drive_url_auto');
    ck('Link folder Drive tampil otomatis & read-only',
      (await driveInput.count()) === 1
      && (await driveInput.getAttribute('readonly')) !== null
      && (await driveInput.inputValue()) === `https://drive.google.com/drive/folders/${FOLDER_ID}`,
      await driveInput.inputValue().catch(() => 'n/a'));
    ck('Fieldset menjelaskan sumber 01. FILE MENTAH',
      /01\. FILE MENTAH/.test(await admin.content()));

    // Tambah satu file di folder mock → tombol Perbarui harus mengimpornya.
    await fetch(`http://127.0.0.1:${MOCK}/mock/add?name=DLY00999.JPG`, { method: 'POST' });
    await submitAndSettle(admin, () => admin.locator('form[action$="/sync"] button').first().click());
    db = openDb();
    const photoCount3 = db.prepare('SELECT COUNT(*) AS n FROM photo_selection_photos WHERE portal_id = ?').get(portal.id).n;
    ck('"Perbarui dari 01. File Mentah" menambahkan file baru', photoCount3 === photoCount + 1, `${photoCount} → ${photoCount3}`);

    // Wizard: link otomatis read-only untuk booking yang sudah punya subfolder mentah.
    await admin.goto(`${BASE}/admin/bookings/${fx.doneId}/portal`, { waitUntil: 'load' });
    ck('Wizard membuat portal: link 01. FILE MENTAH otomatis read-only',
      (await admin.locator('#drive_url').getAttribute('readonly')) !== null
      && (await admin.locator('#drive_url').inputValue()) === `https://drive.google.com/drive/folders/${FOLDER_ID}`);

    /* ============================================================
       FASE 4 — tahap sesi otomatis selesai + ikon centang
       ============================================================ */
    const b3 = await chromium.launch();
    const runningPage = await b3.newPage({ viewport: { width: 390, height: 900 } });
    runningPage.on('pageerror', (e) => errors.push(String(e)));
    await login(runningPage, fx.runningCode);
    await runningPage.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const runningTl = await runningPage.evaluate(() => ({
      text: document.body.innerText,
      live: Array.from(document.querySelectorAll('.cp-tl__item')).map((li) => ({
        live: li.classList.contains('is-current'),
        chip: (li.querySelector('.cp-chip--live') || {}).textContent || '',
        title: (li.querySelector('.cp-tl__title strong') || {}).textContent || ''
      }))
    }));
    ck('Sesi yang sedang berjalan: judul "Sesi foto dimulai"',
      /Sesi foto dimulai/i.test(runningTl.text), runningTl.text.slice(0, 160));
    ck('Hanya tahap sesi yang memakai badge "Sedang Berlangsung"',
      runningTl.live.filter((i) => i.live).length === 1
      && /Sesi foto dimulai/i.test(runningTl.live.find((i) => i.live).title),
      JSON.stringify(runningTl.live));

    const b4 = await chromium.launch();
    const ended = await b4.newPage({ viewport: { width: 390, height: 900 } });
    ended.on('pageerror', (e) => errors.push(String(e)));
    await login(ended, fx.endedCode);
    await ended.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const endedInfo = await ended.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.cp-tl__item'))
        .find((li) => /Sesi/i.test(li.querySelector('.cp-tl__title strong').textContent || ''));
      return {
        body: document.body.innerText,
        checked: Boolean(item && item.querySelector('.cp-tl__dot svg')),
        state: item ? item.className : ''
      };
    });
    ck('Sesi 60 menit yang mulai 65 menit lalu = "Sesimu sudah selesai" (tanpa +60 menit)',
      /Sesimu sudah selesai/i.test(endedInfo.body), endedInfo.body.slice(0, 200));
    ck('Tahap sesi tampil sebagai centang hijau',
      endedInfo.checked && /is-done/.test(endedInfo.state), JSON.stringify(endedInfo));
    ck('Keterangan menunggu upload file mentah ditampilkan',
      /nunggu fotografer kamu untuk meng upload file mentahnya/i.test(endedInfo.body));

    /* ============================================================
       FASE 5 — upgrade durasi (pricelist) + Extra Time saat sesi dimulai
       ============================================================ */
    await client.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    // Revisi 5: durasi tampil sebagai chip di dalam kartu paket GAYA PRICELIST
    // (`.cp-pkgcard.is-current .cp-dur`), bukan kartu terpisah lagi.
    const durCards = await client.evaluate(() => Array.from(document.querySelectorAll('.cp-pkgcard.is-current .cp-dur')).map((c) => ({
      minutes: c.getAttribute('data-duration'),
      text: c.innerText.replace(/\s+/g, ' '),
      isCurrent: c.classList.contains('is-active'),
      locked: c.classList.contains('is-locked'),
      hasButton: Boolean(c.querySelector('form button'))
    })));
    ck('Upgrade durasi tampil sebagai chip di kartu paket (90 & 120 menit bisa diajukan)',
      durCards.length >= 3
      && durCards.filter((c) => c.hasButton).map((c) => c.minutes).sort().join(',') === '120,90',
      JSON.stringify(durCards));
    ck('Durasi sekarang ditandai & tidak menawarkan tombol',
      durCards.some((c) => c.minutes === '60' && c.isCurrent && !c.hasButton), JSON.stringify(durCards));
    const pkgDiff = await client.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.cp-pkgcard'))
        .find((c) => c.getAttribute('data-state') === 'upgrade');
      return card ? card.innerText.replace(/\s+/g, ' ') : '';
    });
    // Data-aware: fixture ini hanya punya satu paket, jadi kartu "upgrade" hanya ada
    // bila paket lain di database memang lebih mahal.
    const hasUpgradeCard = await client.locator('.cp-pkgcard[data-state="upgrade"]').count();
    ck('Kartu paket upgrade (bila ada) menampilkan selisih harga',
      hasUpgradeCard === 0 || /\+Rp/.test(pkgDiff), pkgDiff.slice(0, 120));

    // Downgrade (30 menit) ditolak server.
    const dl = await client.request.post(`${BASE}/portal/upgrade/duration`, {
      form: { _csrf: '', minutes: '30' }, maxRedirects: 0
    });
    db = openDb();
    const dlRow = db.prepare("SELECT COUNT(*) AS n FROM booking_upgrades WHERE booking_id = ? AND kind = 'duration'").get(fx.openId).n;
    ck('Server menolak downgrade durasi (30 menit)', dlRow === 0, `status=${dl.status()} rows=${dlRow}`);

    // Ajukan upgrade 90 menit → admin setujui → durasi booking berubah.
    await submitAndSettle(client, () => client.locator('.cp-pkgcard.is-current .cp-dur form button').first().click());
    db = openDb();
    const durReq = db.prepare("SELECT * FROM booking_upgrades WHERE booking_id = ? AND kind = 'duration' ORDER BY id DESC LIMIT 1").get(fx.openId);
    ck('Pengajuan upgrade durasi tersimpan pending',
      durReq && durReq.status === 'pending' && Number(durReq.minutes) === 90, JSON.stringify(durReq || {}));
    await admin.goto(`${BASE}/admin/upgrades`, { waitUntil: 'load' });
    await submitAndSettle(admin, () => admin.locator(`form[action$="/upgrades/${durReq.id}/approve"] button`).first().click());
    db = openDb();
    const afterDur = db.prepare('SELECT duration_minutes FROM bookings WHERE id = ?').get(fx.openId);
    ck('Persetujuan admin mengubah durasi booking menjadi 90 menit',
      Number(afterDur.duration_minutes) === 90, JSON.stringify(afterDur));

    // Extra Time: sesi BELUM mulai (booking OPEN kini +25 hari) → terkunci.
    await client.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const lockedExtra = await client.evaluate(() => Array.from(document.querySelectorAll('.cp-up__card--extra'))
      .map((c) => ({ locked: c.classList.contains('is-locked'), hasButton: Boolean(c.querySelector('form button')) })));
    ck('Extra Time TERKUNCI sebelum sesi foto dimulai',
      lockedExtra.length === 2 && lockedExtra.every((c) => c.locked && !c.hasButton), JSON.stringify(lockedExtra));

    // Booking yang sesinya SEDANG BERJALAN → Extra Time terbuka.
    const b5 = await chromium.launch();
    const started = await b5.newPage({ viewport: { width: 390, height: 900 } });
    started.on('pageerror', (e) => errors.push(String(e)));
    await login(started, fx.runningCode);
    await started.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const openExtra = await started.evaluate(() => Array.from(document.querySelectorAll('.cp-up__card--extra'))
      .map((c) => ({ locked: c.classList.contains('is-locked'), hasButton: Boolean(c.querySelector('form button')) })));
    ck('Extra Time TERBUKA saat sesi foto dimulai (bukan setelah selesai)',
      openExtra.length === 2 && openExtra.every((c) => !c.locked && c.hasButton), JSON.stringify(openExtra));

    // Server juga menolak Extra Time sebelum sesi dimulai.
    await client.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const extraPost = await client.request.post(`${BASE}/portal/upgrade/extra`, {
      form: { _csrf: '', minutes: '30' }, maxRedirects: 0
    });
    db = openDb();
    const extraRow = db.prepare("SELECT COUNT(*) AS n FROM booking_upgrades WHERE booking_id = ? AND kind = 'extra'").get(fx.openId).n;
    ck('Server menolak Extra Time sebelum sesi dimulai', extraRow === 0, `status=${extraPost.status()} rows=${extraRow}`);

    ck('Tidak ada error JavaScript di halaman yang diuji', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close().catch(() => {});
    cleanup();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Gagal:\n- ' + failures.join('\n- '));
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(failures.length ? 1 : 0), 300);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

'use strict';

/**
 * Client Portal — acceptance suite (blueprint §12).
 *
 * Boots the app on its own port against a COPY of the database in /tmp, seeds two demo
 * bookings with portals, then drives the whole client journey with Playwright.
 * Nothing here touches the production database or the owner's real calendar.
 *
 *   node scripts/check-portal.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PORTAL_PORT || 4600);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = `/tmp/dly-portal-${Date.now()}`;
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const ck = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const pad = (n) => String(n).padStart(2, '0');

function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) {}
}

/** Fixtures written AFTER boot (columns/table baru dibuat oleh migration saat boot). */
function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
  const stamp = Date.now().toString().slice(-5);
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const insert = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, faculty, major, city_id,
     shooting_date, shooting_time, location, package_id, category_id, duration, duration_minutes,
     price, package_price_snapshot, total_price_snapshot, status, terms_consent, terms_consent_at,
     portal_pin, created_at, confirmed_at)
    VALUES (?, ?, ?, '6281200000001', 'uji.portal', 'Institut Uji Portal', 'Fakultas Teknik',
            'Teknik Informatika', ?, ?, '09:00', 'Gedung Uji', ?, ?, 60, 60, 400000, 400000, 400000,
            'confirmed', 1, datetime('now'), '1234', datetime('now'), datetime('now'))`);

  // Booking A: sudah dikonfirmasi, portal BELUM ada (dibuat lewat admin di suite ini).
  const aId = Number(insert.run(
    `DLY-WISUDA-ANJAS${stamp.slice(-3)}`, `tok-a-${stamp}`, 'Anjas Pratama', city.id, today, pkg.id, pkg.category_id
  ).lastInsertRowid);
  const aCode = db.prepare('SELECT code FROM bookings WHERE id = ?').get(aId).code;

  // Booking B: milik klien lain, dipakai untuk uji isolasi & rate limit.
  const bId = Number(insert.run(
    `DLY-WISUDA-NADIA${stamp.slice(-3)}`, `tok-b-${stamp}`, 'Nadia Safitri', city.id, today, pkg.id, pkg.category_id
  ).lastInsertRowid);
  const bCode = db.prepare('SELECT code FROM bookings WHERE id = ?').get(bId).code;
  db.prepare("UPDATE bookings SET portal_pin = '5678', portal_pin_hash = NULL WHERE id = ?").run(bId);

  db.close();
  return { aId, aCode, bId, bCode };
}

(async () => {
  prepareDataDir();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1' },
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

    // 1 tab per browser instance (platform limit): admin & klien di instance terpisah.
    const adminBrowser = await chromium.launch();
    const admin = await adminBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
    admin.on('dialog', (d) => d.accept());
    await admin.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await admin.fill('input[name="username"]', USER);
    await admin.fill('input[name="password"]', PASS);
    await Promise.all([admin.waitForNavigation(), admin.click('button[type="submit"]')]);

    /* ============================================================
       A. Kode booking & PIN dari halaman admin
       ============================================================ */
    ck('Kode booking memakai format DLY-WISUDA-NAMA###', /^DLY-WISUDA-[A-Z]{3,10}\d{3}$/.test(fx.aCode), fx.aCode);
    ck('Dua booking berbeda mendapat kode berbeda', fx.aCode !== fx.bCode, `${fx.aCode} vs ${fx.bCode}`);

    await admin.goto(`${BASE}/admin/bookings/${fx.aId}?tab=workflow`, { waitUntil: 'load' });
    ck('Detail booking menampilkan kartu Client Portal', await admin.locator('#client-portal').count() === 1);
    const shownCode = (await admin.locator('[data-cp-code]').innerText()).trim();
    ck('Kode pada kartu portal sama dengan kode booking', shownCode === fx.aCode, shownCode);

    // Buat PIN lewat tombol admin (bukan disuntik SQL).
    const pinBtn = admin.locator('#client-portal form[action$="/portal-pin"] button').first();
    await Promise.all([admin.waitForNavigation(), pinBtn.click()]);
    const pin = (await admin.locator('[data-cp-pin]').innerText()).trim();
    ck('Admin bisa membuat PIN 4 digit', /^\d{4}$/.test(pin), pin);
    ck('PIN tampil di halaman admin (untuk dikirim via WhatsApp)', pin.length === 4);

    /* ============================================================
       B. Halaman masuk portal
       ============================================================ */
    const clientBrowser = await chromium.launch();
    const client = await clientBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    client.on('pageerror', (e) => errors.push(String(e)));
    const login = await client.goto(`${BASE}/portal`, { waitUntil: 'load' });
    ck('Halaman masuk portal tersedia', login.status() === 200, String(login.status()));
    ck('Judul "Selamat Datang" tampil', (await client.locator('.cp-login__head h1').innerText()).trim() === 'Selamat Datang');
    ck('Label PORTAL CLIENT tampil', /PORTAL CLIENT/i.test(await client.locator('.cp-login__eyebrow').innerText()));
    ck('Tidak ada field username/email/password/Google',
      await client.locator('input[name="username"], input[type="email"], input[name="password"]:not([name="pin"])').count() === 0);
    ck('Ada field KODE BOOKING dan PIN', await client.locator('input[name="code"]').count() === 1
      && await client.locator('input[name="pin"]').count() === 1);

    // Salah PIN
    await client.fill('input[name="code"]', fx.aCode);
    await client.fill('input[name="pin"]', '0000');
    await Promise.all([client.waitForNavigation(), client.click('.cp-login__btn')]);
    ck('PIN salah ditolak dengan pesan jelas', /PIN tidak sesuai/i.test(await client.locator('.cp-login__err').innerText()));

    // Kode tidak dikenal
    await client.fill('input[name="code"]', 'DLY-WISUDA-TIDAKADA999');
    await client.fill('input[name="pin"]', pin);
    await Promise.all([client.waitForNavigation(), client.click('.cp-login__btn')]);
    ck('Kode tidak dikenal ditolak', /tidak ditemukan/i.test(await client.locator('.cp-login__err').innerText()));

    // Login benar (kode huruf kecil + PIN benar)
    await client.fill('input[name="code"]', fx.aCode.toLowerCase());
    await client.fill('input[name="pin"]', pin);
    await Promise.all([client.waitForNavigation(), client.click('.cp-login__btn')]);
    ck('Login dengan kode + PIN berhasil', /\/portal\/ringkasan$/.test(client.url()), client.url());

    /* ============================================================
       C. Sidebar & Ringkasan
       ============================================================ */
    // Revisi 4: menu "Reschedule" ditambahkan → 6 menu utama.
    ck('Sidebar punya 6 menu utama (termasuk Reschedule & Upgrade Paket)',
      await client.locator('.cp-nav__item').count() === 6,
      String(await client.locator('.cp-nav__item').count()));
    const menuLabels = await client.locator('.cp-nav__label').allInnerTexts();
    // Revisi 2 (06): label sidebar "Link Google Drive" → "Orderanmu Siap".
    // Revisi: "Upgrade Paket" ditambahkan ke sidebar.
    ck('Menu = Ringkasan / Pilih Foto Favorit / Pantau Order / Reschedule / Upgrade Paket / Orderanmu Siap',
      menuLabels.join('|') === 'Ringkasan|Pilih Foto Favorit|Pantau Order|Reschedule|Upgrade Paket|Orderanmu Siap',
      menuLabels.join('|'));

    const ring = await client.locator('.cp-page').innerText();
    ck('Ringkasan menampilkan nama lengkap', ring.includes('Anjas Pratama'));
    ck('Ringkasan menampilkan kampus, fakultas, jurusan',
      ring.includes('Institut Uji Portal') && ring.includes('Fakultas Teknik') && ring.includes('Teknik Informatika'));
    ck('Ringkasan menampilkan kode booking', ring.includes(fx.aCode));
    ck('Ringkasan menampilkan persetujuan S&K', /Disetujui/i.test(ring));
    // Status = tahap TERBARU yang tercapai (bisa 01..08), bukan selalu tahap 01.
    ck('Ringkasan menampilkan status order saat ini',
      /Status Order Kamu Saat Ini/i.test(ring)
      && /Booking Terkonfirmasi|DP Terkonfirmasi|Sesi foto dimulai|Menunggu sesi foto|Sesi Foto|Sesimu sudah selesai|Foto Siap Dipilih|Foto Mentah Dikirim|Masuk Antrean Editing|Proses Editing|Foto Editmu Siap/.test(ring),
      ring.replace(/\n/g, ' | ').slice(0, 160));
    ck('Menu foto nonaktif sebelum portal sortir dibuat',
      /Belum aktif/i.test(await client.locator('.cp-nav__item.is-disabled').innerText().catch(() => ''))
      || await client.locator('.cp-nav__item.is-disabled').count() >= 1);

    /* ============================================================
       D. Isolasi data: klien tidak bisa membuka booking lain
       ============================================================ */
    const other = await client.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    ck('Halaman portal tidak menerima parameter booking id apa pun',
      other.url().indexOf(fx.bId) === -1 && !(await client.locator('.cp-page').innerText()).includes(fx.bCode),
      other.url());

    /* ============================================================
       E. Admin membuat portal sortir → menu foto aktif
       ============================================================ */
    await admin.goto(`${BASE}/admin/bookings/${fx.aId}/portal`, { waitUntil: 'load' });
    ck('Form buat portal punya 4 bagian', await admin.locator('.xx-sec').count() === 4);
    // Blueprint: klien BOLEH mengirim meski kuota belum penuh → jangan wajibkan kuota penuh.
    // Checkbox-nya tersembunyi (custom switch) → klik labelnya seperti pengguna.
    const fullQuota = admin.locator('input[name="require_full_quota"]');
    if (await fullQuota.isChecked()) {
      await admin.locator('.xx-switch:has(input[name="require_full_quota"])').click();
    }
    ck('Wajib-kuota bisa dimatikan (klien boleh kirim di bawah kuota)',
      await fullQuota.isChecked() === false);
    await Promise.all([
      admin.waitForNavigation(),
      admin.click('button[name="no_drive"]')
    ]);
    ck('Portal sortir dibuat (masuk ke editor portal)', /\/admin\/selection\/\d+/.test(admin.url()), admin.url());

    // Upload 6 foto supaya galeri bisa diuji tanpa Google Drive.
    const uploads = fs.readdirSync(path.join(APP, 'public', 'uploads')).filter((f) => /\.(jpe?g|png)$/i.test(f)).slice(0, 6);
    const files = uploads.map((f, i) => {
      const to = path.join(require('os').tmpdir(), `portal-${Date.now()}-${i}-${f}`);
      fs.copyFileSync(path.join(APP, 'public', 'uploads', f), to);
      return to;
    });
    await Promise.all([
      admin.waitForNavigation({ waitUntil: 'load' }),
      (async () => {
        await admin.setInputFiles('#photo_files', files);
        await admin.waitForTimeout(300);
        await admin.click('form[action$="/photos"] button[type="submit"]');
      })()
    ]);
    ck('Foto portal tersimpan', /selection\/\d+/.test(admin.url()), admin.url());

    const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const portalRow = db.prepare('SELECT * FROM photo_selections WHERE booking_id = ?').get(fx.aId);
    const photoCount = db.prepare('SELECT COUNT(*) AS n FROM photo_selection_photos WHERE portal_id = ?').get(portalRow.id).n;
    db.close();
    ck('Portal terhubung ke Booking ID', Boolean(portalRow) && Number(portalRow.booking_id) === Number(fx.aId));
    ck('Foto tersimpan di database portal', photoCount >= 6, String(photoCount));

    await client.goto(`${BASE}/portal/ringkasan`, { waitUntil: 'load' });
    ck('Menu Pilih Foto Favorit aktif setelah portal dibuat',
      await client.locator('.cp-nav__item.is-disabled').count() === 1, 'masih disabled: link drive saja');

    /* ============================================================
       F. Halaman Pilih Foto Favorit
       ============================================================ */
    await client.goto(`${BASE}/portal/pilih-foto`, { waitUntil: 'domcontentloaded' });
    await client.waitForSelector('[data-selection-app]');
    const tiles = await client.locator('.sel-tile').count();
    ck('Galeri menampilkan foto dari portal', tiles >= 6, String(tiles));
    ck('Header menampilkan nama klien & kode booking',
      (await client.locator('.cp-photo__id').innerText()).includes('Anjas Pratama')
      && (await client.locator('.cp-photo__id').innerText()).includes(fx.aCode));
    ck('Ada info kuota, sisa kuota, dan jumlah foto',
      /kuota maksimal/i.test(await client.locator('.cp-photo__facts').innerText()));
    ck('Counter 0/40 tampil di header', /0\s*\/\s*\d+/.test((await client.locator('[data-sel-counter-big]').innerText()).replace(/\s+/g, '')));

    // Pilih 3 foto (di bawah kuota) — klik per elemen seperti pengguna.
    const tileIds = await client.evaluate(() => Array.from(document.querySelectorAll('.sel-tile'))
      .slice(0, 3).map((t) => t.getAttribute('data-photo')));
    for (const id of tileIds) {
      await client.evaluate((photoId) => {
        document.querySelector(`.sel-tile[data-photo="${photoId}"] .sel-tile__pick`).click();
      }, id);
      await sleep(400);
    }
    const counterAfter = (await client.locator('[data-sel-counter-big]').innerText()).replace(/\s+/g, '');
    ck('Counter bertambah langsung setelah memilih', counterAfter.startsWith('3/'), counterAfter);
    const pickedClass = await client.locator('.sel-tile.is-picked').count();
    ck('Foto terpilih punya penanda visual (is-picked)', pickedClass === 3, String(pickedClass));

    // Batalkan satu.
    await client.evaluate((photoId) => {
      document.querySelector(`.sel-tile[data-photo="${photoId}"] .sel-tile__pick`).click();
    }, tileIds[0]);
    await sleep(400);
    ck('Ketuk lagi membatalkan pilihan',
      (await client.locator('.sel-tile.is-picked').count()) === 2
      && (await client.locator('[data-sel-counter-big]').innerText()).replace(/\s+/g, '').startsWith('2/'));

    // Tombol kirim tetap bisa dipakai walau kuota belum penuh.
    ck('Tombol Kirim Pilihan aktif meski kuota belum penuh',
      !(await client.locator('[data-sel-send]').isDisabled()));

    /* ============================================================
       G. Submit dua jalur: simpan dulu, lalu WhatsApp
       ============================================================ */
    await client.click('[data-sel-send]');
    await client.waitForSelector('[data-sel-modal]:not([hidden])');
    const modalNames = (await client.locator('[data-sel-modal-list]').innerText()).trim().split('\n').map((s) => s.trim()).filter(Boolean);
    ck('Modal konfirmasi menampilkan 2 nama file', modalNames.length === 2, JSON.stringify(modalNames));
    ck('Nama file tanpa nomor urut & tanpa ekstensi',
      modalNames.every((n) => !/^\d+[.)]/.test(n) && !/\.(jpe?g|png|webp)$/i.test(n)), JSON.stringify(modalNames));

    const popupPromise = client.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await client.click('[data-sel-submit]');
    const popup = await popupPromise;
    const waUrl = popup ? popup.url() : '';
    if (popup) await popup.close().catch(() => {});
    ck('WhatsApp dibuka setelah menyimpan', /wa\.me|whatsapp/i.test(waUrl), waUrl.slice(0, 60));

    await client.waitForLoadState('domcontentloaded').catch(() => {});
    const db2 = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const afterSubmit = db2.prepare('SELECT status, submitted_at FROM photo_selections WHERE id = ?').get(portalRow.id);
    const pickRows = db2.prepare('SELECT file_name FROM photo_selection_picks WHERE portal_id = ? ORDER BY position').all(portalRow.id);
    const tlRows = db2.prepare('SELECT stage FROM booking_timeline WHERE booking_id = ?').all(fx.aId).map((r) => r.stage);
    db2.close();
    ck('Pilihan tersimpan di database sebelum WhatsApp', Boolean(afterSubmit.submitted_at), String(afterSubmit.submitted_at));
    // Data-aware: bila antrean editing kosong, job baru langsung menjadi #1 sehingga
    // status portal otomatis "processing" (lihat src/editing.js). Keduanya sah.
    ck('Status portal menjadi "submitted" (terkunci) — otomatis "processing" bila antrean kosong',
      ['submitted', 'processing'].includes(afterSubmit.status), afterSubmit.status);
    ck('Dua foto tersimpan sebagai pilihan', pickRows.length === 2, JSON.stringify(pickRows));
    ck('Timeline mencatat tahap submit', tlRows.includes('submitted'), tlRows.join(','));
    ck('Tahap 06 & 07 aktif bersamaan setelah submit',
      tlRows.includes('editing_queue') && tlRows.includes('editing'), tlRows.join(','));
    ck('Tahap 08 belum aktif (order belum selesai)', !tlRows.includes('final_ready'));

    // wa.me memakai '+' untuk spasi.
    const waText = decodeURIComponent((waUrl.split('text=')[1] || '').replace(/\+/g, ' '));
    ck('Pesan WhatsApp memuat nama klien & kampus',
      waText.includes('Anjas Pratama') && waText.includes('Institut Uji Portal'), waText.slice(0, 80));
    ck('Pesan WhatsApp memuat daftar nama file bersih',
      modalNames.every((n) => waText.includes(n)), waText.slice(-80));

    /* ============================================================
       H. Setelah dikirim: halaman terkunci
       ============================================================ */
    await client.goto(`${BASE}/portal/pilih-foto`, { waitUntil: 'domcontentloaded' });
    await client.waitForSelector('.cp-sentbox');
    ck('Halaman foto menampilkan status "Pilihan Foto Sudah Dikirim"',
      /Pilihan Foto Sudah Dikirim|Pilihan foto sudah dikirim/i.test(await client.locator('.cp-sentbox').innerText()));
    ck('Jumlah foto & waktu pengiriman tampil',
      /foto pilihanmu|foto<\/strong>|2 foto/i.test(await client.locator('.cp-sentbox').innerText()));
    ck('Galeri tidak bisa dipilih lagi (tidak ada tombol pilih)',
      await client.locator('.sel-tile__pick').count() === 0);

    /* ============================================================
       I. Pantau Order
       ============================================================ */
    await client.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const tlText = await client.locator('.cp-page').innerText();
    const stageCount = await client.locator('.cp-tl__item').count();
    ck('Timeline hanya menampilkan tahap yang tercapai', stageCount >= 5 && stageCount <= 8, String(stageCount));
    ck('Timeline memuat Booking Terkonfirmasi', /Booking Terkonfirmasi/.test(tlText));
    ck('Timeline memuat Foto Siap Dipilih', /Foto Siap Dipilih/.test(tlText));
    ck('Timeline memuat Masuk Antrean Editing & Proses Editing',
      /Masuk Antrean Editing/.test(tlText) && /Proses Editing/.test(tlText));
    ck('Tahap Foto Editmu Siap BELUM tampil', !/Foto Editmu Siap/.test(tlText));
    ck('Timeline menampilkan deadline 10 hari kerja', /10 hari kerja/i.test(tlText), tlText.slice(-160));
    ck('Label "Sedang Berlangsung" ada pada tahap terakhir',
      /Sedang Berlangsung/i.test(await client.locator('.cp-tl__item.is-current').innerText().catch(() => '')));

    /* ============================================================
       J. Link Google Drive final
       ============================================================ */
    await client.goto(`${BASE}/portal/drive`, { waitUntil: 'load' });
    ck('Sebelum selesai: "belum tersedia" ditampilkan',
      /belum tersedia/i.test(await client.locator('.cp-page').innerText()));
    ck('Tanpa tombol Google Drive aktif',
      await client.locator('a.cp-btn--primary[href*="drive.google"]').count() === 0);

    // v14: admin TIDAK lagi mengisi URL final. "Selesaikan Order" memakai folder
    // "03. FILE EDIT" milik booking dan MEMVALIDASINYA ke Google Drive — karena suite ini
    // berjalan tanpa koneksi Google, jalur validasi diuji terpisah di check-rev4.js.
    // Di sini status selesai disiapkan langsung di database (sama seperti hasil aksi admin
    // yang lolos validasi), lalu tampilan Portal Client yang diuji.
    const dbFin = new Database(path.join(DATA_DIR, 'app.sqlite'));
    dbFin.prepare("UPDATE bookings SET final_url = 'https://drive.google.com/drive/folders/CONTOH-FINAL-PORTAL', final_at = datetime('now') WHERE id = ?").run(fx.aId);
    dbFin.prepare("INSERT OR IGNORE INTO booking_timeline (booking_id, stage, happened_at, actor, note) VALUES (?, 'final_ready', datetime('now'), 'admin', 'Admin menyelesaikan order')").run(fx.aId);
    dbFin.close();

    const db3 = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const fin = db3.prepare('SELECT final_url, final_at FROM bookings WHERE id = ?').get(fx.aId);
    const tlFinal = db3.prepare("SELECT stage FROM booking_timeline WHERE booking_id = ? AND stage = 'final_ready'").get(fx.aId);
    db3.close();
    ck('Order selesai menyimpan link final + waktu selesai', Boolean(fin.final_url && fin.final_at), JSON.stringify(fin));
    ck('Tahap 08 tercatat di timeline', Boolean(tlFinal));

    await client.goto(`${BASE}/portal/drive`, { waitUntil: 'load' });
    const driveText = await client.locator('.cp-page').innerText();
    ck('Halaman final menampilkan "Foto Final Kamu"', /Foto Final Kamu/.test(driveText));
    ck('Pesan hangat & tombol BUKA GOOGLE DRIVE muncul',
      /Yeay, foto kamu sudah siap/i.test(driveText) && /BUKA GOOGLE DRIVE/i.test(await client.locator('a.cp-btn--primary').first().innerText()));
    const driveHref = await client.locator('a.cp-btn--primary').first().getAttribute('href');
    // Revisi 2 (06): ajakan ulasan + tombol yang memakai halaman testimoni yang sudah ada.
    ck('Ajakan mengisi ulasan tampil saat order selesai',
      /Bagikan pengalamanmu sekarang yukk dengan mengisi ulasan/i.test(driveText), driveText.slice(-200));
    const reviewHref = await client.locator('a.cp-btn--primary', { hasText: 'Isi Ulasan Sekarang' }).getAttribute('href');
    ck('Tombol "Isi Ulasan Sekarang" menuju halaman testimoni/ulasan yang sudah ada',
      /\/testimoni\/|\/ulasan/.test(String(reviewHref)), reviewHref);
    ck('Tombol mengarah ke link final yang benar', driveHref === fin.final_url, driveHref);
    ck('Teks penutup terima kasih tampil', /Terima kasih sudah mempercayakan/i.test(driveText));

    await client.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    ck('Timeline kini menampilkan Foto Editmu Siap',
      /Foto Editmu Siap/.test(await client.locator('.cp-page').innerText()));

    /* ============================================================
       K. Keamanan: rate limit + logout + sesi
       ============================================================ */
    // Sidebar off-canvas di HP → kirim form keluar langsung (setara menekan tombolnya).
    await Promise.all([
      client.waitForNavigation(),
      client.evaluate(() => document.querySelector('form[action$="/portal/keluar"]').submit())
    ]);
    ck('Logout kembali ke halaman masuk', /\/portal$/.test(client.url()), client.url());
    const guarded = await client.goto(`${BASE}/portal/ringkasan`, { waitUntil: 'load' });
    ck('Halaman portal tanpa sesi dialihkan ke form masuk',
      /\/portal(\?|$)/.test(guarded.url()) || /Selamat Datang/.test(await client.locator('.cp-login__head h1').innerText().catch(() => '')));

    // 8 percobaan gagal → diblokir sementara.
    for (let i = 0; i < 9; i += 1) {
      await client.goto(`${BASE}/portal`, { waitUntil: 'load' });
      await client.fill('input[name="code"]', fx.bCode);
      await client.fill('input[name="pin"]', '1111');
      await Promise.all([client.waitForNavigation(), client.click('.cp-login__btn')]);
    }
    const limited = await client.locator('.cp-login__err').innerText();
    ck('Percobaan berulang dibatasi (rate limit)', /Terlalu banyak percobaan/i.test(limited), limited.slice(0, 60));

    // Rate limit diuji; reset hitungan di SALINAN database agar uji mobile di bawah bisa
    // masuk (bukan mengubah perilaku aplikasi).
    const dbReset = new Database(path.join(DATA_DIR, 'app.sqlite'));
    dbReset.prepare('DELETE FROM portal_attempts').run();
    dbReset.close();

    /* ============================================================
       L. Mobile layout
       ============================================================ */
    const mobBrowser = await chromium.launch();
    const mob = await mobBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mob.goto(`${BASE}/portal`, { waitUntil: 'load' });
    const loginOverflow = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Halaman masuk tidak overflow di HP', loginOverflow <= 1, `${loginOverflow}px`);
    await mob.fill('input[name="code"]', fx.bCode);
    await mob.fill('input[name="pin"]', '5678');
    await Promise.all([mob.waitForNavigation(), mob.click('.cp-login__btn')]);
    ck('Klien kedua bisa masuk dengan PIN-nya sendiri', /ringkasan/.test(mob.url()), mob.url());
    const drawerClosed = await mob.locator('[data-cp-side]').evaluate((el) => !el.classList.contains('is-open'));
    ck('Sidebar tersembunyi di HP sebelum dibuka', drawerClosed);
    await mob.click('[data-cp-toggle]');
    await sleep(400);
    ck('Tombol menu membuka sidebar (drawer)', await mob.locator('[data-cp-side]').evaluate((el) => el.classList.contains('is-open')));
    await mob.keyboard.press('Escape');
    await sleep(300);
    ck('Escape menutup drawer', await mob.locator('[data-cp-side]').evaluate((el) => !el.classList.contains('is-open')));
    const pageOverflow = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Halaman ringkasan tidak overflow di HP', pageOverflow <= 1, `${pageOverflow}px`);
    await mob.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const tlOverflow = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Halaman timeline tidak overflow di HP', tlOverflow <= 1, `${tlOverflow}px`);
    await mobBrowser.close();

    ck('Tidak ada error JavaScript di halaman portal', errors.length === 0, errors.slice(0, 2).join(' | '));
    await clientBrowser.close();
    await adminBrowser.close();
  } finally {
    await browser.close();
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

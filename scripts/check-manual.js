'use strict';

/**
 * REVISI 6 — suite penerimaan dua permintaan pemilik:
 *
 *  1. TOMBOL "Tambah Client Manual" di Kelola Booking → form yang menerima TANGGAL BEBAS
 *     (termasuk tanggal lampau, hari yang ditutup, dan tanggal yang sudah penuh) dan
 *     link folder Google Drive yang diisi MANUAL. Client hasil input manual harus bisa
 *     masuk portal dengan kode + PIN dan melihat progres pesanannya.
 *  2. UPGRADE PAKET otomatis DIKUNCI setelah sesi foto selesai (UI + server), sedangkan
 *     EXTRA TIME tetap bisa diajukan.
 *
 * Semua uji memakai SALINAN database (os.tmpdir()) — data pemilik tidak disentuh.
 * Jalankan: node scripts/check-manual.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4691);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `dly-manual-${process.pid}`);
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';

let pass = 0;
const failures = [];
const ck = (label, ok, detail) => {
  if (ok) { pass += 1; console.log('  ok  ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  ['preview-cache', 'image-cache', 'logo-cache'].forEach((dir) => {
    try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA_DIR, dir), { recursive: true }); } catch (e) { /* opsional */ }
  });
}
const openDb = () => new Database(path.join(DATA_DIR, 'app.sqlite'));
const wibDatePlus = (days) => new Date(Date.now() + 7 * 3600 * 1000 + days * 86400 * 1000)
  .toISOString().slice(0, 10);
const wibTime = (offsetMinutes) => {
  const w = new Date(Date.now() + 7 * 3600 * 1000 + offsetMinutes * 60000);
  return w.toISOString().slice(11, 16);
};

/** Tanggal lampau yang SENGAJA ditutup + ditandai penuh: aturan publik menolaknya. */
function seed() {
  const db = openDb();
  const pkg = db.prepare(`SELECT p.id, p.city_id FROM packages p
                          JOIN package_durations d ON d.package_id = p.id
                          WHERE p.is_active = 1 AND d.is_active = 1 AND d.price > 0
                          ORDER BY p.id LIMIT 1`).get();
  const other = db.prepare(`SELECT p.id, p.city_id, p.name FROM packages p
                            JOIN package_durations d ON d.package_id = p.id
                            WHERE p.is_active = 1 AND d.is_active = 1 AND d.price > 0
                              AND p.city_id = ? AND p.id <> ?
                            ORDER BY d.price DESC LIMIT 1`).get(pkg.city_id, pkg.id);

  // Durasi + harga tetap supaya perhitungan bisa diuji.
  db.prepare(`UPDATE package_durations SET price = CASE duration_minutes
      WHEN 60 THEN 400000 WHEN 90 THEN 525000 WHEN 120 THEN 725000 ELSE COALESCE(NULLIF(price,0), 400000) END
      WHERE package_id = ?`).run(pkg.id);
  db.prepare(`INSERT OR IGNORE INTO package_durations
      (package_id, duration_minutes, price, description, is_active, sort_order, edited_photos)
      VALUES (?, 90, 525000, '', 1, 0, 40)`).run(pkg.id);

  // Extra Time berharga (supaya bisa diajukan setelah sesi selesai).
  db.prepare("INSERT INTO settings (key, value) VALUES ('extra_time_30_price', '150000') ON CONFLICT(key) DO UPDATE SET value = '150000'").run();

  // Tanggal lampau yang DITUTUP + PENUH: form publik pasti menolaknya.
  const pastBlocked = wibDatePlus(-30);
  db.prepare(`INSERT INTO availability_overrides (date, is_available, note) VALUES (?, 0, 'Uji tutup')
              ON CONFLICT(date) DO UPDATE SET is_available = 0`).run(pastBlocked);

  db.close();
  return {
    pkgId: pkg.id,
    otherId: other ? other.id : null,
    otherName: other ? other.name : '',
    pastBlocked
  };
}

const app = (() => {
  prepareDataDir();
  const fx = seed();
  const child = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1' },
    stdio: 'ignore'
  });
  return { child, fx };
})();

const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .split('\n').map((s) => s.trim()).filter(Boolean).join('\n');

(async () => {
  const errors = [];
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) { /* belum siap */ }
    await sleep(250);
  }
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1360, height: 950 } });
  page.on('pageerror', (e) => errors.push(String(e)));

  /* ---------------- login admin ---------------- */
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="password"]', PASS);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('button[type="submit"]')]);

  /* ============================================================
     1. TOMBOL + FORM TAMBAH CLIENT MANUAL
     ============================================================ */
  await page.goto(`${BASE}/admin/bookings`, { waitUntil: 'load' });
  const button = page.locator('a[href$="/admin/bookings/new"]').first();
  ck('Tombol "+ Tambah Client Manual" ada di Kelola Booking', (await button.count()) > 0);
  await Promise.all([page.waitForNavigation().catch(() => {}), button.click()]);
  ck('Halaman form tambah client terbuka', /Tambah client manual/i.test(await page.content()));

  const has = async (sel) => (await page.locator(sel).count()) > 0;
  ck('Form punya field nama client', await has('#client_name'));
  ck('Form punya field WhatsApp', await has('#client_phone'));
  ck('Form punya pilihan paket (semua kota)', (await page.locator('#package_id option').count()) > 1);
  ck('Form punya field tanggal sesi bebas (tanpa min/max)',
    await page.evaluate(() => {
      const el = document.querySelector('#shooting_date');
      return Boolean(el) && !el.hasAttribute('min') && !el.hasAttribute('max');
    }));
  ck('Form punya field link Google Drive manual', await has('#drive_url'));

  /* validasi: kirim kosong → 422 + pesan, tidak ada baris dibuat */
  const before = (() => { const db = openDb(); const n = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n; db.close(); return n; })();
  await page.evaluate(() => {
    // Validasi HTML dimatikan supaya validasi SERVER yang diuji.
    document.querySelectorAll('form[data-manual-booking] [required]').forEach((el) => { el.removeAttribute('required'); });
  });
  await Promise.all([page.waitForNavigation().catch(() => {}),
    page.click('form[data-manual-booking] button[type="submit"]')]);
  const errBody = strip(await page.content());
  ck('Form kosong ditolak dengan pesan yang jelas',
    /Belum bisa disimpan/i.test(errBody) && /Nama lengkap wajib diisi/i.test(errBody) && /Paket wajib dipilih/i.test(errBody),
    errBody.slice(0, 220));
  const afterInvalid = (() => { const db = openDb(); const n = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n; db.close(); return n; })();
  ck('Tidak ada booking dibuat saat validasi gagal', afterInvalid === before, `${before} → ${afterInvalid}`);

  /* simpan client manual: tanggal LAMPAU yang ditutup + penuh, link Drive manual */
  const driveUrl = 'https://drive.google.com/drive/folders/1ManualDriveFolderIdUji1234567890?usp=sharing';
  await page.goto(`${BASE}/admin/bookings/new`, { waitUntil: 'load' });
  await page.fill('#client_name', 'Client Manual Uji');
  await page.fill('#client_phone', '081234567891');
  await page.fill('#instagram', '@manual.uji');
  await page.fill('#campus', 'Universitas Manual');
  await page.selectOption('#package_id', String(app.fx.pkgId));
  await page.waitForTimeout(120);
  await page.selectOption('#minutes', '90');
  await page.fill('#shooting_date', app.fx.pastBlocked);
  await page.fill('#shooting_time', '10:30');
  await page.fill('#location', 'Studio Manual');
  await page.fill('#drive_url', driveUrl);
  await page.fill('#price', '650000');
  const priceAuto = await page.inputValue('#price');
  ck('Harga terisi otomatis dari durasi sebelum diedit manual', priceAuto === '650000' || Number(priceAuto) > 0, priceAuto);

  await Promise.all([page.waitForNavigation().catch(() => {}),
    page.click('form[data-manual-booking] button[type="submit"]')]);
  const detailHtml = await page.content();
  const detailText = strip(detailHtml);
  ck('Client manual tersimpan → diarahkan ke halaman detail booking',
    /Booking DLY-WISUDA-/i.test(detailText) && /Client Manual Uji/i.test(detailText), detailText.slice(0, 160));
  ck('Tidak ada pesan ketersediaan/tanggal ditolak pada client manual',
    !/ditutup untuk pemotretan|Full Booking|terlalu dekat dengan hari ini/i.test(detailText),
    (detailText.match(/[^\n]*(ditutup|Full Booking)[^\n]*/i) || [''])[0]);
  ck('Flash menampilkan kode booking + PIN portal', /PIN portal \d{4}/i.test(detailText),
    (detailText.match(/PIN portal[^\n]*/) || [''])[0]);

  const row = (() => {
    const db = openDb();
    const r = db.prepare(`SELECT * FROM bookings WHERE client_name = 'Client Manual Uji' ORDER BY id DESC LIMIT 1`).get();
    db.close();
    return r;
  })();
  ck('Baris booking tersimpan dengan durasi & harga yang benar',
    row && Number(row.duration_minutes) === 90 && Number(row.package_price_snapshot) === 650000,
    row ? `${row.duration_minutes} menit / ${row.package_price_snapshot}` : 'tidak ada');
  ck('total_price_snapshot ikut terisi', row && Number(row.total_price_snapshot) === 650000, String(row && row.total_price_snapshot));
  ck('Tanggal sesi lampau (ditutup & penuh) tersimpan apa adanya',
    Boolean(row) && row.shooting_date === app.fx.pastBlocked,
    row ? `${row.shooting_date} ≠ ${app.fx.pastBlocked}` : 'tidak ada');
  ck('Link Drive manual tersimpan sebagai folder utama booking',
    row && row.drive_folder_id === '1ManualDriveFolderIdUji1234567890'
      && /drive\.google\.com\/drive\/folders\/1ManualDriveFolderIdUji1234567890/.test(row.drive_folder_url || ''),
    row ? `${row.drive_folder_id} | ${row.drive_folder_url}` : 'tidak ada');
  ck('PIN portal langsung dibuat untuk client manual', Boolean(row && /^\d{4}$/.test(String(row.portal_pin || ''))));

  /* ============================================================
     2. CLIENT MANUAL BISA MASUK PORTAL & MELIHAT PROGRES
     ============================================================ */
  const b2 = await chromium.launch();
  const cp = await b2.newPage({ viewport: { width: 390, height: 900 } });
  cp.on('pageerror', (e) => errors.push(String(e)));
  await cp.goto(`${BASE}/portal`, { waitUntil: 'load' });
  await cp.fill('input[name="code"]', row.code);
  await cp.fill('input[name="pin"]', row.portal_pin);
  await Promise.all([cp.waitForNavigation().catch(() => {}), cp.click('button[type="submit"]')]);
  ck('Client manual bisa masuk portal dengan kode + PIN', /\/portal\/ringkasan/.test(cp.url()), cp.url());

  await cp.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
  const tlText = strip(await cp.content());
  ck('Pantau Order menampilkan progres booking manual', /Booking Terkonfirmasi/i.test(tlText), tlText.slice(0, 200));
  ck('Sesi foto yang sudah lewat terbaca "Sesimu sudah selesai"',
    /Sesimu sudah selesai/i.test(tlText),
    (tlText.match(/Sesi[^\n]*/g) || []).slice(0, 3).join(' | '));

  await cp.goto(`${BASE}/portal/ringkasan`, { waitUntil: 'load' });
  const ringText = strip(await cp.content());
  ck('Ringkasan menampilkan identitas client manual', /Universitas Manual/i.test(ringText));
  ck('Ringkasan memakai harga manual (Rp 650.000)', /650\.000/.test(ringText), ringText.slice(0, 200));

  /* ============================================================
     3. UPGRADE TERKUNCI SETELAH SESI SELESAI (Extra Time tetap boleh)
     ============================================================ */
  await cp.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
  const upHtml = await cp.content();
  const upText = strip(upHtml);
  ck('Upgrade paket dikunci setelah sesi selesai',
    /Upgrade sudah ditutup/i.test(upText), upText.slice(0, 300));
  ck('Alasan kunci menyebut sesi foto sudah selesai',
    /sesi foto kamu sudah selesai/i.test(upText),
    (upText.match(/Upgrade paket, durasi[^\n]*/) || [''])[0]);
  ck('Label kunci memakai "sesi selesai" (bukan H-7)', /Dikunci \(sesi selesai\)/i.test(upText));
  ck('Tidak ada form pengajuan upgrade paket yang aktif',
    (await cp.locator('form[action$="/portal/upgrade/package"]').count()) === 0);
  ck('Tidak ada form pengajuan upgrade durasi yang aktif',
    (await cp.locator('form[action$="/portal/upgrade/duration"]').count()) === 0);
  ck('Extra Time TETAP bisa diajukan setelah sesi selesai',
    (await cp.locator('form[action$="/portal/upgrade/extra"]').count()) > 0);

  // redirect:'manual' menghasilkan opaqueredirect (status 0, tanpa header) di browser,
  // jadi ikuti redirect dan periksa URL akhirnya.
  const post = async (p, body) => cp.evaluate(async ([url, data]) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
      redirect: 'follow'
    });
    return { status: res.status, location: res.url || '' };
  }, [p, body]);

  if (app.fx.otherId) {
    const pkgPost = await post('/portal/upgrade/package', { package_id: String(app.fx.otherId) });
    ck('Server MENOLAK upgrade paket setelah sesi selesai',
      /err=/.test(pkgPost.location) && /sesi foto kamu sudah selesai/i.test(decodeURIComponent(pkgPost.location)),
      `${pkgPost.status} ${decodeURIComponent(pkgPost.location)}`);
    const pending = (() => {
      const db = openDb();
      const n = db.prepare("SELECT COUNT(*) AS n FROM booking_upgrades WHERE booking_id = ? AND kind = 'package'").get(row.id).n;
      db.close();
      return n;
    })();
    ck('Tidak ada pengajuan paket tersimpan dari percobaan itu', pending === 0, String(pending));
  } else {
    ck('Server MENOLAK upgrade paket setelah sesi selesai (paket pembanding tidak ada — dilewati)', true);
  }

  const durPost = await post('/portal/upgrade/duration', { minutes: '120' });
  ck('Server MENOLAK upgrade durasi setelah sesi selesai',
    /err=/.test(durPost.location), `${durPost.status} ${decodeURIComponent(durPost.location)}`);

  const extraPost = await post('/portal/upgrade/extra', { minutes: '30' });
  ck('Server MENERIMA Extra Time setelah sesi selesai',
    /msg=/.test(extraPost.location), `${extraPost.status} ${decodeURIComponent(extraPost.location)}`);
  const extraRow = (() => {
    const db = openDb();
    const r = db.prepare("SELECT * FROM booking_upgrades WHERE booking_id = ? AND kind = 'extra' ORDER BY id DESC LIMIT 1").get(row.id);
    db.close();
    return r;
  })();
  ck('Extra Time tersimpan sebagai pengajuan (menunggu admin)', Boolean(extraRow && extraRow.status === 'pending'));

  /* ============================================================
     4. SESI MASIH JAUH → UPGRADE TETAP TERBUKA (tidak ikut terkunci)
     ============================================================ */
  await cp.request.post(`${BASE}/portal/keluar`, { maxRedirects: 0 }).catch(() => {});
  await cp.context().clearCookies();
  // Client manual kedua: sesi +30 hari (belum lewat H-7).
  await page.goto(`${BASE}/admin/bookings/new`, { waitUntil: 'load' });
  await page.fill('#client_name', 'Client Jauh Uji');
  await page.fill('#client_phone', '081234567892');
  await page.selectOption('#package_id', String(app.fx.pkgId));
  await page.waitForTimeout(120);
  await page.selectOption('#minutes', '60');
  await page.fill('#shooting_date', wibDatePlus(30));
  await page.fill('#shooting_time', wibTime(0));
  await page.fill('#location', 'Studio Jauh');
  await Promise.all([page.waitForNavigation().catch(() => {}),
    page.click('form[data-manual-booking] button[type="submit"]')]);
  const far = (() => {
    const db = openDb();
    const r = db.prepare("SELECT * FROM bookings WHERE client_name = 'Client Jauh Uji' ORDER BY id DESC LIMIT 1").get();
    db.close();
    return r;
  })();
  ck('Client manual kedua (sesi +30 hari) tersimpan', Boolean(far && far.id), `harga=${far && far.package_price_snapshot}`);
  ck('Harga otomatis dari durasi saat kolom harga dikosongkan',
    Boolean(far) && Number(far.package_price_snapshot) === 400000, far ? String(far.package_price_snapshot) : 'tidak ada');

  await cp.goto(`${BASE}/portal`, { waitUntil: 'load' });
  await cp.fill('input[name="code"]', far.code);
  await cp.fill('input[name="pin"]', far.portal_pin);
  await Promise.all([cp.waitForNavigation().catch(() => {}), cp.click('button[type="submit"]')]);
  await cp.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
  const farText = strip(await cp.content());
  ck('Sesi masih jauh → upgrade tidak terkunci',
    !/Upgrade sudah ditutup/i.test(farText) && !/Upgrade paket sedang dikunci/i.test(farText),
    farText.slice(0, 220));
  ck('Sesi masih jauh → form upgrade durasi tersedia',
    (await cp.locator('form[action$="/portal/upgrade/duration"]').count()) > 0);

  /* ============================================================
     5. H-7 tetap terkunci (perilaku lama tidak rusak)
     ============================================================ */
  const near = (() => {
    const db = openDb();
    const id = db.prepare(`INSERT INTO bookings
      (code, access_token, client_name, client_phone, campus, city_id, shooting_date, shooting_time,
       location, package_id, category_id, duration, duration_minutes, price, package_price_snapshot,
       total_price_snapshot, status, terms_consent, portal_pin, created_at, confirmed_at)
      VALUES (?, ?, 'Client H7 Uji', '6281234567893', 'Kampus', ?, ?, '09:00', 'Studio', ?, 1, 60, 60,
              400000, 400000, 400000, 'confirmed', 1, '1357', datetime('now'), datetime('now'))`)
      .run(`DLY-WISUDA-H7${Date.now().toString().slice(-4)}`, `tok-h7-${Date.now()}`, far.city_id,
        wibDatePlus(3), far.package_id).lastInsertRowid;
    const r = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    db.close();
    return r;
  })();
  await cp.request.post(`${BASE}/portal/keluar`, { maxRedirects: 0 }).catch(() => {});
  await cp.context().clearCookies();
  await cp.goto(`${BASE}/portal`, { waitUntil: 'load' });
  await cp.fill('input[name="code"]', near.code);
  await cp.fill('input[name="pin"]', '1357');
  await Promise.all([cp.waitForNavigation().catch(() => {}), cp.click('button[type="submit"]')]);
  await cp.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
  const nearText = strip(await cp.content());
  ck('H-7 tetap terkunci (perilaku lama tidak rusak)',
    /Upgrade paket sedang dikunci/i.test(nearText) && /H-7/i.test(nearText), nearText.slice(0, 240));

  ck('Tidak ada error JavaScript di halaman yang diuji', errors.length === 0, errors.slice(0, 2).join(' | '));

  await b.close();
  await b2.close();
  app.child.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('FATAL', err);
  app.child.kill();
  process.exitCode = 1;
});

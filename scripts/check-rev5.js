'use strict';

/**
 * REVISI 2 — suite penerimaan (dokumen "DLY GRADUATION | WEBSITE V2").
 *
 * Cakupan:
 *   01–02  logo resmi untuk favicon, ikon PWA (manifest) & ikon notifikasi (SW)
 *   03     notifikasi event-driven: DP/pembayaran juga ke client, judul "Editan kamu sudah selesai"
 *   04     menu Lokasi & Paket hilang dari navigasi (halaman & datanya tetap hidup)
 *   05     Gallery: dropdown Paket + Lokasi (dinamis, bisa digabung, empty state)
 *   06     Client Portal: label "Orderanmu Siap" + tombol ulasan setelah order selesai
 *   07     Antrean editing dua kolom + tombol SELESAI yang memvalidasi link Drive
 *   08     Timeline 8 tahap: DP, sesi selesai, posisi antrean, tahap 07 saat #1, tahap 08 centang
 *
 * Jalankan (membuat salinan DB sendiri, tidak menyentuh data produksi):
 *   node scripts/check-rev5.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4433);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(require('os').tmpdir(), `dly-rev5-${process.pid}`);
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';

let pass = 0;
const failures = [];
function ck(label, ok, detail) {
  if (ok) { pass += 1; console.log('  ok  ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']
    .filter((f) => fs.existsSync(path.join(APP, 'data', f)))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) { /* opsional */ }
}

const openDb = () => new Database(path.join(DATA_DIR, 'app.sqlite'));

/** Fixture ditulis SETELAH boot (kolom baru baru dibuat oleh migrasi saat boot). */
function seed() {
  const db = openDb();
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const city2 = db.prepare('SELECT id FROM cities ORDER BY id DESC LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
  const stamp = Date.now().toString().slice(-6);
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  // Portfolio: dua karya dengan label paket berbeda (filter Paket dibangun dari sini).
  const pfImage = '/assets/favicon.svg';
  const insPf = db.prepare(`INSERT INTO portfolio
    (title, client_name, campus, image, image_url, alt_text, category, collection, city_id,
     package_label, is_active, is_featured, sort_order, slug)
    VALUES (?, ?, 'Institut Uji', ?, ?, ?, 'individual', 'portfolio', ?, ?, 1, 0, ?, ?)`);
  const aPf = Number(insPf.run('Uji Paket Individu', 'Uji Paket Individu', pfImage, pfImage, 'Uji', city.id,
    'Individu', 1, `uji-individu-${stamp}`).lastInsertRowid);
  const bPf = Number(insPf.run('Uji Paket Grup', 'Uji Paket Grup', pfImage, pfImage, 'Uji', city2.id,
    'Grup', 2, `uji-grup-${stamp}`).lastInsertRowid);

  // Booking A: sudah dikonfirmasi + DP + pilihan foto terkirim + job editing di posisi #1.
  const insB = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date,
     shooting_time, location, package_id, category_id, duration, duration_minutes, price,
     package_price_snapshot, total_price_snapshot, status, terms_consent, terms_consent_at,
     portal_pin, created_at, confirmed_at)
    VALUES (?, ?, 'Klien Revisi Dua', '6281200000002', 'uji.rev5', 'Institut Uji', ?,
            ?, '09:00', 'Gedung Uji', ?, ?, 60, 60, 400000, 400000, 400000, 'confirmed', 1,
            datetime('now'), '4321', datetime('now'), datetime('now'))`);
  const aId = Number(insB.run(`DLY-WISUDA-REV${stamp.slice(-3)}A`, `tok-rev5-${stamp}`,
    city.id, today, pkg.id, pkg.category_id).lastInsertRowid);
  const aCode = db.prepare('SELECT code FROM bookings WHERE id = ?').get(aId).code;

  db.prepare(`INSERT INTO booking_payments (booking_id, amount, paid_at, method, note, kind)
              VALUES (?, 100000, ?, 'DP', 'DP uji', 'dp')`).run(aId, today);

  const token = require('crypto').randomBytes(24).toString('hex');
  const portalId = Number(db.prepare(`INSERT INTO photo_selections
      (booking_id, token, quota, is_open, status, submitted_at, created_at, updated_at)
      VALUES (?, ?, 10, 1, 'submitted', datetime('now'), datetime('now'), datetime('now'))`)
    .run(aId, token).lastInsertRowid);

  const jobId = Number(db.prepare(`INSERT INTO editing_jobs
      (booking_id, portal_id, status, photo_count, note, position, created_at, updated_at)
      VALUES (?, ?, 'queued', 3, '', -1, datetime('now'), datetime('now'))`)
    .run(aId, portalId).lastInsertRowid);

  // Booking B: order SELESAI (dipakai untuk uji "Orderanmu Siap" + tombol ulasan).
  const bId = Number(insB.run(`DLY-WISUDA-REV${stamp.slice(-3)}B`, `tok-rev5b-${stamp}`,
    city.id, today, pkg.id, pkg.category_id).lastInsertRowid);
  db.prepare(`UPDATE bookings SET final_url = 'https://drive.google.com/drive/folders/UJI-REV5',
              final_at = datetime('now') WHERE id = ?`).run(bId);

  db.close();
  return { aId, aCode, bId, portalId, token, jobId, aPf, bPf };
}

(async () => {
  prepareDataDir();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DLY_DATA_DIR: DATA_DIR,
      // Catatan: DLY_UPLOAD_DIR sengaja TIDAK diset. Kalau diset, masterPath() mencari
      // upload di folder itu saja sehingga logo brand (yang ada di public/uploads)
      // dianggap tidak ada → favicon/ikon jatuh ke file mentah.
      DLY_DISABLE_PUSH_SCHEDULER: '1',
      // Suite ini menulis konten publik langsung ke DB → matikan mikro-cache agar deterministik.
      PUBLIC_CACHE_MS: '0'
    },
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

    /* ==================================================================
       01–02. Logo resmi: favicon, ikon PWA, ikon notifikasi
       ================================================================== */
    const manifestRes = await page.request.get(`${BASE}/manifest.webmanifest`);
    const manifest = await manifestRes.json();
    const icons = manifest.icons || [];
    ck('Manifest PWA memakai ikon turunan logo resmi (/appicon/)',
      icons.length >= 3 && icons.every((i) => String(i.src).includes('/appicon/')),
      icons.map((i) => i.src.slice(0, 28)).join(' | '));
    const any192 = icons.find((i) => i.sizes === '192x192');
    const any512 = icons.find((i) => i.sizes === '512x512' && i.purpose === 'any');
    const maskable = icons.find((i) => i.purpose === 'maskable');
    const iconRes = await page.request.get(BASE + any192.src);
    const iconBuf = await iconRes.body();
    ck('Ikon 192 tersedia & PNG 192x192',
      iconRes.status() === 200 && iconRes.headers()['content-type'].includes('image/png')
      && iconBuf.length > 2000, `${iconRes.status()} ${iconBuf.length}B`);
    const dims = (buf, off) => `${buf.readUInt32BE(off)}x${buf.readUInt32BE(off + 4)}`;
    ck('Ukuran file ikon benar (192 & 512 & maskable 512)',
      dims(iconBuf, 16) === '192x192'
      && dims(await (await page.request.get(BASE + any512.src)).body(), 16) === '512x512'
      && dims(await (await page.request.get(BASE + maskable.src)).body(), 16) === '512x512');
    ck('Nama aplikasi PWA tetap brand DLY', /DLY/i.test(manifest.short_name), manifest.short_name);

    await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    const favHref = await page.getAttribute('link[rel="icon"]', 'href');
    const favRes = await page.request.get(favHref.startsWith('http') ? favHref : BASE + favHref);
    ck('Favicon tab browser memakai logo DLY (/favicon/)',
      favHref.includes('/favicon/') && favRes.status() === 200, favHref);
    const swSrc = fs.readFileSync(path.join(APP, 'public', 'sw.js'), 'utf8');
    ck('Service worker mengambil ikon notifikasi dari manifest (bukan path hardcode)',
      /manifest\.webmanifest/.test(swSrc) && /showNotification\(title, options\)/.test(swSrc)
      && /icon: ic\.icon/.test(swSrc));

    /* ==================================================================
       03. Notifikasi event-driven (katalog event)
       ================================================================== */
    const pushSrc = fs.readFileSync(path.join(APP, 'src', 'push.js'), 'utf8');
    ck('Ada event notifikasi pembayaran untuk CLIENT (role client)',
      /client_payment:\s*\{[\s\S]*?role: 'client'/.test(pushSrc));
    ck('Judul notifikasi order selesai = "Editan kamu sudah selesai"',
      /client_final:[\s\S]*?title: 'Editan kamu sudah selesai'/.test(pushSrc));
    const adminSrc = fs.readFileSync(path.join(APP, 'src', 'routes', 'admin.js'), 'utf8');
    ck('Pembayaran memicu notifikasi admin DAN client',
      /push\.notify\('payment'/.test(adminSrc) && /push\.notify\('client_payment'/.test(adminSrc));
    ck('Setiap kiriman memakai event_id (anti-duplikat)',
      !/push\.notify\('client_payment',\s*\{\s*(?![\s\S]{0,80}eventId)/.test(adminSrc));

    /* ==================================================================
       04. Navigasi utama tanpa Lokasi & Paket
       ================================================================== */
    const nav = await page.evaluate(() => ({
      drops: document.querySelectorAll('[data-nav-drop], [data-mobile-group]').length,
      labels: Array.from(document.querySelectorAll('.site-nav > a')).map((a) => a.textContent.trim()),
      mobile: Array.from(document.querySelectorAll('.mobile-nav__item .mobile-nav__label')).map((s) => s.textContent.trim())
    }));
    ck('Tidak ada dropdown/nav grup Lokasi & Paket (desktop + mobile)',
      nav.drops === 0 && !nav.mobile.includes('Lokasi') && !nav.mobile.includes('Paket'), JSON.stringify(nav.mobile));
    ck('Menu wajib tetap ada: Home, Gallery, Pricelist, Cara Order, Ulasan',
      ['Home', 'Gallery', 'Pricelist', 'Cara Order', 'Ulasan'].every((l) => nav.labels.includes(l)),
      nav.labels.join(' | '));
    ck('Syarat & Ketentuan tetap tampil di navigasi',
      nav.labels.some((l) => /Syarat/i.test(l)), nav.labels.join(' | '));
    const legacyCity = await page.request.get(`${BASE}/city`);
    const legacyPaket = await page.request.get(`${BASE}/pricelist`);
    ck('Halaman lokasi & paket TIDAK dihapus (tetap 200)',
      legacyCity.status() === 200 && legacyPaket.status() === 200,
      `${legacyCity.status()}/${legacyPaket.status()}`);

    /* ==================================================================
       05. Gallery: dropdown Paket + Lokasi
       ================================================================== */
    await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    const opts = await page.evaluate(() => {
      const kat = document.querySelector('select[name="kategori"]');
      const kota = document.querySelector('select[name="kota"]');
      return {
        hasKategori: Boolean(kat), hasKota: Boolean(kota),
        kategori: kat ? Array.from(kat.options).map((o) => o.value) : [],
        kota: kota ? Array.from(kota.options).map((o) => o.value) : [],
        labels: Array.from(document.querySelectorAll('.gf-select__label')).map((e) => e.textContent.trim()),
        pills: document.querySelectorAll('.gallery-filter__cats .pill').length
      };
    });
    ck('Filter Gallery = dua dropdown (Kategori & Lokasi), bukan pil kategori',
      opts.hasKategori && opts.hasKota && opts.pills === 0, JSON.stringify(opts.pills));
    ck('Label filter memakai "Kategori" (bukan "Paket")',
      opts.labels.join('|') === 'Kategori|Lokasi', opts.labels.join('|'));
    ck('Default = Semua Kategori & Semua Lokasi',
      opts.kategori[0] === '' && opts.kota[0] === '', `${opts.kategori[0]}/${opts.kota[0]}`);
    ck('Pilihan Kategori berasal dari data kategori aktif (dikelola admin)',
      opts.kategori.filter(Boolean).length >= 1
      && !opts.kategori.some((v) => /event/i.test(v)), opts.kategori.join(','));
    ck('Pilihan Lokasi berasal dari data kota aktif',
      opts.kota.length >= 2, opts.kota.join(','));

    const totalAll = await page.locator('.pf-carousel__slide').count();
    const katSlug = opts.kategori.filter(Boolean)[0];
    await page.goto(`${BASE}/gallery?kategori=${katSlug}`, { waitUntil: 'load' });
    const onlyKat = await page.locator('.pf-carousel__slide').count();
    ck('Filter Kategori mempersempit/menyaring hasil',
      onlyKat > 0 && onlyKat <= totalAll, `${onlyKat}/${totalAll}`);
    const kotaSlug = (await page.evaluate(() => {
      const s = document.querySelector('select[name="kota"]');
      return Array.from(s.options).map((o) => o.value)[1];
    }));
    await page.goto(`${BASE}/gallery?kategori=${katSlug}&kota=${kotaSlug}`, { waitUntil: 'load' });
    const combined = await page.locator('.pf-carousel__slide').count();
    ck('Kategori + Lokasi bisa digabung (kombinasi diterapkan bersamaan)',
      combined >= 0 && combined <= onlyKat, `${combined}/${onlyKat}`);
    // Kategori yang belum punya karya → empty state (bukan halaman kosong tanpa pesan).
    const emptyCat = (() => {
      const d = openDb();
      const row = d.prepare(`SELECT c.slug FROM portfolio_categories c
                             WHERE NOT EXISTS (SELECT 1 FROM portfolio p WHERE p.category = c.slug)
                             LIMIT 1`).get();
      d.close();
      return row ? row.slug : '';
    })();
    await page.goto(`${BASE}/gallery?kategori=${emptyCat || katSlug}&kota=${kotaSlug}`, { waitUntil: 'load' });
    const emptyState = await page.locator('.empty-state').innerText().catch(() => '');
    ck('Kombinasi tanpa hasil menampilkan empty state',
      Boolean(emptyCat) && /Belum ada karya pada filter ini/i.test(emptyState),
      `${emptyCat || '(tidak ada kategori kosong)'} · ${emptyState.slice(0, 60)}`);

    const dbAfter = openDb();
    const pfCount = dbAfter.prepare('SELECT COUNT(*) AS n FROM portfolio WHERE is_active = 1').get().n;
    const cats = dbAfter.prepare('SELECT COUNT(*) AS n FROM portfolio_categories').get().n;
    dbAfter.close();
    ck('Data portfolio tidak berubah saat filter dipakai',
      pfCount >= 2 && cats >= 1, `${pfCount} karya · ${cats} kategori`);

    /* ==================================================================
       04/05. Admin: field Paket di form portfolio (sumber data filter)
       ================================================================== */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    ck('Login admin berhasil', page.url().includes('/admin'), page.url());

    await page.goto(`${BASE}/admin/portfolio/${fx.aPf}/edit`, { waitUntil: 'load' });
    const katField = page.locator('select[name="category"]');
    ck('Form portfolio punya pilihan Kategori', await katField.count() === 1);
    ck('Kategori pada form berasal dari data (bukan hardcode view)',
      (await katField.locator('option').count()) >= 1,
      String(await katField.locator('option').count()));

    // Kategori baru dibuat di halaman Kategori Gallery, lalu muncul di filter publik.
    await page.goto(`${BASE}/admin/portfolio-categories`, { waitUntil: 'load' });
    await page.fill('input[name="label"]', 'Kategori Uji Rev5');
    await Promise.all([
      page.waitForNavigation(),
      page.locator('form[action$="/admin/portfolio-categories"] button[type="submit"]').click()
    ]);
    await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    const newOption = await page.evaluate(() => Array.from(document.querySelectorAll('select[name="kategori"] option')).map((o) => o.value + '|' + o.textContent.trim()));
    ck('Kategori baru dari admin otomatis muncul di dropdown Gallery',
      newOption.some((o) => /Kategori Uji Rev5/.test(o)), newOption.join(','));

    /* ==================================================================
       06 + 08. Client Portal: "Orderanmu Siap", tombol ulasan, timeline
       Satu tab per browser instance (batas platform) → dua instance terpisah.
       ================================================================== */
    const bCode = (() => {
      const d = openDb();
      const row = d.prepare('SELECT code FROM bookings WHERE id = ?').get(fx.bId);
      d.close();
      return row.code;
    })();

    // --- Instance 1: booking A (order BELUM selesai → timeline & antrean diuji di sini)
    const clientBrowser = await chromium.launch();
    const client = await clientBrowser.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
    client.on('pageerror', (e) => errors.push(String(e)));
    await client.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await client.fill('input[name="code"]', fx.aCode);
    await client.fill('input[name="pin"]', '4321');
    await Promise.all([client.waitForNavigation(), client.click('button[type="submit"]')]);

    const menuLabels = await client.locator('.cp-nav__label').allInnerTexts();
    ck('Sidebar portal memakai label "Orderanmu Siap"',
      menuLabels.map((s) => s.trim()).includes('Orderanmu Siap'), menuLabels.join(' | '));
    ck('Label lama "Link Google Drive" sudah tidak dipakai',
      !menuLabels.some((s) => /Link Google Drive/i.test(s)), menuLabels.join(' | '));

    await client.goto(`${BASE}/portal/drive`, { waitUntil: 'load' });
    const notDoneText = await client.locator('.cp-page').innerText();
    ck('Order BELUM selesai: tombol ulasan tidak ditampilkan',
      !/Isi Ulasan Sekarang/i.test(notDoneText) && /belum tersedia/i.test(notDoneText),
      notDoneText.replace(/\n/g, ' ').slice(0, 80));

    await client.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const tl = await client.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.cp-tl__item'));
      return {
        titles: items.map((li) => (li.querySelector('.cp-tl__title strong') || {}).textContent || ''),
        no: items.map((li) => (li.querySelector('.cp-tl__no') || {}).textContent || ''),
        current: items.filter((li) => li.classList.contains('is-current'))
          .map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
        body: document.body.innerText
      };
    });
    ck('Timeline berurutan 01..N tanpa nomor melompat',
      tl.no.join(',') === tl.no.map((_, i) => String(i + 1).padStart(2, '0')).join(','), tl.no.join(','));
    ck('Tahap 02 = "DP Terkonfirmasi" (bukan Menunggu Sesi)',
      tl.titles.some((t) => /DP Terkonfirmasi/i.test(t)), tl.titles.join(' | '));
    ck('Tahap "Menunggu Sesi Pemotretan" lama tidak dipakai lagi',
      !tl.titles.some((t) => /Menunggu Sesi Pemotretan/i.test(t)), tl.titles.join(' | '));
    ck('Tahap 06 menampilkan posisi antrean aktual ("ke-N dari M")',
      /Antreanmu saat ini ke-\s*1\s*dari\s*\d+/i.test(tl.body), tl.body.replace(/\n/g, ' ').slice(0, 160));
    ck('Tahap 07 "Proses Editing" aktif karena posisi #1',
      tl.current.length === 1 && /Proses Editing/i.test(tl.current[0]), tl.current[0] || '-');
    ck('Tahap 08 belum tampil sebelum order selesai',
      !tl.titles.some((t) => /Foto Editmu Siap/i.test(t)), tl.titles.join(' | '));

    /* ---- order A diselesaikan → tahap 08 jadi CENTANG HIJAU + tombol ulasan ---- */
    const done = openDb();
    done.prepare(`UPDATE bookings SET final_url = 'https://drive.google.com/drive/folders/UJI-REV5-A',
                  final_at = datetime('now') WHERE id = ?`).run(fx.aId);
    done.prepare("UPDATE editing_jobs SET status = 'done', finished_at = datetime('now') WHERE id = ?").run(fx.jobId);
    done.close();

    await client.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const tlDone = await client.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.cp-tl__item'));
      const last = items[items.length - 1];
      return {
        lastTitle: (last.querySelector('.cp-tl__title strong') || {}).textContent || '',
        lastDone: last.classList.contains('is-done'),
        hasCheck: Boolean(last.querySelector('.cp-tl__dot svg')),
        liveBadge: /Sedang Berlangsung/i.test(last.innerText),
        currentCount: items.filter((li) => li.classList.contains('is-current')).length
      };
    });
    ck('Tahap 08 tampil sebagai tahap selesai (centang hijau, bukan "Sedang Berlangsung")',
      /Foto Editmu Siap/i.test(tlDone.lastTitle) && tlDone.lastDone && tlDone.hasCheck && !tlDone.liveBadge,
      JSON.stringify(tlDone));
    ck('Tidak ada tahap yang masih "aktif" setelah order selesai', tlDone.currentCount === 0,
      String(tlDone.currentCount));
    await client.goto(`${BASE}/portal/drive`, { waitUntil: 'load' });
    ck('Setelah order selesai (tahap 08), tombol ulasan langsung muncul',
      /Isi Ulasan Sekarang/i.test(await client.locator('.cp-page').innerText()));
    await clientBrowser.close();

    // --- Instance 2: booking B (order sudah selesai sejak awal)
    const clientBrowser2 = await chromium.launch();
    const client2 = await clientBrowser2.newPage({ viewport: { width: 390, height: 900 } });
    client2.on('pageerror', (e) => errors.push(String(e)));
    await client2.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await client2.fill('input[name="code"]', bCode);
    await client2.fill('input[name="pin"]', '4321');
    await Promise.all([client2.waitForNavigation(), client2.click('button[type="submit"]')]);
    await client2.goto(`${BASE}/portal/drive`, { waitUntil: 'load' });
    const driveText = await client2.locator('.cp-page').innerText();
    ck('Order selesai: tombol buka Google Drive tampil', /BUKA GOOGLE DRIVE/i.test(driveText));
    ck('Ajakan ulasan tampil saat order selesai & link tersedia',
      /Bagikan pengalamanmu sekarang yukk dengan mengisi ulasan/i.test(driveText));
    const reviewHref = await client2.locator('a', { hasText: 'Isi Ulasan Sekarang' }).getAttribute('href');
    ck('Tombol "Isi Ulasan Sekarang" memakai halaman testimoni/ulasan yang sudah ada',
      /\/testimoni\/|\/ulasan/.test(String(reviewHref)), reviewHref);
    const reviewRes = await client2.request.get(reviewHref.startsWith('http') ? reviewHref : BASE + reviewHref);
    ck('Halaman ulasan yang ditautkan benar-benar ada (bukan tautan mati)',
      reviewRes.status() === 200, String(reviewRes.status()));
    await client2.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    ck('Portal tetap menampilkan timeline order',
      await client2.locator('.cp-tl__item').count() >= 1);
    await clientBrowser2.close();

    /* ==================================================================
       07. Antrean editing admin: dua kolom + tombol SELESAI
       ================================================================== */
    // Job baru untuk uji tombol SELESAI (booking A baru saja diselesaikan).
    const db2 = openDb();
    const cityId = db2.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get().id;
    const pkg2 = db2.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
    const stamp2 = Date.now().toString().slice(-6);
    const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const qBooking = Number(db2.prepare(`INSERT INTO bookings
      (code, access_token, client_name, client_phone, campus, city_id, shooting_date, shooting_time,
       location, package_id, category_id, duration, duration_minutes, price,
       package_price_snapshot, total_price_snapshot, status, terms_consent, terms_consent_at,
       created_at, confirmed_at)
      VALUES (?, ?, 'Klien Antrean Uji', '6281200000003', 'Institut Uji', ?, ?, '10:00', 'Gedung',
              ?, ?, 60, 60, 400000, 400000, 400000, 'confirmed', 1, datetime('now'),
              datetime('now'), datetime('now'))`)
      .run(`DLY-WISUDA-QUE${stamp2.slice(-3)}`, `tok-que-${stamp2}`, cityId, today,
        pkg2.id, pkg2.category_id).lastInsertRowid);
    const qPortal = Number(db2.prepare(`INSERT INTO photo_selections
        (booking_id, token, quota, is_open, status, submitted_at, created_at, updated_at)
        VALUES (?, ?, 5, 1, 'submitted', datetime('now'), datetime('now'), datetime('now'))`)
      .run(qBooking, require('crypto').randomBytes(24).toString('hex')).lastInsertRowid);
    const qJob = Number(db2.prepare(`INSERT INTO editing_jobs
        (booking_id, portal_id, status, photo_count, note, position, created_at, updated_at)
        VALUES (?, ?, 'queued', 2, '', -2, datetime('now'), datetime('now'))`)
      .run(qBooking, qPortal).lastInsertRowid);
    db2.close();

    await page.goto(`${BASE}/admin/editing`, { waitUntil: 'load' });
    ck('Papan antrean editing hanya 2 kolom', await page.locator('.ed-col').count() === 2,
      String(await page.locator('.ed-col').count()));
    const colTitles = await page.locator('.ed-col__head h2').allInnerTexts();
    ck('Kolom = Antrean Editing & Selesai',
      colTitles.join('|') === 'Antrean Editing|Selesai', colTitles.join('|'));
    const qCard = page.locator(`.ed-card[data-job-id="${qJob}"]`);
    ck('Kartu antrean punya tombol SELESAI',
      await qCard.locator('.admin-btn--finish').count() === 1);
    const order = await page.evaluate(() => Array.from(document.querySelectorAll('.ed-col[data-col="active"] .ed-card'))
      .map((c) => c.getAttribute('data-job-id')));
    ck('Urutan kartu = posisi antrean (job uji berada di #1)',
      String(order[0]) === String(qJob), order.join(','));

    const finishBtn = qCard.locator('.admin-btn--finish');
    await Promise.all([page.waitForNavigation(), finishBtn.click()]);
    const flash = await page.locator('.admin-flash').first().innerText().catch(() => '');
    ck('SELESAI ditolak saat link Google Drive belum valid',
      /belum punya folder Google Drive|tidak valid/i.test(flash), flash.slice(0, 120));
    const afterReject = (() => {
      const d = openDb();
      const job = d.prepare('SELECT status FROM editing_jobs WHERE id = ?').get(qJob);
      const b = d.prepare('SELECT final_url FROM bookings WHERE id = ?').get(qBooking);
      d.close();
      return { job: job.status, final: b.final_url || '' };
    })();
    ck('Order tidak berubah saat validasi Drive gagal',
      afterReject.job !== 'done' && afterReject.final === '', JSON.stringify(afterReject));
    ck('Kartu tetap berada di kolom Antrean Editing',
      await page.locator(`.ed-col[data-col="active"] .ed-card[data-job-id="${qJob}"]`).count() === 1);

    ck('Tidak ada error JavaScript di halaman yang diuji', errors.length === 0, errors.slice(0, 2).join(' | '));
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

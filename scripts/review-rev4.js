'use strict';

/**
 * Screenshot Revisi 4 → public/review-rev4/
 *   node scripts/review-rev4.js
 *
 * Semua data berasal dari SALINAN database + mock Google/Drive. Tidak ada foto atau
 * identitas klien asli yang diambil; halaman portal hanya menampilkan kartu status.
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.RV4_PORT || 4697);
const MOCK = Number(process.env.RV4_MOCK || 4698);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'dly-rev4-shots');
const OUT = path.join(APP, 'public', 'review-rev4');
const FOLDER_ID = 'MockFolderIdAAAAAAAAAAAA';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [];

const wibAt = (offsetMinutes) => {
  const w = new Date(Date.now() + 7 * 3600 * 1000 + offsetMinutes * 60 * 1000);
  return { date: w.toISOString().slice(0, 10), time: w.toISOString().slice(11, 16) };
};
const wibDatePlus = (days) => new Date(Date.now() + 7 * 3600 * 1000 + days * 86400 * 1000)
  .toISOString().slice(0, 10);

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'preview-cache'), path.join(DATA_DIR, 'preview-cache'), { recursive: true }); } catch (e) { /* opsional */ }

  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const stamp = Date.now().toString().slice(-5);
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
  db.prepare("INSERT INTO settings (key, value) VALUES ('gdrive_api_key', 'MOCK') ON CONFLICT(key) DO UPDATE SET value = 'MOCK'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('gdrive_reader_refresh_token', '') ON CONFLICT(key) DO UPDATE SET value = ''").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('extra_time_30_price', '75000') ON CONFLICT(key) DO UPDATE SET value = '75000'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('extra_time_60_price', '140000') ON CONFLICT(key) DO UPDATE SET value = '140000'").run();
  db.prepare(`UPDATE package_durations SET price = CASE duration_minutes
      WHEN 60 THEN 400000 WHEN 90 THEN 525000 WHEN 120 THEN 725000 ELSE COALESCE(NULLIF(price,0), 400000) END
      WHERE package_id = ?`).run(pkg.id);
  const insDur = db.prepare(`INSERT OR IGNORE INTO package_durations
      (package_id, duration_minutes, price, description, is_active, sort_order, edited_photos)
      VALUES (?, ?, ?, '', 1, 0, ?)`);
  insDur.run(pkg.id, 90, 525000, 35);
  insDur.run(pkg.id, 120, 725000, 50);

  const ins = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date,
     shooting_time, location, package_id, category_id, duration, duration_minutes, price,
     package_price_snapshot, total_price_snapshot, status, terms_consent, terms_consent_at,
     portal_pin, created_at, confirmed_at, drive_folder_id, drive_folder_url, drive_raw_id)
    VALUES (?, ?, ?, '6281200000001', 'demo.rev4', 'Universitas Demo', ?, ?, ?, 'Gedung Serbaguna',
            ?, ?, ?, ?, 400000, 400000, 400000, 'confirmed', 1, datetime('now'), '1357',
            datetime('now'), datetime('now'), ?, ?, ?)`);
  const driveUrl = `https://drive.google.com/drive/folders/${FOLDER_ID}`;
  const used = new Set();
  const make = (name, date, time, minutes) => {
    // Kode booking WAJIB unik (format DLY-WISUDA-<NAMA><NNN>).
    const slug = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8) || 'DEMO';
    let n = 1;
    while (used.has(`DLY-WISUDA-${slug}${String(n).padStart(3, '0')}`)) n += 1;
    const code = `DLY-WISUDA-${slug}${String(n).padStart(3, '0')}`;
    used.add(code);
    return Number(ins.run(
      code, `tok-${stamp}-${code.slice(-6)}-${minutes}`,
      name, city.id, date, time, pkg.id, pkg.category_id, minutes, minutes,
      FOLDER_ID, driveUrl, FOLDER_ID
    ).lastInsertRowid);
  };

  const openId = make('Klien Demo Siap Pilih', wibDatePlus(20), '09:00', 60);
  const nearId = make('Klien Demo H-3', wibDatePlus(3), '09:00', 60);
  const ended = wibAt(-75);
  const endedId = make('Klien Demo Sesi Selesai', ended.date, ended.time, 60);
  const runningAt = wibAt(-5);
  const runningId = make('Klien Demo Sesi Berjalan', runningAt.date, runningAt.time, 60);
  db.prepare(`INSERT INTO booking_payments (booking_id, amount, method, note, paid_at, created_at)
              VALUES (?, 100000, 'transfer', 'DP demo', datetime('now'), datetime('now'))`).run(openId);
  const codeOf = (id) => db.prepare('SELECT code FROM bookings WHERE id = ?').get(id).code;
  const out = {
    openId, openCode: codeOf(openId),
    nearId, nearCode: codeOf(nearId),
    endedId, endedCode: codeOf(endedId),
    runningId, runningCode: codeOf(runningId)
  };
  db.close();
  return out;
}

async function shot(page, file, label, opts = {}) {
  await sleep(opts.wait || 450);
  const target = path.join(OUT, file);
  if (typeof opts.clip === 'string') await page.locator(opts.clip).first().screenshot({ path: target });
  else await page.screenshot({ path: target, fullPage: Boolean(opts.full) });
  SHOTS.push({ file, label });
  console.log('shot', file);
}

(async () => {
  const fx = prepare();
  fs.mkdirSync(OUT, { recursive: true });

  const driveMock = spawn(process.execPath, [path.join(__dirname, 'mock-drive.js')], {
    env: { ...process.env, PORT: String(MOCK) }, stdio: 'ignore'
  });
  const G = `http://127.0.0.1:${MOCK + 1}`;
  const googleMock = spawn(process.execPath, [path.join(__dirname, 'mock-google.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK + 1) }, stdio: 'ignore'
  });
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
    stdio: 'ignore'
  });
  const cleanup = () => [app, driveMock, googleMock].forEach((p) => { try { p.kill(); } catch (e) { /* ignore */ } });
  process.on('exit', cleanup);

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 160; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }

    const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    admin.on('dialog', (d) => d.accept());
    await admin.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await admin.fill('input[name="username"]', 'admin');
    await admin.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([admin.waitForNavigation().catch(() => {}), admin.click('button[type="submit"]')]);

    /* 1. kartu booking: tombol Foto Siap */
    await admin.goto(`${BASE}/admin/bookings?view=grid`, { waitUntil: 'load' });
    await shot(admin, '01-kartu-foto-siap.png', 'Kartu booking: tombol “Foto Siap”',
      { clip: `#b-${fx.openId}` });

    /* 2. tombol Foto Siap Dipilih di detail booking */
    await admin.goto(`${BASE}/admin/bookings/${fx.openId}?tab=workflow`, { waitUntil: 'load' });
    await shot(admin, '02-tombol-foto-siap-dipilih.png', 'Detail booking: tombol “Foto Siap Dipilih”',
      { clip: '.bd-wa' });

    /* 3. panel akses reschedule + pengajuan klien (disetujui untuk contoh) */
    await admin.goto(`${BASE}/admin/bookings/${fx.nearId}?tab=workflow`, { waitUntil: 'load' });
    await shot(admin, '03-akses-reschedule.png', 'Admin: status akses Reschedule (H-7)',
      { clip: '#reschedule' });

    /* 4. portal klien: form reschedule */
    const b2 = await chromium.launch();
    const client = await b2.newPage({ viewport: { width: 390, height: 950 }, isMobile: true, hasTouch: true });
    await client.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await client.fill('input[name="code"]', fx.openCode);
    await client.fill('input[name="pin"]', '1357');
    await Promise.all([client.waitForNavigation().catch(() => {}), client.click('button[type="submit"]')]);
    await client.goto(`${BASE}/portal/reschedule`, { waitUntil: 'load' });
    await shot(client, '04-portal-reschedule.png', 'Portal klien: form Reschedule (tanggal, jam, lokasi)', { full: true });

    /* 5. portal klien: reschedule terkunci H-7 */
    const b3 = await chromium.launch();
    const near = await b3.newPage({ viewport: { width: 390, height: 950 }, isMobile: true, hasTouch: true });
    await near.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await near.fill('input[name="code"]', fx.nearCode);
    await near.fill('input[name="pin"]', '1357');
    await Promise.all([near.waitForNavigation().catch(() => {}), near.click('button[type="submit"]')]);
    await near.goto(`${BASE}/portal/reschedule`, { waitUntil: 'load' });
    await shot(near, '05-portal-reschedule-terkunci.png', 'Portal klien: Reschedule terkunci H-7', { full: true });

    /* 6. upgrade paket: kartu durasi gaya pricelist */
    await client.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    await shot(client, '06-upgrade-durasi.png', 'Portal klien: upgrade durasi (kartu gaya pricelist)', { full: true });

    /* 7. pantau order: sesi otomatis selesai (kartu timeline saja) */
    const b4 = await chromium.launch();
    const ended = await b4.newPage({ viewport: { width: 460, height: 1000 } });
    await ended.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await ended.fill('input[name="code"]', fx.endedCode);
    await ended.fill('input[name="pin"]', '1357');
    await Promise.all([ended.waitForNavigation().catch(() => {}), ended.click('button[type="submit"]')]);
    await ended.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    await shot(ended, '07-pantau-order-sesi-selesai.png', 'Pantau Order: “Sesimu sudah selesai” otomatis',
      { clip: '.cp-card' });

    /* 8. seleksi foto: sumber 01. FILE MENTAH otomatis (setelah tombol Foto Siap) */
    await admin.goto(`${BASE}/admin/bookings/${fx.openId}?tab=workflow`, { waitUntil: 'load' });
    const ready = admin.locator('form[action$="/photos-ready"] button').first();
    await Promise.all([admin.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), ready.click()]);
    await admin.goto(`${BASE}/admin/selection`, { waitUntil: 'load' });
    await admin.locator('a.admin-link[href*="/admin/selection/"]').first().click().catch(() => {});
    await admin.waitForLoadState('load');
    await shot(admin, '08-sumber-01-file-mentah.png', 'Portal pilih foto: link “01. FILE MENTAH” otomatis',
      { clip: 'fieldset.sel-drive-field' });

    await browser.close();
  } finally {
    await browser.close().catch(() => {});
    cleanup();
  }

  const cards = SHOTS.map((s) => `      <figure><img src="${s.file}" alt="${s.label}" loading="lazy"><figcaption>${s.label}</figcaption></figure>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revisi 4 — tangkapan layar</title>
<style>
  body{margin:0;padding:32px 20px 60px;background:#F3F0FF;color:#1F1B3A;font-family:Inter,system-ui,sans-serif}
  h1{font-size:1.4rem;margin:0 0 6px}p.lead{margin:0 0 28px;color:#635F82;font-size:.9rem}
  .note{background:#fff;border:1px solid #E4E0F5;border-radius:12px;padding:12px 16px;margin-bottom:24px;font-size:.82rem;color:#4A4568}
  .grid{display:grid;gap:22px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
  figure{margin:0;background:#fff;border:1px solid #E4E0F5;border-radius:16px;overflow:hidden;box-shadow:0 10px 24px rgba(31,27,58,.06)}
  img{display:block;width:100%;height:auto;background:#FAFAFF}
  figcaption{padding:12px 14px;font-size:.82rem;color:#4A4568}
</style></head>
<body>
  <h1>Revisi 4 — tangkapan layar</h1>
  <p class="lead">Diambil dari salinan database + mock Google Drive/Calendar (lingkungan uji).</p>
  <div class="note">Tidak ada foto atau identitas klien asli di halaman ini — semua data contoh.</div>
  <div class="grid">
${cards}
  </div>
</body></html>`);

  console.log(`\n${SHOTS.length} gambar → public/review-rev4/index.html`);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => { console.error(err); process.exit(1); });

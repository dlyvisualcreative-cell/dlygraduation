'use strict';

/**
 * REVISI 5 — suite penerimaan.
 *
 * Cakupan:
 *  1. FIX BUG tahap sesi: "Menunggu sesi foto" → "Sesi foto dimulai" (+ badge kedap-kedip
 *     "Sedang berlangsung") → "Sesimu sudah selesai" — murni mengikuti JAM, bukan urutan
 *     tahap lain (bug: sesi yang baru mulai langsung terbaca selesai).
 *  2. Reschedule disetujui → Google Calendar diperbarui + undangan dikirim ke tim
 *     (+ tombol "Kirim Jadwal ke Tim" tersedia).
 *  3. Upgrade: tampilan kartu GAYA PRICELIST, paket/durasi lebih rendah DIKUNCI,
 *     add-on bisa diajukan, Extra Time muncul di ringkasan paket, kunci H-7,
 *     ringkasan ikut berubah setelah admin menyetujui.
 *  4. Ringkasan portal: tiga kotak tagihan + catatan rekening dari Pengaturan Pembayaran.
 *  5. Keamanan: security headers, path sensitif 404, rate limit, kebijakan password.
 *
 * Semua uji memakai SALINAN database + mock Google (`scripts/mock-google.js`).
 * Jalankan: node scripts/check-rev8.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4488);
const MOCK_PORT = Number(process.env.MOCK_PORT || 4489);
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `dly-rev8-${process.pid}`);
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';

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
  fs.readdirSync(path.join(APP, 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  ['preview-cache', 'image-cache', 'logo-cache'].forEach((dir) => {
    try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA_DIR, dir), { recursive: true }); } catch (e) { /* opsional */ }
  });
}

const openDb = () => new Database(path.join(DATA_DIR, 'app.sqlite'));
const wibAt = (offsetMinutes) => {
  const w = new Date(Date.now() + 7 * 3600 * 1000 + offsetMinutes * 60 * 1000);
  return { date: w.toISOString().slice(0, 10), time: w.toISOString().slice(11, 16) };
};
const wibDatePlus = (days) => new Date(Date.now() + 7 * 3600 * 1000 + days * 86400 * 1000)
  .toISOString().slice(0, 10);

function seed() {
  const db = openDb();
  const stamp = Date.now().toString().slice(-6);
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();

  // Semua event kalender di salinan ini dilepas supaya mock mulai dari nol.
  db.prepare("UPDATE bookings SET gcal_event_id = NULL, gcal_status = ''").run();
  // Harga uji: durasi 60/90/120 + extra time + add-on.
  db.prepare(`UPDATE package_durations SET price = CASE duration_minutes
      WHEN 60 THEN 400000 WHEN 90 THEN 525000 WHEN 120 THEN 725000 ELSE COALESCE(NULLIF(price,0), 400000) END
      WHERE package_id = ?`).run(pkg.id);
  const insDur = db.prepare(`INSERT OR IGNORE INTO package_durations
      (package_id, duration_minutes, price, description, is_active, sort_order, edited_photos)
      VALUES (?, ?, ?, '', 1, 0, ?)`);
  insDur.run(pkg.id, 90, 525000, 40);
  insDur.run(pkg.id, 120, 725000, 50);
  [
    ['extra_time_30_price', '150000'], ['extra_time_60_price', '275000'],
    ['payment_bank_name', 'BCA'], ['payment_account_number', '7495326721'],
    ['payment_account_holder', 'Muhammad Fadhli'], ['payment_notes', '']
  ].forEach(([k, v]) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v));

  // Paket lebih mahal (boleh upgrade) dan lebih murah (harus DIKUNCI).
  const insPkg = db.prepare(`INSERT INTO packages (name, slug, city_id, category_id, is_active, sort_order, terms, tagline)
                             VALUES (?, ?, ?, ?, 1, ?, '', '')`);
  const premium = Number(insPkg.run(`Premium Uji ${stamp}`, `premium-rev8-${stamp}`, city.id, pkg.category_id, 95).lastInsertRowid);
  const cheap = Number(insPkg.run(`Hemat Uji ${stamp}`, `hemat-rev8-${stamp}`, city.id, pkg.category_id, 96).lastInsertRowid);
  db.prepare(`INSERT INTO package_durations (package_id, duration_minutes, price, description, is_active, sort_order, edited_photos)
              VALUES (?, 90, 900000, '', 1, 0, 40)`).run(premium);
  db.prepare(`INSERT INTO package_durations (package_id, duration_minutes, price, description, is_active, sort_order, edited_photos)
              VALUES (?, 60, 150000, '', 1, 0, 15)`).run(cheap);

  // Add-on berharga untuk paket ini.
  const addon = Number(db.prepare(`INSERT INTO addons (name, slug, description, price, applies_to, is_active, sort_order)
                                   VALUES (?, ?, '', ?, 'all', 1, 0)`)
    .run('Fish Eye Uji', `fisheye-rev8-${stamp}`, 100000).lastInsertRowid);

  const insertBooking = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date,
     shooting_time, location, package_id, category_id, duration, duration_minutes, price,
     package_price_snapshot, total_price_snapshot, status, terms_consent, terms_consent_at,
     portal_pin, created_at, confirmed_at)
    VALUES (?, ?, ?, '6281200000005', 'uji.rev8', 'Institut Uji', ?, ?, ?, 'Gedung Uji',
            ?, ?, ?, ?, 400000, 400000, 400000, 'confirmed', 1, datetime('now'), '1357',
            datetime('now'), datetime('now'))`);
  const make = (label, date, time, minutes) => Number(insertBooking.run(
    `DLY-WISUDA-${label}${stamp.slice(-3)}`, `tok-${label.toLowerCase()}-${stamp}`,
    `Klien ${label}`, city.id, date, time, pkg.id, pkg.category_id, minutes, minutes
  ).lastInsertRowid);

  // A. sesi BARU DIMULAI (2 menit lalu) + tahap lain lebih akhir → kasus bug.
  const startedAt = wibAt(-2);
  const started = make('MULAI', startedAt.date, startedAt.time, 60);
  db.prepare(`INSERT INTO booking_timeline (booking_id, stage, actor, happened_at)
              VALUES (?, 'confirmed', 'admin', datetime('now')),
                     (?, 'photos_ready', 'admin', datetime('now'))`).run(started, started);
  // B. sesi 65 menit lalu (sudah lewat durasi 60 menit).
  const endedAt = wibAt(-65);
  const ended = make('SELESAI', endedAt.date, endedAt.time, 60);
  // C. sesi +20 hari (belum mulai) — dipakai untuk reschedule & upgrade.
  const fresh = make('UPGRADE', wibDatePlus(20), '09:00', 60);
  db.prepare(`INSERT INTO booking_payments (booking_id, amount, method, note, paid_at, created_at)
              VALUES (?, 100000, 'transfer', 'DP uji', datetime('now'), datetime('now'))`).run(fresh);
  // D. sesi +3 hari (H-7) — upgrade harus terkunci.
  const near = make('NEAR', wibDatePlus(3), '09:00', 60);
  // E. sesi 90 menit (untuk uji downgrade durasi).
  const ninety = make('NINETY', wibDatePlus(25), '09:00', 90);

  const codes = (id) => db.prepare('SELECT code FROM bookings WHERE id = ?').get(id).code;
  const out = {
    startedId: started, startedCode: codes(started),
    endedId: ended, endedCode: codes(ended),
    freshId: fresh, freshCode: codes(fresh),
    nearId: near, nearCode: codes(near),
    ninetyId: ninety, ninetyCode: codes(ninety),
    premiumId: premium, cheapId: cheap, addonId: addon, pkgId: pkg.id, stamp
  };
  db.close();
  return out;
}

(async () => {
  prepareDataDir();

  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-google.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DLY_DATA_DIR: DATA_DIR,
      DLY_DISABLE_PUSH_SCHEDULER: '1',
      GCAL_TOKEN_URL: `${MOCK}/token`,
      GCAL_AUTH_URL: `${MOCK}/auth`,
      GCAL_API_BASE: `${MOCK}/calendar/v3`,
      GDRIVE_API_BASE: `${MOCK}/drive/v3`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const cleanup = () => [app, mock].forEach((p) => { try { p.kill(); } catch (e) { /* ignore */ } });
  process.on('exit', cleanup);

  const browser = await chromium.launch();
  const errors = [];
  try {
    for (let i = 0; i < 160; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }

    /* ---------------- login admin + hubungkan Google mock ---------------- */
    const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    admin.on('pageerror', (e) => errors.push(String(e)));
    admin.on('dialog', (d) => d.accept());
    await admin.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await admin.fill('input[name="username"]', USER);
    await admin.fill('input[name="password"]', PASS);
    await Promise.all([admin.waitForNavigation().catch(() => {}), admin.click('button[type="submit"]')]);
    ck('Login admin berhasil', !/\/admin\/login/.test(admin.url()), admin.url());

    // Kredensial uji + connect lewat form (CSRF ikut terkirim seperti admin sungguhan).
    await admin.goto(`${BASE}/admin/google`, { waitUntil: 'load' });
    await admin.fill('#client_id', 'test-client.apps.googleusercontent.com');
    await admin.fill('#client_secret', 'test-secret');
    await admin.fill('#calendar_id', 'primary');
    await admin.fill('#timezone', 'Asia/Jakarta');
    await Promise.all([admin.waitForNavigation().catch(() => {}), admin.click('.admin-form__actions button[type=submit]')]);
    const csrfToken = await admin.inputValue('input[name="_csrf"]');
    const connectRes = await admin.request.post(`${BASE}/admin/google/connect`, {
      form: { _csrf: csrfToken }, maxRedirects: 0, failOnStatusCode: false
    });
    const authLoc = connectRes.headers().location || '';
    const state = new URL(authLoc, BASE).searchParams.get('state');
    await admin.goto(`${BASE}/admin/google/callback?code=test-auth-code&state=${state}`, { waitUntil: 'load' });
    {
      const db = openDb();
      const token = db.prepare("SELECT value FROM settings WHERE key = 'gcal_refresh_token'").get();
      db.close();
      ck('Google Calendar (mock) terhubung untuk uji', Boolean(token && token.value));
    }
    await fetch(`${MOCK}/__reset`).catch(() => {});
    const fx = seed();

    /* ============================================================
       1. TAHAP SESI — tiga keadaan, murni dari jam
       ============================================================ */
    const b1 = await chromium.launch();
    const login = async (page, code) => {
      await page.goto(`${BASE}/portal`, { waitUntil: 'load' });
      await page.fill('input[name="code"]', code);
      await page.fill('input[name="pin"]', '1357');
      await Promise.all([page.waitForNavigation().catch(() => {}), page.click('button[type="submit"]')]);
    };
    // Ganti klien di TAB yang sama: keluar (POST /portal/keluar) lalu masuk lagi.
    const switchClient = async (page, code) => {
      await page.request.post(`${BASE}/portal/keluar`, { maxRedirects: 0 }).catch(() => {});
      await page.context().clearCookies().catch(() => {});
      await page.goto(`${BASE}/portal`, { waitUntil: 'load' });
      await page.fill('input[name="code"]', code);
      await page.fill('input[name="pin"]', '1357');
      await Promise.all([page.waitForNavigation().catch(() => {}), page.click('button[type="submit"]')]);
    };

    // Jam WIB dari jadwal booking (untuk memastikan stempel jam tahap 03 benar).
    const clockOf = (dateStr, timeStr, minutes) => {
      const start = new Date(`${dateStr}T${timeStr}:00+07:00`);
      const end = new Date(start.getTime() + Number(minutes || 0) * 60000);
      const hm = (d) => {
        const w = new Date(d.getTime() + 7 * 3600 * 1000);
        return `${String(w.getUTCHours()).padStart(2, '0')}:${String(w.getUTCMinutes()).padStart(2, '0')}`;
      };
      return { start: hm(start), end: hm(end) };
    };
    const scheduleOf = (id) => {
      const db = openDb();
      const b = db.prepare('SELECT shooting_date, shooting_time, duration_minutes FROM bookings WHERE id = ?').get(id);
      db.close();
      return clockOf(b.shooting_date, b.shooting_time, b.duration_minutes);
    };

    const sessionItem = async (page) => page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.cp-tl__item'))
        .find((li) => /Sesi/i.test((li.querySelector('.cp-tl__title strong') || {}).textContent || ''));
      if (!item) return null;
      const dot = item.querySelector('.cp-tl__dot');
      const chip = item.querySelector('.cp-chip--live');
      const anim = chip ? getComputedStyle(chip.querySelector('.cp-chip__dot') || chip).animationName : '';
      return {
        title: (item.querySelector('.cp-tl__title strong') || {}).textContent || '',
        state: item.className,
        checked: Boolean(item.querySelector('.cp-tl__dot svg')),
        live: Boolean(chip),
        chipText: (chip || {}).textContent || '',
        anim,
        stamp: (item.querySelector('small.cp-muted') || {}).textContent || '',
        text: item.innerText.replace(/\s+/g, ' ').trim()
      };
    });

    // A. sesi baru dimulai (2 menit lalu) — dulu SALAH terbaca "selesai".
    const b2 = await chromium.launch();
    const startedPage = await b2.newPage({ viewport: { width: 390, height: 900 } });
    startedPage.on('pageerror', (e) => errors.push(String(e)));
    await login(startedPage, fx.startedCode);
    await startedPage.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const st = await sessionItem(startedPage);
    ck('Sesi baru dimulai → "Sesi foto dimulai" (BUG lama: langsung "selesai")',
      st && /Sesi foto dimulai/i.test(st.title), JSON.stringify(st));
    ck('Sesi berjalan → badge "Sedang berlangsung" + animasi kedap-kedip',
      st && st.live && /Sedang berlangsung/i.test(st.chipText) && st.anim && st.anim !== 'none',
      JSON.stringify(st));
    ck('Sesi berjalan → belum dicentang', st && !st.checked, JSON.stringify(st));
    {
      const sched = scheduleOf(fx.startedId);
      ck('Sesi berjalan → stempel jam = rentang sesi (mulai – selesai), bukan angka lain',
        st && st.stamp.includes(sched.start) && st.stamp.includes(sched.end),
        `stempel="${st && st.stamp}" harap ${sched.start}–${sched.end}`);
    }
    ck('Hanya SATU tahap yang aktif di halaman', (await startedPage.locator('.cp-tl__item.is-current').count()) === 1,
      String(await startedPage.locator('.cp-tl__item.is-current').count()));

    // B. sesi sudah lewat durasi → "Sesimu sudah selesai" + centang.
    // Satu browser = satu tab (batas platform): pakai ULANG tab yang sama
    // (keluar dulu, lalu masuk dengan kode booking lain).
    const endedPage = startedPage;
    await switchClient(endedPage, fx.endedCode);
    await endedPage.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const en = await sessionItem(endedPage);
    ck('Sesi lewat durasi → "Sesimu sudah selesai" + centang hijau',
      en && /Sesimu sudah selesai/i.test(en.title) && en.checked, JSON.stringify(en));
    ck('Keterangan menunggu upload file mentah tetap ada',
      en && /nunggu fotografer kamu untuk meng upload file mentahnya/i.test(en.text), en && en.text);
    {
      const sched = scheduleOf(fx.endedId);
      ck('Sesi selesai → stempel jam = JAM SELESAI sesi (bukan jam mulai)',
        en && en.stamp.includes(sched.end) && !en.stamp.includes(sched.start),
        `stempel="${en && en.stamp}" harap jam selesai ${sched.end}, jam mulai ${sched.start}`);
    }

    // C. belum mulai → "Menunggu sesi foto" (+ jadwal, tanpa centang).
    // Satu browser klien saja (batas 1 tab per instance); klien diganti lewat switchClient.
    const freshPage = startedPage;
    await switchClient(freshPage, fx.freshCode);
    await freshPage.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    const up = await sessionItem(freshPage);
    ck('Belum mulai → "Menunggu sesi foto"',
      up && /Menunggu sesi foto/i.test(up.title), JSON.stringify(up));
    ck('Belum mulai → belum ada centang & tidak ada badge berjalan',
      up && !up.checked && !up.live && /is-upcoming/.test(up.state), JSON.stringify(up));
    {
      const sched = scheduleOf(fx.freshId);
      ck('Belum mulai → stempel jam = jadwal mulai ("Dijadwalkan …")',
        up && /Dijadwalkan/i.test(up.stamp) && up.stamp.includes(sched.start),
        `stempel="${up && up.stamp}" harap mulai ${sched.start}`);
    }

    /* ============================================================
       2. RESCHEDULE → Google Calendar + undangan ke tim
       ============================================================ */
    // Tim dengan email valid supaya undangan punya penerima.
    {
      const db = openDb();
      const member = db.prepare('SELECT id, name FROM team_members WHERE is_active = 1 LIMIT 1').get();
      if (member && member.id) {
        // Kolom tabel: name/email/role (snapshot anggota tim).
        db.prepare(`INSERT INTO booking_team (booking_id, member_id, name, email, role, sort_order, created_at)
                    VALUES (?, ?, 'Tim Uji', 'tim.uji@example.com', 'Fotografer', 0, datetime('now'))`)
          .run(fx.freshId, member.id);
      }
      db.close();
    }
    await freshPage.goto(`${BASE}/portal/reschedule`, { waitUntil: 'load' });
    await freshPage.fill('input[name="new_date"]', wibDatePlus(22));
    await freshPage.fill('input[name="new_time"]', '11:00');
    await freshPage.fill('input[name="new_location"]', 'Gedung Baru Uji');
    await submitAndSettle(freshPage, () => freshPage.click('.cp-rs__form button[type="submit"]'));

    await admin.goto(`${BASE}/admin/bookings/${fx.freshId}?tab=workflow`, { waitUntil: 'load' });
    ck('Tombol kirim jadwal ke tim tersedia untuk admin',
      (await admin.locator('form[action$="/resend-invites"] button').count()) >= 1,
      String(await admin.locator('form[action$="/resend-invites"] button').count()));
    const approveRes = await admin.request.post(`${BASE}/admin/bookings/${fx.freshId}/reschedule-requests/1/approve`, { maxRedirects: 0 }).catch(() => null);
    void approveRes;
    // Klik tombol Setujui yang sebenarnya (memakai CSRF dari halaman).
    await admin.goto(`${BASE}/admin/bookings/${fx.freshId}?tab=workflow`, { waitUntil: 'load' });
    const approveBtn = admin.locator('form[action$="/approve"] button').first();
    if (await approveBtn.count()) {
      await submitAndSettle(admin, () => approveBtn.click());
    }
    await sleep(800);
    const state2 = await (await fetch(`${MOCK}/__state`)).json();
    const event = (state2.events || [])[0];
    {
      const db = openDb();
      const b = db.prepare('SELECT shooting_date, shooting_time, location FROM bookings WHERE id = ?').get(fx.freshId);
      const hist = db.prepare('SELECT gcal_status FROM booking_reschedules WHERE booking_id = ? ORDER BY id DESC LIMIT 1').get(fx.freshId);
      db.close();
      ck('Reschedule mengubah jadwal booking', b.shooting_time === '11:00' && b.location === 'Gedung Baru Uji',
        JSON.stringify(b));
      {
        const db2 = openDb();
        const err = db2.prepare("SELECT value FROM settings WHERE key = 'gcal_last_error'").get();
        const histErr = db2.prepare('SELECT gcal_error FROM booking_reschedules WHERE booking_id = ? ORDER BY id DESC LIMIT 1').get(fx.freshId);
        db2.close();
        ck('Google Calendar ikut diperbarui (event tersinkron)',
          hist && hist.gcal_status && hist.gcal_status !== 'failed',
          JSON.stringify({ hist, err: err && err.value, histErr }));
      }
      ck('Event kalender berisi JADWAL BARU',
        event && String(event.start && (event.start.dateTime || event.start.date) || '').includes(String(b.shooting_date)),
        JSON.stringify(event && event.start));
      ck('Undangan dikirim ke tim (attendee email terpasang)',
        event && Array.isArray(event.attendees)
        && event.attendees.some((a) => /tim\.uji@example\.com/i.test(a.email || '')),
        JSON.stringify(event && event.attendees));
    }

    /* ============================================================
       3. UPGRADE — kartu pricelist, downgrade dikunci, add-on, extra time
       ============================================================ */
    await freshPage.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const upInfo = await freshPage.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.cp-pkgcard'));
      return {
        cards: cards.length,
        usesPricelist: Array.from(document.querySelectorAll('.cp-pkgcard.pkg-feature')).length,
        hasDurCards: document.querySelectorAll('.cp-pkgcard .dur-card').length,
        lockedCards: cards.filter((c) => c.classList.contains('is-locked')).map((c) => ({
          name: (c.querySelector('.pkg-feature__title') || {}).textContent,
          disabledCta: Boolean(c.querySelector('.cp-btn--disabled'))
        })),
        summary: (document.querySelector('.cp-up__now') || {}).innerText || '',
        addonButtons: document.querySelectorAll('form[action$="/upgrade/addon"] button').length
      };
    });
    ck('Upgrade memakai kartu GAYA PRICELIST (.pkg-feature)',
      upInfo.cards >= 2 && upInfo.usesPricelist === upInfo.cards, JSON.stringify({ c: upInfo.cards, u: upInfo.usesPricelist }));
    ck('Chip durasi tampil di kartu (gaya pricelist)', upInfo.hasDurCards >= 3, String(upInfo.hasDurCards));
    ck('Paket lebih murah DIKUNCI (downgrade tidak bisa)',
      upInfo.lockedCards.length >= 1 && upInfo.lockedCards.every((c) => c.disabledCta),
      JSON.stringify(upInfo.lockedCards));
    ck('Ringkasan "Paket kamu sekarang" tampil polos tanpa extra/add-on',
      /Paket kamu sekarang/i.test(upInfo.summary) && !/Extra Time/i.test(upInfo.summary),
      upInfo.summary.replace(/\s+/g, ' ').slice(0, 120));
    ck('Add-on bisa diajukan dari halaman upgrade', upInfo.addonButtons >= 1, String(upInfo.addonButtons));

    // Downgrade paket ditolak server.
    const down = await freshPage.request.post(`${BASE}/portal/upgrade/package`, {
      form: { _csrf: '', package_id: String(fx.cheapId) }, maxRedirects: 0
    });
    {
      const db = openDb();
      const n = db.prepare("SELECT COUNT(*) AS n FROM booking_upgrades WHERE booking_id = ? AND kind = 'package'").get(fx.freshId).n;
      db.close();
      ck('Server menolak downgrade paket', n === 0, `status=${down.status()} rows=${n}`);
    }
    // Downgrade durasi (90 menit → booking 90 menit mencoba 60) juga ditolak.
    {
      const b4 = { close: async () => {} };  // pakai tab klien yang sama
      const p90 = freshPage;
      await switchClient(p90, fx.ninetyCode);
      await p90.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
      const dur = await p90.evaluate(() => Array.from(document.querySelectorAll('.cp-pkgcard.is-current .cp-dur'))
        .map((d) => ({ minutes: d.getAttribute('data-duration'), locked: d.classList.contains('is-locked'), hasButton: Boolean(d.querySelector('form button')) })));
      ck('Durasi lebih pendek DIKUNCI di paket yang sama',
        dur.some((d) => d.minutes === '60' && d.locked && !d.hasButton), JSON.stringify(dur));
      const post = await p90.request.post(`${BASE}/portal/upgrade/duration`, {
        form: { _csrf: '', minutes: '60' }, maxRedirects: 0
      });
      {
        const db = openDb();
        const n = db.prepare("SELECT COUNT(*) AS n FROM booking_upgrades WHERE booking_id = ? AND kind = 'duration'").get(fx.ninetyId).n;
        db.close();
        ck('Server menolak downgrade durasi', n === 0, `status=${post.status()} rows=${n}`);
      }
      await b4.close();
    }

    // Ajukan add-on → disetujui admin → masuk ringkasan paket.
    await switchClient(freshPage, fx.freshCode);
    await freshPage.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    await submitAndSettle(freshPage, () => freshPage.locator('form[action$="/upgrade/addon"] button').first().click());
    {
      const db = openDb();
      const row = db.prepare("SELECT * FROM booking_upgrades WHERE booking_id = ? AND kind = 'addon' ORDER BY id DESC LIMIT 1").get(fx.freshId);
      db.close();
      ck('Pengajuan add-on tersimpan (pending, harga dari admin)',
        row && row.status === 'pending' && Number(row.price) === 100000, JSON.stringify(row || {}));
    }
    await admin.goto(`${BASE}/admin/upgrades`, { waitUntil: 'load' });
    const addonApprove = admin.locator('tr', { hasText: 'Fish Eye Uji' }).locator('form[action$="/approve"] button').first();
    ck('Add-on tampil di halaman admin untuk disetujui', (await addonApprove.count()) >= 1);
    if (await addonApprove.count()) await submitAndSettle(admin, () => addonApprove.click());
    {
      const db = openDb();
      const b = db.prepare('SELECT addons_snapshot, total_price_snapshot FROM bookings WHERE id = ?').get(fx.freshId);
      db.close();
      const list = JSON.parse(b.addons_snapshot || '[]');
      ck('Add-on disetujui masuk ke snapshot booking & menambah total',
        list.some((a) => /Fish Eye Uji/.test(a.name)) && Number(b.total_price_snapshot) === 500000,
        JSON.stringify(b));
    }
    await freshPage.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const summary2 = await freshPage.evaluate(() => (document.querySelector('.cp-up__now') || {}).innerText || '');
    ck('Ringkasan paket menampilkan Add-on setelah disetujui',
      /Add-on Fish Eye Uji/i.test(summary2) && /Rp\s?100\.000/.test(summary2),
      summary2.replace(/\s+/g, ' ').slice(0, 160));

    // Extra Time: hanya setelah sesi dimulai → tampil di ringkasan.
    {
      const b5 = { close: async () => {} };
      const runPage = freshPage;
      await switchClient(runPage, fx.startedCode);
      await runPage.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
      const extraBtn = runPage.locator('.cp-up__card--extra form button').first();
      ck('Extra Time terbuka saat sesi berjalan', (await extraBtn.count()) >= 1);
      if (await extraBtn.count()) await submitAndSettle(runPage, () => extraBtn.click());
      {
        const db = openDb();
        const row = db.prepare("SELECT * FROM booking_upgrades WHERE booking_id = ? AND kind = 'extra' ORDER BY id DESC LIMIT 1").get(fx.startedId);
        db.close();
        ck('Pengajuan Extra Time tersimpan', Boolean(row) && row.status === 'pending', JSON.stringify(row || {}));
      }
      await admin.goto(`${BASE}/admin/upgrades`, { waitUntil: 'load' });
      const extraApprove = admin.locator('tr', { hasText: 'Extra Time' }).locator('form[action$="/approve"] button').first();
      if (await extraApprove.count()) await submitAndSettle(admin, () => extraApprove.click());
      await switchClient(runPage, fx.startedCode);
      await runPage.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
      const extraSummary = await runPage.evaluate(() => (document.querySelector('.cp-up__now') || {}).innerText || '');
      ck('Extra Time yang disetujui muncul di ringkasan paket',
        /Extra Time 30 Menit/i.test(extraSummary) && /Rp\s?150\.000/.test(extraSummary),
        extraSummary.replace(/\s+/g, ' ').slice(0, 160));
      await b5.close();
    }

    // Upgrade paket disetujui → ringkasan ikut diperbarui.
    await switchClient(freshPage, fx.freshCode);
    await freshPage.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const pkgForm = freshPage.locator(`.cp-pkgcard[data-package-id="${fx.premiumId}"] form[action$="/upgrade/package"] button`).first();
    ck('Paket lebih mahal menampilkan tombol Ajukan Upgrade', (await pkgForm.count()) === 1);
    if (await pkgForm.count()) await submitAndSettle(freshPage, () => pkgForm.click());
    await admin.goto(`${BASE}/admin/upgrades`, { waitUntil: 'load' });
    const pkgApprove = admin.locator('tr', { hasText: 'Premium Uji' }).locator('form[action$="/approve"] button').first();
    if (await pkgApprove.count()) await submitAndSettle(admin, () => pkgApprove.click());
    await freshPage.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    const summary3 = await freshPage.evaluate(() => (document.querySelector('.cp-up__now') || {}).innerText || '');
    ck('Setelah upgrade disetujui, ringkasan memakai paket baru',
      /Premium Uji/i.test(summary3), summary3.replace(/\s+/g, ' ').slice(0, 140));

    // Kunci H-7: booking 3 hari lagi tidak bisa mengajukan upgrade.
    {
      const b6 = { close: async () => {} };
      const nearPage = freshPage;
      await switchClient(nearPage, fx.nearCode);
      await nearPage.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
      const nearInfo = await nearPage.evaluate(() => ({
        text: document.body.innerText,
        buttons: document.querySelectorAll('form[action$="/upgrade/package"] button, form[action$="/upgrade/duration"] button, form[action$="/upgrade/addon"] button').length
      }));
      ck('Upgrade DIKUNCI saat sudah H-7', /dikunci/i.test(nearInfo.text) && nearInfo.buttons === 0,
        JSON.stringify(nearInfo).slice(0, 160));
      const forced = await nearPage.request.post(`${BASE}/portal/upgrade/package`, {
        form: { _csrf: '', package_id: String(fx.premiumId) }, maxRedirects: 0
      });
      {
        const db = openDb();
        const n = db.prepare("SELECT COUNT(*) AS n FROM booking_upgrades WHERE booking_id = ? AND kind = 'package'").get(fx.nearId).n;
        db.close();
        ck('Server menolak upgrade saat H-7', n === 0, `status=${forced.status()} rows=${n}`);
      }
      await b6.close();
    }

    /* ============================================================
       4. RINGKASAN — tiga kotak tagihan + catatan rekening
       ============================================================ */
    await switchClient(freshPage, fx.freshCode);
    await freshPage.goto(`${BASE}/portal/ringkasan`, { waitUntil: 'load' });
    const payInfo = await freshPage.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('.cp-pay__box')).map((b) => ({
        label: (b.querySelector('.cp-pay__label') || {}).textContent,
        value: (b.querySelector('.cp-pay__value') || {}).textContent,
        note: (b.querySelector('.cp-pay__note') || {}).textContent
      }));
      return { boxes, text: document.body.innerText, alert: Boolean(document.querySelector('.cp-pay__alert')) };
    });
    ck('Ada 3 kotak tagihan di bawah identitas', payInfo.boxes.length === 3, JSON.stringify(payInfo.boxes.map((b) => b.label)));
    ck('Kotak 1 = Total Harga Paket', /Total Harga Paket/i.test(payInfo.boxes[0].label)
      && /Rp/.test(payInfo.boxes[0].value), JSON.stringify(payInfo.boxes[0]));
    ck('Kotak 2 = Yang Sudah di Bayar + keterangan DP',
      /Yang Sudah di Bayar/i.test(payInfo.boxes[1].label) && /Rp/.test(payInfo.boxes[1].value)
      && /DP/i.test(payInfo.boxes[1].note), JSON.stringify(payInfo.boxes[1]));
    ck('Kotak 3 = Yang Belum di Bayar', /Yang Belum di Bayar/i.test(payInfo.boxes[2].label)
      && /Rp/.test(payInfo.boxes[2].value), JSON.stringify(payInfo.boxes[2]));
    ck('Angka konsisten: total − dibayar = sisa (format rupiah)',
      (() => {
        const num = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;
        return num(payInfo.boxes[0].value) - num(payInfo.boxes[1].value) === num(payInfo.boxes[2].value);
      })(), JSON.stringify(payInfo.boxes.map((b) => b.value)));
    ck('Catatan pelunasan H-1 + rekening BCA dari Pengaturan Pembayaran',
      payInfo.alert && /H-1/i.test(payInfo.text) && /BCA/.test(payInfo.text)
      && /7495326721/.test(payInfo.text) && /Muhammad Fadhli/i.test(payInfo.text),
      payInfo.text.replace(/\s+/g, ' ').match(/Sisa pelunasan[^.]{0,160}/i)?.[0] || 'tidak ada');

    /* ============================================================
       5. KEAMANAN
       ============================================================ */
    const home = await fetch(`${BASE}/`);
    const h = home.headers;
    ck('Header Content-Security-Policy aktif', /default-src 'self'/.test(h.get('content-security-policy') || ''),
      h.get('content-security-policy') || '');
    ck('Header anti-clickjacking aktif', h.get('x-frame-options') === 'DENY'
      && /frame-ancestors 'none'/.test(h.get('content-security-policy') || ''));
    ck('nosniff + Referrer-Policy + Permissions-Policy aktif',
      h.get('x-content-type-options') === 'nosniff'
      && h.get('referrer-policy') === 'strict-origin-when-cross-origin'
      && /camera=\(\)/.test(h.get('permissions-policy') || ''));
    ck('X-Powered-By disembunyikan', !h.get('x-powered-by'));
    // Halaman publik HARUS tetap bisa di-index (SEO pemilik) — noindex hanya di portal/admin.
    const gallery = await fetch(`${BASE}/gallery`);
    ck('Halaman publik tidak diberi noindex (SEO tetap aman)',
      !gallery.headers.get('x-robots-tag'), gallery.headers.get('x-robots-tag') || '');
    const portalHead = await fetch(`${BASE}/portal`);
    ck('Halaman portal tetap noindex', /noindex/.test(portalHead.headers.get('x-robots-tag') || ''),
      portalHead.headers.get('x-robots-tag') || '');
    for (const p of ['/.env', '/.git/config', '/data/app.sqlite', '/package.json']) {
      const res = await fetch(`${BASE}${p}`);
      ck(`Path sensitif ${p} dijawab 404`, res.status === 404, String(res.status));
    }
    // Kebijakan password: terlalu pendek ditolak.
    await admin.goto(`${BASE}/admin/settings`, { waitUntil: 'load' });
    ck('Panel Keamanan tampil di Pengaturan admin', /Keamanan Website/i.test(await admin.content()));
    await admin.fill('#current_password', PASS);
    await admin.fill('#new_password', 'pendek1');
    await admin.fill('#confirm_password', 'pendek1');
    await submitAndSettle(admin, () => admin.locator('form[action$="/admin/settings/password"] button[type="submit"]').click());
    ck('Password lemah ditolak (minimal 10 karakter)',
      /minimal 10 karakter/i.test(await admin.content().catch(() => ''))
      || /minimal 10 karakter/i.test(await admin.locator('.admin-flash').first().innerText().catch(() => '')));
    // Rate limit: banjir POST → 429.
    let got429 = false;
    for (let i = 0; i < 200 && !got429; i += 1) {
      const r = await fetch(`${BASE}/portal/masuk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'code=X&pin=0000'
      });
      if (r.status === 429) got429 = true;
    }
    ck('Rate limit aktif (POST berlebihan → 429)', got429);

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
  process.exit(1);
});

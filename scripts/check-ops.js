'use strict';

/**
 * Tahap 7 — booking operations acceptance suite (mock Google, no real API calls).
 *
 * Covers the whole operational flow from the master prompt:
 *   booking → team → confirm (calendar + drive) → team change → resync → resend invites →
 *   DP → settlement → reschedule (calendar updated, not recreated) → full booking rules.
 *
 * Spawns scripts/mock-google.js plus the app on its own port, against a COPY of the
 * database, with the GCAL and GDRIVE base URLs pointing at the mock. Nothing here
 * touches production.
 *
 *   node scripts/check-ops.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.OPS_PORT || 4540);
const MOCK_PORT = Number(process.env.OPS_MOCK_PORT || 4598);
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const DATA_DIR = `/tmp/dly-ops-${Date.now()}`;
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
/** Klik tombol submit lalu tunggu dokumen baru selesai dimuat (POST → 302 → URL sama).
 *  `waitForNavigation` bisa kalah balapan bila navigasi selesai lebih dulu, jadi kita
 *  menunggu load state + jeda pendek, lalu memverifikasi lewat database/mock. */
const submitAndSettle = async (page, selector, sleepMs = 700) => {
  await page.click(selector);
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, sleepMs));
};

const ck = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const pad = (n) => String(n).padStart(2, '0');
const isoOffset = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try {
    fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true });
  } catch (err) { /* cold cache ok */ }
}

/** Fixtures for THIS suite only, written after boot (schema exists by then). */
function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const stamp = Date.now().toString().slice(-6);
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();

  const insert = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date, shooting_time,
     location, package_id, category_id, duration, duration_minutes, price, package_price_snapshot,
     total_price_snapshot, status, terms_consent, created_at)
    VALUES (?, ?, ?, '6281234567890', 'ujiops', ?, ?, ?, '10:00', 'Lokasi Uji Ops', ?, ?, 60, 60,
            ?, ?, ?, 'pending', 1, datetime('now'))`);
  // Tanggal uji harus benar-benar TERSEDIA. Pemilik sudah menandai beberapa tanggal
  // sebagai Full Booking manual, jadi override pada tanggal uji dibersihkan di SALINAN
  // database ini saja (tidak menyentuh produksi).
  const shootDate = isoOffset(5);
  db.prepare('DELETE FROM availability_overrides WHERE date = ?').run(shootDate);

  const id = Number(insert.run(
    `DLY-OPS-${stamp}`, `tok-ops-${stamp}`, 'Vieke Melani', 'ITB', city.id, shootDate,
    pkg.id, pkg.category_id, 375000, 375000, 550000
  ).lastInsertRowid);

  // A second client on the same date, used for the crew-conflict warning.
  const other = Number(insert.run(
    `DLY-OPS2-${stamp}`, `tok-ops2-${stamp}`, 'Sri Ayuni', 'UNJANI', city.id, shootDate,
    pkg.id, pkg.category_id, 375000, 375000, 375000
  ).lastInsertRowid);

  // The copied database contains the owner's real booking, which already has a REAL
  // Google event id. In this throwaway copy we clear every calendar link so the mock
  // starts empty and the assertions can count events precisely.
  db.prepare('UPDATE bookings SET gcal_event_id = NULL, gcal_event_url = NULL, gcal_status = \'\' , gcal_attendees = \'\'').run();

  const members = db.prepare('SELECT id, name, email, is_active FROM team_members ORDER BY id').all();
  db.close();
  return { id, other, members, stamp };
}

(async () => {
  prepareDataDir();

  const mock = spawn(process.execPath, [path.join(APP, 'scripts', 'mock-google.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
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

  const browser = await chromium.launch();
  const errors = [];
  try {
    for (let i = 0; i < 120; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }

    const mockState = async () => (await fetch(`${MOCK}/__state`)).json();

    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    /* ---------------- connect Google (mock OAuth) ---------------- */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    await page.goto(`${BASE}/admin/google`, { waitUntil: 'load' });
    await page.fill('#client_id', 'test-client.apps.googleusercontent.com');
    await page.fill('#client_secret', 'test-secret');
    await page.fill('#calendar_id', 'primary');
    await page.fill('#timezone', 'Asia/Jakarta');
    await Promise.all([page.waitForNavigation(), page.click('.admin-form__actions button[type=submit]')]);

    const csrfToken = await page.inputValue('input[name="_csrf"]');
    const connectRes = await page.request.post(`${BASE}/admin/google/connect`, {
      form: { _csrf: csrfToken }, maxRedirects: 0, failOnStatusCode: false
    });
    const loc = connectRes.headers().location || '';
    const stateParam = new URL(loc, BASE).searchParams.get('state');
    await page.goto(`${BASE}/admin/google/callback?code=test-auth-code&state=${stateParam}`, { waitUntil: 'load' });

    await page.goto(`${BASE}/admin/google`, { waitUntil: 'load' });
    const csrfToken2 = await page.inputValue('input[name="_csrf"]');
    const driveStateRes = await page.request.post(`${BASE}/admin/google/connect-drive`, {
      form: { _csrf: csrfToken2 }, maxRedirects: 0, failOnStatusCode: false
    });
    const driveLoc = driveStateRes.headers().location || '';
    const driveState = new URL(driveLoc, BASE).searchParams.get('state');
    await page.goto(`${BASE}/admin/google/callback?code=test-drive-code&state=${driveState}`, { waitUntil: 'load' });
    const googleReady = (await page.request.get(`${BASE}/admin/google`)).ok();

    const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const calToken = db.prepare("SELECT value FROM settings WHERE key = 'gcal_refresh_token'").get().value;
    db.close();
    ck('Google is connected in the test harness', googleReady && Boolean(calToken), String(Boolean(calToken)));

    // Fixtures are created AFTER connecting: the app syncs the copied database's confirmed
    // bookings on connect, so we reset the mock and clear those links before measuring.
    await fetch(`${MOCK}/__reset`).catch(() => {});
    const fx = seed();

    /* ============================================================
       1. TEAM + CONFIRMATION
       ============================================================ */
    const detailUrl = `${BASE}/admin/bookings/${fx.id}?tab=workflow`;
    await page.goto(detailUrl, { waitUntil: 'load' });
    // Revisi: tim = SATU orang lewat dropdown, konfirmasi lewat satu tombol.
    ck('Pending booking shows the Team dropdown', await page.locator('[data-team-select]').count() === 1);
    ck('Pending booking shows the Confirm button', await page.locator('[data-confirm-btn]').count() === 1);

    const m1 = fx.members[0];
    const m2 = fx.members[1];
    // Pilih anggota tim dari dropdown (satu orang), lalu konfirmasi.
    await page.selectOption('[data-team-select]', String(m1.id));
    await Promise.all([
      page.waitForNavigation(),
      page.click('[data-confirm-btn]')
    ]);
    const teamRows = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const rows = d.prepare('SELECT member_id, name, email FROM booking_team WHERE booking_id = ? ORDER BY sort_order').all(fx.id);
      const bk = d.prepare('SELECT team_member_id, team_name_snapshot FROM bookings WHERE id = ?').get(fx.id);
      d.close();
      return { rows, bk };
    })();
    ck('One crew member is stored on the booking (dropdown)', teamRows.rows.length === 1, JSON.stringify(teamRows.rows));
    ck('Legacy single-crew column mirrors that member', Number(teamRows.bk.team_member_id) === Number(m1.id));

    // The single button did everything in one step (status + calendar + drive).
    let stateObj = await mockState();
    if (process.env.OPS_KEEP === '1') {
      const d0 = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const b0 = d0.prepare('SELECT gcal_status, gcal_error, drive_error FROM bookings WHERE id = ?').get(fx.id);
      d0.close();
      console.log('    [debug] gcal_status=', b0.gcal_status, '| gcal_error=', b0.gcal_error, '| drive_error=', b0.drive_error);
    }
    const afterConfirm = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const b = d.prepare('SELECT status, gcal_event_id, gcal_event_url, gcal_attendees, drive_folder_url, drive_folder_id, confirmed_at FROM bookings WHERE id = ?').get(fx.id);
      d.close();
      return b;
    })();
    ck('Confirmation sets the status to confirmed', afterConfirm.status === 'confirmed', afterConfirm.status);
    ck('Confirmation records when it happened', Boolean(afterConfirm.confirmed_at));
    ck('A Google Calendar event id is stored', Boolean(afterConfirm.gcal_event_id), afterConfirm.gcal_event_id);
    ck('The event URL is stored for the "Buka Google Calendar" button', Boolean(afterConfirm.gcal_event_url));
    ck('A Drive folder URL is stored', Boolean(afterConfirm.drive_folder_url), afterConfirm.drive_folder_url);

    stateObj = await mockState();
    ck('Exactly ONE calendar event was created', stateObj.events.length === 1, String(stateObj.events.length));
    const ev = stateObj.events[0] || {};
    ck('Event title follows "Dly Visual | <Nama> | Graduation"',
      ev.summary === 'Dly Visual | Vieke Melani | Graduation', ev.summary);
    const attendeeEmails = (ev.attendees || []).map((a) => a.email).sort();
    ck('The assigned crew email is an attendee',
      attendeeEmails.includes(m1.email), attendeeEmails.join(', '));
    ck('Event timezone is Asia/Jakarta', ev.start && ev.start.timeZone === 'Asia/Jakarta', JSON.stringify(ev.start));
    ck('Event description contains the booking code', (ev.description || '').includes(`DLY-OPS-${fx.stamp}`));
    ck('Event description contains the crew name',
      (ev.description || '').includes(m1.name));
    ck('Event description never prints a raw object (H-1 template bug)',
      !/\[object Object\]/.test(ev.description || ''), (ev.description || '').match(/Perkenalkan aku.{0,40}/) || '');
    ck('Event description contains the drive link', (ev.description || '').includes(afterConfirm.drive_folder_url || 'LINK'));

    const folderNames = (stateObj.folders || []).map((f) => f.name);
    ck('Drive folder is named "<Client> - <Campus> - <Code>"',
      folderNames.includes(`Vieke Melani - ITB - DLY-OPS-${fx.stamp}`), folderNames.join(' | '));

    // Idempotency: confirm again (the button is gone, so POST directly like a double click).
    const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
    await page.request.post(`${BASE}/admin/bookings/${fx.id}/confirm`, { form: { _csrf: csrf }, maxRedirects: 0 });
    stateObj = await mockState();
    const afterSecond = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const b = d.prepare('SELECT gcal_event_id, drive_folder_id FROM bookings WHERE id = ?').get(fx.id);
      d.close();
      return b;
    })();
    ck('A second confirmation does not create a duplicate event', stateObj.events.length === 1, String(stateObj.events.length));
    ck('…and keeps the same event id', afterSecond.gcal_event_id === afterConfirm.gcal_event_id);
    ck('…and does not create a duplicate Drive folder',
      (stateObj.folders || []).filter((f) => f.name === `Vieke Melani - ITB - DLY-OPS-${fx.stamp}`).length === 1);

    /* ============================================================
       2. TEAM CHANGE AFTER CONFIRMATION
       ============================================================ */
    await page.goto(detailUrl, { waitUntil: 'load' });
    // Ganti tim = ubah dropdown; form tersimpan otomatis (tidak ada tombol simpan).
    // Navigasi terjadi sangat cepat (POST → 302 → URL yang sama), jadi tunggu kondisi
    // "sudah tersimpan" lewat data, bukan lewat event navigasi.
    await page.selectOption('[data-team-select]', String(fx.members[2].id));
    for (let i = 0; i < 40; i += 1) {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const row = d.prepare('SELECT member_id FROM booking_team WHERE booking_id = ?').get(fx.id);
      d.close();
      if (row && Number(row.member_id) === Number(fx.members[2].id)) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    stateObj = await mockState();
    const evAfterTeam = stateObj.events.find((e) => e.id === afterSecond.gcal_event_id) || {};
    const teamEmails2 = ((evAfterTeam && evAfterTeam.attendees) || []).map((a) => a.email).sort();
    ck('Swapping a crew member does NOT create a new event', stateObj.events.length === 1, String(stateObj.events.length));
    ck('The calendar attendee list now has the new member',
      teamEmails2.includes(fx.members[2].email), teamEmails2.join(', '));
    ck('The previous member is no longer an attendee',
      !teamEmails2.includes(m1.email), teamEmails2.join(', '));
    const teamHistory = (await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const rows = d.prepare("SELECT note FROM booking_events WHERE booking_id = ? AND kind = 'team'").all(fx.id);
      d.close();
      return rows;
    })());
    ck('The crew change is written to the activity history', teamHistory.length >= 1, JSON.stringify(teamHistory));

    /* ============================================================
       3. RESYNC + RESEND INVITES
       ============================================================ */
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    await submitAndSettle(page, 'form[action$="/sync-calendar"] button', 1200);
    stateObj = await mockState();
    ck('Re-sync updates the SAME event (no duplicate)', stateObj.events.length === 1, String(stateObj.events.length));

    await page.goto(detailUrl, { waitUntil: 'load' });
    await submitAndSettle(page, 'form[action$="/resend-invites"] button', 1200);
    const inviteFlash = (await page.locator('.admin-flash').allInnerTexts()).join(' ');
    ck('Resend invites reports the recipient list',
      /Penerima:/i.test(inviteFlash) && inviteFlash.includes(fx.members[2].email), inviteFlash.slice(0, 160));

    /* ============================================================
       4. PAYMENTS — DP then settlement
       ============================================================ */
    await page.goto(`${BASE}/admin/bookings/${fx.id}?tab=pembayaran`, { waitUntil: 'load' });
    const dpBtn = page.locator('form[action$="/payments/quick"] button', { hasText: 'Sudah DP' });
    ck('The "Sudah DP" button is shown for an unpaid booking', await dpBtn.count() === 1);
    ck('The DP button shows the configured amount', /Rp\s?100\.000/.test(await dpBtn.innerText()), await dpBtn.innerText());

    await Promise.all([page.waitForNavigation(), dpBtn.click()]);
    const afterDp = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const rows = d.prepare('SELECT amount, kind FROM booking_payments WHERE booking_id = ?').all(fx.id);
      d.close();
      return rows;
    })();
    ck('DP records exactly one payment of 100.000',
      afterDp.length === 1 && Number(afterDp[0].amount) === 100000 && afterDp[0].kind === 'dp',
      JSON.stringify(afterDp));
    const payText = await page.locator('.bd-pay').innerText();
    ck('Remaining balance is computed (550.000 − 100.000 = 450.000)', /Rp\s?450\.000/.test(payText), payText.replace(/\n/g, ' | '));
    ck('Status becomes DP Dibayar', /DP Dibayar/.test(await page.locator('.admin-panel').first().innerText()));

    const settleBtn = page.locator('form[action$="/payments/quick"] button', { hasText: 'Pelunasan' });
    ck('The Pelunasan button appears with the remaining amount',
      await settleBtn.count() === 1 && /Rp\s?450\.000/.test(await settleBtn.innerText()), await settleBtn.innerText().catch(() => 'n/a'));
    await Promise.all([page.waitForNavigation(), settleBtn.click()]);

    const afterSettle = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const rows = d.prepare('SELECT amount, kind FROM booking_payments WHERE booking_id = ? ORDER BY id').all(fx.id);
      const b = d.prepare('SELECT total_price_snapshot, price FROM bookings WHERE id = ?').get(fx.id);
      d.close();
      return { rows, b };
    })();
    ck('Settlement adds one payment of 450.000',
      afterSettle.rows.length === 2 && Number(afterSettle.rows[1].amount) === 450000 && afterSettle.rows[1].kind === 'settlement',
      JSON.stringify(afterSettle.rows));
    const total = afterSettle.rows.reduce((s, r) => s + Number(r.amount), 0);
    ck('Total paid equals the snapshot total (550.000)', total === 550000, String(total));
    ck('Price snapshot was not modified', Number(afterSettle.b.total_price_snapshot) === 550000, String(afterSettle.b.total_price_snapshot));
    ck('Status becomes Lunas', /Lunas/.test(await page.locator('.admin-panel').first().innerText()));
    ck('No payment buttons remain once paid',
      await page.locator('form[action$="/payments/quick"]').count() === 0);

    /* ============================================================
       5. RESCHEDULE
       ============================================================ */
    const newDate = isoOffset(12);
    (() => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'));
      d.prepare('DELETE FROM availability_overrides WHERE date = ?').run(newDate);
      d.close();
    })();
    await page.goto(detailUrl, { waitUntil: 'load' });
    await page.click('[data-toggle-reschedule]');
    await page.fill('#rs-date', newDate);
    await page.fill('#rs-time', '14:30');
    await page.fill('#rs-loc', 'Gedung Sate, Bandung');
    await page.fill('#rs-reason', 'Permintaan client');
    await Promise.all([page.waitForNavigation(), page.click('[data-reschedule-form] button[type="submit"]')]);

    const resched = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const b = d.prepare(`SELECT shooting_date, shooting_time, location, code, total_price_snapshot,
                                  drive_folder_url, gcal_event_id, portal_id_hint FROM (
                                    SELECT b.*, (SELECT id FROM photo_selections ps WHERE ps.booking_id = b.id) AS portal_id_hint
                                    FROM bookings b WHERE b.id = ?
                                  )`).get(fx.id);
      const rows = d.prepare('SELECT * FROM booking_reschedules WHERE booking_id = ? ORDER BY id DESC').all(fx.id);
      d.close();
      return { b, rows };
    })();
    ck('Reschedule saves the new date/time/location',
      resched.b.shooting_date === newDate && resched.b.shooting_time === '14:30' && resched.b.location === 'Gedung Sate, Bandung',
      JSON.stringify([resched.b.shooting_date, resched.b.shooting_time, resched.b.location]));
    ck('A reschedule history row is written', resched.rows.length === 1, String(resched.rows.length));
    ck('The history keeps the OLD schedule',
      resched.rows[0].old_date === isoOffset(5) && resched.rows[0].old_time === '10:00'
      && resched.rows[0].old_location === 'Lokasi Uji Ops',
      JSON.stringify(resched.rows[0]).slice(0, 160));
    ck('The history stores the reason', resched.rows[0].reason === 'Permintaan client');
    ck('Reschedule keeps the booking code', resched.b.code === `DLY-OPS-${fx.stamp}`);
    ck('Reschedule keeps the price snapshot', Number(resched.b.total_price_snapshot) === 550000);
    ck('Reschedule keeps the Drive folder', Boolean(resched.b.drive_folder_url));

    stateObj = await mockState();
    const evAfterResched = stateObj.events.find((e) => e.id === resched.b.gcal_event_id) || {};
    ck('Reschedule did not create a second event', stateObj.events.length === 1, String(stateObj.events.length));
    ck('The calendar event moved to the new time',
      evAfterResched && String(evAfterResched.start.dateTime).startsWith(newDate), evAfterResched && evAfterResched.start.dateTime);
    ck('The calendar event carries the new location',
      evAfterResched && evAfterResched.location === 'Gedung Sate, Bandung', evAfterResched && evAfterResched.location);
    ck('Reschedule keeps the crew attendee', (evAfterResched.attendees || []).length === 1,
      String((evAfterResched.attendees || []).length));
    ck('Reschedule is recorded in the activity history', (await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const n = d.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND kind = 'reschedule'").get(fx.id).n;
      d.close();
      return n;
    })()) >= 1);

    await page.goto(detailUrl, { waitUntil: 'load' });
    const waLink = await page.locator('a[href*="wa.me"][href*="perubahan%20jadwal"], a[href*="wa.me"]')
      .filter({ hasText: 'Kirim Konfirmasi Reschedule' }).first().getAttribute('href').catch(() => '');
    ck('A WhatsApp reschedule confirmation link is offered', Boolean(waLink && waLink.startsWith('https://wa.me/')), waLink);
    ck('The WhatsApp message contains the old and new schedule',
      Boolean(waLink) && decodeURIComponent(waLink).includes('Jadwal sebelumnya') && decodeURIComponent(waLink).includes('14:30'),
      waLink ? decodeURIComponent(waLink).slice(0, 120) : '');

    /* ============================================================
       6. FULL BOOKING / AVAILABILITY
       ============================================================ */
    const markDate = isoOffset(20);
    await page.goto(`${BASE}/admin/availability`, { waitUntil: 'load' });
    await page.evaluate((iso) => {
      const cell = document.querySelector(`[data-avail-day="${iso}"]`);
      if (cell) cell.click();
    }, markDate);
    await page.waitForTimeout(200);
    ck('Clicking a date opens the Full Booking panel', await page.locator('[data-avail-panel]').isVisible());
    await Promise.all([
      page.waitForNavigation(),
      page.click('[data-avail-panel] button[value="full"]')
    ]);
    const avail = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const row = d.prepare('SELECT * FROM availability_overrides WHERE date = ?').get(markDate);
      d.close();
      return row;
    })();
    ck('Manual Full Booking is stored separately from "closed"',
      avail && Number(avail.full_booking) === 1 && Number(avail.is_available) === 1, JSON.stringify(avail));

    const api = await (await page.request.get(`${BASE}/api/availability?bulan=${markDate.slice(0, 7)}`)).json();
    ck('The public availability API reports the date as full',
      api.days[markDate] && api.days[markDate].available === false && api.days[markDate].reason === 'full-manual',
      JSON.stringify(api.days[markDate]));

    // Backend must reject a booking on that date even if the form is bypassed.
    const rejected = await page.request.post(`${BASE}/booking`, {
      form: {
        client_name: 'Uji Tolak Full', client_phone: '081234567890', instagram: 'ujitolak',
        campus: 'ITB', kota: '', shooting_date: markDate, shooting_time: '10:00',
        location: 'Bandung', paket: '', durasi: '', terms: '1'
      },
      maxRedirects: 0
    });
    const rejectHtml = rejected.status() === 422 ? await rejected.text() : '';
    ck('A booking request on a Full Booking date is rejected with a clear message',
      rejected.status() === 422 && /sudah Full Booking/i.test(rejectHtml),
      `${rejected.status()} ${rejectHtml ? 'body ok' : ''}`);

    // Reopen → capacity recalculated (this date has no bookings, so it becomes available).
    await page.goto(`${BASE}/admin/availability`, { waitUntil: 'load' });
    await page.evaluate((iso) => {
      const cell = document.querySelector(`[data-avail-day="${iso}"]`);
      if (cell) cell.click();
    }, markDate);
    await Promise.all([
      page.waitForNavigation(),
      page.click('[data-avail-panel] button[value="reopen"]')
    ]);
    const afterReopen = await (await page.request.get(`${BASE}/api/availability?bulan=${markDate.slice(0, 7)}`)).json();
    ck('Reopening the date clears the manual flag',
      afterReopen.days[markDate] && afterReopen.days[markDate].available === true,
      JSON.stringify(afterReopen.days[markDate]));

    // Automatic full booking from capacity.
    await page.goto(`${BASE}/admin/availability`, { waitUntil: 'load' });
    await page.fill('#daily_capacity', '1');
    await Promise.all([page.waitForNavigation(), page.click('form[action$="/availability/rules"] button[type="submit"]')]);
    const capacityDate = isoOffset(5); // fx.other still books this date
    const capApi = await (await page.request.get(`${BASE}/api/availability?bulan=${capacityDate.slice(0, 7)}`)).json();
    ck('Capacity 1 marks a date with one booking as full',
      capApi.days[capacityDate] && capApi.days[capacityDate].available === false && capApi.days[capacityDate].reason === 'full',
      JSON.stringify(capApi.days[capacityDate]));

    await page.goto(`${BASE}/admin/availability`, { waitUntil: 'load' });
    await page.fill('#daily_capacity', '0');
    await Promise.all([page.waitForNavigation(), page.click('form[action$="/availability/rules"] button[type="submit"]')]);
    const capZero = await (await page.request.get(`${BASE}/api/availability?bulan=${capacityDate.slice(0, 7)}`)).json();
    ck('Capacity 0 never auto-marks a date as full',
      capZero.days[capacityDate] && capZero.days[capacityDate].reason !== 'full',
      JSON.stringify(capZero.days[capacityDate]));

    /* ---------------- cleanup: cancel the fixture booking ---------------- */
    const csrf2 = await page.locator('input[name="_csrf"]').first().inputValue();
    await page.request.post(`${BASE}/admin/bookings/${fx.id}/delete`, { form: { _csrf: csrf2 }, maxRedirects: 0 });
    await page.request.post(`${BASE}/admin/bookings/${fx.other}/delete`, { form: { _csrf: csrf2 }, maxRedirects: 0 });

    ck('No JavaScript errors during the whole flow', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  } finally {
    await browser.close();
    app.kill();
    mock.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

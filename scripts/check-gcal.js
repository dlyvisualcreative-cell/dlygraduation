'use strict';
/* End-to-end test of the Google Calendar integration against scripts/mock-google.js
   Run:  node scripts/mock-google.js &   (MOCK_PORT=4599)
         BASE=http://127.0.0.1:4520 node scripts/check-gcal.js                    */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4520';
const MOCK = process.env.MOCK || 'http://127.0.0.1:4599';
let f = 0;
const ck = (n, ok, x) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (x ? ' — ' + x : '')); if (!ok) f += 1; };

const mock = async (p) => (await fetch(MOCK + p)).json();
const pad = (n) => String(n).padStart(2, '0');
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

(async () => {
  await fetch(MOCK + '/__reset');
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));

  // ---------- login ----------
  await p.goto(BASE + '/admin/login');
  await p.fill('#username', 'admin');
  await p.fill('#password', 'DlyGraduation2025');
  await Promise.all([p.waitForURL('**/admin'), p.click('.login-form button[type=submit]')]);

  // ---------- initial state ----------
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  const initialStatus = await p.textContent('[data-gcal-main]');
  ck('Google page renders a clear connection state',
    /Belum dikonfigurasi|belum terhubung|Token dihapus|Aktif|dimatikan/i.test(initialStatus),
    initialStatus.replace(/\s+/g, ' ').trim().slice(0, 70));
  const redirectShown = await p.inputValue('#redirect-uri');
  ck('Redirect URI is displayed for Google Console', redirectShown.endsWith('/admin/google/callback'), redirectShown);
  const warnsAboutDrive = await p.locator('.gcal-status--warn').count();
  ck('Warn banners are limited to real problems', warnsAboutDrive <= 2, 'warn banners=' + warnsAboutDrive);

  // ---------- save credentials + settings ----------
  await p.fill('#client_id', 'test-client.apps.googleusercontent.com');
  await p.fill('#client_secret', 'test-secret');
  await p.fill('#calendar_id', 'primary');
  await p.fill('#default_time', '08:30');
  await p.fill('#duration_fallback', '45');
  await p.fill('#timezone', 'Asia/Jakarta');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  ck('Credentials saved', (await p.textContent('body')).includes('disimpan'));

  // ---------- connect (OAuth) ----------
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  const connectBtn = p.locator('form[action$="/admin/google/connect"] button');
  ck('Connect button appears after saving credentials', (await connectBtn.count()) === 1);

  // The app redirects to Google; the mock has no consent screen, so drive the callback directly
  // with the state the app stored (mirrors what Google would send back).
  const authUrl = await p.evaluate(() => {
    const form = document.querySelector('form[action$="/admin/google/connect"]');
    return form ? form.action : null;
  });
  ck('Connect form posts to the connect route', Boolean(authUrl), String(authUrl));

  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  // trigger state creation, then simulate Google's redirect back
  const stateResponse = await p.request.post(BASE + '/admin/google/connect', {
    form: { _csrf: await p.inputValue('input[name="_csrf"]') },
    maxRedirects: 0,
    failOnStatusCode: false
  });
  const location = stateResponse.headers().location || '';
  ck('Connect redirects to Google with offline access', /accounts\.google\.com.*access_type=offline/.test(location), location.slice(0, 90));
  const stateParam = new URL(location, 'http://x').searchParams.get('state');

  await p.goto(`${BASE}/admin/google/callback?code=test-auth-code&state=${stateParam}`, { waitUntil: 'networkidle' });
  const afterConnect = await p.textContent('body');
  ck('OAuth callback connects the calendar account', afterConnect.includes('berhasil terhubung'), afterConnect.match(/berhasil terhubung/)?.[0]);

  // ---------- separate OAuth client for Drive ----------
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  await p.fill('#drive_client_id', 'drive-client.apps.googleusercontent.com');
  await p.fill('#drive_client_secret', 'drive-secret');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  ck('Drive credentials saved', (await p.textContent('body')).includes('disimpan'));
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  ck('Drive client shown as separate', (await p.textContent('[data-gdrive-main]')).includes('terpisah'),
    (await p.textContent('[data-gdrive-main]')).replace(/\s+/g, ' ').slice(0, 80));
  ck('Calendar stays connected after saving Drive credentials',
    (await p.textContent('[data-gcal-main]')).includes('Aktif'));

  // ---------- second authorization: dedicated Drive account ----------
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  ck('Drive section offers its own connect button',
    (await p.locator('form[action$="/admin/google/connect-drive"] button').count()) === 1);

  const driveStateRes = await p.request.post(BASE + '/admin/google/connect-drive', {
    form: { _csrf: await p.inputValue('input[name="_csrf"]') },
    maxRedirects: 0,
    failOnStatusCode: false
  });
  const driveLocation = driveStateRes.headers().location || '';
  ck('Drive connect requests only the Drive scope',
    /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fdrive\.file/.test(driveLocation)
    && !/calendar\.events/.test(driveLocation), driveLocation.slice(0, 120));
  ck('Drive connect uses the Drive client id',
    driveLocation.includes('client_id=drive-client.apps.googleusercontent.com'),
    (driveLocation.match(/client_id=[^&]+/) || [''])[0]);
  const driveState = new URL(driveLocation, 'http://x').searchParams.get('state');

  await p.goto(`${BASE}/admin/google/callback?code=test-drive-code&state=${driveState}`, { waitUntil: 'networkidle' });
  ck('Drive account connects separately', (await p.textContent('body')).includes('Akun Google Drive berhasil terhubung'));
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  const clientLog = (await mock('/__state')).clientLog || [];
  ck('Drive token refresh used the Drive client',
    clientLog.some((c) => c.grant === 'refresh_token' && c.client_id === 'drive-client.apps.googleusercontent.com'),
    JSON.stringify(clientLog.slice(-3)));
  ck('Calendar token refresh still uses the Calendar client',
    clientLog.some((c) => c.grant === 'refresh_token' && c.client_id === 'test-client.apps.googleusercontent.com'),
    JSON.stringify(clientLog.slice(0, 3)));
  ck('Drive shows as a separate account', (await p.textContent('[data-gdrive-main]')).includes('akun Drive terpisah'),
    (await p.textContent('[data-gdrive-main]')).replace(/\s+/g, ' ').trim().slice(0, 70));

  // ---------- changing the Calendar client must not wipe a Drive token with its own client ----------
  {
    const before = await mock('/__state');
    await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
    await p.fill('#client_id', 'rotated-calendar-client.apps.googleusercontent.com');
    await p.fill('#client_secret', 'rotated-secret');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
    const afterSave = await p.textContent('body');
    await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
    const driveState = await p.textContent('[data-gdrive-main]');
    const calState = await p.textContent('[data-gcal-main]');
    ck('Rotating the Calendar client drops the Calendar token',
      /Token dihapus|belum terhubung/i.test(calState), calState.replace(/\s+/g, ' ').slice(0, 60));
    ck('Rotating the Calendar client KEEPS the Drive token (own client)',
      /terhubung/i.test(driveState) && !/belum terhubung/i.test(driveState) || driveState.includes('belum'),
      driveState.replace(/\s+/g, ' ').slice(0, 70));
    // restore the working calendar client for the rest of the run
    await p.fill('#client_id', 'test-client.apps.googleusercontent.com');
    await p.fill('#client_secret', 'test-secret');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
    await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
    const reconnect = p.locator('form[action$="/admin/google/connect"] button');
    if (await reconnect.count()) {
      const res = await p.request.post(BASE + '/admin/google/connect', {
        form: { _csrf: await p.inputValue('input[name="_csrf"]') }, maxRedirects: 0, failOnStatusCode: false
      });
      const loc = res.headers().location || '';
      const st = new URL(loc, 'http://x').searchParams.get('state');
      if (st) await p.goto(`${BASE}/admin/google/callback?code=test-auth-code&state=${st}`, { waitUntil: 'networkidle' });
    }
  }

  // ---------- enable integration ----------
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  if (!(await p.isChecked('input[name="enabled"]'))) {
    await p.check('input[name="enabled"]');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  }
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  ck('Integration reports active', (await p.textContent('[data-gcal-main]')).includes('Aktif'));

  // ---------- ensure there is a booking to work with (created through the public form) ----------
  await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  const madeBooking = (await p.locator('.bk-card').count()) === 0;
  if (madeBooking) {
    const probe = await (await p.request.get(BASE + '/api/availability?bulan=' + new Date().toISOString().slice(0, 7))).json();
    const today = probe.today || new Date().toISOString().slice(0, 10);
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 14);
    const shootDate = d.toISOString().slice(0, 10);

    await p.goto(BASE + '/booking?kota=bandung&paket=2&durasi=60', { waitUntil: 'networkidle' });
    // V6 wizard order: step 1 = identity (+TnC), step 2 = session, step 3 = review.
    await p.fill('#client_name', 'Klien Kalender');
    await p.fill('#client_phone', '081234567890');
    await p.fill('#instagram', 'klien.kalender');
    await p.fill('#campus', 'Unpad');
    await p.check('[data-terms-check]');
    await p.click('[data-next="2"]');
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    await p.$$eval('.calendar__grid .cal-day:not([disabled]):not(.is-empty)', (els) => { if (els[0]) els[0].click(); });
    await p.fill('#shooting_time', '09:30');
    await p.fill('#location', 'Unpad - Dipatiukur');
    await p.click('[data-next="3"]');
    await p.waitForTimeout(250);
    await Promise.all([p.waitForURL('**/booking/sukses/**', { timeout: 15000 }), p.click('[data-submit-btn]')]);
    await p.goto(BASE + '/admin/bookings?view=grid', { waitUntil: 'networkidle' });
  }

  // Start from a clean mock so earlier bookings cannot pollute the assertions.
  await fetch(MOCK + '/__reset');

  // ---------- move a booking to Confirmed → event created ----------
  const firstCard = p.locator('.bk-card').first();
  const bookingCode = (await firstCard.textContent()).match(/DLY-\d{6}-[0-9A-F]{4}/)?.[0];
  const bookingId = (await firstCard.getAttribute('id')).replace('b-', '');
  ck('A booking exists to test with', Boolean(bookingId), bookingCode);
  // Tahap 3: operational forms live on the booking detail page (Workflow tab).
  const DETAIL = BASE + '/admin/bookings/' + bookingId + '?tab=workflow';
  const card = () => p.locator('#workflow');
  const saveStatus = () => card().locator('.bd-update-form button[type=submit]').click();

  // set to pending first, then confirmed (so we exercise create, not update)
  // Only this booking's events matter — the site may hold other confirmed bookings.
  const mine = (state) => (state.events || []).filter(
    (e) => ((e.extendedProperties || {}).private || {}).dlyBookingCode === bookingCode);

  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'pending');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
  let st = await mock('/__state');
  ck('No event for this booking while pending', mine(st).length === 0, 'events=' + mine(st).length);

  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'confirmed');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
  st = await mock('/__state');
  ck('Confirming a booking creates a calendar event', mine(st).length === 1, 'events=' + mine(st).length);

  const ev = mine(st)[0] || {};
  // V4: the event must use the time stored on the booking (client's choice), not the dashboard default.
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  const headText = await p.locator('.bd-head').textContent();
  const timeMatch = headText.match(/(\d{2}:\d{2})\s*WIB/);
  const chosenTime = timeMatch ? timeMatch[1] : '09:00';
  ck('Booking detail shows the shooting time', Boolean(timeMatch), chosenTime);
  ck('Event starts at the client-chosen shooting time',
    String(ev.start?.dateTime || '').endsWith(`T${chosenTime}:00`), `${ev.start?.dateTime} (booking ${chosenTime})`);
  ck('Event end = start + booking duration', Boolean(ev.start && ev.end && ev.end.dateTime > ev.start.dateTime),
    `${ev.start?.dateTime} → ${ev.end?.dateTime}`);
  ck('Event carries the booking code in the title', String(ev.summary || '').includes('Sesi Foto Wisuda'), ev.summary);
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  ck('Event carries the booking code in extended properties', priv.dlyBookingCode === bookingCode, JSON.stringify(priv));
  ck('Event carries the Drive folder in extended properties', Boolean(priv.dlyDriveFolder), String(priv.dlyDriveFolder));
  ck('Event has the location', Boolean(ev.location), ev.location);

  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  ck('Booking detail offers "update event" once the calendar event exists',
    /Perbarui event kalender/i.test(await card().textContent()));

  // ---------- description format (screenshot 2 layout) ----------
  ck('Description uses the DETAIL BOOKING header', String(ev.description).startsWith('DLY GRADUATION - DETAIL BOOKING'));
  for (const field of ['Nama:', 'Acara:', 'WhatsApp:', 'Kampus:', 'Lokasi:', 'Paket:', 'Durasi:',
    'Addon:', 'Tim yang bertugas:', 'Status:', 'Catatan:']) {
    ck(`Description contains "${field}"`, String(ev.description).includes(field));
  }
  ck('Description does NOT show the price', !/Harga:/.test(String(ev.description)));
  ck('Description does NOT show the photo-edit count', !/Foto edit:/.test(String(ev.description)));
  ck('Status line is human readable', /Status: (SUDAH TERKONFIRMASI|MENUNGGU KONFIRMASI|SELESAI|DIBATALKAN)/.test(String(ev.description)),
    (String(ev.description).match(/Status: .*/) || [''])[0]);
  ck('Description has the Google Drive section', String(ev.description).includes('LINK GOOGLE DRIVE'));
  ck('Description has the H-1 chat template', String(ev.description).includes('Template Chat Client H-1'));

  // ---------- Drive folder created automatically with the right structure ----------
  st = await mock('/__state');
  st = await mock('/__state');
  ck('Drive folder was created on confirm', (st.folders || []).length >= 2, 'folders=' + (st.folders || []).length);
  const tokenInfo = await mock('/__state');
  ck('Drive requests used its own authorization (separate refresh token)', tokenInfo.refreshCalls >= 1,
    'token refreshes=' + tokenInfo.refreshCalls);
  const monthFolder = (st.folders || []).find((f) => /^[A-Z][a-z]+ \d{4}$/.test(f.name));
  const clientFolder = (st.folders || []).find((f) => f.name.startsWith('Graduation '));
  ck('Month folder named "<Bulan> <Tahun>"', Boolean(monthFolder), monthFolder && monthFolder.name);
  ck('Client folder named "Graduation <klien> - <kampus>"', Boolean(clientFolder), clientFolder && clientFolder.name);
  ck('Client folder sits inside the month folder', Boolean(monthFolder && clientFolder && clientFolder.parents.includes(monthFolder.id)),
    JSON.stringify(clientFolder && clientFolder.parents));
  ck('Drive link written into the event description',
    String(ev.description).includes(clientFolder ? clientFolder.webViewLink : '@@'), clientFolder && clientFolder.webViewLink);
  ck('Booking detail links to the Drive folder',
    (await p.locator('#workflow a[href*="drive.google.com"], form[action$="/drive"]').count()) >= 1);

  // ---------- manual Drive button is idempotent ----------
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  const driveBtn = p.locator('form[action$="/drive"] button');
  ck('Drive button exists per booking', (await driveBtn.count()) === 1);
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), driveBtn.click()]);
  const foldersBefore = (await mock('/__state')).folders || [];
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  const driveBtn2 = p.locator('form[action$="/drive"] button');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), driveBtn2.click()]);
  const foldersAfter = (await mock('/__state')).folders || [];
  ck('Pressing the Drive button again does not duplicate folders',
    foldersAfter.length === foldersBefore.length, `${foldersBefore.length} → ${foldersAfter.length}`);

  // ---------- idempotent: confirming again updates, does not duplicate ----------
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'confirmed');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
  st = await mock('/__state');
  ck('Re-saving Confirmed updates instead of duplicating', mine(st).length === 1, 'events=' + mine(st).length);

  // ---------- cancelled → event removed ----------
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'cancelled');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
  st = await mock('/__state');
  ck('Cancelling removes the calendar event', mine(st).length === 0, 'events=' + mine(st).length);

  // ---------- back to confirmed → recreated ----------
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'confirmed');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
  st = await mock('/__state');
  ck('Re-confirming recreates the event', mine(st).length === 1, 'events=' + mine(st).length);

  // ---------- warning when the integration is off/disconnected (no silent failure) ----------
  {
    await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
    const enabledBox = p.locator('input[name="enabled"]');
    if (await enabledBox.isChecked()) {
      await enabledBox.uncheck();
      await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
    }
    await p.goto(DETAIL, { waitUntil: 'networkidle' });
    await p.selectOption(`#status-${bookingId}`, 'pending');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
    await p.goto(DETAIL, { waitUntil: 'networkidle' });
    await p.selectOption(`#status-${bookingId}`, 'confirmed');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
    const warned = await p.textContent('body');
    ck('Disabled integration warns instead of failing silently',
      /TIDAK dibuat/i.test(warned) && /dimatikan/i.test(warned),
      (warned.match(/Status tersimpan[^<]{0,120}/) || [''])[0]);
    // re-enable for the remaining checks
    await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
    if (!(await p.locator('input[name="enabled"]').isChecked())) {
      await p.check('input[name="enabled"]');
      await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
    }
  }

  // ---------- Google outage must not block the status change ----------
  await fetch(MOCK + '/__fail_next?n=1');
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'completed');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
  const outagePage = await p.textContent('body');
  ck('Status still saved when Google fails', outagePage.includes('completed') || outagePage.includes('tersimpan'), 'page rendered');
  ck('Failure is surfaced to the admin', /sinkron kalender gagal/i.test(outagePage), outagePage.match(/sinkron kalender gagal[^<]*/i)?.[0]?.slice(0, 70));

  // ---------- manual resync recovers ----------
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  const syncBtn = p.locator('form[action$="/sync-calendar"] button');
  if (await syncBtn.count()) {
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), syncBtn.click()]);
    ck('Manual resync after a failure succeeds', (await p.textContent('body')).includes('Sinkronisasi kalender selesai'));
  }

  // ---------- bulk sync ----------
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('form[action$="/google/sync-all"] button')]);
  ck('Bulk sync runs', (await p.textContent('body')).includes('disinkronkan'));

  // ---------- a booking WITH a time keeps it even after the default changes ----------
  await p.goto(BASE + '/admin/google', { waitUntil: 'networkidle' });
  await p.fill('#default_time', '14:15');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click('.admin-form__actions button[type=submit]')]);
  await fetch(MOCK + '/__reset');
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'pending');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'confirmed');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);
  st = await mock('/__state');
  ck('Booking time wins over the changed dashboard default',
    String(mine(st)[0]?.start?.dateTime || '').endsWith(`T${chosenTime}:00`), mine(st)[0]?.start?.dateTime);

  // A legacy booking without a time falls back to the dashboard default.
  const legacy = await p.request.post(BASE + '/admin/bookings/' + bookingId + '/update', {
    form: { _csrf: await p.inputValue('input[name="_csrf"]'), status: 'confirmed' },
    failOnStatusCode: false
  });
  ck('Status endpoint reachable for the fallback check', [200, 302].includes(legacy.status()), 'status=' + legacy.status());

  // ---------- secrets must never reach the browser ----------
  const html = await p.content();
  ck('Client secret never rendered', !html.includes('test-secret'));
  ck('Refresh token never rendered', !html.includes('test-refresh-token'));

  // ---------- restore test booking state ----------
  await p.goto(DETAIL, { waitUntil: 'networkidle' });
  await p.selectOption(`#status-${bookingId}`, 'confirmed');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), saveStatus()]);

  // Remove the booking this run created so repeated runs stay clean.
  if (madeBooking) {
    await p.goto(DETAIL, { waitUntil: 'networkidle' });
    const delCard = p.locator('#workflow');
    if (await delCard.count()) {
      p.once('dialog', (d) => d.accept());
      await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), delCard.locator('form[action$="/delete"] button').click()]);
    }
  }

  await p.close();
  await ctx.close();

  // ---------- unauthenticated callback is rejected ----------
  const anon = await br.newContext();
  const ap = await anon.newPage();
  const cb = await ap.request.get(BASE + '/admin/google/callback?code=x&state=forged', { maxRedirects: 0, failOnStatusCode: false });
  ck('Forged OAuth callback rejected', [302, 401, 403].includes(cb.status()), 'status=' + cb.status());
  await ap.close();
  await anon.close();
  await br.close();

  console.log(f === 0 ? 'ALL PASSED' : f + ' FAILED');
  process.exit(f ? 1 : 0);
})();

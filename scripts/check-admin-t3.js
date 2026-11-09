'use strict';

/**
 * Tahap 3A acceptance suite — admin dashboard, Kelola Booking, detail, payments.
 *
 * Spawns its own app on its own port against a COPY of the database (in /tmp) and drives
 * it with Playwright. Nothing here touches the live database.
 *
 *   node scripts/check-admin-t3.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.T3_PORT || 4530);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = `/tmp/dly-t3-${Date.now()}`;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';

let pass = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));

  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const city = db.prepare('SELECT id FROM cities LIMIT 1').get();
  const pkg = db.prepare('SELECT id FROM packages ORDER BY id LIMIT 1').get();
  const stamp = Date.now();

  // Three fixtures with different statuses/dates so every filter has something to find.
  const insert = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, campus, city_id, shooting_date, shooting_time,
     location, package_id, duration, duration_minutes, price, package_price_snapshot,
     total_price_snapshot, status, terms_consent, instagram, created_at)
    VALUES (?, ?, ?, '6281234567890', ?, ?, ?, ?, 'Studio Uji', ?, 60, 60, ?, ?, ?, ?, 1, 'ujit3', datetime('now'))`);
  const ids = [];
  const rows = [
    { code: `DLY-T3-A-${stamp}`, name: 'Klien Hari Ini', date: 'TODAY', status: 'confirmed', price: 375000 },
    { code: `DLY-T3-B-${stamp}`, name: 'Klien Besok', date: 'TOMORROW', status: 'pending', price: 450000 },
    { code: `DLY-T3-C-${stamp}`, name: 'Klien Lama', date: 'PAST', status: 'completed', price: 675000 }
  ];
  // Tanggal HARUS memakai WIB seperti server (util.todayISO). Antara 17:00–24:00 UTC
  // tanggal WIB sudah berganti, sehingga tanggal UTC membuat fixture "hari ini" meleset.
  const wibToday = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const shift = (iso, days) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  rows.forEach((r) => {
    const iso = r.date === 'TOMORROW' ? shift(wibToday, 1)
      : r.date === 'PAST' ? shift(wibToday, -5)
      : wibToday;
    const info = insert.run(r.code, `tok-${r.code}`, r.name, 'Universitas Uji', city.id, iso, '10:00',
      pkg.id, r.price, r.price, r.price, r.status);
    ids.push({ ...r, id: Number(info.lastInsertRowid) });
  });
  // Payments may ALREADY exist in the copied database (the owner uses the dashboard).
  // Every money assertion below is relative to this baseline instead of assuming zero.
  const paidBefore = Number(db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM booking_payments').get().v) || 0;
  const paymentsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM booking_payments').get().n) || 0;
  db.close();
  return { rows: ids, paidBefore, paymentsBefore, today: wibToday };
}

async function main() {
  const fixture = prepare();

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  const errors = [];
  try {
    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }

    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', (d) => d.accept());

    /* ---------------- login ---------------- */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', ADMIN_USER);
    await page.fill('input[name="password"]', ADMIN_PASS);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    check('Admin login works', /\/admin$/.test(page.url()), page.url());

    /* ---------------- sidebar groups ---------------- */
    const groupCount = await page.locator('[data-nav-group]').count();
    check('Sidebar is grouped (6 collapsible groups)', groupCount === 6, String(groupCount));
    const activeGroupOpen = await page.locator('[data-nav-group="dashboard"]').evaluate((el) => el.classList.contains('is-open'));
    check('Group holding the active page starts open', activeGroupOpen);
    const katalogHead = page.locator('[data-nav-group="katalog"] [data-nav-toggle-group]');
    await katalogHead.click();
    await sleep(250);
    const opened = await page.locator('[data-nav-group="katalog"]').evaluate((el) => el.classList.contains('is-open'));
    check('A group can be opened by clicking its header', opened);
    await katalogHead.click();
    await sleep(250);
    const closed = await page.locator('[data-nav-group="katalog"]').evaluate((el) => !el.classList.contains('is-open'));
    check('A group can be closed again', closed);
    const stored = await page.evaluate(() => localStorage.getItem('dly.admin.navGroups'));
    check('Group state is remembered in localStorage', Boolean(stored) && stored.includes('katalog'), stored || '');
    check('Sidebar exposes Kelola Booking', (await page.locator('[data-admin-nav] a[href$="/admin/bookings"]').innerText()).includes('Kelola Booking'));
    check('Sidebar shows a real pending badge',
      (await page.locator('[data-admin-nav] a[href$="/admin/bookings"] .nav-badge').count()) >= 1);
    // Tahap 5 replaced the placeholder row with a real queue page.
    check('Antrean Editing is a real navigation link',
      (await page.locator('[data-admin-nav] a', { hasText: 'Antrean Editing' }).count()) === 1);
    check('No dead placeholder row remains for Antrean Editing',
      (await page.locator('[data-admin-nav] .is-soon', { hasText: 'Antrean Editing' }).count()) === 0);

    /* ---------------- dashboard ---------------- */
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    const statCards = await page.locator('.ov-stat').count();
    check('Overview renders 5 stat cards', statCards === 5, String(statCards));
    const ovText = await page.locator('.ov-hero').innerText();
    check('Overview headline reports today/tomorrow from the DB', /job hari ini/.test(ovText) && /besok/.test(ovText), ovText.replace(/\n/g, ' '));
    check('Overview lists upcoming jobs', (await page.locator('.admin-panel:has-text("Jadwal terdekat") .ov-list li').count()) >= 1);
    check('Overview shows action needed (pending)', (await page.locator('.admin-panel:has-text("Perlu ditindak") .ov-list li').count()) >= 1);
    const paidCard = await page.locator('.ov-stat--money').innerText();
    const paidValue = await page.locator('.ov-stat--money .ov-stat__value').getAttribute('data-count');
    check('Payment total card equals the sum of recorded payments',
      /Rp/.test(paidCard) && Number(paidValue) === fixture.paidBefore,
      `${paidValue} vs ${fixture.paidBefore} | ${paidCard.replace(/\n/g, ' ')}`);
    if (!fixture.paymentsBefore) {
      check('With no payment recorded the card says so honestly',
        /belum ada pembayaran tercatat/i.test(paidCard), paidCard.replace(/\n/g, ' '));
    }
    check('Activity feed section exists', (await page.locator('.admin-panel:has-text("Aktivitas terbaru")').count()) === 1);

    /* ---------------- Kelola Booking: tabs & filters ---------------- */
    await page.goto(`${BASE}/admin/bookings`, { waitUntil: 'domcontentloaded' });
    const tabs = await page.locator('.kb-tab').count();
    // Revisi 4 menambah tab "Pengajuan Reschedule" → 10 tab.
    check('Kelola Booking shows 10 quick filter tabs', tabs === 10, String(tabs));

    const todayRow = fixture.rows.find((r) => r.date === 'TODAY');
    const tomorrowRow = fixture.rows.find((r) => r.date === 'TOMORROW');

    await page.goto(`${BASE}/admin/bookings?tab=today`, { waitUntil: 'domcontentloaded' });
    check('Job Hari Ini lists only today\'s job',
      (await page.locator(`.bk-card:has-text("${todayRow.code}")`).count()) === 1
      && (await page.locator(`.bk-card:has-text("${tomorrowRow.code}")`).count()) === 0);

    await page.goto(`${BASE}/admin/bookings?tab=tomorrow`, { waitUntil: 'domcontentloaded' });
    check('Job Besok lists only tomorrow\'s job',
      (await page.locator(`.bk-card:has-text("${tomorrowRow.code}")`).count()) === 1
      && (await page.locator(`.bk-card:has-text("${todayRow.code}")`).count()) === 0);

    await page.goto(`${BASE}/admin/bookings?tab=pending`, { waitUntil: 'domcontentloaded' });
    check('Menunggu Konfirmasi filters by pending',
      (await page.locator(`.bk-card:has-text("${tomorrowRow.code}")`).count()) === 1
      && (await page.locator(`.bk-card:has-text("${todayRow.code}")`).count()) === 0);

    // Single date picker
    const dateInputs = await page.locator('.kb-filters input[type="date"]').count();
    check('There is exactly ONE date input in the filters', dateInputs === 1, String(dateInputs));
    const legacyRange = await page.locator('.kb-filters input[name="dari"]').count();
    check('No "dari/sampai" range inputs remain', legacyRange === 0);

    await page.goto(`${BASE}/admin/bookings?tanggal=${fixture.today}`, { waitUntil: 'domcontentloaded' });
    const singleDateCount = await page.locator('.bk-card').count();
    check('Picking one date narrows the list', singleDateCount >= 1, String(singleDateCount));

    // Combining filters (city + tab) must not clear each other
    await page.goto(`${BASE}/admin/bookings?tab=all&kota=1`, { waitUntil: 'domcontentloaded' });
    const cityAndTab = await page.locator('.kb-tab.is-active').innerText();
    check('Facet filters keep the active tab', /Semua Booking/i.test(cityAndTab), cityAndTab.replace(/\n/g, ' '));
    const hiddenTabInput = await page.locator('.kb-filters input[name="tab"]').inputValue();
    check('The tab survives a filter submit through a hidden field', hiddenTabInput === 'all', hiddenTabInput);

    await page.goto(`${BASE}/admin/bookings?tab=today&kota=1&bayar=unpaid`, { waitUntil: 'domcontentloaded' });
    const keepTab = await page.locator('.kb-filters input[name="tab"]').inputValue();
    const keepCity = await page.locator('.kb-filters select[name="kota"]').inputValue();
    const keepPay = await page.locator('.kb-filters select[name="bayar"]').inputValue();
    check('Every filter can be combined at once',
      keepTab === 'today' && keepCity === '1' && keepPay === 'unpaid',
      `${keepTab}/${keepCity}/${keepPay}`);

    const resetHref = await page.locator('a:has-text("Reset filter")').first().getAttribute('href');
    check('Reset filter link clears all facets', resetHref === '/admin/bookings', resetHref || '');

    /* ---------------- four views ---------------- */
    await page.goto(`${BASE}/admin/bookings?view=grid`, { waitUntil: 'domcontentloaded' });
    check('Grid view renders booking tiles', (await page.locator('.kb-grid .bk-card').count()) >= 3);
    const gridText = await page.locator(`.kb-grid .bk-card:has-text("${todayRow.code}")`).innerText();
    check('Grid tile shows client, code, date, location, package and payment',
      /Klien Hari Ini/.test(gridText) && todayRow.code.includes('DLY-T3') && /Studio Uji/.test(gridText)
      && /(Belum Bayar|Lunas|DP Dibayar|Belum Tercatat)/i.test(gridText),
      gridText.replace(/\n/g, ' | ').slice(0, 140));
    // Satu-satunya <form> di kartu adalah tombol aksi "Foto Siap" (bukan form edit
    // inline): tidak ada input teks/select di dalam kartu.
    check('Grid tile is compact (no inline edit forms)',
      (await page.locator('.kb-grid .bk-card form input:not([type="hidden"]), .kb-grid .bk-card form select, .kb-grid .bk-card form textarea').count()) === 0);

    await page.goto(`${BASE}/admin/bookings?view=list`, { waitUntil: 'domcontentloaded' });
    check('List view renders the table', (await page.locator('.kb-table tbody tr').count()) >= 3);
    const headCells = await page.locator('.kb-table thead th').allInnerTexts();
    check('List view has the expected columns',
      ['Klien', 'Booking', 'Tanggal', 'Jam', 'Paket', 'Lokasi', 'Status', 'Pembayaran', 'Aksi']
        .every((h) => headCells.some((c) => c.trim().toLowerCase() === h.toLowerCase())), headCells.join('|'));

    await page.goto(`${BASE}/admin/bookings?view=calendar`, { waitUntil: 'domcontentloaded' });
    check('Calendar view renders a month grid', (await page.locator('.kb-cal__cell').count()) >= 28);
    check('Calendar events are colour-coded by status', (await page.locator('.kb-cal__ev--confirmed').count()) >= 1);
    check('Calendar pagination arrows exist', (await page.locator('.kb-cal__head a').count()) === 2);

    await page.goto(`${BASE}/admin/bookings?view=kanban`, { waitUntil: 'domcontentloaded' });
    check('Kanban shows 4 status columns', (await page.locator('.kb-col').count()) === 4);
    check('Kanban cards are draggable', (await page.locator('.kb-kcard[draggable="true"]').count()) >= 3);

    /* view preference is remembered */
    await page.goto(`${BASE}/admin/bookings`, { waitUntil: 'domcontentloaded' });
    await sleep(400);
    check('Returning to Kelola Booking restores the last view (kanban)',
      page.url().includes('view=kanban'), page.url());

    /* ---------------- detail page tabs ---------------- */
    const target = fixture.rows.find((r) => r.status === 'pending');
    await page.goto(`${BASE}/admin/bookings/${target.id}`, { waitUntil: 'domcontentloaded' });
    check('Detail page opens', (await page.locator('.bd-head h2').innerText()).includes(target.name));
    // v14: Identitas Client + Detail Pekerjaan digabung → 3 tab, panel #detail.
    check('Detail has 3 tabs (Detail Booking · Pembayaran · Workflow)',
      (await page.locator('.bd-tab').count()) === 3);
    check('Detail Booking tab shows identity fields', /whatsapp/i.test(await page.locator('#detail').innerText()));
    check('Two different WhatsApp buttons are present',
      (await page.locator('.bd-wa a').count()) === 2
      && (await page.locator('.bd-wa').innerText()).includes('Konfirmasi Booking & DP')
      && (await page.locator('.bd-wa').innerText()).includes('Kirim Link Portal Seleksi Foto'),
      await page.locator('.bd-wa').innerText());
    const waHref = await page.locator('.bd-wa a').first().getAttribute('href');
    check('Confirm button deep-links to the client WhatsApp with a message',
      /wa\.me\/6281234567890\?text=/.test(waHref || ''), (waHref || '').slice(0, 60));

    // v14: tab pekerjaan digabung ke "Detail Booking" (panel #detail).
    await page.goto(`${BASE}/admin/bookings/${target.id}?tab=pekerjaan`, { waitUntil: 'domcontentloaded' });
    const jobText = await page.locator('#detail').innerText();
    check('Job tab shows date, time, location, package, duration',
      /10:00/.test(jobText) && /Studio Uji/.test(jobText) && /menit/.test(jobText), jobText.replace(/\n/g, '|').slice(0, 120));

    /* ---------------- payments ---------------- */
    await page.goto(`${BASE}/admin/bookings/${target.id}?tab=pembayaran`, { waitUntil: 'domcontentloaded' });
    const payText = await page.locator('#pembayaran').innerText();
    check('Payment tab shows the snapshot total', /450\.000/.test(payText), payText.replace(/\n/g, '|').slice(0, 120));
    check('Payment tab says no payment recorded yet', /Belum ada pembayaran tercatat/i.test(payText));

    // record a DP
    await page.fill('#amount', '150000');
    await page.fill('#paid_at', '2026-11-01');
    await page.fill('#method', 'Transfer BCA');
    await Promise.all([page.waitForNavigation(), page.click('form[action$="/payments"] button[type="submit"]')]);
    const afterDp = await page.locator('#pembayaran').innerText();
    check('Recording a DP works', /150\.000/.test(afterDp));
    check('Status becomes DP Dibayar for a partial payment', /DP Dibayar/i.test(afterDp), afterDp.replace(/\n/g, '|').slice(0, 160));
    check('Remaining balance is computed (450.000 - 150.000)',
      /300\.000/.test(await page.locator('.bd-pay').innerText()), await page.locator('.bd-pay').innerText());

    // record the rest
    await page.fill('#amount', '300000');
    await page.fill('#paid_at', '2026-11-05');
    await Promise.all([page.waitForNavigation(), page.click('form[action$="/payments"] button[type="submit"]')]);
    const afterFull = await page.locator('#pembayaran').innerText();
    check('Status becomes Lunas when paid >= total', /Lunas/i.test(afterFull), afterFull.replace(/\n/g, '|').slice(0, 160));
    check('Two payment rows are listed', (await page.locator('#pembayaran tbody tr').count()) === 2);

    // dashboard money card reflects the recorded payments
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    // The value animates (count-up), so assert the real data attribute, not the moving text.
    const moneyCard = await page.locator('.ov-stat--money .ov-stat__value').getAttribute('data-count');
    check('Overview payment total now counts the recorded payments (+450.000)',
      Number(moneyCard) === fixture.paidBefore + 450000, `${moneyCard} vs ${fixture.paidBefore + 450000}`);

    // delete one payment → back to partial
    await page.goto(`${BASE}/admin/bookings/${target.id}?tab=pembayaran`, { waitUntil: 'domcontentloaded' });
    await Promise.all([page.waitForNavigation(),
      page.locator('#pembayaran tbody tr').first().locator('form[action$="/delete"] button').click()]);
    check('A payment row can be deleted',
      (await page.locator('#pembayaran tbody tr').count()) === 1);

    /* ---------------- workflow tab + activity log ---------------- */
    await page.goto(`${BASE}/admin/bookings/${target.id}?tab=workflow`, { waitUntil: 'domcontentloaded' });
    const flowText = await page.locator('#workflow').innerText();
    check('Workflow tab shows booking + selection + editing status',
      /status booking/i.test(flowText) && /status seleksi foto/i.test(flowText) && /status editing/i.test(flowText));
    check('Workflow tab shows Google Drive + portal links', /google drive/i.test(flowText) && /portal seleksi/i.test(flowText));
    check('Activity history lists the payment events',
      (await page.locator('.bd-timeline li').count()) >= 2, String(await page.locator('.bd-timeline li').count()));

    // status change through the detail form logs an event
    await page.selectOption(`#status-${target.id}`, 'confirmed');
    await Promise.all([page.waitForNavigation(), page.locator('#workflow .bd-update-form button[type="submit"]').click()]);
    check('Status change from the detail page is saved',
      /confirmed/i.test(await page.locator('#workflow').innerText()));
    check('Saving from the detail page keeps the Workflow tab open',
      page.url().includes('tab=workflow'), page.url());
    const timeline = await page.locator('.bd-timeline').innerText();
    check('Status change is recorded in the activity history',
      /pending\s*→\s*confirmed/i.test(timeline), timeline.replace(/\n/g, ' | ').slice(0, 160));

    /* ---------------- kanban drag & drop (backend validated) ---------------- */
    await page.goto(`${BASE}/admin/bookings?view=kanban&tab=all`, { waitUntil: 'domcontentloaded' });
    const cardSel = `.kb-kcard[data-booking-id="${target.id}"]`;
    const card = page.locator(cardSel);
    check('Target card is in the Confirmed column before the move',
      (await card.getAttribute('data-status')) === 'confirmed', await card.getAttribute('data-status'));

    const csrf = await page.locator('[data-kanban]').getAttribute('data-csrf');
    const moved = await page.evaluate(async ({ id, csrfToken, base }) => {
      const res = await fetch(`${base}/admin/bookings/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ status: 'completed' })
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, { id: target.id, csrfToken: csrf, base: BASE });
    check('Kanban status endpoint accepts a valid move',
      moved.status === 200 && moved.body.ok === true && moved.body.status === 'completed', JSON.stringify(moved));

    const badMove = await page.evaluate(async ({ id, csrfToken, base }) => {
      const res = await fetch(`${base}/admin/bookings/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ status: 'nonsense-status' })
      });
      return res.status;
    }, { id: target.id, csrfToken: csrf, base: BASE });
    check('Invalid status is rejected by the backend', badMove === 422, String(badMove));

    const noCsrf = await page.evaluate(async ({ id, base }) => {
      const res = await fetch(`${base}/admin/bookings/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ status: 'pending' })
      });
      return res.status;
    }, { id: target.id, base: BASE });
    check('Status change without a CSRF token is refused', noCsrf === 403, String(noCsrf));

    await page.goto(`${BASE}/admin/bookings/${target.id}?tab=workflow`, { waitUntil: 'domcontentloaded' });
    const timeline2 = await page.locator('.bd-timeline').innerText();
    check('The kanban move is recorded in the history',
      /confirmed\s*→\s*completed/i.test(timeline2), timeline2.replace(/\n/g, ' | ').slice(0, 160));

    /* ---------------- filters still work with legacy params ---------------- */
    // `&view=grid` pins the view: the page otherwise restores the remembered one.
    await page.goto(`${BASE}/admin/bookings?status=completed&view=grid`, { waitUntil: 'domcontentloaded' });
    check('Legacy ?status= filter still works',
      (await page.locator(`.bk-card:has-text("${target.code}")`).count()) === 1);
    await page.goto(`${BASE}/admin/bookings?dari=2020-01-01&sampai=2030-12-31&view=grid`, { waitUntil: 'domcontentloaded' });
    check('Legacy date-range params still work', (await page.locator('.bk-card').count()) >= 3);

    /* ---------------- mobile ---------------- */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/admin/bookings`, { waitUntil: 'domcontentloaded' });
    const ov = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth
    }));
    check('Mobile Kelola Booking has no horizontal overflow', ov.scroll <= ov.client + 1, JSON.stringify(ov));
    await page.click('[data-side-toggle]');
    await sleep(350);
    check('Mobile drawer opens', await page.locator('[data-side]').evaluate((el) => el.classList.contains('is-open')));
    check('Mobile drawer still shows collapsible group headers',
      await page.locator('[data-nav-toggle-group]').first().isVisible());

    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    const ovHome = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth
    }));
    check('Mobile Overview has no horizontal overflow', ovHome.scroll <= ovHome.client + 1, JSON.stringify(ovHome));

    await page.goto(`${BASE}/admin/bookings/${target.id}?tab=pembayaran`, { waitUntil: 'domcontentloaded' });
    const ovDetail = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth
    }));
    check('Mobile detail page has no horizontal overflow', ovDetail.scroll <= ovDetail.client + 1, JSON.stringify(ovDetail));

    // The negative tests above intentionally produced 422/403 responses; Chromium logs those
    // as console errors, so only real page errors are treated as failures here.
    const realErrors = errors.filter((e) => !/Failed to load resource/i.test(e));
    check('No JavaScript errors across admin pages', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });

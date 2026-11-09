'use strict';

/**
 * V9 acceptance suite — client photo-selection portal.
 * Run with a SERVER ALREADY LISTENING on BASE (see the npm script / README section):
 *   BASE=http://127.0.0.1:4420 node scripts/check-selection.js
 *
 * Uses an isolated data dir + upload dir (DLY_DATA_DIR / DLY_UPLOAD_DIR) so nothing
 * here touches the live database or the live uploads folder.
 */

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// The suite runs against an isolated copy (DLY_DATA_DIR) — never the live database.
const DATA_DIR = process.env.DLY_DATA_DIR || path.join(__dirname, '..', 'data');
const readDb = () => new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true, fileMustExist: true });

const BASE = process.env.BASE || 'http://127.0.0.1:4420';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';

let pass = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Solid-colour JPEG with a big numeral so every fixture is visually distinct. */
function jpeg(label, colour) {
  const tmp = path.join('/tmp', `dlysel-${label}.png`);
  execFileSync('convert', ['-size', '900x1200', `xc:${colour}`, '-gravity', 'center',
    '-pointsize', '220', '-fill', 'rgba(255,255,255,0.85)', '-annotate', '+0+0', label, tmp]);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf;
}

const files = [
  { name: 'sesi-01.jpg', mimeType: 'image/jpeg', buffer: jpeg('1', '#1B455F') },
  { name: 'sesi-02.jpg', mimeType: 'image/jpeg', buffer: jpeg('2', '#2C5E73') },
  { name: 'sesi-03.jpg', mimeType: 'image/jpeg', buffer: jpeg('3', '#0B2340') },
  { name: 'sesi-04.jpg', mimeType: 'image/jpeg', buffer: jpeg('4', '#5B7C8D') },
  { name: 'sesi-05.jpg', mimeType: 'image/jpeg', buffer: jpeg('5', '#8A6E4B') },
  { name: 'sesi-06.jpg', mimeType: 'image/jpeg', buffer: jpeg('6', '#6B7280') }
];

async function login(page) {
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"]', ADMIN_USER);
  await page.fill('input[name="password"]', ADMIN_PASS);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
}


/**
 * The suite needs at least two bookings. The live database may legitimately have none
 * (a fresh install, or the owner cleaned up), so create fixtures in the COPY instead of
 * depending on the owner's data. Writes only ever go to DLY_DATA_DIR.
 */
function ensureFixtureBookings(min = 2) {
  const dir = process.env.DLY_DATA_DIR;
  if (!dir) {
    console.log('  !  DLY_DATA_DIR not set — skipping fixture bookings (read-only run)');
    return;
  }
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dir, 'app.sqlite'));
  const have = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
  const city = db.prepare('SELECT id FROM cities LIMIT 1').get();
  const pkg = db.prepare('SELECT id FROM packages WHERE price_60 IS NOT NULL OR id IN (SELECT package_id FROM package_durations WHERE price IS NOT NULL) LIMIT 1').get()
    || db.prepare('SELECT id FROM packages LIMIT 1').get();
  const ins = db.prepare(`INSERT INTO bookings
      (code, access_token, client_name, client_phone, campus, city_id, shooting_date,
       location, package_id, duration, price, status, terms_consent, instagram)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 60, 0, 'confirmed', 1, ?)`);
  for (let i = have; i < min; i += 1) {
    ins.run(`DLY-TEST-${Date.now()}-${i}`, `tok-${i}`, `Klien Uji ${i + 1}`, '6281234567890',
      'Universitas Uji', city.id, '2026-12-0' + Math.min(9, i + 1), 'Studio Uji', pkg.id, `klien.uji${i}`);
  }
  // The owner's real bookings may ALL already have a portal, which would leave the
  // "Belum Dibuat" list empty. Guarantee one booking without a portal exists for that check.
  const withoutPortal = db.prepare(`SELECT COUNT(*) AS n FROM bookings b
      WHERE NOT EXISTS (SELECT 1 FROM photo_selections ps WHERE ps.booking_id = b.id)`).get().n;
  if (!withoutPortal) {
    ins.run(`DLY-TEST-NOPORTAL-${Date.now()}`, `tok-np-${Date.now()}`, 'Klien Tanpa Portal',
      '6281234567890', 'Universitas Uji', city.id, '2026-12-09', 'Studio Uji', pkg.id, `klien.noportal`);
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
  db.close();
  console.log(`  ·  fixture bookings: ${have} → ${after} (tanpa portal: ${withoutPortal || 1})`);
}

async function main() {
  ensureFixtureBookings(3);  // one gets a portal in the main flow, one is used for the cascade test
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  page.on('dialog', (d) => d.accept());

  await login(page);

  /* ---------------- admin list + create ---------------- */
  await page.goto(`${BASE}/admin/selection`, { waitUntil: 'domcontentloaded' });
  check('Seleksi Foto menu lists bookings (Belum Dibuat rows present)',
    (await page.locator('.sel-status--none').count()) > 0);
  check('Sidebar has Operasional → Seleksi Foto',
    (await page.locator('.admin-nav a[href$="/admin/selection"]').count()) === 1);

  // Bookings page: the portal button is on every booking card.
  await page.goto(`${BASE}/admin/bookings?view=grid`, { waitUntil: 'domcontentloaded' });
  // A card whose portal does not exist YET (otherwise the button is the WhatsApp
  // "Link Portal", which is correct behaviour but would not open the wizard).
  const cardCount = await page.locator('.bk-card').count();
  let bookingCard = null;
  let portalBtn = null;
  for (let i = 0; i < cardCount; i += 1) {
    const card = page.locator('.bk-card').nth(i);
    const btn = card.locator('a[href$="/portal"]').first();
    if (await btn.count()) { bookingCard = card; portalBtn = btn; break; }
  }
  check('Booking card has a portal button', Boolean(portalBtn),
    portalBtn ? await portalBtn.innerText() : 'no card with /portal link');
  const bookingCode = (await bookingCard.locator('.bk-card__code').innerText()).trim();
  const bookingName = (await bookingCard.locator('.bk-card__title strong').innerText()).trim();
  await Promise.all([page.waitForNavigation(), portalBtn.click()]);
  // V9.2: the card opens the "Buat Portal" wizard first. Create it without a Drive folder
  // (the Drive import path is covered by scripts/check-drive.js).
  if (/\/portal$/.test(page.url())) {
    await Promise.all([page.waitForNavigation(), page.locator('button[name="no_drive"]').click()]);
  }
  check('Creating a portal redirects to its editor', /\/admin\/selection\/\d+/.test(page.url()), page.url());
  const portalId = Number(page.url().match(/\/admin\/selection\/(\d+)/)[1]);
  const portalUrl = await page.inputValue('[data-portal-url]');
  check('Portal link uses /selection/<token>', /\/selection\/[a-f0-9]{48}$/.test(portalUrl), portalUrl);
  const token = portalUrl.split('/').pop();

  /* ---------------- photo upload ---------------- */
  await page.setInputFiles('#photo_files', files);
  await Promise.all([page.waitForNavigation({ timeout: 30000 }), page.click('form.sel-upload button[type="submit"]')]);
  const photoCount = await page.locator('.sel-photo').count();
  check('6 photos uploaded', photoCount === 6, `count=${photoCount}`);
  check('Photos get stable codes #001…',
    (await page.locator('.sel-photo').first().innerText()).includes('#001'));
  check('First upload becomes the main photo',
    (await page.locator('.sel-photo').first().locator('.admin-badge--ok').count()) >= 1);

  const db = readDb();
  const fixturePhotoIds = db.prepare('SELECT id FROM photo_selection_photos WHERE portal_id = ? ORDER BY sort_order LIMIT 2')
    .all(portalId).map((r) => r.id);
  const masters = db.prepare('SELECT image FROM photo_selection_photos WHERE portal_id = ?').all(portalId)
    .map((r) => path.basename(String(r.image)));
  db.close();

  // Thumbnails render through the app (watermarked preview), never a master URL.
  const thumb200 = await page.evaluate(async () => {
    const img = document.querySelector('.sel-photo__media img');
    return img.src;
  });
  check('Admin thumbnail URL is app-scoped, not a file URL',
    thumb200.includes('/admin/selection/') && !thumb200.includes('/uploads/'), thumb200);

  /* ---------------- quota + instructions ---------------- */
  await page.fill('#quota', '3');
  await page.fill('#instructions', 'Pilih 3 foto terbaik ya, Kak. Klik foto untuk memperbesar.');
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/settings"] button[type="submit"]')]);
  check('Quota saved = 3', (await page.inputValue('#quota')) === '3');

  /* ---------------- reorder + main photo ---------------- */
  const firstCode = await page.locator('.sel-photo__meta strong').first().innerText();
  await Promise.all([page.waitForNavigation(),
    page.locator('.sel-photo').nth(1).locator('form[action$="/move"] input[value="up"]').first().evaluate((el) => el.form.requestSubmit())]);
  check('Reordering changes the first photo', (await page.locator('.sel-photo__meta strong').first().innerText()) !== firstCode);
  await Promise.all([page.waitForNavigation(),
    page.locator('.sel-photo').nth(2).locator('form[action$="/primary"] button').evaluate((b) => b.form.requestSubmit())]);
  check('Setting a main photo is reflected',
    (await page.locator('.sel-photo').nth(2).locator('.admin-badge--ok').count()) >= 1);

  /* ---------------- client portal (separate browser) ---------------- */
  const client2 = await chromium.launch();
  const cpage = await client2.newPage({ viewport: { width: 1280, height: 900 } });
  cpage.on('dialog', (d) => d.accept());

  await cpage.goto(portalUrl, { waitUntil: 'domcontentloaded' });
  const heroName = await cpage.locator('.sel-hero h1').innerText().catch(async () =>
    cpage.locator('.cp-photo__id h1').innerText());
  // Nama di portal kini menyertakan gelar ("Iis Dahlia, S.Pd"); bandingkan bagian namanya.
  const firstWord = bookingName.replace(/,/g, ' ').trim().split(/\s+/)[0];
  check('Client sees the client name', heroName.includes(firstWord), `${heroName} vs ${bookingName}`);
  check('Client sees the booking id', (await cpage.content()).includes(bookingCode));
  check('Client sees the instructions', (await cpage.content()).includes('Pilih 3 foto terbaik'));
  check('Gallery shows all 6 photos', (await cpage.locator('.sel-tile[data-photo]').count()) === 6);
  check('Counter starts at 0 / 3', (await cpage.locator('[data-sel-counter]').innerText()).replace(/\s/g, '') === '0/3');
  check('Submit button is disabled with no picks',
    await cpage.locator('[data-sel-send]').isDisabled());

  // Portal HTML must never leak master file URLs.
  const imgSrcs = await cpage.$$eval('.sel-tile img', (els) => els.map((e) => e.getAttribute('src') || ''));
  check('Every gallery image goes through the token-scoped photo route',
    imgSrcs.length === 6 && imgSrcs.every((s) => /^\/selection\/[a-f0-9]{48}\/photo\/\d+(\?w=\d+)?$/.test(s)),
    imgSrcs.slice(0, 2).join(' | '));
  const portalHtmlNow = await cpage.content();
  check('No master photo filename appears in the client portal HTML',
    masters.length === 6 && masters.every((m) => !portalHtmlNow.includes(m)),
    masters.filter((m) => portalHtmlNow.includes(m)).join(', '));
  check('Portal is noindex', /noindex/.test(await cpage.content()));

  const tiles = cpage.locator('.sel-tile[data-photo]');
  for (const i of [0, 1, 2]) {
    await tiles.nth(i).locator('[data-pick]').click();
    await cpage.waitForFunction((n) => document.querySelector('[data-sel-counter]').textContent.replace(/\s/g, '').startsWith(n), String(i + 1));
  }
  check('Counter follows the quota (3 / 3)', (await cpage.locator('[data-sel-counter]').innerText()).replace(/\s/g, '') === '3/3');
  check('Selected tiles are marked', (await cpage.locator('.sel-tile.is-picked').count()) === 3);

  await tiles.nth(3).locator('[data-pick]').click();
  await cpage.waitForTimeout(600);
  check('4th pick is refused by the quota', (await cpage.locator('.sel-tile.is-picked').count()) === 3);
  check('Quota message is shown', await cpage.locator('.sel-toast.is-error.is-visible').count() > 0);

  await tiles.nth(1).locator('[data-pick]').click();
  await cpage.waitForFunction(() => document.querySelector('[data-sel-counter]').textContent.replace(/\s/g, '') === '2/3');
  check('Unpicking works', (await cpage.locator('[data-sel-counter]').innerText()).replace(/\s/g, '') === '2/3');
  await tiles.nth(3).locator('[data-pick]').click();
  await cpage.waitForFunction(() => document.querySelector('[data-sel-counter]').textContent.replace(/\s/g, '') === '3/3');
  check('Picked after freeing a slot', (await cpage.locator('.sel-tile.is-picked').count()) === 3);

  // Persistence: reload keeps the picks (stored server-side).
  await cpage.reload({ waitUntil: 'domcontentloaded' });
  check('Picks survive a reload', (await cpage.locator('[data-sel-counter]').innerText()).replace(/\s/g, '') === '3/3');

  // Lightbox with next/previous across the whole session.
  await cpage.locator('.sel-tile[data-photo]').nth(2).locator('[data-lightbox]').click();
  await cpage.waitForSelector('[data-lightbox-modal]:not([hidden])');
  check('Lightbox opens', await cpage.locator('[data-lightbox-modal]').isVisible());
  const counterText = await cpage.locator('[data-lb-counter]').innerText();
  check('Lightbox counter covers the whole gallery', /\/ 6$/.test(counterText.trim()), counterText);
  await cpage.click('[data-lb-next]');
  check('Lightbox next works', (await cpage.locator('[data-lb-counter]').innerText()).trim() !== counterText.trim());
  await cpage.keyboard.press('Escape');

  /* ---------------- confirmation modal + submit ---------------- */
  await cpage.click('[data-sel-send]');
  await cpage.waitForSelector('[data-sel-modal]:not([hidden])');
  check('Confirmation modal lists the chosen count',
    (await cpage.locator('[data-sel-modal-count]').innerText()).trim() === '3');
  // Revisi: daftar untuk WhatsApp = nama file BERSIH (tanpa nomor urut & tanpa ekstensi).
  const modalList = (await cpage.locator('[data-sel-modal-list]').innerText()).trim().split('\n').map((l) => l.trim()).filter(Boolean);
  check('Confirmation modal lists one clean name per pick', modalList.length === 3, JSON.stringify(modalList));
  check('Names carry no leading number and no file extension',
    modalList.every((n) => !/^\d+\s*[.)]/.test(n) && !/\.(jpe?g|png|webp|gif)$/i.test(n)),
    JSON.stringify(modalList));
  const [waPopup] = await Promise.all([
    cpage.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
    cpage.click('[data-sel-submit]')
  ]);
  if (waPopup) await waPopup.close().catch(() => {});
  await cpage.waitForLoadState('domcontentloaded').catch(() => {});
  check('Success screen after sending', /berhasil dikirim|sudah dikirim/i.test(await cpage.locator('.sel-card h2').innerText()));
  check('Sent state shows the picked photos', (await cpage.locator('.sel-grid--readonly .sel-tile').count()) === 3);

  const pickAgain = await cpage.evaluate(async (t) => {
    const res = await fetch(`/selection/${t}/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoId: 1, action: 'add' })
    });
    return res.status;
  }, token);
  check('Picking after submit is rejected (409)', pickAgain === 409, `status=${pickAgain}`);

  /* ---------------- admin sees the result ---------------- */
  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  const adminBody = await page.content();
  check('Admin portal page shows the sent status', /Pilihan Terkirim/i.test(adminBody));
  check('Admin sees 3 picked photos', (await page.locator('.sel-picked__item').count()) === 3);
  check('Admin sees the picked photo codes',
    /\b\d{3}\b/.test(await page.locator('.sel-pick-table').innerText()));
  check('Admin page shows the submitted timestamp',
    /dikirim:/i.test(await page.locator('.sel-chips').innerText()));

  // CSV export
  const csv = await page.evaluate(async (id) => {
    const res = await fetch(`/admin/selection/${id}/export.csv`);
    return { status: res.status, text: await res.text() };
  }, portalId);
  check('CSV export downloads', csv.status === 200 && csv.text.includes('kode_foto'));
  check('CSV marks exactly 3 photos as picked',
    (csv.text.match(/,ya,\d+,\d{4}-\d{2}-\d{2}/g) || []).length === 3, csv.text.slice(0, 200));

  // ZIP export (store-method writer, no dependency)
  const zip = await page.evaluate(async (id) => {
    const res = await fetch(`/admin/selection/${id}/download.zip`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, head: Array.from(buf.slice(0, 4)), tail: Array.from(buf.slice(-22)), size: buf.length };
  }, portalId);
  check('ZIP export is a real ZIP', zip.status === 200 && zip.head.join(',') === '80,75,3,4' && zip.tail.slice(0, 2).join(',') === '80,75',
    JSON.stringify(zip));
  check('ZIP contains data', zip.size > 5000, `size=${zip.size}`);

  /* ---------------- security ---------------- */
  const bad = await cpage.evaluate(async () => (await fetch('/selection/deadbeefdeadbeefdeadbeefdeadbeef')).status);
  check('Unknown token → 404', bad === 404, `status=${bad}`);

  // Photo of another portal must not be reachable through this token.
  const otherPhotoId = await page.evaluate(async (id) => {
    const res = await fetch(`/admin/selection/${id}`);
    const html = await res.text();
    const m = html.match(/\/admin\/selection\/\d+\/photo\/(\d+)/);
    return m ? Number(m[1]) : 0;
  }, portalId);
  const cross = await cpage.evaluate(async ({ t, pid }) => {
    const res = await fetch(`/selection/${t}/photo/${pid + 9999}`);
    return res.status;
  }, { t: token, pid: otherPhotoId });
  check('Foreign photo id through a valid token → 404', cross === 404, `status=${cross}`);

  // Token rotation invalidates the old link.
  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation(),
    page.locator('form[action$="/token"] button').click()]);
  const newUrl = await page.inputValue('[data-portal-url]');
  check('Token rotation produces a new link', newUrl !== portalUrl);
  const oldStatus = await cpage.evaluate(async (t) => (await fetch(`/selection/${t}`)).status, token);
  check('Old token no longer opens the portal', oldStatus === 404, `status=${oldStatus}`);
  const newToken = newUrl.split('/').pop();
  const newStatus = await cpage.evaluate(async (t) => (await fetch(`/selection/${t}`)).status, newToken);
  check('New token opens the portal (admin submitted view)', newStatus === 200, `status=${newStatus}`);

  // Closing the portal blocks the client but not the admin.
  check('Exactly one portal on/off control exists',
    (await page.locator('form[action$="/toggle"] button').count()) === 1);
  await Promise.all([page.waitForNavigation(), page.locator('form[action$="/toggle"] button').first().click()]);
  await cpage.goto(newUrl, { waitUntil: 'domcontentloaded' });
  check('Closed portal shows the closed state', (await cpage.content()).includes('Portal seleksi sudah ditutup'));
  const photoBlocked = await cpage.evaluate(async ({ t, id }) => (await fetch(`/selection/${t}/photo/${id}`)).status,
    { t: newToken, id: fixturePhotoIds[0] });
  check('Closed portal blocks photo requests (403)', photoBlocked === 403, `status=${photoBlocked}`);
  await page.goto(newUrl, { waitUntil: 'domcontentloaded' });
  check('Admin can still preview a closed portal', (await page.locator('.sel-hero h1').count()) === 1);

  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation(), page.locator('form[action$="/toggle"] button').first().click()]);
  check('Portal can be reopened', /aktif/i.test(await page.locator('.sel-chips .admin-badge').first().innerText()));

  /* ---------------- watermark + mobile ---------------- */
  await cpage.goto(newUrl, { waitUntil: 'domcontentloaded' });
  const wm = await cpage.evaluate(async ({ t, id }) => {
    const res = await fetch(`/selection/${t}/photo/${id}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { type: res.headers.get('content-type'), size: buf.length, cache: res.headers.get('cache-control') };
  }, { t: newToken, id: fixturePhotoIds[0] });
  check('Preview is served as an image', /image\//.test(wm.type), wm.type);
  check('Preview is private-cached', /private/.test(wm.cache), wm.cache);

  await cpage.setViewportSize({ width: 390, height: 844 });
  await cpage.reload({ waitUntil: 'domcontentloaded' });
  const overflow = await cpage.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth
  }));
  check('Mobile portal has no horizontal overflow', overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));
  const cols = await cpage.evaluate(() => {
    const grid = document.querySelector('.sel-grid');
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
  });
  check('Mobile gallery is 2 columns', cols === 2, `cols=${cols}`);

  /* ---------------- Drive folder link in the portal ---------------- */
  // Revisi 4: booking yang SUDAH punya subfolder "01. FILE MENTAH" mendapat link otomatis
  // (read-only). Bagian ini menguji jalur booking LAMA (link manual), jadi subfolder
  // mentahnya dilepas dulu — hanya di salinan database (DLY_DATA_DIR).
  const dbrw = new Database(path.join(DATA_DIR, 'app.sqlite'));
  dbrw.prepare('UPDATE bookings SET drive_raw_id = NULL WHERE code = ?').run(bookingCode);
  dbrw.close();

  // Reset to the booking's own Drive folder first (drive_url empty + visible).
  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#drive_url', '');
  await page.check('input[name="drive_show"]');
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/settings"] button[type="submit"]')]);
  const bookingDriveUrl = await page.evaluate(() => {
    const a = document.querySelector('.admin-hint a[href*="drive.google.com"]');
    return a ? a.getAttribute('href') : '';
  });

  await cpage.goto(newUrl, { waitUntil: 'domcontentloaded' });
  const driveBtn = cpage.locator('.sel-drive a.sel-btn--drive');
  if (bookingDriveUrl) {
    check('Portal shows the booking Drive folder when the field is empty',
      (await driveBtn.count()) === 1 && (await driveBtn.getAttribute('href')) === bookingDriveUrl,
      await driveBtn.getAttribute('href'));
  } else {
    check('Portal hides the Drive block when no folder exists', (await driveBtn.count()) === 0);
  }

  // Custom pasted link wins.
  const customDrive = 'https://drive.google.com/drive/folders/CustomFolderId123456';
  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#drive_url', customDrive);
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/settings"] button[type="submit"]')]);
  await cpage.goto(newUrl, { waitUntil: 'domcontentloaded' });
  check('Custom Drive link overrides the booking folder',
    (await cpage.locator('.sel-drive a.sel-btn--drive').getAttribute('href')) === customDrive);
  check('Drive button opens in a new tab safely',
    (await cpage.locator('.sel-drive a.sel-btn--drive').getAttribute('rel') || '').includes('noopener'));

  // Bare folder id is accepted and normalised.
  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#drive_url', '1AbCdEfGhIjKlMnOpQrStUvWxYz01234');
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/settings"] button[type="submit"]')]);
  check('Bare folder id is normalised into a Drive URL',
    (await page.inputValue('#drive_url')) === 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz01234',
    await page.inputValue('#drive_url'));

  // A non-Drive URL is rejected instead of ending up in the client portal.
  await page.fill('#drive_url', 'https://example.com/foto-saya.zip');
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/settings"] button[type="submit"]')]);
  check('Non-Drive link is rejected with a message',
    /harus berupa tautan Google Drive/i.test(await page.content()));
  check('Rejected link did not replace the stored one',
    (await page.inputValue('#drive_url')).includes('drive.google.com'));

  // Hiding the toggle removes it from the client portal.
  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  await page.uncheck('input[name="drive_show"]');
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/settings"] button[type="submit"]')]);
  await cpage.goto(newUrl, { waitUntil: 'domcontentloaded' });
  check('Unchecked "tampilkan" hides the Drive block', (await cpage.locator('.sel-drive').count()) === 0);

  // Restore visible for the WhatsApp-check below.
  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  await page.check('input[name="drive_show"]');
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/settings"] button[type="submit"]')]);

  /* ---------------- WhatsApp invite (encoding) ---------------- */
  await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
  const waHref = await page.getAttribute('a[href*="wa.me/"]', 'href');
  const waText = decodeURIComponent((waHref || '').split('text=')[1] || '');
  check('WhatsApp button opens wa.me with the client number', /wa\.me\/\d{8,}/.test(waHref || ''), waHref);
  check('WhatsApp message greets the client by name', waText.includes(`Halo Kak ${bookingName}`), waText.slice(0, 60));
  check('WhatsApp emoji survive UTF-8 encoding', waText.includes('👋😊') && waText.includes('📸✨'));
  check('WhatsApp message carries the portal link', waText.includes(newUrl));
  check('WhatsApp message states the quota', waText.includes('3 foto'), waText.split('\n').find((l) => l.includes('kuota')) || '');
  // {{folder_drive}} is an optional placeholder — assert the data contract, not the wording.
  const tplHasFolderVar = await page.evaluate(async () => {
    const res = await fetch('/admin/wa-template');
    return (await res.text()).includes('{{folder_drive}}');
  });
  check('WhatsApp template screen documents {{folder_drive}}', tplHasFolderVar);

  /* ---------------- list view reflects the status ---------------- */
  await page.goto(`${BASE}/admin/selection`, { waitUntil: 'domcontentloaded' });
  const listBody = await page.content();
  check('List view shows the sent portal', /Pilihan Terkirim/i.test(listBody));
  check('List view keeps "Belum Dibuat" filter', /Belum Dibuat/i.test(listBody));

  await page.goto(`${BASE}/admin/selection?status=submitted`, { waitUntil: 'domcontentloaded' });
  check('Status filter narrows the list', (await page.locator('.admin-table--selection tbody tr').count()) >= 1
    && /Pilihan Terkirim/i.test(await page.content()));
  await page.goto(`${BASE}/admin/selection?q=${encodeURIComponent(bookingName)}`, { waitUntil: 'domcontentloaded' });
  check('Search finds the client', (await page.content()).includes(bookingCode));

  /* ---------------- booking delete cascades the portal ---------------- */
  await page.goto(`${BASE}/admin/bookings?view=grid`, { waitUntil: 'domcontentloaded' });
  // Pick a booking that does NOT have a portal yet (the live database already contains the
  // owner's real booking with its own portal, so "the second card" is not a safe assumption).
  const secondCard = page.locator('.bk-card').filter({ has: page.locator('a[href$="/portal"]') }).first();
  const secondBookingId = Number((await secondCard.getAttribute('id')).replace('b-', ''));
  // The booking card opens the "Buat Portal Seleksi Foto" wizard.
  await Promise.all([page.waitForNavigation({ timeout: 20000 }),
    secondCard.locator('a[href$="/portal"]').first().click()]);
  if (/\/portal$/.test(page.url())) {
    await Promise.all([page.waitForNavigation(),
      page.locator('button[name="no_drive"]').click()]);
  }
  const cascadePortalId = Number(page.url().match(/\/admin\/selection\/(\d+)/)[1]);
  const dbc = readDb();
  const before = dbc.prepare('SELECT COUNT(*) AS n FROM photo_selections WHERE id = ?').get(cascadePortalId).n;
  dbc.close();
  check('Second portal created for the cascade test', before === 1);

  // Tahap 3: delete lives on the booking detail page.
  await page.goto(`${BASE}/admin/bookings/${secondBookingId}?tab=workflow`, { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation(),
    page.locator('#workflow form[action$="/delete"] button').click()]);
  const dbd = readDb();
  const after = dbd.prepare('SELECT COUNT(*) AS n FROM photo_selections WHERE id = ?').get(cascadePortalId).n;
  dbd.close();
  check('Deleting a booking also removes its portal (no orphan rows)', after === 0);

  await client2.close();
  await browser.close();

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

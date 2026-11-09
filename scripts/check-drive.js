'use strict';

/**
 * V9.2 acceptance suite — Google Drive → portal seleksi foto.
 *
 * Runs against a LOCAL MOCK of the Drive API (scripts/mock-drive.js), so no real Google
 * account or quota is touched. The app instance gets its own data dir + upload dir and a
 * copy of the live database, so nothing here can write to production data.
 *
 *   node scripts/check-drive.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP_PORT = Number(process.env.PORT || 4433);
const MOCK_PORT = Number(process.env.MOCK_PORT || 4699);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const DATA_DIR = process.env.DLY_DATA_DIR || '/tmp/dly-drive-test';
const UPLOAD_DIR = process.env.DLY_UPLOAD_DIR || '/tmp/dly-drive-test/uploads';
const FOLDER_ID = 'MockFolderIdAAAAAAAAAAAA';
const EMPTY_FOLDER_ID = 'MockEmptyFolderBBBBBBBBBBBB';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch (err) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function prepareDb() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  // Copy the WAL + SHM too — the live database keeps recent rows in the WAL.
  fs.readdirSync(path.join(__dirname, '..', 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(__dirname, '..', 'data', f), path.join(DATA_DIR, f)));
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  // API-key mode: the mock accepts any key, real Drive would need a public folder.
  db.prepare("INSERT INTO settings (key, value) VALUES ('gdrive_api_key', 'MOCK_API_KEY') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('gdrive_reader_refresh_token', '') ON CONFLICT(key) DO UPDATE SET value = ''").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('selection_allow_download', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  // Pick a booking that has no portal yet (the live DB may already contain real portals —
  // those belong to the owner and must never be touched).
  let booking = db.prepare(`SELECT b.id, b.code, b.client_name FROM bookings b
                            LEFT JOIN photo_selections ps ON ps.booking_id = b.id
                            WHERE ps.id IS NULL ORDER BY b.id DESC LIMIT 1`).get();
  if (!booking) {
    // Every booking already has a portal: add a dedicated fixture row in the COPY.
    const city = db.prepare('SELECT id FROM cities LIMIT 1').get();
    const pkg = db.prepare('SELECT id FROM packages LIMIT 1').get();
    const info = db.prepare(`INSERT INTO bookings
        (code, access_token, client_name, client_phone, campus, city_id, shooting_date,
         location, package_id, duration, price, status, terms_consent)
        VALUES (?, ?, 'Klien Uji Drive', '6281234567890', 'Universitas Uji', ?, ?, 'Studio Uji',
                ?, 60, 0, 'confirmed', 1)`).run(
      `DLY-TEST-${Date.now()}`, 'testtoken', city.id, '2026-12-01', pkg.id
    );
    booking = db.prepare('SELECT id, code, client_name FROM bookings WHERE id = ?').get(Number(info.lastInsertRowid));
  }
  // Revisi 4 — wizard memakai subfolder "01. FILE MENTAH" secara otomatis (read-only)
  // bila booking sudah punya drive_raw_id. Suite ini menguji jalur LINK MANUAL, jadi
  // fixture-nya dibuat seperti booking lama: belum punya subfolder mentah.
  db.prepare(`UPDATE bookings SET drive_raw_id = NULL, drive_sortir_id = NULL,
              drive_edit_id = NULL WHERE id = ?`).run(booking.id);
  db.close();
  return booking;
}

async function main() {
  const booking = prepareDb();

  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-drive.js')], {
    env: { ...process.env, PORT: String(MOCK_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));

  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DLY_DATA_DIR: DATA_DIR,
      DLY_UPLOAD_DIR: UPLOAD_DIR,
      GDRIVE_API_BASE: `${MOCK}/drive/v3`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));
  app.stdout.on('data', () => {});

  const cleanup = () => {
    try { app.kill(); } catch (e) { /* ignore */ }
    try { mock.kill(); } catch (e) { /* ignore */ }
  };
  process.on('exit', cleanup);

  try {
    await waitFor(`${MOCK}/mock/state`);
    await waitFor(`${BASE}/`);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('dialog', (d) => d.accept());

    /* ---------------- login + settings ---------------- */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    await page.goto(`${BASE}/admin/selection/settings`, { waitUntil: 'domcontentloaded' });
    check('Settings page renders the Drive panel', (await page.content()).includes('Akses Google Drive'));
    check('API key mode is reported as active',
      /API key/.test(await page.locator('.admin-panel').first().innerText()));
    await Promise.all([page.waitForNavigation(), page.click('form[action$="/settings/test"] button')]);
    check('"Tes akses" reports a working credential',
      /Akses baca Drive OK/i.test(await page.content()));

    /* ---------------- wizard: invalid + permission + empty ---------------- */
    await page.goto(`${BASE}/admin/bookings/${booking.id}/portal`, { waitUntil: 'domcontentloaded' });
    check('Wizard opens for a booking without a portal', (await page.locator('#drive_url').count()) === 1);

    await page.fill('#drive_url', 'https://example.com/folder');
    await Promise.all([page.waitForNavigation(), page.click('button[formaction$="/portal/test"]')]);
    check('Non-Drive link is rejected with a readable message',
      /harus berasal dari drive\.google\.com/i.test(await page.content()));

    await fetch(`${MOCK}/mock/mode?mode=notfound`, { method: 'POST' });
    await page.fill('#drive_url', `https://drive.google.com/drive/folders/${FOLDER_ID}`);
    await Promise.all([page.waitForNavigation(), page.click('button[formaction$="/portal/test"]')]);
    check('Folder not found shows an actionable error',
      /tidak ditemukan|belum dibagikan/i.test(await page.content()));
    check('No dummy photos were created on failure',
      (await page.locator('.sel-probe-list code').count()) === 0);

    await fetch(`${MOCK}/mock/mode?mode=forbidden`, { method: 'POST' });
    await Promise.all([page.waitForNavigation(), page.click('button[formaction$="/portal/test"]')]);
    check('Missing permission is explained (not a silent failure)',
      /tidak bisa dibaca dengan izin|Siapa saja yang memiliki link/i.test(await page.content()));

    await fetch(`${MOCK}/mock/mode?mode=quota`, { method: 'POST' });
    await Promise.all([page.waitForNavigation(), page.click('button[formaction$="/portal/test"]')]);
    check('Quota exceeded is explained', /Kuota Google Drive API terlampaui/i.test(await page.content()));

    await fetch(`${MOCK}/mock/mode?mode=ok`, { method: 'POST' });
    await page.fill('#drive_url', `https://drive.google.com/drive/folders/${EMPTY_FOLDER_ID}`);
    await Promise.all([page.waitForNavigation(), page.click('button[formaction$="/portal/test"]')]);
    check('Empty folder reports 0 photos', /0 foto/.test(await page.content()));

    /* ---------------- wizard: valid, paginated folder ---------------- */
    await fetch(`${MOCK}/mock/reset?n=5&page=2`, { method: 'POST' });
    await page.goto(`${BASE}/admin/bookings/${booking.id}/portal`, { waitUntil: 'domcontentloaded' });
    await page.fill('#drive_url', `https://drive.google.com/drive/folders/${FOLDER_ID}`);
    await page.fill('#quota', '3');
    await Promise.all([page.waitForNavigation(), page.click('button[formaction$="/portal/test"]')]);
    const probeText = await page.locator('.admin-flash--ok').innerText();
    check('Preview counts every photo across pagination pages', /5 foto/.test(probeText), probeText.slice(0, 120));
    check('Preview sample lists Drive file names', /DLY00001\.JPG/.test(probeText));

    // Create the portal.
    await Promise.all([page.waitForNavigation({ timeout: 60000 }),
      page.click('.xx-actions .admin-btn--primary')]);
    check('Portal creation lands on the portal editor', /\/admin\/selection\/\d+/.test(page.url()), page.url());
    const portalId = Number(page.url().match(/\/admin\/selection\/(\d+)/)[1]);

    const portalRow = await page.evaluate(async (id) => {
      const res = await fetch(`/admin/selection/${id}`);
      return res.text();
    }, portalId);
    check('All 5 Drive photos were imported', (await page.locator('.sel-photo').count()) === 5);
    check('Photos come from Drive (no local re-upload)', /Google Drive/.test(portalRow));
    check('Drive file names are shown to the admin', /DLY00001\.JPG/.test(portalRow));

    const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const rows = db.prepare('SELECT id, code, source, drive_file_id, file_name FROM photo_selection_photos WHERE portal_id = ? ORDER BY sort_order').all(portalId);
    const portalDb = db.prepare('SELECT token, drive_folder_id, quota FROM photo_selections WHERE id = ?').get(portalId);
    db.close();
    check('Every row is linked to a Drive file id',
      rows.length === 5 && rows.every((r) => r.source === 'drive' && /^mockfile/.test(r.drive_file_id)));
    check('Folder id is stored on the portal', portalDb.drive_folder_id === FOLDER_ID, portalDb.drive_folder_id);
    check('Quota from the wizard is applied', portalDb.quota === 3, String(portalDb.quota));

    /* ---------------- idempotency: pressing create again ---------------- */
    await page.goto(`${BASE}/admin/bookings/${booking.id}/portal`, { waitUntil: 'domcontentloaded' });
    check('Existing portal is not re-created (redirects to the editor)',
      page.url().includes(`/admin/selection/${portalId}`), page.url());

    /* ---------------- client portal ---------------- */
    const portalUrl = `${BASE}/selection/${portalDb.token}`;
    const client2 = await chromium.launch();
    const cpage = await client2.newPage({ viewport: { width: 1280, height: 900 } });
    cpage.on('dialog', (d) => d.accept());

    await cpage.goto(portalUrl, { waitUntil: 'domcontentloaded' });
    check('Client portal shows the Drive photos', (await cpage.locator('.sel-tile[data-photo]').count()) === 5);
    check('Header states the limit', (await cpage.locator('.sel-hero__stats').innerText()).includes('3 foto'));
    check('Filter tabs exist', (await cpage.locator('[data-filter]').count()) >= 2,
      String(await cpage.locator('[data-filter]').count()));
    check('Search + sort controls exist',
      (await cpage.locator('[data-sel-search]').count()) === 1
      && (await cpage.locator('[data-sel-sort]').count()) === 1);

    // Watermarked preview is served by the app, not from Drive.
    const imgInfo = await cpage.evaluate(async () => {
      const src = document.querySelector('.sel-tile img').getAttribute('src');
      const res = await fetch(src);
      return { src, type: res.headers.get('content-type'), status: res.status };
    });
    // V10: thumbnails request a width variant (?w=400) of the same token-scoped route.
    check('Preview goes through the token-scoped route',
      /^\/selection\/[a-f0-9]{48}\/photo\/\d+(\?w=\d+)?$/.test(imgInfo.src), imgInfo.src);
    check('Preview is an image served by the app', imgInfo.status === 200 && /image\//.test(imgInfo.type), imgInfo.type);

    // Search filter.
    await cpage.fill('[data-sel-search]', 'DLY00003');
    await sleep(200);
    check('Search narrows the grid', (await cpage.locator('.sel-tile[data-photo]:visible').count()) === 1);
    await cpage.fill('[data-sel-search]', '');

    // Sort Z→A.
    await cpage.selectOption('[data-sel-sort]', 'name-desc');
    await sleep(200);
    const firstName = await cpage.locator('.sel-tile[data-photo]').first().getAttribute('data-name');
    // V16: nama file untuk klien TANPA ekstensi (dipakai WhatsApp/daftar salin).
    check('Sort Z→A moves the last file first', /^dly00005/i.test(String(firstName)), String(firstName));
    await cpage.selectOption('[data-sel-sort]', 'default');

    // Pick 3 (quota) and refuse a 4th.
    const tiles = cpage.locator('.sel-tile[data-photo]');
    for (let i = 0; i < 3; i += 1) {
      await tiles.nth(i).locator('[data-pick]').click();
      await cpage.waitForFunction((n) => document.querySelector('[data-sel-counter]').textContent.trim().startsWith(String(n)), i + 1);
    }
    check('Counter follows the quota', (await cpage.locator('[data-sel-counter]').innerText()).trim() === '3/3');
    check('Picked photos show their order number',
      (await cpage.locator('.sel-tile.is-picked .sel-tile__order').allInnerTexts()).join(',').replace(/\s/g, '') === '1,2,3');
    await tiles.nth(3).locator('[data-pick]').click();
    await sleep(500);
    check('A 4th photo is refused', (await cpage.locator('.sel-tile.is-picked').count()) === 3);

    // "Foto Terpilih" tab.
    await cpage.click('[data-filter="picked"]');
    await sleep(200);
    check('"Foto Terpilih" tab filters the grid',
      (await cpage.locator('.sel-tile[data-photo]:visible').count()) === 3);
    await cpage.click('[data-filter="all"]');

    /* ---------------- submit modal ---------------- */
    await cpage.click('[data-sel-send]');
    await cpage.waitForSelector('[data-sel-modal]:not([hidden])');
    const listText = await cpage.locator('[data-sel-modal-list]').innerText();
    check('Modal lists the real Drive file names', /DLY00001/i.test(listText), listText.slice(0, 40));
    check('Modal shows the number of saved photos',
      (await cpage.locator('[data-sel-modal-count]').innerText()).trim() === '3');
    check('Modal has Salin Daftar Foto', (await cpage.locator('[data-sel-copy]').count()) === 1);
    check('Modal has the WhatsApp action', (await cpage.locator('[data-sel-submit]').count()) === 1);

    // Copy list (clipboard permissions granted).
    await cpage.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await cpage.click('[data-sel-copy]');
    await sleep(300);
    const clip = await cpage.evaluate(() => navigator.clipboard.readText());
    check('Copy puts the file list on the clipboard', /DLY00001/i.test(clip), clip.slice(0, 40));

    // Submit → WhatsApp URL + status.
    const [waPage] = await Promise.all([
      cpage.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
      cpage.click('[data-sel-submit]')
    ]);
    if (waPage) await waPage.close().catch(() => {});
    await cpage.waitForLoadState('domcontentloaded').catch(() => {});
    check('Submission lands on the sent state', /berhasil dikirim|sudah dikirim/i.test(await cpage.content()));

    const db2 = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const picks = db2.prepare(`SELECT position, file_name, drive_file_id, created_at
                               FROM photo_selection_picks WHERE portal_id = ? ORDER BY position`).all(portalId);
    const after = db2.prepare('SELECT status, submitted_at FROM photo_selections WHERE id = ?').get(portalId);
    db2.close();
    check('Picks store Drive file id + file name + order',
      picks.length === 3 && picks.every((p) => p.drive_file_id && p.file_name && p.position >= 1),
      JSON.stringify(picks[0] || {}));
    check('Selection is marked as submitted with a timestamp',
      after.status === 'submitted' && Boolean(after.submitted_at));

    // WhatsApp message contract (built server-side from the DB).
    const waLink = await page.evaluate(async (id) => {
      const res = await fetch(`/admin/selection/${id}`);
      const html = await res.text();
      const m = html.match(/data-wa-reminder[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-wa-reminder/);
      const raw = m ? (m[1] || m[2]) : '';
      return raw ? decodeURIComponent(raw.replace(/&amp;/g, '&')) : '';
    }, portalId);
    check('Admin page offers a WhatsApp reminder with the picked files',
      /^https:\/\/wa\.me\//.test(waLink) && /DLY\d{5}/i.test(waLink), waLink.slice(0, 200));

    /* ---------------- admin result view + exports ---------------- */
    await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
    const adminHtml = await page.content();
    check('Admin sees the picked file names', /DLY00001\.JPG/.test(adminHtml));
    check('Admin sees the Drive file id column', (await page.locator('.sel-pick-table').innerText()).includes('mockfile'));
    check('Admin sees pick order numbers', (await page.locator('.sel-pick-table tbody tr').count()) === 3);

    const csv = await page.evaluate(async (id) => (await (await fetch(`/admin/selection/${id}/export.csv`)).text()), portalId);
    check('CSV export contains file names and drive ids',
      csv.includes('nama_file') && csv.includes('DLY00001.JPG') && csv.includes('mockfile'));

    /* ---------------- sync: add + remove, keep picks ---------------- */
    await fetch(`${MOCK}/mock/add?name=DLY00099.JPG`, { method: 'POST' });
    await fetch(`${MOCK}/mock/remove?name=DLY00002.JPG`, { method: 'POST' });
    await Promise.all([page.waitForNavigation({ timeout: 60000 }),
      page.locator('form[action$="/sync"] button').click()]);
    const syncFlash = await page.locator('.admin-flash').first().innerText();

    const db3 = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const synced = db3.prepare('SELECT file_name, drive_file_id, is_available FROM photo_selection_photos WHERE portal_id = ?').all(portalId);
    const keptPicks = db3.prepare('SELECT COUNT(*) AS n FROM photo_selection_picks WHERE portal_id = ?').get(portalId).n;
    const dupes = db3.prepare(`SELECT drive_file_id, COUNT(*) n FROM photo_selection_photos
                               WHERE portal_id = ? GROUP BY drive_file_id HAVING n > 1`).all(portalId);
    db3.close();

    check('Sync adds the new Drive file', synced.some((r) => r.file_name === 'DLY00099.JPG'));
    check('Removed Drive file is marked unavailable (not deleted)',
      synced.some((r) => r.file_name === 'DLY00002.JPG' && Number(r.is_available) === 0));
    check('No duplicate photos after sync', dupes.length === 0, JSON.stringify(dupes));
    check('Client picks survive the sync', keptPicks === 3, `picks=${keptPicks}`);
    check('Sync result is reported in words', /Sinkronisasi selesai/.test(syncFlash), syncFlash.slice(0, 120));

    /* ---------------- closed / expired portals ---------------- */
    await page.goto(`${BASE}/admin/selection/${portalId}`, { waitUntil: 'domcontentloaded' });
    await Promise.all([page.waitForNavigation(),
      page.locator('form[action$="/toggle"] button, form[action$="/delete"] button').first().evaluate((el) => el.form.requestSubmit())]);
    const closedState = await page.evaluate(async (t) => (await fetch(`/selection/${t}`)).status, portalDb.token);
    check('Closed portal still answers (state screen)', closedState === 200, String(closedState));

    await client2.close();
    await browser.close();
  } finally {
    cleanup();
  }

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

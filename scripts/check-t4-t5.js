'use strict';

/**
 * Tahap 4 & 5 acceptance suite — notification centre, editing queue, PWA.
 *
 * Boots the app on its own port against a COPY of the database in /tmp and seeds demo
 * fixtures (a new booking, a payment, a submitted portal, a portal whose deadline passed,
 * and a shoot scheduled tomorrow) so every notification source has something to show.
 * The live database is never touched.
 *
 *   node scripts/check-t4-t5.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.T45_PORT || 4534);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = `/tmp/dly-t45-${Date.now()}`;
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try {
    fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true });
  } catch (err) { /* cold cache is fine */ }
}

/** Fixtures are written after boot (the tables are created by the boot migrations). */
function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const stamp = Date.now().toString().slice(-6);
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
  // WIB (seperti util.todayISO): UTC dan WIB berbeda tanggal antara 17:00–24:00 UTC.
  const day = (offset) => new Date(Date.now() + 7 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);

  const insert = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, campus, city_id, shooting_date, shooting_time,
     location, package_id, category_id, duration, duration_minutes, price, package_price_snapshot,
     total_price_snapshot, status, terms_consent, instagram, created_at, edited_photos_snapshot)
    VALUES (?, ?, ?, '6281234567890', 'Universitas Uji', ?, ?, '10:00', 'Studio Uji', ?, ?, 60, 60,
            ?, ?, ?, ?, 1, 'ujit45', datetime('now'), 12)`);
  const mk = (code, name, offset, status, price) => Number(insert.run(
    code, `tok-${code}`, name, city.id, day(offset), pkg.id, pkg.category_id, price, price, price, status
  ).lastInsertRowid);

  const newBooking = mk(`DLY-NEW-${stamp}`, 'Klien Baru Uji', 4, 'pending', 375000);   // → notif "booking baru"
  const tomorrow = mk(`DLY-TMR-${stamp}`, 'Klien Besok Uji', 1, 'confirmed', 450000);  // → notif "job besok"
  const editingBooking = mk(`DLY-EDT-${stamp}`, 'Klien Editing Uji', -3, 'completed', 675000);

  db.prepare('INSERT INTO booking_payments (booking_id, amount, paid_at, method, note) VALUES (?, ?, ?, ?, ?)')
    .run(newBooking, 150000, day(0), 'Transfer BCA', 'DP');

  // A portal the client already submitted (→ "pilihan foto masuk" + editing queue).
  // The portal token is the only credential — it must be 32-64 lowercase hex chars.
  const hexToken = () => crypto.randomBytes(24).toString('hex');
  const portalToken = hexToken();
  // Open + waiting: the test then submits it through the REAL client endpoint, so the
  // automatic queueing is exercised end-to-end (not simulated with SQL).
  const portal = Number(db.prepare(`INSERT INTO photo_selections
      (booking_id, token, quota, instructions, is_open, status, created_at, updated_at)
      VALUES (?, ?, 5, '', 1, 'waiting', datetime('now'), datetime('now'))`)
    .run(editingBooking, portalToken).lastInsertRowid);
  const photo = Number(db.prepare(`INSERT INTO photo_selection_photos
      (portal_id, code, image, is_primary, sort_order, file_name, source, created_at)
      VALUES (?, '001', '/ph/portfolio-event.svg', 1, 0, 'foto-uji.jpg', 'upload', datetime('now'))`)
    .run(portal).lastInsertRowid);
  db.prepare('INSERT INTO photo_selection_picks (portal_id, photo_id, position, file_name) VALUES (?, ?, 1, ?)')
    .run(portal, photo, 'foto-uji.jpg');

  // An OPEN portal whose deadline already passed (→ "deadline seleksi").
  const deadlineBooking = mk(`DLY-DLN-${stamp}`, 'Klien Deadline Uji', 9, 'confirmed', 375000);
  const deadlinePortal = Number(db.prepare(`INSERT INTO photo_selections
      (booking_id, token, quota, instructions, is_open, status, deadline, created_at, updated_at)
      VALUES (?, ?, 5, '', 1, 'waiting', ?, datetime('now'), datetime('now'))`)
    .run(deadlineBooking, hexToken(), day(-2)).lastInsertRowid);

  db.close();
  return { newBooking, tomorrow, editingBooking, portal, deadlinePortal, portalToken, stamp };
}

(async () => {
  prepare();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  const errors = [];
  try {
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const fx = seed();

    // Client submits the photo picks through the public endpoint — this both creates the
    // "pilihan foto masuk" notification and must queue the editing job automatically.
    const submitRes = await fetch(`${BASE}/selection/${fx.portalToken}/submit`, {
      method: 'POST', headers: { accept: 'application/json' }
    });
    const submitBody = await submitRes.json().catch(() => ({}));
    check('Client can submit the photo selection', submitRes.status === 200 && submitBody.ok === true,
      `${submitRes.status} ${JSON.stringify(submitBody).slice(0, 120)}`);
    const autoJob = await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const job = db.prepare('SELECT * FROM editing_jobs WHERE booking_id = ?').get(fx.editingBooking);
      const portalRow = db.prepare('SELECT status FROM photo_selections WHERE id = ?').get(fx.portal);
      db.close();
      return { job, portalStatus: portalRow.status };
    })();
    check('Submitting a selection queues an editing job automatically',
      Boolean(autoJob.job) && autoJob.job.status === 'queued', JSON.stringify(autoJob.job && autoJob.job.status));
    check('The auto-queued job snapshots the number of picked photos',
      autoJob.job && Number(autoJob.job.photo_count) === 1, String(autoJob.job && autoJob.job.photo_count));

    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    /* ============================================================
       1. PWA — manifest, icons, service worker, offline public pages
       ============================================================ */
    const man = await page.goto(`${BASE}/manifest.webmanifest`);
    const manifest = await man.json();
    check('Manifest is served as a manifest', (man.headers()['content-type'] || '').includes('manifest'));
    check('Manifest has a name + short_name', Boolean(manifest.name && manifest.short_name), JSON.stringify([manifest.name, manifest.short_name]));
    check('short_name is a launcher label, not a chopped name', /^[A-Z]{2,6}$/.test(manifest.short_name || ''), manifest.short_name);
    check('Manifest start_url/scope point at the app root', manifest.start_url === '/' && manifest.scope === '/');
    check('Manifest is standalone', manifest.display === 'standalone');
    check('Manifest declares 192 + 512 + maskable icons',
      manifest.icons.some((i) => i.sizes === '192x192')
      && manifest.icons.some((i) => i.sizes === '512x512')
      && manifest.icons.some((i) => i.purpose === 'maskable'));
    for (const icon of manifest.icons) {
      const r = await page.request.get(BASE + icon.src);
      check(`Icon ${icon.src} loads (${icon.sizes})`, r.ok() && (r.headers()['content-type'] || '').includes('png'), String(r.status()));
    }

    const home = await page.goto(`${BASE}/`, { waitUntil: 'load' });
    check('Homepage links the manifest', await page.locator('link[rel="manifest"]').count() === 1);
    // Registration is asynchronous: wait for `serviceWorker.ready` (it resolves once the
    // worker controls this page) instead of reading getRegistration() immediately.
    const registered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const timeout = new Promise((r) => setTimeout(() => r(null), 15000));
      const ready = navigator.serviceWorker.ready.then((reg) => Boolean(reg && reg.active));
      return Promise.race([ready, timeout]);
    });
    check('Service worker registers and activates', registered === true, String(registered));
    const swHeaders = await page.request.get(`${BASE}/sw.js`);
    check('Service worker is not pinned by the HTTP cache',
      /no-cache/.test(swHeaders.headers()['cache-control'] || ''), swHeaders.headers()['cache-control']);
    check('Install chip is hidden until the browser offers it',
      await page.locator('[data-install-app]').isHidden());

    // Visit the three public pages so the worker has something to cache.
    for (const url of ['/', '/pricelist', '/gallery']) {
      await page.goto(BASE + url, { waitUntil: 'load' });
      await sleep(500);
    }
    const cachedKeys = await page.evaluate(async () => {
      const names = await caches.keys();
      const out = [];
      for (const n of names) {
        const c = await caches.open(n);
        (await c.keys()).forEach((req) => out.push(new URL(req.url).pathname));
      }
      return out;
    });
    check('Public pages are cached for offline use',
      ['/pricelist', '/gallery'].every((p) => cachedKeys.includes(p)), cachedKeys.join(', '));
    check('Admin is never cached by the service worker',
      !cachedKeys.some((p) => p.startsWith('/admin')), cachedKeys.filter((p) => p.includes('admin')).join(', '));
    check('Offline fallback page is precached', cachedKeys.includes('/offline.html'));

    // Now go offline and reload the cached pages.
    await context.setOffline(true);
    const offlineHome = await page.goto(BASE + '/', { waitUntil: 'load' }).catch(() => null);
    check('Homepage opens while offline', Boolean(offlineHome) && (await page.locator('body').count()) === 1);
    await page.goto(BASE + '/pricelist', { waitUntil: 'load' }).catch(() => {});
    check('Pricelist opens while offline', (await page.locator('.pkg-feature, .pkg-browser').count()) > 0);
    await page.goto(BASE + '/gallery', { waitUntil: 'load' }).catch(() => {});
    check('Portfolio opens while offline', (await page.locator('.portfolio-card, .gallery-masonry').count()) > 0);
    // A page that was never cached must fall back to the offline page, not a browser error.
    await page.goto(BASE + '/booking', { waitUntil: 'load' }).catch(() => {});
    check('An uncached page falls back to the offline screen',
      /Kakak sedang offline|offline/i.test(await page.content()));
    // Admin must NOT be answered from the cache while offline.
    const adminOffline = await page.goto(BASE + '/admin', { waitUntil: 'load' }).catch(() => null);
    const adminBody = adminOffline ? await page.content() : '';
    check('Admin is never served from the offline cache',
      !/Kelola Booking|Overview — Admin|Pilih foto/i.test(adminBody), adminBody.slice(0, 80));
    await context.setOffline(false);

    /* ============================================================
       2. Notification centre (Tahap 4)
       ============================================================ */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    const bell = page.locator('.admin-bell');
    check('Topbar has a notification bell', await bell.count() === 1);
    const bellBadge = await page.locator('.admin-bell__badge').innerText().catch(() => '0');
    check('Bell shows an unread badge', Number(bellBadge) > 0, bellBadge);
    check('Sidebar exposes Notifikasi as a real link',
      await page.locator('[data-admin-nav] a[href$="/admin/notifications"]').count() === 1);

    await page.goto(`${BASE}/admin/notifications`, { waitUntil: 'domcontentloaded' });
    const notifText = await page.locator('.nt-list').innerText();
    check('Notifikasi page lists a new booking', /Booking baru: Klien Baru Uji/.test(notifText), notifText.slice(0, 160));
    check('Notifikasi page lists a recorded payment', /Pembayaran Rp\s?150\.000/.test(notifText));
    check('Notifikasi page lists the client photo picks', /Pilihan foto masuk: Klien Editing Uji/.test(notifText));
    check('Notifikasi page lists a passed selection deadline', /Deadline seleksi/i.test(notifText));
    check('Notifikasi page lists tomorrow\'s shoot', /Job besok: Klien Besok Uji/.test(notifText));
    const typeCount = await page.locator('.nt-item').count();
    check('Every notification has a working target link',
      (await page.locator('.nt-item__title').count()) === typeCount);

    const beforeRead = await page.locator('.admin-bell__badge').count();
    await Promise.all([
      page.waitForNavigation(),
      page.click('form[action$="/notifications/read"] button[type="submit"]')
    ]);
    const afterReadText = await page.locator('.nt-head').innerText();
    check('Marking all read clears the unread counter', /0 notifikasi belum dibaca/.test(afterReadText), afterReadText.replace(/\n/g, ' '));
    check('Unread badge disappears after mark-all-read',
      (await page.locator('.admin-bell__badge').count()) === 0, `was ${beforeRead}`);
    const unreadTab = await (await page.request.get(`${BASE}/admin/notifications?baca=belum`)).text();
    check('Unread filter is empty after marking read', !/Booking baru: Klien Baru Uji/.test(unreadTab));
    const typeTab = await page.goto(`${BASE}/admin/notifications?tipe=payment`, { waitUntil: 'domcontentloaded' });
    check('Type filter works', typeTab.status() === 200 && /Pembayaran/.test(await page.locator('.nt-list').innerText() || ''));
    check('Type filter excludes other types', !/Job besok/.test(await page.locator('.nt-list').innerText() || ''));

    /* ============================================================
       3. Editing queue (Tahap 5)
       ============================================================ */
    check('Sidebar exposes Antrean Editing as a real link',
      await page.locator('[data-admin-nav] a[href$="/admin/editing"]').count() === 1);
    await page.goto(`${BASE}/admin/editing`, { waitUntil: 'domcontentloaded' });
    // Revisi 2 (07): papan operasional = DUA kolom saja.
    check('Editing board has exactly 2 columns', await page.locator('.ed-col').count() === 2);
    const colNames = await page.locator('.ed-col__head h2').allInnerTexts();
    check('Columns are Antrean Editing / Selesai',
      colNames.join('|') === 'Antrean Editing|Selesai', colNames.join('|'));
    // Target OUR fixture booking by id — the owner's own queue jobs may also be on the board.
    const jobId = await (async () => {
      // Koneksi harus writable: job uji kita geser ke posisi #1 (lihat catatan di bawah).
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'));
      const row = d.prepare("SELECT id FROM editing_jobs WHERE booking_id = ? AND status = 'queued' ORDER BY id DESC LIMIT 1").get(fx.editingBooking);
      // Jadikan job uji ini urutan #1 di antrean (posisi dihitung dari kolom position)
      // supaya aturan "Proses Editing aktif saat posisi #1" bisa diuji tanpa menyentuh
      // job milik pemilik yang mungkin sudah ada di salinan DB ini.
      if (row) d.prepare('UPDATE editing_jobs SET position = -1 WHERE id = ?').run(row.id);
      d.close();
      return row ? String(row.id) : null;
    })();
    check('The queue job belongs to the test booking', Boolean(jobId), String(jobId));
    const queuedCards = await page.locator('.ed-col[data-col="active"] .ed-card').count();
    check('A submitted selection landed in "Antrean Editing" automatically',
      await page.locator(`.ed-card[data-job-id="${jobId}"]`).count() === 1,
      `cards=${queuedCards}`);
    // Revisi 2: tidak ada drag antar kolom; setiap kartu antrean punya tombol SELESAI.
    check('Every queue card has a SELESAI button',
      await page.locator('.ed-col[data-col="active"] .ed-card .admin-btn--finish').count() === queuedCards,
      `buttons vs cards`);
    const headCard = page.locator('.ed-col[data-col="active"] .ed-card').first();
    check('The first card in the queue shows that it is being edited',
      /Sedang diedit/i.test(await headCard.innerText()), (await headCard.innerText()).slice(0, 80));

    // Move the card through the API the drag handler uses.
    const csrf = await page.locator('[data-editing-board]').getAttribute('data-csrf');
    const move = async (status) => {
      const res = await page.request.post(`${BASE}/admin/editing/${jobId}/status`, {
        headers: { 'x-csrf-token': csrf, accept: 'application/json', 'content-type': 'application/json' },
        data: { status }
      });
      return { status: res.status(), body: await res.json().catch(() => ({})) };
    };
    const okMove = await move('editing');
    check('Stage "editing" is accepted by the server (koordinasi internal)', okMove.status === 200 && okMove.body.ok === true, JSON.stringify(okMove));
    const badMove = await move('shipped');
    check('An unknown stage is rejected', badMove.status === 422 && badMove.body.ok === false, JSON.stringify(badMove));
    const noCsrf = await page.request.post(`${BASE}/admin/editing/${jobId}/status`, {
      headers: { accept: 'application/json', 'content-type': 'application/json' }, data: { status: 'done' }
    });
    check('A move without a CSRF token is refused', noCsrf.status() === 403 || noCsrf.status() === 302, String(noCsrf.status()));

    const portalRow = await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const row = db.prepare('SELECT status FROM photo_selections WHERE id = ?').get(fx.portal);
      const job = db.prepare('SELECT * FROM editing_jobs WHERE id = ?').get(Number(jobId));
      const events = db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND kind = 'editing'").get(job.booking_id).n;
      db.close();
      return { status: row.status, job, events };
    })();
    check('Client-facing portal status mirrors "Diedit" (Sedang Diproses)',
      portalRow.status === 'processing', portalRow.status);
    check('An internal note field exists but is not exposed to the client view', Object.prototype.hasOwnProperty.call(portalRow.job, 'note'));
    check('Queue moves are recorded in the booking activity log', portalRow.events >= 1, String(portalRow.events));

    // Job form: editor + target date + internal note.
    await page.goto(`${BASE}/admin/editing`, { waitUntil: 'domcontentloaded' });
    const card = page.locator(`.ed-card[data-job-id="${jobId}"]`);
    await card.locator('details.ed-card__more summary').click();
    await card.locator('input[name="due_at"]').fill('2026-12-01');
    await card.locator('textarea[name="note"]').fill('Catatan internal uji — jangan tampil ke klien');
    // Scope ke form "Atur job": tombol pertama di kartu sekarang SELESAI.
    await Promise.all([page.waitForNavigation(), card.locator('.ed-card__form button[type="submit"]').first().click()]);
    const savedNote = await page.locator(`.ed-card[data-job-id="${jobId}"] textarea[name="note"]`).inputValue();
    check('Editor/target/note are saved on the job', savedNote.includes('Catatan internal uji'), savedNote);

    // Client portal shows the stage, never the internal note.
    // Own browser INSTANCE: this platform allows only one open tab per instance.
    const clientBrowser = await chromium.launch();
    const clientContext = await clientBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const portalPage = await clientContext.newPage();
    const token = fx.portalToken;
    await portalPage.goto(`${BASE}/selection/${token}`, { waitUntil: 'load' });
    const portalBody = await portalPage.content();
    check('Client portal shows the editing status', /Status editing/i.test(portalBody));
    check('Client portal shows the 3-stage strip even before any move',
      await portalPage.locator('.sel-edit__step').count() === 3);
    check('Client portal shows the stage label ("Diedit")', /sel-edit__label[^>]*>Diedit/.test(portalBody));
    check('Client portal shows the 3-stage progress strip', await portalPage.locator('.sel-edit__step').count() === 3);
    check('Internal editing note never reaches the client portal',
      !/Catatan internal uji/.test(portalBody));
    check('Internal target date never reaches the client portal', !/2026-12-01/.test(portalBody));
    check('Client portal defines no editing admin controls', await portalPage.locator('.ed-card, [data-editing-board]').count() === 0);

    // Revisi 2 (07): tombol SELESAI WAJIB gagal bila link Google Drive belum valid.
    // Fixture ini tidak punya folder Drive, jadi tidak ada panggilan ke Google sama sekali.
    const finishNoDrive = await page.request.post(`${BASE}/admin/editing/${jobId}/finish`, {
      form: { _csrf: csrf }, maxRedirects: 0
    });
    const noDriveLoc = String(finishNoDrive.headers().location || '');
    check('SELESAI ditolak saat link Google Drive belum valid',
      finishNoDrive.status() === 302 && /err=/.test(noDriveLoc)
      && /belum punya folder Google Drive/i.test(decodeURIComponent(noDriveLoc).replace(/\+/g, ' ')), noDriveLoc);
    const stillActive = await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const job = db.prepare('SELECT status FROM editing_jobs WHERE id = ?').get(Number(jobId));
      const booking = db.prepare('SELECT final_url FROM bookings WHERE id = ?').get(fx.editingBooking);
      db.close();
      return { job: job.status, final: booking.final_url || '' };
    })();
    check('Order TIDAK ditandai selesai saat validasi Drive gagal',
      stillActive.job !== 'done' && stillActive.final === '', JSON.stringify(stillActive));

    // Setelah link final valid tersimpan (di sini disiapkan lewat DB; jalur validasi Drive
    // asli diuji di check-final-link.js dengan mock), job boleh diselesaikan.
    await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
      db.prepare("UPDATE bookings SET final_url = 'https://drive.google.com/drive/folders/UJI-T4T5', final_at = datetime('now') WHERE id = ?").run(fx.editingBooking);
      db.close();
    })();
    const finish = await move('done');
    check('Job bisa diselesaikan setelah link final valid', finish.status === 200 && finish.body.ok === true, JSON.stringify(finish));
    const afterDone = await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const row = db.prepare('SELECT status FROM photo_selections WHERE id = ?').get(fx.portal);
      const job = db.prepare('SELECT status, finished_at FROM editing_jobs WHERE id = ?').get(Number(jobId));
      db.close();
      return { portal: row.status, job };
    })();
    check('Portal status becomes "Selesai" when the job is done', afterDone.portal === 'done', afterDone.portal);
    check('Finished job records a completion timestamp', Boolean(afterDone.job.finished_at));
    await portalPage.goto(`${BASE}/selection/${token}`, { waitUntil: 'load' });
    check('Client sees "Selesai" on the portal', /sel-edit__label[^>]*>Selesai/.test(await portalPage.content()));

    // Manual enqueue from the booking detail page (idempotent).
    await page.goto(`${BASE}/admin/bookings/${fx.tomorrow}?tab=workflow`, { waitUntil: 'domcontentloaded' });
    // Admin labels are uppercased by CSS, so match case-insensitively.
    check('Booking detail shows a real editing status row',
      /status editing/i.test(await page.locator('#workflow').innerText()));
    await Promise.all([
      page.waitForNavigation(),
      page.click(`form[action$="/admin/bookings/${fx.tomorrow}/editing"] button`)
    ]);
    const queuedMsg = await page.locator('.admin-flash').first().innerText();
    check('A booking can be queued manually', /antrean editing/i.test(queuedMsg), queuedMsg);
    // The button is replaced by "Buka antrean" once a job exists…
    check('After queueing, the button becomes a link to the queue',
      await page.locator(`form[action$="/admin/bookings/${fx.tomorrow}/editing"]`).count() === 0
      && /buka antrean/i.test(await page.locator('#workflow').innerText()));
    // …and POSTing the same action again (old tab, double click) is a no-op with a message.
    const csrfToken = await page.locator('input[name="_csrf"]').first().inputValue();
    const dupRes = await page.request.post(`${BASE}/admin/bookings/${fx.tomorrow}/editing`, {
      form: { _csrf: csrfToken }, maxRedirects: 0
    });
    check('A repeated queue request is handled (redirect with a message), not duplicated',
      dupRes.status() === 302 && /msg=editing-already/.test(dupRes.headers().location || ''),
      `${dupRes.status()} ${dupRes.headers().location || ''}`);
    const activeCount = await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const n = db.prepare("SELECT COUNT(*) AS n FROM editing_jobs WHERE booking_id = ? AND status IN ('queued','editing')").get(fx.tomorrow).n;
      db.close();
      return n;
    })();
    check('Exactly one active job per booking survives a double click', activeCount === 1, String(activeCount));

    // Deleting a job removes it from the queue and the portal falls back to the honest
    // "waiting to be queued" card (no invented stage).
    const deleteRes = await page.request.post(`${BASE}/admin/editing/${jobId}/delete`, {
      form: { _csrf: csrfToken }, maxRedirects: 0
    });
    check('A job can be removed from the queue', deleteRes.status() === 302, String(deleteRes.status()));
    await portalPage.goto(`${BASE}/selection/${token}`, { waitUntil: 'load' });
    const afterDelete = await portalPage.content();
    check('Without a job the portal says it is waiting to be queued',
      /Menunggu masuk antrean/.test(afterDelete));
    check('The progress strip is still shown with no stage active',
      (await portalPage.locator('.sel-edit__step').count()) === 3
      && (await portalPage.locator('.sel-edit__step.is-current').count()) === 0);
    const jobsLeft = await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const n = db.prepare('SELECT COUNT(*) AS n FROM editing_jobs WHERE id = ?').get(Number(jobId)).n;
      const picks = db.prepare('SELECT COUNT(*) AS n FROM photo_selection_picks WHERE portal_id = ?').get(fx.portal).n;
      db.close();
      return { n, picks };
    })();
    check('Deleting a job keeps the client photo picks', jobsLeft.n === 0 && jobsLeft.picks === 1, JSON.stringify(jobsLeft));
    await clientContext.close();
    await clientBrowser.close();

    /* ---------------- mobile ---------------- */
    // Again a separate instance; the desktop page above stays open for its own checks.
    const mobileBrowser = await chromium.launch();
    const mobileContext = await mobileBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const m = await mobileContext.newPage();
    await m.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await m.fill('input[name="username"]', USER);
    await m.fill('input[name="password"]', PASS);
    await Promise.all([m.waitForNavigation(), m.click('button[type="submit"]')]);
    for (const url of ['/admin/notifications', '/admin/editing']) {
      await m.goto(BASE + url, { waitUntil: 'load' });
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`Mobile ${url} has no horizontal overflow`, overflow <= 0, `${overflow}px`);
    }
    const mobileBell = await m.locator('.admin-bell').isVisible();
    check('Notification bell is reachable on mobile', mobileBell);
    await mobileContext.close();
    await mobileBrowser.close();

    check('No JavaScript errors across the tested pages', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
    await context.close();
  } finally {
    await browser.close();
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });

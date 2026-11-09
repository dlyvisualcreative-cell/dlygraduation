'use strict';

/**
 * Tahap 6 end-to-end check on a COPY of the production database.
 *
 * Covers what the automated suites cannot: the real boot migrations (portfolio slug,
 * push tables, typography), every new public page, and the Web Push admin API with a
 * fake subscription (the last hop to Google/Apple is the only part that needs a physical
 * device).
 *
 *   node scripts/check-t6-live-copy.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 4537);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-e2e6';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const ck = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${label}`); }
  else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try {
    fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true });
  } catch (err) { /* cold cache */ }

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    // PUBLIC_CACHE_MS=0: suite ini menulis konten publik LANGSUNG ke DB, jadi mikro-cache
    // halaman publik dimatikan agar hasilnya deterministik (cache diuji terpisah oleh
    // .testrun/verify-publiccache.js).
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1', PUBLIC_CACHE_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }

    /* ---------------- migrations on the real data ---------------- */
    const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const cols = db.prepare('PRAGMA table_info(portfolio)').all().map((c) => c.name);
    const slugs = db.prepare('SELECT slug, client_name FROM portfolio WHERE is_active = 1').all();
    const vapid = db.prepare("SELECT value FROM settings WHERE key = 'push_vapid_public'").get();
    const fonts = db.prepare("SELECT live_value FROM site_content WHERE key LIKE 'appearance.font%'").all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const bookingCount = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
    const photoCount = db.prepare('SELECT COUNT(*) AS n FROM photo_selection_photos').get().n;
    const pickCount = db.prepare('SELECT COUNT(*) AS n FROM photo_selection_picks').get().n;
    const prices = db.prepare('SELECT package_id, duration_minutes, price FROM package_durations WHERE price IS NOT NULL ORDER BY package_id, duration_minutes').all();
    db.close();

    ck('portfolio.slug + session_time columns were added', cols.includes('slug') && cols.includes('session_time'));
    ck('Every published portfolio got a slug', slugs.length > 0 && slugs.every((s) => /^[a-z0-9-]+$/.test(s.slug || '')),
      slugs.map((s) => s.slug).join(', '));
    ck('Push tables exist', tables.includes('push_subscriptions') && tables.includes('push_log'));
    ck('A VAPID public key was generated', Boolean(vapid && /^[A-Za-z0-9_-]{87}$/.test(vapid.value)), vapid && String(vapid.value.length));
    // Tipografi adalah PILIHAN PEMILIK (bisa diubah kapan saja dari Warna & Font).
    // Yang diuji: nilainya valid & berasal dari daftar font yang tersedia.
    const schema = require(path.join(APP, 'src', 'content-schema.js'));
    const validFonts = schema.FONT_OPTIONS.map((f) => f.value);
    ck('Typography settings point at fonts that exist in FONT_OPTIONS',
      fonts.length === 2 && fonts.every((f) => validFonts.includes(f.live_value)),
      fonts.map((f) => f.live_value).join(' + '));
    // Data-aware: jumlah durasi berharga bisa berubah saat pemilik menambah paket.
    ck('Existing data is intact (booking / photos / picks / prices)',
      bookingCount >= 1 && photoCount >= 45 && pickCount >= 40 && prices.length >= 1,
      `b=${bookingCount} p=${photoCount} k=${pickCount} prices=${prices.length}`);

    /* ---------------- public pages ---------------- */
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    for (const url of ['/', '/pricelist', '/gallery', `/portfolio/${slugs[0].slug}`, '/booking', '/sitemap.xml', '/manifest.webmanifest', '/sw.js', '/offline', '/admin/login']) {
      const res = await page.goto(BASE + url, { waitUntil: 'load' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ck(`${url} → ${res.status()} without horizontal overflow`, res.status() === 200 && overflow <= 0, `${res.status()} / ${overflow}px`);
    }

    const fontsLoaded = await page.goto(BASE + '/', { waitUntil: 'load' }).then(() => page.evaluate(async () => {
      await document.fonts.ready;
      return Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family);
    }));
    // Font self-hosted hanya dipakai bila pemilik memilihnya; kalau bukan, Google Fonts
    // yang dimuat. Yang penting: font yang DIPILIH benar-benar aktif di browser.
    const chosen = fonts.map((f) => f.live_value);
    const selfHosted = chosen.includes('Fraunces') || chosen.includes('Instrument Sans');
    ck(selfHosted ? 'Font self-hosted yang dipilih termuat' : 'Font pilihan pemilik termuat di browser',
      chosen.every((name) => fontsLoaded.some((f) => f.toLowerCase().includes(name.split(' ')[0].toLowerCase()))),
      `dipilih: ${chosen.join(' + ')} · termuat: ${fontsLoaded.join(', ')}`);

    /* ---------------- web push admin API ---------------- */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    const pushPage = await page.goto(`${BASE}/admin/push`, { waitUntil: 'load' });
    ck('The push settings page loads', pushPage.status() === 200);
    ck('It explains the iPhone Home Screen requirement', /Layar Utama/.test(await page.locator('.push-guide').innerText()));
    const csrf = await page.locator('[data-push-enable]').getAttribute('data-csrf');
    ck('The page exposes the VAPID key to the client', (await page.locator('[data-push-enable]').getAttribute('data-key')).length === 87);
    ck('Permission is NOT requested on load',
      await page.evaluate(() => window.__notifPrompted !== true));

    // The owner may already have devices connected in the real database (they do). All
    // assertions below are relative to that baseline instead of assuming an empty list.
    const baseline = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const n = d.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;
      d.close();
      return Number(n) || 0;
    })();
    console.log(`    [info] perangkat sudah terhubung di salinan DB: ${baseline}`);

    const sub = {
      endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/fake-endpoint-t6',
      keys: {
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
        auth: 'tBHItJI5svbpez7KI4CCXg'
      }
    };
    const r1 = await page.request.post(`${BASE}/admin/push/subscribe`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json', accept: 'application/json' },
      data: JSON.stringify({ subscription: sub, platform: 'Android', label: 'Uji Android' })
    });
    ck('A subscription can be stored from the page', r1.status() === 200 && (await r1.json()).ok === true, String(r1.status()));
    const r1b = await page.request.post(`${BASE}/admin/push/subscribe`, {
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json', accept: 'application/json' },
      data: JSON.stringify({ subscription: sub, platform: 'Android' })
    });
    ck('Re-subscribing is idempotent', (await r1b.json()).created === false);

    await page.goto(`${BASE}/admin/push`, { waitUntil: 'load' });
    ck('The device appears in the list', await page.locator('.push-device').count() === baseline + 1,
      `${await page.locator('.push-device').count()} (baseline ${baseline})`);
    ck('The device list offers a delete control', await page.locator('form[action$="/delete"]').count() >= 1);

    const r2 = await page.request.post(`${BASE}/admin/push/test`, { form: { _csrf: csrf }, maxRedirects: 0 });
    ck('A test send is attempted and reported honestly', r2.status() === 302, String(r2.status()));
    const db2 = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const dev = db2.prepare('SELECT * FROM push_subscriptions WHERE endpoint LIKE ?').get('%fake-endpoint-t6%');
    db2.close();
    ck('A failed delivery is recorded on the device (not silently dropped)',
      Boolean(dev && dev.last_error), dev && dev.last_error);

    const r3 = await page.request.post(`${BASE}/admin/push/settings`, {
      form: {
        _csrf: csrf, push_enabled: '1', push_type_booking: '1', push_type_payment: '1',
        push_type_selection: '1', push_type_deadline: '1', push_type_job: '1', push_vapid_subject: 'mailto:test@example.com'
      },
      maxRedirects: 0
    });
    ck('Notification settings save', r3.status() === 302, String(r3.status()));

    const r4 = await page.request.post(`${BASE}/admin/push/devices/${dev.id}/delete`, { form: { _csrf: csrf }, maxRedirects: 0 });
    ck('A device can be deleted', r4.status() === 302);
    const db3 = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
    const left = db3.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;
    const gone = db3.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE ?').get('%fake-endpoint-t6%').n;
    db3.close();
    ck('The device row is gone', Number(gone) === 0 && Number(left) === baseline, `${gone} fake / ${left} total (baseline ${baseline})`);

    ck('No JavaScript errors on the checked pages', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  } finally {
    await browser.close();
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

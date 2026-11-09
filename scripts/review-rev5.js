'use strict';

/**
 * Screenshot Revisi 5 → public/review-rev5/
 *   node scripts/review-rev5.js
 *
 * Data dari SALINAN database + mock (lingkungan uji). Halaman portal hanya menampilkan
 * kartu status/tagihan — tidak ada foto atau identitas klien asli.
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.RV5_PORT || 4671);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'dly-rev5-shots');
const OUT = path.join(APP, 'public', 'review-rev5');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [];

const wibAt = (m) => {
  const w = new Date(Date.now() + 7 * 3600e3 + m * 60e3);
  return { date: w.toISOString().slice(0, 10), time: w.toISOString().slice(11, 16) };
};
const wibDatePlus = (d) => new Date(Date.now() + 7 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'preview-cache'), path.join(DATA_DIR, 'preview-cache'), { recursive: true }); } catch (e) { /* opsional */ }

  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const stamp = Date.now().toString().slice(-5);
  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages ORDER BY id LIMIT 1').get();
  db.prepare(`UPDATE package_durations SET price = CASE duration_minutes
      WHEN 60 THEN 400000 WHEN 90 THEN 525000 WHEN 120 THEN 725000 ELSE COALESCE(NULLIF(price,0), 400000) END
      WHERE package_id = ?`).run(pkg.id);
  const insDur = db.prepare(`INSERT OR IGNORE INTO package_durations
      (package_id, duration_minutes, price, description, is_active, sort_order, edited_photos)
      VALUES (?, ?, ?, '', 1, 0, ?)`);
  insDur.run(pkg.id, 90, 525000, 40);
  insDur.run(pkg.id, 120, 725000, 50);
  [['extra_time_30_price', '150000'], ['extra_time_60_price', '275000'],
    ['payment_bank_name', 'BCA'], ['payment_account_number', '7495326721'],
    ['payment_account_holder', 'Muhammad Fadhli']]
    .forEach(([k, v]) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v));

  const ins = db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date,
     shooting_time, location, package_id, category_id, duration, duration_minutes, price,
     package_price_snapshot, total_price_snapshot, status, terms_consent, portal_pin,
     created_at, confirmed_at)
    VALUES (?, ?, ?, '6281200000009', 'demo.rev5', 'Universitas Demo', ?, ?, ?, 'Gedung Serbaguna',
            ?, ?, ?, ?, 400000, 400000, 550000, 'confirmed', 1, '1357', datetime('now'), datetime('now'))`);
  const used = new Set();
  const make = (name, date, time, minutes) => {
    const slug = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8) || 'DEMO';
    let n = 1;
    while (used.has(`DLY-WISUDA-${slug}${String(n).padStart(3, '0')}`)) n += 1;
    const code = `DLY-WISUDA-${slug}${String(n).padStart(3, '0')}`;
    used.add(code);
    return Number(ins.run(code, `tok-${stamp}-${code.slice(-6)}-${minutes}`, name,
      city.id, date, time, pkg.id, pkg.category_id, minutes, minutes).lastInsertRowid);
  };

  const runAt = wibAt(-5);
  const runningId = make('Demo Sesi Berjalan', runAt.date, runAt.time, 60);
  const waitId = make('Demo Menunggu Sesi', wibDatePlus(20), '09:00', 60);
  const endedAt = wibAt(-70);
  const endedId = make('Demo Sesi Selesai', endedAt.date, endedAt.time, 60);
  db.prepare(`INSERT INTO booking_payments (booking_id, amount, method, note, paid_at, created_at)
              VALUES (?, 100000, 'transfer', 'DP demo', datetime('now'), datetime('now'))`).run(waitId);
  db.prepare(`INSERT INTO addons (name, slug, description, price, applies_to, is_active, sort_order)
              VALUES ('Fish Eye Demo', ?, 'Lensa tambahan sudut lebar', 100000, 'all', 1, 0)`)
    .run(`fisheye-${stamp}`);
  const codeOf = (id) => db.prepare('SELECT code FROM bookings WHERE id = ?').get(id).code;
  const out = { runningCode: codeOf(runningId), waitCode: codeOf(waitId), endedCode: codeOf(endedId) };
  db.close();
  return out;
}

async function shot(page, file, label, opts = {}) {
  await sleep(opts.wait || 500);
  const target = path.join(OUT, file);
  if (typeof opts.clip === 'string') await page.locator(opts.clip).first().screenshot({ path: target });
  else await page.screenshot({ path: target, fullPage: Boolean(opts.full) });
  SHOTS.push({ file, label });
  console.log('shot', file);
}

(async () => {
  const fx = prepare();
  fs.mkdirSync(OUT, { recursive: true });

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1' },
    stdio: 'ignore'
  });
  const cleanup = () => { try { app.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 140; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const b2 = await chromium.launch();
    const client = await b2.newPage({ viewport: { width: 1280, height: 1000 } });
    const login = async (code) => {
      await client.request.post(`${BASE}/portal/keluar`, { maxRedirects: 0 }).catch(() => {});
      await client.context().clearCookies().catch(() => {});
      await client.goto(`${BASE}/portal`, { waitUntil: 'load' });
      await client.fill('input[name="code"]', code);
      await client.fill('input[name="pin"]', '1357');
      await Promise.all([client.waitForNavigation().catch(() => {}), client.click('button[type="submit"]')]);
    };

    /* 1. Tahap sesi: "Sesi foto dimulai" + badge kedap-kedip */
    await login(fx.runningCode);
    await client.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    await shot(client, '01-pantau-order-sesi-dimulai.png', 'Pantau Order: “Sesi foto dimulai” (badge berjalan)', { clip: '.cp-card' });

    /* 2. Tahap sesi selesai */
    await login(fx.endedCode);
    await client.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    await shot(client, '02-pantau-order-sesi-selesai.png', 'Pantau Order: “Sesimu sudah selesai”', { clip: '.cp-card' });

    /* 3. Menunggu sesi + kotak tagihan + rekening */
    await login(fx.waitCode);
    await client.goto(`${BASE}/portal/ringkasan`, { waitUntil: 'load' });
    await shot(client, '03-ringkasan-tagihan.png', 'Ringkasan: total / sudah dibayar / belum dibayar + catatan rekening', { full: true });

    /* 4. Upgrade paket gaya pricelist */
    await client.goto(`${BASE}/portal/upgrade`, { waitUntil: 'load' });
    await shot(client, '04-upgrade-pricelist.png', 'Upgrade Paket: kartu gaya pricelist, downgrade dikunci', { full: true });

    /* 5. Ringkasan paket (dengan add-on & extra time) */
    await shot(client, '05-ringkasan-paket-sekarang.png', 'Ringkasan “Paket kamu sekarang”', { clip: '.cp-up__now' });

    /* 6. Panel keamanan di admin */
    const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await admin.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await admin.fill('input[name="username"]', 'admin');
    await admin.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([admin.waitForNavigation().catch(() => {}), admin.click('button[type="submit"]')]);
    await admin.goto(`${BASE}/admin/settings`, { waitUntil: 'load' });
    await shot(admin, '06-panel-keamanan.png', 'Pengaturan Admin: panel Keamanan Website', { full: true });
    await b2.close();
  } finally {
    await browser.close().catch(() => {});
    cleanup();
  }

  const cards = SHOTS.map((s) => `      <figure><img src="${s.file}" alt="${s.label}" loading="lazy"><figcaption>${s.label}</figcaption></figure>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revisi 5 — tangkapan layar</title>
<style>
  body{margin:0;padding:32px 20px 60px;background:#F3F0FF;color:#1F1B3A;font-family:Inter,system-ui,sans-serif}
  h1{font-size:1.4rem;margin:0 0 6px}p.lead{margin:0 0 24px;color:#635F82;font-size:.9rem}
  .grid{display:grid;gap:22px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
  figure{margin:0;background:#fff;border:1px solid #E4E0F5;border-radius:16px;overflow:hidden;box-shadow:0 10px 24px rgba(31,27,58,.06)}
  img{display:block;width:100%;height:auto}
  figcaption{padding:12px 14px;font-size:.82rem;color:#4A4568}
</style></head>
<body>
  <h1>Revisi 5 — tangkapan layar</h1>
  <p class="lead">Diambil dari salinan database + data contoh (lingkungan uji), bukan data klien asli.</p>
  <div class="grid">
${cards}
  </div>
</body></html>`);

  console.log(`\n${SHOTS.length} gambar → public/review-rev5/index.html`);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => { console.error(err); process.exit(1); });

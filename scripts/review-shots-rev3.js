'use strict';

/**
 * Screenshot hasil revisi 11–18 → public/review-revisi-3/
 *   node scripts/review-shots-rev3.js
 *
 * Semua gambar diambil dari SALINAN database (/tmp). Untuk halaman portal, yang
 * ditangkap hanya kartu status/timeline (tanpa identitas client).
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.RV3_PORT || 4691);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-rev3-shots';
const OUT = path.join(APP, 'public', 'review-revisi-3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [];

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  db.prepare("UPDATE bookings SET portal_pin = '1357', portal_pin_hash = NULL WHERE id = 13").run();
  const past = new Date(Date.now() + 7 * 3600 * 1000 - 6 * 60 * 1000);
  const date = `${past.getUTCFullYear()}-${String(past.getUTCMonth() + 1).padStart(2, '0')}-${String(past.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(past.getUTCHours()).padStart(2, '0')}:${String(past.getUTCMinutes()).padStart(2, '0')}`;
  db.prepare('UPDATE bookings SET shooting_date = ?, shooting_time = ? WHERE id = 13').run(date, time);
  db.prepare("DELETE FROM booking_timeline WHERE booking_id = 13 AND stage = 'session_done'").run();
  const code = (db.prepare('SELECT code FROM bookings WHERE id = 13').get() || {}).code || '';
  db.close();
  return code;
}

async function shot(page, file, label, opts = {}) {
  await sleep(opts.wait || 500);
  const target = path.join(OUT, file);
  if (opts.clip && typeof opts.clip === 'string') await page.locator(opts.clip).screenshot({ path: target });
  else if (opts.clip) await page.screenshot({ path: target, clip: opts.clip });
  else await page.screenshot({ path: target, fullPage: Boolean(opts.full) });
  SHOTS.push({ file, label, group: opts.group || 'Lainnya' });
  console.log('shot', file);
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const code = prepare();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  try {
    for (let i = 0; i < 160; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }

    const d = await chromium.launch();
    const desk = await d.newPage({ viewport: { width: 1440, height: 1000 } });
    await desk.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    await sleep(900);
    await shot(desk, '01-gallery-desktop.png', 'Gallery publik = grid 3 kolom dengan overlay nama/kampus/tanggal', { group: 'Gallery' });
    // Revisi 2 (04/05): dropdown navigasi Lokasi & Paket DIHAPUS; filter pindah ke Gallery.
    await shot(desk, '02-nav-utama.png', 'Navigasi utama tanpa menu Lokasi & Paket (Home, Gallery, Pricelist, Cara Order, Ulasan, S&K)', { group: 'Navigasi', clip: { x: 0, y: 0, width: 1440, height: 180 } });
    await desk.evaluate(() => {
      const s = document.querySelector('select[name="paket"]');
      if (s) { s.value = s.options[1] ? s.options[1].value : ''; s.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await sleep(900);
    await shot(desk, '03-filter-gallery.png', 'Gallery: filter dropdown Paket + Lokasi (bisa digabung)', { group: 'Navigasi', clip: { x: 0, y: 0, width: 1440, height: 460 } });
    await desk.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await desk.goto(`${BASE}/paket/individual`, { waitUntil: 'load' });
    await shot(desk, '04-paket-desktop.png', 'Judul + badge jumlah sesi sejajar, harga Bold', { group: 'Paket' });
    await desk.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await shot(desk, '05-login-desktop.png', 'Login Client Portal memakai logo resmi (warna menyesuaikan latar)', { group: 'Client Portal' });
    await d.close();

    const m = await chromium.launch();
    const mob = await m.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await mob.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    await sleep(700);
    await shot(mob, '06-gallery-mobile.png', 'Mobile: satu kartu per baris, menyusun ke bawah', { group: 'Gallery' });
    await mob.goto(`${BASE}/portfolio/nabila-puspita`, { waitUntil: 'load' });
    await sleep(700);
    await mob.locator('.pf-others').scrollIntoViewIfNeeded();
    await sleep(400);
    await shot(mob, '07-portfolio-klien-lain-mobile.png', '"Portfolio klien lain" mobile = carousel satu kartu', { group: 'Gallery' });
    await mob.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await shot(mob, '08-login-mobile.png', 'Login Client Portal (mobile)', { group: 'Client Portal' });

    await mob.fill('input[name="code"]', code);
    await mob.fill('input[name="pin"]', '1357');
    await Promise.all([mob.waitForNavigation(), mob.click('.cp-login__btn')]);
    await sleep(700);
    await shot(mob, '09-status-order-mobile.png', 'Kartu status: tahap 03 otomatis + badge dot hijau + pengingat', { group: 'Status', clip: '.cp-card--status' });
    await mob.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    await sleep(700);
    await shot(mob, '10-timeline-mobile.png', 'Timeline: centang untuk tahap selesai, glow hanya tahap aktif', { group: 'Status', clip: '.cp-card' });
    await m.close();
  } finally {
    app.kill();
  }

  const groups = ['Gallery', 'Navigasi', 'Paket', 'Client Portal', 'Status'];
  const labelFor = (f) => (SHOTS.find((s) => s.file === f) || {}).label || f;
  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DLY Graduation — Revisi Gallery, Portal & Status</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body{margin:0;padding:30px 18px 70px;background:#F7F6F2;color:#252A30;font:15px/1.6 Inter,system-ui,sans-serif}
  .wrap{max-width:1240px;margin:0 auto}
  h1{font-size:clamp(1.6rem,3.6vw,2.3rem);color:#0B2340;margin:6px 0 8px}
  .eyebrow{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:#2C5E73}
  p.lede{color:#5F6B7A;max-width:820px}
  h2{font-size:1.05rem;color:#0B2340;margin:32px 0 14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px}
  figure{margin:0;background:#fff;border:1px solid #E3E5E7;border-radius:16px;overflow:hidden;
         box-shadow:0 2px 6px rgba(11,35,64,.05),0 16px 34px rgba(11,35,64,.07)}
  figure a{display:block}
  figure img{display:block;width:100%;height:auto;max-height:620px;object-fit:cover;object-position:top}
  figcaption{padding:11px 14px;font-size:.8rem;display:flex;justify-content:space-between;gap:10px}
  .note{margin-top:28px;padding:14px 16px;border:1px dashed #C9CDD1;border-radius:12px;color:#5F6B7A;font-size:.82rem}
</style></head><body><div class="wrap">
<header>
  <span class="eyebrow">DLY Graduation · Revisi Lanjutan</span>
  <h1>Gallery Auto-Slider, Logo Portal &amp; Status Sesi Real-time</h1>
  <p class="lede">Hasil revisi 11–18: gallery menjadi satu jalur horizontal dengan overlay nama
  client, kartu portfolio klien lain satu per slide di HP, badge jumlah sesi sejajar judul
  dengan soft blue glow, harga panel “Harga” setebal sticky bar, logo resmi di login, serta
  tahap “Sesi Pemotretan Dimulai” yang aktif otomatis tepat pada jam sesi.</p>
</header>
${groups.map((g) => {
  const files = SHOTS.filter((s) => s.group === g).map((s) => s.file);
  if (!files.length) return '';
  return `<h2>${g}</h2><div class="grid">
${files.map((f) => `<figure><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="${labelFor(f)}" loading="lazy"></a>
<figcaption><span>${labelFor(f)}</span><a href="${f}" target="_blank" rel="noopener">Buka</a></figcaption></figure>`).join('\n')}
</div>`;
}).join('\n')}
<div class="note">Halaman review ini hanya untuk pemeriksaan hasil revisi dan boleh dihapus kapan saja.
Screenshot portal hanya menampilkan kartu status/timeline (tanpa identitas client).</div>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\nReview page: ${path.relative(APP, path.join(OUT, 'index.html'))}`);
})().catch((e) => { console.error(e); process.exit(1); });

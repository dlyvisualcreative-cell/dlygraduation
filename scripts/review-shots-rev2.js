'use strict';

/**
 * Screenshot revisi pack:
 *   notifikasi (push page: grup role + log) · carousel portfolio (mobile/desktop) ·
 *   hero · paket (judul+indikator sesi) · login Client Portal (mobile/desktop) ·
 *   ringkasan portal · booking time 24 jam
 *
 *   node scripts/review-shots-rev2.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.RV2_PORT || 4670);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-rev2-shots';
const OUT = path.join(APP, 'public', process.env.REVIEW_REV2_OUT || 'review-revisi-2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [];

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) {}
}

function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const b = db.prepare('SELECT id, code FROM bookings ORDER BY id LIMIT 1').get();
  if (!b) { db.close(); return null; }
  db.prepare("UPDATE bookings SET portal_pin = '1357', portal_pin_hash = NULL WHERE id = ?").run(b.id);
  db.prepare("UPDATE photo_selections SET submitted_at = NULL, status = 'waiting', is_open = 1 WHERE booking_id = ?").run(b.id);
  db.close();
  return { code: b.code };
}

const shot = async (page, file, label, opts = {}) => {
  await sleep(opts.wait || 450);
  const target = path.join(OUT, file);
  if (opts.clip) await page.locator(opts.clip).screenshot({ path: target });
  else await page.screenshot({ path: target, fullPage: Boolean(opts.full) });
  SHOTS.push({ file, label });
  console.log('shot', file);
};

(async () => {
  prepare();
  fs.mkdirSync(OUT, { recursive: true });
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 120; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const fx = seed();

    /* ---------------- admin: push page ---------------- */
    const aB = await chromium.launch();
    const a = await aB.newPage({ viewport: { width: 1440, height: 1200 } });
    a.on('dialog', (d) => d.accept());
    await a.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await a.fill('input[name="username"]', 'admin');
    await a.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([a.waitForNavigation(), a.click('button[type="submit"]')]);
    await a.goto(`${BASE}/admin/push`, { waitUntil: 'load' });
    await shot(a, '01-push-settings.png', 'Notifikasi HP — grup per role + log pengiriman', { full: true, wait: 700 });
    await a.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    await aB.close();

    /* ---------------- public: hero, carousel, paket ---------------- */
    const dB = await chromium.launch();
    const d = await dB.newPage({ viewport: { width: 1440, height: 950 } });
    await d.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(1200);
    await shot(d, '02-hero.png', 'Hero — teks putih + tombol portofolio biru', { wait: 500 });
    await d.evaluate(() => document.querySelector('[data-pf-carousel]').scrollIntoView({ block: 'center' }));
    await sleep(1200);
    await shot(d, '03-carousel-desktop.png', 'Portfolio Highlights — carousel horizontal (desktop)', { wait: 500 });
    await d.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    await sleep(700);
    await shot(d, '04-paket.png', 'Pricelist — judul tebal, indikator sesi di samping judul', { full: true, wait: 600 });
    await d.goto(`${BASE}/booking`, { waitUntil: 'load' });
    await shot(d, '05-booking-24jam.png', 'Booking — jam 00:00–23:59', { wait: 500 });
    await dB.close();

    /* ---------------- mobile: carousel + login + portal ---------------- */
    const mB = await chromium.launch();
    const m = await mB.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await m.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(1000);
    await m.evaluate(() => document.querySelector('[data-pf-carousel]').scrollIntoView({ block: 'center' }));
    await sleep(1200);
    await shot(m, '10-carousel-mobile.png', 'Carousel portfolio — mobile (1 kartu + peek)', { wait: 400 });
    await m.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await shot(m, '11-login-mobile.png', 'Login Client Portal — mobile', { wait: 400 });
    if (fx) {
      await m.fill('input[name="code"]', fx.code);
      await m.fill('input[name="pin"]', '1357');
      await Promise.all([m.waitForNavigation(), m.click('.cp-login__btn')]);
      await shot(m, '12-portal-ringkasan-mobile.png', 'Ringkasan portal — mobile', { full: true, wait: 700 });
    }
    await mB.close();

    const dB2 = await chromium.launch();
    const d2 = await dB2.newPage({ viewport: { width: 1440, height: 950 } });
    await d2.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await shot(d2, '13-login-desktop.png', 'Login Client Portal — desktop (modal putih, latar gelap)', { wait: 500 });
    await dB2.close();
  } finally {
    await browser.close();
    app.kill();
  }

  const groups = [
    ['Notifikasi', ['01-push-settings.png']],
    ['Hero, portfolio, paket', ['02-hero.png', '03-carousel-desktop.png', '10-carousel-mobile.png', '04-paket.png']],
    ['Booking 24 jam', ['05-booking-24jam.png']],
    ['Client Portal', ['11-login-mobile.png', '13-login-desktop.png', '12-portal-ringkasan-mobile.png']]
  ];
  const labelFor = (f) => (SHOTS.find((s) => s.file === f) || {}).label || f;
  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DLY Graduation — Revisi Implementasi</title>
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
  figure img{display:block;width:100%;height:auto;max-height:560px;object-fit:cover;object-position:top}
  figcaption{padding:11px 14px;font-size:.8rem;display:flex;justify-content:space-between;gap:10px}
  .note{margin-top:28px;padding:14px 16px;border:1px dashed #C9CDD1;border-radius:12px;color:#5F6B7A;font-size:.82rem}
</style></head><body><div class="wrap">
<header>
  <span class="eyebrow">DLY Graduation · Revisi Implementasi</span>
  <h1>Notifikasi, Client Portal, Portfolio Carousel &amp; Tipografi</h1>
  <p class="lede">Hasil revisi: sumber notifikasi spontan diperbaiki (event_id + role + log),
  Client Portal responsif dengan login baru, booking 24 jam, portfolio menjadi carousel
  horizontal ber-overlay, serta hierarki tipografi yang lebih tegas.</p>
</header>
${groups.map(([t, files]) => `<h2>${t}</h2><div class="grid">
${files.map((f) => `<figure><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="${labelFor(f)}" loading="lazy"></a>
<figcaption><span>${labelFor(f)}</span><a href="${f}" target="_blank" rel="noopener">Buka</a></figcaption></figure>`).join('\n')}
</div>`).join('\n')}
<div class="note">Halaman review ini hanya untuk pemeriksaan dan boleh dihapus kapan saja.</div>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\nReview page: ${OUT}/index.html`);
})().catch((e) => { console.error(e); process.exit(1); });

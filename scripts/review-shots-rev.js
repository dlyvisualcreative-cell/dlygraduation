'use strict';

/**
 * Revisi (setelah Tahap 7) — screenshot hasil perubahan:
 *   - Antrean Editing tanpa pilihan editor, deadline otomatis 10 hari kerja
 *   - Workflow booking: satu dropdown tim + satu tombol Confirm Booking
 *   - Sidebar accordion tanpa celah kosong
 *   - Portal Seleksi: form buat portal, galeri bisa dilipat, tab Highlight, mode Swipe,
 *     bottom bar, status editing
 *
 * Database: SALINAN di /tmp. Klien tidak pernah melihat data booking lain.
 *
 *   node scripts/review-shots-rev.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.REV_PORT || 4570);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-rev';
const OUT = path.join(APP, 'public', process.env.REVIEW_REV_OUT || 'review-revisi');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [];

const prepare = () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) {}
};

/** Fixtures after boot (schema ready): a pending booking, an open portal, highlights. */
function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const city = db.prepare('SELECT id FROM cities LIMIT 1').get();
  const pkg = db.prepare('SELECT id, category_id FROM packages LIMIT 1').get();
  const member = db.prepare('SELECT id FROM team_members WHERE is_active = 1 ORDER BY sort_order LIMIT 1').get();

  // 1) booking pending (untuk screenshot tombol Confirm Booking)
  const pendingId = Number(db.prepare(`INSERT INTO bookings
    (code, access_token, client_name, client_phone, instagram, campus, city_id, shooting_date,
     shooting_time, location, package_id, category_id, duration, duration_minutes, price,
     package_price_snapshot, total_price_snapshot, status, terms_consent, created_at)
    VALUES ('DLY-REV-PENDING', 'tok-rev1', 'Vieke Melani', '6281200000001', 'vieke.melani', 'ITB',
            ?, '2026-11-20', '09:00', 'Gedung Sate, Bandung', ?, ?, 90, 90, 450000, 450000, 550000,
            'pending', 1, datetime('now'))`).run(city.id, pkg.id, pkg.category_id).lastInsertRowid);

  // 2) portal dengan banyak foto untuk client POV
  const portalId = db.prepare('SELECT p.id, p.token, (SELECT COUNT(*) FROM photo_selection_photos ph WHERE ph.portal_id = p.id) n FROM photo_selections p ORDER BY n DESC LIMIT 1').get()
    || null;
  if (portalId) {
    // quota kecil + tidak wajib penuh supaya modal konfirmasi bisa didemokan
    db.prepare("UPDATE photo_selections SET submitted_at = NULL, status = 'waiting', is_open = 1, quota = 8, require_full_quota = 0 WHERE id = ?").run(portalId.id);
    db.prepare('DELETE FROM photo_selection_picks WHERE portal_id = ?').run(portalId.id);
    db.prepare('UPDATE photo_selection_photos SET is_highlight = 0 WHERE portal_id = ?').run(portalId.id);
    db.prepare('SELECT id FROM photo_selection_photos WHERE portal_id = ? ORDER BY sort_order LIMIT 6').all(portalId.id)
      .forEach((r) => db.prepare('UPDATE photo_selection_photos SET is_highlight = 1 WHERE id = ?').run(r.id));
  }

  // 3) satu job editing dengan deadline otomatis
  db.prepare("DELETE FROM editing_jobs WHERE booking_id = ?").run(pendingId);
  db.close();
  return {
    pendingId,
    memberId: member ? member.id : 1,
    portal: portalId ? { id: portalId.id, token: portalId.token, photos: portalId.n } : null
  };
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
  let waSample = '';
  try {
    for (let i = 0; i < 120; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const fx = seed();

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'DlyGraduation2025');
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    /* -------- Antrean Editing: tanpa editor + deadline otomatis -------- */
    await page.goto(`${BASE}/admin/editing`, { waitUntil: 'load' });
    await shot(page, '01-antrean-editing.png', 'Antrean Editing — tanpa pilihan editor, tenggat otomatis', { full: true });

    /* -------- Workflow: satu dropdown + satu tombol -------- */
    await page.goto(`${BASE}/admin/bookings/${fx.pendingId}?tab=workflow`, { waitUntil: 'load' });
    await shot(page, '02-workflow-simple.png', 'Workflow booking — satu dropdown tim + Confirm Booking', { full: true });

    /* -------- Sidebar: grup tertutup tidak menyisakan celah -------- */
    await page.goto(`${BASE}/admin/bookings`, { waitUntil: 'load' });
    const heads = page.locator('[data-nav-group] [data-nav-toggle-group]');
    const n = await heads.count();
    for (let i = 0; i < n; i += 1) {
      const open = await page.locator('[data-nav-group]').nth(i).evaluate((el) => el.classList.contains('is-open'));
      if (open) await heads.nth(i).click();
    }
    await sleep(500);
    await page.locator('[data-side]').screenshot({ path: path.join(OUT, '03-sidebar-all-closed.png') });
    SHOTS.push({ file: '03-sidebar-all-closed.png', label: 'Sidebar — semua grup tertutup (tanpa celah kosong)' });
    await page.click('[data-nav-group="konten"] [data-nav-toggle-group]');
    await sleep(600);
    await page.locator('[data-side]').screenshot({ path: path.join(OUT, '04-sidebar-one-open.png') });
    SHOTS.push({ file: '04-sidebar-one-open.png', label: 'Sidebar — satu grup dibuka, menu di bawah turun' });

    /* -------- Buat Portal Seleksi Foto (redesign) -------- */
    await page.goto(`${BASE}/admin/bookings/${fx.pendingId}/portal`, { waitUntil: 'load' });
    await shot(page, '05-buat-portal.png', 'Buat Portal Seleksi Foto — form 4 bagian', { full: true });
    await page.click('[data-deadline-days="14"]');
    await shot(page, '06-buat-portal-deadline.png', 'Preset deadline (3/7/14/30 hari) berlaku', { clip: '.xx-card' });

    /* -------- Client POV -------- */
    if (fx.portal) {
      // 1 tab per instance: tutup halaman admin dulu.
      await page.close();
      const clientBrowser = await chromium.launch();
      const client = await clientBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
      await client.goto(`${BASE}/selection/${fx.portal.token}`, { waitUntil: 'load' });
      await sleep(1400);
      await shot(client, '10-client-desktop.png', 'Portal klien — desktop', { wait: 800 });
      // pick a few photos
      for (let i = 0; i < 4; i += 1) {
        const btn = client.locator('.sel-tile__pick').nth(i);
        if (await btn.count()) await btn.click({ force: true }).catch(() => {});
        await sleep(120);
      }
      await shot(client, '11-client-picked.png', 'Foto terpilih — border teal, centang, nomor urut', { wait: 500 });
      // fold the gallery
      await client.$eval('[data-sel-fold]', (el) => el.click());
      await sleep(500);
      await shot(client, '12-client-folded.png', 'Galeri dilipat (halaman terasa ringkas)', { wait: 300 });
      await client.$eval('[data-sel-fold]', (el) => el.click());
      await sleep(300);
      // highlight tab
      if (await client.locator('[data-filter="highlight"]').count()) {
        await client.$eval('[data-filter="highlight"]', (el) => el.click());
        await sleep(400);
        await shot(client, '13-client-highlight.png', 'Tab Highlight (foto pilihan admin)', { wait: 300 });
      }
      // picked tab
      await client.$eval('[data-filter="picked"]', (el) => el.click());
      await sleep(400);
      await shot(client, '14-client-terpilih.png', 'Tab Terpilih', { wait: 300 });
      // swipe mode
      await client.$eval('[data-filter="swipe"]', (el) => el.click());
      await sleep(700);
      await shot(client, '15-client-swipe.png', 'Mode Swipe — satu foto besar', { wait: 300 });
      // bottom bar + modal
      await client.$eval('[data-filter="all"]', (el) => el.click());
      await sleep(300);
      // "Lihat Pilihan" menyaring galeri; modal konfirmasi dibuka oleh "Kirim Pilihan".
      await client.$eval('[data-sel-view]', (el) => el.click());
      await sleep(500);
      await shot(client, '16-client-lihat-pilihan.png', 'Tombol "Lihat Pilihan" — hanya foto terpilih', { wait: 400 });
      await client.$eval('[data-sel-send]', (el) => el.click());
      await sleep(600);
      await shot(client, '17-client-modal.png', 'Konfirmasi "Kirim Pilihan" — daftar nama file', { wait: 400 });
      const waText = await client.$eval('[data-sel-modal-list]', (el) => el.textContent);
      waSample = String(waText || '').trim().split('\n').slice(0, 6).join('\n');
      await clientBrowser.close();

      // mobile
      const mobBrowser = await chromium.launch();
      const mob = await mobBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await mob.goto(`${BASE}/selection/${fx.portal.token}`, { waitUntil: 'load' });
      await sleep(1500);
      await shot(mob, '20-client-mobile.png', 'Portal klien — mobile (grid rapat)', { wait: 700 });
      await mob.$eval('[data-sel-fold]', (el) => el.click());
      await sleep(500);
      await shot(mob, '21-client-mobile-folded.png', 'Mobile — galeri dilipat', { wait: 300 });
      await mob.$eval('[data-sel-fold]', (el) => el.click());
      await sleep(300);
      for (let i = 0; i < 3; i += 1) {
        const btn = mob.locator('.sel-tile__pick').nth(i);
        if (await btn.count()) await btn.click({ force: true }).catch(() => {});
        await sleep(150);
      }
      await shot(mob, '22-client-mobile-bar.png', 'Mobile — bottom bar Lihat/Kirim Pilihan', { wait: 500 });
      await mobBrowser.close();
    }
  } finally {
    await browser.close();
    app.kill();
  }

  const groups = [
    ['Dashboard admin', ['01-antrean-editing.png', '02-workflow-simple.png', '03-sidebar-all-closed.png', '04-sidebar-one-open.png']],
    ['Buat Portal Seleksi Foto', ['05-buat-portal.png', '06-buat-portal-deadline.png']],
    ['Portal klien (desktop)', ['10-client-desktop.png', '11-client-picked.png', '12-client-folded.png', '13-client-highlight.png', '14-client-terpilih.png', '15-client-swipe.png', '16-client-lihat-pilihan.png', '17-client-modal.png']],
    ['Portal klien (mobile)', ['20-client-mobile.png', '21-client-mobile-folded.png', '22-client-mobile-bar.png']]
  ];
  const labelFor = (f) => (SHOTS.find((s) => s.file === f) || {}).label || f;
  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DLY Graduation — Review Revisi Portal Seleksi</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body { margin:0; padding:30px 18px 70px; background:#F7F6F2; color:#252A30; font:15px/1.6 Inter,system-ui,sans-serif; }
  .wrap { max-width:1240px; margin:0 auto; }
  h1 { font-size:clamp(1.6rem,3.6vw,2.3rem); color:#0B2340; margin:6px 0 8px; }
  .eyebrow { font-size:.62rem; letter-spacing:.2em; text-transform:uppercase; color:#2C5E73; }
  p.lede { color:#5F6B7A; max-width:780px; }
  h2 { font-size:1.05rem; color:#0B2340; margin:34px 0 14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:18px; }
  figure { margin:0; background:#fff; border:1px solid #E3E5E7; border-radius:16px; overflow:hidden;
           box-shadow:0 2px 6px rgba(11,35,64,.05),0 16px 34px rgba(11,35,64,.07); }
  figure img { display:block; width:100%; height:auto; max-height:540px; object-fit:cover; object-position:top; }
  figcaption { padding:11px 14px; font-size:.8rem; display:flex; justify-content:space-between; gap:10px; }
  pre { background:#0B2340; color:#E7EEF5; padding:16px; border-radius:12px; font-size:.78rem; line-height:1.6; overflow:auto; }
  .note { margin-top:30px; padding:14px 16px; border:1px dashed #C9CDD1; border-radius:12px; color:#5F6B7A; font-size:.82rem; }
</style></head><body><div class="wrap">
<header>
  <span class="eyebrow">DLY Graduation · Revisi</span>
  <h1>Portal Seleksi Foto &amp; Penyederhanaan Dashboard</h1>
  <p class="lede">Hasil revisi: editor dihapus dari antrean (deadline otomatis 10 hari kerja), tim satu orang
  lewat dropdown dengan satu tombol Confirm Booking, sidebar accordion tanpa celah, portal klien dengan
  galeri yang bisa dilipat, tab Highlight/Swipe, dan nama file WhatsApp tanpa nomor &amp; ekstensi.</p>
</header>
${groups.map(([t, files]) => `<h2>${t}</h2><div class="grid">
${files.map((f) => `<figure><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="${labelFor(f)}" loading="lazy"></a>
<figcaption><span>${labelFor(f)}</span><a href="${f}" target="_blank" rel="noopener">Buka</a></figcaption></figure>`).join('\n')}
</div>`).join('\n')}
${waSample ? `<h2>Contoh daftar nama file pada pesan WhatsApp</h2><pre>${waSample.replace(/</g, '&lt;')}</pre>` : ''}
<div class="note">Halaman review ini hanya untuk pemeriksaan dan boleh dihapus kapan saja.</div>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\nReview page: ${OUT}/index.html`);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';

/**
 * Revisi 11–18 acceptance suite (paket revisi "REVISI LAGI").
 *
 *   node scripts/check-rev3.js            → semua pemeriksaan (~2 menit)
 *   REV3_FAST=1 node scripts/check-rev3.js → lewati uji tunggu 1 menit (transisi real-time)
 *
 * Selalu memakai SALINAN database di /tmp; database produksi tidak disentuh.
 * Uji transisi memakai jam server + timestamp booking (Asia/Jakarta), bukan jam perangkat.
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.REV3_PORT || 4690);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = `/tmp/dly-rev3-${Date.now()}`;
const UNIT_DIR = `/tmp/dly-rev3-unit-${Date.now()}`;
const SLOW = process.env.REV3_FAST !== '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
function ck(label, ok, detail) {
  if (ok) { pass += 1; console.log('PASS  ' + label); }
  else { failures.push(label); console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

function copyDb(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.readdirSync(path.join(APP, 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(dir, f)));
}

/* ------------------------------------------------------------------ */
/* 1. Unit: transisi tahap 03 tepat pada jam sesi (idempoten)          */
/* ------------------------------------------------------------------ */
function unitTimeline() {
  copyDb(UNIT_DIR);
  process.env.DLY_DATA_DIR = UNIT_DIR;
  const { db } = require('../src/db');
  const timeline = require('../src/timeline');
  const util = require('../src/util');

  const base = db.prepare('SELECT * FROM bookings WHERE id = ?').get(13)
    || db.prepare('SELECT * FROM bookings ORDER BY id LIMIT 1').get();
  const booking = { ...base, status: 'confirmed', shooting_date: '2026-11-08', shooting_time: '04:23' };
  db.prepare("DELETE FROM booking_timeline WHERE booking_id = ? AND stage = 'session_done'").run(booking.id);

  const before = timeline.reach(booking, { now: new Date('2026-11-08T04:22:59+07:00') });
  ck('Tahap 03 belum aktif 1 detik sebelum jadwal', !before.includes('session_done'));
  const at = timeline.reach(booking, { now: new Date('2026-11-08T04:23:00+07:00') });
  ck('Tahap 03 aktif TEPAT saat jadwal sesi (04.23 WIB)', at.includes('session_done'));
  const again = timeline.reach(booking, { now: new Date('2026-11-08T06:00:00+07:00') });
  ck('Transisi tidak dobel saat dipanggil berulang (idempotent)', !again.includes('session_done'));
  const row = db.prepare("SELECT * FROM booking_timeline WHERE booking_id = ? AND stage = 'session_done'").get(booking.id);
  ck('Waktu transisi tersimpan = jam sesi di booking (04:23 WIB)',
    Boolean(row) && util.formatDateTimeWIB(row.happened_at).includes('04:23'),
    row && row.happened_at);
  db.prepare("DELETE FROM booking_timeline WHERE booking_id = ? AND stage = 'session_done'").run(booking.id);
  const pending = timeline.list(booking, { now: new Date('2026-11-08T04:00:00+07:00') });
  ck('nextSessionAt tersedia untuk penyegaran otomatis halaman',
    pending.nextSessionAt === new Date('2026-11-08T04:23:00+07:00').getTime(), pending.nextSessionAt);
  db.close();
}

/* ------------------------------------------------------------------ */
/* 2–8. Browser checks                                                 */
/* ------------------------------------------------------------------ */
async function browserChecks() {
  copyDb(DATA_DIR);
  const prep = new Database(path.join(DATA_DIR, 'app.sqlite'));
  // v15: PIN disimpan sebagai hash. Fixture harus mengosongkan hash lama, kalau tidak
  // verifikasi memakai hash (bukan PIN plaintext yang disetel di sini) dan login gagal.
  prep.prepare("UPDATE bookings SET portal_pin = '1357', portal_pin_hash = NULL WHERE id = 13").run();
  // Booking 13 dijadikan "sesi baru saja dimulai" (6 menit lalu, WIB).
  const past = new Date(Date.now() + 7 * 3600 * 1000 - 6 * 60 * 1000);
  const pastDate = `${past.getUTCFullYear()}-${String(past.getUTCMonth() + 1).padStart(2, '0')}-${String(past.getUTCDate()).padStart(2, '0')}`;
  const pastTime = `${String(past.getUTCHours()).padStart(2, '0')}:${String(past.getUTCMinutes()).padStart(2, '0')}`;
  // DATA-AWARE: dulu skrip ini memakai id 13 tetap, sehingga langsung rusak ketika
  // pemilik menghapus booking tersebut. Sekarang pakai booking 13 bila ada, kalau tidak
  // booking mana pun yang tersedia, dan SEMUA fixture memakai id itu.
  const fixRow = prep.prepare('SELECT id, code FROM bookings WHERE id = 13').get()
    || prep.prepare('SELECT id, code FROM bookings ORDER BY id LIMIT 1').get();
  if (!fixRow) throw new Error('Tidak ada booking sama sekali di salinan database untuk diuji.');
  const FIX_ID = fixRow.id;
  const booking13 = { code: fixRow.code };
  prep.prepare('UPDATE bookings SET shooting_date = ?, shooting_time = ? WHERE id = ?').run(pastDate, pastTime, FIX_ID);
  // Booking ini dipakai sebagai "sesi baru dimulai": bersihkan progres sesudahnya HANYA di
  // salinan uji, supaya tahap 03 benar-benar menjadi tahap aktif (data pemilik bisa saja
  // sudah punya portal foto untuk booking ini).
  prep.prepare('UPDATE bookings SET final_url = NULL, final_at = NULL WHERE id = ?').run(FIX_ID);
  prep.prepare("UPDATE bookings SET status = 'confirmed', portal_pin = '1357', portal_pin_hash = NULL WHERE id = ?").run(FIX_ID);
  prep.prepare("DELETE FROM booking_timeline WHERE booking_id = ? AND stage IN ('session_done','photos_ready','submitted','editing_queue','editing','final_ready')").run(FIX_ID);
  try { prep.prepare('DELETE FROM photo_selections WHERE booking_id = ?').run(FIX_ID); } catch (err) { /* tabel portal */ }
  prep.close();

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

    /* ---------- 11–12: gallery = CAROUSEL horizontal satu jalur ---------- */
    const b = await chromium.launch();
    const d = await b.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    d.on('pageerror', (e) => errors.push(String(e)));
    await d.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    await sleep(900);
    await d.evaluate(() => document.querySelector('.pf-carousel--gallery').scrollIntoView({ block: 'center' }));
    await sleep(400);
    const desk = await d.evaluate(() => {
      const root = document.querySelector('.pf-carousel--gallery');
      const vp = root && root.querySelector('[data-pf-viewport]');
      const cards = root ? Array.from(root.querySelectorAll('.portfolio-card')) : [];
      const cap = cards[0] && cards[0].querySelector('.portfolio-card__caption');
      const name = cards[0] && cards[0].querySelector('.portfolio-card__name');
      const sub = cards[0] && cards[0].querySelector('.portfolio-card__sub');
      const shade = cards[0] && cards[0].querySelector('.portfolio-card__shade');
      const capBox = cap ? cap.getBoundingClientRect() : null;
      const hit = capBox ? document.elementFromPoint(capBox.x + capBox.width / 2, capBox.y + capBox.height / 2) : null;
      const slot = root && root.querySelector('.pf-carousel__slide');
      return {
        exists: Boolean(root),
        cards: cards.length,
        rows: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size,
        slideW: slot ? Math.round(slot.getBoundingClientRect().width) : 0,
        vpW: vp ? Math.round(vp.clientWidth) : 0,
        scrollable: vp ? vp.scrollWidth - vp.clientWidth : 0,
        dots: root ? root.querySelectorAll('[data-pf-dots] .pf-carousel__dot').length : 0,
        gap: (root && root.querySelector('[data-pf-track]')) ? parseFloat(getComputedStyle(root.querySelector('[data-pf-track]')).gap) : 0,
        names: cards.map((c) => ((c.querySelector('.portfolio-card__name')) || {}).textContent || ''),
        metas: cards.map((c) => ((c.querySelector('.portfolio-card__sub')) || {}).textContent || ''),
        captionInside: Boolean(cap && cards[0].contains(cap)),
        captionVisible: hit ? /portfolio-card__(name|sub|caption)/.test(hit.className || '') : false,
        captionBg: cap ? getComputedStyle(cap).backgroundColor : '',
        shadeBg: shade ? getComputedStyle(shade).backgroundImage : '',
        nameFont: name ? getComputedStyle(name).fontFamily.split(',')[0].replace(/["']/g, '') : '',
        nameWeight: name ? getComputedStyle(name).fontWeight : '',
        subFont: sub ? getComputedStyle(sub).fontFamily.split(',')[0].replace(/["']/g, '') : '',
        subWeight: sub ? getComputedStyle(sub).fontWeight : '',
        ratio: (() => {
          const img = cards[0] && cards[0].querySelector('.portfolio-card__img');
          if (!img) return 0;
          const r = img.getBoundingClientRect();
          return Math.round((r.width / r.height) * 100) / 100;
        })(),
        masonry: document.querySelectorAll('.gallery-masonry').length,
        wall: document.querySelectorAll('.pf-wall').length,
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth
      };
    });
    ck('Gallery publik = carousel horizontal satu jalur (bukan grid/masonry)',
      desk.exists && desk.masonry === 0 && desk.wall === 0 && desk.cards >= 2,
      `${desk.cards} kartu, masonry=${desk.masonry}, wall=${desk.wall}`);
    ck('Semua kartu pada satu baris + masih bisa digeser',
      desk.rows === 1 && desk.slideW < desk.vpW && desk.scrollable > 20,
      `${desk.rows} baris, slide ${desk.slideW}/${desk.vpW}, scrollable ${desk.scrollable}`);
    ck('Carousel punya dots sejumlah karya', desk.dots === desk.cards, `${desk.dots}/${desk.cards}`);
    ck('Jarak antar kartu lega (≥16px)', desk.gap >= 16, String(desk.gap));
    ck('Kartu memakai crop portrait konsisten (4:5)', Math.abs(desk.ratio - 0.8) < 0.04, String(desk.ratio));
    ck('Nama client tampil di SETIAP kartu (data masing-masing)',
      desk.names.length > 0 && desk.names.every((n) => n.trim().length > 0), desk.names.join(' | '));
    ck('Baris kedua "Kampus • Tanggal" di setiap kartu',
      desk.metas.every((m) => /•/.test(m)), desk.metas.join(' | '));
    ck('Keterangan TERLIHAT di atas foto (tidak tertutup gambar)',
      desk.captionInside && desk.captionVisible);
    ck('Keterangan menyatu dengan foto (gradient, bukan panel solid)',
      /gradient/.test(desk.shadeBg) && /rgba\(0, 0, 0, 0\)|transparent/.test(desk.captionBg));
    ck('Tipografi caption Montserrat (nama Bold, meta Medium/SemiBold)',
      desk.nameFont === 'Montserrat' && Number(desk.nameWeight) >= 700
      && desk.subFont === 'Montserrat' && Number(desk.subWeight) >= 500,
      `${desk.nameFont} ${desk.nameWeight} / ${desk.subFont} ${desk.subWeight}`);
    ck('Tidak ada overflow horizontal pada halaman gallery', desk.docW <= desk.winW + 1, `${desk.docW}/${desk.winW}`);
    /* ---------- 13 & 17: paket ---------- */
    await d.goto(`${BASE}/paket/individual`, { waitUntil: 'load' });
    await sleep(400);
    const pkg = await d.evaluate(() => {
      const h1 = document.querySelector('.pkg-detail__titlerow h1');
      const badge = document.querySelector('.pkg-detail__titlerow .pkg-sold');
      const price = document.querySelector('.pkg-detail__price strong');
      const sticky = document.querySelector('[data-sticky-price]');
      const rr = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cy: r.y + r.height / 2 }; };
      return {
        h1: h1 ? rr(h1) : null,
        badge: badge ? rr(badge) : null,
        badgeShadow: badge ? getComputedStyle(badge).boxShadow : '',
        dotAnim: badge ? getComputedStyle(badge.querySelector('.pkg-sold__dot')).animationName : '',
        priceWeight: price ? getComputedStyle(price).fontWeight : '',
        stickyWeight: sticky ? getComputedStyle(sticky).fontWeight : '',
        h1Weight: h1 ? getComputedStyle(h1).fontWeight : ''
      };
    });
    ck('Indikator jumlah sesi ada di baris judul paket (bukan di bawah judul)',
      Boolean(pkg.h1 && pkg.badge && Math.abs(pkg.h1.cy - pkg.badge.cy) < pkg.h1.h && pkg.badge.x > pkg.h1.x),
      pkg.h1 && pkg.badge ? `h1 ${Math.round(pkg.h1.cy)} / badge ${Math.round(pkg.badge.cy)}` : '');
    ck('Badge punya soft blue glow + dot pulse lembut',
      /rgb/.test(pkg.badgeShadow) && pkg.dotAnim === 'soldPulse', `${pkg.badgeShadow} / ${pkg.dotAnim}`);
    ck('Harga panel "Harga" Bold (700), sama tebal dengan sticky booking bar',
      pkg.priceWeight === '700' && pkg.stickyWeight === '700', `${pkg.priceWeight}/${pkg.stickyWeight}`);
    ck('Judul paket tegas (700)', pkg.h1Weight === '700', pkg.h1Weight);
    ck('Tidak ada error JavaScript di halaman yang diuji', errors.length === 0, errors.join(' | '));
    await b.close();

    /* ---------- mobile: gallery, klien lain, login, status ---------- */
    const b2 = await chromium.launch();
    const m = await b2.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await m.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    await sleep(600);
    const mob = await m.evaluate(() => {
      const root = document.querySelector('.pf-carousel--gallery');
      const vp = root && root.querySelector('[data-pf-viewport]');
      const slots = root ? Array.from(root.querySelectorAll('.pf-carousel__slide')) : [];
      const cards = root ? Array.from(root.querySelectorAll('.portfolio-card')) : [];
      return {
        cards: cards.length,
        slideW: slots[0] ? Math.round(slots[0].getBoundingClientRect().width) : 0,
        vpW: vp ? Math.round(vp.clientWidth) : 0,
        rows: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size,
        gap: (root && root.querySelector('[data-pf-track]')) ? parseFloat(getComputedStyle(root.querySelector('[data-pf-track]')).gap) : 0,
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth
      };
    });
    ck('Mobile: SATU kartu per slide (peek kartu berikutnya)',
      mob.cards >= 2 && mob.rows === 1 && mob.slideW > mob.vpW * 0.7 && mob.slideW < mob.vpW,
      `${mob.cards} kartu, slide ${mob.slideW}/${mob.vpW}, ${mob.rows} baris`);
    ck('Mobile tidak overflow horizontal + jarak antar kartu wajar', mob.docW <= mob.winW + 1 && mob.gap >= 12,
      `${mob.docW}/${mob.winW}, gap ${mob.gap}px`);

    await m.goto(`${BASE}/portfolio/nabila-puspita`, { waitUntil: 'load' });
    await sleep(600);
    const others = await m.evaluate(() => {
      const root = document.querySelector('.pf-carousel--others');
      const vp = root && root.querySelector('[data-pf-viewport]');
      const slides = root ? Array.from(root.querySelectorAll('.pf-carousel__slide')) : [];
      return {
        exists: Boolean(root),
        slideW: slides[0] ? Math.round(slides[0].getBoundingClientRect().width) : 0,
        tops: slides.map((s) => Math.round(s.getBoundingClientRect().top)),
        vpW: vp ? vp.clientWidth : 0,
        scrollable: vp ? vp.scrollWidth > vp.clientWidth + 2 : false,
        grid: document.querySelectorAll('.pf-others .portfolio-grid').length,
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth
      };
    });
    ck('"Portfolio klien lain" mobile = carousel satu jalur (bukan grid 2 kolom)',
      others.exists && others.grid === 0 && others.slideW / others.vpW > 0.78 && others.slideW / others.vpW < 0.95,
      `${others.slideW}/${others.vpW}`);
    ck('Kartu "klien lain" tidak turun ke baris kedua + bisa digeser',
      new Set(others.tops).size === 1 && others.scrollable && others.docW <= others.winW + 1,
      others.tops.join(','));

    await m.goto(`${BASE}/portal`, { waitUntil: 'load' });
    await sleep(500);
    const login = await m.evaluate(() => {
      const logo = document.querySelector('.cp-login__logo');
      const card = document.querySelector('.cp-login__card');
      return {
        logo: logo ? { w: logo.getBoundingClientRect().width, h: logo.getBoundingClientRect().height } : null,
        mark: Boolean(document.querySelector('.cp-login__mark')),
        cardW: card ? card.getBoundingClientRect().width : 0,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1 || card.getBoundingClientRect().width > window.innerWidth
      };
    });
    ck('Login Client Portal tidak lagi memakai placeholder kotak "DLY"', !login.mark);
    // V20: satu ukuran logo global (--logo-h = 40px) — dulu clamp 84–112px, jadi
    // tinggi tidak lagi >60px. Yang dijaga sekarang: logo resmi tampil, rasio wajar,
    // dan tidak melebihi lebar kartu.
    ck('Logo resmi tampil dengan ukuran seragam (40px) di login',
      Boolean(login.logo && Math.abs(login.logo.h - 40) <= 1 && login.logo.w > 60 && login.logo.w < login.cardW),
      JSON.stringify(login.logo));
    ck('Login tidak overflow di HP', !login.overflow);

    await m.fill('input[name="code"]', booking13.code);
    await m.fill('input[name="pin"]', '1357');
    await Promise.all([m.waitForNavigation(), m.click('.cp-login__btn')]);
    await sleep(600);
    const ring = await m.evaluate(() => {
      const card = document.querySelector('[data-cp-live]');
      const chip = card && card.querySelector('.cp-chip--live');
      const dot = chip && chip.querySelector('.cp-chip__dot');
      const title = card && card.querySelector('.cp-card__title');
      const cb = chip ? chip.getBoundingClientRect() : null;
      const tb = title ? title.getBoundingClientRect() : null;
      const reminder = card && card.querySelector('.cp-status__reminder');
      return {
        stage: card ? card.getAttribute('data-stage') : '',
        nowText: card ? card.querySelector('.cp-status__now').innerText.replace(/\s+/g, ' ').trim() : '',
        reminder: reminder ? reminder.textContent.trim() : '',
        chipDot: Boolean(dot),
        dotAnim: dot ? getComputedStyle(dot).animationName : '',
        chipShadow: chip ? getComputedStyle(chip).boxShadow : '',
        sameRow: cb && tb ? Math.abs((cb.top + cb.height / 2) - (tb.top + tb.height / 2)) < tb.height : false
      };
    });
    // Revisi 2 (08): tahap 03 kini "Sesi Foto Selesai" (aktif selama sesi, centang
    // hijau setelah perkiraan akhir sesi).
    // Judul tahap 03 dinamis: saat sesi berjalan = "Sesi Fotomu Dimulai"
    // (setelah sesi lewat = "Sesi Foto Selesai").
    ck('Status otomatis pindah ke tahap 03 saat jam sesi tiba',
      ring.stage === 'session_done' && /Sesi foto dimulai|Sesimu sudah selesai|Sesi Foto Selesai/.test(ring.nowText),
      ring.nowText.slice(0, 80));
    ck('Pesan pengingat tampil di bawah deskripsi tahap 03',
      ring.reminder === require('../src/timeline').SESSION_REMINDER, ring.reminder);
    ck('Badge "Sedang Berlangsung" punya dot hijau pulse + soft glow',
      ring.chipDot && ring.dotAnim === 'cpLivePulse' && /rgb/.test(ring.chipShadow), `${ring.dotAnim}`);
    ck('Judul kartu status + badge dalam satu baris', ring.sameRow);

    await m.goto(`${BASE}/portal/pantau-order`, { waitUntil: 'load' });
    await sleep(500);
    const tl = await m.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.cp-tl__item'));
      const cur = document.querySelector('.cp-tl__item.is-current .cp-tl__dot');
      return {
        done: items.filter((li) => li.classList.contains('is-done')).length,
        checks: items.filter((li) => li.classList.contains('is-done') && li.querySelector('.cp-tl__dot svg')).length,
        literal: document.body.innerText.includes('&#10003;'),
        current: items.filter((li) => li.classList.contains('is-current')).map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
        glow: cur ? getComputedStyle(cur).boxShadow : '',
        reminder: document.body.innerText.includes('Harap datang tepat waktu'),
        titles: items.map((li) => (li.querySelector('.cp-tl__title strong') || {}).textContent || '')
      };
    });
    ck('Tahap selesai memakai ikon centang sederhana (bukan teks entity)',
      tl.done > 0 && tl.checks === tl.done && !tl.literal, `${tl.checks}/${tl.done}`);
    ck('Tahap aktif tetap punya indikator sendiri + label "Sedang berlangsung"',
      tl.current.length === 1 && /Sedang berlangsung/i.test(tl.current[0]), tl.current[0]);
    ck('Indikator tahap aktif memakai soft glow (hanya tahap aktif)',
      /rgb/.test(tl.glow), tl.glow);
    ck('Timeline memuat tahap 03 + pengingat saat aktif',
      tl.titles.some((t) => /Sesi foto/i.test(t)) && tl.reminder, tl.titles.join(' | '));

    /* ---------- endpoint status (kontrak JSON, tanpa data pribadi) ---------- */
    const statusJson = await m.evaluate(async () => {
      const r = await fetch(document.body.getAttribute('data-base') + '/portal/status', { credentials: 'same-origin' });
      return r.ok ? r.json() : { ok: false };
    });
    ck('Endpoint /portal/status mengembalikan tahap tanpa data pribadi',
      statusJson.ok === true && statusJson.stage === 'session_done'
      && !('clientName' in statusJson) && !('phone' in statusJson), JSON.stringify(statusJson));

    /* ---------- Revisi 2 (04): navigasi utama tanpa Lokasi & Paket ---------- */
    await m.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    await sleep(400);
    const navData = await m.evaluate(async () => {
      const links = Array.from(document.querySelectorAll('.site-nav > a'));
      return {
        drops: document.querySelectorAll('[data-nav-drop], [data-mobile-group]').length,
        labels: links.map((a) => a.textContent.trim()),
        mobileGroups: document.querySelectorAll('.mobile-nav__group').length,
        // Halaman lama tetap hidup (data tidak dihapus, hanya menunya).
        cityStatus: await fetch(document.body.getAttribute('data-base') + '/city').then((r) => r.status),
        paketHref: (document.querySelector('.site-nav a[href$="/pricelist"]') || {}).getAttribute
          ? document.querySelector('.site-nav a[href$="/pricelist"]').getAttribute('href') : ''
      };
    });
    ck('Navigasi utama TIDAK lagi punya dropdown Lokasi & Paket',
      navData.drops === 0 && navData.mobileGroups === 0, String(navData.drops));
    ck('Menu yang dipertahankan tetap ada (Home, Gallery, Pricelist, Cara Order, Ulasan)',
      ['Home', 'Gallery', 'Pricelist', 'Cara Order', 'Ulasan'].every((l) => navData.labels.includes(l)),
      navData.labels.join(' | '));
    ck('Menu Syarat & Ketentuan tetap tampil di navigasi',
      navData.labels.some((l) => /Syarat/i.test(l)), navData.labels.join(' | '));
    ck('Halaman /city masih hidup walau menunya dihapus', navData.cityStatus === 200, String(navData.cityStatus));

    /* ---------- logo beradaptasi dengan latar ---------- */
    const dLog = await chromium.launch();
    const pLog = await dLog.newPage({ viewport: { width: 1440, height: 950 } });
    await pLog.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    await sleep(600);
    const solidLogo = await pLog.evaluate(() => {
      const img = document.querySelector('.logo .logo__img--solid');
      const over = document.querySelector('.logo .logo__img--over');
      return {
        solidShown: img ? getComputedStyle(img).display !== 'none' : false,
        solidSrc: img ? img.currentSrc || img.src : '',
        overShown: over ? getComputedStyle(over).display !== 'none' : false
      };
    });
    await pLog.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(700);
    const overLogo = await pLog.evaluate(() => {
      const img = document.querySelector('.logo .logo__img--over');
      const solid = document.querySelector('.logo .logo__img--solid');
      return {
        overShown: img ? getComputedStyle(img).display !== 'none' : false,
        overSrc: img ? img.currentSrc || img.src : '',
        solidShown: solid ? getComputedStyle(solid).display !== 'none' : false
      };
    });
    ck('Header putih memakai logo gelap (warna asli), bukan logo putih',
      solidLogo.solidShown && !solidLogo.overShown, JSON.stringify(solidLogo));
    ck('Header di atas foto gelap memakai logo putih',
      overLogo.overShown && !overLogo.solidShown, JSON.stringify(overLogo));
    ck('Dua varian logo benar-benar berbeda (adaptif, bukan file yang sama)',
      Boolean(solidLogo.solidSrc) && Boolean(overLogo.overSrc) && solidLogo.solidSrc !== overLogo.overSrc,
      `${solidLogo.solidSrc} vs ${overLogo.overSrc}`);
    const logoStatus = await pLog.evaluate(async (src) => {
      const r = await fetch(src, { cache: 'no-store' });
      return r.status;
    }, overLogo.overSrc);
    ck('File logo yang dirender bisa diambil (200)', logoStatus === 200, String(logoStatus));
    await dLog.close();

    /* ---------- 18.1: halaman menyegarkan diri tepat waktu ---------- */
    if (SLOW) {
      const next = new Date(Date.now() + 7 * 3600 * 1000);
      next.setUTCSeconds(0, 0);
      next.setUTCMinutes(next.getUTCMinutes() + 1);
      const nd = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
      const nt = `${String(next.getUTCHours()).padStart(2, '0')}:${String(next.getUTCMinutes()).padStart(2, '0')}`;
      const nextAt = next.getTime() - 7 * 3600 * 1000;
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
      db.prepare('UPDATE bookings SET shooting_date = ?, shooting_time = ? WHERE id = ?').run(nd, nt, FIX_ID);
      db.prepare("DELETE FROM booking_timeline WHERE booking_id = ? AND stage = 'session_done'").run(FIX_ID);
      db.close();

      const b3 = await chromium.launch();
      const rm = await b3.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce' });
      await rm.goto(`${BASE}/portal`, { waitUntil: 'load' });
      await rm.fill('input[name="code"]', booking13.code);
      await rm.fill('input[name="pin"]', '1357');
      await Promise.all([rm.waitForNavigation(), rm.click('.cp-login__btn')]);
      await sleep(500);
      const before = await rm.getAttribute('[data-cp-live]', 'data-stage');
      // Revisi 2 (08): "Menunggu Sesi Pemotretan" dihapus; tahap 02 = DP Terkonfirmasi.
      ck('Sebelum jam sesi tiba, tahap terakhir bukan sesi (DP Terkonfirmasi/belum ada)',
        before !== 'session_done' && before !== 'photos_ready', before);
      await rm.waitForTimeout(Math.max(4000, nextAt - Date.now() + 8000));
      const after = await rm.evaluate(() => ({
        stage: document.querySelector('[data-cp-live]') ? document.querySelector('[data-cp-live]').getAttribute('data-stage') : '',
        nav: performance.getEntriesByType('navigation')[0].type,
        text: document.body.innerText.replace(/\s+/g, ' ')
      }));
      ck('Halaman menyegarkan sendiri saat jam sesi tiba (tanpa refresh manual)',
        after.stage === 'session_done' && after.nav === 'reload' && /Sesi foto/i.test(after.text),
        `${after.stage}/${after.nav}`);
      await b3.close();
    } else {
      console.log('SKIP  Uji tunggu transisi real-time (REV3_FAST=1)');
    }
  } finally {
    app.kill();
  }
}

(async () => {
  unitTimeline();
  await browserChecks();
  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Gagal: ' + failures.join(' | '));
    process.exitCode = 1;
  }
  // Browser/app anak bisa menahan event loop — keluar eksplisit setelah hasil dicetak.
  setTimeout(() => process.exit(failures.length ? 1 : 0), 200);
})().catch((e) => { console.error(e); process.exit(1); });

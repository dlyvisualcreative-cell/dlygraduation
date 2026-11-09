'use strict';

/**
 * Revisi pack — acceptance suite (UI + booking 24 jam + portal responsive).
 * Notifikasi diuji terpisah di scripts/check-push-rules.js.
 *
 *   node scripts/check-rev2.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.REV2_PORT || 4650);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = `/tmp/dly-rev2-${Date.now()}`;
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const ck = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) {}
}

function seedPortal() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const b = db.prepare('SELECT id, code, portal_pin FROM bookings ORDER BY id LIMIT 1').get();
  if (!b) { db.close(); return null; }
  const sel = db.prepare('SELECT id FROM photo_selections WHERE booking_id = ?').get(b.id);
  if (sel) {
    db.prepare("UPDATE photo_selections SET submitted_at = NULL, status = 'waiting', is_open = 1 WHERE id = ?").run(sel.id);
    db.prepare('DELETE FROM photo_selection_picks WHERE portal_id = ?').run(sel.id);
  }
  db.prepare("UPDATE bookings SET portal_pin = '1357', portal_pin_hash = NULL WHERE id = ?").run(b.id);
  db.close();
  return { code: b.code, hasPortal: Boolean(sel) };
}

(async () => {
  prepare();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  const browser = await chromium.launch();
  const errors = [];
  try {
    for (let i = 0; i < 120; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await sleep(250);
    }
    const fx = seedPortal();

    /* ============================================================
       05–07, 10. Portfolio Highlights — CAROUSEL HORIZONTAL (revisi 11/12)
       Satu jalur horizontal (bukan grid 2×2): 1 kartu + peek di HP,
       beberapa kartu sejajar di tablet/desktop. Keterangan tetap overlay.
       ============================================================ */
    const desk = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    desk.on('pageerror', (e) => errors.push(String(e)));
    await desk.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(900);
    await desk.evaluate(() => document.querySelector('.pf-carousel--featured').scrollIntoView({ block: 'center' }));
    await sleep(400);

    const wall = await desk.evaluate(() => {
      const root = document.querySelector('.pf-carousel--featured');
      const vp = root && root.querySelector('[data-pf-viewport]');
      const track = root && root.querySelector('[data-pf-track]');
      const slots = root ? Array.from(root.querySelectorAll('.pf-carousel__slide')) : [];
      const cards = root ? Array.from(root.querySelectorAll('.portfolio-card')) : [];
      const card = cards[0];
      const cap = card && card.querySelector('.portfolio-card__caption');
      const name = card && card.querySelector('.portfolio-card__name');
      const sub = card && card.querySelector('.portfolio-card__sub');
      const shade = card && card.querySelector('.portfolio-card__shade');
      const cs = card ? getComputedStyle(card) : null;
      const capBox = cap ? cap.getBoundingClientRect() : null;
      const cardBox = card ? card.getBoundingClientRect() : null;
      const hit = capBox ? document.elementFromPoint(capBox.x + capBox.width / 2, capBox.y + capBox.height / 2) : null;
      return {
        exists: Boolean(root),
        cards: cards.length,
        rows: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size,
        slideW: slots[0] ? Math.round(slots[0].getBoundingClientRect().width) : 0,
        vpW: vp ? Math.round(vp.clientWidth) : 0,
        scrollable: vp ? vp.scrollWidth - vp.clientWidth : 0,
        gap: track ? parseFloat(getComputedStyle(track).gap) : 0,
        captionChildren: cap ? cap.children.length : 0,
        captionInside: Boolean(capBox && cardBox && capBox.bottom <= cardBox.bottom + 1),
        nameWeight: name ? getComputedStyle(name).fontWeight : '',
        nameFont: name ? getComputedStyle(name).fontFamily.split(',')[0].replace(/["']/g, '') : '',
        subFont: sub ? getComputedStyle(sub).fontFamily.split(',')[0].replace(/["']/g, '') : '',
        subText: sub ? sub.textContent.trim() : '',
        shadeBg: shade ? getComputedStyle(shade).backgroundImage.slice(0, 40) : '',
        captionBg: cap ? getComputedStyle(cap).backgroundColor : '',
        captionVisible: hit ? /portfolio-card__name|portfolio-card__sub|portfolio-card__caption/.test(hit.className || '') : false,
        nameSize: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
        shadow: cs ? cs.boxShadow !== 'none' : false,
        radius: cs ? parseFloat(cs.borderTopLeftRadius) : 0,
        ratio: (() => {
          const img = card && card.querySelector('.portfolio-card__img');
          if (!img) return 0;
          const r = img.getBoundingClientRect();
          return r.width / r.height;
        })(),
        btnText: (document.querySelector('.pf-carousel__more') || {}).textContent || '',
        btnWeight: (() => { const b = document.querySelector('.pf-carousel__more'); return b ? getComputedStyle(b).fontWeight : ''; })(),
        headingFont: (() => { const h = document.querySelector('.pf-carousel__title'); return h ? getComputedStyle(h).fontFamily.split(',')[0].replace(/["']/g, '') : ''; })(),
        headingWeight: (() => { const h = document.querySelector('.pf-carousel__title'); return h ? getComputedStyle(h).fontWeight : ''; })()
      };
    });
    ck('Portfolio Highlights tampil sebagai carousel horizontal', wall.exists && wall.cards >= 2, `${wall.cards} kartu`);
    ck('Semua kartu berada pada SATU baris (bukan grid 2×2)', wall.rows === 1, `${wall.rows} baris`);
    ck('Desktop: beberapa kartu sejajar + masih bisa digeser', wall.slideW < wall.vpW && wall.scrollable > 20,
      `slide=${wall.slideW} vp=${wall.vpW} scrollable=${wall.scrollable}`);
    ck('Jarak antar kartu lega dan konsisten (≥16px)', wall.gap >= 16, `${wall.gap}px`);
    ck('Kartu memakai crop portrait konsisten (4:5)', Math.abs(wall.ratio - 0.8) < 0.04, wall.ratio.toFixed(2));
    ck('Keterangan kartu = 2 baris (nama + kampus•tanggal)', wall.captionChildren === 2, String(wall.captionChildren));
    ck('Keterangan berada DI DALAM foto (overlay bawah)', wall.captionInside);
    ck('Keterangan BENAR-BENAR terlihat di atas foto (bukan tertutup gambar)', wall.captionVisible);
    ck('Nama client memakai Montserrat Bold', wall.nameFont === 'Montserrat' && Number(wall.nameWeight) >= 700,
      `${wall.nameFont} ${wall.nameWeight}`);
    ck('Baris kampus • tanggal memakai Montserrat', wall.subFont === 'Montserrat', wall.subFont);
    ck('Baris kedua berformat "Kampus • Tanggal"', /•/.test(wall.subText), wall.subText);
    ck('Keterangan menempel pada foto (gradient, bukan kotak solid)',
      /gradient/.test(wall.shadeBg) && (wall.captionBg === 'rgba(0, 0, 0, 0)' || wall.captionBg === 'transparent'),
      `${wall.shadeBg} / ${wall.captionBg}`);
    ck('Kartu punya sudut membulat + shadow lembut', wall.radius >= 12 && wall.shadow, `${wall.radius} / ${wall.shadow}`);
    ck('Judul section memakai Montserrat tegas', wall.headingFont === 'Montserrat' && Number(wall.headingWeight) >= 600,
      `${wall.headingFont} ${wall.headingWeight}`);
    ck('Tombol "EXPLORE MORE WORKS" ada dan tebal',
      /EXPLORE MORE WORKS/i.test(wall.btnText) && Number(wall.btnWeight) >= 600,
      `${wall.btnText} / ${wall.btnWeight}`);

    /* ---------------- mobile: 1 kartu + peek ---------------- */
    await desk.close();
    const mobBrowser = await chromium.launch();
    const mob = await mobBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mob.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(700);
    const mobWall = await mob.evaluate(() => {
      const root = document.querySelector('.pf-carousel--featured');
      const vp = root.querySelector('[data-pf-viewport]');
      const slots = Array.from(root.querySelectorAll('.pf-carousel__slide'));
      const cards = Array.from(root.querySelectorAll('.portfolio-card'));
      const name = cards[0].querySelector('.portfolio-card__name');
      return {
        slideW: Math.round(slots[0].getBoundingClientRect().width),
        vpW: Math.round(vp.clientWidth),
        rows: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size,
        gap: parseFloat(getComputedStyle(root.querySelector('[data-pf-track]')).gap),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        nameSize: parseFloat(getComputedStyle(name).fontSize)
      };
    });
    ck('Mobile: SATU kartu utama + peek kartu berikutnya',
      mobWall.slideW > mobWall.vpW * 0.7 && mobWall.slideW < mobWall.vpW, `${mobWall.slideW}/${mobWall.vpW}`);
    ck('Mobile: kartu tetap satu baris (tidak turun)', mobWall.rows === 1, `${mobWall.rows} baris`);
    ck('Mobile tidak ada overflow horizontal', mobWall.overflow <= 0, `${mobWall.overflow}px`);
    ck('Nama client di mobile tetap terbaca', mobWall.nameSize >= 13, String(mobWall.nameSize));
    ck('Jarak kartu di mobile tidak terlalu rapat (≥12px)', mobWall.gap >= 12, `${mobWall.gap}px`);

    await mobBrowser.close();

    /* ---------------- tablet: beberapa kartu sejajar (instance terpisah) ---------------- */
    const tabBrowser = await chromium.launch();
    const tab = await tabBrowser.newPage({ viewport: { width: 820, height: 1000 } });
    await tab.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(600);
    const tabMetrics = await tab.evaluate(() => {
      const root = document.querySelector('.pf-carousel--featured');
      const vp = root.querySelector('[data-pf-viewport]');
      const slot = root.querySelector('.pf-carousel__slide');
      return {
        slideW: Math.round(slot.getBoundingClientRect().width),
        vpW: Math.round(vp.clientWidth)
      };
    });
    ck('Tablet menampilkan beberapa kartu sejajar (2+ terlihat)',
      tabMetrics.slideW <= tabMetrics.vpW * 0.55, `${tabMetrics.slideW}/${tabMetrics.vpW}`);
    await tabBrowser.close();

    /* ============================================================
       08. Hero (instance browser terpisah)
       ============================================================ */
    const deskBrowser = await chromium.launch();
    const deskPage = await deskBrowser.newPage({ viewport: { width: 1440, height: 950 } });
    await deskPage.goto(`${BASE}/`, { waitUntil: 'load' });
    const hero = await deskPage.evaluate(() => {
      const h1 = document.querySelector('.hero__title');
      const btn = document.querySelector('.hero__actions .btn');
      const overlay = document.querySelector('.hero__overlay');
      return {
        color: h1 ? getComputedStyle(h1).color : '',
        weight: h1 ? Number(getComputedStyle(h1).fontWeight) : 0,
        btnBg: btn ? getComputedStyle(btn).backgroundColor : '',
        btnColor: btn ? getComputedStyle(btn).color : '',
        btnWeight: btn ? Number(getComputedStyle(btn).fontWeight) : 0,
        overlay: overlay ? getComputedStyle(overlay).opacity : ''
      };
    });
    ck('Teks hero berwarna putih', hero.color === 'rgb(255, 255, 255)', hero.color);
    ck('Judul hero berbobot Medium/SemiBold (500–600)', hero.weight >= 500 && hero.weight <= 600, String(hero.weight));
    ck('Tombol portofolio berlatar biru DLY dengan teks putih',
      hero.btnBg === 'rgb(11, 35, 64)' && hero.btnColor === 'rgb(255, 255, 255)', `${hero.btnBg} / ${hero.btnColor}`);
    ck('Font tombol hero lebih tebal', hero.btnWeight >= 600, String(hero.btnWeight));

    /* ============================================================
       09. Heading, paket, harga, indikator sesi
       ============================================================ */
    await deskPage.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    const pkg = await deskPage.evaluate(() => {
      const title = document.querySelector('.pkg-feature__title');
      const price = document.querySelector('.pkg-feature__price strong');
      const sold = document.querySelector('.pkg-sold--inline');
      const row = document.querySelector('.pkg-feature__titlerow');
      const desc = document.querySelector('.pkg-feature__desc');
      const dot = sold ? sold.querySelector('.pkg-sold__dot') : null;
      return {
        titleWeight: title ? Number(getComputedStyle(title).fontWeight) : 0,
        priceWeight: price ? Number(getComputedStyle(price).fontWeight) : 0,
        descWeight: desc ? Number(getComputedStyle(desc).fontWeight) : 0,
        soldInline: Boolean(sold),
        soldInTitleRow: Boolean(row && sold && row.contains(sold)),
        soldText: sold ? sold.textContent.trim() : '',
        pulse: dot ? getComputedStyle(dot).animationName : '',
        headingWeight: Number(getComputedStyle(document.querySelector('h2')).fontWeight)
      };
    });
    ck('Nama paket memakai bobot tegas (600–700)', pkg.titleWeight >= 600, String(pkg.titleWeight));
    ck('Total harga memakai bobot tegas', pkg.priceWeight >= 600, String(pkg.priceWeight));
    ck('Deskripsi tetap bobot normal (hierarki terjaga)', pkg.descWeight <= 400, String(pkg.descWeight));
    ck('Indikator jumlah sesi berada di samping judul paket', pkg.soldInTitleRow, pkg.soldText);
    ck('Indikator memakai angka dari data (bukan karangan)', /\d/.test(pkg.soldText), pkg.soldText);
    ck('Dot indikator beranimasi pulse lembut', /soldPulse/.test(pkg.pulse), pkg.pulse);
    ck('Heading section berbobot SemiBold/Bold', pkg.headingWeight >= 600, String(pkg.headingWeight));

    /* ============================================================
       04. Booking 24 jam
       ============================================================ */
    await deskPage.goto(`${BASE}/booking`, { waitUntil: 'load' });
    const timeInput = await deskPage.evaluate(() => {
      const el = document.querySelector('input[name="shooting_time"]');
      const label = el ? el.closest('.field') : null;
      return {
        min: el ? el.getAttribute('min') : '',
        max: el ? el.getAttribute('max') : '',
        hint: label ? label.innerText : ''
      };
    });
    ck('Time picker membuka 00:00–23:59', timeInput.min === '00:00' && timeInput.max === '23:59', `${timeInput.min}–${timeInput.max}`);
    ck('Keterangan menjelaskan ketersediaan 24 jam', /24 jam|00:00/.test(timeInput.hint), timeInput.hint.slice(0, 60));

    // server: jam 00:30 & 23:00 diterima, format 24:00 ditolak
    const mkBooking = (time) => deskPage.request.post(`${BASE}/booking`, {
      form: {
        client_name: 'Uji Jam ' + time.replace(':', ''),
        client_phone: '081234567890', instagram: 'ujijam', campus: 'ITB',
        kota: '', shooting_date: '', shooting_time: time, location: 'Bandung',
        paket: '', durasi: '', terms: '1'
      },
      maxRedirects: 0
    });
    const rEarly = await mkBooking('00:30');
    const bodyEarly = rEarly.status() === 422 ? await rEarly.text() : '';
    ck('Jam 00:30 tidak ditolak karena batas jam',
      !/antara 06:00 dan 21:00/i.test(bodyEarly), `${rEarly.status()}`);
    const rLate = await mkBooking('23:00');
    const bodyLate = rLate.status() === 422 ? await rLate.text() : '';
    ck('Jam 23:00 tidak ditolak karena batas jam', !/antara 06:00 dan 21:00/i.test(bodyLate), `${rLate.status()}`);

    /* ============================================================
       02–03. Client Portal responsive + login
       ============================================================ */
    for (const [label, vp] of [['320', { width: 320, height: 640 }], ['390', { width: 390, height: 844 }],
      ['820', { width: 820, height: 1180 }], ['1440', { width: 1440, height: 950 }]]) {
      const b = await chromium.launch();
      const p = await b.newPage({ viewport: vp, isMobile: vp.width < 900, hasTouch: vp.width < 900 });
      await p.goto(`${BASE}/portal`, { waitUntil: 'load' });
      const info = await p.evaluate(() => {
        const card = document.querySelector('.cp-login__card');
        const btn = document.querySelector('.cp-login__btn');
        const h1 = document.querySelector('.cp-login__head h1');
        const r = card.getBoundingClientRect();
        return {
          cardW: Math.round(r.width), viewportW: window.innerWidth,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          btnRadius: getComputedStyle(btn).borderRadius,
          btnW: Math.round(btn.getBoundingClientRect().width),
          cardRadius: parseFloat(getComputedStyle(card).borderTopLeftRadius),
          h1Size: parseFloat(getComputedStyle(h1).fontSize),
          bgDark: (() => {
            const bg = document.querySelector('.cp-login__bg');
            const c = getComputedStyle(bg).backgroundColor;
            return c;
          })()
        };
      });
      ck(`[${label}] login: kartu tidak melebihi layar`, info.cardW <= info.viewportW - 8, `${info.cardW}/${info.viewportW}`);
      ck(`[${label}] login: tanpa overflow horizontal`, info.overflow <= 1, `${info.overflow}px`);
      ck(`[${label}] login: tombol pill selebar kartu`, parseFloat(info.btnRadius) >= 100 && info.btnW > info.cardW * 0.6,
        `${info.btnRadius} / ${info.btnW}`);
      ck(`[${label}] login: kartu bersudut membulat besar`, info.cardRadius >= 16, String(info.cardRadius));
      ck(`[${label}] login: heading proporsional`, info.h1Size >= 20 && info.h1Size <= 34, `${info.h1Size}px`);
      await b.close();
    }

    // portal pages responsive (login dulu)
    if (fx) {
      for (const [label, vp] of [['390', { width: 390, height: 844 }], ['1440', { width: 1440, height: 950 }]]) {
        const b = await chromium.launch();
        const p = await b.newPage({ viewport: vp, isMobile: vp.width < 900, hasTouch: vp.width < 900 });
        await p.goto(`${BASE}/portal`, { waitUntil: 'load' });
        await p.fill('input[name="code"]', fx.code);
        await p.fill('input[name="pin"]', '1357');
        await Promise.all([p.waitForNavigation(), p.click('.cp-login__btn')]);
        for (const url of ['/portal/ringkasan', '/portal/pantau-order', '/portal/drive']) {
          await p.goto(BASE + url, { waitUntil: 'load' });
          const ov = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          ck(`[${label}] ${url} tanpa overflow`, ov <= 1, `${ov}px`);
        }
        const sizes = await p.evaluate(() => ({
          h1: parseFloat(getComputedStyle(document.querySelector('.cp-page__head h1')).fontSize),
          body: parseFloat(getComputedStyle(document.body).fontSize)
        }));
        ck(`[${label}] ukuran teks portal proporsional`, sizes.h1 <= 42 && sizes.body <= 17, JSON.stringify(sizes));
        await b.close();
      }
    }

    ck('Tidak ada error JavaScript di halaman yang diuji', errors.length === 0, errors.slice(0, 2).join(' | '));
    await deskBrowser.close();
  } finally {
    await browser.close();
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

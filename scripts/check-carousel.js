'use strict';

/**
 * V20 — carousel portfolio (revisi 11/12/16 + v13).
 *
 * Diuji:
 *  - Home "Featured Portfolio": SATU jalur horizontal, semua slide sebaris,
 *    hanya karya unggulan (is_featured = 1), autoplay bergerak sendiri lalu
 *    berhenti saat pengguna menyentuh, tanpa dots, tombol EXPLORE MORE WORKS
 *    menuju /gallery, dan klik kartu membuka /portfolio/<slug> yang benar.
 *  - Gallery / Portfolio Highlights: satu jalur horizontal, dots ada, panah
 *    menggeser track, swipe/drag berfungsi, overlay caption 2 baris + Montserrat.
 *  - Mobile: 1 kartu + peek (bukan grid 2 kolom), tidak ada overflow vertikal
 *    (kartu tidak turun ke baris berikutnya), halaman tidak overflow horizontal.
 *  - prefers-reduced-motion: tidak ada pergerakan otomatis.
 *
 * node scripts/check-carousel.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `dly-car-${process.pid}`);
const PORT = 3500 + (process.pid % 60);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'public', 'review-carousel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
function ck(label, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok  ', label, extra); }
  else { fails.push(label + (extra ? ` — ${extra}` : '')); console.log('  FAIL', label, extra); }
}

function prepare() {
  fs.mkdirSync(TMP, { recursive: true });
  ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'].forEach((f) => {
    const src = path.join(ROOT, 'data', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, f));
  });
}

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return true; } catch (err) { /* retry */ }
    await sleep(400);
  }
  return false;
}

/** Posisi semua slide: sebaris kalau semua offsetTop sama. */
const metrics = () => {
  const roots = Array.from(document.querySelectorAll('[data-pf-carousel]'));
  return roots.map((root) => {
    const vp = root.querySelector('[data-pf-viewport]');
    const slides = Array.from(root.querySelectorAll('.pf-carousel__slide'));
    const tops = slides.map((s) => Math.round(s.getBoundingClientRect().top));
    const card = slides[0] ? slides[0].querySelector('.portfolio-card') : null;
    const img = card ? card.querySelector('img') : null;
    const cap = card ? card.querySelector('.portfolio-card__caption') : null;
    const name = card ? card.querySelector('.portfolio-card__name') : null;
    const shade = card ? card.querySelector('.portfolio-card__shade') : null;
    const cs = name ? getComputedStyle(name) : null;
    const shadeCs = shade ? getComputedStyle(shade) : null;
    const capBox = cap ? cap.getBoundingClientRect() : null;
    const cardBox = card ? card.getBoundingClientRect() : null;
    return {
      cls: root.className,
      slides: slides.length,
      singleRow: new Set(tops).size === 1,
      tops,
      scrollLeft: vp ? Math.round(vp.scrollLeft) : 0,
      scrollable: vp ? vp.scrollWidth - vp.clientWidth : 0,
      vpWidth: vp ? Math.round(vp.clientWidth) : 0,
      slideWidth: slides[0] ? Math.round(slides[0].getBoundingClientRect().width) : 0,
      dots: root.querySelectorAll('[data-pf-dots] .pf-carousel__dot').length,
      hrefs: slides.map((s) => {
        const a = s.querySelector('a.portfolio-card__btn');
        return a ? a.getAttribute('href') : '';
      }),
      caption: {
        font: cs ? cs.fontFamily : '',
        weight: cs ? cs.fontWeight : '',
        insidePhoto: Boolean(capBox && cardBox && capBox.bottom <= cardBox.bottom + 1 && capBox.top > cardBox.top),
        shadeGradient: shadeCs ? shadeCs.backgroundImage.slice(0, 40) : '',
        shadow: cs ? cs.textShadow : '',
        lines: cap ? cap.querySelectorAll('.portfolio-card__name, .portfolio-card__sub').length : 0,
        sub: card && card.querySelector('.portfolio-card__sub')
          ? card.querySelector('.portfolio-card__sub').textContent.trim() : ''
      },
      imgRatio: img ? (img.getBoundingClientRect().width / img.getBoundingClientRect().height).toFixed(2) : ''
    };
  });
};

async function run() {
  prepare();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: TMP },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (b) => logs.push(String(b)));
  child.stderr.on('data', (b) => logs.push(String(b)));
  if (!(await waitUp())) {
    console.error('server tidak siap\n' + logs.join(''));
    child.kill('SIGKILL');
    process.exit(1);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  const db = new Database(path.join(TMP, 'app.sqlite'), { readonly: true });
  const featuredRows = db.prepare('SELECT slug FROM portfolio WHERE is_active = 1 AND is_featured = 1 ORDER BY sort_order, id DESC').all();
  const publicRows = db.prepare('SELECT slug FROM portfolio WHERE is_active = 1 ORDER BY sort_order, id DESC').all();
  db.close();

  const browser = await chromium.launch();

  /* ---------------- HOME (desktop) ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const res = await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    ck('Home 200', res.status() === 200);
    const m = (await page.evaluate(metrics))[0];
    ck('Home: carousel featured ada', Boolean(m) && m.cls.includes('pf-carousel--featured'));
    ck('Home: semua slide dalam SATU baris (bukan grid)', m.singleRow, JSON.stringify(m.tops));
    ck('Home: bukan grid 2 kolom (kartu < 42% lebar viewport)', m.slideWidth < m.vpWidth * 0.42,
      `${m.slideWidth}/${m.vpWidth}`);
    ck('Home: autoplay berjalan (bisa digeser)', m.scrollable > 40, `scrollable=${m.scrollable}`);
    ck('Home: ada tombol panah', await page.locator('[data-pf-prev]').count() > 0);
    ck('Home: tanpa dots (beda dari gallery)', m.dots === 0, String(m.dots));
    const hrefs = m.hrefs.filter(Boolean).map((h) => h.replace(/^.*\/portfolio\//, ''));
    ck('Home: hanya karya unggulan yang tampil',
      hrefs.length === featuredRows.length && hrefs.every((s) => featuredRows.some((f) => f.slug === s)),
      JSON.stringify(hrefs));
    ck('Home: ada tombol EXPLORE MORE WORKS → /gallery',
      await page.locator('a.pf-carousel__more[href$="/gallery"]').count() > 0);
    ck('Home: overlay caption menempel di dalam foto', m.caption.insidePhoto);
    ck('Home: caption 2 baris (nama + kampus • tanggal)', m.caption.lines === 2 && /•/.test(m.caption.sub), m.caption.sub);
    ck('Home: caption Montserrat Bold', /Montserrat/.test(m.caption.font) && Number(m.caption.weight) >= 700, `${m.caption.font} ${m.caption.weight}`);
    ck('Home: gradient gelap transparan di bawah foto', /gradient/.test(m.caption.shadeGradient));
    ck('Home: text-shadow tipis pada nama', /rgba?\(/.test(m.caption.shadow), m.caption.shadow);

    // Klik kartu → detail karya yang benar
    const firstHref = m.hrefs[0];
    await page.locator('.pf-carousel--featured a.portfolio-card__btn').first().click();
    await page.waitForLoadState('networkidle');
    ck('Home: klik kartu membuka detail karya yang benar', page.url().endsWith(firstHref), page.url());
    await page.goBack({ waitUntil: 'networkidle' });

    // Autoplay benar-benar bergerak
    const before = await page.evaluate(() => {
      const vp = document.querySelector('.pf-carousel--featured [data-pf-viewport]');
      return Math.round(vp.scrollLeft);
    });
    await sleep(7500);
    const after = await page.evaluate(() => {
      const vp = document.querySelector('.pf-carousel--featured [data-pf-viewport]');
      return Math.round(vp.scrollLeft);
    });
    ck('Home: autoplay menggeser track tanpa interaksi', after !== before, `${before} → ${after}`);

    // Hover → berhenti sementara
    await page.locator('.pf-carousel--featured [data-pf-viewport]').hover();
    const h1 = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--featured [data-pf-viewport]').scrollLeft));
    await sleep(7000);
    const h2 = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--featured [data-pf-viewport]').scrollLeft));
    ck('Home: autoplay berhenti saat pointer di atas carousel', h1 === h2, `${h1} → ${h2}`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Home: tidak ada overflow horizontal halaman', overflow <= 0, String(overflow));
    await page.screenshot({ path: path.join(SHOTS, 'home-desktop.png'), fullPage: false });
    await page.close();
    await ctx.close();
  }

  /* ---------------- HOME (mobile) ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const m = (await page.evaluate(metrics))[0];
    ck('Home mobile: satu kartu utama + peek kartu berikutnya',
      m.slideWidth > m.vpWidth * 0.7 && m.slideWidth < m.vpWidth, `${m.slideWidth}/${m.vpWidth}`);
    ck('Home mobile: satu baris', m.singleRow);
    const noVOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Home mobile: tidak ada overflow horizontal', noVOverflow <= 0, String(noVOverflow));
    await page.screenshot({ path: path.join(SHOTS, 'home-mobile.png'), fullPage: false });
    await page.close();
    await ctx.close();
  }

  /* ---------------- GALLERY (desktop) ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const res = await page.goto(BASE + '/gallery', { waitUntil: 'networkidle' });
    ck('Gallery 200', res.status() === 200);
    const m = (await page.evaluate(metrics))[0];
    ck('Gallery: memakai carousel--gallery', m.cls.includes('pf-carousel--gallery'));
    ck('Gallery: semua slide satu baris', m.singleRow, JSON.stringify(m.tops));
    ck('Gallery: bukan grid (tidak ada .pf-wall)', await page.locator('.pf-wall').count() === 0);
    ck('Gallery: dots ada & sesuai jumlah karya', m.dots === m.slides, `${m.dots}/${m.slides}`);
    ck('Gallery: isinya SEMUA karya publik (bukan hanya unggulan)',
      m.slides === publicRows.length, `${m.slides} vs ${publicRows.length}`);
    ck('Gallery: caption Montserrat 700 + baris "Kampus • Tanggal"',
      /Montserrat/.test(m.caption.font) && Number(m.caption.weight) >= 700 && /•/.test(m.caption.sub), m.caption.sub);
    ck('Gallery: crop portrait konsisten 4:5', Math.abs(Number(m.imgRatio) - 0.8) < 0.06, m.imgRatio);

    // Panah menggeser track
    const x0 = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--gallery [data-pf-viewport]').scrollLeft));
    await page.locator('[data-pf-next]').first().click();
    await sleep(900);
    const x1 = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--gallery [data-pf-viewport]').scrollLeft));
    ck('Gallery: panah kanan menggeser track', x1 > x0, `${x0} → ${x1}`);
    await page.locator('[data-pf-prev]').first().click();
    await sleep(900);
    const x2 = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--gallery [data-pf-viewport]').scrollLeft));
    ck('Gallery: panah kiri menggeser balik', x2 < x1, `${x1} → ${x2}`);

    // Drag manual (mouse) menggeser track
    const vp = await page.locator('.pf-carousel--gallery [data-pf-viewport]').boundingBox();
    await page.mouse.move(vp.x + vp.width - 60, vp.y + vp.height / 2);
    await page.mouse.down();
    await page.mouse.move(vp.x + 80, vp.y + vp.height / 2, { steps: 12 });
    await page.mouse.up();
    await sleep(700);
    const x3 = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--gallery [data-pf-viewport]').scrollLeft));
    ck('Gallery: drag manual menggeser track', x3 > x2, `${x2} → ${x3}`);

    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Gallery: tidak ada overflow horizontal', ov <= 0, String(ov));
    await page.screenshot({ path: path.join(SHOTS, 'gallery-desktop.png'), fullPage: false });
    await page.close();
    await ctx.close();
  }

  /* ---------------- GALLERY (mobile) ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/gallery', { waitUntil: 'networkidle' });
    const m = (await page.evaluate(metrics))[0];
    ck('Gallery mobile: satu kartu utama + peek', m.slideWidth > m.vpWidth * 0.7 && m.slideWidth < m.vpWidth, `${m.slideWidth}/${m.vpWidth}`);
    ck('Gallery mobile: satu baris (kartu tidak turun)', m.singleRow);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Gallery mobile: tidak ada overflow horizontal', ov <= 0, String(ov));
    // Swipe (touch) lewat CDP agar gestur asli, bukan scrollLeft manual
    const box = await page.locator('.pf-carousel--gallery [data-pf-viewport]').boundingBox();
    const cx = box.x + box.width - 30;
    const cy = box.y + box.height / 2;
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
    for (let i = 1; i <= 6; i += 1) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - i * 30, y: cy }] });
      await sleep(30);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(900);
    const after = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--gallery [data-pf-viewport]').scrollLeft));
    ck('Gallery mobile: swipe menggeser track', after > 40, String(after));
    await page.screenshot({ path: path.join(SHOTS, 'gallery-mobile.png'), fullPage: false });
    await page.close();
    await ctx.close();
  }

  /* ---------------- tablet ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/gallery', { waitUntil: 'networkidle' });
    const m = (await page.evaluate(metrics))[0];
    ck('Gallery tablet: satu baris + beberapa kartu terlihat', m.singleRow && m.slideWidth < m.vpWidth);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Gallery tablet: tidak ada overflow horizontal', ov <= 0, String(ov));
    await page.screenshot({ path: path.join(SHOTS, 'gallery-tablet.png') });
    await page.close();
    await ctx.close();
  }

  /* ---------------- reduced motion ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const a = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--featured [data-pf-viewport]').scrollLeft));
    await sleep(8000);
    const b = await page.evaluate(() => Math.round(document.querySelector('.pf-carousel--featured [data-pf-viewport]').scrollLeft));
    ck('Reduced motion: autoplay tidak berjalan', a === b, `${a} → ${b}`);
    await page.close();
    await ctx.close();
  }

  await browser.close();
  child.kill('SIGKILL');
  console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
  if (fails.length) { fails.forEach((f) => console.log(' - ' + f)); process.exit(1); }
}

run().catch((err) => { console.error(err); process.exit(1); });

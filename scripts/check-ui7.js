'use strict';

/**
 * Tahap 7 — UI/UX acceptance suite.
 *
 * Sidebar accordion (menus below really move), availability calendar on mobile, pricelist
 * category icons, portfolio admin form (3 sections + multi-file preview + ordering), and
 * the public client portfolio page. Runs on a COPY of the database.
 *
 *   node scripts/check-ui7.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.UI7_PORT || 4541);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = `/tmp/dly-ui7-${Date.now()}`;
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const ck = (n, c, d) => {
  if (c) { pass += 1; console.log(`  ok  ${n}`); }
  else { failures.push(n + (d ? ` — ${d}` : '')); console.log(`FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try { fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true }); } catch (e) {}
}

function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const pool = fs.readdirSync(path.join(APP, 'public', 'uploads')).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  const imgs = pool.slice(0, 5).map((f) => `/uploads/${f}`);
  if (imgs.length < 3) throw new Error('need at least 3 uploads for the gallery fixture');
  const stamp = Date.now().toString().slice(-6);
  const slug = `ui7-${stamp}`;
  const pf = Number(db.prepare(`INSERT INTO portfolio
      (title, slug, session_time, client_name, client_degree, campus, image, image_url, alt_text,
       category, collection, description, taken_at, is_active, is_featured, sort_order)
      VALUES (?, ?, '09:15', 'Uji Tujuh', 'S.Kom.', 'Institut Uji Tujuh', ?, ?, '', 'individual', 'portfolio',
              'Deskripsi uji.', '2026-10-12', 1, 1, 3)`)
    .run('Uji Tujuh', slug, imgs[0], imgs[0]).lastInsertRowid);
  const ins = db.prepare("INSERT INTO portfolio_images (portfolio_id, image, caption, is_primary, sort_order) VALUES (?, ?, '', 0, ?)");
  [1, 2, 3].forEach((i) => ins.run(pf, imgs[i], i));
  // A package with a photo gallery so the pricelist carousel + icons are visible.
  const pkg = db.prepare('SELECT id FROM packages WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  const insPkg = db.prepare("INSERT INTO package_images (package_id, image, caption, is_primary, sort_order) VALUES (?, ?, '', 0, ?)");
  insPkg.run(pkg.id, imgs[0], 0);
  insPkg.run(pkg.id, imgs[1], 1);
  db.close();
  return { pf, slug };
}

(async () => {
  prepare();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    // PUBLIC_CACHE_MS=0: suite ini menulis konten publik LANGSUNG ke DB, jadi mikro-cache
    // halaman publik dimatikan agar hasilnya deterministik (cache diuji terpisah oleh
    // .testrun/verify-publiccache.js).
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1', PUBLIC_CACHE_MS: '0' },
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

    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());

    /* ---------------- public: pricelist category icons ---------------- */
    await page.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    const cats = await page.evaluate(() => Array.from(document.querySelectorAll('.cat-pill')).map((el) => ({
      slug: el.getAttribute('data-cat-tab'),
      hasIcon: Boolean(el.querySelector('.cat-pill__icon svg')),
      iconPath: (el.querySelector('.cat-pill__icon svg path') || {}).getAttribute
        ? el.querySelector('.cat-pill__icon svg path').getAttribute('d')
        : '',
      name: (el.querySelector('.cat-pill__name') || {}).textContent || '',
      iconSize: el.querySelector('.cat-pill__icon')
        ? parseFloat(getComputedStyle(el.querySelector('.cat-pill__icon')).width) : 0
    })));
    ck('Every package category shows an icon', cats.length > 0 && cats.every((c) => c.hasIcon), JSON.stringify(cats.map((c) => [c.slug, c.hasIcon])));
    ck('Individual / couple / group use different icons',
      new Set(cats.map((c) => c.iconPath)).size >= Math.min(3, cats.length),
      cats.map((c) => c.slug).join(','));
    ck('Category names were not changed by the icon work', cats.every((c) => /Package|Individu|Couple|Group/i.test(c.name)),
      cats.map((c) => c.name).join(' | '));
    ck('Icons are proportional (26–34px)', cats.every((c) => c.iconSize >= 24 && c.iconSize <= 36), String(cats[0] && cats[0].iconSize));

    const carouselSlides = await page.locator('[data-pkg-carousel] .pkg-carousel__slide').count();
    ck('The package carousel still renders with the gallery photos', carouselSlides >= 2, String(carouselSlides));

    /* ---------------- public: portfolio identity + client page ---------------- */
    await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    const card = await page.evaluate((slug) => {
      const a = document.querySelector(`.portfolio-card__btn[href$="${slug}"]`);
      if (!a) return null;
      const name = a.querySelector('.portfolio-card__name');
      const sub = a.querySelector('.portfolio-card__sub');
      return {
        name: name ? name.textContent.trim() : '',
        nameSize: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
        sub: sub ? sub.textContent.trim() : '',
        subSize: sub ? parseFloat(getComputedStyle(sub).fontSize) : 0,
        href: a.getAttribute('href')
      };
    }, fx.slug);
    ck('Gallery thumbnail shows the client name + degree', Boolean(card && card.name === 'Uji Tujuh, S.Kom.'), card && card.name);
    ck('Gallery thumbnail shows campus and date below the name',
      Boolean(card && card.sub.includes('Institut Uji Tujuh') && card.sub.includes('12 Oktober 2026')), card && card.sub);
    ck('Name is the most prominent line on the thumbnail', Boolean(card && card.nameSize > card.subSize), card && `${card.nameSize} vs ${card.subSize}`);
    ck('Thumbnail links to the client page', Boolean(card && card.href.endsWith(`/portfolio/${fx.slug}`)), card && card.href);

    // Featured portfolio on the homepage uses the same card
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    const featured = await page.evaluate((slug) => {
      const a = document.querySelector(`.section--featured .portfolio-card__btn[href$="${slug}"]`);
      if (!a) return null;
      return {
        name: (a.querySelector('.portfolio-card__name') || {}).textContent || '',
        sub: (a.querySelector('.portfolio-card__sub') || {}).textContent || ''
      };
    }, fx.slug);
    ck('Featured portfolio on the homepage shows the same identity block',
      Boolean(featured && featured.name.includes('Uji Tujuh') && featured.sub.includes('Institut Uji Tujuh')),
      featured ? `${featured.name} | ${featured.sub}` : 'not found');

    const detail = await page.goto(`${BASE}/portfolio/${fx.slug}`, { waitUntil: 'load' });
    ck('Client portfolio page loads', detail.status() === 200, String(detail.status()));
    const head = await page.locator('.pf-head').innerText();
    ck('Client page header shows name, campus, date and time',
      head.includes('Uji Tujuh, S.Kom.') && head.includes('Institut Uji Tujuh')
      && /12 Oktober 2026/.test(head) && head.includes('09:15'), head.replace(/\n/g, ' | ').slice(0, 140));
    const tiles = await page.locator('.pf-tile').count();
    ck('Client page gallery shows only that client\'s extra photos', tiles === 3, String(tiles));
    await page.locator('.pf-cover__btn').click();
    await sleep(300);
    ck('Lightbox works from the client page', await page.isVisible('[data-lightbox-modal]'));
    ck('Lightbox knows the full photo set', (await page.locator('[data-lb-counter]').innerText()).trim() === '1 / 4');
    await page.locator('[data-lb-close]').click();

    /* ---------------- admin login ---------------- */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    /* ---------------- sidebar accordion geometry ---------------- */
    await page.goto(`${BASE}/admin/bookings`, { waitUntil: 'load' });
    // offsetTop (layout) instead of getBoundingClientRect: the sidebar scrolls, so viewport
    // coordinates go negative and make the movement impossible to compare.
    const groupBoxes = async () => page.evaluate(() => {
      const out = {};
      document.querySelectorAll('[data-nav-group]').forEach((g) => {
        out[g.getAttribute('data-nav-group')] = Math.round(g.offsetTop);
      });
      return out;
    });
    // Ensure exactly one state: open everything, then close "konten".
    const heads = page.locator('[data-nav-group] [data-nav-toggle-group]');
    const count = await heads.count();
    for (let i = 0; i < count; i += 1) {
      const open = await page.locator('[data-nav-group]').nth(i).evaluate((el) => el.classList.contains('is-open'));
      if (!open) await heads.nth(i).click();
    }
    await sleep(450);
    const allOpen = await groupBoxes();
    await page.click('[data-nav-group="konten"] [data-nav-toggle-group]');
    await sleep(500);
    const kontenClosed = await groupBoxes();
    ck('Closing a group really shrinks the sidebar (groups below move UP)',
      kontenClosed.katalog < allOpen.katalog && kontenClosed.operasional < allOpen.operasional,
      `katalog ${allOpen.katalog}→${kontenClosed.katalog}, operasional ${allOpen.operasional}→${kontenClosed.operasional}`);
    ck('Group directly below moves up by the collapsed height (no empty gap left behind)',
      allOpen.katalog - kontenClosed.katalog > 20,
      String(allOpen.katalog - kontenClosed.katalog));

    await page.click('[data-nav-group="konten"] [data-nav-toggle-group]');
    await sleep(500);
    const reopened = await groupBoxes();
    ck('Opening it again pushes the groups below back DOWN',
      reopened.katalog > kontenClosed.katalog && Math.abs(reopened.katalog - allOpen.katalog) <= 2,
      `katalog ${kontenClosed.katalog}→${reopened.katalog} (open state was ${allOpen.katalog})`);

    const samples = await page.evaluate(() => new Promise((resolve) => {
      const grp = document.querySelector('[data-nav-group="konten"]');
      const btn = grp.querySelector('[data-nav-toggle-group]');
      const last = () => {
        const gs = document.querySelectorAll('[data-nav-group]');
        return Math.round(gs[gs.length - 1].offsetTop);
      };
      btn.click(); // close
      const out = [];
      let n = 0;
      const t = setInterval(() => {
        out.push(last());
        if (++n >= 10) { clearInterval(t); resolve(out); }
      }, 30);
    }));
    const monotonic = samples.every((v, i) => i === 0 || v <= samples[i - 1] + 1);
    ck('The collapse animates smoothly (no jump, values only decrease)',
      monotonic && samples[samples.length - 1] < samples[0],
      samples.join(' → '));

    const activeGroup = await page.evaluate(() => {
      const g = document.querySelector('[data-nav-group="operasional"]');
      return g ? g.classList.contains('is-open') : false;
    });
    ck('The group containing the active page is open on load', activeGroup);

    /* ---------------- availability calendar (desktop + mobile) ---------------- */
    await page.goto(`${BASE}/admin/availability`, { waitUntil: 'load' });
    const cells = await page.locator('.avail-cell').count();
    ck('The availability calendar renders its day cells', cells >= 28, String(cells));
    ck('Legend explains Tersedia / Full Booking / Ditutup',
      /Tersedia/.test(await page.locator('.avail-legend').innerText())
      && /Full Booking/.test(await page.locator('.avail-legend').innerText())
      && /Ditutup/.test(await page.locator('.avail-legend').innerText()));

    const overflowDesk = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Availability page has no horizontal overflow (desktop)', overflowDesk <= 0, `${overflowDesk}px`);

    /* ---------------- portfolio admin form ---------------- */
    await page.goto(`${BASE}/admin/portfolio/${fx.pf}/edit`, { waitUntil: 'load' });
    const legends = await page.locator('.pf-form legend, #galeri legend').allInnerTexts();
    ck('Portfolio form is split into Information / Display / Gallery sections',
      legends.some((l) => /Informasi Client/i.test(l))
      && legends.some((l) => /pengaturan tampilan/i.test(l))
      && legends.some((l) => /Galeri foto/i.test(l)), legends.join(' | '));
    ck('The gallery lists the existing photos with numbers', await page.locator('.pf-photo').count() === 3);
    ck('Multi-file upload input exists', await page.locator('input[name="photo_files"][multiple]').count() === 1);
    ck('A separate URL upload path is offered', await page.locator('textarea[name="photo_urls"]').count() === 1);
    ck('Images are lazy-loaded in the gallery grid',
      (await page.locator('.pf-photo img[loading="lazy"]').count()) === 3);

    // Preview before upload.
    const stamp2 = Date.now();
    // Use a real JPEG from the uploads folder: the image pipeline must be able to build
    // derivatives, and a 1x1 stub would (correctly) fail conversion.
    const realUploads = fs.readdirSync(path.join(APP, 'public', 'uploads')).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
    const srcImg = path.join(APP, 'public', 'uploads', realUploads[0]);
    const f1 = path.join(require('os').tmpdir(), `ui7-a-${stamp2}${path.extname(srcImg)}`);
    const f2 = path.join(require('os').tmpdir(), `ui7-b-${stamp2}${path.extname(srcImg)}`);
    fs.copyFileSync(srcImg, f1); fs.copyFileSync(srcImg, f2);
    await page.setInputFiles('input[name="photo_files"]', [f1, f2]);
    await sleep(400);
    ck('Preview shows every selected file before uploading', await page.locator('.pf-preview__item').count() === 2);
    ck('Preview shows the file name and size',
      /ui7-a/.test(await page.locator('.pf-preview').innerText()) && /KB|MB/.test(await page.locator('.pf-preview').innerText()));
    const disabled = await page.locator('[data-upload-submit]').isDisabled();
    ck('The upload button becomes enabled with files selected', disabled === false);
    // Remove one from the selection.
    await page.locator('.pf-preview__x').first().click();
    await sleep(200);
    ck('A selected file can be removed before uploading', await page.locator('.pf-preview__item').count() === 1);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.click('[data-upload-submit]')
    ]);
    ck('Uploading the remaining photo adds it to the gallery', await page.locator('.pf-photo').count() === 4);

    // Reorder with the arrow buttons (touch-friendly alternative to drag & drop).
    const firstIdBefore = await page.locator('.pf-photo').first().getAttribute('data-photo-id');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.locator('.pf-photo').first().locator('[data-move="1"]').click()
    ]).catch(async () => {
      // the arrow saves via fetch (no navigation) — give it a moment
      await sleep(800);
    });
    const orderAfter = await page.evaluate(() => Array.from(document.querySelectorAll('.pf-photo'))
      .map((el) => el.getAttribute('data-photo-id')));
    ck('Arrow buttons reorder the gallery', orderAfter[0] !== firstIdBefore, `${firstIdBefore} now at ${orderAfter.indexOf(firstIdBefore)}`);
    const savedOrder = await (async () => {
      const d = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const rows = d.prepare('SELECT id, sort_order FROM portfolio_images WHERE portfolio_id = ? ORDER BY sort_order').all(fx.pf);
      d.close();
      return rows;
    })();
    ck('The new order is persisted in the database',
      String(savedOrder[0].id) === String(orderAfter[0]), JSON.stringify(savedOrder));
    const publicOrder = await page.goto(`${BASE}/portfolio/${fx.slug}`, { waitUntil: 'load' })
      .then(() => page.evaluate(() => Array.from(document.querySelectorAll('.pf-tile img')).map((i) => i.getAttribute('src'))));
    ck('The public page follows the admin order', publicOrder.length === 4, String(publicOrder.length));

    /* ---------------- mobile ---------------- */
    const mobBrowser = await chromium.launch();
    const mob = await mobBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mob.goto(`${BASE}/admin/login`, { waitUntil: 'load' });
    await mob.fill('input[name="username"]', USER);
    await mob.fill('input[name="password"]', PASS);
    await Promise.all([mob.waitForNavigation(), mob.click('button[type="submit"]')]);

    for (const url of ['/admin/bookings/9?tab=workflow', '/admin/availability', `/admin/portfolio/${fx.pf}/edit`, '/admin/bookings/9?tab=pembayaran']) {
      await mob.goto(BASE + url, { waitUntil: 'load' });
      const ov = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (ov > 1) {
        const culprits = await mob.evaluate(() => {
          const out = [];
          document.querySelectorAll('body *').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.right > window.innerWidth + 0.5 && r.width > 10) {
              out.push(`${el.tagName}.${String(el.className).split(' ')[0]}(${Math.round(r.width)})`);
            }
          });
          return out.slice(0, 5);
        });
        console.log('      wide:', culprits.join(', '));
      }
      ck(`Mobile ${url} has no horizontal overflow`, ov <= 1, `${ov}px`);
    }
    // Data-aware: pemilik bisa menghapus booking, jadi jangan pakai id tertentu.
    await mob.goto(`${BASE}/admin/bookings?view=grid`, { waitUntil: 'load' });
    const firstId = await mob.evaluate(() => {
      const card = document.querySelector('.bk-card[id^="b-"]');
      return card ? card.id.replace('b-', '') : '';
    });
    ck('Ada booking untuk diuji di halaman detail', Boolean(firstId), firstId);
    await mob.goto(`${BASE}/admin/bookings/${firstId}?tab=workflow`, { waitUntil: 'load' });
    const tapSizes = await mob.evaluate(() => {
      const pick = document.querySelector('[data-team-select]');
      const btn = document.querySelector('.admin-btn');
      return {
        pick: pick ? Math.round(pick.getBoundingClientRect().height) : 0,
        btn: btn ? Math.round(btn.getBoundingClientRect().height) : 0
      };
    });
    ck('Team dropdown is large enough to tap', tapSizes.pick >= 40, String(tapSizes.pick));
    ck('Buttons are large enough to tap', tapSizes.btn >= 32, String(tapSizes.btn));
    await mob.goto(`${BASE}/admin/availability`, { waitUntil: 'load' });
    await mob.evaluate(() => {
      // Only real day cells carry data-avail-day (the leading blanks do not).
      const cells = Array.from(document.querySelectorAll('[data-avail-day]')).filter((c) => !c.disabled);
      const cell = cells[3] || cells[0];
      if (cell) { cell.scrollIntoView({ block: 'center' }); cell.click(); }
    });
    await sleep(400);
    const panelOpen = await mob.evaluate(() => {
      const el = document.querySelector('[data-avail-panel]');
      return Boolean(el) && el.hidden === false;
    });
    ck('Full Booking panel opens on mobile', panelOpen);
    const panelBox = await mob.locator('[data-avail-panel]').boundingBox();
    ck('The panel fits the mobile viewport', Boolean(panelBox && panelBox.width <= 390), panelBox && String(Math.round(panelBox.width)));
    await mob.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    const mobCat = await mob.evaluate(() => {
      const el = document.querySelector('.cat-pill');
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), icon: Boolean(el.querySelector('.cat-pill__icon svg')) };
    });
    ck('Category cards stay usable on mobile (icon + readable size)', mobCat.icon && mobCat.w >= 150 && mobCat.h >= 60, JSON.stringify(mobCat));
    await mob.goto(`${BASE}/portfolio/${fx.slug}`, { waitUntil: 'load' });
    const mobOv = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('Client portfolio page has no horizontal overflow on mobile', mobOv <= 1, `${mobOv}px`);

    ck('No JavaScript errors across the tested pages', errors.length === 0, errors.slice(0, 2).join(' | '));
    await mobBrowser.close();
    await page.close();
  } finally {
    await browser.close();
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

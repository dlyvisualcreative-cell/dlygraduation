'use strict';

/**
 * Tahap 6 acceptance suite — portfolio client pages, pricelist photo carousel, city
 * buttons, package category cards, header, mobile dropdown, admin sidebar and typography.
 *
 * Boots the app on its own port against a COPY of the database in /tmp, seeds a demo
 * portfolio with several photos and a package with a photo gallery, then drives it with
 * Playwright. The live database is never touched.
 *
 *   node scripts/check-t6.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.T6_PORT || 4536);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = `/tmp/dly-t6-${Date.now()}`;
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'DlyGraduation2025';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

function prepareDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  try {
    fs.cpSync(path.join(APP, 'data', 'image-cache'), path.join(DATA_DIR, 'image-cache'), { recursive: true });
  } catch (err) { /* cold cache is fine */ }
}

/** Demo rows, written after boot (the additive migrations run on boot). */
function seed() {
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const stamp = Date.now().toString().slice(-6);

  const uploads = fs.readdirSync(path.join(APP, 'public', 'uploads'))
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).slice(0, 6).map((f) => `/uploads/${f}`);
  const pool = uploads.length >= 4 ? uploads : ['/ph/portfolio-portrait-1.svg', '/ph/portfolio-couple.svg', '/ph/portfolio-group.svg', '/ph/portfolio-event.svg'];

  const city = db.prepare('SELECT id FROM cities ORDER BY id LIMIT 1').get();
  const slug = `uji-klien-${stamp}`;

  // A published portfolio with 4 photos + session time.
  const pf = Number(db.prepare(`INSERT INTO portfolio
      (title, slug, session_time, client_name, client_degree, campus, image, image_url, alt_text,
       category, collection, city_id, description, taken_at, is_featured, is_active, show_city, sort_order)
      VALUES (?, ?, '09:30', 'Uji Klien Enam', 'S.Kom.', 'Institut Uji T6', ?, ?, 'Uji Klien Enam',
              'individual', 'portfolio', ?, 'Sesi uji acceptance Tahap 6.', '2026-10-12', 0, 1, 0, 50)`)
    .run(`Uji Klien Enam`, slug, pool[0], pool[0], city.id).lastInsertRowid);
  const insPhoto = db.prepare('INSERT INTO portfolio_images (portfolio_id, image, caption, is_primary, sort_order) VALUES (?, ?, \'\', 0, ?)');
  [1, 2, 3].forEach((i) => insPhoto.run(pf, pool[i % pool.length], i));

  // An UNPUBLISHED portfolio that must never be reachable.
  const hiddenSlug = `uji-tersembunyi-${stamp}`;
  db.prepare(`INSERT INTO portfolio (title, slug, client_name, image, image_url, category, is_active, sort_order)
              VALUES ('Uji Tersembunyi', ?, 'Uji Tersembunyi', ?, ?, 'individual', 0, 51)`)
    .run(hiddenSlug, pool[0], pool[0]);

  // A package with a real photo gallery → the pricelist carousel must appear.
  const pkg = db.prepare('SELECT id FROM packages WHERE is_active = 1 AND image IS NOT NULL LIMIT 1').get()
    || db.prepare('SELECT id FROM packages LIMIT 1').get();
  const insGallery = db.prepare('INSERT INTO package_images (package_id, image, caption, is_primary, sort_order) VALUES (?, ?, \'\', 0, ?)');
  [1, 2].forEach((i) => insGallery.run(pkg.id, pool[i % pool.length], i));

  db.close();
  return { slug, hiddenSlug, pool };
}

(async () => {
  prepareDataDir();
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

    /* ============================================================
       1. PORTFOLIO KLIEN — kartu, halaman, keamanan data
       ============================================================ */
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    page.on('pageerror', (e) => errors.push(String(e)));

    const gallery = await page.goto(`${BASE}/gallery`, { waitUntil: 'load' });
    check('Gallery page loads', gallery.status() === 200);

    const cardInfo = await page.evaluate((slug) => {
      const card = document.querySelector(`.portfolio-card__btn[href$="${slug}"]`);
      if (!card) return null;
      const name = card.querySelector('.portfolio-card__name');
      const sub = card.querySelector('.portfolio-card__sub');
      return {
        href: card.getAttribute('href'),
        name: name ? name.textContent.trim() : '',
        nameSize: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
        sub: sub ? sub.textContent.trim() : '',
        subSize: sub ? parseFloat(getComputedStyle(sub).fontSize) : 0,
        isLink: card.tagName === 'A',
        hasLightbox: Boolean(card.querySelector('[data-lightbox]'))
      };
    }, fx.slug);
    check('A portfolio card links to its client page', Boolean(cardInfo && cardInfo.href === `/portfolio/${fx.slug}`), cardInfo && cardInfo.href);
    check('The card is a real link (not a lightbox trigger)', Boolean(cardInfo && cardInfo.isLink && !cardInfo.hasLightbox));
    check('The card shows the client name with the degree', Boolean(cardInfo && cardInfo.name.includes('Uji Klien Enam, S.Kom.')), cardInfo && cardInfo.name);
    check('The card shows campus and date as supporting info',
      Boolean(cardInfo && cardInfo.sub.includes('Institut Uji T6') && cardInfo.sub.includes('12 Oktober 2026')), cardInfo && cardInfo.sub);
    check('The client name is visually primary (larger than the meta line)',
      Boolean(cardInfo && cardInfo.nameSize > cardInfo.subSize), cardInfo && `${cardInfo.nameSize} vs ${cardInfo.subSize}`);
    check('The card never shows the city on the cover', Boolean(cardInfo && !/Bandung/i.test(cardInfo.sub)), cardInfo && cardInfo.sub);

    const detail = await page.goto(`${BASE}/portfolio/${fx.slug}`, { waitUntil: 'load' });
    check('The client page answers 200', detail.status() === 200, String(detail.status()));
    const head = await page.locator('.pf-head').innerText();
    check('The client page header shows name + degree', head.includes('Uji Klien Enam, S.Kom.'), head.split('\n').slice(0, 6).join(' | '));
    check('The client page header shows the campus', head.includes('Institut Uji T6'));
    check('The client page header shows the shoot date', /12 Oktober 2026/i.test(head));
    check('The client page header shows the session time', head.includes('09:30'), head.replace(/\n/g, ' ').slice(0, 120));
    check('The client page shows the photo count', /4 foto/.test(head), head.replace(/\n/g, ' ').slice(-80));

    const tileCount = await page.locator('.pf-tile').count();
    check('The client page renders a gallery of the other photos', tileCount === 3, String(tileCount));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('The client page has no horizontal overflow', overflow <= 0, `${overflow}px`);
    const lazyInfo = await page.evaluate(() => Array.from(document.querySelectorAll('.pf-tile img'))
      .map((i) => ({ loading: i.loading, complete: i.complete })));
    check('Gallery images are lazy-loaded (only the first two eager)',
      lazyInfo.slice(2).every((i) => i.loading === 'lazy'), JSON.stringify(lazyInfo.map((i) => i.loading)));

    // Lightbox + multi-photo navigation on the client page.
    await page.locator('.pf-cover__btn').click();
    await sleep(350);
    check('Cover opens the lightbox', await page.isVisible('[data-lightbox-modal]'));
    const counter = await page.locator('[data-lb-counter]').innerText();
    check('The lightbox knows the whole photo set', counter.trim() === '1 / 4', counter);
    await page.locator('[data-lb-next]').click();
    await sleep(250);
    check('Next moves to the second photo', (await page.locator('[data-lb-counter]').innerText()).trim() === '2 / 4');
    await page.locator('[data-lb-close]').click();
    await sleep(200);
    check('The lightbox closes', !(await page.isVisible('[data-lightbox-modal]')));

    const hidden = await page.goto(`${BASE}/portfolio/${fx.hiddenSlug}`, { waitUntil: 'load' });
    check('An unpublished portfolio page is NOT reachable (404)', hidden.status() === 404, String(hidden.status()));

    // No private data may leak into a public client page.
    await page.goto(`${BASE}/portfolio/${fx.slug}`, { waitUntil: 'load' });
    const publicHtml = await page.content();
    check('The client page contains no booking/payment/selection data',
      !/Rp\s?\d|client_phone|6281|payment|Catatan internal|photo_selection/i.test(publicHtml.replace(/<script[\s\S]*?<\/script>/g, '')),
      (publicHtml.match(/Rp\s?\d|6281|payment/gi) || []).slice(0, 3).join(', '));

    const sitemap = await (await page.request.get(`${BASE}/sitemap.xml`)).text();
    check('Published client pages are in the sitemap', sitemap.includes(`/portfolio/${fx.slug}`));
    check('Unpublished client pages are NOT in the sitemap', !sitemap.includes(fx.hiddenSlug));

    /* ---------------- admin: session time + slug ---------------- */
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    const pfRow = await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const row = db.prepare('SELECT * FROM portfolio WHERE slug = ?').get(fx.slug);
      db.close();
      return row;
    })();
    const editPage = await page.goto(`${BASE}/admin/portfolio/${pfRow.id}/edit`, { waitUntil: 'load' });
    check('The admin edit form loads', editPage.status() === 200);
    check('The admin form has a session-time field', await page.locator('input[name="session_time"]').count() === 1);
    check('The admin form has a slug field with a preview prefix',
      await page.locator('input[name="slug"]').count() === 1 && (await page.locator('.slug-field__prefix').innerText()).includes('/portfolio/'));
    check('The admin form links to the public client page',
      await page.locator(`a[href$="/portfolio/${fx.slug}"]`).count() >= 1);
    await page.fill('input[name="session_time"]', '14:15');
    await Promise.all([
      page.waitForNavigation(),
      // NOT the first submit on the page — the admin topbar has its own "Publish" button.
      page.click('form[action$="/admin/portfolio/save"] button[type="submit"]')
    ]);
    const savedTime = await (async () => {
      const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
      const row = db.prepare('SELECT session_time FROM portfolio WHERE id = ?').get(pfRow.id);
      db.close();
      return row.session_time;
    })();
    check('Saving the session time works', savedTime === '14:15', savedTime);

    const editor = await page.locator('.admin-nav a[href$="/admin/portfolio"]').count();
    check('Portfolio stays manageable from the sidebar', editor >= 1, String(editor));

    /* ============================================================
       2. PRICELIST — carousel foto paket
       ============================================================ */
    await page.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    await sleep(900);
    const carousel = await page.evaluate(() => {
      const c = document.querySelector('[data-pkg-carousel]');
      if (!c) return null;
      const track = c.querySelector('[data-carousel-track]');
      const slides = c.querySelectorAll('.pkg-carousel__slide');
      return {
        slides: slides.length,
        dots: c.querySelectorAll('.pkg-carousel__dot').length,
        counter: (c.querySelector('[data-carousel-counter]') || {}).textContent || '',
        snap: getComputedStyle(track).scrollSnapType,
        scrollable: track.scrollWidth > track.clientWidth + 2,
        cardH: Math.round(document.querySelector('.pkg-feature').getBoundingClientRect().height)
      };
    });
    check('The pricelist package renders a photo carousel', Boolean(carousel), 'missing');
    check('The carousel holds every package photo', carousel && carousel.slides >= 2, carousel && String(carousel.slides));
    check('The carousel shows position indicators (dots)', carousel && carousel.dots === carousel.slides, carousel && String(carousel.dots));
    check('The carousel shows a counter', Boolean(carousel && /\d \/ \d/.test(carousel.counter)), carousel && carousel.counter);
    check('The carousel is swipeable (scroll-snap + overflow)',
      Boolean(carousel && /x mandatory/.test(carousel.snap) && carousel.scrollable), carousel && carousel.snap);

    // Autoplay must move the track WITHOUT changing the card height (no layout shift).
    const before = await page.evaluate(() => {
      const c = document.querySelector('[data-pkg-carousel]');
      return { left: c.querySelector('[data-carousel-track]').scrollLeft, h: Math.round(document.querySelector('.pkg-feature').getBoundingClientRect().height) };
    });
    await sleep(7000);
    const after = await page.evaluate(() => {
      const c = document.querySelector('[data-pkg-carousel]');
      return {
        left: c.querySelector('[data-carousel-track]').scrollLeft,
        h: Math.round(document.querySelector('.pkg-feature').getBoundingClientRect().height),
        activeDot: c.querySelectorAll('.pkg-carousel__dot.is-active').length,
        counter: (c.querySelector('[data-carousel-counter]') || {}).textContent
      };
    });
    check('Autoplay advances the carousel', after.left > before.left && after.left > 50, `${before.left} → ${after.left}`);
    check('The active dot follows the current photo', after.activeDot === 1);
    check('Autoplay does not shift the layout', Math.abs(after.h - before.h) <= 2, `${before.h} → ${after.h}`);

    // Interaction pauses autoplay (hover) and manual controls take over.
    await page.locator('[data-pkg-carousel]').hover();
    const pausedAt = await page.evaluate(() => document.querySelector('[data-carousel-track]').scrollLeft);
    await sleep(6500);
    const stillPaused = await page.evaluate(() => document.querySelector('[data-carousel-track]').scrollLeft);
    check('Autoplay pauses while the visitor is interacting', Math.abs(stillPaused - pausedAt) <= 2, `${pausedAt} → ${stillPaused}`);

    await page.locator('[data-pkg-carousel] [data-carousel-next]').click();
    await sleep(700);
    const afterNext = await page.evaluate(() => document.querySelector('[data-carousel-track]').scrollLeft);
    check('The manual next button moves the carousel', afterNext !== stillPaused, `${stillPaused} → ${afterNext}`);
    await page.locator('[data-pkg-carousel] [data-carousel-dot]').first().click();
    await sleep(700);
    const backToFirst = await page.evaluate(() => ({
      left: document.querySelector('[data-carousel-track]').scrollLeft,
      active: document.querySelector('.pkg-carousel__dot.is-active').getAttribute('data-carousel-dot')
    }));
    check('Dots jump straight to a photo', backToFirst.left < 40 && backToFirst.active === '0', JSON.stringify(backToFirst));

    check('Carousel photos open the lightbox', await page.locator('[data-pkg-carousel] [data-lightbox]').count() >= 2);

    // Reduced motion: never autoplay.
    const rmBrowser = await chromium.launch();
    const rmContext = await rmBrowser.newContext({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce' });
    const rmPage = await rmContext.newPage();
    await rmPage.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    await sleep(6500);
    const rmLeft = await rmPage.evaluate(() => document.querySelector('[data-carousel-track]').scrollLeft);
    check('Reduced motion disables autoplay', rmLeft < 5, String(rmLeft));
    await rmContext.close();
    await rmBrowser.close();

    /* ============================================================
       3. KOTA LAYANAN + KATEGORI PAKET
       ============================================================ */
    await page.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    const cityPills = await page.evaluate(() => {
      const pills = Array.from(document.querySelectorAll('.city-pill'));
      const active = document.querySelector('.city-pill.is-active');
      const cs = active ? getComputedStyle(active) : null;
      const pin = active ? active.querySelector('.city-pill__pin svg') : null;
      return {
        count: pills.length,
        allHavePin: pills.every((p) => Boolean(p.querySelector('.city-pill__pin svg'))),
        radius: cs ? parseFloat(cs.borderTopLeftRadius) : 0,
        activeBg: cs ? cs.backgroundColor : '',
        activeColor: cs ? cs.color : '',
        hasAria: Boolean(active && active.getAttribute('aria-current')),
        height: active ? Math.round(active.getBoundingClientRect().height) : 0
      };
    });
    check('Every city button carries a location pin icon', cityPills.allHavePin, JSON.stringify(cityPills));
    check('City buttons are rounded (not sharp rectangles)', cityPills.radius >= 40, String(cityPills.radius));
    check('The active city is visually distinct (navy fill + white text)',
      /rgb\(11, 35, 64\)/.test(cityPills.activeBg) && /255, 255, 255/.test(cityPills.activeColor),
      `${cityPills.activeBg} / ${cityPills.activeColor}`);
    check('The active city is marked for assistive tech', cityPills.hasAria);
    check('City buttons stay comfortably tappable', cityPills.height >= 36, String(cityPills.height));

    const cats = await page.evaluate(() => {
      const pills = Array.from(document.querySelectorAll('.cat-pill'));
      const active = document.querySelector('.cat-pill.is-active');
      const inactive = pills.find((p) => !p.classList.contains('is-active'));
      const rule = active && active.querySelector('.cat-pill__rule');
      const activeName = active && active.querySelector('.cat-pill__name');
      return {
        count: pills.length,
        everyHasRule: pills.every((p) => Boolean(p.querySelector('.cat-pill__rule'))),
        radius: active ? parseFloat(getComputedStyle(active).borderTopLeftRadius) : 0,
        activeBg: active ? getComputedStyle(active).backgroundColor : '',
        activeNameColor: activeName ? getComputedStyle(activeName).color : '',
        ruleVisible: rule ? rule.getBoundingClientRect().height >= 1 : false,
        inactiveBg: inactive ? getComputedStyle(inactive).backgroundColor : '',
        nameAboveRule: (() => {
          if (!active) return false;
          const n = active.querySelector('.cat-pill__name').getBoundingClientRect();
          const r = rule.getBoundingClientRect();
          return n.bottom <= r.top + 2;
        })()
      };
    });
    check('Category tabs render as cards', cats.count >= 2, String(cats.count));
    check('Each category card has a horizontal divider under its name', cats.everyHasRule && cats.ruleVisible);
    check('The category name sits above the divider', cats.nameAboveRule);
    check('Category cards are rounded', cats.radius >= 12, String(cats.radius));
    check('The selected category uses the navy fill with white text',
      /rgb\(11, 35, 64\)/.test(cats.activeBg) && /255, 255, 255/.test(cats.activeNameColor),
      `${cats.activeBg} / ${cats.activeNameColor}`);
    check('Unselected categories stay light', /255, 255, 255/.test(cats.inactiveBg), cats.inactiveBg);

    /* ============================================================
       4. HEADER + DROPDOWN MOBILE
       ============================================================ */
    const header = await page.evaluate(() => {
      const logo = document.querySelector('.logo');
      return {
        text: Boolean(logo.querySelector('.logo__text')),
        img: Boolean(logo.querySelector('.logo__img')),
        label: logo.getAttribute('aria-label') || '',
        // Two variants exist (light label over the hero, dark label on white); measure the
        // one that is actually displayed.
        logoH: (() => {
          const imgs = Array.from(logo.querySelectorAll('.logo__img'));
          const shown = imgs.find((i) => getComputedStyle(i).display !== 'none') || imgs[0];
          return shown ? Math.round(shown.getBoundingClientRect().height) : 0;
        })(),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    check('The header no longer prints the studio name next to the logo', header.text === false, String(header.text));
    check('The logo image itself is kept', header.img === true);
    check('The brand name is still exposed for accessibility/SEO', header.label.length > 0, header.label);
    check('The logo is sized proportionally', header.logoH > 20 && header.logoH <= 60, String(header.logoH));

    const mobBrowser = await chromium.launch();
    const mob = await mobBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mob.on('pageerror', (e) => errors.push(String(e)));
    await mob.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    const closed = await mob.locator('[data-mobile-nav]').isHidden();
    check('The mobile menu starts closed', closed);
    await mob.locator('[data-nav-toggle]').click();
    await sleep(400);
    const menuOpen = await mob.evaluate(() => {
      const nav = document.querySelector('[data-mobile-nav]');
      const cs = getComputedStyle(nav);
      return {
        hidden: nav.hidden,
        open: nav.classList.contains('is-open'),
        opacity: parseFloat(cs.opacity),
        radius: parseFloat(cs.borderTopLeftRadius),
        shadow: cs.boxShadow !== 'none',
        width: Math.round(nav.getBoundingClientRect().width),
        vw: window.innerWidth,
        backdrop: Boolean(document.querySelector('.mobile-nav__backdrop.is-open')),
        items: nav.querySelectorAll('.mobile-nav__item').length,
        expanded: document.querySelector('[data-nav-toggle]').getAttribute('aria-expanded')
      };
    });
    check('Tapping the hamburger opens the menu', menuOpen.hidden === false && menuOpen.open === true);
    check('The menu animates in (opacity transition instead of a hard show)',
      menuOpen.opacity > 0.9 && menuOpen.open, String(menuOpen.opacity));
    check('The menu is a rounded floating card with a soft shadow',
      menuOpen.radius >= 12 && menuOpen.shadow, `${menuOpen.radius} / ${menuOpen.shadow}`);
    check('The menu does not cover the full screen width', menuOpen.width < menuOpen.vw - 8, `${menuOpen.width} of ${menuOpen.vw}`);
    check('A backdrop dims the page behind the menu', menuOpen.backdrop);
    check('The menu keeps every navigation item', menuOpen.items >= 6, String(menuOpen.items));
    check('aria-expanded follows the state', menuOpen.expanded === 'true');

    await mob.keyboard.press('Escape');
    await sleep(400);
    check('Escape closes the menu', await mob.evaluate(() => document.querySelector('[data-mobile-nav]').hidden === true));

    await mob.locator('[data-nav-toggle]').click();
    await sleep(300);
    await mob.locator('.mobile-nav__backdrop').click({ position: { x: 5, y: 400 } });
    await sleep(400);
    check('Tapping outside closes the menu', await mob.evaluate(() => document.querySelector('[data-mobile-nav]').hidden === true));

    await mob.locator('[data-nav-toggle]').click();
    await sleep(300);
    await Promise.all([mob.waitForNavigation({ waitUntil: 'load' }), mob.locator('.mobile-nav__item').nth(1).click()]);
    check('A menu item navigates', !mob.url().endsWith('/pricelist'), mob.url());
    check('Navigating closes the menu', await mob.evaluate(() => document.querySelector('[data-mobile-nav]').hidden === true));
    await mobBrowser.close();

    /* ============================================================
       5. SIDEBAR ADMIN (accordion) + tipografi
       ============================================================ */
    // The session from the earlier login is still valid, so /admin/login redirects to the
    // dashboard. Log in only when the form is actually there.
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    if (await page.locator('input[name="username"]').count()) {
      await page.fill('input[name="username"]', USER);
      await page.fill('input[name="password"]', PASS);
      await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    }
    await page.goto(`${BASE}/admin`, { waitUntil: 'load' });

    const groups = await page.evaluate(() => Array.from(document.querySelectorAll('[data-nav-group]')).map((g) => ({
      key: g.getAttribute('data-nav-group'),
      open: g.classList.contains('is-open'),
      icon: Boolean(g.querySelector('.nav-group__icon')),
      items: g.querySelectorAll('.admin-nav__item').length,
      transition: getComputedStyle(g.querySelector('.nav-group__body')).transitionProperty
    })));
    check('The sidebar has 6 accordion groups', groups.length === 6, String(groups.length));
    check('Every group header has an icon', groups.every((g) => g.icon));
    check('Every group expands smoothly (transition on the body)',
      groups.every((g) => /grid-template-rows/.test(g.transition)), groups[0] && groups[0].transition);
    check('The group holding the current page is open', groups.some((g) => g.open));
    const targets = await page.evaluate(() => Array.from(document.querySelectorAll('.admin-nav a')).map((a) => a.getAttribute('href')));
    ['/admin/bookings', '/admin/selection', '/admin/editing', '/admin/portfolio', '/admin/notifications', '/admin/push', '/admin/google']
      .forEach((href) => check(`Sidebar keeps the existing URL ${href}`, targets.some((t) => t === href), targets.slice(0, 5).join(', ')));

    await page.goto(`${BASE}/admin/editing`, { waitUntil: 'load' });
    const opGroupOpen = await page.locator('[data-nav-group="operasional"]').evaluate((el) => el.classList.contains('is-open'));
    check('Opening a submenu page auto-expands its parent group', opGroupOpen);

    // Typography is measured on the PUBLIC site (the admin has its own denser scale).
    await page.goto(`${BASE}/pricelist`, { waitUntil: 'load' });
    const typo = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const h1 = document.querySelector('h1');
      const lede = document.querySelector('.page-head__lede, .lede');
      const eyebrow = document.querySelector('.filter-label, .eyebrow');
      return {
        bodyFont: body.fontFamily,
        bodySize: body.fontSize,
        lineHeight: body.lineHeight,
        headingFont: h1 ? getComputedStyle(h1).fontFamily : '',
        headingSpacing: h1 ? getComputedStyle(h1).letterSpacing : '',
        ledeSize: lede ? parseFloat(getComputedStyle(lede).fontSize) : 0,
        eyebrowWeight: eyebrow ? getComputedStyle(eyebrow).fontWeight : '',
        headingBalance: h1 ? getComputedStyle(h1).textWrap || getComputedStyle(h1).textWrapStyle : ''
      };
    });
    check('The body uses a modern sans font', /Instrument Sans|Inter|Manrope|Karla|Montserrat|Poppins/i.test(typo.bodyFont), typo.bodyFont);
    check('The body font size stays at a readable 16px', typo.bodySize === '16px', typo.bodySize);
    check('The body line height is comfortable for long text',
      parseFloat(typo.lineHeight) / parseFloat(typo.bodySize) >= 1.55, typo.lineHeight);
    check('Headings use an editorial serif', /serif/i.test(typo.headingFont), typo.headingFont);
    check('Headings carry a tighter letter-spacing than body text',
      parseFloat(typo.headingSpacing) < 0, typo.headingSpacing);
    check('The intro paragraph is slightly larger than body text', typo.ledeSize >= 16, String(typo.ledeSize));
    check('Small uppercase labels are not bold (tracking does the work)',
      Number(typo.eyebrowWeight) <= 600, typo.eyebrowWeight);

    check('No JavaScript errors across the tested pages', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

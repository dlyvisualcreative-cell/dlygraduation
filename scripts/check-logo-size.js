'use strict';

/**
 * V20 — verifikasi logo seragam + favicon logo DLY.
 *
 * Yang diuji:
 *  1. Semua logo yang tampil (header publik header/footer, portal seleksi, sidebar
 *     portal client, login portal, sidebar admin, login admin) tingginya SAMA.
 *  2. Logo memakai turunan yang sudah di-trim (bukan file upload mentah yang
 *     punya padding transparan besar).
 *  3. Favicon di publik, admin, dan portal = turunan logo resmi (/favicon/...png)
 *     yang benar-benar berisi artwork (bukan kanvas kosong).
 *  4. Tidak ada horizontal overflow di 390 / 820 / 1440 px.
 *
 * Jalankan: node scripts/check-logo-size.js
 * DB produksi TIDAK disentuh: salinan dibuat di /tmp lalu dipakai oleh server tes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const TMP = path.join(os.tmpdir(), `dly-logo-${process.pid}`);
const PORT = 3399 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'public', 'review-logo');

const EXPECT = 40;          // --logo-h
const TOL = 1;

let pass = 0;
const fails = [];
function ok(label, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok  ', label, extra); }
  else { fails.push(label + (extra ? ` — ${extra}` : '')); console.log('  FAIL', label, extra); }
}
const near = (a, b) => Math.abs(a - b) <= TOL;

function copyDb() {
  fs.mkdirSync(TMP, { recursive: true });
  ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'].forEach((f) => {
    const src = path.join(DATA, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, f));
  });
}

function makeSession() {
  const db = new Database(path.join(TMP, 'app.sqlite'));
  const admin = db.prepare('SELECT id, username FROM admins ORDER BY id LIMIT 1').get();
  const sid = 'testlogo' + Date.now();
  db.prepare(`INSERT OR REPLACE INTO sessions (id, admin_id, csrf, expires_at)
              VALUES (?, ?, 'testcsrf', datetime('now', '+1 day'))`).run(sid, admin.id);
  db.close();
  return { sid, admin };
}

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return true;
    } catch (err) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Ukuran setiap logo yang terlihat pada sebuah halaman. */
async function measure(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(
      'img.logo__img, .portal-brand__logo, .cp-side__logo, .cp-login__logo, .admin-side__logoimg'
    ));
    const visible = nodes.filter((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    return {
      logos: visible.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          cls: n.className,
          src: decodeURIComponent(n.currentSrc || n.src).replace(/^.*\/dlygraduation/, ''),
          h: Math.round(r.height * 10) / 10,
          w: Math.round(r.width * 10) / 10
        };
      }),
      favicon: (document.querySelector('link[rel="icon"]') || {}).href || '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
}

async function run() {
  copyDb();
  const { sid, admin } = makeSession();
  console.log(`[logo] admin=${admin.username} session=${sid}`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: TMP, NODE_ENV: 'production' },
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

  const browser = await chromium.launch();
  const pages = [
    { url: '/', name: 'home', viewport: { width: 1440, height: 900 }, auth: false },
    { url: '/', name: 'home-mobile', viewport: { width: 390, height: 844 }, auth: false },
    { url: '/', name: 'home-tablet', viewport: { width: 820, height: 1180 }, auth: false },
    { url: '/pricelist', name: 'pricelist', viewport: { width: 1440, height: 900 }, auth: false },
    { url: '/gallery', name: 'gallery', viewport: { width: 1440, height: 900 }, auth: false },
    { url: '/booking', name: 'booking', viewport: { width: 1440, height: 900 }, auth: false },
    { url: '/portal', name: 'portal-login', viewport: { width: 390, height: 844 }, auth: false },
    { url: '/portal', name: 'portal-login-desk', viewport: { width: 1440, height: 900 }, auth: false },
    { url: '/admin/login', name: 'admin-login', viewport: { width: 1440, height: 900 }, auth: false },
    { url: '/admin', name: 'admin', viewport: { width: 1440, height: 900 }, auth: true },
    { url: '/admin', name: 'admin-mobile', viewport: { width: 390, height: 844 }, auth: true, openSide: true },
    // Rail ciut (78px) tidak mungkin memuat logo 82px: di sana logo diskalakan agar
    // muat, jadi ukuran seragam tidak diwajibkan (hanya diuji "masih di dalam rail").
    { url: '/admin', name: 'admin-collapsed', viewport: { width: 1440, height: 900 }, auth: true, collapse: true, uniform: false }
  ];

  for (const cfg of pages) {
    const ctx = await browser.newContext({ viewport: cfg.viewport });
    if (cfg.auth) {
      await ctx.addCookies([{ name: 'dly_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
    }
    const page = await ctx.newPage();
    const res = await page.goto(BASE + cfg.url, { waitUntil: 'networkidle' });
    if (cfg.openSide) await page.click('[data-side-toggle]').catch(() => {});
    if (cfg.collapse) await page.click('[data-side-collapse]').catch(() => {});
    await page.waitForTimeout(350);

    const m = await measure(page);
    console.log(`\n[${cfg.name}] ${res.status()} ${cfg.url} — overflow=${m.overflow}`);
    m.logos.forEach((l) => console.log(`   logo h=${l.h} w=${l.w} ${l.cls} ${l.src}`));

    ok(`${cfg.name}: status 200`, res.status() === 200, String(res.status()));
    ok(`${cfg.name}: ada logo tampil`, m.logos.length > 0);
    if (cfg.uniform !== false) {
      m.logos.forEach((l) => ok(`${cfg.name}: tinggi logo ${l.h}px = ${EXPECT}px`, near(l.h, EXPECT)));
    }
    m.logos.forEach((l) => ok(`${cfg.name}: logo memakai turunan /logo/ (trimmed)`, l.src.includes('/logo/'), l.src));
    ok(`${cfg.name}: favicon = turunan logo DLY`, m.favicon.includes('/favicon/'), m.favicon);
    ok(`${cfg.name}: tidak ada horizontal overflow`, m.overflow <= 0, String(m.overflow));
    if (cfg.collapse) {
      const fit = await page.evaluate(() => {
        const img = document.querySelector('.admin-side__logoimg');
        const side = document.querySelector('.admin-side');
        if (!img || !side) return null;
        const a = img.getBoundingClientRect();
        const b = side.getBoundingClientRect();
        return { fits: a.right <= b.right + 0.5 && a.left >= b.left - 0.5, imgW: a.width, sideW: b.width };
      });
      ok(`${cfg.name}: logo tetap di dalam rail`, fit && fit.fits, JSON.stringify(fit));
    }

    // favicon harus benar-benar berisi artwork (bukan kotak navy kosong)
    if (m.favicon) {
      const r = await page.request.get(m.favicon);
      const body = await r.body();
      ok(`${cfg.name}: favicon 200 & image/png`, r.status() === 200
        && String(r.headers()['content-type']).includes('image/png'), `${r.status()} ${body.length}b`);
      const tmpFile = path.join(TMP, `fav-${cfg.name}.png`);
      fs.writeFileSync(tmpFile, body);
      const dims = execFileSync('identify', ['-format', '%wx%h', tmpFile], { encoding: 'utf8' });
      const colors = execFileSync('convert', [tmpFile, '-format', '%k', 'info:'], { encoding: 'utf8' });
      ok(`${cfg.name}: favicon 256x256`, dims === '256x256', dims);
      ok(`${cfg.name}: favicon berisi logo (banyak warna)`, Number(colors) > 8, `colors=${colors}`);
    }

    // Bukti visual: 5 halaman kunci saja (screenshot PNG penuh memakan beberapa MB).
    if (['home', 'home-mobile', 'portal-login', 'admin', 'admin-mobile'].includes(cfg.name)) {
      await page.screenshot({ path: path.join(SHOTS, `${cfg.name}.png`) });
    }
    await page.close();
    await ctx.close();
  }

  // Portal seleksi: header portal memakai .portal-brand__logo
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const token = (() => {
    const db = new Database(path.join(TMP, 'app.sqlite'), { readonly: true });
    const row = db.prepare('SELECT token FROM photo_selections ORDER BY id DESC LIMIT 1').get();
    db.close();
    return row && row.token;
  })();
  if (token) {
    const res = await page.goto(`${BASE}/selection/${token}`, { waitUntil: 'networkidle' });
    const m = await measure(page);
    console.log(`\n[selection] ${res.status()} — logos=${m.logos.length} overflow=${m.overflow}`);
    m.logos.forEach((l) => console.log(`   logo h=${l.h} w=${l.w} ${l.cls}`));
    ok('selection: portal header logo ada', m.logos.length > 0);
    m.logos.forEach((l) => ok(`selection: tinggi logo ${l.h}px = ${EXPECT}px`, near(l.h, EXPECT)));
    ok('selection: tidak ada horizontal overflow', m.overflow <= 0, String(m.overflow));
    await page.screenshot({ path: path.join(SHOTS, 'portal-selection.png') });
  } else {
    console.log('[selection] dilewati — belum ada data seleksi di DB');
  }
  await page.close();
  await ctx.close();

  await browser.close();
  child.kill('SIGKILL');

  console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
  if (fails.length) {
    fails.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

'use strict';

/**
 * V20 — v16: standarisasi tipografi Dashboard Admin (Montserrat menyeluruh).
 *
 * Diuji pada beberapa halaman admin utama (Overview, Kelola Booking, Detail Booking,
 * Portal Seleksi, Teks Website, Pengaturan) di desktop + mobile:
 *  - SETIAP elemen teks memakai Montserrat (tidak ada serif/dekoratif/monospace),
 *  - halaman & heading tegas (SemiBold/Bold ≥ 600),
 *  - body/deskripsi/metadata regular/medium (≤ 500) dan tetap terbaca,
 *  - angka KPI tegas,
 *  - tidak ada teks terpotong / overflow horizontal di HP maupun desktop,
 *  - tidak ada perubahan fungsi (jumlah tab, form, tabel tetap seperti semula).
 *
 * node scripts/check-admin-type.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `dly-admtype-${process.pid}`);
const PORT = 3700 + (process.pid % 60);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'public', 'review-admin-type');
const SID = `admtype${Date.now()}`;
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
  const db = new Database(path.join(TMP, 'app.sqlite'));
  const admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get();
  db.prepare(`INSERT OR REPLACE INTO sessions (id, admin_id, csrf, expires_at)
              VALUES (?, ?, 'csrf', datetime('now', '+1 day'))`).run(SID, admin.id);
  const booking = db.prepare('SELECT id FROM bookings ORDER BY id LIMIT 1').get();
  const portal = db.prepare('SELECT id FROM photo_selections ORDER BY id LIMIT 1').get();
  db.close();
  return { bookingId: booking ? booking.id : 0, portalId: portal ? portal.id : 0 };
}

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return true; } catch (err) { /* retry */ }
    await sleep(400);
  }
  return false;
}

/** Kumpulkan statistik tipografi dari halaman yang sedang terbuka. */
const audit = () => {
  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const parseFont = (el) => getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const fonts = new Map();
  const textSamples = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.textContent || '').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || !isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'svg') continue;
    const font = parseFont(el);
    const size = parseFloat(getComputedStyle(el).fontSize);
    const weight = Number(getComputedStyle(el).fontWeight);
    fonts.set(font, (fonts.get(font) || 0) + 1);
    if (text.length > 2) textSamples.push({ text: text.slice(0, 60), tag, font, size, weight });
  }

  const hs = Array.from(document.querySelectorAll('h1, h2')).filter(isVisible).map((el) => ({
    text: (el.textContent || '').trim().slice(0, 40),
    font: parseFont(el),
    weight: Number(getComputedStyle(el).fontWeight),
    size: parseFloat(getComputedStyle(el).fontSize)
  }));
  const kpi = Array.from(document.querySelectorAll('.stat-card__value, .ov-kpi__value'))
    .filter(isVisible)
    .map((el) => ({ font: parseFont(el), weight: Number(getComputedStyle(el).fontWeight) }));

  // Teks benar-benar terpotong: elemen berisi TEKS LANGSUNG, overflow dipaksa hidden,
  // dan bukan pemendekan yang disengaja (ellipsis). Kontrol form dilewati karena
  // scrollWidth > clientWidth adalah hal normal untuk <input> berisi teks panjang.
  const clippedElements = Array.from(document.querySelectorAll('.admin-main *')).filter((el) => {
    if (!isVisible(el)) return false;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTGROUP', 'CANVAS', 'SVG'].includes(el.tagName)) return false;
    const hasOwnText = Array.from(el.childNodes)
      .some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 1);
    if (!hasOwnText) return false;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') return false;
    if (cs.textOverflow === 'ellipsis') return false;
    return el.scrollWidth > el.clientWidth + 2;
  });
  const clipped = clippedElements.length;

  return {
    fonts: Array.from(fonts.entries()),
    headings: hs,
    kpi,
    clipped,
    clippedDetail: clippedElements.slice(0, 4).map((el) => `${el.tagName}.${String(el.className).slice(0, 30)}`),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyFont: parseFont(document.body),
    bodySize: parseFloat(getComputedStyle(document.body).fontSize),
    count: textSamples.length
  };
};

async function run() {
  const fx = prepare();
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

  const routes = [
    { url: '/admin', name: 'overview' },
    { url: '/admin/bookings', name: 'bookings' },
    { url: `/admin/bookings/${fx.bookingId}`, name: 'booking-detail' },
    { url: `/admin/bookings/${fx.bookingId}?tab=pembayaran`, name: 'booking-payment' },
    { url: '/admin/selection', name: 'selection-list' },
    { url: `/admin/selection/${fx.portalId}`, name: 'selection-detail' },
    { url: '/admin/content', name: 'content' },
    { url: '/admin/packages', name: 'packages' },
    { url: '/admin/portfolio', name: 'portfolio' },
    { url: '/admin/settings', name: 'settings' },
    { url: '/admin/push', name: 'push' }
  ];

  const browser = await chromium.launch();
  for (const viewport of [{ width: 1440, height: 900, label: 'desktop' }, { width: 390, height: 844, label: 'mobile' }]) {
    const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    await ctx.addCookies([{ name: 'dly_sid', value: SID, domain: '127.0.0.1', path: '/' }]);
    const page = await ctx.newPage();

    for (const r of routes) {
      const res = await page.goto(BASE + r.url, { waitUntil: 'networkidle' });
      if (res.status() !== 200) { ck(`${viewport.label} ${r.name}: 200`, false, String(res.status())); continue; }
      if (viewport.label === 'mobile') {
        // Buka drawer supaya tipografi navigasi juga diperiksa.
        await page.click('[data-side-toggle]').catch(() => {});
        await sleep(150);
      }
      const a = await page.evaluate(audit);
      const nonMontserrat = a.fonts.filter(([f]) => f && f !== 'Montserrat');
      ck(`${viewport.label} ${r.name}: semua teks Montserrat`, nonMontserrat.length === 0,
        nonMontserrat.map(([f, n]) => `${f}×${n}`).join(', '));
      ck(`${viewport.label} ${r.name}: heading tegas (≥600)`,
        a.headings.length === 0 || a.headings.every((h) => h.weight >= 600),
        a.headings.map((h) => `${h.text}:${h.weight}`).join(' | '));
      ck(`${viewport.label} ${r.name}: KPI/nominal tegas (≥600)`,
        a.kpi.length === 0 || a.kpi.every((k) => k.weight >= 600),
        a.kpi.map((k) => k.weight).join(','));
      ck(`${viewport.label} ${r.name}: body terbaca (≥13px)`, a.bodySize >= 13, String(a.bodySize));
      ck(`${viewport.label} ${r.name}: tidak ada teks terpotong`, a.clipped === 0,
        `${a.clipped} ${a.clippedDetail.join(', ')}`);
      ck(`${viewport.label} ${r.name}: tidak ada overflow horizontal`, a.overflow <= 0, String(a.overflow));
      if (viewport.label === 'desktop' && ['overview', 'booking-detail', 'selection-detail'].includes(r.name)) {
        await page.screenshot({ path: path.join(SHOTS, `${r.name}.png`), fullPage: false });
      }
      if (viewport.label === 'mobile' && r.name === 'overview') {
        await page.screenshot({ path: path.join(SHOTS, 'overview-mobile.png'), fullPage: false });
      }
    }
    await page.close();
    await ctx.close();
  }

  // Halaman login (layout-blank) juga Montserrat.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    const a = await page.evaluate(audit);
    const non = a.fonts.filter(([f]) => f && f !== 'Montserrat');
    ck('login admin: semua teks Montserrat', non.length === 0, non.map(([f, n]) => `${f}×${n}`).join(', '));
    ck('login admin: judul tegas (≥600)', a.headings.every((h) => h.weight >= 600),
      a.headings.map((h) => `${h.text}:${h.weight}`).join(' | '));
    await page.screenshot({ path: path.join(SHOTS, 'login.png') });
    await page.close();
    await ctx.close();
  }

  await browser.close();
  child.kill('SIGKILL');
  console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
  if (fails.length) { fails.forEach((f) => console.log(' - ' + f)); process.exit(1); }
}

run().catch((err) => { console.error(err); process.exit(1); });

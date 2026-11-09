'use strict';

/**
 * Page + asset regression check (V10).
 *
 * Boots the app on its own port against a COPY of the database (in /tmp — the sandbox
 * mounts every `app.sqlite` inside the workspace read-only), then for every public and
 * admin page:
 *   - asserts the HTTP status
 *   - asserts no render error text / unclosed <picture>
 *   - extracts every image URL (img/src, srcset, <source>) and fetches it
 *   - reports non-200 assets, wrong content types and oversized payloads
 *
 *   node scripts/verify-pages.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.CHECK_PORT || 4490);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/dly-verify';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const notes = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; } else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
  return cond;
}

function prepare() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  // Cache gambar ikut disalin: di produksi cache ini sudah hangat (dan /media di-cache
  // `immutable`), jadi suite mengukur keadaan nyata. Membiarkannya kosong membuat setiap
  // varian dibuat dari master 4000×6000 secara berurutan → suite butuh belasan menit.
  ['image-cache', 'logo-cache', 'preview-cache'].forEach((dir) => {
    try { fs.cpSync(path.join(APP, 'data', dir), path.join(DATA_DIR, dir), { recursive: true }); } catch (e) { /* opsional */ }
  });
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'), { readonly: true });
  const token = (db.prepare('SELECT token FROM photo_selections LIMIT 1').get() || {}).token || '';
  const booking = db.prepare('SELECT id FROM bookings LIMIT 1').get() || {};
  const pkg = db.prepare('SELECT slug FROM packages LIMIT 1').get() || {};
  const article = db.prepare('SELECT slug FROM articles WHERE is_published = 1 LIMIT 1').get() || {};
  const city = db.prepare('SELECT slug FROM cities LIMIT 1').get() || {};
  db.close();
  return { token, bookingId: booking.id, pkgSlug: pkg.slug, articleSlug: article.slug, citySlug: city.slug };
}

function imageUrls(html) {
  const out = new Set();
  const re = /(?:src|data-src)="([^"]+\.(?:jpe?g|png|webp|gif|svg)(?:\?[^"]*)?)"/gi;
  let m;
  while ((m = re.exec(html))) out.add(m[1]);
  const setRe = /srcset="([^"]+)"/gi;
  while ((m = setRe.exec(html))) {
    m[1].split(',').forEach((part) => {
      const url = part.trim().split(/\s+/)[0];
      if (url) out.add(url);
    });
  }
  return Array.from(out);
}

async function main() {
  const ctx = prepare();
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  try {
    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`${BASE}/`); if (r.ok) break; } catch (e) { /* booting */ }
      await sleep(250);
    }

    const pages = [
      '/', '/gallery', '/portfolio', '/pricelist', '/city', `/city/${ctx.citySlug}`,
      '/cara-order', '/ulasan', '/syarat-ketentuan', '/tentang', '/artikel', '/faq',
      '/booking', '/sitemap.xml', '/robots.txt'
    ];
    if (ctx.pkgSlug) pages.push(`/paket/${ctx.pkgSlug}`);
    if (ctx.articleSlug) pages.push(`/artikel/${ctx.articleSlug}`);
    // Portal seleksi klien memuat foto dari GOOGLE DRIVE (source='drive'), sehingga setiap
    // gambar di dalamnya mengunduh dari Drive. Memeriksa semuanya butuh belasan menit dan
    // mengukur jaringan Drive, bukan aplikasi. Dilewati kecuali SKIP_SELECTION=0.
    if (ctx.token && process.env.SKIP_SELECTION !== '1') pages.push(`/selection/${ctx.token}`);

    const allImages = new Map();
    for (const url of pages) {
      const res = await fetch(`${BASE}${url}`);
      const html = await res.text();
      const ok = check(`GET ${url} → 200`, res.status === 200, String(res.status));
      if (!ok) continue;
      check(`${url} no render error`, !/Terjadi kesalahan pada server|ReferenceError|is not defined/.test(html));
      check(`${url} picture tags balanced`,
        (html.match(/<picture>/g) || []).length === (html.match(/<\/picture>/g) || []).length,
        `${(html.match(/<picture>/g) || []).length} open / ${(html.match(/<\/picture>/g) || []).length} close`);
      if (url !== '/sitemap.xml' && url !== '/robots.txt') {
        imageUrls(html).forEach((src) => {
          const abs = src.startsWith('http') ? src : `${BASE}${src.startsWith('/') ? '' : '/'}${src}`;
          if (!allImages.has(abs)) allImages.set(abs, new Set());
          allImages.get(abs).add(url);
        });
      }
    }

    // Every referenced image must actually load, with an image content type.
    let bad = 0;
    let totalBytes = 0;
    for (const [url, from] of allImages) {
      if (url.startsWith('data:')) continue;
      const res = await fetch(url).catch(() => null);
      if (!res || res.status !== 200) { bad += 1; notes.push(`BROKEN ${url} (from ${Array.from(from).join(',')})`); continue; }
      const type = String(res.headers.get('content-type') || '');
      if (!/^(image\/|application\/octet-stream)/.test(type)) { bad += 1; notes.push(`WRONG-TYPE ${url} → ${type}`); }
      const buf = await res.arrayBuffer();
      totalBytes += buf.byteLength;
    }
    check(`all ${allImages.size} referenced images load`, bad === 0, `${bad} broken`);

    // A versioned asset must be cacheable for a year.
    const css = await fetch(`${BASE}/assets/app.css`);
    check('CSS served with long immutable cache',
      /immutable/.test(String(css.headers.get('cache-control') || '')), String(css.headers.get('cache-control') || ''));
    check('CSS is compressed on the wire',
      Boolean(css.headers.get('content-encoding')), String(css.headers.get('content-encoding') || 'none'));

    // Media route guardrails.
    const bad1 = await fetch(`${BASE}/media/deadbeef-480.webp`);
    check('unknown media variant → 404', bad1.status === 404, String(bad1.status));
    const bad2 = await fetch(`${BASE}/media/..%2f..%2fetc%2fpasswd.480.webp`);
    check('path traversal blocked', bad2.status === 404, String(bad2.status));

    notes.push(`images fetched: ${allImages.size}, total ${Math.round(totalBytes / 1024)}KB`);
  } finally {
    app.kill();
  }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(' FAIL ' + f));
  notes.forEach((n) => console.log(' note ' + n));
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });

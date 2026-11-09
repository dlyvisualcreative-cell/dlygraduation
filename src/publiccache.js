'use strict';

/**
 * Micro-cache HTML untuk halaman PUBLIK saja (P2).
 *
 * Kenapa: setiap kunjungan ke beranda/gallery/pricelist selama ini me-render EJS penuh
 * (±10–17 ms CPU per request). Saat trafik naik, CPU 1 core habis untuk merender ulang
 * halaman yang isinya sama. Cache 15 detik membuat lonjakan trafik tidak lagi menambah
 * antrean, tanpa membuat status pesanan menjadi kedaluwarsa.
 *
 * YANG TIDAK PERNAH DI-CACHE (sengaja, demi keamanan & kebenaran data):
 *   - /admin, /portal, /selection, /testimoni  → data pribadi klien
 *   - /booking, /booking/sukses, /api          → data transaksi
 *   - /media, /logo, /favicon, /appicon, /assets, /uploads → file, bukan HTML
 *   - request dengan query string (?msg=, ?kota=, token) → bisa berisi pesan/flash
 *   - request dengan cookie sesi admin (`dly_sid`) → halaman bisa berbeda untuk admin
 *   - respons yang memasang `Cache-Control: no-store`
 *
 * Invalidasi: setiap publish/kancel perubahan konten dan setiap simpan di dashboard admin
 * memanggil `clear()` — jadi perubahan pemilik langsung terlihat (maks. satu request).
 */

// PUBLIC_CACHE_MS=0 mematikan cache (dipakai suite tes yang menulis DB langsung).
const RAW_TTL = Number(process.env.PUBLIC_CACHE_MS === undefined ? 15000 : process.env.PUBLIC_CACHE_MS);
const ENABLED = RAW_TTL > 0;
const TTL_MS = ENABLED ? Math.max(1000, RAW_TTL) : 0;

/** Halaman publik yang isinya identik untuk semua pengunjung (tanpa parameter). */
const EXACT = new Set([
  '/', '/gallery', '/pricelist', '/city', '/cara-order', '/ulasan', '/faq',
  '/tentang', '/syarat-ketentuan', '/artikel'
]);
/** Pola halaman detail publik (slug aman: huruf, angka, tanda hubung). */
const PATTERNS = [
  /^\/city\/[a-z0-9-]{1,80}$/i,
  /^\/artikel\/[a-z0-9-]{1,120}$/i,
  /^\/portfolio\/[a-z0-9-]{1,120}$/i,
  /^\/paket\/[a-z0-9-]{1,120}$/i
];
const ALWAYS_SKIP = /^\/(admin|portal|selection|testimoni|booking|api|media|logo|favicon|appicon|assets|uploads|sw\.js|manifest\.webmanifest|robots\.txt|sitemap\.xml|offline|health)/i;

const store = new Map(); // key → { body, type, at, headers }
let hits = 0;
let misses = 0;
let stored = 0;

const isCacheablePath = (pathname) => {
  if (ALWAYS_SKIP.test(pathname)) return false;
  if (EXACT.has(pathname)) return true;
  return PATTERNS.some((re) => re.test(pathname));
};

function cacheKey(req) {
  // Base path ikut jadi kunci: alamat default (/<slug>) dan custom domain menghasilkan
  // tautan absolut yang berbeda di HTML. Dibaca langsung dari header supaya middleware
  // ini bisa jalan SEBELUM render (tidak perlu menunggu req.basePath diisi).
  return `${req.get('x-public-base-path') || ''}${req.path}`;
}

function clear() {
  const n = store.size;
  store.clear();
  return n;
}

function stats() {
  return { entries: store.size, hits, misses, stored, ttlMs: TTL_MS };
}

function middleware() {
  return function publicHtmlCache(req, res, next) {
    if (!ENABLED) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!isCacheablePath(req.path)) return next();
    // Query string apa pun (kota=, msg=, utm, token) → lewati cache.
    if (req.originalUrl.includes('?')) return next();
    // Admin yang sedang login bisa melihat keadaan berbeda (mis. pratinjau) → lewati.
    if (/dly_sid=/.test(String(req.headers.cookie || ''))) return next();
    // Klien meminta versi segar (reload paksa) → lewati.
    if (/no-cache|no-store/i.test(String(req.headers['cache-control'] || ''))) return next();

    const key = cacheKey(req);
    const hit = store.get(key);
    const now = Date.now();
    if (hit && now - hit.at < TTL_MS) {
      hits += 1;
      // Header tetap sama seperti respons biasa (no-store untuk browser, lihat middleware
      // di bawah). Cache ini hanya menghemat RENDER di server, bukan mengubah perilaku
      // cache browser.
      res.setHeader('Cache-Control', hit.cacheControl || 'no-store');
      res.setHeader('Content-Type', hit.type);
      res.setHeader('X-Public-Cache', 'HIT');
      return res.end(hit.body);
    }

    misses += 1;
    const origEnd = res.end.bind(res);
    res.end = function endWithCache(chunk, enc, cb) {
      try {
        const type = String(res.getHeader('content-type') || '');
        // Hanya HTML 200 yang boleh masuk cache. Path sudah difilter ketat di atas
        // (tidak ada admin/portal/booking/API), jadi tidak ada data pribadi di sini.
        if (res.statusCode === 200 && /^text\/html/i.test(type) && chunk) {
          const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8');
          if (store.size > 400) store.clear();
          store.set(key, {
            body,
            type,
            at: Date.now(),
            cacheControl: String(res.getHeader('cache-control') || 'no-store')
          });
          stored += 1;
          res.setHeader('X-Public-Cache', 'MISS');
        }
      } catch (err) { /* cache tidak boleh merusak respons */ }
      return origEnd(chunk, enc, cb);
    };
    return next();
  };
}

module.exports = { middleware, clear, stats, TTL_MS, ENABLED, isCacheablePath };

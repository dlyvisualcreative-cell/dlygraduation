'use strict';

/**
 * Lapisan keamanan (Revisi 5 — "sistem keamanan website yang paling aman").
 *
 * Yang dikerjakan di sini, semuanya berlaku untuk SEMUA rute:
 *  1. Security headers: CSP, HSTS, nosniff, X-Frame-Options, Referrer-Policy,
 *     Permissions-Policy, COOP/CORP, dan `X-Powered-By` dimatikan.
 *  2. Penyaring permintaan berbahaya: dotfile (`.env`, `.git`), file database,
 *     backup, dan path traversal — dijawab 404 tanpa menyentuh router.
 *  3. Rate limit per-IP (token bucket) untuk metode yang mengubah data
 *     (POST/PUT/PATCH/DELETE). Login admin & portal punya limit sendiri yang lebih ketat.
 *  4. Kebijakan password admin (dipakai route ganti password).
 *
 * Tidak ada dependensi baru: semua ditulis dengan modul bawaan Node.
 */

// Halaman yang berisi data pribadi (tidak boleh masuk mesin pencari).
const PRIVATE_PATH = /^\/(portal|admin|selection|testimoni)(\/|$)/i;

const BLOCKED_PATH = /(^|\/)(\.env(\..*)?|\.git(\/|$)|\.htaccess|\.htpasswd|\.DS_Store|.*\.sqlite(-wal|-shm)?|.*\.sql(\.gz)?|.*\.bak|.*\.old|.*\.log|.*\.pem|.*\.key|id_rsa.*|composer\.(json|lock)|package(-lock)?\.json|node_modules(\/|$))/i;

/* ------------------------------------------------------------------ */
/* 1. Security headers                                                 */
/* ------------------------------------------------------------------ */
// CSP dibuat cukup ketat tanpa mematahkan aplikasi:
//  - `'unsafe-inline'` masih diperlukan karena template memakai <style>/<script> inline
//    dan atribut style (ini TIDAK membuka jalan bagi XSS dari input pengguna, karena
//    semua output EJS sudah di-escape).
//  - Google Fonts diizinkan khusus untuk stylesheet/font.
//  - `img-src https:` diperlukan karena foto bisa berasal dari CDN media platform.
//  - `frame-ancestors 'none'` + form-action 'self' mencegah clickjacking & form hijack.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:"
].join('; ');

function isHttps(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || '').split(',')[0].trim();
  return proto === 'https';
}

function headers(req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  // HSTS hanya untuk HTTPS (kalau dikirim lewat HTTP, browser mengabaikannya, tapi
  // lebih jelas bila hanya muncul pada koneksi aman).
  if (isHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // HANYA halaman pribadi (portal klien, admin, halaman seleksi & testimoni bertoken)
  // yang noindex. Halaman publik (beranda, gallery, pricelist) HARUS tetap bisa
  // di-index Google — jangan pernah memasang noindex global di sini.
  if (PRIVATE_PATH.test(req.path || '')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
  }
  res.setHeader('Content-Security-Policy', CSP);
  next();
}

/* ------------------------------------------------------------------ */
/* 2. Penyaring path berbahaya                                        */
/* ------------------------------------------------------------------ */
function blockSensitivePaths(req, res, next) {
  let decoded = req.path || '/';
  try { decoded = decodeURIComponent(decoded); } catch (err) { /* biarkan apa adanya */ }
  if (decoded.includes('\0') || decoded.includes('../') || BLOCKED_PATH.test(decoded)) {
    // 404 (bukan 403) supaya keberadaan file tidak dikonfirmasi.
    logEvent('blocked-path', req.ip, decoded.slice(0, 160));
    return res.status(404).type('text/plain').send('Not found');
  }
  return next();
}

/* ------------------------------------------------------------------ */
/* 3. Rate limit sederhana per IP                                      */
/* ------------------------------------------------------------------ */
/**
 * Token bucket: `limit` permintaan per `windowMs`. Dipakai untuk semua permintaan
 * yang mengubah data. Tidak memakai memori besar: entri lama dibersihkan berkala.
 */
function createLimiter({ limit = 120, windowMs = 60 * 1000, methods = ['POST', 'PUT', 'PATCH', 'DELETE'] } = {}) {
  const buckets = new Map();
  let lastSweep = Date.now();

  const sweep = (now) => {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, b] of buckets) {
      if (now - b.start > windowMs) buckets.delete(key);
    }
  };

  return function limiter(req, res, next) {
    if (!methods.includes(req.method)) return next();
    const now = Date.now();
    sweep(now);
    const ip = String(req.ip || req.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
    let bucket = buckets.get(ip);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      logEvent('rate-limit', ip, `${req.method} ${req.path}`.slice(0, 160));
      res.setHeader('Retry-After', String(Math.ceil((windowMs - (now - bucket.start)) / 1000)));
      return res.status(429).type('text/plain')
        .send('Terlalu banyak permintaan dari jaringan ini. Coba lagi sebentar lagi.');
    }
    return next();
  };
}

/* ------------------------------------------------------------------ */
/* 4. Kebijakan password                                              */
/* ------------------------------------------------------------------ */
const WEAK_PASSWORDS = new Set([
  'password', 'password123', '12345678', '123456789', '1234567890', 'qwerty123',
  'admin123', 'admin1234', 'dlygraduation2025', 'graduation', 'wisuda2025', 'iloveyou'
]);

/**
 * @returns {{ok:boolean, message?:string}}
 */
function checkPassword(password) {
  const value = String(password || '');
  if (value.length < 10) return { ok: false, message: 'Password baru minimal 10 karakter.' };
  if (value.length > 200) return { ok: false, message: 'Password terlalu panjang (maksimal 200 karakter).' };
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return { ok: false, message: 'Password harus memuat huruf dan angka.' };
  }
  if (WEAK_PASSWORDS.has(value.toLowerCase())) {
    return { ok: false, message: 'Password itu terlalu mudah ditebak. Pakai kombinasi lain.' };
  }
  if (/^(.)\1+$/.test(value)) return { ok: false, message: 'Password tidak boleh satu karakter berulang.' };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 5. Catatan peristiwa keamanan                                      */
/* ------------------------------------------------------------------ */
/**
 * Simpan peristiwa keamanan (login gagal, rate limit, akses file sensitif) ke
 * `security_events` supaya bisa ditinjau di dashboard. Tidak pernah melempar error.
 */
function logEvent(kind, ip, detail = '') {
  try {
    const { db } = require('./db');
    db.prepare(`INSERT INTO security_events (kind, ip, detail) VALUES (?, ?, ?)`)
      .run(String(kind || '').slice(0, 40), String(ip || '').slice(0, 60), String(detail || '').slice(0, 200));
    // Simpan maksimal ~2000 baris terakhir (tidak perlu arsip panjang).
    db.prepare(`DELETE FROM security_events WHERE id NOT IN
                (SELECT id FROM security_events ORDER BY id DESC LIMIT 2000)`).run();
    return true;
  } catch (err) {
    return false;
  }
}

/** Ringkasan untuk panel Keamanan di /admin/settings. */
function status() {
  const { db } = require('./db');
  const since = "datetime('now', '-7 days')";
  const one = (sql) => {
    try { return db.prepare(sql).get().n; } catch (err) { return 0; }
  };
  return {
    failedLogins7d: one(`SELECT COUNT(*) AS n FROM security_events WHERE kind = 'login-failed' AND created_at >= ${since}`),
    blockedPaths7d: one(`SELECT COUNT(*) AS n FROM security_events WHERE kind = 'blocked-path' AND created_at >= ${since}`),
    rateLimited7d: one(`SELECT COUNT(*) AS n FROM security_events WHERE kind = 'rate-limit' AND created_at >= ${since}`),
    activeSessions: one("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > datetime('now')"),
    recent: (() => {
      try {
        return db.prepare(`SELECT kind, ip, detail, created_at FROM security_events
                           ORDER BY id DESC LIMIT 8`).all();
      } catch (err) { return []; }
    })()
  };
}

module.exports = {
  CSP,
  headers,
  blockSensitivePaths,
  createLimiter,
  checkPassword,
  PRIVATE_PATH,
  logEvent,
  status,
  BLOCKED_PATH
};

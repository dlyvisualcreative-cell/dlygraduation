'use strict';

/**
 * Client Portal — akses klien tanpa akun.
 *
 * Kredensial = **Kode Booking + PIN 4 digit** (PIN dikirim admin lewat WhatsApp).
 * Keduanya divalidasi di BACKEND; tampilan hanya alat bantu.
 *
 * Keamanan:
 *  - Sesi disimpan di tabel `portal_sessions` (cookie httpOnly, id acak 32 byte).
 *  - Rate limit: maksimal 8 percobaan gagal / 15 menit per IP (dan per kode).
 *  - Kode dicocokkan case-insensitive; kode lama (`legacy_code`) tetap berlaku.
 *  - `findBooking` hanya mengembalikan booking yang kodenya cocok — tidak ada endpoint
 *    yang bisa menebak id booking.
 *
 * PIN (v15) disimpan sebagai HASH scrypt (`bookings.portal_pin_hash`) — tidak ada
 * PIN plaintext di database maupun backup. Konsekuensinya PIN lama tidak bisa
 * ditampilkan lagi: admin membuat PIN baru lewat tombol "Buat PIN Baru", dan PIN baru
 * itu ditahan di MEMORI proses selama 15 menit agar bisa ikut terkirim di pesan
 * WhatsApp (tidak pernah ditulis ke DB).
 */

const crypto = require('crypto');
const { db, verifyPassword } = require('./db');

const COOKIE = 'dly_portal';
const SESSION_HOURS = 12;
const MAX_ATTEMPTS = 8;
const WINDOW_MINUTES = 15;

/* ------------------------------------------------------------------ */
/* Kode & PIN                                                          */
/* ------------------------------------------------------------------ */
const normalizeCode = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

/** Cari booking dari kode portal (format baru) atau kode lama. */
function findBooking(codeInput) {
  const code = normalizeCode(codeInput);
  if (!code) return null;
  return db.prepare(`SELECT * FROM bookings WHERE UPPER(code) = ? OR UPPER(COALESCE(legacy_code, '')) = ?
                     LIMIT 1`).get(code, code) || null;
}

const bookingById = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(id)) || null;

/* ------------------------------------------------------------------ */
/* PIN                                                                 */
/* ------------------------------------------------------------------ */
/**
 * PIN disimpan TERBACA di `bookings.portal_pin` (4 digit) karena pemilik memutuskan
 * PIN harus bisa ditampilkan lagi di Dashboard Admin (mis. klien lupa PIN → admin
 * tinggal membacanya dan mengirim ulang lewat WhatsApp).
 *
 * Catatan keamanan (disepakati pemilik): datanya hanya 4 digit sehingga nilainya
 * memang tidak pernah menjadi rahasia yang kuat — proteksi sesungguhnya ada pada
 * rate limit login, sesi httpOnly, dan pengecekan kepemilikan booking di backend.
 * Kolom `portal_pin_hash` (V20) tetap dibaca sebagai fallback agar PIN lama yang
 * sempat di-hash tidak langsung mati; lihat verifyPin().
 */
function randomPin() {
  return String(crypto.randomInt(1000, 10000));
}

const hasPin = (booking) => Boolean(booking && (booking.portal_pin || booking.portal_pin_hash));

/** PIN yang bisa ditampilkan di dashboard ('' bila belum ada). */
function visiblePin(bookingId) {
  const booking = bookingById(bookingId);
  if (!booking) return '';
  return /^\d{4}$/.test(String(booking.portal_pin || '')) ? String(booking.portal_pin) : '';
}

/** Menyimpan PIN terbaca (hash lama dikosongkan supaya tidak ada dua sumber kebenaran). */
function storePin(bookingId, pin) {
  db.prepare("UPDATE bookings SET portal_pin = ?, portal_pin_hash = NULL, portal_pin_at = datetime('now') WHERE id = ?")
    .run(String(pin), Number(bookingId));
  return String(pin);
}

/**
 * Pastikan PIN ada dan bisa ditampilkan.
 *  - sudah ada PIN 4 digit  → dikembalikan apa adanya
 *  - hanya ada hash (data V20) → dibuat PIN baru (tidak bisa dibalik), hash dibersihkan
 *  - belum ada sama sekali   → dibuat PIN baru
 */
function ensurePin(bookingId) {
  const booking = bookingById(bookingId);
  if (!booking) return null;
  const plain = String(booking.portal_pin || '');
  if (/^\d{4}$/.test(plain)) return plain;
  return storePin(booking.id, randomPin());
}

/** Buat PIN baru (ganti PIN lama). Sesi portal yang aktif diputus oleh pemanggil. */
function resetPin(bookingId) {
  const booking = bookingById(bookingId);
  if (!booking) return null;
  return storePin(booking.id, randomPin());
}

/**
 * Verifikasi PIN. Sumber utama = PIN terbaca. Baris lama yang hanya punya hash
 * (hasil V20) tetap bisa masuk, lalu otomatis di-upgrade menjadi PIN terbaca
 * supaya tampil lagi di dashboard.
 */
function verifyPin(booking, pin) {
  if (!booking) return false;
  const candidate = String(pin || '');
  const plain = String(booking.portal_pin || '');
  if (/^\d{4}$/.test(plain)) {
    if (plain.length !== 4 || candidate.length !== 4) return false;
    return crypto.timingSafeEqual(Buffer.from(plain), Buffer.from(candidate));
  }
  if (booking.portal_pin_hash && verifyPassword(candidate, booking.portal_pin_hash)) {
    // Hash-only (data V20): simpan ulang sebagai PIN terbaca agar bisa ditampilkan.
    try { storePin(booking.id, candidate); } catch (err) { /* upgrade opsional */ }
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Masa akses portal untuk booking yang belum dikonfirmasi             */
/* ------------------------------------------------------------------ */
/**
 * Kode booking + PIN hanya berlaku **24 jam sejak booking dikirim** selama statusnya
 * masih `pending` (belum dikonfirmasi admin). Setelah itu akses portal ditutup
 * otomatis: kode tidak bisa dipakai masuk lagi dan sesi aktif ikut diputus.
 *
 * Booking yang sudah `confirmed` / `completed` TIDAK dibatasi waktu — klien perlu
 * portal untuk memilih foto, memantau order, dan mengambil hasil edit.
 * Booking `cancelled` ditolak dengan pesan tersendiri (lihat route login).
 */
const PENDING_ACCESS_HOURS = 24;
const UNCONFIRMED_STATUSES = ['pending', 'cancelled'];

/** Waktu (epoch ms) masa akses berakhir, atau null bila tidak dibatasi. */
function accessExpiresAt(booking) {
  if (!booking) return null;
  if (!UNCONFIRMED_STATUSES.includes(String(booking.status || ''))) return null;
  const created = String(booking.created_at || '').trim();
  if (!created) return null;
  const iso = created.replace(' ', 'T');
  const ms = Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(ms)) return null;
  return ms + PENDING_ACCESS_HOURS * 3600 * 1000;
}

/**
 * Status akses satu booking.
 * @returns {{ok:boolean, expiresAt:number|null, expired:boolean, hours:number, label:string}}
 */
function accessState(booking, now = Date.now()) {
  const expiresAt = accessExpiresAt(booking);
  if (!expiresAt) return { ok: true, expiresAt: null, expired: false, hours: PENDING_ACCESS_HOURS, label: '' };
  const expired = now >= expiresAt;
  return {
    ok: !expired,
    expiresAt,
    expired,
    hours: PENDING_ACCESS_HOURS,
    label: expired
      ? `Masa akses portal sudah berakhir (${PENDING_ACCESS_HOURS} jam sejak booking dikirim).`
      : `Portal aktif sampai ${new Date(expiresAt).toISOString()}`
  };
}

/** Putus semua sesi milik booking (dipakai saat masa akses habis). */
const expireSessionsFor = (bookingId) => destroySessionsFor(bookingId);

/* ------------------------------------------------------------------ */
/* Rate limit                                                          */
/* ------------------------------------------------------------------ */
function tooManyAttempts(ip) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM portal_attempts
                          WHERE ip = ? AND ok = 0 AND created_at >= datetime('now', ?)`)
    .get(String(ip || ''), `-${WINDOW_MINUTES} minutes`);
  return Number(row.n) >= MAX_ATTEMPTS;
}

function recordAttempt(ip, code, ok) {
  db.prepare('INSERT INTO portal_attempts (ip, code, ok) VALUES (?, ?, ?)')
    .run(String(ip || '').slice(0, 60), normalizeCode(code).slice(0, 40), ok ? 1 : 0);
  // housekeeping
  db.prepare("DELETE FROM portal_attempts WHERE created_at < datetime('now', '-2 days')").run();
}

function resetAttempts(ip) {
  db.prepare('DELETE FROM portal_attempts WHERE ip = ?').run(String(ip || ''));
}

/* ------------------------------------------------------------------ */
/* Sesi                                                               */
/* ------------------------------------------------------------------ */
function cleanupSessions() {
  db.prepare("DELETE FROM portal_sessions WHERE expires_at < datetime('now')").run();
}

function createSession(bookingId, { ip = '', userAgent = '' } = {}) {
  cleanupSessions();
  const id = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO portal_sessions (id, booking_id, expires_at, ip, user_agent)
              VALUES (?, ?, datetime('now', ?), ?, ?)`)
    .run(id, Number(bookingId), `+${SESSION_HOURS} hours`, String(ip).slice(0, 60), String(userAgent).slice(0, 300));
  return id;
}

const parseCookies = (header) => {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
};

function getSession(req) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const row = db.prepare(`SELECT s.id, s.booking_id, s.expires_at FROM portal_sessions s WHERE s.id = ?`).get(id);
  if (!row) return null;
  const expires = Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(expires) || expires < Date.now()) {
    db.prepare('DELETE FROM portal_sessions WHERE id = ?').run(id);
    return null;
  }
  return { id: row.id, bookingId: Number(row.booking_id) };
}

const destroySession = (req) => {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (id) db.prepare('DELETE FROM portal_sessions WHERE id = ?').run(id);
};

const destroySessionsFor = (bookingId) =>
  db.prepare('DELETE FROM portal_sessions WHERE booking_id = ?').run(Number(bookingId)).changes;

function cookieFor(req, id) {
  const secure = req.protocol === 'https' || String(req.get('x-forwarded-proto') || '') === 'https';
  const bits = [
    `${COOKIE}=${id}`,
    'Path=/',
    `Max-Age=${SESSION_HOURS * 3600}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

/** Middleware: halaman /portal/* wajib punya sesi; kalau tidak, kembali ke halaman masuk. */
function requirePortal(req, res, next) {
  const session = getSession(req);
  if (!session) {
    const target = req.originalUrl || '/portal';
    return res.redirect(`${req.basePath}/portal?next=${encodeURIComponent(target)}`);
  }
  const booking = bookingById(session.bookingId);
  if (!booking) {
    destroySession(req);
    return res.redirect(`${req.basePath}/portal`);
  }
  // Booking yang belum dikonfirmasi hanya punya jatah 24 jam (lihat accessState).
  const access = accessState(booking);
  if (!access.ok) {
    destroySession(req);
    expireSessionsFor(booking.id);
    return res.redirect(`${req.basePath}/portal?expired=1`);
  }
  req.portalBooking = booking;
  req.portalSession = session;
  next();
}

module.exports = {
  COOKIE,
  MAX_ATTEMPTS,
  WINDOW_MINUTES,
  PENDING_ACCESS_HOURS,
  accessExpiresAt,
  accessState,
  expireSessionsFor,
  normalizeCode,
  findBooking,
  bookingById,
  ensurePin,
  resetPin,
  verifyPin,
  visiblePin,
  hasPin,
  tooManyAttempts,
  recordAttempt,
  resetAttempts,
  createSession,
  getSession,
  destroySession,
  destroySessionsFor,
  cookieFor,
  clearCookie,
  requirePortal
};

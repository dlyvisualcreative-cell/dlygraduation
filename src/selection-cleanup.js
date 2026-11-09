'use strict';

/**
 * Pembersihan thumbnail / preview (V2 — kebijakan retensi).
 *
 * ATURAN KESELAMATAN (tidak boleh dilanggar oleh perubahan apa pun di masa depan):
 *  1. Modul ini HANYA menghapus file di `DATA_DIR/preview-cache` — turunan JPEG/WebP yang
 *     dibuat ulang kapan saja dari master. Master di `public/uploads` dan file di Google
 *     Drive TIDAK PERNAH disentuh.
 *  2. Baris `photo_selection_picks` (data pilihan klien) dan riwayat submit TIDAK PERNAH
 *     disentuh. Menghapus cache tidak mengubah pilihan.
 *  3. Penghapusan untuk portal yang sudah submit hanya dimasukkan ke antrean SETELAH
 *     transaksi submit commit & terverifikasi. Kalau submit gagal, tidak ada yang masuk
 *     antrean dan tidak ada file yang dihapus.
 *  4. Operasi idempotent: menghapus file yang sudah tidak ada dianggap sukses, jadi worker
 *     boleh diulang berkali-kali (retry) tanpa efek samping.
 *  5. Setiap aksi dicatat di `selection_access_log` (action = 'cleanup') — audit trail.
 *
 * Retensi (permintaan pemilik):
 *  - thumbnail galeri  : maksimal 30 hari
 *  - preview besar     : idle 7 hari, maksimal 30 hari
 *  - setelah submit    : masuk antrean penghapusan (grace singkat agar admin masih bisa
 *                        membuka pratinjau bila perlu)
 */

const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

const CACHE_DIR = path.join(DATA_DIR, 'preview-cache');

/** File cache per foto: `p<photoId>-<width>.<jpg|webp>` (lihat src/selection.js). */
const FILE_RE = /^p(\d+)-(\d+)\.(jpg|webp)$/;

const THUMB_MAX_DAYS = Number(process.env.THUMB_MAX_DAYS || 30);
const LARGE_IDLE_DAYS = Number(process.env.PREVIEW_IDLE_DAYS || 7);
const LARGE_MAX_DAYS = Number(process.env.PREVIEW_MAX_DAYS || 30);
/** Grace setelah submit sebelum thumbnail dibersihkan (jam). 0 = langsung. */
const SUBMIT_GRACE_HOURS = Number(process.env.THUMB_SUBMIT_GRACE_HOURS || 0);
const MAX_ATTEMPTS = 5;
const DAY = 86400000;

/* ------------------------------------------------------------------ */
/* Antrean                                                             */
/* ------------------------------------------------------------------ */
/**
 * Masukkan seluruh thumbnail satu portal ke antrean penghapusan.
 * Dipanggil HANYA setelah submit terverifikasi (atau saat retensi habis).
 */
function enqueuePortal(portalId, bookingId, reason = 'submitted', { dueInHours = SUBMIT_GRACE_HOURS } = {}) {
  const id = Number(portalId);
  if (!id) return { queued: false };
  // Idempotent: satu baris pending per (portal, reason) — submit dua kali tidak menggandakan.
  const existing = db.prepare(`SELECT id FROM selection_cleanup_queue
                               WHERE portal_id = ? AND scope = 'portal' AND reason = ? AND status = 'pending'`)
    .get(id, String(reason));
  if (existing) return { queued: false, id: existing.id, duplicate: true };
  const info = db.prepare(`INSERT INTO selection_cleanup_queue
      (portal_id, booking_id, photo_id, scope, reason, due_at, status, created_at)
      VALUES (?, ?, NULL, 'portal', ?, datetime('now', ?), 'pending', datetime('now'))`)
    .run(id, bookingId || null, String(reason), `+${Math.max(0, Number(dueInHours) || 0)} hours`);
  return { queued: true, id: Number(info.lastInsertRowid) };
}

const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM selection_cleanup_queue WHERE status = 'pending'").get().n;

function log(portalId, bookingId, action, reason, result) {
  try {
    db.prepare(`INSERT INTO selection_access_log
        (portal_id, booking_id, action, actor, reason, result, ip, created_at)
        VALUES (?, ?, ?, 'sistem', ?, ?, '', datetime('now'))`)
      .run(Number(portalId), bookingId || null, action, String(reason || '').slice(0, 200), String(result || 'ok').slice(0, 200));
  } catch (err) { /* log tidak boleh menggagalkan pembersihan */ }
}

/* ------------------------------------------------------------------ */
/* Penghapusan file                                                    */
/* ------------------------------------------------------------------ */
function cacheFilesForPortal(portalId) {
  const photoIds = db.prepare('SELECT id FROM photo_selection_photos WHERE portal_id = ?')
    .all(Number(portalId)).map((r) => Number(r.id));
  const wanted = new Set(photoIds);
  let names = [];
  try { names = fs.readdirSync(CACHE_DIR); } catch (err) { return { files: [], photoIds }; }
  const files = [];
  names.forEach((name) => {
    const m = FILE_RE.exec(name);
    if (!m) return;                       // .in-/.gen-/.out- dibersihkan oleh housekeeping lain
    if (!wanted.has(Number(m[1]))) return;
    files.push(path.join(CACHE_DIR, name));
  });
  return { files, photoIds };
}

/** Hapus satu file dengan aman (idempotent). Mengembalikan {removed,bytes}. */
function removeFile(file) {
  try {
    const st = fs.statSync(file);
    fs.unlinkSync(file);
    return { removed: 1, bytes: st.size };
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: 0, bytes: 0 }; // sudah tidak ada → sukses
    throw err;
  }
}

/**
 * Jalankan satu baris antrean. Idempotent: aman dipanggil berulang.
 * @returns {{ok:boolean, files:number, bytes:number, error?:string}}
 */
function runOne(row) {
  const portalId = Number(row.portal_id);
  // Jangan pernah menghapus cache portal yang BELUM submit kecuali memang kedaluwarsa.
  const portal = db.prepare('SELECT id, booking_id, status, submitted_at FROM photo_selections WHERE id = ?').get(portalId);
  if (!portal) {
    // Portal sudah dihapus admin → cache-nya tetap boleh dibersihkan.
    const { files } = cacheFilesForPortal(portalId);
    let removed = 0; let bytes = 0;
    files.forEach((f) => { const r = removeFile(f); removed += r.removed; bytes += r.bytes; });
    db.prepare("UPDATE selection_cleanup_queue SET status = 'done', files = ?, bytes = ?, done_at = datetime('now') WHERE id = ?")
      .run(removed, bytes, row.id);
    return { ok: true, files: removed, bytes };
  }
  if (row.reason === 'submitted' && !portal.submitted_at) {
    // Submit belum (atau tidak jadi) tersimpan → JANGAN hapus apa pun; kembalikan ke antrean.
    db.prepare("UPDATE selection_cleanup_queue SET status = 'pending', attempts = attempts + 1, last_error = ? WHERE id = ?")
      .run('portal belum submit', row.id);
    return { ok: false, files: 0, bytes: 0, error: 'portal belum submit' };
  }

  const { files } = cacheFilesForPortal(portalId);
  let removed = 0;
  let bytes = 0;
  const failures = [];
  files.forEach((f) => {
    try {
      const r = removeFile(f);
      removed += r.removed;
      bytes += r.bytes;
    } catch (err) {
      failures.push(path.basename(f));
    }
  });

  if (failures.length) {
    const attempts = Number(row.attempts) + 1;
    db.prepare(`UPDATE selection_cleanup_queue
                SET attempts = ?, status = ?, last_error = ? WHERE id = ?`)
      .run(attempts, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        `gagal hapus ${failures.length} file: ${failures.slice(0, 3).join(', ')}`.slice(0, 300), row.id);
    log(portalId, portal.booking_id, 'cleanup', row.reason, `retry ${attempts}/${MAX_ATTEMPTS} (${failures.length} gagal)`);
    return { ok: false, files: removed, bytes, error: `${failures.length} gagal` };
  }

  db.prepare(`UPDATE selection_cleanup_queue SET status = 'done', files = ?, bytes = ?,
              attempts = attempts + 1, last_error = '', done_at = datetime('now') WHERE id = ?`)
    .run(removed, bytes, row.id);
  log(portalId, portal.booking_id, 'cleanup', row.reason,
    `thumbnail dihapus: ${removed} file, ${Math.round(bytes / 1024)}KB (pilihan tetap utuh)`);
  return { ok: true, files: removed, bytes };
}

/** Proses antrean yang sudah jatuh tempo (dipanggil worker berkala). */
function drain(limit = 20) {
  const rows = db.prepare(`SELECT * FROM selection_cleanup_queue
                           WHERE status = 'pending' AND due_at <= datetime('now')
                           ORDER BY due_at LIMIT ?`).all(Number(limit) || 20);
  const out = [];
  rows.forEach((row) => {
    try { out.push({ id: row.id, ...runOne(row) }); } catch (err) {
      db.prepare(`UPDATE selection_cleanup_queue SET attempts = attempts + 1,
                  status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
                  last_error = ? WHERE id = ?`)
        .run(MAX_ATTEMPTS, String(err.message || '').slice(0, 300), row.id);
      out.push({ id: row.id, ok: false, error: String(err.message || '') });
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Retensi berbasis waktu (idle 7 hari / maks 30 hari)                */
/* ------------------------------------------------------------------ */
/**
 * Bersihkan file cache yang melewati kebijakan retensi, TANPA menyentuh data pilihan.
 *  - lebar <= 640 (thumbnail galeri): lebih tua dari THUMB_MAX_DAYS → hapus
 *  - lebar 1600 (preview besar)     : idle > LARGE_IDLE_DAYS atau umur > LARGE_MAX_DAYS → hapus
 */
function sweepExpired({ now = Date.now(), dryRun = false } = {}) {
  let names = [];
  try { names = fs.readdirSync(CACHE_DIR); } catch (err) { return { removed: 0, bytes: 0, scanned: 0 }; }
  let removed = 0;
  let bytes = 0;
  let scanned = 0;
  names.forEach((name) => {
    const m = FILE_RE.exec(name);
    if (!m) return;
    scanned += 1;
    const width = Number(m[2]);
    const file = path.join(CACHE_DIR, name);
    let st;
    try { st = fs.statSync(file); } catch (err) { return; }
    const ageDays = (now - st.mtimeMs) / DAY;
    const expired = width >= 1600
      ? (ageDays > LARGE_IDLE_DAYS || ageDays > LARGE_MAX_DAYS)
      : ageDays > THUMB_MAX_DAYS;
    if (!expired) return;
    if (dryRun) { removed += 1; bytes += st.size; return; }
    try {
      const r = removeFile(file);
      removed += r.removed;
      bytes += r.bytes;
    } catch (err) { /* dicoba lagi pada sapuan berikutnya */ }
  });
  if (!dryRun && removed) {
    log(null, null, 'cleanup', 'retensi', `${removed} file cache kedaluwarsa dihapus (${Math.round(bytes / 1024)}KB)`);
  }
  return { removed, bytes, scanned };
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */
let timer = null;
function startWorker({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (timer) return timer;
  const tick = () => {
    try { drain(20); } catch (err) { console.error('[selection-cleanup] drain', err.message); }
    try { sweepExpired(); } catch (err) { console.error('[selection-cleanup] sweep', err.message); }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  // Sapuan pertama setelah 1 menit (jangan berebut CPU dengan warm-up boot).
  setTimeout(tick, 60 * 1000).unref();
  return timer;
}
function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  CACHE_DIR,
  THUMB_MAX_DAYS,
  LARGE_IDLE_DAYS,
  LARGE_MAX_DAYS,
  enqueuePortal,
  pendingCount,
  drain,
  sweepExpired,
  cacheFilesForPortal,
  startWorker,
  stopWorker
};

'use strict';

/**
 * Client Photo Selection Portal (V9).
 *
 * One portal per booking (`photo_selections.booking_id` is UNIQUE). Access is granted ONLY
 * by the portal's random token — the booking code / booking id is never enough.
 *
 * The MASTER file of every photo lives in `photo_selection_photos.image` and is never
 * rendered to a client: the public portal streams a resized, watermarked derivative from
 * a token-scoped route (/selection/:token/photo/:id), so the real file URL never reaches
 * the browser. The derivative is cached on disk (regenerable from the master) and the
 * cache is invalidated on delete.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { db, DATA_DIR, getSettings } = require('./db');
const util = require('./util');
const media = require('./media');

/* ------------------------------------------------------------------ */
/* Statuses                                                            */
/* ------------------------------------------------------------------ */
const STATUSES = [
  { value: 'none', label: 'Belum Dibuat', tone: 'muted' },
  { value: 'waiting', label: 'Menunggu Pilihan', tone: 'warn' },
  { value: 'picking', label: 'Sedang Memilih', tone: 'info' },
  { value: 'submitted', label: 'Pilihan Terkirim', tone: 'ok' },
  { value: 'processing', label: 'Sedang Diproses', tone: 'info' },
  { value: 'done', label: 'Selesai', tone: 'ok' },
  { value: 'expired', label: 'Deadline Berakhir', tone: 'warn' },
  { value: 'disabled', label: 'Dinonaktifkan', tone: 'muted' }
];

/** Manual statuses the admin may set (picking/waiting/expired/disabled are derived). */
const ADMIN_STATUSES = ['waiting', 'submitted', 'processing', 'done'];

const statusLabel = (value) => (STATUSES.find((s) => s.value === value) || STATUSES[0]).label;

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */
const portalForBooking = (bookingId) =>
  db.prepare('SELECT * FROM photo_selections WHERE booking_id = ?').get(Number(bookingId));

const portalById = (id) => db.prepare('SELECT * FROM photo_selections WHERE id = ?').get(Number(id));

const portalByToken = (token) => {
  const value = String(token || '');
  if (!/^[a-f0-9]{32,64}$/.test(value)) return null;
  return db.prepare('SELECT * FROM photo_selections WHERE token = ?').get(value);
};

const photosFor = (portalId) =>
  db.prepare(`SELECT * FROM photo_selection_photos WHERE portal_id = ?
              ORDER BY sort_order ASC, id ASC`).all(Number(portalId));

const photoById = (portalId, photoId) =>
  db.prepare('SELECT * FROM photo_selection_photos WHERE id = ? AND portal_id = ?')
    .get(Number(photoId), Number(portalId));

/** Selected photos with everything the admin exports need (order = pick order). */
const pickedPhotos = (portalId) =>
  db.prepare(`SELECT ph.*, pk.position, pk.created_at AS picked_at
              FROM photo_selection_picks pk
              JOIN photo_selection_photos ph ON ph.id = pk.photo_id
              WHERE pk.portal_id = ?
              ORDER BY COALESCE(pk.position, 9999), ph.sort_order, ph.id`).all(Number(portalId));

/** Selected photo ids, ordered by the gallery order (stable for the client). */
const pickedIds = (portalId) =>
  db.prepare(`SELECT p.photo_id FROM photo_selection_picks p
              JOIN photo_selection_photos ph ON ph.id = p.photo_id
              WHERE p.portal_id = ? ORDER BY ph.sort_order, ph.id`).all(Number(portalId))
    .map((r) => r.photo_id);

const pickCount = (portalId) =>
  db.prepare('SELECT COUNT(*) AS n FROM photo_selection_picks WHERE portal_id = ?')
    .get(Number(portalId)).n;

/**
 * Derived portal status:
 *  - disabled  → admin turned the portal off (was: is_open = 0)
 *  - expired   → the selection deadline has passed and nothing was submitted
 *  - submitted/processing/done are explicit admin/client states
 *  - picking   → the client already picked something
 *  - waiting   → portal is live but untouched
 */
function deriveStatus(status, picks, opts = {}) {
  if (!status) return 'none';
  if (['submitted', 'processing', 'done'].includes(status)) return status;
  if (opts.open === 0 || opts.open === false) return 'disabled';
  if (opts.expired) return 'expired';
  return Number(picks) > 0 ? 'picking' : 'waiting';
}

const isExpired = (portal) => {
  if (!portal || !portal.deadline) return false;
  return util.todayISO() > String(portal.deadline).slice(0, 10);
};

/** Portal closed by the admin, past its deadline, or past its own expiry date. */
const isClosed = (portal) => {
  if (!portal) return true;
  if (Number(portal.is_open) === 0) return true;
  if (isExpired(portal)) return true;
  if (portal.expires_at && util.todayISO() > String(portal.expires_at).slice(0, 10)) return true;
  return false;
};

function statusOf(portal) {
  if (!portal) return 'none';
  return deriveStatus(portal.status, pickCount(portal.id), {
    open: Number(portal.is_open),
    expired: isExpired(portal)
  });
}

/** Portal + booking context (client, package, session date, quota source). */
function detail(portal) {
  if (!portal) return null;
  const booking = db.prepare(`SELECT b.*, c.name AS city_name, p.name AS package_name,
                                     k.name AS category_name
                              FROM bookings b
                              JOIN cities c ON c.id = b.city_id
                              JOIN packages p ON p.id = b.package_id
                              LEFT JOIN package_categories k ON k.id = b.category_id
                              WHERE b.id = ?`).get(portal.booking_id);
  return { portal, booking, status: statusOf(portal), picks: pickedIds(portal.id) };
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */
const newToken = () => crypto.randomBytes(24).toString('hex'); // 192-bit, hex (48 chars)

/** Quota suggestion = the booked duration's edited-photo count, else the owner default. */
function defaultQuota(bookingId) {
  const row = db.prepare(`SELECT COALESCE(b.edited_photos_snapshot, d.edited_photos, p.edited_photos) AS n
                          FROM bookings b
                          LEFT JOIN packages p ON p.id = b.package_id
                          LEFT JOIN package_durations d
                                 ON d.package_id = b.package_id
                                AND d.duration_minutes = COALESCE(b.duration_minutes, b.duration)
                          WHERE b.id = ?`).get(Number(bookingId));
  const n = Number(row && row.n);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 500);
  const fallback = Number(getSettings().selection_default_quota);
  return Number.isFinite(fallback) && fallback > 0 ? Math.min(fallback, 500) : 40;
}

/** Default deadline = today + `selection_default_days` days (0 ⇒ no deadline). */
function defaultDeadline() {
  const days = Number(getSettings().selection_default_days);
  if (!Number.isFinite(days) || days <= 0) return null;
  return util.addDaysISO(util.todayISO(), Math.min(days, 365));
}

function createForBooking(bookingId, extra = {}) {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(bookingId));
  if (!booking) return null;
  const existing = portalForBooking(booking.id);
  // Never create a duplicate portal for a booking that already has one.
  if (existing) return existing;

  const settings = getSettings();
  const instructions = String(settings.selection_default_instructions || '').trim()
    || 'Silakan pilih foto favorit Anda dari hasil sesi pemotretan di bawah ini.';

  const ttlDays = Number(settings.selection_portal_ttl_days);
  const expiresAt = Number.isFinite(ttlDays) && ttlDays > 0
    ? util.addDaysISO(util.todayISO(), Math.min(ttlDays, 365))
    : null;

  const quota = Number(extra.quota) > 0 ? Math.min(Number(extra.quota), 500) : defaultQuota(booking.id);
  const deadline = extra.deadline === undefined ? defaultDeadline() : (extra.deadline || null);
  const allowDownload = extra.allowDownload === undefined
    ? (settings.selection_allow_download === '1' ? 1 : 0)
    : (extra.allowDownload ? 1 : 0);
  const requireFull = extra.requireFullQuota === undefined
    ? (settings.selection_require_full_quota === '1' ? 1 : 0)
    : (extra.requireFullQuota ? 1 : 0);

  const insert = db.prepare(`INSERT INTO photo_selections
      (booking_id, token, quota, instructions, deadline, drive_url, allow_download,
       require_full_quota, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      insert.run(booking.id, newToken(), quota, instructions, deadline,
        String(extra.driveUrl || ''), allowDownload, requireFull, expiresAt);
      break;
    } catch (err) {
      // Extremely unlikely token collision — mint another one.
      if (!/UNIQUE/.test(String(err.message))) throw err;
    }
  }
  return portalForBooking(booking.id);
}

/* ------------------------------------------------------------------ */
/* Photo codes / ordering                                              */
/* ------------------------------------------------------------------ */
function nextCode(portalId) {
  const rows = db.prepare('SELECT code FROM photo_selection_photos WHERE portal_id = ?').all(Number(portalId));
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.code || '').replace(/[^0-9]/g, ''));
    if (Number.isFinite(n) && n > max) max = n;
  });
  return String(max + 1).padStart(3, '0');
}

function nextSortOrder(portalId) {
  return db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM photo_selection_photos WHERE portal_id = ?')
    .get(Number(portalId)).n;
}

/* ------------------------------------------------------------------ */
/* Watermarked preview                                                 */
/* ------------------------------------------------------------------ */
const CACHE_DIR = path.join(DATA_DIR, 'preview-cache');
/**
 * Preview variants (V10 / V2). Thumbnails used to receive the 1600px watermarked file, so a
 * 45-photo portal downloaded ~22MB for 171px tiles. Each width now has its own cache file.
 * The watermark is burned into every variant so the text stays proportional to the photo.
 *
 * V2 (akurasi & performa): daftar lebar ini adalah SATU-SATUNYA sumber kebenaran.
 * Views meminta 320/640/1600; lebar lain (dulu `?w=400` dan `?w=800` dari halaman
 * baca-saja) TIDAK dikenal sehingga jatuh ke 1600 — itulah sebabnya satu tile bisa
 * mengunduh 84 KB. Sekarang lebar tak dikenal "di-snap" ke varian terdekat.
 */
const PREVIEW_WIDTHS = [320, 640, 1600];
/** Thumbnail galeri (WebP, target 50–100 KB) vs preview besar (JPEG). */
const THUMB_WIDTHS = [320, 640];
const previewFile = (photoId, width, format = 'jpg') =>
  path.join(CACHE_DIR, `p${Number(photoId)}-${Number(width) || 1600}.${format === 'webp' ? 'webp' : 'jpg'}`);

/** Lebar yang benar-benar dipakai: snap ke varian terdekat (tidak pernah 1600 untuk tile). */
function normalizeWidth(width) {
  const n = Number(width);
  if (!Number.isFinite(n) || n <= 0) return 1600;
  if (PREVIEW_WIDTHS.includes(n)) return n;
  // pilih varian terkecil yang masih >= permintaan, kalau tidak ada pakai yang terbesar
  const bigger = PREVIEW_WIDTHS.filter((w) => w >= n).sort((a, b) => a - b)[0];
  if (bigger) return bigger;
  return PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1];
}
const isThumbWidth = (width) => THUMB_WIDTHS.includes(Number(width));

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
];
const FONT_REGULAR = FONT_CANDIDATES.find((f) => fs.existsSync(f)) || '';
const FONT_BOLD = FONT_REGULAR;

/**
 * V2: konversi preview WAJIB lewat antrean proses gambar yang sama dengan /media
 * (`images.withImageSlot`). Tanpa ini, membuka satu portal (45–700 foto) bisa menjalankan
 * belasan `convert` sekaligus dan membuat seluruh server tersendat.
 * `priority` = 'high' untuk permintaan pengunjung, 'low' untuk warm-up latar.
 */
function runConvert(args, timeout = 20000, priority = 'high') {
  const images = require('./images');
  return images.withImageSlot(() => new Promise((resolve, reject) => {
    execFile('convert', args, { timeout, maxBuffer: 1024 * 1024 }, (err) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(true);
    });
  }), priority);
}

/** Master bytes: local upload (fs), the media CDN, or Google Drive (server-side only). */
async function masterBytes(photo) {
  if (photo && photo.source === 'drive' && photo.drive_file_id) {
    const drive = require('./drive');
    return drive.downloadBytes(photo.drive_file_id);
  }
  const local = media.localPathFor(photo.image);
  if (local) return fs.promises.readFile(local);
  const url = String(photo.image || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Lokasi file foto tidak dikenal.');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal mengambil file foto (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * File sementara yang sedang dipakai proses ini. Kalau aplikasi dimatikan (publish /
 * restart) di tengah konversi, file ini bisa tertinggal dan masing-masing berukuran
 * sebesar master (1–6 MB!). Dulu inilah yang membuat `preview-cache` membengkak sampai
 * 328 MB. Sekarang: (a) dilacak, (b) dihapus saat proses berhenti, (c) disapu berkala.
 */
const activeTempFiles = new Set();
function cleanupActiveTempFiles() {
  activeTempFiles.forEach((file) => {
    try { fs.unlinkSync(file); } catch (err) { /* sudah hilang */ }
  });
  activeTempFiles.clear();
}
['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => { cleanupActiveTempFiles(); process.exit(0); });
});
process.on('exit', cleanupActiveTempFiles);

async function writePreviewFromBuffer(photo, buffer, width = 1600, { background = false } = {}) {
  const targetWidth = normalizeWidth(width);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmpIn = path.join(CACHE_DIR, `.in-${photo.id}-${Date.now()}-${process.pid}.tmp`);
  activeTempFiles.add(tmpIn);
  // V2: thumbnail galeri (maks 640 px) dibuat sebagai **WebP** — jauh lebih kecil dari JPEG
  // untuk kualitas visual yang setara (target pemilik: 50–100 KB per foto).
  const format = isThumbWidth(targetWidth) ? 'webp' : 'jpg';
  const target = previewFile(photo.id, targetWidth, format);
  const tmpOut = `${target}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmpIn, buffer);
  } catch (err) {
    activeTempFiles.delete(tmpIn);
    throw err;
  }
  const watermark = getSettings().selection_watermark !== '0';
  // Point sizes scale with the output so the watermark looks the same at every width.
  const scale = targetWidth / 1600;
  // `jpeg:size` membuat ImageMagick mendekode JPEG pada ukuran perkiraan lebih dulu
  // (bukan resolusi penuh). Untuk thumbnail 320px ini memotong waktu konversi nyaris
  // separuh tanpa mengubah hasil visual.
  const decodeHint = `${Math.max(640, targetWidth * 2)}x${Math.max(640, targetWidth * 2)}`;
  const args = [
    '-define', `jpeg:size=${decodeHint}`,
    tmpIn, '-auto-orient', '-resize', `${targetWidth}x${targetWidth}>`,
    '-strip',
    // WebP: kualitas 78 → 320 px ± 12–20 KB, 640 px ± 30–60 KB (di bawah batas 100 KB).
    ...(format === 'webp'
      ? ['-quality', '78', '-define', 'webp:method=4']
      : ['-quality', '80', '-interlace', 'Plane'])   // progressive JPEG untuk lightbox
  ];
  if (watermark && FONT_REGULAR) {
    const big = Math.max(16, Math.round(46 * scale));
    const small = Math.max(9, Math.round(20 * scale));
    args.push(
      '-font', FONT_BOLD, '-pointsize', String(big), '-fill', 'rgba(255,255,255,0.20)',
      '-gravity', 'center', '-annotate', `${Math.max(120, Math.round(330 * scale))}x${Math.max(120, Math.round(330 * scale))}+0+0`, 'DLY GRADUATION',
      '-font', FONT_REGULAR, '-pointsize', String(small), '-fill', 'rgba(255,255,255,0.60)',
      '-gravity', 'southeast', '-annotate', `+${Math.max(8, Math.round(26 * scale))}+${Math.max(6, Math.round(20 * scale))}`,
      `#${photo.code || photo.id} · DLY`
    );
  }
  args.push(`${format}:` + tmpOut);
  try {
    await runConvert(args, 20000, background ? 'low' : 'high');
    await fs.promises.rename(tmpOut, target);
  } finally {
    activeTempFiles.delete(tmpIn);
    fs.promises.unlink(tmpIn).catch(() => {});
    fs.promises.unlink(tmpOut).catch(() => {});
  }
  return target;
}

/**
 * Returns { file, format } of the cached preview, generating it when missing.
 * Throws when neither ImageMagick nor the master file are usable — the caller then
 * falls back to streaming the master bytes through the same token-protected route.
 *
 * V2: lebar selalu di-snap ke PREVIEW_WIDTHS (tak dikenal → varian terdekat, bukan 1600),
 * dan thumbnail galeri disajikan sebagai WebP.
 */
async function ensurePreview(photo, width = 1600) {
  const targetWidth = normalizeWidth(width);
  const format = isThumbWidth(targetWidth) ? 'webp' : 'jpg';
  const target = previewFile(photo.id, targetWidth, format);
  try {
    const stat = await fs.promises.stat(target);
    if (stat.size > 0) return { file: target, format };
  } catch (err) { /* not cached yet */ }
  const bytes = await masterBytes(photo);
  try {
    const file = await writePreviewFromBuffer(photo, bytes, targetWidth);
    // Satu unduhan master dipakai untuk SEMUA varian: tanpa ini, membuka lightbox setelah
    // melihat thumbnail akan mengunduh ulang file Drive yang sama (lambat & boros kuota).
    PREVIEW_WIDTHS.filter((w) => w !== targetWidth).forEach((w) => {
      const other = previewFile(photo.id, w, isThumbWidth(w) ? 'webp' : 'jpg');
      if (!fs.existsSync(other)) writePreviewFromBuffer(photo, bytes, w, { background: true }).catch(() => {});
    });
    return { file, format };
  } catch (err) {
    // Konversi gagal (mis. ImageMagick bermasalah): pakai varian JPEG lama bila ada supaya
    // portal tetap tampil. Tidak pernah membuat ulang master.
    const legacy = previewFile(photo.id, targetWidth, 'jpg');
    try {
      const st = await fs.promises.stat(legacy);
      if (st.size > 0) return { file: legacy, format: 'jpg' };
    } catch (err2) { /* tidak ada */ }
    throw err;
  }
}

/**
 * Isi cache thumbnail di BELAKANG LAYAR supaya portal tidak menunggu unduhan Drive +
 * ImageMagick saat klien membukanya. Concurrency dibatasi 3 agar kuota Drive/CPU tidak
 * dihabiskan oleh satu portal. Tidak pernah melempar error ke pemanggil.
 */
async function warmPreviews(portalId, { width = 320, concurrency = 2, limit = 400 } = {}) {
  const photos = photosFor(portalId)
    .filter((p) => Number(p.is_available) !== 0)
    .slice(0, limit);
  const pending = [];
  const warmWidth = normalizeWidth(width);
  for (const photo of photos) {
    const target = previewFile(photo.id, warmWidth, isThumbWidth(warmWidth) ? 'webp' : 'jpg');
    let cached = false;
    try {
      const stat = await fs.promises.stat(target);
      cached = stat.size > 0;
    } catch (err) { cached = false; }
    if (!cached) pending.push(photo);
  }
  if (!pending.length) return { total: photos.length, built: 0 };

  let built = 0;
  let index = 0;
  const worker = async () => {
    while (index < pending.length) {
      const photo = pending[index++];
      try {
        await ensurePreview(photo, warmWidth);
        built += 1;
      } catch (err) {
        // Diamkan: thumbnail akan dicoba lagi saat benar-benar diminta browser.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return { total: photos.length, built, width };
}

/**
 * Fire-and-forget wrapper. Dijalankan dengan JEDA supaya respons HTML portal dan thumbnail
 * pertama yang diminta browser tidak berebut CPU dengan konversi latar belakang
 * (satu inti CPU: warm yang jalan lebih dulu justru memperlambat halaman pertama).
 */
function warmPreviewsInBackground(portalId, opts, delayMs = 4000) {
  const timer = setTimeout(() => {
    warmPreviews(portalId, opts).catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
  if (timer.unref) timer.unref();
}

function dropPreview(photoId) {
  PREVIEW_WIDTHS.forEach((w) => {
    fs.promises.unlink(previewFile(photoId, w, isThumbWidth(w) ? 'webp' : 'jpg')).catch(() => {});
    fs.promises.unlink(previewFile(photoId, w, 'jpg')).catch(() => {});
    fs.promises.unlink(previewFile(photoId, w, 'webp')).catch(() => {});
  });
}

/* ------------------------------------------------------------------ */
/* Sync from Google Drive (V9.2)                                       */
/* ------------------------------------------------------------------ */
/**
 * Reads the portal's Drive folder and reconciles it with the portal photos.
 *
 * Rules (owner's requirements):
 *  - the Drive file id is the identity ⇒ re-syncing can never duplicate a photo;
 *  - a file that disappeared from Drive is marked `is_available = 0`, NEVER deleted,
 *    so a client's pick history stays intact;
 *  - if the file comes back, it is available again;
 *  - new files are appended at the end (existing order/codes are untouched);
 *  - client picks are never modified here.
 */
async function syncFromDrive(portal, folderIdInput) {
  const drive = require('./drive');
  const parsed = drive.parseFolderId(folderIdInput || portal.drive_folder_id || portal.drive_url || '');
  if (!parsed.ok) {
    throw drive.fail('invalid-link', parsed.message);
  }
  const folder = await drive.getFolder(parsed.id);
  const { files, truncated, pages } = await drive.listFolderPhotos(parsed.id);

  const existing = photosFor(portal.id);
  const byDriveId = new Map();
  existing.forEach((p) => {
    if (p.drive_file_id) byDriveId.set(p.drive_file_id, p);
  });

  let order = nextSortOrder(portal.id);
  const added = [];
  const restored = [];
  let unavailable = 0;

  const insert = db.prepare(`INSERT INTO photo_selection_photos
      (portal_id, code, image, file_name, source, drive_file_id, mime_type, file_size,
       caption, is_primary, sort_order, is_available)
      VALUES (?, ?, ?, ?, 'drive', ?, ?, ?, '', ?, ?, 1)`);
  const hasPrimary = existing.some((p) => Number(p.is_primary) === 1);

  const run = db.transaction(() => {
    // 1) upsert everything currently in the folder
    files.forEach((f) => {
      const found = byDriveId.get(f.id);
      if (found) {
        db.prepare(`UPDATE photo_selection_photos
                    SET file_name = ?, mime_type = ?, file_size = ?, is_available = 1
                    WHERE id = ?`)
          .run(f.name, f.mimeType, f.size, found.id);
        if (Number(found.is_available) === 0) restored.push(found.id);
        return;
      }
      const code = nextCode(portal.id);
      const isPrimary = hasPrimary || added.length > 0 ? 0 : 1;
      const info = insert.run(
        portal.id, code, '', f.name, f.id, f.mimeType, f.size,
        isPrimary, order
      );
      added.push(Number(info.lastInsertRowid));
      order += 1;
    });

    // 2) anything no longer in the folder → unavailable (rows and picks stay)
    const seen = new Set(files.map((f) => f.id));
    existing.forEach((p) => {
      if (!p.drive_file_id) return;
      if (!seen.has(p.drive_file_id) && Number(p.is_available) === 1) {
        db.prepare('UPDATE photo_selection_photos SET is_available = 0 WHERE id = ?').run(p.id);
        unavailable += 1;
      }
    });

    // 3) the first photo is always flagged as the folder cover
    if (!hasPrimary) {
      const first = db.prepare(`SELECT id FROM photo_selection_photos WHERE portal_id = ?
                                ORDER BY sort_order, id LIMIT 1`).get(portal.id);
      if (first) db.prepare('UPDATE photo_selection_photos SET is_primary = 1 WHERE id = ?').run(first.id);
    }

    db.prepare(`UPDATE photo_selections
                SET drive_folder_id = ?, drive_url = CASE WHEN drive_url = '' THEN ? ELSE drive_url END,
                    sync_at = datetime('now'), sync_error = '', sync_count = ?,
                    updated_at = datetime('now')
                WHERE id = ?`)
      .run(folder.folder.id, folder.folder.url || `https://drive.google.com/drive/folders/${folder.folder.id}`,
        files.length, portal.id);
  });
  run();

  // Nomor tampilan DLY#### untuk file yang namanya bukan pola DLY (mis. nama screenshot).
  try { assignDisplayNumbers(portal.id); } catch (err) { /* kosmetik: jangan gagalkan sync */ }

  // Previews are generated lazily by the photo route; nothing to do here.
  return {
    ok: true,
    folder: folder.folder,
    total: files.length,
    added: added.length,
    restored: restored.length,
    unavailable,
    pages,
    truncated
  };
}

/**
 * Folder sumber foto portal = subfolder "01. FILE MENTAH" milik booking.
 * Satu sumber kebenaran untuk: wizard portal, tombol "Perbarui", pengaturan portal, dan
 * tombol "Foto Siap Dipilih". Mengembalikan {id,url} (kosong bila booking belum punya).
 */
function rawFolderOf(bookingId) {
  const row = db.prepare('SELECT drive_raw_id FROM bookings WHERE id = ?').get(Number(bookingId));
  const id = String((row && row.drive_raw_id) || '').trim();
  return {
    id,
    url: id ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : ''
  };
}

/* ------------------------------------------------------------------ */
/* Drive folder link (display + source)                                */
/* ------------------------------------------------------------------ */
/**
 * Accepts a pasted Drive folder link (or a bare folder id) and returns a canonical
 * https://drive.google.com/drive/folders/<id> URL. Anything that is not a Google
 * Drive/docs link is rejected so a typo or another site's URL cannot end up in the
 * client portal.
 */
function normalizeDriveUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) {
    return `https://drive.google.com/drive/folders/${raw}`;
  }
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!/(^|\.)(drive|docs)\.google\.com$/i.test(url.hostname)) return null;
  return url.toString();
}

/**
 * Which Drive link the portal should show.
 * `custom` wins over the booking's app-created folder; `visible` follows drive_show.
 */
function driveFolderFor(portal, booking) {
  const custom = String((portal && portal.drive_url) || '').trim();
  const fromBooking = String((booking && booking.drive_folder_url) || '').trim();
  const url = custom || fromBooking;
  // v14.6 — folder MENTAH ("01. FILE MENTAH") milik booking ini.
  // URL dibentuk dari folder ID yang TERSIMPAN pada booking (bukan dari nama client
  // dan bukan tebakan lokasi): format tautan folder Google Drive stabil per ID.
  // Tidak ada kredensial / ID booking lain yang ikut dikirim ke browser.
  const rawId = String((booking && booking.drive_raw_id) || '').trim();
  return {
    url: url || '',
    source: custom ? 'custom' : (fromBooking ? 'booking' : 'none'),
    visible: Boolean(url) && (!portal || Number(portal.drive_show) !== 0),
    raw: {
      id: rawId,
      url: rawId ? `https://drive.google.com/drive/folders/${encodeURIComponent(rawId)}` : '',
      visible: Boolean(rawId)
    }
  };
}

/* ------------------------------------------------------------------ */
/* WhatsApp invite                                                     */
/* ------------------------------------------------------------------ */
const DEFAULT_SELECTION_TEMPLATE = [
  'Halo Kak {{nama}}! 👋😊',
  '',
  'Terima kasih sudah melakukan sesi foto bersama DLY Graduation.',
  '',
  'Sekarang Kakak sudah bisa memilih foto favorit melalui halaman seleksi foto kami.',
  '',
  'Silakan buka link berikut:',
  '',
  '{{link}}',
  '',
  'Pilih foto sesuai kuota paket Kakak ({{kuota}} foto{{paket_text}}), kemudian tekan tombol Kirim Pilihan Foto jika sudah selesai.',
  '',
  'Selamat memilih foto favorit Kakak! 📸✨'
].join('\n');

function portalUrl(origin, token) {
  const base = String(origin || '').replace(/\/$/, '');
  return `${base}/selection/${token}`;
}

function waVars(ctx, link) {
  const b = (ctx && ctx.booking) || {};
  const p = (ctx && ctx.portal) || {};
  const drive = driveFolderFor(p, b);
  return {
    nama: b.client_name || 'Kak',
    link,
    kuota: p.quota == null ? '' : String(p.quota),
    paket: b.package_name || '-',
    paket_text: b.package_name ? ` — paket ${b.package_name}` : '',
    tanggal: b.shooting_date ? util.formatDateID(b.shooting_date, true) : '-',
    jam: b.shooting_time ? `${b.shooting_time} WIB` : '-',
    booking_id: b.code || '-',
    kampus: b.campus || '-',
    kota: b.city_name || '-',
    folder_drive: drive.visible ? drive.url : '-'
  };
}

function waMessage(ctx, link) {
  const settings = getSettings();
  // `wa_portal_template` is the admin-editable "Kirim Link Portal" template (V9.2);
  // `wa_selection_template` is the earlier key and stays supported.
  const template = String(settings.wa_portal_template || settings.wa_selection_template || '').trim()
    || DEFAULT_SELECTION_TEMPLATE;
  return util.renderTemplate(template, waVars(ctx, link));
}

/**
 * The client's "send my selection to the admin" message (built from the DB, not the DOM).
 * Teksnya bisa diubah admin di Dashboard → Template Chat (`wa_submit_template`).
 * Daftar nama file TIDAK pernah diubah: satu nama per baris, tanpa nomor urut & ekstensi.
 */
function clientSubmitMessage(ctx) {
  const b = (ctx && ctx.booking) || {};
  const p = (ctx && ctx.portal) || {};
  const photos = pickedPhotos(p.id);
  const list = photos.map((ph) => photoBaseName(ph)).join('\n') || '(belum ada foto dipilih)';
  const template = String(getSettings().wa_submit_template || '').trim() || util.DEFAULT_SUBMIT_TEMPLATE;
  return util.renderTemplate(template, {
    nama: b.client_name || '-',
    kampus: b.campus || '-',
    paket: b.package_name || '-',
    kode: b.code || '-',
    jumlah: String(photos.length),
    daftar_foto: list
  });
}

/* ------------------------------------------------------------------ */
/* CSV / ZIP export (admin only)                                       */
/* ------------------------------------------------------------------ */
/** Human name of a photo: the Drive file name when present, else the code. */
const photoName = (ph) => String((ph && (ph.file_name || ph.caption)) || '').trim()
  || (ph && ph.code ? `#${ph.code}` : '');

/** Buang ekstensi & nomor urut di depan ("1. DLY0007.jpg" → "DLY0007"). */
function cleanFileName(raw) {
  let name = String(raw || '').trim();
  if (!name) return '';
  name = name.replace(/^\s*\d+\s*[.)\-:]\s*/, '');
  name = name.replace(/\.(jpe?g|png|webp|gif|heic|heif|tiff?|bmp)$/i, '');
  return name.trim();
}

/** Digit DLY pada sebuah nama file ("DLY00013.jpg" → "00013"), atau '' bila bukan pola DLY. */
function dlyDigits(raw) {
  const base = cleanFileName(raw);
  const m = base.match(/^DLY[\s._-]*(\d{3,})$/i);
  return m ? m[1] : '';
}
const dlyNumber = (raw) => Number(dlyDigits(raw)) || 0;

/**
 * Nama file untuk pesan WhatsApp / daftar ke admin.
 *
 * Aturan (revisi pemilik):
 *  - File yang SUDAH berpola DLY (DLY00013) dipakai apa adanya → "DLY00013".
 *  - File yang BUKAN pola DLY (mis. "Tangkapan Layar …") diberi NOMOR URUT OTOMATIS
 *    yang stabil (kolom `display_no`), sehingga tetap mudah disortir.
 *  - Tidak pernah memakai nomor urut pilihan & tidak pernah berekstensi.
 */
function photoBaseName(ph) {
  const raw = String((ph && (ph.file_name || ph.caption)) || '').trim();
  // Nama asli DLY dipertahankan PERSIS (DLY00013 tetap DLY00013, tidak dipotong jadi DLY0013).
  const digitsFromName = dlyDigits(raw);
  if (digitsFromName) return `DLY${digitsFromName}`;
  const seq = Number(ph && ph.display_no) || 0;
  if (seq > 0) return `DLY${String(seq).padStart(4, '0')}`;
  const digits = String((ph && ph.code) || '').replace(/\D/g, '');
  if (digits) return `DLY${digits.padStart(4, '0')}`;
  return cleanFileName(raw) || String((ph && ph.code) || '');
}

/**
 * Tetapkan nomor tampilan otomatis untuk file yang BUKAN pola DLY.
 * Nomor melanjutkan nomor DLY tertinggi di portal (jadi tidak bertabrakan dengan
 * DLY0007 milik file asli) dan bersifat STABIL: nomor yang sudah ada tidak diubah.
 */
function assignDisplayNumbers(portalId) {
  const rows = photosFor(Number(portalId));
  let maxDly = 0;
  rows.forEach((r) => {
    const n = dlyNumber(r.file_name);
    if (n > 0) maxDly = Math.max(maxDly, n);
  });
  rows.forEach((r) => {
    const n = Number(r.display_no) || 0;
    if (dlyNumber(r.file_name) === 0 && n > 0) maxDly = Math.max(maxDly, n);
  });

  const upd = db.prepare('UPDATE photo_selection_photos SET display_no = ? WHERE id = ?');
  let assigned = 0;
  let next = maxDly;
  db.transaction(() => {
    rows.forEach((r) => {
      if (dlyNumber(r.file_name) > 0) return;      // file asli DLY: tidak perlu nomor
      if (Number(r.display_no) > 0) return;        // sudah punya nomor: pertahankan
      next += 1;
      upd.run(next, r.id);
      assigned += 1;
    });
  })();
  return { assigned, lastNumber: next };
}

/** Drive web link for a photo (used by "Salin Link Google Drive Foto Terpilih"). */
function drivePhotoLinks(ctx) {
  return pickedPhotos(ctx.portal.id)
    .filter((ph) => ph.drive_file_id)
    .map((ph) => `https://drive.google.com/file/d/${ph.drive_file_id}/view`);
}

function csvFor(ctx) {
  const photos = photosFor(ctx.portal.id);
  const picks = new Map(pickedPhotos(ctx.portal.id).map((p) => [p.id, p]));
  const rows = [[
    'no', 'kode_foto', 'nama_file', 'google_drive_file_id', 'tersedia',
    'dipilih', 'urutan_pilihan', 'waktu_pilih'
  ]];
  photos.forEach((ph, i) => {
    const pick = picks.get(ph.id);
    rows.push([
      i + 1,
      ph.code || '',
      photoName(ph),
      ph.drive_file_id || '',
      Number(ph.is_available) === 0 ? 'tidak' : 'ya',
      pick ? 'ya' : 'tidak',
      pick && pick.position != null ? pick.position : '',
      pick ? String(pick.picked_at || '') : ''
    ]);
  });
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/** Plain-text list of the picked files (copy-to-clipboard / WhatsApp). */
function pickedFileList(ctx) {
  return pickedPhotos(ctx.portal.id).map((ph) => photoBaseName(ph)).join('\n');
}

/* ---- minimal streaming ZIP (store method, no external dependency) ---- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, day };
}

const writeChunk = (res, chunk) => new Promise((resolve) => {
  if (res.write(chunk)) resolve();
  else res.once('drain', resolve);
});

/**
 * Streams a ZIP of the given files. Each entry is fetched just-in-time, so a large
 * selection never has to sit in memory all at once.
 */
async function streamZip(res, entries) {
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());

  for (const entry of entries) {
    const data = await entry.getBuffer();
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);       // UTF-8 file name
    local.writeUInt16LE(0, 8);            // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    await writeChunk(res, Buffer.concat([local, nameBuf]));
    await writeChunk(res, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += 30 + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await writeChunk(res, centralBuf);
  await writeChunk(res, end);
  res.end();
}

module.exports = {
  STATUSES,
  ADMIN_STATUSES,
  statusLabel,
  deriveStatus,
  statusOf,
  defaultQuota,
  createForBooking,
  portalForBooking,
  portalById,
  portalByToken,
  photosFor,
  photoById,
  pickedIds,
  pickedPhotos,
  pickCount,
  isExpired,
  isClosed,
  photoName,
  photoBaseName,
  assignDisplayNumbers,
  warmPreviews,
  warmPreviewsInBackground,
  pickedFileList,
  drivePhotoLinks,
  clientSubmitMessage,
  syncFromDrive,
  detail,
  nextCode,
  nextSortOrder,
  ensurePreview,
  normalizeWidth,
  isThumbWidth,
  THUMB_WIDTHS,
  writePreviewFromBuffer,
  previewFile,
  PREVIEW_WIDTHS,
  dropPreview,
  masterBytes,
  DEFAULT_SELECTION_TEMPLATE,
  defaultDeadline,
  portalUrl,
  normalizeDriveUrl,
  driveFolderFor,
  rawFolderOf,
  waMessage,
  waVars,
  csvFor,
  streamZip,
  newToken
};

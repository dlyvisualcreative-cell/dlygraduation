'use strict';
/*
 * FIXTURE (salinan lokal saja) — portal seleksi dengan N foto LOKAL supaya thumbnail
 * bisa dibuat tanpa Google Drive. Tidak pernah menyentuh data produksi.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const APP = path.join(__dirname, '..');

function makeDataDir(prefix = 'dly-sel') {
  const dir = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(path.join(APP, 'data'))) {
    if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(dir, f));
  }
  for (const d of ['image-cache', 'logo-cache']) {
    try { fs.cpSync(path.join(APP, 'data', d), path.join(dir, d), { recursive: true }); } catch (e) { /* opsional */ }
  }
  // preview-cache SENGAJA kosong: kita ingin mengukur biaya pembuatan thumbnail.
  fs.mkdirSync(path.join(dir, 'preview-cache'), { recursive: true });
  return dir;
}

/** Foto lokal untuk fixture: pakai file asli dari public/uploads (tidak disalin). */
function localMasters(limit = 40) {
  const dir = path.join(APP, 'public', 'uploads');
  return fs.readdirSync(dir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .filter((f) => !/fixture|v8-test|ui7-b/.test(f))
    .slice(0, limit);
}

/**
 * Membuat (di salinan) satu portal seleksi dengan `count` foto lokal, siap dipakai uji.
 * @returns {{dir,sid,portalId,token,photoIds,quota}}
 */
function seedPortal({ dir, count = 700, quota = 0, bookingId = null } = {}) {
  const db = new Database(path.join(dir, 'app.sqlite'));
  const masters = localMasters(40);
  if (!masters.length) throw new Error('tidak ada file gambar di public/uploads');

  const booking = bookingId
    ? db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId)
    : db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' ORDER BY id DESC LIMIT 1").get();
  if (!booking) throw new Error('tidak ada booking terkonfirmasi');

  const token = crypto.randomBytes(24).toString('hex');
  const effectiveQuota = quota || Math.max(count, 1);
  // Satu booking hanya boleh punya satu portal seleksi (UNIQUE booking_id) → hapus yang lama
  // HANYA di salinan uji ini.
  db.prepare('DELETE FROM photo_selections WHERE booking_id = ?').run(booking.id);
  const info = db.prepare(`INSERT INTO photo_selections
      (booking_id, token, status, quota, is_open, allow_download, require_full_quota,
       created_at, deadline, drive_url, drive_show)
      VALUES (?, ?, 'waiting', ?, 1, 0, 0, datetime('now'), NULL, '', 1)`)
    .run(booking.id, token, effectiveQuota);
  const portalId = Number(info.lastInsertRowid);

  const ins = db.prepare(`INSERT INTO photo_selection_photos
      (portal_id, code, image, file_name, sort_order, source, is_available, display_no)
      VALUES (?, ?, ?, ?, ?, 'local', 1, ?)`);
  const photoIds = [];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const master = masters[i % masters.length];
      const code = String(i + 1).padStart(3, '0');
      const id = Number(ins.run(portalId, code, `/uploads/${master}`,
        `DLY-SEL-${code}.jpg`, i, i + 1).lastInsertRowid);
      photoIds.push(id);
    }
  })();
  db.close();
  return { dir, portalId, token, photoIds, quota: effectiveQuota, bookingId: booking.id };
}

module.exports = { makeDataDir, seedPortal, localMasters };

// Bisa dijalankan langsung: node .testrun/selection-fixture.js 700
if (require.main === module) {
  const count = Number(process.argv[2] || 700);
  const dir = makeDataDir('dly-fixture');
  const seeded = seedPortal({ dir, count });
  console.log(JSON.stringify({ dir, token: seeded.token, count: seeded.photoIds.length, quota: seeded.quota }, null, 1));
}

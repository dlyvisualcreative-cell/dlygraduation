'use strict';

/**
 * "Selesaikan Order" — satu jalur untuk DUA tombol admin:
 *
 *   1. Detail Booking → Workflow → "Selesaikan Order" (POST /admin/bookings/:id/complete-order)
 *   2. Antrean Editing → kolom Antrean → tombol SELESAI  (POST /admin/editing/:id/finish)
 *
 * Keduanya WAJIB memakai logika yang sama, karena revisi 2 mensyaratkan: order hanya
 * boleh ditandai selesai bila link Google Drive benar-benar ada dan valid. Kalau dua
 * jalur punya validasi berbeda, tombol SELESAI di antrean bisa "menyelesaikan" order
 * tanpa folder Drive.
 *
 * Yang dilakukan, berurutan:
 *   1. Ambil folder UTAMA booking (`bookings.drive_folder_id`) — bukan subfolder 03.
 *   2. Validasi lewat Google (`gcal.driveFolderInfo`) → 404/403/trash ditolak, order
 *      TIDAK berubah status.
 *   3. Lengkapi subfolder 01/02/03 bila belum ada (kegagalan di sini tidak menggagalkan
 *      penyelesaian order — folder utamanya sudah valid).
 *   4. Simpan `final_url` (webViewLink ASLI dari Google) + `final_at`.
 *   5. Catat tahap 08 di timeline, log aktivitas, dan kirim notifikasi ke client.
 *
 * Idempoten: memanggil dua kali dengan folder yang sama tidak menggandakan timeline,
 * log, atau notifikasi.
 */

const { db } = require('./db');
const gcal = require('./gcal');
const timeline = require('./timeline');
const payments = require('./payments');
const push = require('./push');

const ERRORS = {
  'no-folder': 'Booking ini belum punya folder Google Drive. Buat foldernya dulu (Workflow → "Buat folder Drive"), unggah hasil editnya, lalu tekan tombol SELESAI / Selesaikan Order lagi.',
  'drive-off': 'Google Drive belum terhubung, jadi folder booking tidak bisa diverifikasi. Hubungkan Drive dulu di menu Google Drive, lalu coba lagi.',
  trashed: 'Folder booking berada di Trash Google Drive. Pulihkan foldernya, lalu tekan tombol SELESAI / Selesaikan Order lagi.',
  gone: 'Folder booking tidak ditemukan di Google Drive. Pastikan foldernya belum dihapus, lalu coba lagi.',
  forbidden: 'Akses ke folder booking ditolak Google. Periksa izin akun Drive yang terhubung.',
  'no-booking': 'Booking tidak ditemukan.'
};

/**
 * @param {number} bookingId
 * @param {{actor?:string, source?:string}} opts  source: 'booking' | 'queue'
 * @returns {Promise<{ok:boolean, code?:string, message?:string, url?:string, name?:string,
 *                    already?:boolean, subfoldersReady?:boolean}>}
 */
async function completeOrder(bookingId, { actor = 'admin', source = 'booking' } = {}) {
  const id = Number(bookingId);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return { ok: false, code: 'no-booking', message: ERRORS['no-booking'] };

  const folderId = booking.drive_folder_id || '';

  let info;
  try {
    info = await gcal.driveFolderInfo(folderId);
  } catch (err) {
    const code = err && err.code ? err.code : 'error';
    return {
      ok: false,
      code,
      message: ERRORS[code] || `Folder booking tidak bisa diverifikasi: ${String((err && err.message) || err).slice(0, 160)}`
    };
  }

  // Subfolder 01/02/03 hanya DILENGKAPI bila belum ada. Kegagalan di sini tidak
  // menggagalkan penyelesaian order: tautan yang dibagikan adalah folder utama.
  let subfoldersReady = Boolean(booking.drive_raw_id && booking.drive_sortir_id && booking.drive_edit_id);
  if (!subfoldersReady) {
    try {
      const prepared = await gcal.ensureSubfolders(id, folderId, {
        raw: booking.drive_raw_id, sortir: booking.drive_sortir_id, edit: booking.drive_edit_id
      });
      subfoldersReady = true;
      if (prepared && prepared.created) {
        payments.logEvent(id, {
          kind: 'note',
          actor,
          note: `Subfolder Drive 01/02/03 dilengkapi (${prepared.created} dibuat baru)`
        });
      }
    } catch (err) { /* opsional: link yang dibagikan tetap folder utama */ }
  }

  // Idempoten: klik berulang tidak menggandakan timeline / log / notifikasi.
  const already = String(booking.final_url || '') === String(info.url) && Boolean(booking.final_at);
  // Revisi 2 (07): "status order berubah menjadi selesai" — booking ikut Completed
  // supaya tab "Selesai" di Kelola Booking konsisten dengan portal client.
  // Booking yang dibatalkan tidak pernah diubah statusnya di sini.
  const nextStatus = booking.status === 'cancelled' ? 'cancelled' : 'completed';
  db.prepare(`UPDATE bookings SET final_url = ?, final_at = COALESCE(final_at, datetime('now')),
              status = ?, updated_at = datetime('now') WHERE id = ?`).run(info.url, nextStatus, id);
  if (booking.status !== nextStatus) {
    payments.logEvent(id, {
      kind: 'status',
      from: booking.status,
      to: nextStatus,
      actor,
      note: 'Order selesai — link Google Drive final diaktifkan'
    });
  }

  if (already) {
    return { ok: true, already: true, url: info.url, name: info.name || '', subfoldersReady };
  }

  timeline.record(id, 'final_ready', { actor, note: 'Admin menyelesaikan order' });
  payments.logEvent(id, {
    kind: 'note',
    actor,
    note: `Order ditandai selesai${source === 'queue' ? ' dari Antrean Editing' : ''} — seluruh folder Drive booking "${info.name || 'folder booking'}" diaktifkan di Portal Client${subfoldersReady ? '' : ' (subfolder 01/02/03 belum lengkap)'}`
  });
  // Notifikasi client: "Editan kamu sudah selesai" (event_id deterministik → tidak dobel).
  push.notify('client_final', {
    eventId: `booking:${id}:final`,
    bookingId: id,
    clientName: booking.client_name || '',
    campus: booking.campus || ''
  });

  return { ok: true, already: false, url: info.url, name: info.name || '', subfoldersReady };
}

/** "Batalkan selesai": hanya mengosongkan status final, folder Drive tidak disentuh. */
function clearFinal(bookingId, { actor = 'admin' } = {}) {
  const id = Number(bookingId);
  db.prepare("UPDATE bookings SET final_url = '', final_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  db.prepare("DELETE FROM booking_timeline WHERE booking_id = ? AND stage = 'final_ready'").run(id);
  payments.logEvent(id, { kind: 'note', actor, note: 'Status selesai dibatalkan (link final dikosongkan)' });
  return { ok: true };
}

module.exports = { completeOrder, clearFinal, ERRORS };

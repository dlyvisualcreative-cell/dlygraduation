'use strict';

/**
 * Reschedule (revisi pemilik) — pengajuan oleh KLIEN, keputusan oleh ADMIN.
 *
 * Aturan:
 *  - Klien hanya mengirim PENGAJUAN: tanggal, jam, dan lokasi. Booking TIDAK berubah
 *    sebelum admin menyetujui.
 *  - Menu Reschedule di portal tertutup otomatis bila sudah masuk H-7 (≤ 7 hari sebelum
 *    sesi foto). Klien harus konfirmasi manual ke admin.
 *  - Admin bisa membuka menu itu lagi per booking (`bookings.reschedule_override`).
 *  - Persetujuan memakai mesin yang SAMA dengan form reschedule admin: cek tanggal
 *    tutup/full booking, kapasitas harian, bentrok tim, lalu memperbarui Google Calendar,
 *    riwayat `booking_reschedules`, log aktivitas, dan notifikasi klien.
 *  - Tanggal/jam/lokasi yang tidak berubah ditolak (tidak ada reschedule kosong).
 */

const { db } = require('./db');
const util = require('./util');

/** Menu Reschedule klien hanya terbuka bila sesi masih LEBIH dari 7 hari lagi. */
const HOLD_DAYS = 7;

const STATUS = {
  pending: { value: 'pending', label: 'Menunggu konfirmasi admin', tone: 'warn' },
  approved: { value: 'approved', label: 'Disetujui', tone: 'ok' },
  rejected: { value: 'rejected', label: 'Ditolak', tone: 'muted' }
};
const statusMeta = (v) => STATUS[v] || STATUS.pending;

const timeValid = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** Selisih hari (WIB) antara hari ini dan tanggal sesi. Negatif = sesi sudah lewat. */
function daysUntilSession(booking) {
  const date = String((booking && booking.shooting_date) || '').slice(0, 10);
  if (!isDate(date)) return null;
  const today = util.todayISO();
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

const requestsFor = (bookingId) => db.prepare(`SELECT * FROM reschedule_requests
  WHERE booking_id = ? ORDER BY id DESC`).all(Number(bookingId));

const pendingFor = (bookingId) => db.prepare(`SELECT * FROM reschedule_requests
  WHERE booking_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(Number(bookingId)) || null;

const rowById = (id) => db.prepare('SELECT * FROM reschedule_requests WHERE id = ?').get(Number(id)) || null;
const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM reschedule_requests WHERE status = 'pending'").get().n;

/**
 * Apakah menu Reschedule boleh dipakai untuk booking ini?
 * @returns {{ok:boolean, locked:boolean, reason:string, daysLeft:number|null,
 *            override:boolean, pending:object|null, canRequest:boolean}}
 */
function accessState(booking) {
  const override = Number((booking && booking.reschedule_override) || 0) === 1;
  const daysLeft = daysUntilSession(booking);
  const pending = pendingFor(booking ? booking.id : 0);
  const status = String((booking && booking.status) || '');

  let ok = true;
  let locked = false;
  let reason = '';

  if (status === 'cancelled') {
    ok = false;
    reason = 'Booking sudah dibatalkan, jadi jadwal tidak bisa diubah dari portal.';
  } else if (pending) {
    ok = false;
    reason = 'Pengajuan reschedule kamu masih menunggu konfirmasi admin.';
  } else if (daysLeft === null) {
    ok = false;
    reason = 'Tanggal sesi belum tercatat, jadi reschedule harus lewat admin.';
  } else if (daysLeft <= HOLD_DAYS && !override) {
    ok = false;
    locked = true;
    reason = daysLeft < 0
      ? `Jadwal sesi sudah lewat. Perubahan jadwal hanya bisa dilakukan admin.`
      : `Reschedule sudah ditutup karena sesi foto tinggal ${Math.max(daysLeft, 0)} hari lagi `
        + `(batas pengajuan maksimal H-${HOLD_DAYS}). Silakan konfirmasi langsung ke admin.`;
  }

  return {
    ok,
    locked,
    reason,
    daysLeft,
    override,
    pending,
    holdDays: HOLD_DAYS,
    canRequest: ok
  };
}

/**
 * Validasi jadwal baru tanpa mengubah apa pun.
 * @returns {{ok:boolean, error?:string, warnings:string[]}}
 */
function validate(booking, data = {}) {
  const date = String(data.date || '').slice(0, 10);
  const time = String(data.time || '');
  const location = String(data.location || '').trim().slice(0, 200);
  if (!booking) return { ok: false, error: 'Booking tidak ditemukan.', warnings: [] };
  if (!isDate(date)) return { ok: false, error: 'Tanggal baru tidak valid.', warnings: [] };
  if (!timeValid(time)) return { ok: false, error: 'Jam baru tidak valid (format HH:MM).', warnings: [] };
  if (!location) return { ok: false, error: 'Lokasi baru wajib diisi.', warnings: [] };

  const oldDate = String(booking.shooting_date || '').slice(0, 10);
  const oldTime = String(booking.shooting_time || '');
  const oldLocation = String(booking.location || '');
  if (date === oldDate && time === oldTime && location === oldLocation) {
    return { ok: false, error: 'Tidak ada perubahan jadwal atau lokasi.', warnings: [] };
  }

  // Tanggal lampau tidak masuk akal untuk pengajuan baru.
  if (date < util.todayISO()) {
    return { ok: false, error: 'Tanggal baru tidak boleh di masa lalu.', warnings: [] };
  }

  const dayWarnings = [];
  const map = util.availabilityForRange(date, date);
  const day = map[date];
  if (day && !day.available) {
    dayWarnings.push(`Tanggal ${util.formatDateID(date)} berstatus ${day.status === 'closed' ? 'Ditutup' : 'Full Booking'}.`);
  }
  const capacity = Number(util.availabilityRules().dailyCapacity) || 0;
  const bookedOthers = util.bookedCountOn(date, booking.id);
  if (capacity > 0 && (bookedOthers + 1) > capacity) {
    dayWarnings.push(`Kapasitas ${util.formatDateID(date)} sudah penuh (${bookedOthers}/${capacity}).`);
  }

  const teamWarnings = [];
  const team = require('./team');
  const memberIds = team.membersFor(booking.id).map((m) => Number(m.member_id)).filter(Boolean);
  const conflicts = (date === oldDate && time === oldTime)
    ? []
    : team.conflictsOnDate(date, memberIds, booking.id);
  if (conflicts.length) {
    teamWarnings.push(`Tim bentrok pada tanggal itu: ${conflicts
      .map((c) => `${c.member_name || 'anggota'} (${c.code} ${c.shooting_time || ''})`).join(', ')}.`);
  }

  return {
    ok: true,
    value: { date, time, location, reason: String(data.reason || '').slice(0, 200) },
    old: { date: oldDate, time: oldTime, location: oldLocation },
    dayWarnings,
    teamWarnings,
    warnings: dayWarnings.concat(teamWarnings)
  };
}

/**
 * Simpan pengajuan klien. Tidak mengubah booking.
 * @returns {{ok:boolean, created?:boolean, message?:string, request?:object}}
 */
function request(booking, data = {}) {
  const access = accessState(booking);
  if (!access.ok) return { ok: false, message: access.reason || 'Reschedule tidak tersedia.' };
  const check = validate(booking, data);
  if (!check.ok) return { ok: false, message: check.error };
  const v = check.value;

  const info = db.prepare(`INSERT INTO reschedule_requests
      (booking_id, old_date, old_time, old_location, new_date, new_time, new_location,
       reason, status, conflict, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'))`)
    .run(booking.id, check.old.date, check.old.time, check.old.location,
      v.date, v.time, v.location, v.reason, check.warnings.join(' ').slice(0, 500));

  try {
    require('./payments').logEvent(booking.id, {
      kind: 'reschedule',
      actor: 'klien',
      note: `Klien mengajukan reschedule: ${check.old.date} ${check.old.time} → ${v.date} ${v.time}`
        + `${check.old.location !== v.location ? ` · lokasi ${check.old.location} → ${v.location}` : ''}`.slice(0, 290)
    });
  } catch (err) { /* log tidak boleh menggagalkan pengajuan */ }

  return {
    ok: true,
    created: true,
    warnings: check.warnings,
    request: rowById(Number(info.lastInsertRowid))
  };
}

/**
 * TERAPKAN jadwal baru ke booking (dipakai form admin & persetujuan pengajuan).
 * Semua efek samping (riwayat, Google Calendar, notifikasi klien) ada di sini.
 *
 * @returns {Promise<{ok:boolean, error?:string, note?:string, warnings:string[]}>}
 */
async function applySchedule(booking, data = {}, {
  actor = 'admin', allowOverride = false, conflictAck = false, reason = ''
} = {}) {
  if (!booking) return { ok: false, error: 'Booking tidak ditemukan.', warnings: [] };
  const check = validate(booking, { ...data, reason });
  if (!check.ok) return { ok: false, error: check.error, warnings: [] };

  if (check.dayWarnings.length && !allowOverride) {
    return {
      ok: false,
      warnings: check.warnings,
      error: `${check.dayWarnings.join(' ')} Pilih tanggal lain, atau centang override dengan alasan bila tetap ingin memindahkan.`
    };
  }
  if (check.teamWarnings.length && !conflictAck && !allowOverride) {
    return {
      ok: false,
      warnings: check.warnings,
      error: `${check.teamWarnings.join(' ')} Centang "tetap lanjutkan" bila sudah dicek.`
    };
  }

  const v = check.value;
  const o = check.old;

  db.prepare(`UPDATE bookings SET shooting_date = ?, shooting_time = ?, location = ?,
              reschedule_count = COALESCE(reschedule_count, 0) + 1, updated_at = datetime('now')
              WHERE id = ?`).run(v.date, v.time, v.location, booking.id);

  const info = db.prepare(`INSERT INTO booking_reschedules
      (booking_id, old_date, old_time, old_location, new_date, new_time, new_location, reason, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(booking.id, o.date, o.time, o.location, v.date, v.time, v.location, v.reason, String(actor).slice(0, 60));

  const payments = require('./payments');
  payments.logEvent(booking.id, {
    kind: 'reschedule',
    actor,
    note: `Reschedule: ${o.date} ${o.time} → ${v.date} ${v.time}`
      + (o.location !== v.location ? ` · lokasi ${o.location} → ${v.location}` : '')
      + (v.reason ? ` · alasan: ${v.reason}` : '')
  });
  if (allowOverride && check.warnings.length) {
    payments.logEvent(booking.id, {
      kind: 'note', actor,
      note: `Override saat reschedule: ${v.reason || check.warnings.join(' ')}`.slice(0, 290)
    });
  }

  // Klien: jadwal berubah (hanya ke perangkat milik booking ini).
  try {
    require('./push').notify('client_reschedule', {
      eventId: `booking:${booking.id}:reschedule:${Number(info.lastInsertRowid)}`,
      bookingId: booking.id,
      clientName: booking.client_name || '',
      campus: booking.campus || '',
      scheduleLabel: `${util.formatDateID(v.date, true)} · ${v.time} WIB`
    });
  } catch (err) { /* notifikasi tidak boleh menggagalkan perubahan jadwal */ }

  // Google Calendar — event yang sama di-PATCH, status terpisah dari penyimpanan.
  const needsEvent = booking.status === 'confirmed' || booking.status === 'completed';
  let sync = { ok: true, skipped: true };
  if (needsEvent) {
    const gcal = require('./gcal');
    sync = await gcal.syncBooking(booking.id).catch((err) => ({ ok: false, error: err.message }));
    db.prepare('UPDATE booking_reschedules SET gcal_status = ?, gcal_error = ? WHERE id = ?')
      .run(sync.ok ? (sync.action || 'synced') : 'failed',
        sync.ok ? '' : String(sync.error || sync.message || '').slice(0, 300), Number(info.lastInsertRowid));
  }

  // Tim: `gcal.syncBooking` mengirim ulang undangan (sendUpdates=all) ke SEMUA attendee
  // event — termasuk anggota tim yang punya email. Jadi perubahan jadwal otomatis
  // "terkirim ke tim" tanpa langkah tambahan; jumlahnya dilaporkan ke admin.
  const teamInvited = sync.ok && sync.attendees
    ? String(sync.attendees).split(',').map((e) => e.trim()).filter(Boolean).length
    : 0;

  return {
    ok: true,
    warnings: check.warnings,
    sync,
    needsEvent,
    teamInvited,
    teamEmails: (sync && sync.attendees) || '',
    schedule: v,
    note: `Jadwal baru: ${util.formatDateID(v.date)} ${v.time}.`
      + (needsEvent
        ? (sync.ok
          ? ' Google Calendar diperbarui dengan ID yang sama'
            + (teamInvited ? ` dan undangan baru dikirim ke ${teamInvited} anggota tim.` : ' (belum ada tim dengan email, jadi belum ada undangan yang dikirim).')
          : ' Google Calendar gagal diperbarui — gunakan "Sinkronisasi Ulang".')
        : ' Konfirmasi booking untuk membuat event kalender.')
  };
}

/** Setujui pengajuan: terapkan jadwalnya lalu tandai approved. */
async function approve(id, { actor = 'admin', note = '', allowOverride = false } = {}) {
  const row = rowById(id);
  if (!row) return { ok: false, error: 'Pengajuan tidak ditemukan.', warnings: [] };
  if (row.status !== 'pending') return { ok: false, error: 'Pengajuan ini sudah diproses.', warnings: [] };
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.booking_id);
  if (!booking) return { ok: false, error: 'Booking tidak ditemukan.', warnings: [] };

  const result = await applySchedule(booking, {
    date: row.new_date,
    time: row.new_time,
    location: row.new_location,
    reason: row.reason
  }, { actor, allowOverride, conflictAck: true, reason: row.reason });
  if (!result.ok) return result;

  db.prepare(`UPDATE reschedule_requests SET status = 'approved', decided_at = datetime('now'),
              decided_by = ?, admin_note = ?, conflict = ? WHERE id = ?`)
    .run(String(actor).slice(0, 60), String(note || '').slice(0, 300), result.warnings.join(' ').slice(0, 500), row.id);

  // Pintu manual admin ditutup lagi setelah pengajuan diproses (kecuali override tetap
  // dibiarkan apa adanya — keputusan admin, tidak diubah otomatis).
  return { ok: true, ...result, request: rowById(row.id) };
}

function reject(id, { actor = 'admin', note = '' } = {}) {
  const row = rowById(id);
  if (!row) return { ok: false, error: 'Pengajuan tidak ditemukan.' };
  if (row.status !== 'pending') return { ok: false, error: 'Pengajuan ini sudah diproses.' };
  db.prepare(`UPDATE reschedule_requests SET status = 'rejected', decided_at = datetime('now'),
              decided_by = ?, admin_note = ? WHERE id = ?`)
    .run(String(actor).slice(0, 60), String(note || '').slice(0, 300), row.id);
  try {
    require('./payments').logEvent(row.booking_id, {
      kind: 'reschedule', actor,
      note: `Pengajuan reschedule klien ditolak${note ? `: ${note}` : ''}`.slice(0, 290)
    });
  } catch (err) { /* opsional */ }
  return { ok: true };
}

/** Buka/tutup menu Reschedule klien secara manual (admin). */
function setOverride(bookingId, open, { actor = 'admin' } = {}) {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(bookingId));
  if (!booking) return { ok: false, error: 'Booking tidak ditemukan.' };
  const value = open ? 1 : 0;
  db.prepare(`UPDATE bookings SET reschedule_override = ?, reschedule_override_at = datetime('now'),
              reschedule_override_by = ?, updated_at = updated_at WHERE id = ?`)
    .run(value, String(actor).slice(0, 60), booking.id);
  try {
    require('./payments').logEvent(booking.id, {
      kind: 'reschedule', actor,
      note: open
        ? 'Admin membuka menu Reschedule untuk klien (melewati batas H-7).'
        : 'Admin menutup kembali menu Reschedule untuk klien.'
    });
  } catch (err) { /* opsional */ }
  return { ok: true, open: Boolean(value) };
}

module.exports = {
  HOLD_DAYS,
  STATUS,
  statusMeta,
  timeValid,
  daysUntilSession,
  requestsFor,
  pendingFor,
  pendingCount,
  rowById,
  accessState,
  validate,
  request,
  applySchedule,
  approve,
  reject,
  setOverride
};

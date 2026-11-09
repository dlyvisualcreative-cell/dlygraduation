'use strict';

/**
 * Tim yang bertugas pada satu booking (Tahap 7).
 *
 * Satu booking boleh punya BEBERAPA anggota. Data master tetap di `team_members`
 * (halaman /admin/team) — modul ini tidak membuat daftar anggota kedua, hanya menghubungkan
 * booking dengan anggota yang sudah ada, sambil menyimpan snapshot nama/email/peran supaya
 * riwayat event lama tidak berubah ketika anggota di-rename atau dihapus.
 *
 * Kolom lama `bookings.team_member_id` / `team_name_snapshot` / `team_email_snapshot` tetap
 * diisi dengan anggota PERTAMA, karena masih dibaca oleh kode lama, ekspor, dan pengujian.
 */

const { db } = require('./db');
const payments = require('./payments');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isValidEmail = (value) => EMAIL_RE.test(String(value || '').trim());

const membersFor = (bookingId) =>
  db.prepare(`SELECT * FROM booking_team WHERE booking_id = ? ORDER BY sort_order, id`)
    .all(Number(bookingId));

/** Active crew members the admin may pick. */
const selectableMembers = () =>
  db.prepare('SELECT * FROM team_members WHERE is_active = 1 ORDER BY sort_order, name').all();

/** Everyone, including inactive (so an existing assignment can still be displayed). */
const allMembers = () =>
  db.prepare('SELECT * FROM team_members ORDER BY is_active DESC, sort_order, name').all();

/**
 * Replace a booking's crew.
 * @param {number} bookingId
 * @param {number[]} memberIds
 * @param {{actor?:string}} opts
 * @returns {{ok:boolean, message?:string, members?:Array, added?:Array, removed?:Array, emails?:string[]}}
 */
function setTeam(bookingId, memberIds, { actor = 'admin' } = {}) {
  const id = Number(bookingId);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return { ok: false, message: 'Booking tidak ditemukan.' };

  const wanted = Array.from(new Set((Array.isArray(memberIds) ? memberIds : [])
    .map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)));
  if (!wanted.length) {
    return { ok: false, message: 'Pilih minimal satu anggota tim yang bertugas.' };
  }

  const rows = db.prepare(`SELECT * FROM team_members WHERE id IN (${wanted.map(() => '?').join(',')})`)
    .all(...wanted);
  if (rows.length !== wanted.length) {
    return { ok: false, message: 'Ada anggota tim yang tidak ditemukan.' };
  }
  const inactive = rows.filter((r) => Number(r.is_active) !== 1);
  if (inactive.length) {
    return {
      ok: false,
      message: `Anggota berikut tidak aktif dan tidak bisa dipilih: ${inactive.map((r) => r.name).join(', ')}.`
    };
  }

  const before = membersFor(id);
  const beforeIds = before.map((m) => Number(m.member_id)).filter(Boolean);
  // Preserve the order the admin picked, so "first member" is predictable.
  const ordered = wanted.map((w) => rows.find((r) => Number(r.id) === w)).filter(Boolean);

  db.transaction(() => {
    db.prepare('DELETE FROM booking_team WHERE booking_id = ?').run(id);
    const ins = db.prepare(`INSERT INTO booking_team
        (booking_id, member_id, name, email, role, sort_order) VALUES (?, ?, ?, ?, ?, ?)`);
    ordered.forEach((m, i) => ins.run(id, m.id, m.name || '', m.email || '', m.role || '', i));

    // Legacy mirror (first member only).
    const first = ordered[0];
    db.prepare(`UPDATE bookings SET team_member_id = ?, team_name_snapshot = ?,
                team_email_snapshot = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(first.id, first.name || '', first.email || '', id);
  })();

  const after = membersFor(id);
  const afterIds = after.map((m) => Number(m.member_id));
  const added = after.filter((m) => !beforeIds.includes(Number(m.member_id)));
  const removed = before.filter((m) => !afterIds.includes(Number(m.member_id)));
  const emails = after.map((m) => m.email).filter(isValidEmail);
  const missingEmail = after.filter((m) => !isValidEmail(m.email));

  if (added.length || removed.length) {
    const parts = [];
    if (added.length) parts.push(`+ ${added.map((m) => m.name).join(', ')}`);
    if (removed.length) parts.push(`− ${removed.map((m) => m.name).join(', ')}`);
    payments.logEvent(id, {
      kind: 'team',
      actor,
      note: `Tim yang bertugas diperbarui: ${parts.join(' · ')}`.slice(0, 290)
    });
  }

  return {
    ok: true,
    members: after,
    added,
    removed,
    emails,
    missingEmail,
    message: missingEmail.length
      ? `Tim tersimpan. Catatan: ${missingEmail.map((m) => m.name).join(', ')} belum punya email valid, jadi undangan kalender tidak bisa dikirim ke mereka.`
      : 'Tim yang bertugas tersimpan.'
  };
}

/** Names joined for descriptions/logs. */
const namesOf = (members) => members.map((m) => m.name).filter(Boolean).join(', ');

/** Rows for the calendar `attendees` array (only valid emails, de-duplicated). */
function attendeesFor(bookingId) {
  const members = membersFor(bookingId);
  const seen = new Set();
  const out = [];
  members.forEach((m) => {
    const email = String(m.email || '').trim().toLowerCase();
    if (!isValidEmail(email) || seen.has(email)) return;
    seen.add(email);
    out.push({ email, displayName: m.name || undefined });
  });
  return out;
}

/** Bookings (other than `exceptId`) on one date that share any of these members. */
function conflictsOnDate(dateISO, memberIds, exceptBookingId = 0) {
  const ids = (memberIds || []).map(Number).filter(Boolean);
  if (!ids.length || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) return [];
  const rows = db.prepare(`SELECT b.id, b.code, b.client_name, b.shooting_date, b.shooting_time,
                                  b.team_member_id, t.name AS member_name
                           FROM bookings b
                           LEFT JOIN team_members t ON t.id = b.team_member_id
                           WHERE b.shooting_date = ? AND b.id <> ?
                             AND b.status NOT IN ('cancelled')`).all(String(dateISO), Number(exceptBookingId));
  const bookingIds = rows.map((r) => r.id);
  if (!bookingIds.length) return [];
  const links = db.prepare(`SELECT booking_id, member_id, name FROM booking_team
                            WHERE booking_id IN (${bookingIds.map(() => '?').join(',')})`)
    .all(...bookingIds);
  return rows.filter((r) => {
    const linked = links.filter((l) => Number(l.booking_id) === Number(r.id)).map((l) => Number(l.member_id));
    const effective = linked.length ? linked : (r.team_member_id ? [Number(r.team_member_id)] : []);
    return effective.some((mid) => ids.includes(mid));
  });
}

module.exports = {
  membersFor,
  selectableMembers,
  allMembers,
  setTeam,
  namesOf,
  attendeesFor,
  conflictsOnDate,
  isValidEmail
};

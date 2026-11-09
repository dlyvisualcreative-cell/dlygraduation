'use strict';

/**
 * Per-booking payments + activity log (Tahap 3 / V11).
 *
 * The amount a client has paid is ALWAYS derived from `booking_payments` rows — never
 * stored a second time — so:
 *   - a booking with no rows honestly reads "Belum ada pembayaran tercatat";
 *   - correcting a typo means editing one row, not two places;
 *   - old bookings never get an invented payment.
 *
 * `total` comes from the booking's own price snapshot (`total_price_snapshot` → `price`).
 * Snapshots are never rewritten here.
 */

const { db } = require('./db');
const util = require('./util');

const STATUS = {
  unrecorded: { value: 'unrecorded', label: 'Belum Tercatat', tone: 'muted' },
  unpaid: { value: 'unpaid', label: 'Belum Bayar', tone: 'warn' },
  partial: { value: 'partial', label: 'DP Dibayar', tone: 'info' },
  paid: { value: 'paid', label: 'Lunas', tone: 'ok' }
};

const paymentsFor = (bookingId) =>
  db.prepare(`SELECT * FROM booking_payments WHERE booking_id = ?
              ORDER BY paid_at DESC, id DESC`).all(Number(bookingId));

/** Total bill of a booking: the snapshot, falling back to the legacy price column. */
const totalFor = (booking) => {
  const raw = booking ? (booking.total_price_snapshot != null ? booking.total_price_snapshot : booking.price) : null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * @returns {{total:number|null, paid:number, due:number|null, status:string,
 *            label:string, tone:string, count:number, lastPaidAt:string}}
 */
function summary(booking) {
  const bookingId = booking && booking.id;
  const rows = bookingId ? paymentsFor(bookingId) : [];
  const paid = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const total = totalFor(booking);

  let status = 'unrecorded';
  if (!rows.length) {
    // Nothing recorded yet. If we do know the bill, say "Belum Bayar"; if the price is
    // unknown too, "" is more honest than inventing a number.
    status = total ? 'unpaid' : 'unrecorded';
  } else if (total && paid >= total) {
    status = 'paid';
  } else if (total && paid > 0) {
    status = 'partial';
  } else if (!total && paid > 0) {
    // Money received but the bill is unknown (a package without a price) — still partial.
    status = 'partial';
  } else {
    status = 'unpaid';
  }

  const meta = STATUS[status];
  return {
    total,
    paid,
    due: total == null ? null : Math.max(0, total - paid),
    status,
    label: meta.label,
    tone: meta.tone,
    count: rows.length,
    lastPaidAt: rows.length ? rows[0].paid_at : ''
  };
}

/** Convenience for list views: derive a summary for many bookings in two queries. */
function summariesFor(bookings) {
  const ids = bookings.map((b) => Number(b.id)).filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT booking_id, SUM(amount) AS paid, COUNT(*) AS n, MAX(paid_at) AS last
                           FROM booking_payments WHERE booking_id IN (${placeholders})
                           GROUP BY booking_id`).all(...ids);
  const byId = new Map(rows.map((r) => [Number(r.booking_id), r]));
  bookings.forEach((b) => {
    const agg = byId.get(Number(b.id));
    const paid = agg ? Number(agg.paid) || 0 : 0;
    const total = totalFor(b);
    let status;
    if (!agg) status = total ? 'unpaid' : 'unrecorded';
    else if (total && paid >= total) status = 'paid';
    else if (paid > 0) status = 'partial';
    else status = 'unpaid';
    const meta = STATUS[status];
    out.set(Number(b.id), {
      total,
      paid,
      due: total == null ? null : Math.max(0, total - paid),
      status,
      label: meta.label,
      tone: meta.tone,
      count: agg ? Number(agg.n) : 0,
      lastPaidAt: agg ? agg.last : ''
    });
  });
  return out;
}

function addPayment(bookingId, { amount, paidAt, method, note, kind }) {
  const value = Math.max(0, Math.round(Number(amount) || 0));
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(paidAt || '')) ? String(paidAt) : util.todayISO();
  const type = ['dp', 'settlement', 'manual'].includes(String(kind)) ? String(kind) : 'manual';
  const info = db.prepare(`INSERT INTO booking_payments (booking_id, amount, paid_at, method, note, kind)
                           VALUES (?, ?, ?, ?, ?, ?)`)
    .run(Number(bookingId), value, date, String(method || '').slice(0, 40), String(note || '').slice(0, 200), type);
  return Number(info.lastInsertRowid);
}

const deletePayment = (bookingId, paymentId) =>
  db.prepare('DELETE FROM booking_payments WHERE id = ? AND booking_id = ?')
    .run(Number(paymentId), Number(bookingId)).changes;

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */
function logEvent(bookingId, { kind = 'status', from = '', to = '', actor = '', note = '' } = {}) {
  if (!bookingId) return null;
  const info = db.prepare(`INSERT INTO booking_events (booking_id, kind, from_status, to_status, actor, note)
                           VALUES (?, ?, ?, ?, ?, ?)`)
    .run(Number(bookingId), String(kind).slice(0, 30), String(from || '').slice(0, 30),
      String(to || '').slice(0, 30), String(actor || '').slice(0, 60), String(note || '').slice(0, 300));
  return Number(info.lastInsertRowid);
}

const eventsFor = (bookingId, limit = 60) =>
  db.prepare(`SELECT * FROM booking_events WHERE booking_id = ? ORDER BY id DESC LIMIT ?`)
    .all(Number(bookingId), Number(limit));

/** Newest activity across all bookings (dashboard feed). */
const recentEvents = (limit = 8) =>
  db.prepare(`SELECT e.*, b.code, b.client_name
              FROM booking_events e JOIN bookings b ON b.id = e.booking_id
              ORDER BY e.id DESC LIMIT ?`).all(Number(limit));

/** Human sentence for one event row. */
function describeEvent(e) {
  const who = e.actor ? `oleh ${e.actor}` : 'otomatis';
  switch (e.kind) {
    case 'created':
      return 'Booking dibuat oleh klien';
    case 'status':
      return `Status ${e.from_status || '—'} → ${e.to_status || '—'} (${who})`;
    case 'payment':
      return e.note || `Pembayaran dicatat (${who})`;
    case 'payment-deleted':
      return e.note || `Catatan pembayaran dihapus (${who})`;
    case 'note':
      return e.note || 'Catatan diperbarui';
    case 'team':
      return e.note || 'Tim yang bertugas diperbarui';
    case 'reschedule':
      return e.note || 'Jadwal booking diubah';
    case 'editing':
      return e.note || 'Antrean editing diperbarui';
    case 'portal':
      return e.note || 'Portal seleksi foto diperbarui';
    default:
      return e.note || e.kind;
  }
}

module.exports = {
  STATUS,
  paymentsFor,
  totalFor,
  summary,
  summariesFor,
  addPayment,
  deletePayment,
  logEvent,
  eventsFor,
  recentEvents,
  describeEvent
};

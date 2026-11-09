'use strict';

/**
 * Notification centre (Tahap 4) — dashboard only, no Web Push.
 *
 * Items are DERIVED from the database on every request instead of being stored, so the
 * list can never go stale or show something that no longer exists (a deleted booking
 * simply stops appearing). Five sources, exactly as specified:
 *
 *   booking    — a booking created in the last `booking_new_days` days
 *   payment    — a payment recorded recently (booking_payments.created_at)
 *   selection  — a client submitted their photo picks
 *   deadline   — an open portal whose deadline is near or already passed
 *   job        — a shoot scheduled for TOMORROW (H-1 preparation)
 *
 * "Read" is a single watermark (`settings.notifications_seen_at`): everything newer is
 * unread. Marking all as read moves the watermark to now. There is no per-item state to
 * desynchronise, and no extra table to migrate later.
 */

const { db, getSettings, saveSettings } = require('./db');
const util = require('./util');

const TYPES = [
  { value: 'booking', label: 'Booking baru', icon: 'calendar' },
  { value: 'payment', label: 'Pembayaran', icon: 'wallet' },
  { value: 'selection', label: 'Pilihan foto', icon: 'select' },
  { value: 'deadline', label: 'Deadline seleksi', icon: 'clock' },
  { value: 'job', label: 'Job besok', icon: 'users' }
];

const typeMeta = (value) => TYPES.find((t) => t.value === value) || TYPES[0];

/** SQLite stores UTC `datetime('now')`; compare as UTC to stay consistent. */
const parseDbDate = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const iso = raw.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : 0;
};

const fmtWhen = (ms) => {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return 'baru saja';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} menit lalu`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} jam lalu`;
  return util.formatDateID(new Date(ms).toISOString().slice(0, 10));
};

/**
 * Build the whole feed.
 * @param {{limit?:number, type?:string}} opts
 * @returns {{items:Array, unread:number, seenAt:string}}
 */
function feed({ limit = 40, type = '' } = {}) {
  const settings = getSettings();
  const windowDays = Math.max(1, Number(settings.booking_new_days) || 7);
  const today = util.todayISO();
  const tomorrow = util.addDaysISO(today, 1);
  // "Pinned" items (a deadline, tomorrow's shoot) are news ONCE PER DAY: they carry
  // today's date as their timestamp, so marking all read clears the badge now and the
  // item becomes unread again the next morning — never an un-clearable badge.
  // `today` is the WIB date, but timestamps are UTC: between 17:00–24:00 UTC the WIB date
  // is already tomorrow, so "today 00:00 UTC" would be in the FUTURE and the item could
  // never be marked as read. Clamp it to the past.
  const dayStamp = Math.min(parseDbDate(`${today} 00:00:00`), Date.now() - 60 * 1000);
  const since = `-${windowDays} days`;
  const items = [];

  if (!type || type === 'booking') {
    db.prepare(`SELECT id, code, client_name, shooting_date, created_at, status
                FROM bookings WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 30`).all(since)
      .forEach((b) => items.push({
        type: 'booking',
        key: `booking:${b.id}`,
        title: `Booking baru: ${b.client_name}`,
        detail: `Kode ${b.code} · sesi ${util.formatDateID(b.shooting_date)}${b.status === 'pending' ? ' · menunggu konfirmasi' : ''}`,
        url: `/admin/bookings/${b.id}`,
        at: parseDbDate(b.created_at),
        newFor: windowDays
      }));
  }

  if (!type || type === 'payment') {
    db.prepare(`SELECT p.id, p.amount, p.paid_at, p.created_at, b.id AS booking_id, b.client_name, b.code
                FROM booking_payments p JOIN bookings b ON b.id = p.booking_id
                WHERE p.created_at >= datetime('now', ?) ORDER BY p.id DESC LIMIT 30`).all(since)
      .forEach((p) => items.push({
        type: 'payment',
        key: `payment:${p.id}`,
        title: `Pembayaran ${util.rupiah(p.amount)} — ${p.client_name}`,
        detail: `Dicatat untuk ${p.code}`,
        url: `/admin/bookings/${p.booking_id}?tab=pembayaran`,
        at: parseDbDate(p.created_at || p.paid_at)
      }));
  }

  if (!type || type === 'selection') {
    // Only the CLIENT's submission counts as news; an admin-set status is not a notification.
    db.prepare(`SELECT ps.id, ps.submitted_at, ps.quota,
                       (SELECT COUNT(*) FROM photo_selection_picks pk WHERE pk.portal_id = ps.id) AS picks,
                       b.id AS booking_id, b.client_name
                FROM photo_selections ps JOIN bookings b ON b.id = ps.booking_id
                WHERE ps.submitted_at IS NOT NULL AND ps.submitted_at >= datetime('now', ?)
                ORDER BY ps.id DESC LIMIT 30`).all(since)
      .forEach((p) => items.push({
        type: 'selection',
        key: `selection:${p.id}`,
        title: `Pilihan foto masuk: ${p.client_name}`,
        detail: `${p.picks} dari ${p.quota || '—'} foto dipilih klien`,
        url: `/admin/selection/${p.id}`,
        at: parseDbDate(p.submitted_at)
      }));
  }

  if (!type || type === 'deadline') {
    db.prepare(`SELECT ps.id, ps.deadline, b.client_name, b.id AS booking_id
                FROM photo_selections ps JOIN bookings b ON b.id = ps.booking_id
                WHERE ps.deadline IS NOT NULL AND ps.deadline <= ?
                  AND ps.submitted_at IS NULL AND ps.is_open = 1
                ORDER BY ps.deadline ASC LIMIT 30`).all(util.addDaysISO(today, 3))
      .forEach((p) => {
        const passed = String(p.deadline).slice(0, 10) < today;
        items.push({
          type: 'deadline',
          key: `deadline:${p.id}`,
          title: passed
            ? `Deadline seleksi terlewat: ${p.client_name}`
            : `Deadline seleksi ${util.formatDateID(p.deadline)}: ${p.client_name}`,
          detail: passed ? 'Deadline sudah lewat dan klien belum mengirim pilihan foto'
            : 'Klien belum mengirim pilihan foto',
          url: `/admin/selection/${p.id}`,
          at: dayStamp,
          pinned: true,
          urgent: passed
        });
      });
  }

  if (!type || type === 'job') {
    db.prepare(`SELECT b.id, b.code, b.client_name, b.shooting_date, b.shooting_time, b.status,
                       b.location, c.name AS city_name, p.name AS package_name
                FROM bookings b
                LEFT JOIN cities c ON c.id = b.city_id
                LEFT JOIN packages p ON p.id = b.package_id
                WHERE b.shooting_date = ? AND b.status <> 'cancelled'
                ORDER BY COALESCE(NULLIF(b.shooting_time, ''), '23:59') ASC`).all(tomorrow)
      .forEach((b) => items.push({
        type: 'job',
        key: `job:${b.id}`,
        title: `Job besok: ${b.client_name}`,
        detail: `${b.shooting_time || 'jam belum diisi'} · ${b.location || 'lokasi belum diisi'}${b.city_name ? ' · ' + b.city_name : ''}`,
        url: `/admin/bookings/${b.id}`,
        at: dayStamp,
        pinned: true
      }));
  }

  const seenAt = String(settings.notifications_seen_at || '');
  const seenMs = parseDbDate(seenAt);
  items.forEach((it) => {
    it.unread = !seenMs || it.at > seenMs;
    it.when = fmtWhen(it.at);
    it.meta = typeMeta(it.type);
  });

  items.sort((a, b) => b.at - a.at);
  return {
    items: items.slice(0, limit),
    total: items.length,
    unread: items.filter((i) => i.unread).length,
    seenAt,
    counts: TYPES.reduce((acc, t) => {
      acc[t.value] = items.filter((i) => i.type === t.value).length;
      return acc;
    }, {})
  };
}

/** Cheap-ish unread count for the sidebar badge / bell (same feed, no rendering). */
function unreadCount() {
  try {
    return feed({ limit: 500 }).unread;
  } catch (err) {
    return 0;
  }
}

/** Watermark = "everything created before now has been seen". */
function markAllRead() {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  saveSettings({ notifications_seen_at: now });
  return now;
}

module.exports = { TYPES, typeMeta, feed, unreadCount, markAllRead, parseDbDate };

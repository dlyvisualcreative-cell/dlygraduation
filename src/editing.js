'use strict';

/**
 * Editing queue (Tahap 5).
 *
 * Three stages only, deliberately:
 *   queued  → "Masuk Antrean"
 *   editing → "Diedit"
 *   done    → "Selesai"
 *
 * Rules that keep this honest and safe:
 *  - One ACTIVE job per booking (partial unique index in `db.js`). Re-queueing a finished
 *    job is allowed and keeps the old row as history.
 *  - `photo_count` is a SNAPSHOT of the client's picks when the job entered the queue.
 *    The queue never touches `photo_selection_picks`.
 *  - `note` is INTERNAL. `clientView()` is the only thing the portal renders, and it
 *    never includes it.
 *  - Advancing to `editing` / `done` mirrors the client-facing portal status
 *    (`photo_selections.status` = processing / done) inside one transaction, and writes
 *    a `booking_events` row so the change shows up in the booking activity history.
 */

const { db, getSettings } = require('./db');
const util = require('./util');
const payments = require('./payments');

const STAGES = [
  { value: 'queued', label: 'Masuk Antrean', tone: 'warn', hint: 'Menunggu dikerjakan editor' },
  { value: 'editing', label: 'Diedit', tone: 'info', hint: 'Sedang diedit tim DLY' },
  { value: 'done', label: 'Selesai', tone: 'ok', hint: 'Hasil edit sudah selesai' }
];

/** Deadline default antrean editing: 10 hari kerja. */
const WORKING_DAYS = 10;

const STAGE_VALUES = STAGES.map((s) => s.value);
const stage = (value) => STAGES.find((s) => s.value === value) || STAGES[0];
const stageLabel = (value) => stage(value).label;

/** Portal status that matches a queue stage ('' = leave the portal status alone). */
const PORTAL_STATUS = { queued: '', editing: 'processing', done: 'done' };

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */
const SELECT = `SELECT e.*, b.code, b.client_name, b.shooting_date, b.shooting_time,
                       b.status AS booking_status, b.city_id,
                       b.final_url, b.final_at, b.drive_folder_id,
                       c.name AS city_name, p.name AS package_name,
                       ps.token AS portal_token, ps.quota AS portal_quota,
                       (SELECT COUNT(*) FROM photo_selection_picks pk WHERE pk.portal_id = e.portal_id) AS picks_now
                FROM editing_jobs e
                JOIN bookings b ON b.id = e.booking_id
                LEFT JOIN cities c ON c.id = b.city_id
                LEFT JOIN packages p ON p.id = b.package_id
                LEFT JOIN photo_selections ps ON ps.id = e.portal_id`;

const jobById = (id) => db.prepare(`${SELECT} WHERE e.id = ?`).get(Number(id)) || null;

/** The ACTIVE job (queued/editing) of a booking, else the most recent one. */
const jobForBooking = (bookingId) => db.prepare(`${SELECT}
  WHERE e.booking_id = ?
  ORDER BY CASE e.status WHEN 'queued' THEN 0 WHEN 'editing' THEN 1 ELSE 2 END, e.id DESC
  LIMIT 1`).get(Number(bookingId)) || null;

const activeJobForBooking = (bookingId) => db.prepare(`${SELECT}
  WHERE e.booking_id = ? AND e.status IN ('queued', 'editing') LIMIT 1`).get(Number(bookingId)) || null;

/**
 * Baris papan antrean (revisi 2) — HANYA DUA kolom:
 *   Antrean Editing : semua pekerjaan yang belum selesai (queued + editing)
 *   Selesai         : order yang sudah diselesaikan admin
 *
 * Kolom tidak lagi memisahkan "Masuk Antrean" dan "Diedit": status `editing` tetap ada
 * di database (dipakai timeline client untuk tahap 07) tetapi di papan operasional
 * keduanya tampil sebagai satu antrean, diurutkan menurut posisi antrean sesungguhnya.
 *
 * `done` dibatasi (pekerjaan selesai = riwayat, bukan to-do).
 * @param {{doneLimit?:number}} opts
 */
function board({ doneLimit = 25 } = {}) {
  const rows = db.prepare(`${SELECT} ORDER BY e.position ASC, e.id ASC`).all();
  const active = rows.filter((r) => r.status !== 'done');
  const done = rows.filter((r) => r.status === 'done');
  return {
    active: active.map((r, i) => ({ ...r, queue_no: i + 1, queue_total: active.length })),
    done: done.slice(0, doneLimit),
    doneTotal: done.length
  };
}

/** Urutan antrean aktif (posisi #1 = yang sedang dikerjakan). */
const activeQueue = () => db.prepare(`SELECT id, booking_id, portal_id, status FROM editing_jobs
                                      WHERE status IN ('queued', 'editing')
                                      ORDER BY position ASC, id ASC`).all();

/**
 * Posisi satu booking di antrean aktif — dihitung dari DATABASE, bukan urutan visual.
 * @returns {{position:number, total:number, job:object|null}}
 */
function queuePosition(bookingId) {
  const queue = activeQueue();
  const idx = queue.findIndex((j) => Number(j.booking_id) === Number(bookingId));
  return {
    position: idx >= 0 ? idx + 1 : 0,
    total: queue.length,
    job: idx >= 0 ? queue[idx] : null
  };
}

/**
 * Sinkronkan status internal dengan posisi antrean:
 * kartu urutan #1 otomatis berstatus `editing` (Proses Editing aktif di timeline client),
 * kartu lain kembali `queued`. Hanya menulis bila memang berbeda.
 */
function refreshActive() {
  const queue = activeQueue();
  if (!queue.length) return { changed: 0 };
  let changed = 0;
  db.transaction(() => {
    queue.forEach((job, i) => {
      const want = i === 0 ? 'editing' : 'queued';
      if (job.status === want) return;
      db.prepare(`UPDATE editing_jobs
                  SET status = ?, updated_at = datetime('now'),
                      started_at = CASE WHEN ? = 'editing' THEN COALESCE(started_at, datetime('now'))
                                        ELSE started_at END
                  WHERE id = ?`).run(want, want, job.id);
      if (want === 'editing') {
        // Portal client ikut "Sedang Diproses" — hanya untuk kartu yang benar-benar mulai.
        let portalId = job.portal_id;
        if (!portalId) {
          const portal = db.prepare('SELECT id FROM photo_selections WHERE booking_id = ?').get(job.booking_id);
          if (portal) {
            portalId = portal.id;
            db.prepare('UPDATE editing_jobs SET portal_id = ? WHERE id = ?').run(portalId, job.id);
          }
        }
        if (portalId) {
          db.prepare(`UPDATE photo_selections SET status = 'processing', updated_at = datetime('now')
                      WHERE id = ? AND status NOT IN ('done')`).run(portalId);
        }
      }
      changed += 1;
    });
  })();
  return { changed };
}

function stats() {
  const one = (sql, params = {}) => db.prepare(sql).get(params).n;
  const today = util.todayISO();
  return {
    queued: one("SELECT COUNT(*) AS n FROM editing_jobs WHERE status = 'queued'"),
    editing: one("SELECT COUNT(*) AS n FROM editing_jobs WHERE status = 'editing'"),
    done: one("SELECT COUNT(*) AS n FROM editing_jobs WHERE status = 'done'"),
    overdue: one(`SELECT COUNT(*) AS n FROM editing_jobs
                  WHERE status IN ('queued','editing') AND due_at IS NOT NULL AND due_at < :today`,
      { today }),
    active: one("SELECT COUNT(*) AS n FROM editing_jobs WHERE status IN ('queued','editing')")
  };
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */
/**
 * Queue a booking for editing. Idempotent: an existing active job is returned as-is
 * (never duplicated, never re-created), which is what the admin button relies on.
 */
function enqueue(bookingId, { actor = 'admin', note = '' } = {}) {
  const id = Number(bookingId);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return { ok: false, message: 'Booking tidak ditemukan.' };

  const existing = activeJobForBooking(id);
  if (existing) return { ok: true, created: false, job: jobById(existing.id) };

  const portal = db.prepare('SELECT * FROM photo_selections WHERE booking_id = ?').get(id) || null;
  const picks = portal
    ? db.prepare('SELECT COUNT(*) AS n FROM photo_selection_picks WHERE portal_id = ?').get(portal.id).n
    : 0;
  const photoCount = picks || Number(booking.edited_photos_snapshot) || 0;

  // Deadline otomatis: 10 HARI KERJA (Sabtu & Minggu tidak dihitung) sejak klien
  // mengirim pilihan foto. Admin tetap bisa mengubahnya manual di kartu job.
  // Hari libur yang dikonfigurasi admin (`portal_holidays`) ikut dilewati.
  const holidays = util.lines(getSettings().portal_holidays || '')
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const baseDate = portal && portal.submitted_at
    ? String(portal.submitted_at).slice(0, 10)
    : util.todayISO();
  const dueAt = util.addWorkingDaysISO(baseDate, WORKING_DAYS, holidays);

  const info = db.prepare(`INSERT INTO editing_jobs
      (booking_id, portal_id, status, photo_count, note, due_at, position, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?, 0, datetime('now'), datetime('now'))`)
    .run(id, portal ? portal.id : null, photoCount, String(note || '').slice(0, 500), dueAt);

  payments.logEvent(id, {
    kind: 'editing',
    to: 'queued',
    actor,
    note: `Masuk antrean editing${photoCount ? ` (${photoCount} foto)` : ''}`
  });
  // Kartu yang langsung menjadi #1 otomatis berstatus "Proses Editing".
  refreshActive();
  return { ok: true, created: true, job: jobById(Number(info.lastInsertRowid)) };
}

/** Move a job to another stage. Validated, logged, and mirrored to the portal. */
function setStatus(jobId, status, { actor = 'admin' } = {}) {
  const id = Number(jobId);
  const job = db.prepare('SELECT * FROM editing_jobs WHERE id = ?').get(id);
  if (!job) return { ok: false, message: 'Job editing tidak ditemukan.' };
  if (!STAGE_VALUES.includes(status)) return { ok: false, message: 'Tahap editing tidak valid.' };
  if (job.status === status) return { ok: true, unchanged: true, job: jobById(id) };

  // Revisi 2 (07): "done" HANYA boleh setelah order benar-benar selesai, yaitu setelah
  // link Google Drive tervalidasi & disimpan (final_url). Ini menutup jalur pintas
  // (mis. drag kartu / POST langsung) yang bisa menyelesaikan order tanpa link valid.
  if (status === 'done') {
    const row = db.prepare('SELECT final_url FROM bookings WHERE id = ?').get(job.booking_id) || {};
    if (!row.final_url) {
      return {
        ok: false,
        code: 'no-final-link',
        message: 'Order belum bisa diselesaikan: link Google Drive belum tersedia/valid. Pakai tombol SELESAI di kartu antrean.'
      };
    }
  }

  const doneAt = status === 'done' ? "datetime('now')" : 'NULL';
  const startedAt = status === 'editing' && !job.started_at
    ? "COALESCE(started_at, datetime('now'))"
    : 'started_at';

  db.transaction(() => {
    db.prepare(`UPDATE editing_jobs SET status = ?, updated_at = datetime('now'),
                started_at = ${startedAt}, finished_at = ${doneAt} WHERE id = ?`).run(status, id);

    // The queue drives the CLIENT-facing portal status, so both never disagree.
    // A job queued BEFORE its portal existed has portal_id = NULL, so resolve it from the
    // booking and remember it (otherwise the client would never see the stage change).
    const mirror = PORTAL_STATUS[status];
    let portalId = job.portal_id;
    if (!portalId) {
      const portal = db.prepare('SELECT id FROM photo_selections WHERE booking_id = ?').get(job.booking_id);
      if (portal) {
        portalId = portal.id;
        db.prepare('UPDATE editing_jobs SET portal_id = ? WHERE id = ?').run(portalId, id);
      }
    }
    if (mirror && portalId) {
      db.prepare(`UPDATE photo_selections SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(mirror, portalId);
    }

    payments.logEvent(job.booking_id, {
      kind: 'editing',
      from: job.status,
      to: status,
      actor,
      note: `Status editing: ${stageLabel(job.status)} → ${stageLabel(status)}`
    });
  })();

  // Antrean bergeser: kartu berikutnya menjadi #1 dan otomatis "Proses Editing".
  refreshActive();
  return { ok: true, job: jobById(id) };
}

/** Update the editor / target date / internal note (position is separate on purpose). */
/**
 * Update the target date and/or the internal note. `editorId` is accepted for
 * compatibility but no longer offered in the UI (revisi: pilihan editor dihapus,
 * deadline dihitung otomatis 10 hari kerja).
 */
function update(jobId, { dueAt, note } = {}) {
  const job = db.prepare('SELECT * FROM editing_jobs WHERE id = ?').get(Number(jobId));
  if (!job) return { ok: false, message: 'Job editing tidak ditemukan.' };

  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(dueAt || '')) ? String(dueAt) : null;
  const dueValue = due || job.due_at || null;

  db.prepare(`UPDATE editing_jobs SET due_at = ?, note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(dueValue, String(note || '').slice(0, 2000), job.id);

  if ((job.due_at || '') !== (dueValue || '')) {
    payments.logEvent(job.booking_id, {
      kind: 'editing',
      actor: 'admin',
      note: dueValue ? `Target selesai editing: ${dueValue}` : 'Target selesai editing dikosongkan'
    });
  }
  return { ok: true };
}

function remove(jobId, { actor = 'admin' } = {}) {
  const job = db.prepare('SELECT * FROM editing_jobs WHERE id = ?').get(Number(jobId));
  if (!job) return { ok: false, message: 'Job editing tidak ditemukan.' };
  db.prepare('DELETE FROM editing_jobs WHERE id = ?').run(job.id);
  payments.logEvent(job.booking_id, { kind: 'editing', actor, note: 'Job editing dihapus dari antrean' });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Client view (portal) — never includes the internal note              */
/* ------------------------------------------------------------------ */
function clientView(portalId) {
  if (!portalId) return null;
  const job = db.prepare(`SELECT * FROM editing_jobs WHERE portal_id = ?
                          ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'editing' THEN 1 ELSE 2 END,
                                   id DESC LIMIT 1`).get(Number(portalId));
  if (!job) return null;
  const meta = stage(job.status);
  return {
    status: job.status,
    label: meta.label,
    hint: meta.hint,
    tone: meta.tone,
    // `note` and `due_at` are deliberately absent: they are internal. The client sees
    // the stage label and the progress strip, nothing else.
    // Stage index for the progress strip (0,1,2).
    index: STAGE_VALUES.indexOf(job.status),
    total: STAGES.length,
    stages: STAGES.map((s) => ({ value: s.value, label: s.label }))
  };
}

/** What the client sees when a selection is submitted but nothing is queued yet. */
function pendingView() {
  return {
    status: 'none',
    label: 'Menunggu masuk antrean',
    hint: 'Pilihan sudah diterima. Tim DLY Graduation akan mulai proses editing setelah antrean sesi ini dijadwalkan.',
    tone: 'muted',
    index: -1,
    total: STAGES.length,
    stages: STAGES.map((s) => ({ value: s.value, label: s.label }))
  };
}

module.exports = {
  STAGES,
  WORKING_DAYS,
  STAGE_VALUES,
  stage,
  stageLabel,
  jobById,
  jobForBooking,
  activeJobForBooking,
  board,
  activeQueue,
  queuePosition,
  refreshActive,
  stats,
  enqueue,
  setStatus,
  update,
  remove,
  clientView,
  pendingView
};

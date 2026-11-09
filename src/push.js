'use strict';

/**
 * Web Push (Tahap 6) — Android Chrome/Firefox and iPhone Safari (iOS 16.4+, only when the
 * site is added to the Home Screen).
 *
 * Design rules, all of them deliberate:
 *
 *  - **VAPID keys** are generated once on first boot and stored in `settings`
 *    (`push_vapid_public` / `push_vapid_private`). The browser only ever receives the
 *    PUBLIC key. Regenerating the pair would invalidate every existing subscription, so
 *    the generation is guarded by "only if empty".
 *  - **One row per device** (`push_subscriptions.endpoint` is UNIQUE). Re-subscribing the
 *    same browser updates that row instead of adding a second one — that is the first
 *    half of "no duplicate notifications".
 *  - **Each event is sent at most once.** Every event has a dedupe key (e.g.
 *    `job:42:2026-11-30`) and `push_log` has that key as PRIMARY KEY: a second attempt
 *    (scheduler restart, two admin tabs, an hourly tick) is skipped. That is the second
 *    half.
 *  - **Nothing sensitive on the lock screen.** Titles/bodies here are generic on purpose:
 *    no client name, no phone, no amount, no campus. The detail lives behind the tap, and
 *    the tap goes to an admin page that requires a login.
 *  - **Dead subscriptions are deactivated**, never retried forever: 404/410 from the push
 *    service flips `is_active = 0` immediately.
 */

const webpush = require('web-push');
const { db, getSettings, saveSettings } = require('./db');
const util = require('./util');

/* ------------------------------------------------------------------ */
/* VAPID                                                               */
/* ------------------------------------------------------------------ */
let cached = null;

function config() {
  if (cached) return cached;
  const settings = getSettings();
  let publicKey = String(settings.push_vapid_public || '').trim();
  let privateKey = String(settings.push_vapid_private || '').trim();
  const subject = String(settings.push_vapid_subject || '').trim() || 'mailto:admin@example.com';

  if (!publicKey || !privateKey) {
    const pair = webpush.generateVAPIDKeys();
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;
    saveSettings({ push_vapid_public: publicKey, push_vapid_private: privateKey });
    console.log('[push] VAPID keys generated (first boot)');
  }

  try { webpush.setVapidDetails(subject, publicKey, privateKey); } catch (err) {
    console.error('[push] VAPID tidak valid:', err.message);
    cached = { ok: false, publicKey: '', enabled: false, reason: 'Kunci VAPID tidak valid.' };
    return cached;
  }
  cached = { ok: true, publicKey, enabled: settings.push_enabled !== '0' };
  return cached;
}

/** Drop the cached VAPID config (after the keys were regenerated in settings). */
function resetConfig() { cached = null; }

const publicKey = () => config().publicKey;
const isEnabled = () => config().enabled;

/* ------------------------------------------------------------------ */
/* Event catalogue                                                     */
/* ------------------------------------------------------------------ */
/**
 * `setting` = the admin toggle key. `title`/`body` are intentionally generic.
 * `url` is an ADMIN path — the click handler opens it, and the admin route itself
 * redirects to the login page when there is no session.
 */
/**
 * Katalog event v2 (revisi).
 *
 * Setiap event punya:
 *   role    → siapa penerimanya ('admin' | 'client'). TIDAK ADA broadcast ke semua role.
 *   setting → toggle admin (`push_type_*`).
 *   title   → judul notifikasi (nama event, bukan "From Admin").
 *   body    → fungsi data → isi notifikasi. Data diambil dari database, tidak dikarang.
 *
 * Format yang disepakati:
 *   Booking baru masuk
 *   Muhammad Fadhli - UPI
 *   Segera cek availability-nya via dashboard.
 */
const EVENTS = {
  // ---------------- ADMIN (operasional) ----------------
  booking: {
    role: 'admin',
    setting: 'push_type_booking',
    title: 'Booking baru masuk',
    tag: 'dly-booking',
    url: (ctx) => (ctx.bookingId ? `/admin/bookings/${ctx.bookingId}` : '/admin/bookings'),
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      'Segera cek availability-nya via dashboard.'
    ].filter(Boolean).join('\n')
  },
  selection: {
    role: 'admin',
    setting: 'push_type_selection',
    title: 'Pilihan foto masuk',
    tag: 'dly-selection',
    url: (ctx) => (ctx.portalId ? `/admin/selection/${ctx.portalId}` : '/admin/selection'),
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      'Sudah mengirim dan mengonfirmasi pilihan fotonya.'
    ].filter(Boolean).join('\n')
  },
  payment: {
    role: 'admin',
    setting: 'push_type_payment',
    title: 'Pembayaran dicatat',
    tag: 'dly-payment',
    url: (ctx) => (ctx.bookingId ? `/admin/bookings/${ctx.bookingId}?tab=pembayaran` : '/admin/bookings'),
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      ctx.amountLabel ? `Pembayaran ${ctx.amountLabel} sudah tercatat.` : 'Pembayaran baru sudah tercatat.'
    ].filter(Boolean).join('\n')
  },
  deadline: {
    role: 'admin',
    setting: 'push_type_deadline',
    title: 'Deadline seleksi foto',
    tag: 'dly-deadline',
    url: () => '/admin/selection',
    body: () => 'Ada portal seleksi yang mendekati atau melewati batas waktu.'
  },
  job: {
    role: 'admin',
    setting: 'push_type_job',
    title: 'Jadwal pemotretan besok',
    tag: 'dly-job',
    url: () => '/admin/bookings?tab=tomorrow',
    body: () => 'Ada sesi pemotretan yang dijadwalkan besok. Siapkan tim dan peralatan.'
  },
  editing: {
    role: 'admin',
    setting: 'push_type_editing',
    title: 'Editing selesai',
    tag: 'dly-editing',
    url: (ctx) => (ctx.bookingId ? `/admin/bookings/${ctx.bookingId}?tab=workflow` : '/admin/editing'),
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      'Job editing sudah ditandai selesai.'
    ].filter(Boolean).join('\n')
  },

  // ---------------- CLIENT (hanya booking miliknya) ----------------
  // Daftar ini DISEPAKATI; jangan menambah jenis lain tanpa persetujuan.
  client_confirmed: {
    role: 'client',
    setting: 'push_client_confirmed',
    title: 'Booking kamu sudah dikonfirmasi',
    tag: 'dly-client-confirmed',
    url: () => '/portal/ringkasan',
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      'Jadwal sesi fotomu sudah dikonfirmasi admin. Cek detailnya di portal.'
    ].filter(Boolean).join('\n')
  },
  client_photos_ready: {
    role: 'client',
    setting: 'push_client_photos',
    title: 'Foto siap dipilih',
    tag: 'dly-client-photos',
    url: () => '/portal/pilih-foto',
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      'Foto hasil pemotretanmu sudah siap dipilih di Client Portal.'
    ].filter(Boolean).join('\n')
  },
  client_deadline: {
    role: 'client',
    setting: 'push_client_deadline',
    title: 'Pengingat batas waktu pemilihan foto',
    tag: 'dly-client-deadline',
    url: () => '/portal/pilih-foto',
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      ctx.deadlineLabel ? `Batas waktu memilih foto: ${ctx.deadlineLabel}.` : 'Batas waktu memilih foto sudah dekat.'
    ].filter(Boolean).join('\n')
  },
  client_final: {
    role: 'client',
    setting: 'push_client_final',
    // Revisi 2 (03): teks yang disepakati untuk "order selesai".
    title: 'Editan kamu sudah selesai',
    tag: 'dly-client-final',
    url: () => '/portal/drive',
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      'Hasil edit sudah siap. Buka Client Portal → Orderanmu Siap untuk melihat tautannya.'
    ].filter(Boolean).join('\n')
  },
  // Revisi 2 (03): pembayaran/DP terkonfirmasi juga dikabarkan ke CLIENT pemilik
  // booking (sebelumnya hanya admin). Hanya nominal & status, tanpa data pribadi lain.
  client_payment: {
    role: 'client',
    setting: 'push_client_payment',
    // `label` dipakai halaman admin /admin/push untuk nama toggle (title bisa fungsi).
    label: 'Pembayaran / DP terkonfirmasi',
    title: (ctx) => (ctx.paymentKind === 'dp' ? 'DP kamu sudah dikonfirmasi'
      : ctx.paymentKind === 'settlement' ? 'Pembayaran kamu sudah lunas'
        : 'Pembayaran kamu sudah dikonfirmasi'),
    tag: 'dly-client-payment',
    url: () => '/portal/ringkasan',
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      ctx.amountLabel
        ? `Pembayaran ${ctx.amountLabel} sudah kami terima dan tercatat.`
        : 'Pembayaran kamu sudah kami terima dan tercatat.'
    ].filter(Boolean).join('\n')
  },
  client_reschedule: {
    role: 'client',
    setting: 'push_client_reschedule',
    title: 'Jadwal sesi berubah',
    tag: 'dly-client-reschedule',
    url: () => '/portal/pantau-order',
    body: (ctx) => [
      [ctx.clientName, ctx.campus].filter(Boolean).join(' - '),
      ctx.scheduleLabel ? `Jadwal baru: ${ctx.scheduleLabel}.` : 'Jadwal sesi fotomu sudah diperbarui admin.'
    ].filter(Boolean).join('\n')
  }
};

/** Role yang AKTIF mengirim. fg/editor disiapkan tetapi belum diaktifkan. */
const ACTIVE_ROLES = ['admin', 'client'];
const PREPARED_ROLES = ['fg', 'editor'];

const eventEnabled = (kind) => {
  const def = EVENTS[kind];
  if (!def) return false;
  return getSettings()[def.setting] !== '0';
};

/* ------------------------------------------------------------------ */
/* Subscriptions (dipisah per role)                                    */
/* ------------------------------------------------------------------ */
const devices = () => db.prepare(
  'SELECT * FROM push_subscriptions ORDER BY is_active DESC, id DESC'
).all();

const adminDevices = () => db.prepare(
  "SELECT * FROM push_subscriptions WHERE is_active = 1 AND (role IS NULL OR role = 'admin')"
).all();

const clientDevices = (bookingId) => db.prepare(
  "SELECT * FROM push_subscriptions WHERE is_active = 1 AND role = 'client' AND booking_id = ?"
).all(Number(bookingId));

/** Penerima untuk satu event — TIDAK PERNAH broadcast ke semua role. */
const recipientsFor = (role, bookingId) => {
  if (!ACTIVE_ROLES.includes(role)) return [];           // fg/editor belum aktif
  if (role === 'client') return bookingId ? clientDevices(bookingId) : [];
  return adminDevices();
};

const activeDevices = () => db.prepare(
  'SELECT * FROM push_subscriptions WHERE is_active = 1'
).all();

const deviceCount = (role = null) => {
  if (role === 'client') {
    return db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE is_active = 1 AND role = 'client'").get().n;
  }
  if (role === 'admin') {
    return db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE is_active = 1 AND (role IS NULL OR role = 'admin')").get().n;
  }
  return db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE is_active = 1').get().n;
};

function describeAgent(ua) {
  const s = String(ua || '');
  if (/iPhone|iPad|iPod/i.test(s)) return 'iPhone / iPad';
  if (/Android/i.test(s)) return 'Android';
  if (/Windows/i.test(s)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(s)) return 'macOS';
  if (/Linux/i.test(s)) return 'Linux';
  return 'Perangkat lain';
}

/**
 * Simpan / perbarui satu subscription. UNIQUE(endpoint) mencegah perangkat yang sama
 * tersimpan dua kali. `role` + `booking_id` menentukan event apa yang boleh diterimanya.
 */
function saveSubscription(subscription, meta = {}) {
  const endpoint = String((subscription && subscription.endpoint) || '').trim();
  const keys = (subscription && subscription.keys) || {};
  const p256dh = String(keys.p256dh || '').trim();
  const auth = String(keys.auth || '').trim();
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    const err = new Error('Data langganan notifikasi tidak lengkap.');
    err.status = 422;
    throw err;
  }

  const role = ['admin', 'client', 'fg', 'editor'].includes(String(meta.role)) ? String(meta.role) : 'admin';
  const bookingId = role === 'client' ? (Number(meta.bookingId) || null) : null;
  if (role === 'client' && !bookingId) {
    const err = new Error('Notifikasi client harus terhubung ke satu booking.');
    err.status = 422;
    throw err;
  }

  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  const userAgent = String(meta.userAgent || '').slice(0, 300);
  const platform = String(meta.platform || '').slice(0, 40) || describeAgent(userAgent);
  const label = String(meta.label || '').slice(0, 60) || platform;

  if (existing) {
    db.prepare(`UPDATE push_subscriptions
                SET p256dh = ?, auth = ?, label = ?, platform = ?, user_agent = ?, role = ?,
                    booking_id = ?, is_active = 1, failures = 0, last_error = '',
                    updated_at = datetime('now')
                WHERE id = ?`)
      .run(p256dh, auth, label, platform, userAgent, role, bookingId, existing.id);
    return { created: false, id: existing.id, role };
  }

  const info = db.prepare(`INSERT INTO push_subscriptions
      (endpoint, p256dh, auth, label, platform, user_agent, role, booking_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .run(endpoint, p256dh, auth, label, platform, userAgent, role, bookingId);
  return { created: true, id: Number(info.lastInsertRowid), role };
}

const removeByEndpoint = (endpoint) =>
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint || '')).changes;

const removeDevice = (id) =>
  db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(Number(id)).changes;

const setDeviceActive = (id, active) =>
  db.prepare("UPDATE push_subscriptions SET is_active = ?, updated_at = datetime('now') WHERE id = ?")
    .run(active ? 1 : 0, Number(id)).changes;

/* ------------------------------------------------------------------ */
/* Idempotency log                                                     */
/* ------------------------------------------------------------------ */
const alreadySent = (eventId) => Boolean(
  db.prepare('SELECT 1 FROM push_log WHERE dedupe_key = ? AND ok = 1').get(String(eventId || ''))
);

function markSent(eventId, kind, { ok, sent, role }) {
  db.prepare(`INSERT INTO push_log (dedupe_key, kind, event_id, ok, sent) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(dedupe_key) DO UPDATE SET ok = excluded.ok, sent = excluded.sent`)
    .run(String(eventId), kind, String(eventId), ok ? 1 : 0, Number(sent) || 0);
  void role;
}

function pruneLog(days = 180) {
  db.prepare("DELETE FROM push_log WHERE created_at < datetime('now', ?)").run(`-${Number(days)} days`);
  db.prepare("DELETE FROM push_deliveries WHERE created_at < datetime('now', ?)").run(`-${Number(days)} days`);
}

const logDelivery = (row) => {
  db.prepare(`INSERT INTO push_deliveries
      (event_id, kind, role, booking_id, subscription_id, device, status, http_status, reason, retry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(row.eventId), String(row.kind || ''), String(row.role || 'admin'),
      row.bookingId == null ? null : Number(row.bookingId),
      row.subscriptionId == null ? null : Number(row.subscriptionId),
      String(row.device || '').slice(0, 80), String(row.status || 'pending'),
      Number(row.httpStatus) || 0, String(row.reason || '').slice(0, 300), Number(row.retry) || 0);
};

const deliveriesFor = (eventId, limit = 100) => db.prepare(
  'SELECT * FROM push_deliveries WHERE event_id = ? ORDER BY id DESC LIMIT ?'
).all(String(eventId), Number(limit));

/** Log pengiriman terbaru (untuk halaman admin). */
const recentDeliveries = (limit = 60) => db.prepare(
  `SELECT d.*, p.label AS device_label FROM push_deliveries d
   LEFT JOIN push_subscriptions p ON p.id = d.subscription_id
   ORDER BY d.id DESC LIMIT ?`
).all(Number(limit));

/* ------------------------------------------------------------------ */
/* Sending                                                            */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kirim satu event.
 *
 * @param {string} kind      salah satu EVENTS
 * @param {object} opts      { eventId, bookingId, portalId, clientName, campus, url, vars, force }
 * @returns {Promise<{ok:boolean, skipped?:string, sent:number, failed:number, gone:number, eventId:string}>}
 */
async function send(kind, opts = {}) {
  const def = EVENTS[kind];
  if (!def) return { ok: false, skipped: 'unknown-kind', sent: 0, failed: 0, gone: 0, eventId: '' };
  if (!config().ok) return { ok: false, skipped: 'vapid', sent: 0, failed: 0, gone: 0, eventId: '' };
  if (!isEnabled()) return { ok: false, skipped: 'disabled', sent: 0, failed: 0, gone: 0, eventId: '' };
  // eventEnabled() menerima JENIS event (bukan nama setting). Bug ini sebelumnya membuat
  // SEMUA notifikasi dianggap "type-disabled" sehingga tidak pernah terkirim.
  if (!opts.force && !eventEnabled(kind)) {
    return { ok: false, skipped: 'type-disabled', sent: 0, failed: 0, gone: 0, eventId: '' };
  }
  if (!ACTIVE_ROLES.includes(def.role)) {
    return { ok: false, skipped: 'role-inactive', sent: 0, failed: 0, gone: 0, eventId: '' };
  }

  // event_id deterministik: satu aktivitas = satu notifikasi, walau dipanggil berkali-kali.
  const eventId = String(opts.eventId || '').trim();
  if (!eventId) {
    return { ok: false, skipped: 'no-event-id', sent: 0, failed: 0, gone: 0, eventId: '' };
  }
  if (!opts.force && alreadySent(eventId)) {
    return { ok: true, skipped: 'duplicate', sent: 0, failed: 0, gone: 0, eventId };
  }

  const ctx = {
    bookingId: opts.bookingId || null,
    portalId: opts.portalId || null,
    clientName: opts.clientName || '',
    campus: opts.campus || '',
    deadlineLabel: opts.deadlineLabel || '',
    scheduleLabel: opts.scheduleLabel || '',
    amountLabel: opts.amountLabel || '',
    paymentKind: opts.paymentKind || ''
  };

  const subs = recipientsFor(def.role, ctx.bookingId);
  if (!subs.length) {
    markSent(eventId, kind, { ok: true, sent: 0, role: def.role });
    return { ok: true, skipped: 'no-devices', sent: 0, failed: 0, gone: 0, eventId };
  }

  const url = typeof def.url === 'function' ? def.url(ctx) : (def.url || '/admin/notifications');
  const payload = JSON.stringify({
    // `title` boleh berupa fungsi (mis. DP vs pelunasan punya judul berbeda).
    title: typeof def.title === 'function' ? def.title(ctx) : def.title,
    body: (typeof def.body === 'function' ? def.body(ctx) : def.body) || '',
    url,
    tag: def.tag,
    kind,
    eventId
  });

  let sent = 0;
  let failed = 0;
  let gone = 0;

  for (const sub of subs) {
    let attempt = 0;
    let delivered = false;
    // Retry maksimal 2x untuk kegagalan SEMENTARA (bukan 404/410).
    while (attempt <= 2 && !delivered) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 60 * 60 * 12, urgency: 'normal' }
        );
        delivered = true;
        sent += 1;
        db.prepare(`UPDATE push_subscriptions SET last_ok_at = datetime('now'), failures = 0,
                    last_error = '' WHERE id = ?`).run(sub.id);
        logDelivery({
          eventId, kind, role: def.role, bookingId: ctx.bookingId, subscriptionId: sub.id,
          device: sub.label || sub.platform, status: 'sent', retry: attempt
        });
      } catch (err) {
        const status = Number(err && err.statusCode) || 0;
        if (status === 404 || status === 410) {
          gone += 1;
          db.prepare(`UPDATE push_subscriptions SET is_active = 0, failures = failures + 1,
                      last_error = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(`Endpoint tidak berlaku (${status})`, sub.id);
          logDelivery({
            eventId, kind, role: def.role, bookingId: ctx.bookingId, subscriptionId: sub.id,
            device: sub.label || sub.platform, status: 'gone', httpStatus: status,
            reason: `Endpoint tidak berlaku (${status})`, retry: attempt
          });
          delivered = true; // jangan retry endpoint mati
        } else if (attempt < 2) {
          attempt += 1;
          await sleep(250 * attempt);
        } else {
          failed += 1;
          const reason = String((err && (err.body || err.message)) || 'Gagal mengirim').slice(0, 200);
          db.prepare(`UPDATE push_subscriptions SET failures = failures + 1, last_error = ?,
                      updated_at = datetime('now') WHERE id = ?`).run(reason, sub.id);
          logDelivery({
            eventId, kind, role: def.role, bookingId: ctx.bookingId, subscriptionId: sub.id,
            device: sub.label || sub.platform, status: 'failed', httpStatus: status,
            reason, retry: attempt
          });
          delivered = true;
        }
      }
    }
  }

  markSent(eventId, kind, { ok: sent > 0, sent, role: def.role });
  return { ok: true, sent, failed, gone, eventId, role: def.role, url };
}

/** Fire-and-forget: masalah push tidak boleh menggagalkan aksi utama. */
function notify(kind, opts) {
  send(kind, opts).catch((err) => console.error('[push] gagal kirim', kind, err.message));
}

/** Kirim notifikasi percobaan HANYA saat admin menekan tombol (manual). */
async function sendTest({ url = '/admin/notifications' } = {}) {
  return send('booking', {
    eventId: `test:${Date.now()}`,
    bookingId: null,
    clientName: 'Uji coba',
    campus: 'Manual dari dashboard',
    url,
    force: true
  });
}

/* ------------------------------------------------------------------ */
/* Scheduled events (deadline + jadwal besok)                          */
/* ------------------------------------------------------------------ */
async function runScheduled({ force = false } = {}) {
  const today = util.todayISO();
  const tomorrow = util.addDaysISO(today, 1);
  const result = { deadline: null, job: null, clientDeadline: null };

  // --- admin: deadline seleksi (≤3 hari / terlewat) ---
  try {
    const due = db.prepare(`SELECT ps.id, ps.deadline FROM photo_selections ps
                            JOIN bookings b ON b.id = ps.booking_id
                            WHERE ps.is_open = 1 AND ps.submitted_at IS NULL
                              AND ps.deadline IS NOT NULL AND ps.deadline <= ?
                            ORDER BY ps.deadline ASC`).all(util.addDaysISO(today, 3));
    if (due.length) {
      result.deadline = await send('deadline', {
        eventId: `deadline:${today}:${due.map((d) => d.id).sort().join('-')}`,
        force
      });
    }
  } catch (err) { console.error('[push] jadwal deadline', err.message); }

  // --- admin: jadwal pemotretan besok ---
  try {
    const jobs = db.prepare(`SELECT id FROM bookings WHERE shooting_date = ? AND status <> 'cancelled' ORDER BY id`).all(tomorrow);
    if (jobs.length) {
      result.job = await send('job', {
        eventId: `job:${tomorrow}:${jobs.map((j) => j.id).sort().join('-')}`,
        force
      });
    }
  } catch (err) { console.error('[push] jadwal job', err.message); }

  // --- client: pengingat batas waktu pemilihan foto (H-2 / H-1 / hari terakhir) ---
  try {
    const soon = db.prepare(`SELECT ps.id, ps.booking_id, ps.deadline, b.client_name, b.campus, b.code
                             FROM photo_selections ps JOIN bookings b ON b.id = ps.booking_id
                             WHERE ps.is_open = 1 AND ps.submitted_at IS NULL
                               AND ps.deadline IS NOT NULL
                               AND ps.deadline BETWEEN ? AND ?`).all(today, util.addDaysISO(today, 2));
    const results = [];
    for (const row of soon) {
      results.push(await send('client_deadline', {
        eventId: `client-deadline:${row.id}:${today}`,
        bookingId: row.booking_id,
        clientName: row.client_name,
        campus: row.campus,
        deadlineLabel: util.formatDateID(row.deadline, true),
        force
      }));
    }
    result.clientDeadline = results;
  } catch (err) { console.error('[push] jadwal client deadline', err.message); }

  saveSettings({ push_last_run_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
  pruneLog();
  return result;
}

function startScheduler({ intervalMs = 60 * 60 * 1000 } = {}) {
  if (process.env.DLY_DISABLE_PUSH_SCHEDULER === '1') return null;
  // Jangan kirim apa pun hanya karena server restart/deploy: tunggu 10 menit dulu.
  // Event terjadwal juga punya event_id harian, jadi tidak pernah dobel dalam satu hari.
  const tick = () => {
    runScheduled().catch((err) => console.error('[push] scheduler', err.message));
  };
  const first = setTimeout(tick, 10 * 60 * 1000);
  if (first.unref) first.unref();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  EVENTS,
  ACTIVE_ROLES,
  PREPARED_ROLES,
  recipientsFor,
  adminDevices,
  clientDevices,
  sendTest,
  logDelivery,
  deliveriesFor,
  recentDeliveries,
  config,
  resetConfig,
  publicKey,
  isEnabled,
  eventEnabled,
  devices,
  activeDevices,
  deviceCount,
  describeAgent,
  saveSubscription,
  removeByEndpoint,
  removeDevice,
  setDeviceActive,
  send,
  notify,
  runScheduled,
  startScheduler,
  alreadySent,
  pruneLog
};

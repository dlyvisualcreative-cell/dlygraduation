'use strict';

/**
 * Timeline order Client Portal (blueprint §8).
 *
 * Aturan penting:
 *  - Hanya tahap yang SUDAH tercapai yang ditampilkan. Yang belum aktif tidak dirender
 *    sama sekali (bukan abu-abu, bukan placeholder).
 *  - Tahap 06 (Masuk Antrean Editing) dan 07 (Proses Editing) aktif BERSAMAAN setelah
 *    klien mengirim pilihan foto — sesuai kesepakatan di blueprint.
 *  - Setiap tahap punya timestamp, aktor (admin/sistem/klien) dan pemicu, disimpan di
 *    `booking_timeline` (UNIQUE booking_id+stage → tidak pernah dobel).
 *  - Semua waktu ditampilkan dalam WIB (Asia/Jakarta).
 */

const { db } = require('./db');
const util = require('./util');
const editing = require('./editing');

const STAGES = [
  {
    key: 'confirmed',
    no: '01',
    title: 'Booking Terkonfirmasi',
    blurb: 'Booking kamu sudah terkonfirmasi oleh admin.',
    trigger: 'Admin mengonfirmasi booking',
    actor: 'admin'
  },
  {
    key: 'dp_confirmed',
    no: '02',
    title: 'DP Terkonfirmasi',
    blurb: 'DP kamu sudah kami terima dan verifikasi.',
    trigger: 'Admin memverifikasi DP',
    actor: 'admin'
  },
  {
    key: 'session_done',
    no: '03',
    // Judul & keterangan tahap ini DINAMIS mengikuti waktu (lihat sessionCopy()):
    //   belum mulai → "Sesi Foto" + jadwal + "jangan telat"
    //   sedang berjalan → "Sesi Fotomu Dimulai"
    //   selesai → "Sesi Foto Selesai"
    title: 'Sesi Foto',
    blurb: 'Sesi fotografi kamu sesuai jadwal booking.',
    trigger: 'Jadwal sesi foto',
    actor: 'sistem'
  },
  {
    key: 'photos_ready',
    no: '04',
    title: 'Foto Siap Dipilih',
    blurb: 'Foto mentah sudah siap untuk kamu pilih.',
    trigger: 'Admin menandai foto siap dipilih',
    actor: 'admin'
  },
  {
    key: 'submitted',
    no: '05',
    title: 'Foto Mentah Dikirim',
    blurb: 'Pilihan foto kamu sudah dikirim ke admin.',
    trigger: 'Kamu mengirim pilihan foto',
    actor: 'klien'
  },
  {
    key: 'editing_queue',
    no: '06',
    title: 'Masuk Antrean Editing',
    blurb: 'Pesanan kamu masuk antrean editing.',
    trigger: 'Otomatis setelah pilihan foto dikirim',
    actor: 'sistem'
  },
  {
    key: 'editing',
    no: '07',
    title: 'Proses Editing',
    blurb: 'Tim mulai memproses foto pilihanmu.',
    trigger: 'Otomatis aktif saat antreanmu menjadi #1',
    actor: 'sistem'
  },
  {
    key: 'final_ready',
    no: '08',
    title: 'Foto Editmu Siap',
    blurb: 'Foto final sudah siap diakses di menu Orderanmu Siap.',
    trigger: 'Admin menekan SELESAI setelah link Drive valid',
    actor: 'admin'
  }
];

const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.key, s]));

/** Copy pengingat yang muncul HANYA saat tahap 03 (sesi dimulai) aktif. */
const SESSION_REMINDER = 'Harap datang tepat waktu. Jika terlambat, durasi sesi akan tetap dihitung sesuai jadwal.';

/** Jadwal sesi (tanggal + jam WIB) dari kolom booking → Date UTC. */
function sessionStart(booking) {
  const b = booking || {};
  if (!b.shooting_date) return null;
  const d = new Date(`${b.shooting_date}T${(b.shooting_time || '09:00')}:00+07:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Akhir sesi = mulai + durasi paket. TIDAK ada tambahan jeda: permintaan pemilik
 * (Revisi 4) — booking 60 menit 07.00–08.00 harus menjadi "Sesi Fotomu Selesai" tepat
 * setelah jam 08.00. Sebelumnya ditambah 60 menit "jeda tim" sehingga tahap 03 masih
 * berstatus aktif satu jam setelah sesi benar-benar berakhir.
 */
const SESSION_BUFFER_MINUTES = 0;
function sessionEnd(booking) {
  const start = sessionStart(booking);
  if (!start) return null;
  const minutes = Number((booking && booking.duration_minutes) || 0) || 60;
  return new Date(start.getTime() + (minutes + SESSION_BUFFER_MINUTES) * 60 * 1000);
}

/** Jam WIB (HH:MM) dari sebuah Date. */
function wibClock(date) {
  if (!date) return '';
  const shifted = new Date(date.getTime() + 7 * 3600 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Judul + keterangan tahap 03 sesuai waktu sesi (permintaan pemilik, Revisi 5):
 *   upcoming → "Menunggu sesi foto"  (+ jadwal & pengingat jangan telat)
 *   active   → "Sesi foto dimulai"   (+ badge kedap-kedip "Sedang berlangsung")
 *   done     → "Sesimu sudah selesai"
 * Semua waktu WIB, diambil dari data booking (bukan jam perangkat klien).
 */
function sessionCopy(booking, state) {
  const start = sessionStart(booking);
  const end = sessionEnd(booking);
  const startLabel = start ? util.formatDateTimeWIB(start.toISOString()) : '';
  // "9 November 2026, 13:11 – 14:41 WIB" (jam akhir = mulai + durasi paket).
  const endLabel = end ? `${wibClock(end)} WIB` : '';
  const rangeLabel = start && end
    ? `${util.formatDateTimeWIB(start.toISOString()).replace(/ WIB$/, '')} – ${endLabel}`
    : startLabel;
  const late = 'Jangan telat ya, datang tepat waktu supaya durasi sesimu tidak berkurang.';
  if (state === 'upcoming') {
    return {
      title: 'Menunggu sesi foto',
      blurb: rangeLabel
        ? `Sesi fotomu dijadwalkan ${rangeLabel}. ${late}`
        : `Sesi fotomu akan dimulai sesuai jadwal booking. ${late}`,
      chip: 'Dijadwalkan'
    };
  }
  if (state === 'active') {
    return {
      title: 'Sesi foto dimulai',
      blurb: end
        ? `Waktu sesi foto kamu sudah tiba dan sedang berlangsung, dijadwalkan sampai ${endLabel}.`
        : 'Waktu sesi foto kamu sudah tiba dan sedang berlangsung.',
      chip: 'Sedang berlangsung',
      reminder: true
    };
  }
  return {
    title: 'Sesimu sudah selesai',
    blurb: 'Kamu sudah menyelesaikan sesi foto, dan sekarang tinggal nunggu fotografer kamu '
      + 'untuk meng upload file mentahnya ya.',
    chip: ''
  };
}

/** Tanggal pembayaran pertama yang tercatat (dipakai tahap 02 — DP terkonfirmasi). */
function firstPaymentAt(bookingId) {
  const row = db.prepare(`SELECT MIN(paid_at) AS at FROM booking_payments
                          WHERE booking_id = ? AND amount > 0`).get(Number(bookingId));
  return (row && row.at) || null;
}

/* ------------------------------------------------------------------ */
/* Pencatatan                                                          */
/* ------------------------------------------------------------------ */
/** Catat satu tahap (idempoten). Mengembalikan true bila baris baru dibuat. */
function record(bookingId, stage, { actor = 'sistem', note = '', at = null } = {}) {
  if (!STAGE_MAP[stage]) return false;
  const def = STAGE_MAP[stage];
  const info = db.prepare(`INSERT OR IGNORE INTO booking_timeline (booking_id, stage, actor, note, happened_at)
                           VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`)
    .run(Number(bookingId), stage, String(actor || def.actor).slice(0, 20),
      String(note || '').slice(0, 200), at);
  return info.changes > 0;
}

const rowsFor = (bookingId) =>
  db.prepare('SELECT * FROM booking_timeline WHERE booking_id = ?').all(Number(bookingId));

const timeOf = (rows, stage) => {
  const hit = rows.find((r) => r.stage === stage);
  return hit ? hit.happened_at : null;
};

/* ------------------------------------------------------------------ */
/* Perhitungan tahap                                                   */
/* ------------------------------------------------------------------ */
/**
 * Hitung tahap yang sudah tercapai untuk satu booking, lalu catat yang belum tercatat
 * (agar riwayat punya timestamp & aktor). Tidak pernah menghapus baris lama.
 *
 * @param {object} booking baris bookings.*
 * @param {{portal?:object|null, now?:Date}} ctx
 */
function reach(booking, { portal = null, now = new Date() } = {}) {
  const b = booking || {};
  const id = Number(b.id);
  if (!id) return [];
  const existing = rowsFor(id);
  const has = new Set(existing.map((r) => r.stage));
  const created = [];

  const isConfirmed = b.status === 'confirmed' || b.status === 'completed';
  const submitted = Boolean(portal && portal.submitted_at);

  // 01 — admin mengonfirmasi booking
  if (isConfirmed && !has.has('confirmed')) {
    if (record(id, 'confirmed', { actor: 'admin', at: b.confirmed_at || b.updated_at || null })) created.push('confirmed');
  }

  // 02 — admin memverifikasi DP (ada pembayaran tercatat). Tidak ada pembayaran = tidak
  // ada tahap; tidak ada nominal yang dikarang.
  const paidAt = firstPaymentAt(id);
  if (paidAt && !has.has('dp_confirmed')) {
    if (record(id, 'dp_confirmed', { actor: 'admin', at: paidAt })) created.push('dp_confirmed');
  }

  // 03 — sesi foto: baris dicatat TEPAT saat jam sesi tiba (tahap tampil & aktif),
  // lalu statusnya menjadi "selesai" ketika perkiraan akhir sesi terlewati.
  const startAt = sessionStart(b);
  if (isConfirmed && startAt && now.getTime() >= startAt.getTime()) {
    if (!has.has('session_done') && record(id, 'session_done', {
      at: `${startAt.toISOString().slice(0, 10)} ${startAt.toISOString().slice(11, 19)}`
    })) created.push('session_done');
  }

  // 04 — portal sortir sudah dibuat
  if (portal) {
    if (!has.has('photos_ready') && record(id, 'photos_ready', { actor: 'admin', at: portal.created_at || null })) {
      created.push('photos_ready');
    }
    // 05 — klien mengirim pilihan foto
    if (submitted && !has.has('submitted')) {
      if (record(id, 'submitted', { actor: 'klien', at: portal.submitted_at })) created.push('submitted');
    }
  }

  // 06 — masuk antrean editing (setelah pilihan dikirim / job dibuat manual oleh admin)
  const queue = editing.queuePosition(id);
  const job = editing.jobForBooking(id);
  const inQueue = submitted || Boolean(job);
  if (inQueue && !has.has('editing_queue')) {
    if (record(id, 'editing_queue', { at: (portal && portal.submitted_at) || (job && job.created_at) || null })) {
      created.push('editing_queue');
    }
  }

  // 07 — Proses Editing hanya aktif saat kartu order menjadi urutan #1 di antrean.
  // Job yang sudah selesai tetap dicatat (pernah dikerjakan).
  // Posisi dihitung dari data antrean aktif (bukan urutan visual). #1 = dikerjakan.
  const isFirst = queue.position === 1;
  const wasWorked = Boolean(job && (job.status === 'done' || job.finished_at));
  if ((isFirst || wasWorked) && !has.has('editing')) {
    if (record(id, 'editing', { at: (job && job.started_at) || null })) created.push('editing');
  }

  // 08 — admin menyelesaikan order (link Drive valid)
  if (b.final_at || b.final_url) {
    if (!has.has('final_ready') && record(id, 'final_ready', { actor: 'admin', at: b.final_at || null })) {
      created.push('final_ready');
    }
  }

  return created;
}

/**
 * Daftar tahap untuk ditampilkan (hanya yang sudah tercapai), terurut nomor.
 * @returns {{items:Array, current:object|null, progress:number}}
 */
function list(booking, ctx = {}) {
  reach(booking, ctx);
  const rows = rowsFor(booking.id);
  const byKey = new Map(rows.map((r) => [r.stage, r]));
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const startAt = sessionStart(booking);
  const endAt = sessionEnd(booking);
  const queue = editing.queuePosition(booking && booking.id);
  const isConfirmed = booking && (booking.status === 'confirmed' || booking.status === 'completed');
  // Tahap 03 murni mengikuti JAM, bukan urutan tahap lain. BUG yang diperbaiki di sini:
  // sebelumnya status tahap sesi bisa ikut ditentukan oleh "tahap terakhir yang tercapai",
  // sehingga booking yang sesinya BARU dimulai (mis. 13:11) langsung terbaca
  // "Sesimu sudah selesai" hanya karena tahap lain (Foto Siap Dipilih) lebih akhir.
  const sessionStarted = Boolean(startAt) && now.getTime() >= startAt.getTime();
  const sessionOver = Boolean(endAt) && now.getTime() >= endAt.getTime();
  // Baris sesi yang tercatat saat jadwal LAMA (booking sudah di-reschedule ke depan)
  // tidak boleh dipakai: sesi itu belum terjadi pada jadwal sekarang.
  const staleSessionRow = byKey.has('session_done') && Boolean(startAt) && !sessionStarted;

  // Tahap yang SUDAH tercapai, terurut nomor.
  const items = STAGES
    .filter((s) => byKey.has(s.key) && !(s.key === 'session_done' && staleSessionRow))
    .map((s) => {
    const row = byKey.get(s.key);
    return {
      ...s,
      at: row.happened_at,
      atLabel: util.formatDateTimeWIB(row.happened_at),
      actor: row.actor || s.actor,
      note: row.note || '',
      state: 'done',
      // Posisi antrean aktual ditampilkan di tahap 06, dihitung dari database.
      queue: s.key === 'editing_queue' && queue.position
        ? { position: queue.position, total: queue.total }
        : null
    };
  });

  // Tahap 03 ditampilkan LEBIH DULU sebagai "akan dimulai" (permintaan pemilik):
  // selama booking sudah dikonfirmasi dan jam sesi belum tiba, barisnya muncul dengan
  // state 'upcoming' + jadwal dari booking. Tidak dihitung sebagai tahap tercapai.
  if (isConfirmed && startAt && (!byKey.has('session_done') || staleSessionRow) && !sessionOver) {
    const upcoming = {
      ...STAGE_MAP.session_done,
      at: null,
      atLabel: util.formatDateTimeWIB(startAt.toISOString()),
      actor: 'sistem',
      note: '',
      queue: null,
      state: 'upcoming'
    };
    items.push(upcoming);
    items.sort((a, b) => Number(a.no) - Number(b.no));
  }

  // Status tiap tahap: 'done' | 'active' | 'upcoming'.
  //   - Tahap 03 aktif selama sesi berjalan, selesai TEPAT setelah durasi sesi habis.
  //   - Hanya tahap yang benar-benar SEDANG berjalan yang memakai badge
  //     "Sedang Berlangsung". Booking Terkonfirmasi, DP, Foto Siap Dipilih, Pilihan
  //     Terkirim dan Foto Editmu Siap selalu tampil sebagai centang hijau biasa
  //     (permintaan pemilik: "kalau sudah terkonfirmasi … centang saja").
  const ACTIVE_KEYS = new Set(['editing_queue', 'editing']);
  const reached = items.filter((i) => i.state !== 'upcoming');
  const lastKey = reached.length ? reached[reached.length - 1].key : '';
  // Sesi berjalan = jam sesi sudah tiba dan durasi sesi belum habis.
  const sessionRunning = isConfirmed && sessionStarted && !sessionOver;
  items.forEach((item) => {
    if (item.state === 'upcoming') { /* tetap upcoming */ }
    // Tahap 03 SELALU dari jam (bukan dari urutan tahap): sedang berjalan → aktif,
    // lewat durasi sesi → centang hijau. Ini yang sebelumnya salah.
    else if (item.key === 'session_done') item.state = sessionOver ? 'done' : 'active';
    // Hanya SATU badge "Sedang berlangsung" di halaman; sesi foto yang menang.
    else if (sessionRunning) item.state = 'done';
    // Konfirmasi/DP/Foto Siap Dipilih/Pilihan Terkirim/Foto Editmu Siap = centang hijau.
    else if (item.key === 'final_ready' || item.key !== lastKey) item.state = 'done';
    else item.state = ACTIVE_KEYS.has(item.key) ? 'active' : 'done';
  });

  // Judul & keterangan tahap 03 mengikuti waktunya.
  const sessionItem = items.find((i) => i.key === 'session_done');
  if (sessionItem) {
    const copy = sessionCopy(booking, sessionItem.state);
    sessionItem.title = copy.title;
    sessionItem.blurb = copy.blurb;
    sessionItem.chip = copy.chip;
    sessionItem.reminder = Boolean(copy.reminder);
    // Stempel jam tahap sesi HARUS mencerminkan kapan keadaannya berlaku, bukan kapan
    // barisnya tercatat (baris dicatat saat jam sesi tiba). Tanpa ini, klien melihat
    // "Sesimu sudah selesai · 13:11" padahal sesi 90 menit baru berakhir 14:41 —
    // persis kebingungan yang dilaporkan pemilik.
    if (sessionItem.state === 'done' && endAt) {
      sessionItem.atLabel = util.formatDateTimeWIB(endAt.toISOString());
    } else if (sessionItem.state === 'active' && startAt && endAt) {
      sessionItem.atLabel = `${util.formatDateTimeWIB(startAt.toISOString()).replace(/ WIB$/, '')} – ${wibClock(endAt)} WIB`;
    }
  }

  const last = reached.length ? reached[reached.length - 1] : null;

  // Auto-refresh portal: tepat saat sesi mulai (state upcoming → active) dan tepat saat
  // sesi berakhir. Perubahan antrean ditangani polling di client-portal.js.
  let nextSessionAt = null;
  if (isConfirmed && startAt && (!byKey.has('session_done') || staleSessionRow)
      && startAt.getTime() > now.getTime()) {
    nextSessionAt = startAt.getTime();
  } else if (isConfirmed && endAt && byKey.has('session_done') && !staleSessionRow
      && endAt.getTime() > now.getTime()) {
    nextSessionAt = endAt.getTime();
  }

  return {
    items,
    current: last,
    progress: Math.round((reached.length / STAGES.length) * 100),
    reached: reached.length,
    total: STAGES.length,
    nextSessionAt
  };
}

/** Estimasi selesai editing: 10 hari kerja sejak pilihan dikirim (libur admin dilewati). */
function editingDeadline(portal, holidays = []) {
  const base = portal && portal.submitted_at ? String(portal.submitted_at).slice(0, 10) : '';
  if (!base) return null;
  return util.addWorkingDaysISO(base, 10, holidays);
}

/** Daftar hari libur dari settings (`portal_holidays`, satu tanggal per baris). */
function holidaysFromSettings(settings) {
  return util.lines((settings && settings.portal_holidays) || '').filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

module.exports = {
  STAGES,
  STAGE_MAP,
  SESSION_REMINDER,
  sessionStart,
  sessionEnd,
  sessionCopy,
  firstPaymentAt,
  record,
  reach,
  list,
  rowsFor,
  timeOf,
  editingDeadline,
  holidaysFromSettings
};

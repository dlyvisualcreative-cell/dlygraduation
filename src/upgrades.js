'use strict';

/**
 * Upgrade Paket + Extra Time (revisi pemilik).
 *
 * Aturan yang dijaga di BACKEND (bukan hanya tampilan):
 *  - Klien hanya bisa mengajukan UPGRADE: paket tujuan HARUS lebih mahal dari paket
 *    booking saat ini. Turun harga (downgrade) ditolak server.
 *  - Revisi 4: pengajuan UPGRADE DURASI untuk paket yang sama (mis. 60 → 90 / 120 menit)
 *    ditampilkan seperti kartu pricelist. Hanya durasi LEBIH PANJANG & LEBIH MAHAL yang
 *    ditawarkan; turun durasi (downgrade) ditolak server.
 *  - Extra Time (30 / 60 menit) terbuka sejak SESI FOTO DIMULAI (bukan setelah selesai).
 *    Sebelum jam sesi tiba endpoint menolak walau tombolnya dipaksa lewat curl.
 *  - Pengajuan TIDAK mengubah nominal booking. Harga baru hanya berlaku setelah ADMIN
 *    menyetujui (satu baris `booking_upgrades`), sehingga tidak ada tagihan yang
 *    berubah diam-diam. Snapshot harga lama tetap tersimpan di riwayat pembayaran.
 *  - Harga Extra Time diatur admin kapan saja (`extra_time_30_price` /
 *    `extra_time_60_price`); harga kosong = belum tersedia, tombol pengajuan dinonaktifkan.
 */

const { db, getSettings } = require('./db');
const util = require('./util');
const payments = require('./payments');
const timeline = require('./timeline');

const EXTRA_MINUTES = [30, 60];
const EXTRA_SETTING = { 30: 'extra_time_30_price', 60: 'extra_time_60_price' };

/* ------------------------------------------------------------------ */
/* Data paket                                                          */
/* ------------------------------------------------------------------ */
/** Harga paket = harga durasi aktif termurah (sama seperti "mulai dari" di pricelist). */
function packagePrice(packageId) {
  const row = db.prepare(`SELECT MIN(price) AS price FROM package_durations
                          WHERE package_id = ? AND is_active = 1 AND price IS NOT NULL
                            AND price > 0`).get(Number(packageId));
  return row && row.price ? Number(row.price) : 0;
}

const packageWithMeta = (id) => {
  const row = db.prepare(`SELECT p.*, c.name AS city_name, k.name AS category_name
                          FROM packages p
                          LEFT JOIN cities c ON c.id = p.city_id
                          LEFT JOIN package_categories k ON k.id = p.category_id
                          WHERE p.id = ? AND p.is_active = 1`).get(Number(id));
  if (!row) return null;
  const durations = db.prepare(`SELECT duration_minutes, price, edited_photos FROM package_durations
                                WHERE package_id = ? AND is_active = 1 AND price IS NOT NULL AND price > 0
                                ORDER BY duration_minutes`).all(row.id);
  const gallery = db.prepare(`SELECT image FROM package_images WHERE package_id = ?
                              ORDER BY is_primary DESC, sort_order, id LIMIT 4`).all(row.id)
    .map((g) => g.image).filter(Boolean);
  return {
    ...row,
    price_from: durations.length ? Math.min(...durations.map((d) => Number(d.price))) : 0,
    durations,
    gallery,
    cover: row.image || gallery[0] || ''
  };
};

/** Paket yang boleh dipakai untuk upgrade: aktif, kota sama, dan LEBIH MAHAL. */
function upgradeCandidates(booking) {
  if (!booking) return { current: null, items: [] };
  const current = packageWithMeta(booking.package_id);
  const currentPrice = Number(booking.package_price_snapshot || booking.price || 0)
    || (current ? current.price_from : 0);
  const rows = db.prepare(`SELECT p.id FROM packages p
                           WHERE p.is_active = 1 AND p.id <> ?
                             AND (? IS NULL OR p.city_id = ?)
                           ORDER BY p.sort_order, p.id`)
    .all(Number(booking.package_id) || 0, booking.city_id || null, booking.city_id || null)
    .map((r) => packageWithMeta(r.id))
    .filter(Boolean)
    .map((p) => ({ ...p, diff: p.price_from - currentPrice }))
    // Hanya yang benar-benar LEBIH MAHAL (downgrade tidak pernah ditawarkan).
    .filter((p) => p.price_from > 0 && p.diff > 0);
  return { current, currentPrice, items: rows };
}

/**
 * Kartu paket GAYA PRICELIST untuk halaman Upgrade di portal klien.
 * Satu sumber data untuk: paket sekarang + semua paket lain di kota yang sama.
 *
 * Setiap paket membawa `state`:
 *   'current' → paket yang sedang dipakai booking
 *   'upgrade' → boleh diajukan (harga lebih tinggi / durasi lebih panjang)
 *   'locked'  → downgrade: tetap DITAMPILKAN tapi dikunci (permintaan pemilik)
 * Setiap durasi membawa `durationState` dengan aturan yang sama.
 */
function packageCards(booking) {
  if (!booking) return { current: null, items: [] };
  const currentMinutes = Number(booking.duration_minutes || booking.duration || 0);
  const currentPrice = Number(booking.package_price_snapshot || booking.price || 0);

  const rows = db.prepare(`SELECT p.id FROM packages p
                           WHERE p.is_active = 1 AND (? IS NULL OR p.city_id = ?)
                           ORDER BY p.sort_order, p.id`)
    .all(booking.city_id || null, booking.city_id || null);

  const items = rows.map((r) => {
    const meta = packageWithMeta(r.id);
    if (!meta) return null;
    // Kolom `description` (bukan `note`) yang ada di package_durations.
    const durations = db.prepare(`SELECT duration_minutes, price, edited_photos, description
                                  FROM package_durations
                                  WHERE package_id = ? AND is_active = 1 AND price IS NOT NULL AND price > 0
                                  ORDER BY duration_minutes`).all(meta.id)
      .map((d) => {
        const minutes = Number(d.duration_minutes);
        const price = Number(d.price);
        const isCurrentPkg = Number(meta.id) === Number(booking.package_id);
        let durationState = 'upgrade';
        if (isCurrentPkg && minutes === currentMinutes) durationState = 'current';
        // Downgrade = durasi lebih pendek, atau harga tidak lebih tinggi dari paket sekarang.
        else if (isCurrentPkg && minutes < currentMinutes) durationState = 'locked';
        else if (isCurrentPkg && minutes > currentMinutes && price <= currentPrice) durationState = 'locked';
        return {
          minutes,
          price,
          edited_photos: Number(d.edited_photos) || 0,
          note: d.description || '',
          durationState,
          diff: price - currentPrice
        };
      });
    const priceFrom = durations.length ? Math.min(...durations.map((d) => d.price)) : 0;
    const isCurrent = Number(meta.id) === Number(booking.package_id);
    const diff = priceFrom - currentPrice;
    // Paket lain hanya boleh NAIK (harga lebih tinggi). Paket lebih murah = dikunci.
    const state = isCurrent ? 'current' : (priceFrom > currentPrice ? 'upgrade' : 'locked');
    const gallery = (meta.gallery || []).filter((src) => src && src !== meta.cover);
    return {
      ...meta,
      price_from: priceFrom,
      diff,
      is_current: isCurrent,
      state,
      lockReason: state === 'locked'
        ? 'Paket ini lebih murah dari paket kamu sekarang — downgrade tidak tersedia.'
        : '',
      photos: meta.cover ? [meta.cover].concat(gallery) : [],
      benefits: util.benefitsForPackage(meta.id).map((b) => ({ text: b.text, icon: b.icon })),
      durations
    };
  }).filter(Boolean);

  // Paket sekarang selalu paling atas, lalu paket upgrade termurah.
  items.sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    if (a.state !== b.state) return a.state === 'upgrade' ? -1 : 1;
    return (a.price_from || 0) - (b.price_from || 0) || a.id - b.id;
  });

  return { current: items.find((i) => i.is_current) || null, items };
}

/**
 * Kandidat UPGRADE DURASI dalam paket yang sama (permintaan pemilik: "pesan 60 menit,
 * mau naik ke 90 atau 120 menit"). Hanya durasi yang LEBIH PANJANG dan LEBIH MAHAL.
 * @returns {{current:{minutes:number,price:number}|null, items:Array}}
 */
function durationCandidates(booking) {
  if (!booking) return { current: null, items: [] };
  const currentMinutes = Number(booking.duration_minutes || booking.duration || 0);
  const currentPrice = Number(booking.package_price_snapshot || booking.price || 0);
  const rows = db.prepare(`SELECT * FROM package_durations
                           WHERE package_id = ? AND is_active = 1 AND price IS NOT NULL AND price > 0
                           ORDER BY duration_minutes`).all(Number(booking.package_id) || 0);
  const current = rows.find((r) => Number(r.duration_minutes) === currentMinutes) || null;
  const basePrice = currentPrice || (current ? Number(current.price) : 0);
  const items = rows
    .filter((r) => Number(r.duration_minutes) > currentMinutes)
    .map((r) => ({
      minutes: Number(r.duration_minutes),
      price: Number(r.price),
      edited_photos: Number(r.edited_photos) || 0,
      note: r.note || '',
      diff: Number(r.price) - basePrice
    }))
    // Durasi lebih panjang tetapi harga tidak lebih mahal bukan "upgrade".
    .filter((r) => r.price > 0 && r.diff > 0);
  return { current, currentPrice: basePrice, items };
}

/* ------------------------------------------------------------------ */
/* Add-on tambahan (permintaan pemilik)                                */
/* ------------------------------------------------------------------ */
/**
 * Add-on yang relevan untuk kategori paket booking ini.
 * Add-on tanpa harga tetap ditampilkan sebagai "belum diatur" tapi TIDAK bisa diajukan
 * (tidak pernah mengarang nominal).
 */
function addonOptions(booking) {
  if (!booking) return [];
  const list = util.addonsForCategory(booking.category_id);
  let approved = [];
  try { approved = JSON.parse(booking.addons_snapshot || '[]'); } catch (err) { approved = []; }
  const approvedIds = new Set((Array.isArray(approved) ? approved : []).map((a) => Number(a.id)));
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description || '',
    price: a.price,
    available: Boolean(a.price),
    owned: approvedIds.has(Number(a.id))
  }));
}

/** Ajukan add-on: hanya untuk add-on berharga & belum dimiliki booking. */
function requestAddon(booking, addonId, { note = '' } = {}) {
  if (!booking) return { ok: false, message: 'Booking tidak ditemukan.' };
  const access = accessState(booking);
  if (!access.ok) return { ok: false, locked: true, message: access.reason };
  const option = addonOptions(booking).find((a) => Number(a.id) === Number(addonId));
  if (!option) return { ok: false, message: 'Add-on itu tidak tersedia untuk paket kamu.' };
  if (option.owned) return { ok: false, message: 'Add-on ini sudah ada di paket kamu.' };
  if (!option.available) return { ok: false, message: 'Harga add-on ini belum diatur admin.' };
  const existing = pendingFor(booking.id, 'addon');
  if (existing && Number(existing.package_id) === Number(option.id)) {
    return { ok: true, created: false, request: existing };
  }
  // `package_id` dipakai ulang untuk menyimpan id add-on (kolom sudah ada; tanpa migrasi).
  const info = db.prepare(`INSERT INTO booking_upgrades
      (booking_id, kind, package_id, package_name, minutes, price, note, status, created_at)
      VALUES (?, 'addon', ?, ?, 0, ?, ?, 'pending', datetime('now'))`)
    .run(booking.id, option.id, option.name, option.price, String(note || '').slice(0, 300));
  const row = rowById(Number(info.lastInsertRowid));
  payments.logEvent(booking.id, {
    kind: 'upgrade',
    actor: 'klien',
    note: `Klien mengajukan add-on "${option.name}" (${util.rupiah(option.price) || '-'})`
  });
  return { ok: true, created: true, request: row };
}

/**
 * Ringkas "Paket kamu sekarang" untuk halaman upgrade:
 *   { packageName, head, parts: ['60 Menit Rp375.000 Bandung', 'Extra Time 30 Menit Rp175.000',
 *                                'Add-on Fish Eye Rp100.000'], extras, addons, hasExtras }
 * Extra Time & add-on diambil dari pengajuan yang SUDAH DISETUJUI admin (bukan pending),
 * dan langsung ikut berubah setelah upgrade disetujui (permintaan pemilik).
 */
function currentSummary(booking) {
  if (!booking) return { packageName: '', head: '', parts: [], extras: [], addons: [], hasExtras: false };
  const pkg = packageWithMeta(booking.package_id);
  const approved = db.prepare(`SELECT * FROM booking_upgrades
                               WHERE booking_id = ? AND status = 'approved'
                               ORDER BY id`).all(booking.id);
  const cityRow = db.prepare('SELECT name FROM cities WHERE id = ?').get(booking.city_id);
  const minutes = Number(booking.duration_minutes || booking.duration || 0);
  const price = Number(booking.package_price_snapshot || booking.price || 0);
  const extras = approved.filter((r) => r.kind === 'extra')
    .map((r) => ({ minutes: Number(r.minutes), price: Number(r.price), label: `Extra Time ${r.minutes} Menit` }));
  const addons = [];
  let snapshot = [];
  try { snapshot = JSON.parse(booking.addons_snapshot || '[]'); } catch (err) { snapshot = []; }
  (Array.isArray(snapshot) ? snapshot : []).forEach((a) => {
    addons.push({ name: a.name, price: Number(a.price) || 0, label: `Add-on ${a.name}` });
  });

  const headParts = [];
  if (minutes) headParts.push(`${minutes} Menit`);
  if (price) headParts.push(util.rupiah(price));
  if (cityRow && cityRow.name) headParts.push(cityRow.name);
  const parts = [headParts.join(' ')].filter(Boolean)
    .concat(extras.map((e) => `${e.label} ${e.price ? util.rupiah(e.price) : ''}`.trim()))
    .concat(addons.map((a) => `${a.label} ${a.price ? util.rupiah(a.price) : ''}`.trim()));

  return {
    packageName: pkg ? pkg.name : (booking.package_name || 'Paket booking'),
    head: headParts.join(' '),
    parts,
    extras,
    addons,
    hasExtras: extras.length + addons.length > 0
  };
}

/* ------------------------------------------------------------------ */
/* Extra time                                                          */
/* ------------------------------------------------------------------ */
function extraOptions() {
  const s = getSettings();
  return EXTRA_MINUTES.map((minutes) => {
    const price = Number(s[EXTRA_SETTING[minutes]] || 0);
    return {
      minutes,
      price: Number.isFinite(price) && price > 0 ? price : 0,
      available: Number.isFinite(price) && price > 0
    };
  });
}

/* ------------------------------------------------------------------ */
/* Pengajuan                                                           */
/* ------------------------------------------------------------------ */
const STATUS = {
  pending: { value: 'pending', label: 'Menunggu konfirmasi admin', tone: 'warn' },
  approved: { value: 'approved', label: 'Disetujui', tone: 'ok' },
  rejected: { value: 'rejected', label: 'Ditolak', tone: 'muted' }
};
const statusMeta = (v) => STATUS[v] || STATUS.pending;

const requestsFor = (bookingId) => db.prepare(`SELECT * FROM booking_upgrades
  WHERE booking_id = ? ORDER BY id DESC`).all(Number(bookingId));

const pendingFor = (bookingId, kind) => db.prepare(`SELECT * FROM booking_upgrades
  WHERE booking_id = ? AND kind = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`)
  .get(Number(bookingId), String(kind)) || null;

const rowById = (id) => db.prepare('SELECT * FROM booking_upgrades WHERE id = ?').get(Number(id)) || null;

/**
 * Kunci UPGRADE saat sudah masuk H-7 (permintaan pemilik: "sama kaya reschedule")
 * DAN saat SESI FOTO SUDAH SELESAI (permintaan pemilik: "block otomatis kalau sudah
 * selesai sesi fotonya, kecuali extra time").
 *
 *  - H-7 memakai pintu override yang SAMA (`bookings.reschedule_override`) supaya admin
 *    cukup membuka satu saklar untuk reschedule + upgrade.
 *  - Sesi selesai TIDAK bisa dibuka lewat override: fakta sesi sudah lewat, bukan soal
 *    tenggat. Admin tetap bisa mengubah booking langsung dari dashboard bila perlu.
 *  - Extra Time dikecualikan sepenuhnya: aturannya sendiri (hanya saat sesi sudah dimulai),
 *    jadi `requestExtra()` sengaja TIDAK memanggil accessState().
 */
const HOLD_DAYS = 7;
function accessState(booking) {
  const override = Number((booking && booking.reschedule_override) || 0) === 1;
  const date = String((booking && booking.shooting_date) || '').slice(0, 10);
  let daysLeft = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const a = Date.parse(`${util.todayISO()}T00:00:00Z`);
    const b = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(a) && Number.isFinite(b)) daysLeft = Math.round((b - a) / 86400000);
  }
  // Sesi dianggap selesai bila jam akhir sesi (mulai + durasi) sudah terlewati.
  // Memakai sumber waktu yang sama dengan tahap 03 di portal (timeline.sessionEnd).
  const endsAt = timeline.sessionEnd(booking);
  const sessionOver = Boolean(endsAt) && Date.now() >= endsAt.getTime();
  const holdLocked = !override && daysLeft !== null && daysLeft <= HOLD_DAYS;
  const locked = sessionOver || holdLocked;
  return {
    ok: !locked,
    locked,
    override,
    sessionOver,
    holdLocked,
    sessionEndAt: endsAt ? endsAt.toISOString() : '',
    daysLeft,
    holdDays: HOLD_DAYS,
    reason: sessionOver
      ? 'Upgrade paket, durasi, dan add-on sudah ditutup karena sesi foto kamu sudah selesai. '
        + 'Extra Time tetap bisa diajukan selama sesi berlangsung.'
      : holdLocked
        ? (daysLeft < 0
          ? 'Upgrade paket sudah ditutup karena jadwal sesi foto sudah lewat. Silakan hubungi admin.'
          : `Upgrade paket & durasi ditutup karena sesi foto tinggal ${Math.max(daysLeft, 0)} hari lagi `
            + `(batas pengajuan H-${HOLD_DAYS}). Silakan konfirmasi langsung ke admin.`)
        : ''
  };
}

/**
 * Ajukan upgrade paket. Ditolak bila paket tujuan tidak lebih mahal.
 * @returns {{ok:boolean, message?:string, request?:object}}
 */
function requestPackage(booking, packageId, { note = '' } = {}) {
  if (!booking) return { ok: false, message: 'Booking tidak ditemukan.' };
  const access = accessState(booking);
  if (!access.ok) return { ok: false, locked: true, message: access.reason };
  const target = packageWithMeta(packageId);
  if (!target) return { ok: false, message: 'Paket tidak tersedia atau sudah tidak aktif.' };
  if (Number(target.id) === Number(booking.package_id)) {
    return { ok: false, message: 'Paket ini sudah paket yang kamu gunakan.' };
  }
  const { currentPrice } = upgradeCandidates(booking);
  if (!(target.price_from > currentPrice)) {
    return {
      ok: false,
      message: 'Hanya upgrade ke paket yang lebih mahal. Paket ini tidak bisa dipilih.'
    };
  }
  const existing = pendingFor(booking.id, 'package');
  if (existing && Number(existing.package_id) === Number(target.id)) {
    return { ok: true, created: false, request: existing };
  }
  const info = db.prepare(`INSERT INTO booking_upgrades
      (booking_id, kind, package_id, package_name, minutes, price, note, status, created_at)
      VALUES (?, 'package', ?, ?, 0, ?, ?, 'pending', datetime('now'))`)
    .run(booking.id, target.id, target.name, target.price_from, String(note || '').slice(0, 300));
  const row = rowById(Number(info.lastInsertRowid));
  payments.logEvent(booking.id, {
    kind: 'upgrade',
    actor: 'klien',
    note: `Klien mengajukan upgrade paket ke "${target.name}" (${util.rupiah(target.price_from) || '-'})`
  });
  return { ok: true, created: true, request: row };
}

/**
 * Ajukan upgrade DURASI pada paket yang sama (60 → 90 / 120 menit).
 * Server menolak durasi yang lebih pendek / tidak lebih mahal.
 */
function requestDuration(booking, minutes, { note = '' } = {}) {
  if (!booking) return { ok: false, message: 'Booking tidak ditemukan.' };
  const access = accessState(booking);
  if (!access.ok) return { ok: false, locked: true, message: access.reason };
  const wanted = Number(minutes);
  const candidates = durationCandidates(booking);
  const target = candidates.items.find((d) => d.minutes === wanted);
  if (!target) {
    return { ok: false, message: 'Durasi itu bukan upgrade dari paket kamu (hanya durasi lebih panjang yang tersedia).' };
  }
  const existing = pendingFor(booking.id, 'duration');
  if (existing && Number(existing.minutes) === wanted) {
    return { ok: true, created: false, request: existing };
  }
  const pkg = packageWithMeta(booking.package_id);
  const info = db.prepare(`INSERT INTO booking_upgrades
      (booking_id, kind, package_id, package_name, minutes, price, note, status, created_at)
      VALUES (?, 'duration', ?, ?, ?, ?, ?, 'pending', datetime('now'))`)
    .run(booking.id, booking.package_id, pkg ? pkg.name : '',
      wanted, target.price, String(note || '').slice(0, 300));
  const row = rowById(Number(info.lastInsertRowid));
  payments.logEvent(booking.id, {
    kind: 'upgrade',
    actor: 'klien',
    note: `Klien mengajukan upgrade durasi ${wanted} menit (${util.rupiah(target.price) || '-'})`
  });
  return { ok: true, created: true, request: row };
}

/**
 * Ajukan Extra Time. Terbuka sejak SESI FOTO DIMULAI (`sessionStarted` dihitung route
 * dari timeline, bukan dari jam perangkat klien). Revisi 4 mengganti syarat lama
 * "setelah sesi selesai" → "saat sesi dimulai".
 */
function requestExtra(booking, minutes, { sessionStarted = false, sessionDone = false, note = '' } = {}) {
  if (!booking) return { ok: false, message: 'Booking tidak ditemukan.' };
  const started = Boolean(sessionStarted || sessionDone);
  const wanted = Number(minutes);
  if (!EXTRA_MINUTES.includes(wanted)) return { ok: false, message: 'Pilihan extra time tidak valid.' };
  if (!started) {
    return {
      ok: false,
      locked: true,
      message: 'Extra Time baru bisa diajukan saat sesi foto kamu dimulai.'
    };
  }
  const option = extraOptions().find((o) => o.minutes === wanted);
  if (!option || !option.available) {
    return { ok: false, message: 'Harga Extra Time belum diatur admin. Silakan hubungi admin.' };
  }
  const existing = pendingFor(booking.id, 'extra');
  if (existing && Number(existing.minutes) === wanted) {
    return { ok: true, created: false, request: existing };
  }
  const info = db.prepare(`INSERT INTO booking_upgrades
      (booking_id, kind, package_id, package_name, minutes, price, note, status, created_at)
      VALUES (?, 'extra', NULL, '', ?, ?, ?, 'pending', datetime('now'))`)
    .run(booking.id, wanted, option.price, String(note || '').slice(0, 300));
  const row = rowById(Number(info.lastInsertRowid));
  payments.logEvent(booking.id, {
    kind: 'upgrade',
    actor: 'klien',
    note: `Klien mengajukan Extra Time ${wanted} menit (${util.rupiah(option.price) || '-'})`
  });
  return { ok: true, created: true, request: row };
}

/* ------------------------------------------------------------------ */
/* Keputusan admin                                                     */
/* ------------------------------------------------------------------ */
function addonsTotal(booking) {
  try {
    const list = JSON.parse((booking && booking.addons_snapshot) || '[]');
    return Array.isArray(list) ? list.reduce((n, a) => n + (Number(a.price) || 0), 0) : 0;
  } catch (err) { return 0; }
}

/**
 * Setujui pengajuan → perubahan diterapkan ke booking dalam SATU transaksi.
 * Snapshot harga lama tidak dihapus: riwayat pembayaran tetap utuh, dan event log
 * mencatat nilai sebelum → sesudah.
 */
function approve(id, { actor = 'admin' } = {}) {
  const row = rowById(id);
  if (!row) return { ok: false, message: 'Pengajuan tidak ditemukan.' };
  if (row.status !== 'pending') return { ok: false, message: 'Pengajuan ini sudah diproses.' };
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.booking_id);
  if (!booking) return { ok: false, message: 'Booking tidak ditemukan.' };

  const before = {
    package_id: booking.package_id,
    duration_minutes: booking.duration_minutes,
    total: Number(booking.total_price_snapshot || booking.price || 0)
  };
  const addons = addonsTotal(booking);

  db.transaction(() => {
    if (row.kind === 'package') {
      const target = packageWithMeta(row.package_id);
      if (!target) throw Object.assign(new Error('Paket tujuan sudah tidak aktif.'), { code: 'no-package' });
      const basePrice = Number(row.price) || target.price_from;
      db.prepare(`UPDATE bookings SET package_id = ?, category_id = ?, price = ?,
                  package_price_snapshot = ?, total_price_snapshot = ?,
                  edited_photos_snapshot = COALESCE(?, edited_photos_snapshot),
                  updated_at = datetime('now') WHERE id = ?`)
        .run(target.id, target.category_id, basePrice, basePrice, basePrice + addons,
          (target.durations[0] && target.durations[0].edited_photos) || null, booking.id);
    } else if (row.kind === 'duration') {
      // Upgrade durasi paket yang sama: durasi DIGANTI (bukan ditambah) + harga durasi itu.
      const duration = db.prepare(`SELECT * FROM package_durations
                                   WHERE package_id = ? AND duration_minutes = ? AND is_active = 1`)
        .get(booking.package_id, Number(row.minutes));
      const basePrice = Number(row.price) || (duration ? Number(duration.price) : 0);
      db.prepare(`UPDATE bookings SET duration_minutes = ?, duration = ?,
                  package_price_snapshot = ?, total_price_snapshot = ?, price = ?,
                  edited_photos_snapshot = COALESCE(?, edited_photos_snapshot),
                  updated_at = datetime('now') WHERE id = ?`)
        .run(Number(row.minutes), Number(row.minutes), basePrice, basePrice + addons, basePrice,
          (duration && duration.edited_photos) || null, booking.id);
    } else if (row.kind === 'addon') {
      // Add-on disetujui: tambahkan ke snapshot add-on booking + total harga.
      let list = [];
      try { list = JSON.parse(booking.addons_snapshot || '[]'); } catch (err) { list = []; }
      list = Array.isArray(list) ? list : [];
      if (!list.some((a) => Number(a.id) === Number(row.package_id))) {
        list.push({ id: Number(row.package_id), name: row.package_name, price: Number(row.price) || 0 });
      }
      const currentTotal = Number(booking.total_price_snapshot || booking.price || 0);
      db.prepare(`UPDATE bookings SET addons_snapshot = ?, total_price_snapshot = ?,
                  updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(list), currentTotal + (Number(row.price) || 0), booking.id);
    } else {
      const extra = Number(row.minutes) || 0;
      const price = Number(row.price) || 0;
      const currentTotal = Number(booking.total_price_snapshot || booking.price || 0);
      db.prepare(`UPDATE bookings SET duration_minutes = COALESCE(duration_minutes, 0) + ?,
                  duration = COALESCE(duration, 0) + ?, total_price_snapshot = ?,
                  updated_at = datetime('now') WHERE id = ?`)
        .run(extra, extra, currentTotal + price, booking.id);
    }
    db.prepare(`UPDATE booking_upgrades SET status = 'approved', decided_at = datetime('now'),
                decided_by = ? WHERE id = ?`).run(String(actor).slice(0, 60), row.id);
  })();

  const after = db.prepare('SELECT package_id, duration_minutes, total_price_snapshot FROM bookings WHERE id = ?').get(booking.id);
  payments.logEvent(booking.id, {
    kind: 'upgrade',
    actor,
    note: row.kind === 'package'
      ? `Upgrade paket disetujui → "${row.package_name}". Total ${util.rupiah(before.total) || '-'} → ${util.rupiah(after.total_price_snapshot) || '-'}.`
      : row.kind === 'duration'
        ? `Upgrade durasi ${row.minutes} menit disetujui. Total ${util.rupiah(before.total) || '-'} → ${util.rupiah(after.total_price_snapshot) || '-'}.`
        : row.kind === 'addon'
          ? `Add-on "${row.package_name}" disetujui. Total ${util.rupiah(before.total) || '-'} → ${util.rupiah(after.total_price_snapshot) || '-'}.`
          : `Extra Time ${row.minutes} menit disetujui. Durasi ${before.duration_minutes} → ${after.duration_minutes} menit, total ${util.rupiah(before.total) || '-'} → ${util.rupiah(after.total_price_snapshot) || '-'}.`
  });
  return { ok: true, request: rowById(row.id) };
}

function reject(id, { actor = 'admin', reason = '' } = {}) {
  const row = rowById(id);
  if (!row) return { ok: false, message: 'Pengajuan tidak ditemukan.' };
  if (row.status !== 'pending') return { ok: false, message: 'Pengajuan ini sudah diproses.' };
  db.prepare(`UPDATE booking_upgrades SET status = 'rejected', decided_at = datetime('now'),
              decided_by = ?, note = ? WHERE id = ?`)
    .run(String(actor).slice(0, 60), String(reason || row.note || '').slice(0, 300), row.id);
  payments.logEvent(row.booking_id, {
    kind: 'upgrade',
    actor,
    note: `Pengajuan ${row.kind === 'package' ? `upgrade paket "${row.package_name}"` : `Extra Time ${row.minutes} menit`} ditolak${reason ? `: ${reason}` : ''}`
  });
  return { ok: true };
}

/** Semua pengajuan (untuk halaman admin), lengkap dengan data booking. */
function list({ status = '' } = {}) {
  const where = status && STATUS[status] ? 'WHERE u.status = :status' : '';
  return db.prepare(`SELECT u.*, b.code, b.client_name, b.shooting_date, b.status AS booking_status
                     FROM booking_upgrades u JOIN bookings b ON b.id = u.booking_id
                     ${where}
                     ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.id DESC
                     LIMIT 200`).all(status && STATUS[status] ? { status } : {});
}

const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM booking_upgrades WHERE status = 'pending'").get().n;

module.exports = {
  EXTRA_MINUTES,
  // Dipakai halaman admin untuk label status.
  STATUS,
  statusMeta,
  HOLD_DAYS,
  packagePrice,
  packageWithMeta,
  upgradeCandidates,
  packageCards,
  accessState,
  durationCandidates,
  addonOptions,
  currentSummary,
  extraOptions,
  requestsFor,
  pendingFor,
  rowById,
  requestPackage,
  requestDuration,
  requestAddon,
  requestExtra,
  approve,
  reject,
  list,
  pendingCount
};

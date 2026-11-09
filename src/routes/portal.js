'use strict';

/**
 * Client Portal — akses klien dengan Kode Booking + PIN (tanpa akun).
 *
 * Rute:
 *   GET  /portal                → form masuk (kalau sudah login → /portal/ringkasan)
 *   POST /portal/masuk          → validasi backend (rate limited)
 *   POST /portal/keluar         → hapus sesi
 *   GET  /portal/ringkasan      → identitas client + status terbaru
 *   GET  /portal/pilih-foto     → galeri pemilihan (mesin seleksi yang sama)
 *   GET  /portal/pantau-order   → timeline 8 tahap (hanya yang tercapai)
 *   GET  /portal/drive          → link Google Drive hasil final
 *
 * Keamanan: setiap halaman di belakang `requirePortal`; semua data diambil dari
 * booking milik SESI, bukan dari parameter URL — jadi tidak ada cara membuka booking lain.
 */

const express = require('express');
const crypto = require('crypto');
const { db, getSettings } = require('../db');
const util = require('../util');
const portal = require('../portal');
const timeline = require('../timeline');
const selection = require('../selection');
const portalview = require('../portalview');
const push = require('../push');
const upgrades = require('../upgrades');
const reschedule = require('../reschedule');
const payments = require('../payments');

const router = express.Router();

/* Ikon sidebar (inline SVG, tanpa dependensi). */
const ICONS = {
  ringkasan: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13h6V4H4v9zm10 7h6v-9h-6v9zM4 20h6v-5H4v5zM14 9h6V4h-6v5z"/></svg>',
  foto: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="9" cy="9.5" r="1.6"/></svg>',
  timeline: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l4 2"/></svg>',
  drive: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3l6 0 6 10.5-3 5.5H6L3 13.5zM9 3L3 13.5M15 3l6 10.5"/></svg>',
  upgrade: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/><path d="M4 21h16"/></svg>',
  reschedule: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4M9 15.5h6M12 12.5v6"/></svg>'
};

/* ------------------------------------------------------------------ */
/* Data bersama untuk layout                                          */
/* ------------------------------------------------------------------ */
/**
 * Menu sidebar. "Pilih Foto Favorit" nonaktif sampai admin menyiapkan portal sortir,
 * dan "Link Google Drive" nonaktif sampai admin menyelesaikan order — sesuai blueprint.
 */
function menusFor(booking) {
  const sel = selection.portalForBooking(booking.id);
  const hasPhotos = Boolean(sel && selection.photosFor(sel.id).length);
  const finalReady = Boolean(booking.final_url);
  const rs = reschedule.accessState(booking);
  return [
    { key: 'ringkasan', label: 'Ringkasan', path: '/ringkasan', icon: ICONS.ringkasan },
    {
      key: 'foto',
      label: 'Pilih Foto Favorit',
      path: '/pilih-foto',
      icon: ICONS.foto,
      disabled: !hasPhotos,
      hint: 'Admin belum menyiapkan foto untuk dipilih.',
      badge: hasPhotos && sel && !sel.submitted_at ? 'Aktif' : ''
    },
    { key: 'timeline', label: 'Pantau Order', path: '/pantau-order', icon: ICONS.timeline },
    {
      // Revisi 4 — pengajuan reschedule (tanggal, jam, lokasi) yang harus disetujui admin.
      // Terbuka sampai H-7; setelah itu terkunci dan klien harus menghubungi admin
      // (admin bisa membukanya lagi dari dashboard).
      key: 'reschedule',
      label: 'Reschedule',
      path: '/reschedule',
      icon: ICONS.reschedule,
      badge: rs.pending ? 'Diajukan' : (rs.locked ? 'Terkunci' : '')
    },
    {
      // Revisi: naikkan paket / tambah waktu dari portal (hanya UPGRADE, bukan turun).
      // Revisi 6 — otomatis terkunci setelah sesi foto selesai (Extra Time tetap terbuka),
      // jadi badge-nya mengikuti status yang sama dengan halaman upgrade.
      key: 'upgrade',
      label: 'Upgrade Paket',
      path: '/upgrade',
      icon: ICONS.upgrade,
      badge: upgrades.accessState(booking).locked ? 'Terkunci' : ''
    },
    {
      key: 'drive',
      // Revisi 2 (06): label sidebar "Link Google Drive" → "Orderanmu Siap".
      // Fungsi halaman tetap sama (hasil akhir + tautan Google Drive).
      label: 'Orderanmu Siap',
      path: '/drive',
      icon: ICONS.drive,
      disabled: !finalReady,
      hint: 'Foto final belum tersedia.'
    }
  ];
}

const csrfFor = (req) => (req.portalSession ? req.portalSession.id : '');

function locals(req, res, { active, title, needsSelection = false, extra = {} }) {
  const booking = req.portalBooking;
  const settings = getSettings();
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
  Object.assign(res.locals, {
    portalClient: {
      name: booking.client_name || 'Client',
      code: booking.code || '',
      campus: booking.campus || '',
      bookingId: booking.id
    },
    cpMenus: menusFor(booking),
    cpActive: active,
    cpCsrf: csrfFor(req),
    cpNeedsSelection: needsSelection,
    // Kunci publik VAPID untuk pendaftaran notifikasi client (aman: hanya kunci publik).
    cpPushKey: push.publicKey(),
    ...extra
  });
  return { layout: 'layout-client', title, pageTitle: title };
}

/* ------------------------------------------------------------------ */
/* Masuk / keluar                                                     */
/* ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  if (portal.getSession(req)) return res.redirect(`${req.basePath}/portal/ringkasan`);

  const settings = getSettings();
  // Masa akses habis (requirePortal / login) → tampilkan penjelasan, bukan pesan generik.
  const expiredNotice = String(req.query.expired || '') === '1'
    ? `Masa akses portal sudah berakhir. Kode booking hanya berlaku ${portal.PENDING_ACCESS_HOURS} jam selama booking belum dikonfirmasi admin.`
    : '';
  res.set('Cache-Control', 'no-store');
  res.render('portal/login', {
    layout: 'layout-portal',
    title: 'Masuk Portal',
    pageTitle: 'Masuk Portal',
    bodyClass: 'page-portal-login',
    portalBrandName: (settings.selection_brand_name || '').trim() || res.locals.brand.name,
    next: typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '',
    extraCss: `client-portal.css?v=${res.locals.assetVersion.portal}`,
    error: expiredNotice,
    code: '',
    attemptLimit: portal.MAX_ATTEMPTS,
    attemptWindow: portal.WINDOW_MINUTES,
    pendingAccessHours: portal.PENDING_ACCESS_HOURS
  });
});

router.post('/masuk', (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '');
  const pin = String(b.pin || '').replace(/\D/g, '');
  const next = typeof b.next === 'string' && b.next.startsWith('/') ? b.next : '';
  const settings = getSettings();
  const render = (error, extra = {}) => {
    res.status(422);
    res.set('Cache-Control', 'no-store');
    return res.render('portal/login', {
      layout: 'layout-portal',
      title: 'Masuk Portal',
      pageTitle: 'Masuk Portal',
      bodyClass: 'page-portal-login',
      portalBrandName: (settings.selection_brand_name || '').trim() || res.locals.brand.name,
      next,
      extraCss: `client-portal.css?v=${res.locals.assetVersion.portal}`,
      error,
      code,
      attemptLimit: portal.MAX_ATTEMPTS,
      attemptWindow: portal.WINDOW_MINUTES,
      pendingAccessHours: portal.PENDING_ACCESS_HOURS,
      ...extra
    });
  };

  const ip = req.ip || 'unknown';
  if (portal.tooManyAttempts(ip)) {
    return render(`Terlalu banyak percobaan. Coba lagi dalam ${portal.WINDOW_MINUTES} menit.`);
  }
  if (!/^[A-Za-z0-9-]{4,40}$/.test(portal.normalizeCode(code))) {
    portal.recordAttempt(ip, code, false);
    return render('Format kode booking tidak dikenali. Contoh: DLY-WISUDA-ANJAS001');
  }
  if (!/^\d{4}$/.test(pin)) {
    portal.recordAttempt(ip, code, false);
    return render('PIN harus 4 angka.', { code });
  }

  const booking = portal.findBooking(code);
  if (!booking) {
    portal.recordAttempt(ip, code, false);
    return render('Kode booking tidak ditemukan. Silakan cocokkan dengan pesan WhatsApp dari admin.');
  }
  // Booking yang dibatalkan tidak membuka portal.
  if (booking.status === 'cancelled') {
    portal.recordAttempt(ip, code, false);
    return render('Booking ini sudah dibatalkan. Hubungi admin bila perlu bantuan.');
  }
  // Booking yang belum dikonfirmasi: kode + PIN hanya berlaku 24 jam sejak booking
  // dikirim (revisi pemilik). Setelah itu akses ditutup otomatis.
  const access = portal.accessState(booking);
  if (!access.ok) {
    portal.recordAttempt(ip, code, false);
    portal.expireSessionsFor(booking.id);
    return render(`Masa akses portal sudah berakhir. Kode booking hanya berlaku ${portal.PENDING_ACCESS_HOURS} jam selama booking belum dikonfirmasi admin. Silakan hubungi admin untuk konfirmasi.`);
  }

  let pinOk = false;
  if (!portal.hasPin(booking)) {
    // PIN belum pernah dibuat: buat sekarang dari PIN yang dikirim admin? Tidak bisa —
    // jadi minta admin mengirim PIN terlebih dahulu (pesan yang jelas, bukan gagal senyap).
    portal.recordAttempt(ip, code, false);
    return render('PIN portal belum dibuat. Hubungi admin via WhatsApp agar PIN dikirimkan.');
  }
  try { pinOk = portal.verifyPin(booking, pin); } catch (err) { pinOk = false; }

  if (!pinOk) {
    portal.recordAttempt(ip, code, false);
    return render('PIN tidak sesuai. Mohon periksa kembali pesan dari admin.');
  }

  portal.recordAttempt(ip, code, true);
  portal.resetAttempts(ip);
  const sessionId = portal.createSession(booking.id, { ip, userAgent: req.get('user-agent') || '' });
  res.setHeader('Set-Cookie', portal.cookieFor(req, sessionId));
  res.redirect(`${req.basePath}${next || '/portal/ringkasan'}`);
});

router.post('/keluar', (req, res) => {
  portal.destroySession(req);
  res.setHeader('Set-Cookie', portal.clearCookie());
  res.redirect(`${req.basePath}/portal`);
});

/* ------------------------------------------------------------------ */
/* Halaman                                                            */
/* ------------------------------------------------------------------ */
router.use(portal.requirePortal);

router.get('/ringkasan', (req, res) => {
  const booking = req.portalBooking;
  const ctx = selection.detail(selection.portalForBooking(booking.id)) || { portal: null, booking };
  const tl = timeline.list(booking, { portal: ctx.portal });
  // Revisi 5 — tiga kotak tagihan (total / dibayar / sisa) + info rekening dari
  // Pengaturan Pembayaran admin. Angka HANYA dari snapshot booking & baris pembayaran.
  const pay = payments.summary(booking);
  const money = upgrades.currentSummary(booking);
  const settings = getSettings();
  const holidays = timeline.holidaysFromSettings(settings);
  const deadline = ctx.portal && ctx.portal.submitted_at
    ? timeline.editingDeadline(ctx.portal, holidays)
    : null;

  res.render('portal/ringkasan', {
    ...locals(req, res, { active: 'ringkasan', title: 'Ringkasan' }),
    booking,
    selPortal: ctx.portal,
    timeline: tl,
    SESSION_REMINDER: timeline.SESSION_REMINDER,
    editingDeadline: deadline,
    payLabel: (() => {
      const row = db.prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM booking_payments WHERE booking_id = ?').get(booking.id);
      return Number(row.paid) > 0 ? 'Pembayaran tercatat' : 'Belum ada pembayaran';
    })(),
    // Tiga kotak tagihan: total paket, sudah dibayar, belum dibayar.
    pay,
    payStatusLabel: (() => {
      if (pay.status === 'paid') return 'Pembayaran Lunas';
      if (pay.status === 'partial') return 'Pembayaran baru DP';
      if (pay.status === 'unpaid') return 'Belum ada pembayaran';
      return 'Belum ada tagihan tercatat';
    })(),
    hasExtras: money.hasExtras,
    extrasLabel: [money.extras.length ? 'Extra Time' : '', money.addons.length ? 'Addon' : '']
      .filter(Boolean).join(' + '),
    bank: {
      name: (settings.payment_bank_name || '').trim(),
      number: (settings.payment_account_number || '').trim(),
      holder: (settings.payment_account_holder || '').trim(),
      notes: (settings.payment_notes || '').trim()
    },
    rupiah: util.rupiah,
    formatDateID: util.formatDateID,
    formatDateTimeWIB: util.formatDateTimeWIB
  });
});

router.get('/pilih-foto', (req, res) => {
  const booking = req.portalBooking;
  const vars = portalview.photoVars(req, res, booking, { adminView: false });

  if (!vars) {
    return res.render('portal/foto-empty', {
      ...locals(req, res, { active: 'foto', title: 'Pilih Foto Favorit' }),
      booking,
      reason: 'no-portal'
    });
  }

  res.render('portal/foto', {
    ...locals(req, res, { active: 'foto', title: 'Pilih Foto Favorit', needsSelection: true }),
    ...vars,
    needsSelection: true
  });
});

router.get('/pantau-order', (req, res) => {
  const booking = req.portalBooking;
  const sel = selection.portalForBooking(booking.id);
  const tl = timeline.list(booking, { portal: sel });
  const settings = getSettings();
  const holidays = timeline.holidaysFromSettings(settings);
  const deadline = sel && sel.submitted_at ? timeline.editingDeadline(sel, holidays) : null;

  res.render('portal/timeline', {
    ...locals(req, res, { active: 'timeline', title: 'Pantau Order' }),
    booking,
    selPortal: sel,
    timeline: tl,
    SESSION_REMINDER: timeline.SESSION_REMINDER,
    editingDeadline: deadline,
    deadlineLabel: deadline ? util.formatDateID(deadline, true) : '',
    holidays,
    formatDateTimeWIB: util.formatDateTimeWIB
  });
});

/* ------------------------------------------------------------------ */
/* Reschedule (pengajuan klien → disetujui admin)                      */
/* ------------------------------------------------------------------ */
// Menu ini hanya terbuka sampai H-7 sebelum sesi foto. Setelah itu klien harus
// konfirmasi manual ke admin — dan admin bisa membukanya lagi dari dashboard.
router.get('/reschedule', (req, res) => {
  const booking = req.portalBooking;
  const access = reschedule.accessState(booking);
  const settings = getSettings();
  const requests = reschedule.requestsFor(booking.id);
  const waNumber = settings.whatsapp_number || res.locals.brand.whatsapp || '';
  const waText = `Halo admin DLY Graduation, saya ${booking.client_name} (${booking.code}) ingin `
    + 'mengajukan perubahan jadwal sesi foto.';

  res.render('portal/reschedule', {
    ...locals(req, res, { active: 'reschedule', title: 'Reschedule' }),
    booking,
    access,
    requests: requests.map((r) => ({ ...r, meta: reschedule.statusMeta(r.status) })),
    holdDays: reschedule.HOLD_DAYS,
    flash: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : '',
    flashError: typeof req.query.err === 'string' ? req.query.err.slice(0, 200) : '',
    waHref: util.whatsappLink(waNumber, waText),
    formatDateID: util.formatDateID,
    formatDateTimeWIB: util.formatDateTimeWIB,
    todayISO: util.todayISO()
  });
});

router.post('/reschedule', (req, res) => {
  const booking = req.portalBooking;
  const access = reschedule.accessState(booking);
  if (!access.ok) {
    return res.redirect(`${req.basePath}/portal/reschedule?err=${encodeURIComponent(access.reason)}`);
  }
  const result = reschedule.request(booking, {
    date: String(req.body.new_date || '').trim(),
    time: String(req.body.new_time || '').trim(),
    location: String(req.body.new_location || '').trim(),
    reason: String(req.body.reason || '').trim()
  });
  if (!result.ok) {
    return res.redirect(`${req.basePath}/portal/reschedule?err=${encodeURIComponent(result.message)}`);
  }
  const extra = result.warnings && result.warnings.length
    ? ` Catatan admin: ${result.warnings.join(' ')}`
    : '';
  res.redirect(`${req.basePath}/portal/reschedule?msg=${encodeURIComponent(
    'Pengajuan reschedule dikirim. Admin akan mengonfirmasi jadwal barunya lewat WhatsApp.' + extra
  )}`);
});

/* Status ringkas untuk penyegaran otomatis halaman portal (tanpa data pribadi).
   Dipakai client-portal.js: saat jam sesi tiba, halaman memuat ulang statusnya sendiri. */
router.get('/status', (req, res) => {
  const booking = req.portalBooking;
  const sel = selection.portalForBooking(booking.id);
  const tl = timeline.list(booking, { portal: sel });
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    serverNow: Date.now(),
    stage: tl.current ? tl.current.key : null,
    title: tl.current ? tl.current.title : null,
    // Revisi 2 (08): status tahap terakhir (aktif/selesai) + posisi antrean, supaya
    // halaman bisa menyegarkan diri ketika tahap 07 berubah jadi centang hijau.
    state: tl.current ? tl.current.state : null,
    queue: (() => {
      const q = tl.items.find((s) => s.key === 'editing_queue');
      return q && q.queue ? q.queue : null;
    })(),
    stages: tl.items.map((s) => s.key),
    nextSessionAt: tl.nextSessionAt
  });
});

/* ------------------------------------------------------------------ */
/* Upgrade Paket & Extra Time (revisi pemilik)                        */
/* ------------------------------------------------------------------ */
// Aturannya dijaga server (lihat src/upgrades.js): hanya paket yang LEBIH MAHAL, dan
// Extra Time hanya setelah sesi foto selesai. Pengajuan tidak langsung mengubah tagihan;
// admin harus menyetujui dulu.
router.get('/upgrade', (req, res) => {
  const booking = req.portalBooking;
  const sel = selection.portalForBooking(booking.id);
  const tl = timeline.list(booking, { portal: sel });
  const sessionItem = tl.items.find((i) => i.key === 'session_done');
  // Revisi 4 — Extra Time terbuka sejak SESI FOTO DIMULAI (state aktif), bukan setelah
  // sesi selesai. `sessionDone` tetap dikirim supaya kondisi "sudah lewat" juga terbuka.
  const sessionDone = Boolean(sessionItem && sessionItem.state === 'done');
  const sessionStarted = Boolean(sessionItem && (sessionItem.state === 'active' || sessionItem.state === 'done'));

  const candidates = upgrades.upgradeCandidates(booking);
  const durations = upgrades.durationCandidates(booking);
  // Revisi 5 — tampilan paket & durasi memakai kartu GAYA PRICELIST (satu komponen),
  // paket lebih murah tetap tampil tapi DIKUNCI (downgrade tidak bisa diajukan).
  const cards = upgrades.packageCards(booking);
  const access = upgrades.accessState(booking);
  const summary = upgrades.currentSummary(booking);
  const addons = upgrades.addonOptions(booking);
  const requests = upgrades.requestsFor(booking.id);

  res.render('portal/upgrade', {
    ...locals(req, res, { active: 'upgrade', title: 'Upgrade Paket' }),
    booking,
    access,
    summary,
    addons,
    pendingAddon: upgrades.pendingFor(booking.id, 'addon'),
    cards: cards.items,
    currentPackage: candidates.current,
    currentPrice: candidates.currentPrice,
    packages: candidates.items,
    durations: durations.items,
    currentDuration: durations.current,
    currentDurationPrice: durations.currentPrice,
    extraOptions: upgrades.extraOptions(),
    sessionDone,
    sessionStarted,
    sessionAt: sessionItem ? sessionItem.atLabel : '',
    requests,
    requestStatus: upgrades.statusMeta,
    pendingPackage: upgrades.pendingFor(booking.id, 'package'),
    pendingDuration: upgrades.pendingFor(booking.id, 'duration'),
    pendingExtra: upgrades.pendingFor(booking.id, 'extra'),
    // Catatan kecil di kartu ringkasan: pengajuan yang belum diputuskan admin.
    plannedChanges: (() => {
      const extra = upgrades.pendingFor(booking.id, 'extra');
      const addon = upgrades.pendingFor(booking.id, 'addon');
      return {
        extraMinutes: extra ? Number(extra.minutes) : 0,
        addonName: addon ? addon.package_name : '',
        addonPrice: addon ? Number(addon.price) : 0
      };
    })(),
    // Tombol bantuan saat upgrade terkunci H-7.
    waHref: util.whatsappLink(
      getSettings().whatsapp_number || res.locals.brand.whatsapp || '',
      `Halo admin DLY Graduation, saya ${booking.client_name} (${booking.code}) ingin mengajukan upgrade paket.`
    ),
    csrf: csrfFor(req),
    flash: typeof req.query.msg === 'string' ? req.query.msg : '',
    flashError: typeof req.query.err === 'string' ? req.query.err.slice(0, 200) : '',
    rupiah: util.rupiah
  });
});

router.post('/upgrade/package', (req, res) => {
  const booking = req.portalBooking;
  const result = upgrades.requestPackage(booking, Number(req.body.package_id), {
    note: String(req.body.note || '')
  });
  if (!result.ok) {
    return res.redirect(`${req.basePath}/portal/upgrade?err=${encodeURIComponent(result.message)}`);
  }
  res.redirect(`${req.basePath}/portal/upgrade?msg=${encodeURIComponent(
    result.created ? 'Pengajuan upgrade dikirim. Admin akan menghubungi kamu untuk konfirmasi.'
      : 'Pengajuan upgrade untuk paket ini sudah menunggu konfirmasi admin.'
  )}`);
});

router.post('/upgrade/addon', (req, res) => {
  const booking = req.portalBooking;
  const result = upgrades.requestAddon(booking, Number(req.body.addon_id), {
    note: String(req.body.note || '')
  });
  if (!result.ok) {
    return res.redirect(`${req.basePath}/portal/upgrade?err=${encodeURIComponent(result.message)}`);
  }
  res.redirect(`${req.basePath}/portal/upgrade?msg=${encodeURIComponent(
    result.created ? 'Pengajuan add-on dikirim. Admin akan mengonfirmasi harga & pembayarannya lebih dulu.'
      : 'Pengajuan add-on ini sudah menunggu konfirmasi admin.'
  )}`);
});

router.post('/upgrade/duration', (req, res) => {
  const booking = req.portalBooking;
  const result = upgrades.requestDuration(booking, Number(req.body.minutes), {
    note: String(req.body.note || '')
  });
  if (!result.ok) {
    return res.redirect(`${req.basePath}/portal/upgrade?err=${encodeURIComponent(result.message)}`);
  }
  res.redirect(`${req.basePath}/portal/upgrade?msg=${encodeURIComponent(
    result.created ? 'Pengajuan upgrade durasi dikirim. Admin akan menghubungi kamu untuk konfirmasi.'
      : 'Pengajuan upgrade durasi ini sudah menunggu konfirmasi admin.'
  )}`);
});

router.post('/upgrade/extra', (req, res) => {
  const booking = req.portalBooking;
  const sel = selection.portalForBooking(booking.id);
  const tl = timeline.list(booking, { portal: sel });
  const sessionItem = tl.items.find((i) => i.key === 'session_done');
  const sessionDone = Boolean(sessionItem && sessionItem.state === 'done');
  const sessionStarted = Boolean(sessionItem && (sessionItem.state === 'active' || sessionItem.state === 'done'));

  const result = upgrades.requestExtra(booking, Number(req.body.minutes), {
    sessionStarted,
    sessionDone,
    note: String(req.body.note || '')
  });
  if (!result.ok) {
    return res.redirect(`${req.basePath}/portal/upgrade?err=${encodeURIComponent(result.message)}`);
  }
  res.redirect(`${req.basePath}/portal/upgrade?msg=${encodeURIComponent(
    result.created ? 'Pengajuan Extra Time dikirim. Admin akan menghubungi kamu untuk konfirmasi.'
      : 'Pengajuan Extra Time ini sudah menunggu konfirmasi admin.'
  )}`);
});

router.get('/drive', (req, res) => {
  const booking = req.portalBooking;
  // Tombol "Isi Ulasan Sekarang" memakai halaman testimoni yang SUDAH ada (tidak ada
  // halaman/form baru). Bila admin belum mengaktifkan link testimoni, arahkan ke
  // halaman ulasan publik supaya tombolnya tidak pernah jadi tautan mati.
  const settings = getSettings();
  const testimonialToken = String(settings.testimonial_form_token || '').trim();
  const reviewUrl = testimonialToken
    ? `${req.basePath}/testimoni/${encodeURIComponent(testimonialToken)}`
    : `${req.basePath}/ulasan`;

  res.render('portal/drive', {
    ...locals(req, res, { active: 'drive', title: 'Orderanmu Siap' }),
    booking,
    finalUrl: booking.final_url || '',
    finalAt: booking.final_at || '',
    reviewUrl,
    formatDateTimeWIB: util.formatDateTimeWIB
  });
});

/* ------------------------------------------------------------------ */
/* Notifikasi client (hanya untuk booking milik sesi ini)              */
/* ------------------------------------------------------------------ */
// Client mendaftarkan perangkatnya SENDIRI dari portal. Subscription terikat ke
// booking_id + role 'client', jadi tidak mungkin menerima notifikasi booking lain.
router.post('/push/subscribe', (req, res) => {
  const booking = req.portalBooking;
  try {
    const result = push.saveSubscription(req.body.subscription || {}, {
      role: 'client',
      bookingId: booking.id,
      userAgent: req.get('user-agent') || '',
      platform: req.body.platform,
      label: recLabel(req, booking)
    });
    res.json({ ok: true, created: result.created });
  } catch (err) {
    res.status(err.status || 422).json({ ok: false, message: err.message });
  }
});

router.post('/push/unsubscribe', (req, res) => {
  const endpoint = (req.body.subscription && req.body.subscription.endpoint) || req.body.endpoint || '';
  const removed = push.removeByEndpoint(endpoint);
  res.json({ ok: true, removed });
});

/** Label perangkat client, mis. "Client · Android". */
function recLabel(req, booking) {
  const ua = String(req.get('user-agent') || '');
  const platform = /iPhone|iPad|iPod/i.test(ua) ? 'iPhone'
    : /Android/i.test(ua) ? 'Android' : 'Desktop';
  return `Client ${platform} · ${booking.code || ''}`.slice(0, 60);
}

module.exports = router;

'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { db, getSettings, saveSettings } = require('../db');
const util = require('../util');
const auth = require('../auth');
const content = require('../content');
const schema = require('../content-schema');
const { uploadImage } = require('../media');
const icons = require('../icons');
const gcal = require('../gcal');
const selection = require('../selection');
const drive = require('../drive');
const payments = require('../payments');
const editing = require('../editing');
const notify = require('../notify');
const push = require('../push');
const team = require('../team');
const portalAccess = require('../portal');
const timeline = require('../timeline');
const orderCompletion = require('../ordercompletion');
const upgrades = require('../upgrades');
const reschedule = require('../reschedule');
const security = require('../security');
const publiccache = require('../publiccache');
const bookingcode = require('../bookingcode');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const FLASH = {
  'city-created': 'Kota berhasil ditambahkan.',
  'city-updated': 'Data kota berhasil diperbarui.',
  'city-deleted': 'Kota berhasil dihapus.',
  'category-created': 'Kategori paket berhasil ditambahkan.',
  'category-updated': 'Kategori paket berhasil diperbarui.',
  'category-deleted': 'Kategori paket berhasil dihapus.',
  'package-created': 'Paket berhasil ditambahkan.',
  'package-updated': 'Paket, durasi, dan harga berhasil diperbarui.',
  'package-deleted': 'Paket berhasil dihapus.',
  'portfolio-created': 'Portfolio berhasil ditambahkan.',
  'portfolio-updated': 'Portfolio berhasil diperbarui.',
  'portfolio-deleted': 'Portfolio berhasil dihapus.',
  'hero-created': 'Foto hero berhasil ditambahkan.',
  'hero-updated': 'Slide hero berhasil diperbarui.',
  'hero-deleted': 'Slide hero berhasil dihapus.',
  'booking-updated': 'Booking berhasil diperbarui.',
  'booking-created': 'Client manual berhasil disimpan.',
  'booking-deleted': 'Data booking berhasil dihapus.',
  'testimonial-created': 'Testimoni berhasil ditambahkan.',
  'testimonial-updated': 'Testimoni berhasil diperbarui.',
  'testimonial-deleted': 'Testimoni berhasil dihapus.',
  'settings-saved': 'Pengaturan kontak berhasil disimpan.',
  'password-changed': 'Password admin berhasil diubah.',
  'draft-saved': 'Draft disimpan. Website publik belum berubah sampai Anda menekan Publish Changes.',
  'published': 'Perubahan berhasil dipublikasikan ke website.',
  'cancelled': 'Perubahan draft dibatalkan. Website kembali ke versi terpublikasi.',
  'addon-created': 'Add-on berhasil ditambahkan.',
  'addon-updated': 'Add-on berhasil diperbarui.',
  'addon-deleted': 'Add-on berhasil dihapus.',
  'availability-saved': 'Pengaturan ketersediaan berhasil disimpan.',
  'availability-updated': 'Tanggal ketersediaan berhasil diperbarui.',
  'durations-saved': 'Durasi dan harga berhasil disimpan.',
  'article-created': 'Artikel berhasil ditambahkan.',
  'article-updated': 'Artikel berhasil diperbarui.',
  'article-deleted': 'Artikel berhasil dihapus.',
  'article-published': 'Status publikasi artikel berhasil diubah.',
  'faq-created': 'FAQ berhasil ditambahkan.',
  'faq-updated': 'FAQ berhasil diperbarui.',
  'faq-deleted': 'FAQ berhasil dihapus.',
  'team-created': 'Anggota tim berhasil ditambahkan.',
  'team-updated': 'Data anggota tim berhasil diperbarui.',
  'team-deleted': 'Anggota tim berhasil dihapus.',
  'testimonial-moderated': 'Testimoni berhasil diperbarui.',
  'testimonial-link-saved': 'Pengaturan link testimoni berhasil disimpan.',
  'brand-saved': 'Identitas brand berhasil disimpan.',
  'tnc-saved': 'Syarat & Ketentuan berhasil disimpan sebagai draft.',
  'tnc-published': 'Syarat & Ketentuan berhasil dipublikasikan.',
  'stat-created': 'Statistik berhasil ditambahkan.',
  'stat-updated': 'Statistik berhasil diperbarui.',
  'stat-deleted': 'Statistik berhasil dihapus.',
  'gcal-saved': 'Pengaturan Google Calendar disimpan.',
  'gcal-connected': 'Google Calendar berhasil terhubung.',
  'gcal-disconnected': 'Koneksi Google Calendar diputuskan.',
  'gcal-synced': 'Sinkronisasi kalender selesai.',
  'gcal-all-synced': 'Semua booking terkonfirmasi disinkronkan ke Google Calendar.',
  'gcal-tested': 'Koneksi Google Calendar & Drive berhasil diuji.',
  'drive-created': 'Folder Google Drive berhasil dibuat dan tautannya tersimpan di deskripsi kalender.',
  'drive-exists': 'Folder Google Drive sudah ada — tautannya tersimpan di deskripsi kalender.',
  'gdrive-connected': 'Akun Google Drive berhasil terhubung.',
  'gdrive-disconnected': 'Koneksi akun Google Drive diputuskan.',
  'payment-saved': 'Pengaturan pembayaran berhasil disimpan.',
  'wa-template-saved': 'Template pesan WhatsApp berhasil disimpan.',
  'pages-saved': 'Pengaturan halaman & navigasi berhasil disimpan.',
  'booking-payment-saved': 'Pembayaran berhasil dicatat.',
  'booking-payment-deleted': 'Catatan pembayaran berhasil dihapus.',
  // Tahap 5 — editing queue
  'editing-queued': 'Booking masuk antrean editing.',
  'editing-already': 'Booking ini sudah ada di antrean editing.',
  'editing-saved': 'Data job editing berhasil disimpan.',
  'editing-deleted': 'Job editing dihapus dari antrean.',
  'editing-finished': 'Order diselesaikan — hasil edit sudah bisa diakses client.',
  'editing-already-done': 'Order ini sudah berstatus selesai.',
  'notifications-read': 'Semua notifikasi ditandai sudah dibaca.',
  // Tahap 6 — Web Push
  'push-settings-saved': 'Pengaturan notifikasi HP disimpan.',
  'push-test-sent': 'Notifikasi percobaan dikirim ke perangkat yang terhubung.',
  'push-test-none': 'Belum ada perangkat terhubung. Aktifkan notifikasi di HP Anda terlebih dahulu.',
  'push-device-deleted': 'Perangkat dihapus dari daftar notifikasi.',
  'push-device-toggled': 'Status perangkat diperbarui.',
  'push-keys-reset': 'Kunci VAPID baru dibuat. Semua perangkat harus mengaktifkan notifikasi ulang.',
  // Tahap 7 — operasional booking
  'team-saved': 'Tim yang bertugas berhasil disimpan.',
  'booking-confirmed': 'Booking dikonfirmasi.',
  'booking-rescheduled': 'Jadwal booking berhasil diubah.',
  'invites-sent': 'Undangan kalender dikirim ulang.',
  'payment-recorded': 'Pembayaran berhasil dicatat.',
  'availability-marked': 'Status tanggal berhasil diperbarui.',
  // Client Portal
  'portal-pin-created': 'PIN portal dibuat. Kirimkan ke klien lewat WhatsApp.',
  'portal-pin-reset': 'PIN portal baru dibuat. PIN lama tidak berlaku lagi.',
  'booking-final-saved': 'Order ditandai selesai dan link Google Drive final disimpan.',
  'booking-final-cleared': 'Status selesai dibatalkan; link final dikosongkan.',
  'booking-code-regenerated': 'Kode booking baru dibuat (kode lama tetap bisa dipakai masuk portal).',
  // V9 — client photo-selection portal
  'selection-created': 'Portal Seleksi Foto berhasil dibuat. Unggah foto hasil pemotretan, lalu kirim link ke klien.',
  'selection-settings-saved': 'Pengaturan portal seleksi berhasil disimpan.',
  'selection-photos-added': 'Foto berhasil diunggah ke portal seleksi.',
  'selection-photo-deleted': 'Foto dihapus dari portal seleksi.',
  'selection-photo-primary': 'Foto utama portal seleksi diperbarui.',
  'selection-photo-moved': 'Urutan foto diperbarui.',
  'selection-opened': 'Portal seleksi diaktifkan kembali — klien bisa membuka link.',
  'selection-deadline-reopened': 'Portal Pilih Foto dibuka kembali dengan batas waktu baru. Perubahan tercatat di audit log.',
  'selection-closed': 'Portal seleksi ditutup. Link klien tidak bisa dibuka sampai diaktifkan lagi.',
  'selection-token-rotated': 'Token akses baru dibuat. Link lama otomatis tidak berlaku.',
  'selection-status-saved': 'Status dan catatan portal seleksi berhasil disimpan.',
  'selection-deleted': 'Portal seleksi dihapus (foto & pilihan klien di dalamnya ikut terhapus).',
  'portfolio-category-saved': 'Kategori gallery disimpan.',
  'portfolio-category-deleted': 'Kategori gallery dihapus.',
  'upgrade-approved': 'Upgrade disetujui — harga & durasi booking diperbarui.',
  'upgrade-rejected': 'Pengajuan upgrade ditolak.',
  'extra-time-saved': 'Harga Extra Time disimpan.'
};

router.use((req, res, next) => {
  res.locals.flash = FLASH[req.query.msg] || null;
  res.locals.extraFlash = req.query.note ? String(req.query.note).slice(0, 240) : null;
  res.locals.flashError = req.query.err ? String(req.query.err).slice(0, 240) : null;
  res.locals.adminPage = true;
  res.locals.csrf = res.locals.csrf || '';
  res.locals.pending = null;
  // P2: setiap perubahan dari dashboard (POST/PUT/PATCH/DELETE) membuang mikro-cache
  // halaman publik, supaya isi yang tampil tidak pernah tertinggal dari data terbaru.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => { publiccache.clear(); });
  }
  next();
});

/* ------------------------------------------------------------------ */
/* Auth                                                               */
/* ------------------------------------------------------------------ */
router.get('/login', (req, res) => {
  if (auth.getSession(req)) return res.redirect(`${req.basePath}/admin`);
  res.render('admin/login', {
    layout: 'admin/layout-blank',
    title: 'Login Admin',
    pageTitle: 'Login Admin',
    error: null,
    username: ''
  });
});

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (auth.tooManyAttempts(ip)) {
    return res.status(429).render('admin/login', {
      layout: 'admin/layout-blank', title: 'Login Admin', pageTitle: 'Login Admin',
      error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.', username: req.body.username || ''
    });
  }
  const session = auth.login(req.body.username, req.body.password);
  if (!session) {
    auth.recordAttempt(ip);
    return res.status(401).render('admin/login', {
      layout: 'admin/layout-blank', title: 'Login Admin', pageTitle: 'Login Admin',
      error: 'Username atau password salah.', username: req.body.username || ''
    });
  }
  auth.resetAttempts(ip);
  res.setHeader('Set-Cookie', auth.cookieFor(req, session.id, 8 * 3600));
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : null;
  res.redirect(`${req.basePath}${next || '/admin'}`);
});

router.post('/logout', (req, res) => {
  auth.destroySession(req);
  res.setHeader('Set-Cookie', auth.clearCookie(req));
  res.redirect(`${req.basePath}/admin/login`);
});

// Everything below requires a valid admin session.
router.use(auth.requireAdmin);
router.use((req, res, next) => {
  res.locals.pending = content.pendingChanges();
  // Sidebar badges (real counts, computed once per admin request).
  try {
    const days = Math.max(1, Number(getSettings().booking_new_days) || 7);
    const newCount = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE created_at >= datetime('now', ?)")
      .get(`-${days} days`).n;
    res.locals.navBadges = {
      bookings: db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending'").get().n,
      newBookings: newCount,
      selectionSubmitted: db.prepare("SELECT COUNT(*) AS n FROM photo_selections WHERE status = 'submitted'").get().n,
      // Tahap 5 / Tahap 4 — only ACTIVE queue work and unread notifications cost a badge.
      editing: editing.stats().active,
      notifications: notify.unreadCount()
    };
  } catch (err) {
    res.locals.navBadges = { bookings: 0, newBookings: 0, selectionSubmitted: 0, editing: 0, notifications: 0 };
  }
  try {
    const cfg = gcal.config();
    res.locals.gcal = cfg;
    res.locals.gcalReady = gcal.isActive(cfg);
    res.locals.driveReady = cfg.enabled && cfg.driveEnabled && gcal.isDriveConnected(cfg);
  } catch (err) {
    res.locals.gcal = null;
    res.locals.gcalReady = false;
    res.locals.driveReady = false;
  }
  next();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
function uniqueSlug(table, base, id, cityId) {
  let slug = base || 'item';
  let i = 2;
  const clause = cityId ? ' AND city_id = ?' : '';
  const sql = `SELECT id FROM ${table} WHERE slug = ?${clause}`;
  for (;;) {
    const params = cityId ? [slug, cityId] : [slug];
    const row = db.prepare(sql).get(...params);
    if (!row || (id && row.id === Number(id))) return slug;
    slug = `${base}-${i++}`;
  }
}

const int = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const str = (v, max = 5000) => {
  // A duplicated form field arrives as an array; take the first value instead of "a,b".
  const value = Array.isArray(v) ? v[0] : v;
  return String(value == null ? '' : value).trim().slice(0, max);
};
const bool = (v) => (v ? 1 : 0);

async function maybeUpload(req, field = 'image_file', fallback = '') {
  if (req.file && req.file.buffer && req.file.buffer.length) {
    const { src } = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
    return src;
  }
  return fallback || null;
}

function wrapUpload(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file maksimal 10MB.' : 'Gagal mengunggah file.';
      const back = req.get('referer') || `${req.basePath}/admin`;
      res.redirect(`${back}${back.includes('?') ? '&' : '?'}err=${encodeURIComponent(msg)}`);
    });
  };
}

const back = (req, path, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
  return `${req.basePath}${path}${qs ? '?' + qs : ''}`;
};

/* ------------------------------------------------------------------ */
/* Publish / draft pipeline                                           */
/* ------------------------------------------------------------------ */
router.post('/publish', auth.verifyCsrf, (req, res) => {
  const result = content.publishChanges();
  publiccache.clear();   // mikro-cache HTML publik: perubahan langsung terlihat
  res.redirect(back(req, '/admin', { msg: 'published', n: result.slides }));
});

router.post('/cancel', auth.verifyCsrf, (req, res) => {
  content.cancelChanges();
  publiccache.clear();
  res.redirect(back(req, '/admin', { msg: 'cancelled' }));
});

router.get('/preview', (req, res) => {
  const target = req.query.path && String(req.query.path).startsWith('/') ? String(req.query.path) : '/';
  res.redirect(`${req.basePath}${target}${target.includes('?') ? '&' : '?'}preview=1`);
});

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  const today = util.todayISO();
  const tomorrow = util.addDaysISO(today, 1);
  const newDays = Math.max(1, Number(getSettings().booking_new_days) || 7);
  const one = (sql, params = {}) => db.prepare(sql).get(params).n;

  const stats = {
    bookings: one('SELECT COUNT(*) AS n FROM bookings'),
    pending: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending'"),
    confirmed: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'"),
    completed: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'completed'"),
    cancelled: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'cancelled'"),
    today: one("SELECT COUNT(*) AS n FROM bookings WHERE shooting_date = :d AND status <> 'cancelled'", { d: today }),
    tomorrow: one("SELECT COUNT(*) AS n FROM bookings WHERE shooting_date = :d AND status <> 'cancelled'", { d: tomorrow }),
    newBookings: one("SELECT COUNT(*) AS n FROM bookings WHERE created_at >= datetime('now', :s)", { s: `-${newDays} days` }),
    // Money is only ever summed from recorded payments — never estimated.
    paidTotal: db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM booking_payments').get().v,
    billTotal: db.prepare(`SELECT COALESCE(SUM(COALESCE(total_price_snapshot, price, 0)), 0) AS v
                           FROM bookings WHERE status <> 'cancelled'`).get().v,
    paymentsRecorded: one('SELECT COUNT(*) AS n FROM booking_payments'),
    // Catalogue health
    packages: one('SELECT COUNT(*) AS n FROM packages WHERE is_active = 1'),
    portfolio: one('SELECT COUNT(*) AS n FROM portfolio WHERE is_active = 1'),
    selectionOpen: one('SELECT COUNT(*) AS n FROM photo_selections WHERE is_open = 1')
  };
  stats.outstanding = Math.max(0, stats.billTotal - stats.paidTotal);

  const upcoming = db.prepare(`${BOOKING_SELECT}
      WHERE b.shooting_date >= :d AND b.status <> 'cancelled'
      ORDER BY b.shooting_date ASC, COALESCE(NULLIF(b.shooting_time, ''), '23:59') ASC
      LIMIT 5`).all({ d: today });
  upcoming.forEach((b) => { b.pay = payments.summary(b); });

  const needsAction = db.prepare(`${BOOKING_SELECT}
      WHERE b.status = 'pending' ORDER BY b.id DESC LIMIT 5`).all();
  needsAction.forEach((b) => { b.pay = payments.summary(b); });

  const recentEvents = payments.recentEvents(8);

  const missingPrices = db.prepare(`SELECT p.*, c.name AS city_name, k.name AS category_name,
        (SELECT COUNT(*) FROM package_durations d WHERE d.package_id = p.id AND d.is_active = 1) AS duration_count,
        (SELECT COUNT(*) FROM package_durations d WHERE d.package_id = p.id AND d.is_active = 1 AND (d.price IS NULL OR d.price <= 0)) AS missing_count
      FROM packages p JOIN cities c ON c.id = p.city_id
      LEFT JOIN package_categories k ON k.id = p.category_id
      WHERE p.is_active = 1 ORDER BY c.name, k.sort_order, p.sort_order`).all()
    .filter((p) => p.missing_count > 0 || p.duration_count === 0);

  res.render('admin/dashboard', {
    layout: 'admin/layout',
    title: 'Overview',
    pageTitle: 'Overview',
    stats,
    upcoming,
    needsAction,
    recentEvents: recentEvents.map((e) => ({ ...e, description: payments.describeEvent(e) })),
    missingPrices,
    newDays,
    today,
    rupiah: util.rupiah,
    formatDateID: util.formatDateID
  });
});

router.get('/content', (req, res) => {
  const draft = content.getSiteContent({ preview: true });
  const live = content.getSiteContent({ preview: false });
  const groups = [];
  schema.CONTENT_FIELDS.forEach((f) => {
    let g = groups.find((x) => x.name === f.group);
    if (!g) { g = { name: f.group, fields: [] }; groups.push(g); }
    g.fields.push({ ...f, value: draft[f.key], liveValue: live[f.key] });
  });
  res.render('admin/content', {
    layout: 'admin/layout', title: 'Website Content', pageTitle: 'Website Content',
    groups, fields: schema.CONTENT_FIELDS, draft, live
  });
});

router.post('/content', auth.verifyCsrf, (req, res) => {
  const values = {};
  schema.CONTENT_FIELDS.forEach((f) => {
    if (f.type === 'bool') values[f.key] = req.body[f.key] ? '1' : '0';
    else if (req.body[f.key] !== undefined) values[f.key] = String(req.body[f.key]);
  });
  content.saveDraftValues(values);
  res.redirect(back(req, '/admin/content', { msg: 'draft-saved' }));
});

/* ------------------------------------------------------------------ */
/* Appearance                                                         */
/* ------------------------------------------------------------------ */
router.get('/appearance', (req, res) => {
  const app = content.getAppearance({ preview: true });
  res.render('admin/appearance', {
    layout: 'admin/layout', title: 'Appearance Settings', pageTitle: 'Appearance Settings',
    app, fields: schema.APPEARANCE_FIELDS, presets: schema.APPEARANCE_PRESETS,
    fonts: schema.FONT_OPTIONS
  });
});

router.post('/appearance', wrapUpload('logo_file'), auth.verifyCsrf, async (req, res) => {
  const values = {};
  schema.APPEARANCE_FIELDS.forEach((f) => {
    if (req.body['appearance_' + f.key] !== undefined) {
      values['appearance.' + f.key] = String(req.body['appearance_' + f.key]);
    }
  });
  values['appearance.preset'] = str(req.body.preset || 'custom', 40);

  try {
    if (req.file && req.file.buffer && req.file.buffer.length) {
      const { src } = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
      values['appearance.logo'] = src;
    }
  } catch (err) {
    return res.redirect(back(req, '/admin/appearance', { err: err.message }));
  }

  content.saveDraftValues(values);
  res.redirect(back(req, '/admin/appearance', { msg: 'draft-saved' }));
});

router.post('/appearance/preset', auth.verifyCsrf, (req, res) => {
  const preset = schema.APPEARANCE_PRESETS.find((p) => p.value === req.body.preset);
  if (!preset) return res.redirect(back(req, '/admin/appearance', { err: 'Preset tidak dikenal.' }));
  const values = { 'appearance.preset': preset.value };
  Object.entries(preset.values).forEach(([k, v]) => { values['appearance.' + k] = v; });
  content.saveDraftValues(values);
  res.redirect(back(req, '/admin/appearance', { msg: 'draft-saved' }));
});

/* ------------------------------------------------------------------ */
/* Section manager                                                    */
/* ------------------------------------------------------------------ */
router.get('/sections', (req, res) => {
  const rows = content.getSections({ preview: true }).map((sec) => {
    const defaults = schema.SECTION_ITEM_DEFAULTS[sec.key];
    if (defaults && !sec.items.length) {
      // Show the rows that are currently live so the owner can edit or delete them.
      return { ...sec, items: defaults, items_from_defaults: true };
    }
    return sec;
  });
  res.render('admin/sections', {
    layout: 'admin/layout', title: 'Editor Baris Homepage', pageTitle: 'Editor Baris Homepage',
    sections: rows,
    fontOptions: schema.FONT_OPTIONS
  });
});

const SECTION_ITEM_KEYS = ['services', 'advantages', 'process'];

router.post('/sections', wrapUpload('item_image'), auth.verifyCsrf, async (req, res) => {
  const rows = content.getSections({ preview: true });
  const photo = req.file && req.file.buffer && req.file.buffer.length
    ? await maybeUpload(req, 'item_image')
    : '';

  const items = rows.map((s, idx) => {
    // Structured rows (services/advantages/process) arrive as parallel arrays.
    let itemsJson = s.items_json || '';
    if (SECTION_ITEM_KEYS.includes(s.key)) {
      const titles = [].concat(req.body[`item_title_${s.key}`] || []);
      const descs = [].concat(req.body[`item_desc_${s.key}`] || []);
      const images = [].concat(req.body[`item_image_${s.key}`] || []);
      const links = [].concat(req.body[`item_link_${s.key}`] || []);
      const list = titles.map((t, i) => ({
        title: String(t || '').trim(),
        description: String(descs[i] || '').trim(),
        image: String(images[i] || '').trim(),
        link: String(links[i] || '').trim()
      })).filter((it) => it.title);
      itemsJson = JSON.stringify(list);
    }

    return {
      section_key: s.key,
      title: req.body[`title_${s.key}`] !== undefined ? String(req.body[`title_${s.key}`]) : s.title,
      description: req.body[`description_${s.key}`] !== undefined ? String(req.body[`description_${s.key}`]) : s.description,
      layout: req.body[`layout_${s.key}`] || s.layout,
      sort_order: req.body[`sort_${s.key}`] !== undefined ? int(req.body[`sort_${s.key}`]) : idx,
      content: req.body[`content_${s.key}`] !== undefined ? String(req.body[`content_${s.key}`]) : s.content,
      is_active: req.body[`active_${s.key}`] ? 1 : 0,
      bg_color: String(req.body[`bg_${s.key}`] || ''),
      text_color: String(req.body[`text_${s.key}`] || ''),
      font: String(req.body[`font_${s.key}`] || ''),
      items_json: itemsJson
    };
  });

  // One upload field serves every row: it fills the row whose index was submitted.
  if (photo && req.body.item_upload_section) {
    const key = String(req.body.item_upload_section);
    const row = items.find((it) => it.section_key === key);
    if (row) {
      const list = JSON.parse(row.items_json || '[]');
      const target = Number(req.body.item_upload_index);
      if (list[target]) {
        list[target].image = photo;
        row.items_json = JSON.stringify(list);
      }
    }
  }

  content.saveSectionDrafts(items);
  res.redirect(back(req, '/admin/sections', { msg: 'draft-saved' }));
});

/* ------------------------------------------------------------------ */
/* Hero slideshow                                                     */
/* ------------------------------------------------------------------ */
router.get('/hero', (req, res) => {
  res.render('admin/hero', {
    layout: 'admin/layout', title: 'Hero Slideshow', pageTitle: 'Hero Slideshow',
    slides: content.getHeroSlidesForAdmin(),
    heroSettings: {
      autoplay: req.site['hero.autoplay'],
      interval_ms: req.site['hero.interval_ms'],
      transition_ms: req.site['hero.transition_ms'],
      kenburns: req.site['hero.kenburns'],
      overlay_opacity: req.site['hero.overlay_opacity'],
      overlay_color: req.site['hero.overlay_color'],
      show_controls: req.site['hero.show_controls']
    },
    imageUrl: (img) => util.imageUrl(req.basePath, img)
  });
});

router.post('/hero/settings', auth.verifyCsrf, (req, res) => {
  content.saveDraftValues({
    'hero.autoplay': req.body.autoplay ? '1' : '0',
    'hero.interval_ms': String(Math.min(20000, Math.max(2500, int(req.body.interval_ms) || 6000))),
    'hero.transition_ms': String(Math.min(3000, Math.max(300, int(req.body.transition_ms) || 1300))),
    'hero.kenburns': req.body.kenburns ? '1' : '0',
    'hero.overlay_opacity': String(Math.min(90, Math.max(0, int(req.body.overlay_opacity) ?? 58))),
    'hero.overlay_color': /^#[0-9a-f]{6}$/i.test(req.body.overlay_color || '') ? req.body.overlay_color : '#0B2340',
    'hero.show_controls': req.body.show_controls ? '1' : '0'
  });
  res.redirect(back(req, '/admin/hero', { msg: 'draft-saved' }));
});

router.get('/hero/new', (req, res) => {
  res.render('admin/hero-form', {
    layout: 'admin/layout', title: 'Tambah Slide', pageTitle: 'Tambah Slide Hero',
    slide: {
      id: null, title: '', image_url: '', alt_text: '', desktop_position: 'center',
      mobile_position: 'center', is_active: 1, sort_order: (content.getHeroSlidesForAdmin().length || 0)
    },
    mode: 'create', imageUrl: (img) => util.imageUrl(req.basePath, img)
  });
});

router.get('/hero/:id/edit', (req, res) => {
  const slide = db.prepare('SELECT * FROM hero_slides WHERE id = ?').get(req.params.id);
  if (!slide) return res.redirect(back(req, '/admin/hero', { err: 'Slide tidak ditemukan.' }));
  res.render('admin/hero-form', {
    layout: 'admin/layout', title: 'Edit Slide', pageTitle: 'Edit Slide Hero',
    slide, mode: 'edit', imageUrl: (img) => util.imageUrl(req.basePath, img)
  });
});

router.post('/hero/save', wrapUpload('image_file'), auth.verifyCsrf, async (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  let image = str(req.body.image_url, 500);
  try {
    image = (await maybeUpload(req, 'image_file', image)) || '';
  } catch (err) {
    return res.redirect(back(req, '/admin/hero', { err: err.message }));
  }
  if (!image) return res.redirect(back(req, '/admin/hero', { err: 'Unggah foto atau isi URL gambar terlebih dahulu.' }));

  const data = {
    title: str(req.body.title, 120),
    image_url: image,
    alt_text: str(req.body.alt_text, 200),
    desktop_position: ['center', 'top', 'bottom', 'left', 'right'].includes(req.body.desktop_position) ? req.body.desktop_position : 'center',
    mobile_position: ['center', 'top', 'bottom', 'left', 'right'].includes(req.body.mobile_position) ? req.body.mobile_position : 'center',
    is_active: bool(req.body.is_active),
    sort_order: int(req.body.sort_order) || 0
  };
  if (id) {
    db.prepare(`UPDATE hero_slides SET title=@title, image_url=@image_url, alt_text=@alt_text,
                desktop_position=@desktop_position, mobile_position=@mobile_position,
                is_active=@is_active, sort_order=@sort_order, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...data, id });
    return res.redirect(back(req, '/admin/hero', { msg: 'hero-updated' }));
  }
  db.prepare(`INSERT INTO hero_slides (title, image_url, alt_text, desktop_position, mobile_position, is_active, sort_order)
              VALUES (@title, @image_url, @alt_text, @desktop_position, @mobile_position, @is_active, @sort_order)`).run(data);
  res.redirect(back(req, '/admin/hero', { msg: 'hero-created' }));
});

router.post('/hero/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare("UPDATE hero_slides SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  res.redirect(back(req, '/admin/hero', { msg: 'hero-updated' }));
});

router.post('/hero/:id/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM hero_slides WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/hero', { msg: 'hero-deleted' }));
});

/* ------------------------------------------------------------------ */
/* Drag-and-drop reordering (hero slides + portfolio + categories)     */
/* ------------------------------------------------------------------ */
router.post('/reorder', auth.verifyCsrf, (req, res) => {
  const type = String(req.body.type || '');
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, message: 'Tidak ada item untuk diurutkan.' });
  const table = type === 'hero' ? 'hero_slides' : type === 'portfolio' ? 'portfolio'
    : type === 'categories' ? 'package_categories' : type === 'packages' ? 'packages' : null;
  if (!table) return res.status(400).json({ ok: false, message: 'Tipe tidak dikenal.' });
  const stmt = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
  db.transaction(() => { ids.forEach((id, idx) => stmt.run(idx, id)); })();
  res.json({ ok: true, pending: content.pendingChanges() });
});

/* ------------------------------------------------------------------ */
/* Cities                                                             */
/* ------------------------------------------------------------------ */
router.get('/cities', (req, res) => {
  const cities = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM packages p WHERE p.city_id = c.id) AS package_count,
      (SELECT COUNT(*) FROM portfolio f WHERE f.city_id = c.id) AS photo_count,
      (SELECT COUNT(*) FROM bookings b WHERE b.city_id = c.id) AS booking_count
      FROM cities c ORDER BY c.sort_order ASC, c.name ASC`).all();
  res.render('admin/cities', { layout: 'admin/layout', title: 'Cities', pageTitle: 'Cities', cities });
});

router.get('/cities/new', (req, res) => {
  res.render('admin/city-form', {
    layout: 'admin/layout', title: 'Tambah Kota', pageTitle: 'Tambah Kota',
    city: { id: null, name: '', slug: '', description: '', cover_image: '', is_active: 1, sort_order: 0 },
    mode: 'create'
  });
});

router.get('/cities/:id/edit', (req, res) => {
  const city = db.prepare('SELECT * FROM cities WHERE id = ?').get(req.params.id);
  if (!city) return res.redirect(back(req, '/admin/cities', { err: 'Kota tidak ditemukan.' }));
  res.render('admin/city-form', { layout: 'admin/layout', title: 'Edit Kota', pageTitle: 'Edit Kota', city, mode: 'edit' });
});

router.post('/cities/save', wrapUpload('cover_file'), auth.verifyCsrf, async (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const name = str(req.body.name, 80);
  if (name.length < 2) return res.redirect(back(req, '/admin/cities', { err: 'Nama kota minimal 2 karakter.' }));
  let cover = str(req.body.cover_image, 500);
  try {
    cover = (await maybeUpload(req, 'cover_file', cover)) || '';
  } catch (err) {
    return res.redirect(back(req, '/admin/cities', { err: err.message }));
  }
  const slug = uniqueSlug('cities', util.slugify(req.body.slug || name), id);
  const data = {
    name, slug,
    description: str(req.body.description, 2000),
    cover_image: cover,
    is_active: bool(req.body.is_active),
    sort_order: int(req.body.sort_order) || 0
  };
  if (id) {
    db.prepare(`UPDATE cities SET name=@name, slug=@slug, description=@description,
                cover_image=@cover_image, is_active=@is_active, sort_order=@sort_order,
                updated_at=datetime('now') WHERE id=@id`).run({ ...data, id });
    return res.redirect(back(req, '/admin/cities', { msg: 'city-updated' }));
  }
  db.prepare(`INSERT INTO cities (name, slug, description, cover_image, is_active, sort_order, updated_at)
              VALUES (@name, @slug, @description, @cover_image, @is_active, @sort_order, datetime('now'))`).run(data);
  res.redirect(back(req, '/admin/cities', { msg: 'city-created' }));
});

router.post('/cities/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare("UPDATE cities SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  res.redirect(back(req, '/admin/cities', { msg: 'city-updated' }));
});

router.post('/cities/:id/delete', auth.verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  const bookings = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE city_id = ?').get(id).n;
  if (bookings > 0) {
    return res.redirect(back(req, '/admin/cities', { err: 'Kota tidak dapat dihapus karena sudah memiliki data booking. Nonaktifkan saja kotanya.' }));
  }
  db.prepare('DELETE FROM cities WHERE id = ?').run(id);
  res.redirect(back(req, '/admin/cities', { msg: 'city-deleted' }));
});

/* ------------------------------------------------------------------ */
/* Package categories                                                 */
/* ------------------------------------------------------------------ */
router.get('/categories', (req, res) => {
  const categories = db.prepare(`SELECT k.*,
      (SELECT COUNT(*) FROM packages p WHERE p.category_id = k.id) AS package_count
      FROM package_categories k ORDER BY k.sort_order, k.id`).all();
  res.render('admin/categories', {
    layout: 'admin/layout', title: 'Package Categories', pageTitle: 'Package Categories', categories
  });
});

router.get('/categories/new', (req, res) => {
  res.render('admin/category-form', {
    layout: 'admin/layout', title: 'Tambah Kategori', pageTitle: 'Tambah Kategori',
    category: { id: null, name: '', slug: '', description: '', sort_order: 0, is_active: 1 },
    mode: 'create'
  });
});

router.get('/categories/:id/edit', (req, res) => {
  const category = db.prepare('SELECT * FROM package_categories WHERE id = ?').get(req.params.id);
  if (!category) return res.redirect(back(req, '/admin/categories', { err: 'Kategori tidak ditemukan.' }));
  res.render('admin/category-form', {
    layout: 'admin/layout', title: 'Edit Kategori', pageTitle: 'Edit Kategori', category, mode: 'edit'
  });
});

router.post('/categories/save', auth.verifyCsrf, (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const name = str(req.body.name, 80);
  if (name.length < 2) return res.redirect(back(req, '/admin/categories', { err: 'Nama kategori minimal 2 karakter.' }));
  const slug = uniqueSlug('package_categories', util.slugify(req.body.slug || name), id);
  const data = {
    name, slug,
    description: str(req.body.description, 1000),
    sort_order: int(req.body.sort_order) || 0,
    is_active: bool(req.body.is_active)
  };
  if (id) {
    db.prepare(`UPDATE package_categories SET name=@name, slug=@slug, description=@description,
                sort_order=@sort_order, is_active=@is_active, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...data, id });
    return res.redirect(back(req, '/admin/categories', { msg: 'category-updated' }));
  }
  db.prepare(`INSERT INTO package_categories (name, slug, description, sort_order, is_active)
              VALUES (@name, @slug, @description, @sort_order, @is_active)`).run(data);
  res.redirect(back(req, '/admin/categories', { msg: 'category-created' }));
});

router.post('/categories/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare("UPDATE package_categories SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  res.redirect(back(req, '/admin/categories', { msg: 'category-updated' }));
});

router.post('/categories/:id/delete', auth.verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM packages WHERE category_id = ?').get(id).n;
  if (used > 0) {
    return res.redirect(back(req, '/admin/categories', { err: 'Kategori masih memiliki paket. Pindahkan atau hapus paketnya terlebih dahulu.' }));
  }
  db.prepare('DELETE FROM package_categories WHERE id = ?').run(id);
  res.redirect(back(req, '/admin/categories', { msg: 'category-deleted' }));
});

/* ------------------------------------------------------------------ */
/* Packages & pricing                                                 */
/* ------------------------------------------------------------------ */
function packageRows() {
  return db.prepare(`SELECT p.*, c.name AS city_name, k.name AS category_name,
      (SELECT COUNT(*) FROM package_durations d WHERE d.package_id = p.id) AS duration_count,
      (SELECT COUNT(*) FROM package_durations d WHERE d.package_id = p.id AND d.is_active = 1 AND (d.price IS NULL OR d.price <= 0)) AS missing_count,
      (SELECT MIN(d.price) FROM package_durations d WHERE d.package_id = p.id AND d.is_active = 1 AND d.price > 0) AS min_price
    FROM packages p
    JOIN cities c ON c.id = p.city_id
    LEFT JOIN package_categories k ON k.id = p.category_id
    ORDER BY c.sort_order, k.sort_order, p.sort_order, p.id`).all()
    .map((p) => ({
      ...p,
      durations: db.prepare(`SELECT duration_minutes, price, edited_photos, is_active FROM package_durations
                             WHERE package_id = ? ORDER BY sort_order, duration_minutes`).all(p.id)
    }));
}

router.get('/packages', (req, res) => {
  res.render('admin/packages', {
    layout: 'admin/layout', title: 'Packages & Pricing', pageTitle: 'Packages & Pricing',
    packages: packageRows(),
    cities: util.getAllCities(),
    categories: util.getAllCategories(),
    rupiah: util.rupiah,
    filterCity: req.query.kota || '',
    filterCategory: req.query.kategori || ''
  });
});

router.get('/packages/new', (req, res) => {
  const cities = util.getAllCities();
  const categories = util.getAllCategories();
  if (!cities.length) return res.redirect(back(req, '/admin/cities/new', { err: 'Tambahkan kota terlebih dahulu.' }));
  if (!categories.length) return res.redirect(back(req, '/admin/categories/new', { err: 'Tambahkan kategori paket terlebih dahulu.' }));
  res.render('admin/package-form', {
    layout: 'admin/layout', title: 'Tambah Paket', pageTitle: 'Tambah Paket',
    images: [],
    pkg: {
      id: null,
      city_id: req.query.city_id || cities[0].id,
      category_id: req.query.category_id || categories[0].id,
      name: '', slug: '', label: '', description: '', edited_photos: '', facilities: '',
      is_active: 1, sort_order: 0
    },
    benefits: [],
    durations: [
      { duration_minutes: 60, price: null, edited_photos: null, is_active: 1, sort_order: 0 },
      { duration_minutes: 90, price: null, edited_photos: null, is_active: 1, sort_order: 1 },
      { duration_minutes: 120, price: null, edited_photos: null, is_active: 1, sort_order: 2 }
    ],
    cities, categories, mode: 'create'
  });
});

router.get('/packages/:id/edit', (req, res) => {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  if (!pkg) return res.redirect(back(req, '/admin/packages', { err: 'Paket tidak ditemukan.' }));
  const durations = db.prepare('SELECT * FROM package_durations WHERE package_id = ? ORDER BY sort_order, duration_minutes').all(pkg.id)
    // Old rows may only carry the package-level count; show that so the field is never mysteriously blank.
    .map((d) => ({ ...d, edited_photos: d.edited_photos == null ? pkg.edited_photos : d.edited_photos }));
  const images = db.prepare('SELECT * FROM package_images WHERE package_id = ? ORDER BY is_primary DESC, sort_order, id').all(pkg.id);
  res.render('admin/package-form', {
    layout: 'admin/layout', title: 'Edit Paket', pageTitle: 'Edit Paket & Harga',
    pkg, durations, images,
    benefits: util.allBenefitsForPackage(pkg.id),
    cities: util.getAllCities(), categories: util.getAllCategories(), mode: 'edit'
  });
});

router.post('/packages/save', wrapUpload('image_file'), auth.verifyCsrf, async (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const cityId = Number(req.body.city_id);
  const categoryId = Number(req.body.category_id);
  const city = db.prepare('SELECT * FROM cities WHERE id = ?').get(cityId);
  const category = db.prepare('SELECT * FROM package_categories WHERE id = ?').get(categoryId);
  const name = str(req.body.name, 80);
  if (!city || !category || name.length < 2) {
    return res.redirect(back(req, '/admin/packages', { err: 'Nama paket, kota, dan kategori wajib diisi.' }));
  }

  const slug = uniqueSlug('packages', util.slugify(req.body.slug || name), id, cityId);

  let image = str(req.body.image, 500);
  try {
    image = (await maybeUpload(req, 'image_file', image)) || '';
  } catch (err) {
    return res.redirect(back(req, '/admin/packages', { err: err.message }));
  }

  const data = {
    city_id: cityId,
    category_id: categoryId,
    name,
    slug,
    image,
    label: str(req.body.label, 40),
    tagline: str(req.body.tagline, 160),
    terms: str(req.body.terms, 2000),
    is_best_seller: bool(req.body.is_best_seller),
    is_recommended: bool(req.body.is_recommended),
    sold_count: req.body.sold_count === '' ? null : int(req.body.sold_count),
    sold_label: str(req.body.sold_label, 60),
    sold_visible: bool(req.body.sold_visible),
    description: str(req.body.description, 1500),
    edited_photos: int(req.body.edited_photos),
    facilities: str(req.body.facilities, 3000),
    is_active: bool(req.body.is_active),
    sort_order: int(req.body.sort_order) || 0
  };

  let pkgId = id;
  db.transaction(() => {
    if (id) {
      db.prepare(`UPDATE packages SET city_id=@city_id, category_id=@category_id, name=@name, slug=@slug,
                  image=@image, label=@label, tagline=@tagline, terms=@terms,
                  is_best_seller=@is_best_seller, is_recommended=@is_recommended,
                  sold_count=@sold_count, sold_label=@sold_label,
                  sold_visible=@sold_visible,
                  description=@description, edited_photos=@edited_photos,
                  facilities=@facilities, is_active=@is_active, sort_order=@sort_order,
                  updated_at=datetime('now') WHERE id=@id`).run({ ...data, id });
    } else {
      const info = db.prepare(`INSERT INTO packages
        (city_id, category_id, name, slug, image, label, tagline, terms,
         is_best_seller, is_recommended, sold_count, sold_label, sold_visible,
         description, edited_photos, facilities, is_active, sort_order)
        VALUES (@city_id, @category_id, @name, @slug, @image, @label, @tagline, @terms,
                @is_best_seller, @is_recommended, @sold_count, @sold_label, @sold_visible,
                @description, @edited_photos, @facilities, @is_active, @sort_order)`).run(data);
      pkgId = Number(info.lastInsertRowid);
    }

    // ---- durations: upsert what was submitted, drop the rest ----
    const rows = Number(req.body.duration_rows) || 0;
    const submitted = new Set();
    const upsert = db.prepare(`INSERT INTO package_durations
        (package_id, duration_minutes, price, edited_photos, description, is_active, sort_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(package_id, duration_minutes) DO UPDATE SET
          price = excluded.price, edited_photos = excluded.edited_photos,
          description = excluded.description,
          is_active = excluded.is_active, sort_order = excluded.sort_order,
          updated_at = datetime('now')`);
    for (let i = 0; i < rows; i += 1) {
      const minutes = int(req.body[`dur_min_${i}`]);
      if (!minutes || minutes < 15 || minutes > util.MAX_DURATION) continue;
      if (req.body[`dur_remove_${i}`]) continue;
      submitted.add(minutes);
      const price = util.cleanPrice(req.body[`dur_price_${i}`]);
      const photos = int(req.body[`dur_photos_${i}`]);
      const isActive = req.body[`dur_active_${i}`] ? 1 : 0;
      upsert.run(pkgId, minutes, price, photos, str(req.body[`dur_note_${i}`], 300), isActive, i);
    }
    const existing = db.prepare('SELECT duration_minutes FROM package_durations WHERE package_id = ?').all(pkgId);
    const del = db.prepare('DELETE FROM package_durations WHERE package_id = ? AND duration_minutes = ?');
    existing.forEach((row) => {
      if (!submitted.has(row.duration_minutes)) del.run(pkgId, row.duration_minutes);
    });

    // ---- V8 benefits: upsert submitted rows, drop the rest ----------------
    // The order column is authoritative: rows are sorted by it (then by their
    // position in the form) and given a clean 0,1,2… sequence, so "Urutan 0"
    // always means first — no arithmetic that can collide with existing values.
    const benefitRows = Number(req.body.benefit_rows) || 0;
    const keepBenefit = new Set();
    const insBenefit = db.prepare(`INSERT INTO package_benefits (package_id, text, icon, is_active, sort_order)
                                   VALUES (?, ?, ?, ?, ?)`);
    const updBenefit = db.prepare(`UPDATE package_benefits SET text = ?, icon = ?, is_active = ?, sort_order = ?
                                   WHERE id = ? AND package_id = ?`);
    const submittedBenefits = [];
    for (let i = 0; i < benefitRows; i += 1) {
      const text = str(req.body[`benefit_text_${i}`], 200);
      if (!text) continue;
      const rawOrder = Number(req.body[`benefit_order_${i}`]);
      submittedBenefits.push({
        idx: i,
        text,
        icon: icons.iconKey(req.body[`benefit_icon_${i}`]),
        isActive: req.body[`benefit_active_${i}`] ? 1 : 0,
        order: Number.isFinite(rawOrder) ? rawOrder : i,
        id: Number(req.body[`benefit_id_${i}`]) || null
      });
    }
    submittedBenefits
      // Lower "Urutan" first; on a tie a newly added row wins (the owner typed that
      // number meaning "put me here"), otherwise the form order is preserved.
      .sort((a, b) => (a.order - b.order) || ((a.id ? 1 : 0) - (b.id ? 1 : 0)) || (a.idx - b.idx))
      .forEach((b, position) => {
        if (b.id) {
          const owned = db.prepare('SELECT id FROM package_benefits WHERE id = ? AND package_id = ?').get(b.id, pkgId);
          if (owned) {
            updBenefit.run(b.text, b.icon, b.isActive, position, b.id, pkgId);
            keepBenefit.add(b.id);
            return;
          }
        }
        const info = insBenefit.run(pkgId, b.text, b.icon, b.isActive, position);
        keepBenefit.add(Number(info.lastInsertRowid));
      });
    db.prepare('SELECT id FROM package_benefits WHERE package_id = ?').all(pkgId).forEach((row) => {
      if (!keepBenefit.has(row.id)) db.prepare('DELETE FROM package_benefits WHERE id = ?').run(row.id);
    });

    // Keep the legacy facilities text in sync so nothing reads stale data.
    const syncedFacilities = db.prepare(`SELECT text FROM package_benefits WHERE package_id = ? AND is_active = 1
                                         ORDER BY sort_order, id`).all(pkgId).map((b) => b.text).join('\n');
    db.prepare('UPDATE packages SET facilities = ? WHERE id = ?').run(syncedFacilities, pkgId);
  })();

  res.redirect(back(req, '/admin/packages', { msg: id ? 'package-updated' : 'package-created' }));
});

router.post('/packages/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare("UPDATE packages SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  res.redirect(back(req, '/admin/packages', { msg: 'package-updated' }));
});

router.post('/packages/:id/delete', auth.verifyCsrf, (req, res) => {
  const bookings = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE package_id = ?').get(req.params.id).n;
  if (bookings > 0) {
    return res.redirect(back(req, '/admin/packages', { err: 'Paket tidak dapat dihapus karena sudah dipakai pada booking. Nonaktifkan paket ini saja.' }));
  }
  db.prepare('DELETE FROM packages WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/packages', { msg: 'package-deleted' }));
});


/* ------------------------------------------------------------------ */
/* Package gallery (multi-image)                                       */
/* ------------------------------------------------------------------ */
router.post('/packages/:id/images', wrapUpload('gallery_file'), auth.verifyCsrf, async (req, res) => {
  const pkgId = Number(req.params.id);
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(pkgId);
  if (!pkg) return res.redirect(back(req, '/admin/packages', { err: 'Paket tidak ditemukan.' }));

  let src = str(req.body.gallery_url, 500);
  try {
    src = (await maybeUpload(req, 'gallery_file', src)) || '';
  } catch (err) {
    return res.redirect(back(req, `/admin/packages/${pkgId}/edit`, { err: err.message }));
  }
  if (!src) {
    return res.redirect(back(req, `/admin/packages/${pkgId}/edit`, { err: 'Unggah file atau isi URL foto terlebih dahulu.' }));
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM package_images WHERE package_id = ?').get(pkgId).n;
  db.prepare(`INSERT INTO package_images (package_id, image, caption, is_primary, sort_order)
              VALUES (?, ?, ?, ?, ?)`)
    .run(pkgId, src, str(req.body.caption, 160), count === 0 ? 1 : 0, count);
  // keep the cover in sync with the first image
  if (count === 0) db.prepare('UPDATE packages SET image = ? WHERE id = ?').run(src, pkgId);
  res.redirect(back(req, `/admin/packages/${pkgId}/edit`, { msg: 'package-updated' }));
});

router.post('/packages/:id/images/:imageId/primary', auth.verifyCsrf, (req, res) => {
  const pkgId = Number(req.params.id);
  const imageId = Number(req.params.imageId);
  const row = db.prepare('SELECT * FROM package_images WHERE id = ? AND package_id = ?').get(imageId, pkgId);
  if (row) {
    db.transaction(() => {
      db.prepare('UPDATE package_images SET is_primary = 0 WHERE package_id = ?').run(pkgId);
      db.prepare('UPDATE package_images SET is_primary = 1 WHERE id = ?').run(imageId);
      db.prepare('UPDATE packages SET image = ? WHERE id = ?').run(row.image, pkgId);
    })();
  }
  res.redirect(back(req, `/admin/packages/${pkgId}/edit`, { msg: 'package-updated' }));
});

router.post('/packages/:id/images/:imageId/delete', auth.verifyCsrf, (req, res) => {
  const pkgId = Number(req.params.id);
  db.prepare('DELETE FROM package_images WHERE id = ? AND package_id = ?').run(Number(req.params.imageId), pkgId);
  const next = db.prepare('SELECT * FROM package_images WHERE package_id = ? ORDER BY is_primary DESC, sort_order, id LIMIT 1').get(pkgId);
  if (next) {
    db.prepare('UPDATE packages SET image = ? WHERE id = ?').run(next.image, pkgId);
  }
  res.redirect(back(req, `/admin/packages/${pkgId}/edit`, { msg: 'package-updated' }));
});

/* ------------------------------------------------------------------ */
/* Portfolio                                                          */
/* ------------------------------------------------------------------ */
const portfolioPhotosFor = (id) => db.prepare(
  'SELECT * FROM portfolio_images WHERE portfolio_id = ? ORDER BY sort_order, id'
).all(id);

router.get('/portfolio', (req, res) => {
  const items = db.prepare(`SELECT p.*, COALESCE(p.image_url, p.image) AS image_src, c.name AS city_name,
                                   (SELECT COUNT(*) FROM portfolio_images pi WHERE pi.portfolio_id = p.id) AS photo_count
                            FROM portfolio p LEFT JOIN cities c ON c.id = p.city_id
                            ORDER BY p.sort_order, p.id DESC`).all();
  res.render('admin/portfolio', {
    layout: 'admin/layout', title: 'Portfolio', pageTitle: 'Portfolio',
    items, categories: util.portfolioCategories({ activeOnly: false }), collections: util.COLLECTIONS,
    showCity: getSettings().portfolio_show_city === '1',
    imageUrl: (img) => util.imageUrl(req.basePath, img)
  });
});

// Global switch: city on the public cover (stored + filterable either way).
router.post('/portfolio/city-visibility', auth.verifyCsrf, (req, res) => {
  saveSettings({ portfolio_show_city: req.body.portfolio_show_city ? '1' : '0' });
  res.redirect(back(req, '/admin/portfolio', { msg: 'portfolio-updated' }));
});

/* ---- Upgrade Paket & Extra Time (revisi pemilik) ------------------ */
/**
 * Semua pengajuan upgrade/extra time masuk ke sini. Harga booking HANYA berubah setelah
 * admin menyetujui (satu transaksi di src/upgrades.js) — pengajuan klien tidak pernah
 * mengubah tagihan sendiri.
 */
router.get('/upgrades', (req, res) => {
  const status = String(req.query.status || '');
  res.render('admin/upgrades', {
    layout: 'admin/layout',
    title: 'Upgrade Paket',
    pageTitle: 'Upgrade Paket',
    items: upgrades.list({ status }),
    statusFilter: ['pending', 'approved', 'rejected'].includes(status) ? status : '',
    pending: upgrades.pendingCount(),
    statusMeta: upgrades.statusMeta,
    extraOptions: upgrades.extraOptions(),
    rupiah: util.rupiah,
    formatDateID: util.formatDateID
  });
});

router.post('/upgrades/:id/approve', auth.verifyCsrf, (req, res) => {
  const result = upgrades.approve(int(req.params.id), { actor: (req.admin && req.admin.username) || 'admin' });
  if (!result.ok) return res.redirect(back(req, '/admin/upgrades', { err: result.message }));
  res.redirect(back(req, '/admin/upgrades', {
    msg: 'upgrade-approved',
    note: 'Harga & durasi booking ikut diperbarui. Sampaikan selisih pembayaran ke klien lewat WhatsApp.'
  }));
});

router.post('/upgrades/:id/reject', auth.verifyCsrf, (req, res) => {
  const result = upgrades.reject(int(req.params.id), {
    actor: (req.admin && req.admin.username) || 'admin',
    reason: str(req.body.reason, 200)
  });
  if (!result.ok) return res.redirect(back(req, '/admin/upgrades', { err: result.message }));
  res.redirect(back(req, '/admin/upgrades', { msg: 'upgrade-rejected' }));
});

/** Harga Extra Time 30 / 60 menit — bisa diubah kapan saja oleh admin. */
router.get('/extra-time', (req, res) => {
  res.render('admin/extra-time', {
    layout: 'admin/layout',
    title: 'Extra Time',
    pageTitle: 'Extra Time',
    options: upgrades.extraOptions(),
    rupiah: util.rupiah
  });
});

router.post('/extra-time', auth.verifyCsrf, (req, res) => {
  const clean = (v) => {
    const raw = String(v || '').replace(/[^0-9]/g, '');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : '0';
  };
  saveSettings({
    extra_time_30_price: clean(req.body['extra_time_30_price']),
    extra_time_60_price: clean(req.body['extra_time_60_price'])
  });
  res.redirect(back(req, '/admin/extra-time', { msg: 'extra-time-saved' }));
});

/* ---- Kategori Gallery (dikelola admin) ---------------------------- */
/**
 * Kategori portfolio adalah DATA, bukan konstanta kode: admin bisa menambah, mengganti
 * nama, mengurutkan, menonaktifkan, dan menghapus kategori yang belum dipakai karya.
 * Daftar ini yang tampil di filter Gallery dan di form portfolio.
 */
router.get('/portfolio-categories', (req, res) => {
  const items = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM portfolio p WHERE p.category = c.slug) AS used
      FROM portfolio_categories c ORDER BY c.sort_order, c.id`).all();
  res.render('admin/portfolio-categories', {
    layout: 'admin/layout',
    title: 'Kategori Gallery',
    pageTitle: 'Kategori Gallery',
    items,
    csrf: res.locals.csrf
  });
});

router.post('/portfolio-categories', auth.verifyCsrf, (req, res) => {
  const label = str(req.body.label, 40);
  if (label.length < 2) {
    return res.redirect(back(req, '/admin/portfolio-categories', { err: 'Nama kategori minimal 2 karakter.' }));
  }
  const base = util.slugify(label) || 'kategori';
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM portfolio_categories WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  const order = Number(db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM portfolio_categories').get().n);
  db.prepare(`INSERT INTO portfolio_categories (slug, label, is_active, sort_order)
              VALUES (?, ?, 1, ?)`).run(slug, label, order);
  res.redirect(back(req, '/admin/portfolio-categories', { msg: 'portfolio-category-saved' }));
});

router.post('/portfolio-categories/:id', auth.verifyCsrf, (req, res) => {
  const row = db.prepare('SELECT * FROM portfolio_categories WHERE id = ?').get(int(req.params.id));
  if (!row) return res.redirect(back(req, '/admin/portfolio-categories', { err: 'Kategori tidak ditemukan.' }));
  const label = str(req.body.label, 40) || row.label;
  const active = req.body.is_active ? 1 : 0;
  const order = Number.isFinite(int(req.body.sort_order)) ? int(req.body.sort_order) : row.sort_order;
  db.prepare(`UPDATE portfolio_categories SET label = ?, is_active = ?, sort_order = ?,
              updated_at = datetime('now') WHERE id = ?`).run(label, active, order, row.id);
  res.redirect(back(req, '/admin/portfolio-categories', { msg: 'portfolio-category-saved' }));
});

router.post('/portfolio-categories/:id/delete', auth.verifyCsrf, (req, res) => {
  const row = db.prepare('SELECT * FROM portfolio_categories WHERE id = ?').get(int(req.params.id));
  if (!row) return res.redirect(back(req, '/admin/portfolio-categories', { err: 'Kategori tidak ditemukan.' }));
  const used = db.prepare('SELECT COUNT(*) AS n FROM portfolio WHERE category = ?').get(row.slug).n;
  if (used > 0) {
    // Karya tidak pernah dihapus/diubah diam-diam: nonaktifkan saja.
    return res.redirect(back(req, '/admin/portfolio-categories', {
      err: `Kategori "${row.label}" masih dipakai ${used} karya. Nonaktifkan saja (karya lama tetap aman).`
    }));
  }
  db.prepare('DELETE FROM portfolio_categories WHERE id = ?').run(row.id);
  res.redirect(back(req, '/admin/portfolio-categories', { msg: 'portfolio-category-deleted' }));
});

router.get('/portfolio/new', (req, res) => {
  res.render('admin/portfolio-form', {
    layout: 'admin/layout', title: 'Tambah Portfolio', pageTitle: 'Tambah Portfolio',
    item: {
      id: null, title: '', client_name: '', client_degree: '', campus: '', image: '', alt_text: '',
      category: 'individual', city_id: (util.getAllCities()[0] || {}).id || '', description: '',
      taken_at: '', is_featured: 0, is_active: 1, is_placeholder: 0, show_city: 0,
      sort_order: 0, collection: 'portfolio'
    },
    photos: [],
    cities: util.getAllCities(), categories: util.portfolioCategories({ activeOnly: false }),
    collections: util.COLLECTIONS,
    categoryDefault: (util.portfolioCategories({ activeOnly: false })[0] || {}).value || 'individual',
    mode: 'create', imageUrl: (img) => util.imageUrl(req.basePath, img)
  });
});

router.get('/portfolio/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM portfolio WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect(back(req, '/admin/portfolio', { err: 'Portfolio tidak ditemukan.' }));
  res.render('admin/portfolio-form', {
    layout: 'admin/layout', title: 'Edit Portfolio', pageTitle: 'Edit Portfolio',
    item, photos: portfolioPhotosFor(item.id),
    cities: util.getAllCities(), categories: util.portfolioCategories({ activeOnly: false }),
    collections: util.COLLECTIONS, mode: 'edit',
    imageUrl: (img) => util.imageUrl(req.basePath, img)
  });
});

router.post('/portfolio/save', wrapUpload('image_file'), auth.verifyCsrf, async (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const clientName = str(req.body.client_name, 80);
  // Kategori divalidasi terhadap tabel `portfolio_categories` (dikelola admin).
  const categoryList = util.portfolioCategories({ activeOnly: false });
  const category = categoryList.some((c) => c.value === req.body.category)
    ? String(req.body.category)
    : ((categoryList[0] || {}).value || 'individual');
  const collection = util.COLLECTIONS.some((c) => c.value === req.body.collection) ? req.body.collection : 'portfolio';
  if (clientName.length < 2) {
    return res.redirect(back(req, '/admin/portfolio', { err: 'Nama klien minimal 2 karakter.' }));
  }
  // Legacy NOT NULL column: keep it in sync with the client name for old exports/links.
  const title = clientName;

  let image = str(req.body.image, 500);
  try {
    image = (await maybeUpload(req, 'image_file', image)) || '';
  } catch (err) {
    return res.redirect(back(req, '/admin/portfolio', { err: err.message }));
  }
  if (!image) {
    return res.redirect(back(req, '/admin/portfolio', { err: 'Unggah foto atau isi URL gambar terlebih dahulu.' }));
  }

  // Slug: explicit value wins, otherwise derived from the client name. Always unique so
  // /portfolio/<slug> can never point at two different clients.
  const slugBase = util.slugify(str(req.body.slug, 70) || clientName) || `portfolio-${id || 'baru'}`;
  const slugTaken = (candidate) => {
    const row = db.prepare('SELECT id FROM portfolio WHERE slug = ?').get(candidate);
    return Boolean(row) && (!id || Number(row.id) !== Number(id));
  };
  let slug = slugBase;
  let slugN = 2;
  while (slugTaken(slug)) { slug = `${slugBase}-${slugN++}`; }

  const data = {
    title,
    slug,
    session_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(req.body.session_time || ''))
      ? String(req.body.session_time) : '',
    client_name: clientName,
    client_degree: str(req.body.client_degree, 40),
    campus: str(req.body.campus, 120),
    image,
    image_url: image,
    alt_text: str(req.body.alt_text, 200) || clientName,
    category,
    collection,
    city_id: req.body.city_id ? Number(req.body.city_id) : null,
    description: str(req.body.description, 1000),
    taken_at: str(req.body.taken_at, 20) || null,
    is_featured: bool(req.body.is_featured),
    is_active: bool(req.body.is_active),
    is_placeholder: bool(req.body.is_placeholder),
    show_city: bool(req.body.show_city),
    sort_order: int(req.body.sort_order) || 0
  };
  if (id) {
    db.prepare(`UPDATE portfolio SET title=@title, slug=@slug, session_time=@session_time,
                client_name=@client_name, client_degree=@client_degree,
                campus=@campus, image=@image, image_url=@image_url, alt_text=@alt_text,
                category=@category, collection=@collection,
                city_id=@city_id, description=@description,
                taken_at=@taken_at, is_featured=@is_featured, is_active=@is_active, show_city=@show_city,
                is_placeholder=@is_placeholder, sort_order=@sort_order, updated_at=datetime('now')
                WHERE id=@id`).run({ ...data, id });
    return res.redirect(back(req, `/admin/portfolio/${id}/edit`, { msg: 'portfolio-updated' }));
  }
  const info = db.prepare(`INSERT INTO portfolio (title, slug, session_time, client_name, client_degree,
              campus, image, image_url, alt_text, category, collection,
              city_id, description, taken_at, is_featured, is_active, show_city, is_placeholder, sort_order)
              VALUES (@title, @slug, @session_time, @client_name, @client_degree,
              @campus, @image, @image_url, @alt_text, @category, @collection,
              @city_id, @description,
              @taken_at, @is_featured, @is_active, @show_city, @is_placeholder, @sort_order)`).run(data);
  res.redirect(back(req, `/admin/portfolio/${Number(info.lastInsertRowid)}/edit`, { msg: 'portfolio-created' }));
});

/* ---- extra photos of one portfolio entry ---------------------------- */
const wrapUploadMany = (field, max) => (req, res, next) => {
  upload.array(field, max)(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran tiap file maksimal 10MB.' : 'Gagal mengunggah file.';
    const referer = req.get('referer') || `${req.basePath}/admin`;
    res.redirect(`${referer}${referer.includes('?') ? '&' : '?'}err=${encodeURIComponent(msg)}`);
  });
};

router.post('/portfolio/:id/photos', wrapUploadMany('photo_files', 20), auth.verifyCsrf, async (req, res) => {
  const portfolioId = Number(req.params.id);
  const item = db.prepare('SELECT id FROM portfolio WHERE id = ?').get(portfolioId);
  if (!item) return res.redirect(back(req, '/admin/portfolio', { err: 'Portfolio tidak ditemukan.' }));

  const files = Array.isArray(req.files) ? req.files : [];
  const urls = String(req.body.photo_urls || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const uploaded = [];
  try {
    for (const file of files) {
      if (!file.buffer || !file.buffer.length) continue;
      const { src } = await uploadImage(file.buffer, file.originalname, file.mimetype);
      uploaded.push(src);
    }
  } catch (err) {
    return res.redirect(back(req, `/admin/portfolio/${portfolioId}/edit`, { err: err.message }));
  }
  const all = uploaded.concat(urls);
  if (!all.length) {
    return res.redirect(back(req, `/admin/portfolio/${portfolioId}/edit`, { err: 'Pilih foto atau isi URL foto terlebih dahulu.' }));
  }
  let order = db.prepare('SELECT COUNT(*) AS n FROM portfolio_images WHERE portfolio_id = ?').get(portfolioId).n;
  const ins = db.prepare('INSERT INTO portfolio_images (portfolio_id, image, caption, is_primary, sort_order) VALUES (?, ?, ?, 0, ?)');
  db.transaction(() => {
    all.forEach((src) => {
      ins.run(portfolioId, src, str(req.body.caption, 160), order);
      order += 1;
    });
  })();
  res.redirect(back(req, `/admin/portfolio/${portfolioId}/edit`, { msg: 'portfolio-updated' }));
});

// "Jadikan cover": swaps this photo with the current cover (old cover stays in the set).
router.post('/portfolio/:id/photos/:photoId/cover', auth.verifyCsrf, (req, res) => {
  const portfolioId = Number(req.params.id);
  const photoId = Number(req.params.photoId);
  const photo = db.prepare('SELECT * FROM portfolio_images WHERE id = ? AND portfolio_id = ?').get(photoId, portfolioId);
  const item = db.prepare('SELECT * FROM portfolio WHERE id = ?').get(portfolioId);
  if (photo && item) {
    db.transaction(() => {
      db.prepare('UPDATE portfolio SET image = ?, image_url = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(photo.image, photo.image, portfolioId);
      db.prepare('UPDATE portfolio_images SET image = ? WHERE id = ?').run(item.image, photoId);
    })();
  }
  res.redirect(back(req, `/admin/portfolio/${portfolioId}/edit`, { msg: 'portfolio-updated' }));
});

router.post('/portfolio/:id/photos/:photoId/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM portfolio_images WHERE id = ? AND portfolio_id = ?')
    .run(Number(req.params.photoId), Number(req.params.id));
  res.redirect(back(req, `/admin/portfolio/${req.params.id}/edit`, { msg: 'portfolio-updated' }));
});

/**
 * Save the gallery order (Tahap 7). Accepts an ordered list of photo ids; ids that do not
 * belong to this portfolio are ignored, and any photo missing from the payload keeps its
 * relative position at the end (nothing is ever deleted here).
 */
router.post('/portfolio/:id/photos/reorder', auth.verifyCsrf, (req, res) => {
  const portfolioId = Number(req.params.id);
  const rows = portfolioPhotosFor(portfolioId);
  if (!rows.length) return res.json({ ok: true, order: [] });

  const incoming = (Array.isArray(req.body.order) ? req.body.order : String(req.body.order || '').split(','))
    .map((v) => Number(String(v).trim())).filter(Boolean);
  const own = new Set(rows.map((r) => Number(r.id)));
  const orderedIds = incoming.filter((id, i) => own.has(id) && incoming.indexOf(id) === i);
  rows.map((r) => Number(r.id)).forEach((id) => { if (!orderedIds.includes(id)) orderedIds.push(id); });

  db.transaction(() => {
    const upd = db.prepare('UPDATE portfolio_images SET sort_order = ? WHERE id = ? AND portfolio_id = ?');
    orderedIds.forEach((id, i) => upd.run(i, id, portfolioId));
  })();

  const wantsJson = String(req.get('accept') || '').includes('application/json');
  if (wantsJson) return res.json({ ok: true, order: orderedIds });
  res.redirect(back(req, `/admin/portfolio/${portfolioId}/edit`, { msg: 'portfolio-updated' }));
});

// Move a photo one step earlier/later in the carousel order.
router.post('/portfolio/:id/photos/:photoId/move', auth.verifyCsrf, (req, res) => {
  const portfolioId = Number(req.params.id);
  const dir = req.body.dir === 'up' ? -1 : 1;
  const rows = portfolioPhotosFor(portfolioId);
  const idx = rows.findIndex((r) => r.id === Number(req.params.photoId));
  const swapWith = idx + dir;
  if (idx >= 0 && swapWith >= 0 && swapWith < rows.length) {
    db.transaction(() => {
      db.prepare('UPDATE portfolio_images SET sort_order = ? WHERE id = ?').run(swapWith, rows[idx].id);
      db.prepare('UPDATE portfolio_images SET sort_order = ? WHERE id = ?').run(idx, rows[swapWith].id);
    })();
  }
  res.redirect(back(req, `/admin/portfolio/${portfolioId}/edit`, { msg: 'portfolio-updated' }));
});

router.post('/portfolio/:id/feature', auth.verifyCsrf, (req, res) => {
  db.prepare("UPDATE portfolio SET is_featured = CASE is_featured WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  res.redirect(back(req, '/admin/portfolio', { msg: 'portfolio-updated' }));
});

router.post('/portfolio/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare("UPDATE portfolio SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  res.redirect(back(req, '/admin/portfolio', { msg: 'portfolio-updated' }));
});

router.post('/portfolio/:id/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM portfolio WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/portfolio', { msg: 'portfolio-deleted' }));
});

/* ------------------------------------------------------------------ */
/* Kelola Booking (Tahap 3)                                            */
/* ------------------------------------------------------------------ */
const BOOKING_TABS = [
  { value: 'all', label: 'Semua Booking' },
  { value: 'today', label: 'Job Hari Ini' },
  { value: 'tomorrow', label: 'Job Besok' },
  { value: 'new', label: 'Booking Baru' },
  { value: 'pending', label: 'Menunggu Konfirmasi' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'ongoing', label: 'Sedang Berlangsung' },
  { value: 'reschedule', label: 'Pengajuan Reschedule' },
  { value: 'done', label: 'Selesai' },
  { value: 'cancelled', label: 'Dibatalkan' }
];
const BOOKING_VIEWS = ['grid', 'calendar', 'list', 'kanban'];
const PAYMENT_FILTERS = [
  { value: 'unpaid', label: 'Belum Bayar' },
  { value: 'partial', label: 'DP Dibayar' },
  { value: 'paid', label: 'Lunas' },
  { value: 'none', label: 'Belum Tercatat' }
];

const BOOKING_SELECT = `SELECT b.*, c.name AS city_name, p.name AS package_name,
                               k.name AS category_name,
                               ps.id AS selection_portal_id, ps.status AS selection_status,
                               ps.quota AS selection_quota, ps.is_open AS selection_open,
                               ps.token AS selection_token, ps.deadline AS selection_deadline,
                               ps.allow_download AS selection_allow_download,
                               (SELECT COUNT(*) FROM photo_selection_photos ph
                                 WHERE ph.portal_id = ps.id) AS selection_photos,
                               (SELECT COUNT(*) FROM photo_selection_picks pk
                                 WHERE pk.portal_id = ps.id) AS selection_picks,
                               (SELECT COUNT(*) FROM reschedule_requests rr
                                 WHERE rr.booking_id = b.id AND rr.status = 'pending') AS reschedule_pending
                        FROM bookings b
                        JOIN cities c ON c.id = b.city_id
                        JOIN packages p ON p.id = b.package_id
                        LEFT JOIN package_categories k ON k.id = b.category_id
                        LEFT JOIN photo_selections ps ON ps.booking_id = b.id`;

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/**
 * Turns the query string into `{ tab, where, params, filters }`.
 * `tab` is the quick filter; every other facet is independent so they combine freely.
 * The legacy `?status=` and `?dari=&sampai=` parameters still work.
 */
function bookingQuery(query) {
  const today = util.todayISO();
  const tomorrow = util.addDaysISO(today, 1);
  const newDays = Math.max(1, Number(getSettings().booking_new_days) || 7);

  const legacyStatus = util.STATUSES.some((s) => s.value === query.status) ? query.status : '';
  let tab = BOOKING_TABS.some((t) => t.value === query.tab) ? query.tab : '';
  if (!tab && legacyStatus) tab = legacyStatus === 'completed' ? 'done' : legacyStatus;
  if (!tab) tab = 'all';

  const filters = {
    tab,
    kategori: str(query.kategori, 60),
    kota: int(query.kota) || '',
    tim: str(query.tim, 20),
    bayar: PAYMENT_FILTERS.some((p) => p.value === query.bayar) ? query.bayar : '',
    tanggal: isDate(query.tanggal) ? str(query.tanggal, 10) : '',
    dari: isDate(query.dari) ? str(query.dari, 10) : '',
    sampai: isDate(query.sampai) ? str(query.sampai, 10) : '',
    q: str(query.q, 60),
    view: BOOKING_VIEWS.includes(query.view) ? query.view : '',
    page: Math.max(1, int(query.page) || 1),
    bulan: /^\d{4}-\d{2}$/.test(String(query.bulan || '')) ? String(query.bulan) : today.slice(0, 7)
  };

  // Facets that apply to EVERY tab (so the tab counts stay meaningful).
  const base = [];
  const params = {};
  if (filters.kota) { base.push('b.city_id = :kota'); params.kota = filters.kota; }
  if (filters.kategori) { base.push('k.slug = :kategori'); params.kategori = filters.kategori; }
  if (filters.tim === 'none') base.push('b.team_member_id IS NULL');
  else if (filters.tim) { base.push('b.team_member_id = :tim'); params.tim = Number(filters.tim) || -1; }
  if (filters.tanggal) { base.push('b.shooting_date = :tanggal'); params.tanggal = filters.tanggal; }
  if (filters.dari) { base.push('b.shooting_date >= :dari'); params.dari = filters.dari; }
  if (filters.sampai) { base.push('b.shooting_date <= :sampai'); params.sampai = filters.sampai; }
  if (filters.q) {
    base.push('(LOWER(b.client_name) LIKE :q OR LOWER(b.code) LIKE :q OR b.client_phone LIKE :q OR LOWER(b.campus) LIKE :q)');
    params.q = `%${filters.q.toLowerCase()}%`;
  }

  const tabWhere = [];
  if (tab === 'today') { tabWhere.push("b.shooting_date = :today AND b.status <> 'cancelled'"); params.today = today; }
  else if (tab === 'tomorrow') { tabWhere.push("b.shooting_date = :tomorrow AND b.status <> 'cancelled'"); params.tomorrow = tomorrow; }
  else if (tab === 'new') { tabWhere.push("b.created_at >= datetime('now', :since)"); params.since = `-${newDays} days`; }
  else if (tab === 'pending') tabWhere.push("b.status = 'pending'");
  else if (tab === 'confirmed') tabWhere.push("b.status = 'confirmed'");
  else if (tab === 'ongoing') { tabWhere.push("b.status = 'confirmed' AND b.shooting_date = :today"); params.today = today; }
  else if (tab === 'reschedule') {
    // Booking yang punya pengajuan reschedule dari klien dan belum diputuskan.
    tabWhere.push("EXISTS (SELECT 1 FROM reschedule_requests rr WHERE rr.booking_id = b.id AND rr.status = 'pending')");
  }
  else if (tab === 'done') tabWhere.push("b.status = 'completed'");
  else if (tab === 'cancelled') tabWhere.push("b.status = 'cancelled'");

  return {
    filters,
    today,
    tomorrow,
    baseWhere: base,
    tabWhere,
    params,
    limit: 500
  };
}

const allBookingsFor = (q, where) => db.prepare(`${BOOKING_SELECT}
  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  ORDER BY b.shooting_date DESC, b.id DESC LIMIT ${q.limit}`).all(q.params);

/** Per-booking WhatsApp texts (both buttons are rendered from the database). */
function attachWhatsApp(rows, origin) {
  const settingsNow = getSettings();
  const confirmTemplate = String(settingsNow.wa_confirm_template || '').trim() || util.DEFAULT_CONFIRM_TEMPLATE;
  const portalTemplate = String(settingsNow.wa_portal_template || settingsNow.wa_selection_template || '').trim()
    || util.DEFAULT_PORTAL_LINK_TEMPLATE;
  const withPayment = (text) => text
    .replace(/\{\{\s*dp\s*\}\}/gi, 'Rp' + Number(settingsNow.payment_dp_amount || 100000).toLocaleString('id-ID'))
    .replace(/\{\{\s*bank\s*\}\}/gi, settingsNow.payment_bank_name || '-')
    .replace(/\{\{\s*rekening\s*\}\}/gi, settingsNow.payment_account_number || '-')
    .replace(/\{\{\s*atas_nama\s*\}\}/gi, settingsNow.payment_account_holder || '-');

  rows.forEach((b) => {
    const portalBase = `${origin || ''}/portal`;
    const directLink = b.selection_token ? `${selection.portalUrl(origin, b.selection_token)}` : '';
    const vars = util.bookingTemplateVars({
      ...b,
      portal_pin: b.portal_pin || '',
      shooting_date_label: b.shooting_date_label || (b.shooting_date ? util.formatDateID(b.shooting_date, true) : ''),
      // {{portal}} = halaman masuk Client Portal (kode + PIN), bukan link token.
      portal_url: portalBase
    });
    b.client_portal_url = portalBase;
    let confirmText = withPayment(util.renderTemplate(confirmTemplate, vars));
    // Template milik pemilik mungkin belum memuat akses portal. Tambahkan SATU blok akses
    // (kode + PIN + link) bila belum ada, supaya klien selalu menerima cara masuk portal
    // tanpa harus mengubah template yang sudah mereka pakai.
    // PIN kembali disimpan terbaca (permintaan pemilik) sehingga bisa selalu ikut
    // terkirim di pesan WhatsApp admin — tidak perlu menekan "Buat PIN" lebih dulu.
    const pinNow = /^\d{4}$/.test(String(b.portal_pin || '')) ? String(b.portal_pin) : '';
    if (!confirmText.includes(portalBase)) {
      confirmText += [
        '',
        '🔐 *Client Portal DLY Graduation*',
        `Kode Booking: ${b.code}`,
        ...(pinNow ? [`PIN: ${pinNow}`] : ['PIN: (menyusul dari admin)']),
        `Masuk di: ${portalBase}`,
        '',
        'Di portal kamu bisa melihat ringkasan, memilih foto favorit, memantau progres, dan mengambil foto final.'
      ].join('\n');
    }
    b.pin_fresh = Boolean(pinNow);
    b.wa_confirm_text = confirmText;

    if (b.selection_portal_id) {
      b.portal_url = selection.portalUrl(origin, b.selection_token);
      b.wa_portal_text = util.renderTemplate(portalTemplate, {
        ...vars,
        link: b.portal_url,
        kuota: String(b.selection_quota || ''),
        deadline: b.selection_deadline ? util.formatDateID(b.selection_deadline, true) : 'tanpa batas waktu'
      });
      b.portal_ready = Boolean(b.selection_photos);
    } else {
      b.portal_url = '';
      b.wa_portal_text = '';
      b.portal_ready = false;
    }
  });
  return rows;
}

/** Month grid (Mon-first not required — Indonesian calendars start on Sunday). */
function monthGrid(monthISO, events) {
  const [y, m] = monthISO.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startWeekday = first.getUTCDay(); // 0 = Sunday
  const byDate = new Map();
  events.forEach((b) => {
    if (!byDate.has(b.shooting_date)) byDate.set(b.shooting_date, []);
    byDate.get(b.shooting_date).push(b);
  });
  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push({ empty: true });
  for (let d = 1; d <= daysInMonth; d += 1) {
    const iso = `${monthISO}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, iso, events: byDate.get(iso) || [] });
  }
  while (cells.length % 7 !== 0) cells.push({ empty: true });
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

router.get('/bookings', (req, res) => {
  const q = bookingQuery(req.query);
  const filters = q.filters;

  // Every booking that matches the non-tab facets — used for the tab counters.
  const baseRows = allBookingsFor(q, q.baseWhere);
  const baseSummaries = payments.summariesFor(baseRows);

  const counts = { all: baseRows.length };
  BOOKING_TABS.forEach((t) => { counts[t.value] = 0; });
  baseRows.forEach((b) => {
    counts.all += 0;
    if (b.status === 'pending') counts.pending += 1;
    if (b.status === 'confirmed') counts.confirmed += 1;
    if (b.status === 'completed') counts.done += 1;
    if (b.status === 'cancelled') counts.cancelled += 1;
    if (b.shooting_date === q.today && b.status !== 'cancelled') counts.today += 1;
    if (b.shooting_date === q.tomorrow && b.status !== 'cancelled') counts.tomorrow += 1;
    if (Number(b.reschedule_pending) > 0) counts.reschedule += 1;
    if (b.status === 'confirmed' && b.shooting_date === q.today) counts.ongoing += 1;
    const days = Math.max(1, Number(getSettings().booking_new_days) || 7);
    const created = String(b.created_at || '');
    if (created) {
      const createdMs = Date.parse(created.replace(' ', 'T') + 'Z');
      if (Number.isFinite(createdMs) && (Date.now() - createdMs) <= days * 86400000) counts.new += 1;
    }
  });

  // Apply tab + payment facets.
  let rows = q.tabWhere.length ? allBookingsFor(q, q.baseWhere.concat(q.tabWhere)) : baseRows.slice();
  const summaries = q.tabWhere.length ? payments.summariesFor(rows) : baseSummaries;
  if (filters.bayar) {
    rows = rows.filter((b) => {
      const s = summaries.get(Number(b.id));
      const status = s ? s.status : 'unrecorded';
      return filters.bayar === 'none' ? status === 'unrecorded' : status === filters.bayar;
    });
  }
  rows.forEach((b) => { b.pay = summaries.get(Number(b.id)) || payments.summary(b); });

  attachWhatsApp(rows, res.locals.origin);

  const teamMembers = db.prepare('SELECT id, name, email FROM team_members WHERE is_active = 1 ORDER BY sort_order, name').all();
  const categories = util.getActiveCategories();

  // List view pagination (20 per page); grid/kanban show up to 60.
  const perPage = 20;
  let pageCount = 1;
  let listRows = rows;
  if (filters.view === 'list') {
    pageCount = Math.max(1, Math.ceil(rows.length / perPage));
    const page = Math.min(filters.page, pageCount);
    filters.page = page;
    listRows = rows.slice((page - 1) * perPage, page * perPage);
  }

  // Calendar needs the whole month, independent of the tab's date window.
  const calendarRows = (() => {
    if (filters.view !== 'calendar') return null;
    const monthRows = db.prepare(`${BOOKING_SELECT}
        WHERE b.shooting_date >= :from AND b.shooting_date <= :to
        ORDER BY b.shooting_time, b.id`)
      .all({ from: `${filters.bulan}-01`, to: `${filters.bulan}-31` });
    attachWhatsApp(monthRows, res.locals.origin);
    monthRows.forEach((b) => { b.pay = summaries.get(Number(b.id)) || payments.summary(b); });
    return monthRows;
  })();

  const today = q.today;
  const paidTotal = rows.reduce((sum, b) => sum + (b.pay ? b.pay.paid : 0), 0);
  const billTotal = rows.reduce((sum, b) => sum + ((b.pay && b.pay.total) || 0), 0);

  res.render('admin/bookings', {
    layout: 'admin/layout',
    title: 'Kelola Booking',
    pageTitle: 'Kelola Booking',
    teamMembers,
    categories,
    cities: util.getAllCities(),
    statuses: util.STATUSES,
    tabs: BOOKING_TABS,
    views: [
      { value: 'grid', label: 'Grid', icon: 'grid' },
      { value: 'calendar', label: 'Kalender', icon: 'calendar' },
      { value: 'list', label: 'Daftar', icon: 'list' },
      { value: 'kanban', label: 'Kanban', icon: 'kanban' }
    ],
    paymentFilters: PAYMENT_FILTERS,
    filters,
    counts,
    bookings: filters.view === 'list' ? listRows : (filters.view === 'kanban' ? rows : rows.slice(0, 60)),
    totalRows: rows.length,
    pageCount,
    calendarRows: calendarRows || [],
    calendarWeeks: calendarRows ? monthGrid(filters.bulan, calendarRows) : [],
    today,
    paidTotal,
    billTotal,
    selectionStatus: (row) => selection.deriveStatus(row.selection_status, row.selection_picks),
    selectionStatusLabel: (v) => selection.statusLabel(v),
    rupiah: util.rupiah,
    formatDateID: util.formatDateID,
    normalizePhone: util.normalizePhone
  });
});

/* ------------------------------------------------------------------ */
/* Tambah client manual (data booking lama / di luar formulir publik)  */
/* ------------------------------------------------------------------ */
/**
 * Form ini sengaja TIDAK memakai aturan ketersediaan publik: tanggal bebas
 * (termasuk tanggal yang sudah lewat, tanggal penuh, atau hari yang ditutup) karena
 * dipakai untuk memasukkan data klien yang sudah booking lebih dulu / sudah selesai.
 * Link folder Google Drive juga diisi manual (tidak memanggil API Drive).
 */
function manualBookingFormData(extra = {}) {
  const packages = db.prepare(`SELECT p.id, p.name, p.city_id, p.category_id,
                                      c.name AS city_name, k.name AS category_name
                               FROM packages p
                               JOIN cities c ON c.id = p.city_id
                               LEFT JOIN package_categories k ON k.id = p.category_id
                               WHERE p.is_active = 1 AND c.is_active = 1
                               ORDER BY c.name, k.sort_order, p.sort_order, p.id`).all()
    .map((p) => ({
      ...p,
      durations: db.prepare(`SELECT duration_minutes, price, edited_photos FROM package_durations
                             WHERE package_id = ? AND is_active = 1
                             ORDER BY duration_minutes`).all(p.id)
    }));
  return {
    packages,
    // 'pending' tidak dipakai di input manual: masa akses portal untuk booking pending
    // hanya 24 jam sejak booking dicatat, sedangkan data lama sengaja diberi tanggal
    // lampau sehingga portalnya akan langsung kedaluwarsa.
    statuses: util.MANUAL_STATUSES,
    today: util.todayISO(),
    values: { status: 'confirmed', booking_date: util.todayISO(), ...(extra.values || {}) },
    errors: extra.errors || []
  };
}

router.get('/bookings/new', (req, res) => {
  res.render('admin/booking-new', {
    layout: 'admin/layout',
    title: 'Tambah Client',
    pageTitle: 'Tambah Client Manual',
    ...manualBookingFormData(),
    csrf: res.locals.csrf,
    rupiah: util.rupiah
  });
});

router.post('/bookings/new', auth.verifyCsrf, (req, res) => {
  const body = req.body || {};
  const values = {
    client_name: str(body.client_name, 120),
    client_phone: str(body.client_phone, 30),
    instagram: str(body.instagram, 60).replace(/^@/, ''),
    campus: str(body.campus, 160),
    package_id: str(body.package_id, 20),
    minutes: str(body.minutes, 10),
    shooting_date: str(body.shooting_date, 10),
    shooting_time: str(body.shooting_time, 5),
    location: str(body.location, 160),
    location_address: str(body.location_address, 300),
    price: str(body.price, 20),
    status: util.MANUAL_STATUSES.some((s) => s.value === body.status) ? body.status : 'confirmed',
    drive_url: str(body.drive_url, 500),
    booking_date: str(body.booking_date, 10),
    internal_notes: str(body.internal_notes, 2000),
    notes: str(body.notes, 1000),
    terms: bool(body.terms_consent)
  };
  const errors = [];

  if (values.client_name.length < 3) errors.push('Nama lengkap wajib diisi (minimal 3 karakter).');
  const phone = util.normalizePhone(values.client_phone);
  if (!util.isValidPhone(values.client_phone)) errors.push('Nomor WhatsApp tidak valid. Contoh: 08123456789.');

  const pkg = values.package_id
    ? db.prepare(`SELECT p.*, c.name AS city_name FROM packages p JOIN cities c ON c.id = p.city_id
                  WHERE p.id = ? AND p.is_active = 1`).get(int(values.package_id))
    : null;
  if (!pkg) errors.push('Paket wajib dipilih.');

  const minutes = Number(values.minutes);
  const durationRow = pkg && Number.isInteger(minutes) && minutes > 0
    ? db.prepare(`SELECT * FROM package_durations WHERE package_id = ? AND duration_minutes = ? AND is_active = 1`)
      .get(pkg.id, minutes)
    : null;
  if (!Number.isInteger(minutes) || minutes <= 0) errors.push('Durasi sesi wajib dipilih.');
  else if (pkg && !durationRow) errors.push('Durasi itu tidak tersedia pada paket yang dipilih.');

  if (!isDate(values.shooting_date)) errors.push('Tanggal sesi wajib diisi (format YYYY-MM-DD).');
  if (!/^\d{2}:\d{2}$/.test(values.shooting_time)) errors.push('Jam sesi wajib diisi (format HH:MM).');
  if (values.location.length < 2) errors.push('Lokasi sesi wajib diisi.');
  if (values.booking_date && !isDate(values.booking_date)) errors.push('Tanggal booking tidak valid.');

  // Harga: pakai harga durasi, atau nominal manual bila admin mengisinya.
  const manualPrice = String(values.price || '').replace(/[^0-9]/g, '');
  let packagePrice = durationRow && durationRow.price != null && Number(durationRow.price) > 0
    ? Number(durationRow.price)
    : null;
  if (manualPrice) packagePrice = Number(manualPrice);
  if (!packagePrice) errors.push('Harga paket belum diatur. Isi kolom harga secara manual.');

  // Link Drive manual: disimpan sebagai folder utama booking (dipakai portal seleksi).
  let driveFolder = { id: '', url: '' };
  if (values.drive_url) {
    const parsed = drive.parseFolderId(values.drive_url);
    if (!parsed.ok) errors.push(parsed.message);
    else driveFolder = { id: parsed.id, url: `https://drive.google.com/drive/folders/${parsed.id}` };
  }

  if (errors.length) {
    return res.status(422).render('admin/booking-new', {
      layout: 'admin/layout',
      title: 'Tambah Client',
      pageTitle: 'Tambah Client Manual',
      ...manualBookingFormData({ values, errors }),
      csrf: res.locals.csrf,
      rupiah: util.rupiah
    });
  }

  const editedPhotos = durationRow && durationRow.edited_photos != null
    ? Number(durationRow.edited_photos)
    : (pkg.edited_photos != null ? Number(pkg.edited_photos) : null);
  const code = bookingcode.generate({ clientName: values.client_name, service: 'WISUDA' });
  const accessToken = util.randomToken(16);
  const createdAt = values.booking_date
    ? `${values.booking_date} ${new Date().toISOString().slice(11, 19)}`
    : null;

  let bookingId = 0;
  try {
    const info = db.prepare(`INSERT INTO bookings
        (code, access_token, client_name, client_phone, instagram, campus, city_id,
         shooting_date, shooting_time, location, location_address,
         package_id, category_id, duration, duration_minutes, price, package_price_snapshot,
         total_price_snapshot, edited_photos_snapshot, notes, internal_notes,
         terms_consent, terms_consent_at, status, confirmed_at, created_at,
         drive_folder_id, drive_folder_url, drive_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?)`)
      .run(code, accessToken, values.client_name, phone, values.instagram, values.campus,
        pkg.city_id, values.shooting_date, values.shooting_time, values.location,
        values.location_address, pkg.id, pkg.category_id, minutes, minutes, packagePrice,
        packagePrice, packagePrice, editedPhotos, values.notes, values.internal_notes,
        values.terms, values.terms ? new Date().toISOString() : null, values.status,
        values.status === 'confirmed' || values.status === 'completed'
          ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
        createdAt,
        driveFolder.id || null, driveFolder.url || null,
        driveFolder.id ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null);
    bookingId = Number(info.lastInsertRowid) || 0;
  } catch (err) {
    console.error('[admin] manual booking insert failed', err);
    return res.status(500).render('admin/booking-new', {
      layout: 'admin/layout',
      title: 'Tambah Client',
      pageTitle: 'Tambah Client Manual',
      ...manualBookingFormData({ values, errors: ['Booking gagal disimpan karena gangguan pada server. Coba lagi.'] }),
      csrf: res.locals.csrf,
      rupiah: util.rupiah
    });
  }

  // PIN portal langsung dibuat supaya admin bisa memberikan kode + PIN ke klien.
  const pin = portalAccess.ensurePin(bookingId);
  const event = { kind: 'note', actor: (req.admin && req.admin.username) || 'admin', note: 'Booking dibuat manual oleh admin' };
  try { payments.logEvent(bookingId, event); } catch (err) { /* log opsional */ }

  // Sengaja TIDAK menyinkronkan Google Calendar / membuat folder Drive otomatis:
  // data lama tidak perlu memicu undangan baru. Tombol sinkron tetap ada di detail booking.
  return res.redirect(back(req, `/admin/bookings/${bookingId}`, {
    msg: 'booking-created',
    note: `Kode ${code} · PIN portal ${pin}${driveFolder.id ? ' · link Drive tersimpan' : ''}`
  }));
});

/* ------------------------------------------------------------------ */
/* Detail booking (tab: klien / pekerjaan / pembayaran / workflow)     */
/* ------------------------------------------------------------------ */
router.get('/bookings/:id', (req, res) => {
  const booking = db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(int(req.params.id) || 0);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));

  // Portal: PIN selalu bisa ditampilkan di dashboard. `ensurePin` membuat PIN bila belum
  // ada (dan meng-upgrade baris lama yang hanya menyimpan hash dari V20).
  const ensuredPin = portalAccess.ensurePin(booking.id);
  if (ensuredPin) booking.portal_pin = ensuredPin;
  attachWhatsApp([booking], res.locals.origin);
  const pay = payments.summary(booking);
  const events = payments.eventsFor(booking.id, 80);
  let addons = [];
  try { addons = JSON.parse(booking.addons_snapshot || '[]'); } catch (err) { addons = []; }

  const settingsNow = getSettings();
  res.render('admin/booking-detail', {
    layout: 'admin/layout',
    title: `Booking ${booking.code}`,
    pageTitle: `Booking ${booking.code}`,
    booking,
    addons,
    pay,
    paymentsList: payments.paymentsFor(booking.id),
    events: events.map((e) => ({ ...e, description: payments.describeEvent(e) })),
    selectionStatus: selection.statusOf(selection.portalForBooking(booking.id)),
    selectionStatusLabel: (v) => selection.statusLabel(v),
    editingJob: editing.jobForBooking(booking.id),
    bookingTeam: team.membersFor(booking.id),
    upgradeRequests: upgrades.requestsFor(booking.id),
    upgradeStatus: upgrades.statusMeta,
    clientPortal: (() => {
      // PIN ditampilkan apa adanya di dashboard (keputusan pemilik).
      const pin = booking.portal_pin || '';
      const sel = selection.portalForBooking(booking.id);
      return {
        pin,
        code: booking.code || '',
        legacyCode: booking.legacy_code || '',
        url: `${res.locals.origin || ''}/portal`,
        directLink: sel ? `${res.locals.origin || ''}/selection/${sel.token}` : '',
        hasPin: portalAccess.hasPin(booking),
        finalUrl: booking.final_url || '',
        finalAt: booking.final_at || '',
        // Revisi: selama statusnya belum dikonfirmasi, kode + PIN hanya berlaku 24 jam.
        access: portalAccess.accessState(booking),
        accessHours: portalAccess.PENDING_ACCESS_HOURS,
        timeline: timeline.list(booking, { portal: sel })
      };
    })(),
    teamOptions: team.allMembers(),
    teamMissingEmail: team.membersFor(booking.id).filter((m) => !team.isValidEmail(m.email)),
    reschedules: db.prepare('SELECT * FROM booking_reschedules WHERE booking_id = ? ORDER BY id DESC').all(booking.id),
    // Revisi 4 — pengajuan reschedule dari klien (menunggu keputusan admin) + batas H-7.
    rescheduleRequests: reschedule.requestsFor(booking.id).map((r) => ({
      ...r,
      statusLabel: reschedule.statusMeta(r.status).label,
      tone: reschedule.statusMeta(r.status).tone
    })),
    rescheduleAccess: reschedule.accessState(booking),
    rescheduleHoldDays: reschedule.HOLD_DAYS,
    needsEvent: (booking.status === 'confirmed' || booking.status === 'completed') && !booking.gcal_event_id,
    editingStages: editing.STAGES,
    editingStageLabel: (v) => editing.stageLabel(v),
    statuses: util.STATUSES,
    // Template chat (editable admin) untuk teks WhatsApp reschedule.
    renderTemplate: util.renderTemplate,
    DEFAULT_RESCHEDULE_TEMPLATE: util.DEFAULT_RESCHEDULE_TEMPLATE,
    teamMembers: db.prepare('SELECT id, name, email FROM team_members WHERE is_active = 1 ORDER BY sort_order, name').all(),
    dpDefault: Number(settingsNow.payment_dp_amount) || 100000,
    todayISO: util.todayISO(),
    rupiah: util.rupiah,
    formatDateID: util.formatDateID,
    normalizePhone: util.normalizePhone,
    // v14: tab "Identitas Client" + "Detail Pekerjaan" digabung menjadi "Detail Booking".
    // URL lama (?tab=klien / ?tab=pekerjaan) tetap bekerja — penting untuk bookmark admin.
    tab: (() => {
      const raw = String(req.query.tab || '');
      if (raw === 'klien' || raw === 'pekerjaan') return 'detail';
      return ['detail', 'pembayaran', 'workflow'].includes(raw) ? raw : 'detail';
    })()
  });
});

/* ---- payments ---- */
/* ------------------------------------------------------------------ */
/* Booking operations (Tahap 7)                                       */
/* ------------------------------------------------------------------ */

/** Team editor (works before and after confirmation). */
router.post('/bookings/:id/team', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const ids = Array.isArray(req.body.member_ids) ? req.body.member_ids : [req.body.member_ids].filter(Boolean);
  const before = team.membersFor(bookingId).map((m) => Number(m.member_id));
  const result = team.setTeam(bookingId, ids, { actor: (req.admin && req.admin.username) || 'admin' });
  if (!result.ok) {
    return res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', err: result.message }));
  }

  const after = result.members.map((m) => Number(m.member_id));
  const changed = before.slice().sort().join(',') !== after.slice().sort().join(',');
  let syncNote = '';
  const booking = db.prepare('SELECT status, gcal_event_id FROM bookings WHERE id = ?').get(bookingId);

  // If the booking is already on the calendar, push the NEW attendee list into the SAME
  // event (Google adds the new members, removes the old ones, and emails the invitations).
  if (changed && booking && booking.gcal_event_id && (booking.status === 'confirmed' || booking.status === 'completed')) {
    const sync = await gcal.syncBooking(bookingId).catch((err) => ({ ok: false, error: err.message }));
    if (sync.ok) {
      syncNote = ` Event Google Calendar diperbarui (${sync.attendees || 'tanpa attendees'}).`;
    } else {
      syncNote = ` Perubahan tim tersimpan, tetapi event kalender GAGAL diperbarui: ${String(sync.error || sync.message || '').slice(0, 140)}`;
    }
  }

  const warn = result.missingEmail.length ? ` ${result.message}` : '';
  if (syncNote && !/berhasil|diperbarui/i.test(syncNote)) {
    return res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', err: (result.message + syncNote).slice(0, 280) }));
  }
  res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', msg: 'team-saved', note: (syncNote + warn).trim().slice(0, 280) }));
});

/**
 * One-click confirmation: status → confirmed, calendar event, Drive folder, activity log.
 * Idempotent: a second POST re-uses the stored event id / folder instead of duplicating.
 */
router.post('/bookings/:id/confirm', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const backTo = (params) => back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', ...params });
  const booking = db.prepare(`SELECT b.*, c.name AS city_name, p.name AS package_name
                              FROM bookings b JOIN cities c ON c.id = b.city_id
                              JOIN packages p ON p.id = b.package_id WHERE b.id = ?`).get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));

  // Revisi: tim dipilih dari SATU dropdown. Kalau form mengirim member_id, itu yang
  // dipakai (dan langsung disimpan bersama konfirmasi — tidak ada tombol simpan terpisah).
  const chosenMember = int(req.body.member_id) || 0;
  if (chosenMember) {
    const picked = db.prepare('SELECT id FROM team_members WHERE id = ? AND is_active = 1').get(chosenMember);
    if (!picked) return res.redirect(backTo({ err: 'Anggota tim yang dipilih tidak aktif atau tidak ditemukan.' }));
    const saved = team.setTeam(bookingId, [chosenMember], { actor: (req.admin && req.admin.username) || 'admin' });
    if (!saved.ok) return res.redirect(backTo({ err: saved.message }));
  }

  const members = team.membersFor(bookingId);
  if (!members.length) {
    return res.redirect(backTo({ err: 'Pilih anggota tim yang bertugas sebelum konfirmasi.' }));
  }
  if (booking.status === 'cancelled') {
    return res.redirect(backTo({ err: 'Booking yang dibatalkan tidak bisa dikonfirmasi. Ubah statusnya terlebih dahulu.' }));
  }

  // Availability re-check (admin may explicitly override a full/closed date).
  const override = String(req.body.allow_override || '') === '1';
  const map = util.availabilityForRange(booking.shooting_date, booking.shooting_date);
  const day = map[booking.shooting_date];
  if (day && !day.available && !override) {
    return res.redirect(backTo({
      err: `Tanggal ${util.formatDateID(booking.shooting_date)} berstatus ${day.status === 'closed' ? 'Ditutup' : 'Full Booking'}. Pilih tanggal lain lewat Reschedule, atau centang override dengan alasan.`
    }));
  }

  const notes = [];
  if (day && !day.available && override) {
    payments.logEvent(bookingId, {
      kind: 'note',
      actor: (req.admin && req.admin.username) || 'admin',
      note: `Override ketersediaan saat konfirmasi (${day.status}): ${str(req.body.override_reason, 160) || 'tanpa alasan'}`
    });
    notes.push('Override ketersediaan dicatat.');
  }

  // 1) status
  const wasConfirmed = booking.status === 'confirmed' || booking.status === 'completed';
  db.prepare(`UPDATE bookings SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, datetime('now')),
              updated_at = datetime('now') WHERE id = ?`).run(bookingId);
  if (!wasConfirmed) {
    payments.logEvent(bookingId, {
      kind: 'status', from: booking.status, to: 'confirmed',
      actor: (req.admin && req.admin.username) || 'admin', note: 'Booking dikonfirmasi admin'
    });
  }

  // Kode portal & PIN: pastikan ada supaya admin bisa langsung mengirim akses ke klien.
  const portalPin = portalAccess.ensurePin(bookingId);
  timeline.record(bookingId, 'confirmed', { actor: 'admin', note: 'Booking dikonfirmasi admin' });
  // Revisi 2: tahap 02 = "DP Terkonfirmasi" — dicatat otomatis saat pembayaran masuk
  // (timeline.firstPaymentAt), bukan lagi "Menunggu Sesi Pemotretan".
  if (portalPin) notes.push(`PIN portal: ${portalPin}`);

  // 2) Google Calendar + Drive (each service reports its own result)
  const sync = await gcal.syncBooking(bookingId).catch((err) => ({ ok: false, error: err.message }));
  if (sync.ok) {
    notes.push(sync.action === 'created' ? 'Event Google Calendar dibuat.' : 'Event Google Calendar diperbarui.');
    if (sync.attendees) notes.push(`Undangan ke: ${sync.attendees}.`);
  } else if (sync.skipped) {
    notes.push(`Google Calendar dilewati: ${String(sync.message || sync.reason || '').slice(0, 160)}`);
  } else {
    notes.push(`Google Calendar GAGAL: ${String(sync.error || sync.message || '').slice(0, 160)}`);
  }

  const drive = sync.drive || {};
  if (drive.ok) {
    notes.push(drive.cached ? 'Folder Google Drive sudah ada dan dipakai ulang.' : 'Folder Google Drive dibuat.');
  } else if (drive.error) {
    notes.push(`Google Drive GAGAL: ${String(drive.error).slice(0, 160)}`);
  }

  // Konfirmasi TIDAK mengirim ulang notifikasi "booking baru" ke admin (itu sudah dikirim
  // saat booking dibuat). Yang diberi tahu sekarang adalah CLIENT (event terpisah).
  push.notify('client_confirmed', {
    eventId: `booking:${bookingId}:confirmed`,
    bookingId,
    clientName: booking.client_name || '',
    campus: booking.campus || ''
  });

  const failed = (sync.ok === false && !sync.skipped) || drive.ok === false;
  res.redirect(back(req, `/admin/bookings/${bookingId}`, failed
    ? { tab: 'workflow', err: notes.join(' ') }
    : { tab: 'workflow', msg: 'booking-confirmed', note: notes.join(' ') }));
});

/** Re-point an existing event's attendees to the CURRENT crew (never creates a new event). */
router.post('/bookings/:id/resend-invites', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const result = await gcal.resendInvites(bookingId).catch((err) => ({ ok: false, error: err.message }));
  if (!result.ok) {
    return res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', err: String(result.message || result.error || 'Gagal mengirim undangan.').slice(0, 260) }));
  }
  payments.logEvent(bookingId, {
    kind: 'team', actor: (req.admin && req.admin.username) || 'admin',
    note: `Undangan kalender dikirim ulang ke ${result.emails.join(', ')}`.slice(0, 290)
  });
  res.redirect(back(req, `/admin/bookings/${bookingId}`, {
    tab: 'workflow', msg: 'invites-sent', note: `Penerima: ${result.emails.join(', ')}`
  }));
});

/* ---- Reschedule ---------------------------------------------------- */
const timeValid = reschedule.timeValid;

router.post('/bookings/:id/reschedule', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const backTo = (params) => back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', ...params });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));

  const result = await reschedule.applySchedule(booking, {
    date: str(req.body.shooting_date, 10),
    time: str(req.body.shooting_time, 5),
    location: str(req.body.location, 200),
    reason: str(req.body.reason, 200)
  }, {
    actor: (req.admin && req.admin.username) || 'admin',
    allowOverride: String(req.body.allow_override || '') === '1',
    conflictAck: String(req.body.conflict_ack || '') === '1',
    reason: str(req.body.reason, 200)
  });

  if (!result.ok) return res.redirect(backTo({ err: result.error }));

  // The booking change is saved no matter what Google answers — separate statuses.
  if (result.needsEvent && !result.sync.ok) {
    return res.redirect(backTo({
      err: `Jadwal baru TERSIMPAN (${util.formatDateID(result.schedule.date)} ${result.schedule.time}), tetapi `
        + `Google Calendar gagal diperbarui: ${String(result.sync.error || result.sync.message || '').slice(0, 160)}. `
        + 'Gunakan "Sinkronisasi Ulang".'
    }));
  }
  res.redirect(backTo({ msg: 'booking-rescheduled', note: result.note }));
});

/**
 * Setujui / tolak PENGAJUAN reschedule dari klien (portal).
 * Persetujuan memakai mesin yang sama dengan form admin di atas.
 */
router.post('/bookings/:id/reschedule-requests/:reqId/approve', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const backTo = (params) => back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', ...params });
  const result = await reschedule.approve(int(req.params.reqId), {
    actor: (req.admin && req.admin.username) || 'admin',
    note: str(req.body.admin_note, 300),
    allowOverride: String(req.body.allow_override || '') === '1'
  });
  if (!result.ok) return res.redirect(backTo({ err: result.error }));
  if (result.needsEvent && !result.sync.ok) {
    return res.redirect(backTo({
      note: `Pengajuan disetujui — jadwal baru ${util.formatDateID(result.schedule.date)} ${result.schedule.time} tersimpan.`,
      err: `Google Calendar gagal diperbarui: ${String(result.sync.error || result.sync.message || '').slice(0, 160)}. Gunakan "Sinkronisasi Ulang".`
    }));
  }
  res.redirect(backTo({
    msg: 'booking-rescheduled',
    note: `Pengajuan reschedule klien disetujui. ${result.note}`
  }));
});

router.post('/bookings/:id/reschedule-requests/:reqId/reject', auth.verifyCsrf, (req, res) => {
  const bookingId = int(req.params.id);
  const backTo = (params) => back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', ...params });
  const result = reschedule.reject(int(req.params.reqId), {
    actor: (req.admin && req.admin.username) || 'admin',
    note: str(req.body.admin_note, 300)
  });
  if (!result.ok) return res.redirect(backTo({ err: result.error }));
  res.redirect(backTo({ note: 'Pengajuan reschedule klien ditolak. Jadwal booking tidak berubah.' }));
});

/** Buka / tutup menu Reschedule di portal klien (melewati batas H-7). */
router.post('/bookings/:id/reschedule-access', auth.verifyCsrf, (req, res) => {
  const bookingId = int(req.params.id);
  const open = String(req.body.open || '') === '1';
  const result = reschedule.setOverride(bookingId, open, {
    actor: (req.admin && req.admin.username) || 'admin'
  });
  if (!result.ok) return res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', err: result.error }));
  res.redirect(back(req, `/admin/bookings/${bookingId}`, {
    tab: 'workflow',
    note: open
      ? 'Menu Reschedule di portal klien DIBUKA (klien bisa mengajukan jadwal baru walau sudah H-7).'
      : 'Menu Reschedule di portal klien ditutup kembali mengikuti batas H-7.'
  }));
});

/**
 * FASE 1 — "Foto Siap Dipilih".
 * Satu tombol untuk admin:
 *   1. memakai subfolder "01. FILE MENTAH" milik booking sebagai sumber foto;
 *   2. membuat portal seleksi bila belum ada;
 *   3. membaca ulang folder (foto baru masuk, pilihan klien tidak diubah);
 *   4. mencatat tahap 04 timeline;
 *   5. mengirim notifikasi "foto siap dipilih" ke klien.
 * Idempoten: menekan dua kali tidak menggandakan foto / tahap / notifikasi.
 */
router.post('/bookings/:id/photos-ready', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const backTo = (params) => back(req, `/admin/bookings/${bookingId}`, { tab: 'workflow', ...params });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));

  if (!(booking.status === 'confirmed' || booking.status === 'completed')) {
    return res.redirect(backTo({
      err: 'Konfirmasi booking dulu sebelum menandai foto siap dipilih.'
    }));
  }

  // Sumber foto: subfolder 01. FILE MENTAH. Bila belum tersimpan, minta sistem
  // menyiapkannya dari folder utama booking (tanpa rename / memindahkan file).
  let rawId = String(booking.drive_raw_id || '').trim();
  if (!rawId && booking.drive_folder_id) {
    try {
      const subs = await gcal.ensureSubfolders(booking.id, booking.drive_folder_id, {
        raw: booking.drive_raw_id, sortir: booking.drive_sortir_id, edit: booking.drive_edit_id
      });
      rawId = String((subs.ids && subs.ids.raw) || '').trim();
    } catch (err) { /* dilaporkan di bawah */ }
  }
  if (!rawId) {
    return res.redirect(backTo({
      err: 'Folder "01. FILE MENTAH" belum tersedia untuk booking ini. Buka tab Workflow → Siapkan Subfolder 01/02/03, '
        + 'atau sambungkan Google Drive terlebih dahulu.'
    }));
  }

  const rawUrl = `https://drive.google.com/drive/folders/${encodeURIComponent(rawId)}`;

  // Portal: pakai yang sudah ada, buat bila belum (kuota mengikuti paket).
  let portal = selection.portalForBooking(booking.id);
  const createdNow = !portal;
  if (!portal) {
    portal = selection.createForBooking(booking.id, {
      driveUrl: rawUrl,
      quota: selection.defaultQuota(booking.id)
    });
  }
  if (!portal) return res.redirect(backTo({ err: 'Portal seleksi foto gagal dibuat.' }));

  // Link Drive portal selalu menunjuk folder 01. FILE MENTAH (bukan field manual).
  db.prepare(`UPDATE photo_selections SET drive_url = ?, drive_show = 1, updated_at = datetime('now')
              WHERE id = ?`).run(rawUrl, portal.id);

  let total = 0;
  let added = 0;
  let truncated = false;
  try {
    const result = await selection.syncFromDrive(portal, rawId);
    total = result.total;
    added = result.added;
    truncated = result.truncated;
    selection.warmPreviewsInBackground(portal.id, { width: 320 });
  } catch (err) {
    return res.redirect(backTo({
      err: `Portal siap, tetapi folder "01. FILE MENTAH" belum bisa dibaca: ${str(err.message, 300)}`
    }));
  }

  // Tahap 04 timeline (idempoten) — dicatat sebagai aksi admin, bukan sistem.
  timeline.record(booking.id, 'photos_ready', {
    actor: 'admin',
    note: 'Foto mentah siap dipilih klien'
  });

  // Notifikasi ke klien (event id stabil → tidak pernah dobel untuk portal yang sama).
  if (total > 0) {
    push.notify('client_photos_ready', {
      eventId: `portal:${portal.id}:photos-ready`,
      bookingId: booking.id,
      clientName: booking.client_name || '',
      campus: booking.campus || ''
    });
  }

  const noteParts = [
    `${total} foto di folder 01. FILE MENTAH`,
    createdNow ? 'portal seleksi dibuat otomatis' : 'portal seleksi sudah ada',
    added ? `${added} foto baru` : '',
    total ? 'tahap "Foto Siap Dipilih" dicatat & notifikasi aplikasi dikirim ke klien' : ''
  ].filter(Boolean);
  return res.redirect(backTo({
    msg: 'selection-created',
    note: `${noteParts.join(' · ')}. `
      + 'Menu “Pilih Foto Favorit” di portal klien sekarang aktif. '
      + 'Tekan “Kirim Link Portal Seleksi Foto” untuk mengabari klien lewat WhatsApp.'
      + (truncated ? ' Folder sangat besar — tekan tombol ini lagi untuk sisa fotonya.' : '')
  }));
});

router.post('/bookings/:id/payments', auth.verifyCsrf, (req, res) => {
  const bookingId = int(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));

  const amount = int(req.body.amount);
  if (!amount || amount <= 0) {
    return res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'pembayaran', err: 'Nominal pembayaran harus lebih dari 0.' }));
  }
  const paymentId = payments.addPayment(bookingId, {
    amount,
    paidAt: req.body.paid_at || util.todayISO(),
    method: req.body.method,
    note: req.body.note
  });
  payments.logEvent(bookingId, {
    kind: 'payment',
    actor: (req.admin && req.admin.username) || 'admin',
    note: `Pembayaran ${util.rupiah(amount)} dicatat`
  });
  // Notifikasi admin: satu pembayaran = satu event_id (tidak pernah dobel).
  const bPay = db.prepare('SELECT client_name, campus FROM bookings WHERE id = ?').get(bookingId) || {};
  push.notify('payment', {
    eventId: `payment:${paymentId || bookingId}`,
    bookingId,
    clientName: bPay.client_name || '',
    campus: bPay.campus || '',
    amountLabel: util.rupiah(amount)
  });
  // Revisi 2 (03): client pemilik booking juga menerima kabar pembayaran/DP.
  // event_id sendiri (bukan sama dengan event admin) supaya dedupe per penerima.
  push.notify('client_payment', {
    eventId: `payment:${paymentId || bookingId}:client`,
    bookingId,
    clientName: bPay.client_name || '',
    campus: bPay.campus || '',
    amountLabel: util.rupiah(amount),
    paymentKind: 'manual'
  });
  res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'pembayaran', msg: 'booking-payment-saved' }));
});

/**
 * Quick payment buttons (Tahap 7): DP and Pelunasan with server-side amounts.
 * The client is never charged "automatically" — this only runs when the admin presses it.
 */
router.post('/bookings/:id/payments/quick', auth.verifyCsrf, (req, res) => {
  const bookingId = int(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));

  const pay = payments.summary(booking);
  const kind = String(req.body.kind || '');
  const settingsNow = getSettings();
  const dpDefault = Number(settingsNow.payment_dp_amount) || 100000;
  const remaining = pay.due;
  let amount = 0;

  if (kind === 'dp') amount = Math.min(dpDefault, remaining == null ? dpDefault : remaining) || dpDefault;
  else if (kind === 'settlement') amount = Number(remaining) || 0;
  else amount = int(req.body.amount) || 0;

  if (!amount || amount <= 0) {
    return res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'pembayaran', err: 'Nominal pembayaran tidak valid.' }));
  }
  // Never silently take more money than the bill.
  if (remaining != null && amount > remaining && String(req.body.allow_over || '') !== '1') {
    return res.redirect(back(req, `/admin/bookings/${bookingId}`, {
      tab: 'pembayaran',
      err: `Nominal ${util.rupiah(amount)} melebihi sisa tagihan ${util.rupiah(remaining)}. Centang "izinkan lebih" bila memang benar.`
    }));
  }

  const quickPaymentId = payments.addPayment(bookingId, {
    amount,
    paidAt: util.todayISO(),
    method: kind === 'dp' ? 'DP' : kind === 'settlement' ? 'Pelunasan' : str(req.body.method, 40),
    note: kind === 'dp' ? 'DP diterima' : kind === 'settlement' ? 'Pelunasan diterima' : str(req.body.note, 200),
    kind: kind === 'dp' ? 'dp' : kind === 'settlement' ? 'settlement' : 'manual'
  });
  payments.logEvent(bookingId, {
    kind: 'payment',
    actor: (req.admin && req.admin.username) || 'admin',
    note: `${kind === 'dp' ? 'DP' : kind === 'settlement' ? 'Pelunasan' : 'Pembayaran'} ${util.rupiah(amount)} dicatat`
  });
  push.notify('payment', {
    eventId: `payment:${quickPaymentId || bookingId}`,
    bookingId,
    clientName: booking.client_name || '',
    campus: booking.campus || '',
    amountLabel: util.rupiah(amount)
  });
  // Revisi 2 (03): kabar DP/pelunasan ke client pemilik booking (bukan broadcast).
  push.notify('client_payment', {
    eventId: `payment:${quickPaymentId || bookingId}:client`,
    bookingId,
    clientName: booking.client_name || '',
    campus: booking.campus || '',
    amountLabel: util.rupiah(amount),
    paymentKind: kind === 'dp' ? 'dp' : kind === 'settlement' ? 'settlement' : 'manual'
  });

  const after = payments.summary(db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId));
  res.redirect(back(req, `/admin/bookings/${bookingId}`, {
    tab: 'pembayaran',
    msg: 'payment-recorded',
    note: `${util.rupiah(amount)} dicatat. Total masuk ${util.rupiah(after.paid)} dari ${util.rupiah(after.total)} · sisa ${util.rupiah(after.due)} · status ${after.label}.`
  }));
});

router.post('/bookings/:id/payments/:paymentId/delete', auth.verifyCsrf, (req, res) => {
  const bookingId = int(req.params.id);
  const changes = payments.deletePayment(bookingId, int(req.params.paymentId));
  if (changes) {
    payments.logEvent(bookingId, {
      kind: 'payment-deleted',
      actor: (req.admin && req.admin.username) || 'admin',
      note: 'Catatan pembayaran dihapus'
    });
  }
  res.redirect(back(req, `/admin/bookings/${bookingId}`, { tab: 'pembayaran', msg: 'booking-payment-deleted' }));
});

/* ---- status change usable from Kanban (JSON) and detail page ---- */
router.post('/bookings/:id/status', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  const wantsJson = String(req.get('accept') || '').includes('application/json');
  if (!booking) {
    return wantsJson ? res.status(404).json({ ok: false, message: 'Booking tidak ditemukan.' })
      : res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));
  }
  const status = util.STATUSES.some((s) => s.value === req.body.status) ? req.body.status : '';
  if (!status) {
    return wantsJson ? res.status(422).json({ ok: false, message: 'Status tidak valid.' })
      : res.redirect(back(req, `/admin/bookings/${bookingId}`, { err: 'Status tidak valid.' }));
  }

  if (status !== booking.status) {
    db.prepare("UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, bookingId);
    payments.logEvent(bookingId, {
      kind: 'status',
      from: booking.status,
      to: status,
      actor: (req.admin && req.admin.username) || 'admin'
    });
    // Calendar sync never blocks the status change (same rule as the old update route).
    try { await gcal.syncBooking(bookingId); } catch (err) { /* recorded in gcal_error */ }
  }

  if (wantsJson) return res.json({ ok: true, status, code: booking.code });
  res.redirect(back(req, `/admin/bookings/${bookingId}`, { msg: 'booking-updated' }));
});

router.post('/bookings/:id/update', auth.verifyCsrf, async (req, res) => {
  const status = util.STATUSES.some((s) => s.value === req.body.status) ? req.body.status : 'pending';

  // Optional crew assignment: stored on the booking AND snapshotted so the calendar
  // description/invitee keeps the value even if the member is renamed later.
  let teamId = null;
  let teamName = '';
  let teamEmail = '';
  if (req.body.team_member_id) {
    const member = db.prepare('SELECT * FROM team_members WHERE id = ?').get(Number(req.body.team_member_id));
    if (member) {
      teamId = member.id;
      teamName = member.name || '';
      teamEmail = member.email || '';
    }
  }

  const before = db.prepare('SELECT * FROM bookings WHERE id = ?').get(int(req.params.id));
  db.prepare(`UPDATE bookings SET status = ?, internal_notes = ?,
              team_member_id = ?, team_name_snapshot = ?, team_email_snapshot = ?,
              updated_at = datetime('now') WHERE id = ?`)
    .run(status, str(req.body.internal_notes, 2000), teamId, teamName, teamEmail, req.params.id);

  // Activity history (Tahap 3): status / crew / note changes are all recorded.
  const actor = (req.admin && req.admin.username) || 'admin';
  if (before) {
    if (before.status !== status) {
      payments.logEvent(before.id, { kind: 'status', from: before.status, to: status, actor });
    }
    if (Number(before.team_member_id || 0) !== Number(teamId || 0)) {
      payments.logEvent(before.id, {
        kind: 'team', actor,
        note: teamName ? `Tim yang bertugas: ${teamName}` : 'Tim yang bertugas dikosongkan'
      });
    }
    const noteNow = str(req.body.internal_notes, 2000);
    if ((before.internal_notes || '') !== noteNow) {
      payments.logEvent(before.id, { kind: 'note', actor, note: 'Catatan internal diperbarui' });
    }
  }

  const filters = {
    status: req.body.back_status || undefined,
    kota: req.body.back_kota || undefined,
    dari: req.body.back_dari || undefined,
    sampai: req.body.back_sampai || undefined
  };
  // Saving from the detail page returns to the SAME tab (not always "klien").
  const detailTab = ['detail', 'klien', 'pekerjaan', 'pembayaran', 'workflow'].includes(req.body.back_tab)
    ? req.body.back_tab
    : '';
  const detailId = int(req.params.id);
  if (detailTab) filters.tab = detailTab;

  // Push the change to Google Calendar automatically (never blocks saving the status).
  let syncNote = null;
  try {
    const result = await gcal.syncBooking(Number(req.params.id));
    if (result.skipped && result.message) {
      // Do not fail silently: the event was NOT created and the admin must know why.
      syncNote = `Status tersimpan, tetapi event Google Calendar TIDAK dibuat. ${result.message}`;
    } else if (result.ok === false && !result.skipped) {
      syncNote = `Status tersimpan, tetapi sinkron kalender gagal: ${String(result.error || '').slice(0, 140)}`;
    } else if (result.drive && result.drive.ok === false) {
      syncNote = `Status tersimpan & kalender tersinkron, tetapi folder Drive gagal: ${String(result.drive.error || '').slice(0, 100)}`;
    } else if (result.ok && result.action === 'created') {
      syncNote = result.drive && result.drive.url
        ? `Status tersimpan. Event dibuat di Google Calendar dan folder Drive siap (${result.drive.path}).`
        : 'Status tersimpan dan event baru dibuat di Google Calendar.';
    } else if (result.ok && result.action === 'updated') {
      syncNote = 'Status tersimpan dan event Google Calendar diperbarui.';
    } else if (result.ok && result.action === 'removed') {
      syncNote = 'Status tersimpan dan event di Google Calendar dihapus (status belum dikonfirmasi).';
    }
  } catch (err) {
    syncNote = `Status tersimpan, sinkron kalender gagal: ${String(err.message).slice(0, 120)}`;
  }

  const landing = detailTab ? `/admin/bookings/${detailId}` : '/admin/bookings';
  if (syncNote) return res.redirect(back(req, landing, { ...filters, err: syncNote }));
  res.redirect(back(req, landing, { ...filters, msg: 'booking-updated' }));
});

router.post('/bookings/:id/delete', auth.verifyCsrf, async (req, res) => {
  const existing = gcal.loadBooking(Number(req.params.id));
  if (existing && existing.gcal_event_id && gcal.isActive()) {
    // Cancel first so the calendar does not keep an orphaned event.
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(existing.id);
    await gcal.syncBooking(existing.id);
  }
  // Drop the portal's cached previews before the cascade removes its rows.
  const portal = selection.portalForBooking(Number(req.params.id));
  if (portal) selection.photosFor(portal.id).forEach((p) => selection.dropPreview(p.id));
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/bookings', { msg: 'booking-deleted' }));
});

/* ------------------------------------------------------------------ */
/* Client Portal — admin (PIN, kode, selesaikan order)                 */
/* ------------------------------------------------------------------ */

/** Buat / tampilkan PIN portal. PIN hanya ditampilkan di halaman admin ini. */
router.post('/bookings/:id/portal-pin', auth.verifyCsrf, (req, res) => {
  const bookingId = int(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));
  const reset = String(req.body.reset || '') === '1';
  const pin = reset ? portalAccess.resetPin(bookingId) : portalAccess.ensurePin(bookingId);
  if (!pin) {
    return res.redirect(back(req, `/admin/bookings/${bookingId}`, {
      tab: 'workflow', err: 'PIN gagal dibuat. Coba lagi.'
    }));
  }
  // Reset PIN juga memutus sesi portal yang sedang aktif.
  if (reset) portalAccess.destroySessionsFor(bookingId);
  payments.logEvent(bookingId, {
    kind: 'note',
    actor: (req.admin && req.admin.username) || 'admin',
    note: reset ? 'PIN portal direset' : 'PIN portal dibuat'
  });
  res.redirect(back(req, `/admin/bookings/${bookingId}`, {
    tab: 'workflow',
    msg: reset ? 'portal-pin-reset' : 'portal-pin-created',
    note: `PIN portal: ${pin} — kirim ke klien lewat WhatsApp.`
  }));
});

/** Buat ulang kode booking (format baru). Kode lama tetap jadi alias. */
router.post('/bookings/:id/new-code', auth.verifyCsrf, (req, res) => {
  const bookingId = int(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));
  const code = bookingcode.generate({ clientName: booking.client_name, service: 'WISUDA', excludeBookingId: bookingId });
  db.prepare(`UPDATE bookings SET code = ?, legacy_code = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(code, booking.code, bookingId);
  payments.logEvent(bookingId, {
    kind: 'note',
    actor: (req.admin && req.admin.username) || 'admin',
    note: `Kode booking baru: ${code} (kode lama ${booking.code} tetap berlaku sebagai alias)`
  });
  res.redirect(back(req, `/admin/bookings/${bookingId}`, {
    tab: 'workflow', msg: 'booking-code-regenerated', note: `Kode baru: ${code}`
  }));
});

/** Selesaikan Order: simpan link Drive final + catat tahap 08 di timeline. */
/**
 * Siapkan subfolder 01/02/03 di folder Drive booking (folder lama tetap dipakai,
 * file tidak dipindah, nama folder tidak diubah).
 */
router.post('/bookings/:id/drive-subfolders', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));
  if (!booking.drive_folder_id) {
    return res.redirect(back(req, `/admin/bookings/${bookingId}`, {
      tab: 'workflow', err: 'Folder Drive booking ini belum ada. Buat folder dulu (Sinkronisasi Ulang Google Calendar).'
    }));
  }
  try {
    const result = await gcal.ensureSubfolders(bookingId, booking.drive_folder_id, {
      raw: booking.drive_raw_id, sortir: booking.drive_sortir_id, edit: booking.drive_edit_id
    });
    payments.logEvent(bookingId, {
      kind: 'note', actor: (req.admin && req.admin.username) || 'admin',
      note: `Subfolder Drive 01/02/03 disiapkan (${result.created} dibuat baru)`
    });
    res.redirect(back(req, `/admin/bookings/${bookingId}`, {
      tab: 'workflow',
      note: `Subfolder Drive siap: 01. FILE MENTAH, 02. FILE SORTIR, 03. FILE EDIT${result.created ? ` (${result.created} baru dibuat)` : ' (sudah ada)'}.`
    }));
  } catch (err) {
    res.redirect(back(req, `/admin/bookings/${bookingId}`, {
      tab: 'workflow', err: `Gagal menyiapkan subfolder: ${String(err.message).slice(0, 160)}`
    }));
  }
});

router.post('/bookings/:id/complete-order', auth.verifyCsrf, async (req, res) => {
  const bookingId = int(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));

  const backTo = `/admin/bookings/${bookingId}`;
  const actor = (req.admin && req.admin.username) || 'admin';

  // "Batalkan selesai": hanya mengosongkan status final, folder Drive tidak disentuh.
  if (String(req.body.clear || '') === '1') {
    orderCompletion.clearFinal(bookingId, { actor });
    return res.redirect(back(req, backTo, { tab: 'workflow', msg: 'booking-final-cleared' }));
  }

  // Satu jalur logika dengan tombol SELESAI di Antrean Editing (src/ordercompletion.js):
  // link final = folder UTAMA booking (bukan subfolder 03), divalidasi ke Google, dan
  // order TIDAK ditandai selesai bila folder tidak terbukti ada.
  const result = await orderCompletion.completeOrder(bookingId, { actor, source: 'booking' });
  if (!result.ok) {
    return res.redirect(back(req, backTo, { tab: 'workflow', err: result.message }));
  }
  res.redirect(back(req, backTo, { tab: 'workflow', msg: 'booking-final-saved' }));
});

/* ------------------------------------------------------------------ */
/* Notification centre (Tahap 4)                                       */
/* ------------------------------------------------------------------ */
// Items are derived from the database on every request (src/notify.js), so a deleted
// booking disappears from the list instead of leaving a dead notification behind.
router.get('/notifications', (req, res) => {
  const type = notify.TYPES.some((t) => t.value === req.query.tipe) ? String(req.query.tipe) : '';
  const onlyUnread = req.query.baca === 'belum';
  const data = notify.feed({ type, limit: 200 });
  const items = onlyUnread ? data.items.filter((i) => i.unread) : data.items;

  res.render('admin/notifications', {
    layout: 'admin/layout',
    title: 'Notifikasi',
    pageTitle: 'Notifikasi',
    types: notify.TYPES,
    items,
    counts: data.counts,
    unread: data.unread,
    total: data.total,
    seenAt: data.seenAt,
    filterType: type,
    onlyUnread
  });
});

router.post('/notifications/read', auth.verifyCsrf, (req, res) => {
  notify.markAllRead();
  const backTo = req.body.back === 'unread' ? '/admin/notifications?baca=belum' : '/admin/notifications';
  res.redirect(back(req, backTo, { msg: 'notifications-read' }));
});

/* ------------------------------------------------------------------ */
/* Web Push — device notifications (Tahap 6)                           */
/* ------------------------------------------------------------------ */
// The page works on every browser; on iOS it explains that Safari only allows Web Push
// after the site is added to the Home Screen (iOS 16.4+).
router.get('/push', (req, res) => {
  const cfg = push.config();
  res.render('admin/push', {
    layout: 'admin/layout',
    title: 'Notifikasi HP',
    pageTitle: 'Notifikasi HP',
    publicKey: cfg.publicKey,
    vapidOk: cfg.ok,
    enabled: push.isEnabled(),
    // Event dikelompokkan per ROLE supaya jelas siapa menerima apa.
    eventGroups: [
      {
        role: 'admin',
        label: 'Admin (operasional)',
        items: Object.entries(push.EVENTS).filter(([, d]) => d.role === 'admin').map(([value, d]) => ({
          value, title: d.label || d.title, setting: d.setting, enabled: getSettings()[d.setting] !== '0'
        }))
      },
      {
        role: 'client',
        label: 'Client (hanya booking miliknya)',
        items: Object.entries(push.EVENTS).filter(([, d]) => d.role === 'client').map(([value, d]) => ({
          value, title: d.label || d.title, setting: d.setting, enabled: getSettings()[d.setting] !== '0'
        }))
      }
    ],
    // Role yang disiapkan tetapi BELUM mengirim (Team Portal belum ada).
    preparedRoles: push.PREPARED_ROLES,
    deliveries: push.recentDeliveries(40),
    clientDevices: push.deviceCount('client'),
    adminDeviceCount: push.deviceCount('admin'),
    devices: push.devices(),
    activeDevices: push.deviceCount(),
    lastRunAt: getSettings().push_last_run_at || '',
    subject: getSettings().push_vapid_subject || ''
  });
});

router.post('/push/settings', auth.verifyCsrf, (req, res) => {
  const values = { push_enabled: req.body.push_enabled ? '1' : '0' };
  Object.entries(push.EVENTS).forEach(([kind, def]) => {
    values[def.setting] = req.body[def.setting] ? '1' : '0';
  });
  const subject = str(req.body.push_vapid_subject, 120);
  if (subject) values.push_vapid_subject = subject;
  saveSettings(values);
  res.redirect(back(req, '/admin/push', { msg: 'push-settings-saved' }));
});

// Subscribe: called by the admin page AFTER the user pressed the button (never on load).
router.post('/push/subscribe', auth.verifyCsrf, (req, res) => {
  try {
    const result = push.saveSubscription(req.body.subscription || {}, {
      userAgent: req.get('user-agent'),
      platform: req.body.platform,
      label: req.body.label
    });
    res.json({ ok: true, created: result.created, devices: push.deviceCount() });
  } catch (err) {
    res.status(err.status || 422).json({ ok: false, message: err.message });
  }
});

router.post('/push/unsubscribe', auth.verifyCsrf, (req, res) => {
  const endpoint = (req.body.subscription && req.body.subscription.endpoint)
    || req.body.endpoint || '';
  const removed = push.removeByEndpoint(endpoint);
  res.json({ ok: true, removed, devices: push.deviceCount() });
});

router.post('/push/test', auth.verifyCsrf, async (req, res) => {
  if (!push.deviceCount()) return res.redirect(back(req, '/admin/push', { err: 'Belum ada perangkat terhubung. Aktifkan notifikasi di HP Anda terlebih dahulu.' }));
  // Test notification HANYA dari tombol ini (tidak ada jalur otomatis).
  const result = await push.sendTest({ url: '/admin/notifications' })
    .catch((err) => ({ ok: false, sent: 0, failed: 1, error: err.message }));
  if (!result.sent) {
    return res.redirect(back(req, '/admin/push', {
      err: `Percobaan terkirim 0 perangkat (gagal ${result.failed || 0}, tidak berlaku ${result.gone || 0}). Periksa daftar perangkat di bawah.`
    }));
  }
  res.redirect(back(req, '/admin/push', { note: `Notifikasi percobaan terkirim ke ${result.sent} perangkat.` }));
});

router.post('/push/devices/:id/delete', auth.verifyCsrf, (req, res) => {
  push.removeDevice(int(req.params.id));
  res.redirect(back(req, '/admin/push', { msg: 'push-device-deleted' }));
});

router.post('/push/devices/:id/toggle', auth.verifyCsrf, (req, res) => {
  const device = db.prepare('SELECT is_active FROM push_subscriptions WHERE id = ?').get(int(req.params.id));
  if (device) push.setDeviceActive(int(req.params.id), !Number(device.is_active));
  res.redirect(back(req, '/admin/push', { msg: 'push-device-toggled' }));
});

// Regenerating VAPID keys invalidates every existing subscription — explicit and confirmed.
router.post('/push/keys/reset', auth.verifyCsrf, (req, res) => {
  const pair = require('web-push').generateVAPIDKeys();
  saveSettings({ push_vapid_public: pair.publicKey, push_vapid_private: pair.privateKey });
  push.resetConfig(); // the module caches the VAPID config for the process lifetime
  res.redirect(back(req, '/admin/push', { msg: 'push-keys-reset' }));
});

/* ------------------------------------------------------------------ */
/* Editing queue (Tahap 5)                                             */
/* ------------------------------------------------------------------ */
// Three stages: Masuk Antrean → Diedit → Selesai. Moving a card is validated server-side
// and mirrors the CLIENT-facing portal status (editing → Sedang Diproses, done → Selesai).
router.get('/editing', (req, res) => {
  // Revisi 2 (07): papan operasional disederhanakan menjadi DUA kolom.
  // Status internal (queued/editing) tetap dipakai timeline client, tetapi kolom
  // "Antrean Editing" menampung keduanya. Urutan kartu = posisi antrean sebenarnya.
  editing.refreshActive();
  const data = editing.board({ doneLimit: 30 });
  res.render('admin/editing', {
    layout: 'admin/layout',
    title: 'Antrean Editing',
    pageTitle: 'Antrean Editing',
    columns: [
      { value: 'active', label: 'Antrean Editing', tone: 'warn', items: data.active },
      { value: 'done', label: 'Selesai', tone: 'ok', items: data.done }
    ],
    stages: editing.STAGES,
    stats: editing.stats(),
    doneTotal: data.doneTotal,
    todayISO: util.todayISO(),
    formatDateID: util.formatDateID
  });
});

/**
 * Tombol SELESAI di antrean (revisi 2).
 *
 * Server memastikan link Google Drive folder booking SUDAH ada & valid sebelum order
 * boleh selesai — validasi yang sama dengan "Selesaikan Order" di Detail Booking.
 * Setelah valid: status order selesai, kartu pindah ke kolom Selesai, timeline client
 * diperbarui (tahap 08), dan notifikasi "Editan kamu sudah selesai" terkirim.
 */
router.post('/editing/:id/finish', auth.verifyCsrf, async (req, res) => {
  const job = editing.jobById(int(req.params.id));
  if (!job) return res.redirect(back(req, '/admin/editing', { err: 'Job editing tidak ditemukan.' }));
  if (job.status === 'done') {
    return res.redirect(back(req, '/admin/editing', { msg: 'editing-already-done' }));
  }

  const actor = (req.admin && req.admin.username) || 'admin';
  const result = await orderCompletion.completeOrder(job.booking_id, { actor, source: 'queue' });
  if (!result.ok) {
    // Order TIDAK ditandai selesai; kartu tetap di Antrean Editing.
    return res.redirect(back(req, '/admin/editing', { err: result.message }));
  }

  editing.setStatus(job.id, 'done', { actor });
  res.redirect(back(req, '/admin/editing', {
    msg: 'editing-finished',
    note: `Order ${job.code} selesai. Link Google Drive & tombol ulasan sudah aktif di portal client${result.already ? ' (link final tidak berubah)' : ''}.`
  }));
});

router.post('/editing/:id/status', auth.verifyCsrf, (req, res) => {
  const wantsJson = String(req.get('accept') || '').includes('application/json');
  const result = editing.setStatus(int(req.params.id), String(req.body.status || ''), {
    actor: (req.admin && req.admin.username) || 'admin'
  });
  if (result.ok && !result.unchanged && result.job.status === 'done') {
    // Hanya job yang SELESAI yang layak dinotifikasi (bukan setiap perpindahan tahap).
    push.notify('editing', {
      eventId: `editing:${result.job.id}:done`,
      bookingId: result.job.booking_id,
      clientName: result.job.client_name || '',
      campus: result.job.city_name || ''
    });
  }
  if (wantsJson) {
    return result.ok
      ? res.json({ ok: true, status: result.job.status, label: editing.stageLabel(result.job.status), code: result.job.code })
      : res.status(422).json({ ok: false, message: result.message });
  }
  if (!result.ok) return res.redirect(back(req, '/admin/editing', { err: result.message }));
  res.redirect(back(req, '/admin/editing', { msg: 'editing-saved' }));
});

router.post('/editing/:id', auth.verifyCsrf, (req, res) => {
  const result = editing.update(int(req.params.id), {
    dueAt: req.body.due_at,
    note: req.body.note
  });
  if (!result.ok) return res.redirect(back(req, '/admin/editing', { err: result.message }));
  res.redirect(back(req, '/admin/editing', { msg: 'editing-saved' }));
});

router.post('/editing/:id/delete', auth.verifyCsrf, (req, res) => {
  const result = editing.remove(int(req.params.id), { actor: (req.admin && req.admin.username) || 'admin' });
  if (!result.ok) return res.redirect(back(req, '/admin/editing', { err: result.message }));
  res.redirect(back(req, '/admin/editing', { msg: 'editing-deleted' }));
});

// Queue a booking (idempotent — pressing it twice never creates a second active job).
router.post('/bookings/:id/editing', auth.verifyCsrf, (req, res) => {
  const result = editing.enqueue(int(req.params.id), { actor: (req.admin && req.admin.username) || 'admin' });
  const target = `/admin/bookings/${int(req.params.id)}`;
  if (!result.ok) return res.redirect(back(req, target, { tab: 'workflow', err: result.message }));
  res.redirect(back(req, target, { tab: 'workflow', msg: result.created ? 'editing-queued' : 'editing-already' }));
});

/* ------------------------------------------------------------------ */
/* Client photo-selection portal (V9)                                  */
/* ------------------------------------------------------------------ */
// Photo uploads are bigger than the CMS images and arrive in batches.
const selectionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});
const wrapSelectionUpload = (field, max) => (req, res, next) => {
  selectionUpload.array(field, max)(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'Ukuran tiap foto maksimal 15MB.'
      : 'Gagal mengunggah foto. Coba unggah lebih sedikit sekaligus.';
    const referer = req.get('referer') || `${req.basePath}/admin/selection`;
    res.redirect(`${referer}${referer.includes('?') ? '&' : '?'}err=${encodeURIComponent(msg)}`);
  });
};

const selectionPortalOr404 = (req) => selection.portalById(Number(req.params.id));

router.get('/selection', (req, res) => {
  const wanted = selection.STATUSES.some((s) => s.value === req.query.status) ? req.query.status : '';
  const q = str(req.query.q, 60).toLowerCase();

  const rows = db.prepare(`SELECT b.id AS booking_id, b.code, b.client_name, b.shooting_date,
                                  b.shooting_time, b.status AS booking_status,
                                  p.name AS package_name, c.name AS city_name,
                                  ps.id AS portal_id, ps.status AS portal_status, ps.quota,
                                  ps.is_open, ps.deadline, ps.submitted_at,
                                  (SELECT COUNT(*) FROM photo_selection_photos ph
                                    WHERE ph.portal_id = ps.id) AS photo_count,
                                  (SELECT COUNT(*) FROM photo_selection_picks pk
                                    WHERE pk.portal_id = ps.id) AS pick_count
                           FROM bookings b
                           JOIN packages p ON p.id = b.package_id
                           JOIN cities c ON c.id = b.city_id
                           LEFT JOIN photo_selections ps ON ps.booking_id = b.id
                           ORDER BY b.shooting_date DESC, b.id DESC LIMIT 400`).all()
    .map((r) => ({ ...r, status: selection.deriveStatus(r.portal_status, r.pick_count) }))
    .filter((r) => (!wanted || r.status === wanted))
    .filter((r) => !q
      || String(r.client_name || '').toLowerCase().includes(q)
      || String(r.code || '').toLowerCase().includes(q));

  const all = db.prepare(`SELECT ps.status, ps.id,
                                 (SELECT COUNT(*) FROM photo_selection_picks pk WHERE pk.portal_id = ps.id) AS pick_count
                          FROM photo_selections ps`).all();
  const counts = { none: 0 };
  selection.STATUSES.forEach((s) => { counts[s.value] = 0; });
  const totalBookings = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
  counts.none = totalBookings - all.length;
  all.forEach((p) => {
    const derived = selection.deriveStatus(p.status, p.pick_count);
    counts[derived] = (counts[derived] || 0) + 1;
  });

  res.render('admin/selection-list', {
    layout: 'admin/layout',
    title: 'Seleksi Foto',
    pageTitle: 'Seleksi Foto',
    rows,
    counts,
    statuses: selection.STATUSES,
    activeStatus: wanted,
    query: req.query.q || '',
    total: totalBookings
  });
});

// Creates the portal for a booking (idempotent) and jumps straight to its editor.
router.post('/selection/create', auth.verifyCsrf, (req, res) => {
  const bookingId = Number(req.body.booking_id);
  const booking = db.prepare('SELECT id FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));
  const portal = selection.createForBooking(booking.id);
  if (!portal) return res.redirect(back(req, '/admin/bookings', { err: 'Portal seleksi gagal dibuat.' }));
  res.redirect(back(req, `/admin/selection/${portal.id}`, { msg: 'selection-created' }));
});

/* ---- Portal settings (must be declared before /selection/:id) ------ */
router.get('/selection/settings', (req, res) => {
  const s = getSettings();
  const cfg = drive.config();
  res.render('admin/selection-settings', {
    layout: 'admin/layout',
    title: 'Pengaturan Seleksi Foto',
    pageTitle: 'Pengaturan Seleksi Foto',
    driveMode: drive.mode(cfg),
    driveCfg: cfg,
    driveAutoTest: null,
    selection: {
      defaultQuota: Number(s.selection_default_quota) || 40,
      defaultDays: Number(s.selection_default_days) || 14,
      allowDownload: s.selection_allow_download === '1',
      requireFullQuota: s.selection_require_full_quota === '1',
      ttlDays: Number(s.selection_portal_ttl_days) || 0,
      brandName: s.selection_brand_name || '',
      brandNote: s.selection_brand_note || '',
      logo: s.selection_portal_logo || '',
      watermark: s.selection_watermark !== '0',
      instructions: s.selection_default_instructions || ''
    },
    brandNameFallback: s.brand_name || 'DLY Graduation',
    waNumber: s.whatsapp_number || '',
    dpAmount: Number(s.payment_dp_amount) || 100000,
    bankName: s.payment_bank_name || '',
    accountNumber: s.payment_account_number || ''
  });
});

router.post('/selection/settings', wrapUpload('logo_file'), auth.verifyCsrf, async (req, res) => {
  // Same trap as the Google page: a Client ID pasted into a Secret field.
  const readerSecret = str(req.body.reader_client_secret, 200);
  if (readerSecret && (/apps\.googleusercontent\.com\s*$/i.test(readerSecret) || /^\d{10,}-/.test(readerSecret) || readerSecret.length > 80)) {
    return res.redirect(back(req, '/admin/selection/settings', {
      err: 'Client Secret Drive ditolak: isian itu terlihat seperti Client ID. Salin dari kolom "Client secret" (biasanya diawali GOCSPX-).'
    }));
  }
  const pairs = {
    selection_default_quota: String(Math.min(Math.max(int(req.body.default_quota) || 40, 1), 500)),
    selection_default_days: String(Math.min(Math.max(int(req.body.default_days) || 0, 0), 365)),
    selection_allow_download: req.body.allow_download ? '1' : '0',
    selection_require_full_quota: req.body.require_full_quota ? '1' : '0',
    selection_portal_ttl_days: String(Math.min(Math.max(int(req.body.ttl_days) || 0, 0), 365)),
    selection_brand_name: str(req.body.brand_name, 60),
    selection_brand_note: str(req.body.brand_note, 160),
    selection_watermark: req.body.watermark ? '1' : '0',
    selection_default_instructions: str(req.body.instructions, 3000),
    gdrive_api_key: str(req.body.api_key, 200),
    gdrive_reader_client_id: str(req.body.reader_client_id, 200),
    ...(readerSecret ? { gdrive_reader_client_secret: readerSecret } : {})
  };
  // Logo upload (optional) — same media pipeline as the rest of the CMS.
  if (req.file && req.file.buffer && req.file.buffer.length) {
    try {
      const { src } = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
      pairs.selection_portal_logo = src;
    } catch (err) {
      return res.redirect(back(req, '/admin/selection/settings', { err: err.message }));
    }
  }
  if (req.body.remove_logo) pairs.selection_portal_logo = '';
  saveSettings(pairs);
  drive.resetTokenCache();
  return res.redirect(back(req, '/admin/selection/settings', { msg: 'selection-settings-saved' }));
});

router.post('/selection/settings/test', auth.verifyCsrf, async (req, res) => {
  const result = await drive.selfCheck();
  if (result.ok) {
    return res.redirect(back(req, '/admin/selection/settings', {
      msg: 'selection-settings-saved',
      note: `Akses baca Drive OK (${result.mode === 'oauth' ? 'akun ' + (result.email || 'terhubung') : 'API key'}).`
    }));
  }
  res.redirect(back(req, '/admin/selection/settings', { err: result.message || 'Gagal mengakses Google Drive.' }));
});

router.get('/selection/drive/connect', (req, res) => {
  const cfg = drive.config();
  if (!cfg.clientId || !cfg.clientSecret) {
    return res.redirect(back(req, '/admin/selection/settings', {
      err: 'Isi Client ID & Client Secret (boleh memakai client Drive/Calendar yang sudah ada) sebelum menghubungkan akun.'
    }));
  }
  const state = drive.createState();
  res.redirect(drive.buildAuthUrl(state, gcal.redirectUri(req)));
});

router.post('/selection/drive/disconnect', auth.verifyCsrf, (req, res) => {
  saveSettings({ gdrive_reader_refresh_token: '', gdrive_reader_account: '', gdrive_reader_connected_at: '' });
  drive.resetTokenCache();
  res.redirect(back(req, '/admin/selection/settings', { msg: 'selection-settings-saved' }));
});

/* ---- "Buat Portal Seleksi Foto" wizard (per booking) --------------- */
function renderPortalWizard(req, res, extra = {}) {
  const bookingId = Number(req.params.id);
  const booking = db.prepare(`SELECT b.*, c.name AS city_name, p.name AS package_name
                              FROM bookings b
                              JOIN cities c ON c.id = b.city_id
                              JOIN packages p ON p.id = b.package_id
                              WHERE b.id = ?`).get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));
  const existing = selection.portalForBooking(booking.id);
  if (existing && !extra.forceForm) {
    return res.redirect(back(req, `/admin/selection/${existing.id}`));
  }
  // Revisi 4 — sumber foto OTOMATIS: subfolder "01. FILE MENTAH" milik booking ini.
  // Link-nya tidak perlu (dan tidak boleh) diketik admin lagi.
  const rawFolderUrl = booking.drive_raw_id
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(booking.drive_raw_id)}`
    : '';
  const defaults = {
    driveUrl: rawFolderUrl || (booking.drive_folder_url || ''),
    quota: selection.defaultQuota(booking.id),
    deadline: selection.defaultDeadline() || '',
    allowDownload: getSettings().selection_allow_download === '1',
    requireFullQuota: getSettings().selection_require_full_quota === '1'
  };
  return res.render('admin/selection-new', {
    layout: 'admin/layout',
    title: 'Buat Portal Seleksi Foto',
    pageTitle: 'Buat Portal Seleksi Foto',
    booking,
    existing,
    values: { ...defaults, ...(extra.values || {}) },
    probe: extra.probe || null,
    error: extra.error || '',
    driveMode: drive.mode(),
    hasFolderFromBooking: Boolean(booking.drive_folder_url),
    // Sumber otomatis (01. FILE MENTAH) → field link dibuat read-only.
    rawFolderUrl,
    rawFolderId: booking.drive_raw_id || '',
    autoSource: Boolean(rawFolderUrl),
    formatDateID: util.formatDateID
  });
}

router.get('/bookings/:id/portal', (req, res) => renderPortalWizard(req, res));

// Step 1: validate the link + count the photos WITHOUT creating anything.
router.post('/bookings/:id/portal/test', auth.verifyCsrf, async (req, res) => {
  // Link tidak diketik admin: bila subfolder 01. FILE MENTAH tersimpan, itu sumbernya.
  const bookingRow = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
  const rawUrl = bookingRow && bookingRow.drive_raw_id
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(bookingRow.drive_raw_id)}`
    : '';
  const driveUrl = rawUrl || str(req.body.drive_url, 500);
  const values = {
    driveUrl,
    quota: int(req.body.quota) || selection.defaultQuota(Number(req.params.id)),
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(str(req.body.deadline, 10)) ? str(req.body.deadline, 10) : '',
    allowDownload: Boolean(req.body.allow_download),
    requireFullQuota: Boolean(req.body.require_full_quota)
  };
  const parsed = drive.parseFolderId(driveUrl || '');
  if (!parsed.ok) return renderPortalWizard(req, res, { values, error: parsed.message, forceForm: true });
  try {
    const folder = await drive.getFolder(parsed.id);
    const listing = await drive.listFolderPhotos(parsed.id);
    return renderPortalWizard(req, res, {
      values,
      forceForm: true,
      probe: {
        ok: true,
        folder: listing.files.length ? folder.folder : folder.folder,
        total: listing.files.length,
        pages: listing.pages,
        truncated: listing.truncated,
        sample: listing.files.slice(0, 6).map((f) => f.name),
        folderId: parsed.id
      }
    });
  } catch (err) {
    return renderPortalWizard(req, res, {
      values,
      forceForm: true,
      error: err.message || 'Gagal membaca folder Google Drive.'
    });
  }
});

// Step 2: create the portal (one per booking) and import the folder.
router.post('/bookings/:id/portal', auth.verifyCsrf, async (req, res) => {
  const bookingId = Number(req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return res.redirect(back(req, '/admin/bookings', { err: 'Booking tidak ditemukan.' }));

  // "Buat tanpa folder Drive" posts its own flag — never a second field named drive_url,
  // which Express would read as an array (['','']) and turn into an invalid link.
  // Revisi 4: bila subfolder "01. FILE MENTAH" sudah tersimpan, folder itulah sumbernya
  // (link manual tidak diperlukan lagi).
  const rawUrl = booking.drive_raw_id
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(booking.drive_raw_id)}`
    : '';
  const driveUrl = req.body.no_drive ? '' : (rawUrl || str(req.body.drive_url, 500));
  const values = {
    driveUrl,
    quota: int(req.body.quota) || selection.defaultQuota(booking.id),
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(str(req.body.deadline, 10)) ? str(req.body.deadline, 10) : '',
    allowDownload: Boolean(req.body.allow_download),
    requireFullQuota: Boolean(req.body.require_full_quota)
  };

  // Reuse the existing portal instead of creating a duplicate.
  const existing = selection.portalForBooking(booking.id);
  if (existing) {
    return res.redirect(back(req, `/admin/selection/${existing.id}`, {
      note: 'Booking ini sudah punya portal seleksi — tidak dibuat portal baru.'
    }));
  }

  const parsed = drive.parseFolderId(driveUrl || '');
  if (!parsed.ok && driveUrl) {
    return renderPortalWizard(req, res, { values, forceForm: true, error: parsed.message });
  }
  // No Drive folder is allowed: the portal is then filled by manual upload.

  const portal = selection.createForBooking(booking.id, {
    driveUrl: parsed.ok ? `https://drive.google.com/drive/folders/${parsed.id}` : '',
    quota: values.quota,
    deadline: values.deadline || null,
    allowDownload: values.allowDownload,
    requireFullQuota: values.requireFullQuota
  });
  if (!portal) return res.redirect(back(req, '/admin/bookings', { err: 'Portal seleksi gagal dibuat.' }));

  if (parsed.ok) {
    try {
      const result = await selection.syncFromDrive(portal, parsed.id);
      // Hangatkan thumbnail di latar belakang supaya portal klien langsung ringan.
      selection.warmPreviewsInBackground(portal.id, { width: 320 });
      // Client: foto RAW siap dipilih (satu kali per portal, event_id tetap).
      if (result.total > 0) {
        push.notify('client_photos_ready', {
          eventId: `portal:${portal.id}:photos-ready`,
          bookingId: portal.booking_id,
          clientName: booking.client_name || '',
          campus: booking.campus || ''
        });
      }
      return res.redirect(back(req, `/admin/selection/${portal.id}`, {
        msg: 'selection-created',
        note: `Portal dibuat dan ${result.total} foto dibaca dari folder Drive “${result.folder.name || 'folder'}”`
          + `${result.truncated ? ' (folder sangat besar — daftar dipotong, tekan Perbarui lagi)' : ''}.`
      }));
    } catch (err) {
      db.prepare(`UPDATE photo_selections SET sync_error = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(str(err.message, 300), portal.id);
      return res.redirect(back(req, `/admin/selection/${portal.id}`, {
        note: 'Portal sudah dibuat, tetapi foto belum berhasil dibaca dari Drive.',
        err: str(err.message, 300)
      }));
    }
  }

  res.redirect(back(req, `/admin/selection/${portal.id}`, {
    msg: 'selection-created',
    note: 'Portal dibuat tanpa folder Drive — Anda bisa menambahkan foto secara manual atau mengisi link foldernya.'
  }));
});

// Re-read the folder. Never deletes picks, never duplicates a Drive file.
router.post('/selection/:id/sync', auth.verifyCsrf, async (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  // Revisi 4 — "Perbarui" SELALU membaca subfolder "01. FILE MENTAH" milik booking ini
  // bila tersedia (bukan folder lain / link lama yang pernah ditempel).
  const rawFolder = selection.rawFolderOf(portal.booking_id);
  if (rawFolder.url) {
    db.prepare(`UPDATE photo_selections SET drive_url = ?, drive_show = 1, updated_at = datetime('now')
                WHERE id = ?`).run(rawFolder.url, portal.id);
  }
  const folderInput = rawFolder.id
    || str(req.body.drive_folder || '', 500) || portal.drive_folder_id || portal.drive_url;
  try {
    const result = await selection.syncFromDrive(portal, folderInput);
    selection.warmPreviewsInBackground(portal.id, { width: 320 });
    if (result.total > 0) {
      const bk = db.prepare('SELECT client_name, campus FROM bookings WHERE id = ?').get(portal.booking_id) || {};
      push.notify('client_photos_ready', {
        eventId: `portal:${portal.id}:photos-ready`,
        bookingId: portal.booking_id,
        clientName: bk.client_name || '',
        campus: bk.campus || ''
      });
    }
    const parts = [`${result.total} foto di folder`];
    if (result.added) parts.push(`${result.added} baru ditambahkan`);
    if (result.restored) parts.push(`${result.restored} tersedia kembali`);
    if (result.unavailable) parts.push(`${result.unavailable} tidak lagi ada di Drive (riwayat pilihan tetap disimpan)`);
    if (result.truncated) parts.push('folder sangat besar — sebagian foto belum dibaca');
    return res.redirect(back(req, `/admin/selection/${portal.id}`, {
      note: `Sinkronisasi selesai: ${parts.join(', ')}.`
    }));
  } catch (err) {
    db.prepare(`UPDATE photo_selections SET sync_error = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(str(err.message, 300), portal.id);
    return res.redirect(back(req, `/admin/selection/${portal.id}`, {
      err: `Sinkronisasi gagal: ${str(err.message, 300)}`
    }));
  }
});

/**
 * Tandai / lepas "Highlight" pada satu foto (revisi: tab Highlight di portal klien).
 * Hanya mengubah satu kolom tampilan; pilihan klien tidak tersentuh.
 */
router.post('/selection/:id/photos/:photoId/highlight', auth.verifyCsrf, (req, res) => {
  const portal = db.prepare('SELECT * FROM photo_selections WHERE id = ?').get(int(req.params.id));
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal tidak ditemukan.' }));
  const photo = db.prepare('SELECT * FROM photo_selection_photos WHERE id = ? AND portal_id = ?')
    .get(int(req.params.photoId), portal.id);
  if (photo) {
    const next = Number(photo.is_highlight) === 1 ? 0 : 1;
    db.prepare('UPDATE photo_selection_photos SET is_highlight = ? WHERE id = ?').run(next, photo.id);
  }
  res.redirect(back(req, `/admin/selection/${portal.id}`, { msg: 'selection-status-saved' }));
});

router.get('/selection/:id', (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));

  const ctx = selection.detail(portal);
  const photos = selection.photosFor(portal.id);
  const picks = new Set(ctx.picks);
  const picked = selection.pickedPhotos(portal.id);
  const url = selection.portalUrl(res.locals.origin, portal.token);
  const driveLink = selection.driveFolderFor(portal, ctx.booking);
  const s = getSettings();

  res.render('admin/selection-detail', {
    layout: 'admin/layout',
    title: `Seleksi Foto — ${ctx.booking ? ctx.booking.client_name : ''}`,
    pageTitle: 'Portal Seleksi Foto',
    portal,
    ctx,
    booking: ctx.booking,
    photos,
    pickedPhotos: picked,
    pickedCount: picked.length,
    availableCount: photos.filter((p) => Number(p.is_available) !== 0).length,
    pickedFileList: selection.pickedFileList(ctx),
    pickedNames: picked.map((p) => selection.photoName(p)),
    driveLinks: selection.drivePhotoLinks(ctx),
    status: ctx.status,
    statusLabel: selection.statusLabel(ctx.status),
    statuses: selection.STATUSES,
    adminStatuses: selection.ADMIN_STATUSES,
    url,
    drive: driveLink,
    // Revisi 4 — sumber foto otomatis: subfolder "01. FILE MENTAH" (read-only di form).
    rawFolder: selection.rawFolderOf(portal.booking_id),
    driveMode: drive.mode(),
    bookingDriveUrl: (ctx.booking && ctx.booking.drive_folder_url) || '',
    bookingDrivePath: (ctx.booking && ctx.booking.drive_folder_path) || '',
    clientWa: util.whatsappLink(
      (ctx.booking && ctx.booking.client_phone) || '',
      selection.clientSubmitMessage(ctx)
    ),
    waNumber: (ctx.booking && ctx.booking.client_phone) || '',
    waLink: ctx.booking
      ? util.whatsappLink(ctx.booking.client_phone, selection.waMessage(ctx, url))
      : '',
    defaultQuota: selection.defaultQuota(portal.booking_id),
    formatDateID: util.formatDateID,
    formatDateTimeWIB: util.formatDateTimeWIB,
    normalizePhone: util.normalizePhone,
    // v15: riwayat buka/tutup/ubah deadline portal (audit log, khusus admin).
    accessLog: db.prepare(`SELECT * FROM selection_access_log WHERE portal_id = ?
                           ORDER BY id DESC LIMIT 15`).all(portal.id),
    todayISO: util.todayISO(),
    deadlinePassed: Boolean(portal.deadline) && util.todayISO() > String(portal.deadline).slice(0, 10)
  });
});

router.post('/selection/:id/settings', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));

  const quotaRaw = int(req.body.quota);
  const quota = quotaRaw == null ? portal.quota : Math.min(Math.max(quotaRaw, 1), 500);
  const deadlineRaw = str(req.body.deadline, 10);
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw) ? deadlineRaw : null;

  // Revisi 4 — link folder TIDAK diketik lagi. Sumber foto portal selalu subfolder
  // "01. FILE MENTAH" milik booking ini (kalau tersimpan), jadi nilainya otomatis.
  // `drive_url` dari form hanya dipakai sebagai cadangan untuk booking lama yang
  // belum punya subfolder mentah.
  const rawFolder = selection.rawFolderOf(portal.booking_id);
  const driveRaw = rawFolder.url ? '' : str(req.body.drive_url, 500);
  const driveUrl = rawFolder.url || selection.normalizeDriveUrl(driveRaw);
  if (driveUrl === null) {
    return res.redirect(back(req, `/admin/selection/${portal.id}`, {
      err: 'Link folder harus berupa tautan Google Drive (contoh: https://drive.google.com/drive/folders/…).'
    }));
  }
  const driveShow = req.body.drive_show ? 1 : 0;
  // Keep the Drive folder id in sync with the pasted link so "Perbarui Foto" always
  // re-reads the folder the admin actually sees in this form.
  const folderParsed = driveUrl ? drive.parseFolderId(driveUrl) : { ok: false };
  const driveFolderId = folderParsed.ok ? folderParsed.id : null;

  db.prepare(`UPDATE photo_selections SET quota = ?, instructions = ?, deadline = ?,
              drive_url = ?, drive_show = ?, allow_download = ?, require_full_quota = ?,
              drive_folder_id = COALESCE(?, drive_folder_id),
              updated_at = datetime('now') WHERE id = ?`)
    .run(quota, str(req.body.instructions, 3000), deadline, driveUrl || '', driveShow,
      req.body.allow_download ? 1 : 0, req.body.require_full_quota ? 1 : 0,
      driveFolderId, portal.id);

  // Never silently leave a client over quota after the quota was lowered.
  const note = selection.pickCount(portal.id) > quota
    ? `Kuota diturunkan menjadi ${quota}, tetapi klien sudah memilih ${selection.pickCount(portal.id)} foto.`
    : null;

  res.redirect(back(req, `/admin/selection/${portal.id}`, note
    ? { msg: 'selection-settings-saved', note }
    : { msg: 'selection-settings-saved' }));
});

router.post('/selection/:id/photos', wrapSelectionUpload('photo_files', 40), auth.verifyCsrf, async (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const files = (Array.isArray(req.files) ? req.files : []).filter((f) => f.buffer && f.buffer.length);
  if (!files.length) {
    return res.redirect(back(req, `/admin/selection/${portal.id}`, { err: 'Pilih minimal satu foto untuk diunggah.' }));
  }

  const hasPrimary = db.prepare('SELECT COUNT(*) AS n FROM photo_selection_photos WHERE portal_id = ? AND is_primary = 1')
    .get(portal.id).n > 0;
  const ins = db.prepare(`INSERT INTO photo_selection_photos
      (portal_id, code, image, file_name, source, caption, is_primary, sort_order, is_available)
      VALUES (?, ?, ?, ?, 'upload', ?, ?, ?, 1)`);
  let order = selection.nextSortOrder(portal.id);
  let code = selection.nextCode(portal.id);
  let first = !hasPrimary;
  let uploaded = 0;

  try {
    for (const file of files) {
      const { src } = await uploadImage(file.buffer, file.originalname, file.mimetype);
      const info = ins.run(portal.id, code, src, str(file.originalname, 200),
        str(req.body.caption, 160), first ? 1 : 0, order);
      const photoId = Number(info.lastInsertRowid);
      // Build the GRID thumbnail now (paling sering diminta) dan varian besar di latar
      // belakang — satu pembacaan buffer, portal klien tidak perlu menunggu konversi.
      try {
        await selection.writePreviewFromBuffer({ id: photoId, code }, file.buffer, 320);
        [640, 1600].forEach((w) => {
          selection.writePreviewFromBuffer({ id: photoId, code }, file.buffer, w).catch(() => {});
        });
      } catch (err) {
        console.error('[selection] preview gagal dibuat', photoId, err.message);
      }
      first = false;
      order += 1;
      code = String(Number(code) + 1).padStart(3, '0');
      uploaded += 1;
    }
  } catch (err) {
    return res.redirect(back(req, `/admin/selection/${portal.id}`, {
      err: `${uploaded} foto tersimpan, lalu gagal: ${err.message}`
    }));
  }

  try { selection.assignDisplayNumbers(portal.id); } catch (err) { /* kosmetik */ }
  db.prepare("UPDATE photo_selections SET updated_at = datetime('now') WHERE id = ?").run(portal.id);
  res.redirect(back(req, `/admin/selection/${portal.id}`, {
    msg: 'selection-photos-added',
    note: `${uploaded} foto ditambahkan ke portal.`
  }));
});

// Admin thumbnails use the same watermarked preview as the client (master never served).
router.get('/selection/:id/photo/:photoId', async (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.status(404).end();
  const photo = selection.photoById(portal.id, Number(req.params.photoId));
  if (!photo) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=600');
  try {
    const out = await selection.ensurePreview(photo);
    res.type(out.format === 'webp' ? 'image/webp' : 'image/jpeg');
    res.sendFile(out.file);
  } catch (err) {
    res.status(404).send('Preview foto tidak tersedia. File master perlu diunggah ulang.');
  }
});

router.post('/selection/:id/photos/:photoId/primary', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const photo = selection.photoById(portal.id, Number(req.params.photoId));
  if (photo) {
    db.transaction(() => {
      db.prepare('UPDATE photo_selection_photos SET is_primary = 0 WHERE portal_id = ?').run(portal.id);
      db.prepare('UPDATE photo_selection_photos SET is_primary = 1 WHERE id = ?').run(photo.id);
    })();
  }
  res.redirect(back(req, `/admin/selection/${portal.id}`, { msg: 'selection-photo-primary' }));
});

router.post('/selection/:id/photos/:photoId/delete', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const photo = selection.photoById(portal.id, Number(req.params.photoId));
  if (photo) {
    db.prepare('DELETE FROM photo_selection_photos WHERE id = ?').run(photo.id);
    selection.dropPreview(photo.id);
    if (photo.is_primary) {
      const next = db.prepare('SELECT id FROM photo_selection_photos WHERE portal_id = ? ORDER BY sort_order, id LIMIT 1')
        .get(portal.id);
      if (next) db.prepare('UPDATE photo_selection_photos SET is_primary = 1 WHERE id = ?').run(next.id);
    }
  }
  res.redirect(back(req, `/admin/selection/${portal.id}`, { msg: 'selection-photo-deleted' }));
});

router.post('/selection/:id/photos/:photoId/move', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const dir = req.body.dir === 'up' ? -1 : 1;
  const rows = selection.photosFor(portal.id);
  const idx = rows.findIndex((r) => r.id === Number(req.params.photoId));
  const swapWith = idx + dir;
  if (idx >= 0 && swapWith >= 0 && swapWith < rows.length) {
    db.transaction(() => {
      db.prepare('UPDATE photo_selection_photos SET sort_order = ? WHERE id = ?').run(swapWith, rows[idx].id);
      db.prepare('UPDATE photo_selection_photos SET sort_order = ? WHERE id = ?').run(idx, rows[swapWith].id);
    })();
  }
  res.redirect(back(req, `/admin/selection/${portal.id}`, { msg: 'selection-photo-moved' }));
});

/* ------------------------------------------------------------------ */
/* v15 — Buka kembali / tutup Portal Pilih Foto setelah deadline       */
/* ------------------------------------------------------------------ */
/**
 * Kendali ADMIN untuk membuka kembali portal yang sudah lewat deadline:
 *  - hanya bisa dari area admin yang terautentikasi (semua route di file ini),
 *  - wajib menyertakan deadline baru + alasan,
 *  - SETIAP aksi dicatat di `selection_access_log` (siapa, kapan WIB, deadline lama/baru,
 *    alasan, hasil) dan di riwayat aktivitas booking.
 * Tidak ada tombol/jalur apa pun di Portal Client maupun halaman publik.
 */
function logSelectionAccess(portal, req, { action, reason, oldDeadline, newDeadline, result = 'ok' }) {
  db.prepare(`INSERT INTO selection_access_log
      (portal_id, booking_id, action, actor, reason, old_deadline, new_deadline, result, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(portal.id, portal.booking_id || null, action,
      String((req.admin && req.admin.username) || 'admin').slice(0, 80),
      String(reason || '').slice(0, 500),
      oldDeadline || null, newDeadline || null, result,
      String(req.ip || '').slice(0, 60));
  try {
    payments.logEvent(portal.booking_id, {
      kind: 'note',
      actor: (req.admin && req.admin.username) || 'admin',
      note: action === 'reopen'
        ? `Portal pilih foto dibuka kembali s/d ${newDeadline} (alasan: ${String(reason || '').slice(0, 120)})`
        : action === 'close'
          ? `Portal pilih foto ditutup manual (alasan: ${String(reason || '').slice(0, 120)})`
          : `Batas waktu pilih foto diubah menjadi ${newDeadline}`
    });
  } catch (err) { /* riwayat booking opsional, jangan gagalkan aksi */ }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

router.post('/selection/:id/reopen', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const backTo = `/admin/selection/${portal.id}`;
  const deadlineRaw = str(req.body.deadline, 10);
  const reason = str(req.body.reason, 500).trim();

  if (!ISO_DATE.test(deadlineRaw)) {
    return res.redirect(back(req, backTo, { err: 'Isi tanggal batas waktu baru (YYYY-MM-DD) sebelum membuka kembali portal.' }));
  }
  if (util.todayISO() > deadlineRaw) {
    return res.redirect(back(req, backTo, { err: 'Tanggal batas waktu baru tidak boleh di masa lalu.' }));
  }
  if (reason.length < 5) {
    return res.redirect(back(req, backTo, { err: 'Alasan perubahan wajib diisi (minimal 5 karakter) agar tercatat di audit log.' }));
  }
  if (String(req.body.confirm || '') !== '1') {
    return res.redirect(back(req, backTo, { err: 'Centang konfirmasi sebelum membuka kembali portal.' }));
  }

  const oldDeadline = portal.deadline || null;
  db.prepare(`UPDATE photo_selections SET is_open = 1, deadline = ?, updated_at = datetime('now')
              WHERE id = ?`).run(deadlineRaw, portal.id);
  logSelectionAccess(portal, req, { action: 'reopen', reason, oldDeadline, newDeadline: deadlineRaw });

  const lockNote = portal.submitted_at
    ? ' Klien SUDAH mengirim pilihan, jadi pilihannya tetap terkunci — membuka kunci submission adalah tindakan terpisah.'
    : '';
  res.redirect(back(req, backTo, {
    msg: 'selection-deadline-reopened',
    note: `Portal dibuka kembali sampai ${util.formatDateID(deadlineRaw, true)}.${lockNote}`
  }));
});

router.post('/selection/:id/close', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const backTo = `/admin/selection/${portal.id}`;
  const reason = str(req.body.reason, 500).trim();
  if (reason.length < 5) {
    return res.redirect(back(req, backTo, { err: 'Alasan penutupan wajib diisi (minimal 5 karakter).' }));
  }
  db.prepare("UPDATE photo_selections SET is_open = 0, updated_at = datetime('now') WHERE id = ?").run(portal.id);
  logSelectionAccess(portal, req, {
    action: 'close', reason, oldDeadline: portal.deadline || null, newDeadline: portal.deadline || null
  });
  res.redirect(back(req, backTo, { msg: 'selection-closed' }));
});

router.post('/selection/:id/toggle', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const open = portal.is_open ? 0 : 1;
  db.prepare("UPDATE photo_selections SET is_open = ?, updated_at = datetime('now') WHERE id = ?")
    .run(open, portal.id);
  // v15: setiap buka/tutup manual WAJIB tercatat (aksi admin eksplisit).
  logSelectionAccess(portal, req, {
    action: open ? 'reopen' : 'close',
    reason: 'Buka/tutup manual dari halaman portal seleksi',
    oldDeadline: portal.deadline || null,
    newDeadline: portal.deadline || null
  });
  res.redirect(back(req, `/admin/selection/${portal.id}`, { msg: open ? 'selection-opened' : 'selection-closed' }));
});

router.post('/selection/:id/token', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  db.prepare(`UPDATE photo_selections SET token = ?, token_rotated_at = datetime('now'),
              updated_at = datetime('now') WHERE id = ?`).run(selection.newToken(), portal.id);
  res.redirect(back(req, `/admin/selection/${portal.id}`, { msg: 'selection-token-rotated' }));
});

router.post('/selection/:id/status', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const status = selection.ADMIN_STATUSES.includes(req.body.status) ? req.body.status : portal.status;
  db.prepare(`UPDATE photo_selections SET status = ?, admin_note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, str(req.body.admin_note, 2000), portal.id);
  res.redirect(back(req, `/admin/selection/${portal.id}`, { msg: 'selection-status-saved' }));
});

router.post('/selection/:id/delete', auth.verifyCsrf, (req, res) => {
  const portal = selectionPortalOr404(req);
  if (portal) {
    selection.photosFor(portal.id).forEach((p) => selection.dropPreview(p.id));
    db.prepare('DELETE FROM photo_selections WHERE id = ?').run(portal.id);
  }
  res.redirect(back(req, '/admin/selection', { msg: 'selection-deleted' }));
});

// Opens the client portal in a new tab (admins may open it even when it is closed).
router.get('/selection/:id/preview', (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  res.redirect(selection.portalUrl(res.locals.origin, portal.token));
});

router.get('/selection/:id/export.csv', (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const ctx = selection.detail(portal);
  const code = (ctx.booking && ctx.booking.code) || `portal-${portal.id}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="seleksi-${code}.csv"`);
  res.send('\ufeff' + selection.csvFor(ctx));
});

router.get('/selection/:id/download.zip', async (req, res) => {
  const portal = selectionPortalOr404(req);
  if (!portal) return res.redirect(back(req, '/admin/selection', { err: 'Portal seleksi tidak ditemukan.' }));
  const ctx = selection.detail(portal);
  const picked = new Set(ctx.picks);
  const photos = selection.photosFor(portal.id).filter((p) => picked.has(p.id));
  if (!photos.length) {
    return res.redirect(back(req, `/admin/selection/${portal.id}`, { err: 'Belum ada foto terpilih untuk diunduh.' }));
  }

  const code = (ctx.booking && ctx.booking.code) || `portal-${portal.id}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="seleksi-${code}.zip"`);

  const extOf = (src) => {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(src || ''));
    return m ? `.${m[1].toLowerCase()}` : '.jpg';
  };
  const entries = photos.map((p, i) => ({
    name: `${String(i + 1).padStart(2, '0')}_${p.code || p.id}_${code}${extOf(p.image)}`,
    getBuffer: async () => {
      try {
        return await selection.masterBytes(p);
      } catch (err) {
        console.error('[selection] zip: file gagal diambil', p.id, err.message);
        return Buffer.from(`Foto ${p.code || p.id} tidak dapat diambil dari penyimpanan.`);
      }
    }
  }));

  try {
    await selection.streamZip(res, entries);
  } catch (err) {
    console.error('[selection] zip gagal', err.message);
    if (!res.headersSent) res.status(500).send('Gagal membuat file ZIP.');
    else res.end();
  }
});

/* ------------------------------------------------------------------ */
/* Testimonials                                                       */
/* ------------------------------------------------------------------ */
router.get('/testimonials', (req, res) => {
  const items = db.prepare('SELECT * FROM testimonials ORDER BY sort_order, id').all();
  res.render('admin/testimonials', { layout: 'admin/layout', title: 'Testimoni', pageTitle: 'Testimoni', items });
});

router.get('/testimonials/new', (req, res) => {
  res.render('admin/testimonial-form', {
    layout: 'admin/layout', title: 'Tambah Testimoni', pageTitle: 'Tambah Testimoni',
    item: { id: null, client_name: '', client_meta: '', quote: '', rating: 5, is_active: 1, is_placeholder: 0, sort_order: 0 },
    mode: 'create'
  });
});

router.get('/testimonials/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM testimonials WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect(back(req, '/admin/testimonials', { err: 'Testimoni tidak ditemukan.' }));
  res.render('admin/testimonial-form', {
    layout: 'admin/layout', title: 'Edit Testimoni', pageTitle: 'Edit Testimoni', item, mode: 'edit'
  });
});

router.post('/testimonials/save', wrapUpload('photo_file'), auth.verifyCsrf, async (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const name = str(req.body.client_name, 100);
  const quote = str(req.body.quote, 1000);
  if (name.length < 2 || quote.length < 5) {
    return res.redirect(back(req, '/admin/testimonials', { err: 'Nama dan isi testimoni wajib diisi.' }));
  }
  let photo = str(req.body.photo, 500);
  try {
    photo = (await maybeUpload(req, 'photo_file', photo)) || '';
  } catch (err) {
    return res.redirect(back(req, '/admin/testimonials', { err: err.message }));
  }

  const campus = str(req.body.campus, 120);
  const data = {
    client_name: name,
    client_meta: str(req.body.client_meta, 120) || campus,
    campus,
    photo,
    quote,
    rating: Math.min(5, Math.max(1, int(req.body.rating) || 5)),
    display_date: str(req.body.display_date, 20),
    is_active: bool(req.body.is_active),
    is_placeholder: bool(req.body.is_placeholder),
    sort_order: int(req.body.sort_order) || 0
  };
  if (id) {
    db.prepare(`UPDATE testimonials SET client_name=@client_name, client_meta=@client_meta,
                campus=@campus, photo=@photo, quote=@quote,
                rating=@rating, display_date=@display_date, is_active=@is_active,
                is_placeholder=@is_placeholder,
                sort_order=@sort_order WHERE id=@id`).run({ ...data, id });
    return res.redirect(back(req, '/admin/testimonials', { msg: 'testimonial-updated' }));
  }
  db.prepare(`INSERT INTO testimonials (client_name, client_meta, campus, photo, quote, rating,
              display_date, is_active, is_placeholder, sort_order, source)
              VALUES (@client_name, @client_meta, @campus, @photo, @quote, @rating,
              @display_date, @is_active, @is_placeholder, @sort_order, 'admin')`).run(data);
  res.redirect(back(req, '/admin/testimonials', { msg: 'testimonial-created' }));
});

router.post('/testimonials/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare('UPDATE testimonials SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/testimonials', { msg: 'testimonial-updated' }));
});

router.post('/testimonials/:id/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM testimonials WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/testimonials', { msg: 'testimonial-deleted' }));
});


/* ------------------------------------------------------------------ */
/* Add-ons                                                            */
/* ------------------------------------------------------------------ */
router.get('/addons', (req, res) => {
  const addons = db.prepare('SELECT * FROM addons ORDER BY sort_order, id').all();
  res.render('admin/addons', {
    layout: 'admin/layout', title: 'Add-ons', pageTitle: 'Add-ons',
    addons, categories: util.getAllCategories(), rupiah: util.rupiah
  });
});

router.get('/addons/new', (req, res) => {
  res.render('admin/addon-form', {
    layout: 'admin/layout', title: 'Tambah Add-on', pageTitle: 'Tambah Add-on',
    addon: { id: null, name: '', slug: '', description: '', price: null, applies_to: 'all', is_active: 1, sort_order: 0 },
    categories: util.getAllCategories(), mode: 'create'
  });
});

router.get('/addons/:id/edit', (req, res) => {
  const addon = db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.id);
  if (!addon) return res.redirect(back(req, '/admin/addons', { err: 'Add-on tidak ditemukan.' }));
  res.render('admin/addon-form', {
    layout: 'admin/layout', title: 'Edit Add-on', pageTitle: 'Edit Add-on',
    addon, categories: util.getAllCategories(), mode: 'edit'
  });
});

router.post('/addons/save', auth.verifyCsrf, (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const name = str(req.body.name, 80);
  if (name.length < 2) return res.redirect(back(req, '/admin/addons', { err: 'Nama add-on minimal 2 karakter.' }));

  const scopeValues = Array.isArray(req.body.applies_to) ? req.body.applies_to : (req.body.applies_to ? [req.body.applies_to] : []);
  const appliesTo = scopeValues.includes('all') || scopeValues.length === 0
    ? 'all'
    : scopeValues.map((v) => str(v, 40)).filter(Boolean).join(',');
  if (scopeValues.length && !scopeValues.includes('all') && !appliesTo) {
    return res.redirect(back(req, '/admin/addons', { err: 'Pilih minimal satu kategori untuk add-on ini.' }));
  }

  let slug = util.slugify(req.body.slug || name);
  if (!slug) slug = 'addon';
  const clash = db.prepare('SELECT id FROM addons WHERE slug = ? AND id <> ?').get(slug, id || 0);
  if (clash) slug = `${slug}-${Date.now().toString().slice(-4)}`;

  const data = {
    name, slug,
    description: str(req.body.description, 600),
    price: util.cleanPrice(req.body.price),
    applies_to: appliesTo,
    is_active: bool(req.body.is_active),
    sort_order: int(req.body.sort_order) || 0
  };

  if (id) {
    db.prepare(`UPDATE addons SET name=@name, slug=@slug, description=@description, price=@price,
                applies_to=@applies_to, is_active=@is_active, sort_order=@sort_order,
                updated_at=datetime('now') WHERE id=@id`).run({ ...data, id });
    return res.redirect(back(req, '/admin/addons', { msg: 'addon-updated' }));
  }
  db.prepare(`INSERT INTO addons (name, slug, description, price, applies_to, is_active, sort_order)
              VALUES (@name, @slug, @description, @price, @applies_to, @is_active, @sort_order)`).run(data);
  res.redirect(back(req, '/admin/addons', { msg: 'addon-created' }));
});

router.post('/addons/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare("UPDATE addons SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  res.redirect(back(req, '/admin/addons', { msg: 'addon-updated' }));
});

router.post('/addons/:id/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM addons WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/addons', { msg: 'addon-deleted' }));
});

/* ------------------------------------------------------------------ */
/* Availability                                                       */
/* ------------------------------------------------------------------ */
router.get('/availability', (req, res) => {
  const now = new Date();
  const month = /^\d{4}-\d{2}$/.test(String(req.query.bulan)) ? String(req.query.bulan)
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const map = util.availabilityForRange(first, last);
  const overrides = db.prepare('SELECT * FROM availability_overrides ORDER BY date DESC LIMIT 60').all();
  const upcoming = db.prepare(`SELECT shooting_date, COUNT(*) AS n FROM bookings
                               WHERE status IN ('pending','confirmed','completed') AND shooting_date >= ?
                               GROUP BY shooting_date ORDER BY shooting_date LIMIT 30`).all(util.todayISO());

  const counts = {};
  upcoming.forEach((row) => { counts[row.shooting_date] = row.n; });
  db.prepare(`SELECT shooting_date AS d, COUNT(*) AS n FROM bookings
              WHERE status IN ('pending','confirmed','completed') AND shooting_date BETWEEN ? AND ?
              GROUP BY shooting_date`).all(first, last)
    .forEach((row) => { counts[row.d] = row.n; });
  const overrideMap = Object.fromEntries(overrides.map((o) => [o.date, o]));

  res.render('admin/availability', {
    layout: 'admin/layout', title: 'Availability', pageTitle: 'Jadwal Tersedia',
    rules: util.availabilityRules(), month, first, last, map, overrides, upcoming,
    counts, overrideMap,
    today: util.todayISO(), weekdays: util.WEEKDAYS, formatDateID: util.formatDateID
  });
});

router.post('/availability/rules', auth.verifyCsrf, (req, res) => {
  const closed = Array.isArray(req.body.closed_weekdays) ? req.body.closed_weekdays : [];
  saveSettings({
    booking_lead_days: String(Math.min(60, Math.max(0, int(req.body.lead_days) ?? 0))),
    booking_advance_days: String(Math.min(730, Math.max(7, int(req.body.advance_days) || 180))),
    booking_closed_weekdays: closed.map((d) => Number(d)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).join(','),
    booking_daily_capacity: String(Math.min(50, Math.max(0, int(req.body.daily_capacity) ?? 0)))
  });
  res.redirect(back(req, '/admin/availability', { msg: 'availability-saved', bulan: req.body.back_month || undefined }));
});

router.post('/availability/toggle', auth.verifyCsrf, (req, res) => {
  const date = String(req.body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.redirect(back(req, '/admin/availability', { err: 'Tanggal tidak valid.' }));
  }
  const existing = db.prepare('SELECT * FROM availability_overrides WHERE date = ?').get(date);
  const note = str(req.body.note, 160);
  if (!existing) {
    db.prepare(`INSERT INTO availability_overrides (date, is_available, note, updated_at)
                VALUES (?, 0, ?, datetime('now'))`).run(date, note);
  } else if (Number(existing.is_available) === 1) {
    db.prepare('DELETE FROM availability_overrides WHERE date = ?').run(date);
  } else {
    // closed → re-open explicitly (forces availability even if a rule would close it)
    db.prepare(`UPDATE availability_overrides SET is_available = 1, note = ?, updated_at = datetime('now')
                WHERE date = ?`).run(note, date);
  }
  res.redirect(back(req, '/admin/availability', { msg: 'availability-updated', bulan: req.body.back_month || undefined }));
});

/**
 * Manual Full Booking / Ditutup / Buka kembali (Tahap 7).
 * `full_booking` is stored SEPARATELY from `is_available`, so:
 *   - Ditutup  → is_available = 0 (highest priority)
 *   - Full     → is_available = 1 + full_booking = 1
 *   - Reopen   → override row deleted → availability is computed from capacity again
 */
router.post('/availability/mark', auth.verifyCsrf, (req, res) => {
  const date = String(req.body.date || '');
  const action = String(req.body.action || '');
  const note = str(req.body.note, 160);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.redirect(back(req, '/admin/availability', { err: 'Tanggal tidak valid.' }));
  }

  const existing = db.prepare('SELECT * FROM availability_overrides WHERE date = ?').get(date);
  if (action === 'full') {
    if (existing) {
      db.prepare(`UPDATE availability_overrides SET is_available = 1, full_booking = 1, note = ?,
                  updated_at = datetime('now') WHERE date = ?`).run(note || existing.note || '', date);
    } else {
      db.prepare(`INSERT INTO availability_overrides (date, is_available, full_booking, note, updated_at)
                  VALUES (?, 1, 1, ?, datetime('now'))`).run(date, note);
    }
  } else if (action === 'close') {
    if (existing) {
      db.prepare(`UPDATE availability_overrides SET is_available = 0, full_booking = 0, note = ?,
                  updated_at = datetime('now') WHERE date = ?`).run(note || existing.note || '', date);
    } else {
      db.prepare(`INSERT INTO availability_overrides (date, is_available, full_booking, note, updated_at)
                  VALUES (?, 0, 0, ?, datetime('now'))`).run(date, note);
    }
  } else if (action === 'reopen') {
    // Deleting the override hands control back to the capacity calculation — a date that is
    // genuinely full stays full.
    db.prepare('DELETE FROM availability_overrides WHERE date = ?').run(date);
  } else {
    return res.redirect(back(req, '/admin/availability', { err: 'Aksi tidak dikenal.' }));
  }

  res.redirect(back(req, '/admin/availability', {
    msg: 'availability-marked',
    note: `${util.formatDateID(date)}: ${action === 'full' ? 'ditandai Full Booking' : action === 'close' ? 'ditutup' : 'dibuka kembali'}.`,
    bulan: req.body.back_month || undefined
  }));
});

router.post('/availability/clear', auth.verifyCsrf, (req, res) => {
  const date = String(req.body.date || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    db.prepare('DELETE FROM availability_overrides WHERE date = ?').run(date);
  }
  res.redirect(back(req, '/admin/availability', { msg: 'availability-updated', bulan: req.body.back_month || undefined }));
});

/* ------------------------------------------------------------------ */
/* Package durations (all packages, one screen)                        */
/* ------------------------------------------------------------------ */
router.get('/durations', (req, res) => {
  const packages = db.prepare(`SELECT p.id, p.name, p.is_active, c.name AS city_name, k.name AS category_name
                               FROM packages p JOIN cities c ON c.id = p.city_id
                               LEFT JOIN package_categories k ON k.id = p.category_id
                               ORDER BY c.sort_order, k.sort_order, p.sort_order, p.id`).all();
  const durations = db.prepare(`SELECT d.*, p.edited_photos AS package_photos
                                FROM package_durations d JOIN packages p ON p.id = d.package_id
                                ORDER BY d.package_id, d.sort_order, d.duration_minutes`).all()
    .map((d) => ({ ...d, edited_photos: d.edited_photos == null ? d.package_photos : d.edited_photos }));
  const byPackage = {};
  durations.forEach((d) => {
    if (!byPackage[d.package_id]) byPackage[d.package_id] = [];
    byPackage[d.package_id].push(d);
  });
  res.render('admin/durations', {
    layout: 'admin/layout', title: 'Package Durations', pageTitle: 'Package Durations',
    packages, byPackage, rupiah: util.rupiah
  });
});

router.post('/durations', auth.verifyCsrf, (req, res) => {
  const rows = db.prepare('SELECT * FROM package_durations').all();
  const update = db.prepare(`UPDATE package_durations SET price = ?, edited_photos = ?, is_active = ?,
                             updated_at = datetime('now') WHERE id = ?`);
  db.transaction(() => {
    rows.forEach((row) => {
      const priceKey = `price_${row.id}`;
      const activeKey = `active_${row.id}`;
      const photosKey = `photos_${row.id}`;
      if (req.body[priceKey] === undefined && req.body[activeKey] === undefined && req.body[photosKey] === undefined) return;
      const price = req.body[priceKey] !== undefined ? util.cleanPrice(req.body[priceKey]) : row.price;
      const photos = req.body[photosKey] !== undefined ? int(req.body[photosKey]) : row.edited_photos;
      const active = req.body[`touched_${row.id}`] ? bool(req.body[activeKey]) : row.is_active;
      update.run(price, photos, active, row.id);
    });
  })();
  res.redirect(back(req, '/admin/durations', { msg: 'durations-saved' }));
});

/* ------------------------------------------------------------------ */
/* Articles                                                           */
/* ------------------------------------------------------------------ */
router.get('/articles', (req, res) => {
  const articles = db.prepare('SELECT * FROM articles ORDER BY COALESCE(published_at, created_at) DESC, id DESC').all();
  res.render('admin/articles', {
    layout: 'admin/layout', title: 'Artikel', pageTitle: 'Artikel',
    articles, formatDateID: util.formatDateID
  });
});

router.get('/articles/new', (req, res) => {
  res.render('admin/article-form', {
    layout: 'admin/layout', title: 'Tambah Artikel', pageTitle: 'Tambah Artikel',
    article: { id: null, title: '', slug: '', excerpt: '', body: '', cover_image: '', is_published: 0, sort_order: 0 },
    mode: 'create'
  });
});

router.get('/articles/:id/edit', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.redirect(back(req, '/admin/articles', { err: 'Artikel tidak ditemukan.' }));
  res.render('admin/article-form', {
    layout: 'admin/layout', title: 'Edit Artikel', pageTitle: 'Edit Artikel', article, mode: 'edit'
  });
});

router.post('/articles/save', wrapUpload('cover_file'), auth.verifyCsrf, async (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const title = str(req.body.title, 160);
  if (title.length < 3) return res.redirect(back(req, '/admin/articles', { err: 'Judul artikel minimal 3 karakter.' }));

  let cover = str(req.body.cover_image, 500);
  try {
    cover = (await maybeUpload(req, 'cover_file', cover)) || '';
  } catch (err) {
    return res.redirect(back(req, '/admin/articles', { err: err.message }));
  }

  let slug = util.slugify(req.body.slug || title) || `artikel-${Date.now()}`;
  const clash = db.prepare('SELECT id FROM articles WHERE slug = ? AND id <> ?').get(slug, id || 0);
  if (clash) slug = `${slug}-${Date.now().toString().slice(-4)}`;

  const published = bool(req.body.is_published);
  const data = {
    title, slug,
    excerpt: str(req.body.excerpt, 400),
    body: str(req.body.body, 20000),
    cover_image: cover,
    is_published: published,
    sort_order: int(req.body.sort_order) || 0
  };

  if (id) {
    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    const publishedAt = published ? (existing.published_at || new Date().toISOString()) : null;
    db.prepare(`UPDATE articles SET title=@title, slug=@slug, excerpt=@excerpt, body=@body,
                cover_image=@cover_image, is_published=@is_published, sort_order=@sort_order,
                published_at=?, updated_at=datetime('now') WHERE id=@id`).run({ ...data, id }, publishedAt);
    return res.redirect(back(req, '/admin/articles', { msg: 'article-updated' }));
  }
  db.prepare(`INSERT INTO articles (title, slug, excerpt, body, cover_image, is_published, sort_order, published_at)
              VALUES (@title, @slug, @excerpt, @body, @cover_image, @is_published, @sort_order, ?)`)
    .run(data, published ? new Date().toISOString() : null);
  res.redirect(back(req, '/admin/articles', { msg: 'article-created' }));
});

router.post('/articles/:id/toggle', auth.verifyCsrf, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (article) {
    const next = Number(article.is_published) === 1 ? 0 : 1;
    db.prepare(`UPDATE articles SET is_published = ?, published_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(next, next ? (article.published_at || new Date().toISOString()) : null, article.id);
  }
  res.redirect(back(req, '/admin/articles', { msg: 'article-published' }));
});

router.post('/articles/:id/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/articles', { msg: 'article-deleted' }));
});



/* ------------------------------------------------------------------ */
/* Brand identity (logo variants + studio copy)                        */
/* ------------------------------------------------------------------ */
/**
 * A manually typed path only works if the file really exists locally, or if it is an
 * absolute http(s) URL. Catches the classic "logo 404" after a typo.
 */
function logoPathProblem(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return '';
  if (!v.startsWith('/')) return 'Path logo harus diawali "/" (contoh /uploads/logo.png) atau berupa URL lengkap.';
  const abs = path.join(__dirname, '..', '..', 'public', v.replace(/^\//, ''));
  if (!fs.existsSync(abs)) return `File logo tidak ditemukan: ${v}. Unggah filenya atau perbaiki path-nya.`;
  return '';
}

const LOGO_FIELDS = [
  { key: 'logo_header_light', label: 'Logo header — versi terang', hint: 'Dipakai saat header transparan di atas foto hero. Gunakan logo putih.' },
  { key: 'logo_header_dark', label: 'Logo header — versi gelap', hint: 'Dipakai saat header solid/putih. Gunakan logo berwarna gelap.' },
  { key: 'logo_footer_light', label: 'Logo footer — versi terang', hint: 'Footer berlatar navy, gunakan logo putih.' },
  { key: 'logo_footer_dark', label: 'Logo footer — versi gelap', hint: 'Untuk footer berlatar terang (jika tema diubah).' }
];

router.get('/brand', (req, res) => {
  const s = getSettings();
  res.render('admin/brand', {
    layout: 'admin/layout',
    title: 'Identitas Brand',
    pageTitle: 'Identitas Brand',
    values: {
      brand_name: s.brand_name || '',
      brand_tagline: s.brand_tagline || '',
      brand_description: s.brand_description || '',
      brand_email: s.brand_email || '',
      instagram_handle: s.instagram_handle || '',
      whatsapp_number: s.whatsapp_number || '',
      footer_copyright: s.footer_copyright || ''
    },
    logoFields: LOGO_FIELDS,
    logos: Object.fromEntries(LOGO_FIELDS.map((f) => [f.key, s[f.key] || ''])),
    favicon: s.favicon_custom || '',
    brokenLogos: LOGO_FIELDS
      .map((f) => ({ label: f.label, key: f.key, value: s[f.key] || '', problem: logoPathProblem(s[f.key]) }))
      .filter((x) => x.problem),
    legacyLogo: s.appearance_logo || '',
    showIdentity: s.header_show_identity !== '0',
    sticky: s.header_sticky !== '0'
  });
});

router.post('/brand', wrapUpload('favicon_file'), auth.verifyCsrf, async (req, res) => {
  const uploadField = String(req.body.logo_field || '');
  const values = {
    brand_name: str(req.body.brand_name, 80),
    brand_tagline: str(req.body.brand_tagline, 160),
    brand_description: str(req.body.brand_description, 160),
    brand_email: str(req.body.brand_email, 160),
    instagram_handle: String(req.body.instagram_handle || '').replace(/^@/, '').trim(),
    whatsapp_number: util.normalizePhone(req.body.whatsapp_number),
    header_show_identity: req.body.header_show_identity ? '1' : '0',
    header_sticky: req.body.header_sticky ? '1' : '0'
  };
  if (!util.isValidPhone(values.whatsapp_number)) {
    return res.redirect(back(req, '/admin/brand', { err: 'Nomor WhatsApp tidak valid.' }));
  }

  // Favicon (tab icon) is uploaded separately from the logo variants.
  if (req.file && req.file.buffer && req.file.buffer.length && req.body.favicon_intent === '1') {
    try {
      const { src } = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
      values.favicon_custom = src;
    } catch (err) {
      return res.redirect(back(req, '/admin/brand', { err: err.message }));
    }
  } else if (req.file && req.file.buffer && req.file.buffer.length) {
    if (!LOGO_FIELDS.some((f) => f.key === uploadField)) {
      return res.redirect(back(req, '/admin/brand', { err: 'Pilih varian logo yang akan diunggah.' }));
    }
    try {
      const { src } = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
      values[uploadField] = src;
    } catch (err) {
      return res.redirect(back(req, '/admin/brand', { err: err.message }));
    }
  }

  // Manual path/URL overrides + clearing
  const logoProblems = [];
  LOGO_FIELDS.forEach((f) => {
    const manual = req.body[`${f.key}_url`];
    if (manual !== undefined && String(manual).trim() !== '') {
      const candidate = str(manual, 500);
      const problem = logoPathProblem(candidate);
      if (problem) logoProblems.push(`${f.label}: ${problem}`);
      else values[f.key] = candidate;
    }
    if (req.body[`${f.key}_clear`]) values[f.key] = '';
  });
  if (logoProblems.length) {
    return res.redirect(back(req, '/admin/brand', { err: logoProblems.join(' | ').slice(0, 350) }));
  }

  if (req.body.favicon_clear) values.favicon_custom = '';
  saveSettings(values);
  res.redirect(back(req, '/admin/brand', { msg: 'brand-saved' }));
});

/* ------------------------------------------------------------------ */
/* Syarat & Ketentuan — editor sederhana (baris per poin)              */
/* ------------------------------------------------------------------ */
router.get('/tnc', (req, res) => {
  const draft = content.getSiteContent({ preview: true });
  const live = content.getSiteContent({ preview: false });
  res.render('admin/tnc', {
    layout: 'admin/layout',
    title: 'Syarat & Ketentuan',
    pageTitle: 'Syarat & Ketentuan',
    titleValue: draft['tnc.title'] || '',
    descValue: draft['tnc.description'] || '',
    points: util.lines(draft['tnc.body']),
    livePoints: util.lines(live['tnc.body']).length,
    hasDraft: String(draft['tnc.body'] || '') !== String(live['tnc.body'] || '')
  });
});

router.post('/tnc', auth.verifyCsrf, async (req, res) => {
  const points = [].concat(req.body.point || [])
    .map((p) => String(p).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  content.saveDraftValues({
    'tnc.title': str(req.body.tnc_title, 120) || 'Syarat & Ketentuan',
    'tnc.description': str(req.body.tnc_description, 400),
    'tnc.body': points.join('\n')
  });

  if (req.body.publish_now) {
    content.publishChanges();
    return res.redirect(back(req, '/admin/tnc', { msg: 'tnc-published' }));
  }
  res.redirect(back(req, '/admin/tnc', { msg: 'tnc-saved' }));
});

/* ------------------------------------------------------------------ */
/* Homepage statistics (count-up)                                     */
/* ------------------------------------------------------------------ */
router.get('/home-stats', (req, res) => {
  const stats = db.prepare('SELECT * FROM home_stats ORDER BY sort_order, id').all();
  const s = getSettings();
  res.render('admin/home-stats', {
    layout: 'admin/layout',
    title: 'Statistik Homepage',
    pageTitle: 'Statistik Homepage',
    stats,
    visible: s.home_stats_visible !== '0'
  });
});

router.post('/home-stats/visibility', auth.verifyCsrf, (req, res) => {
  saveSettings({ home_stats_visible: req.body.home_stats_visible ? '1' : '0' });
  res.redirect(back(req, '/admin/home-stats', { msg: 'stat-updated' }));
});

router.post('/home-stats/save', auth.verifyCsrf, (req, res) => {
  const rows = db.prepare('SELECT * FROM home_stats').all();
  const update = db.prepare(`UPDATE home_stats SET value_num = ?, label = ?, suffix = ?, is_active = ?, sort_order = ?
                             WHERE id = ?`);
  const ins = db.prepare(`INSERT INTO home_stats (value_num, label, suffix, is_active, sort_order)
                          VALUES (?, ?, ?, ?, ?)`);
  db.transaction(() => {
    rows.forEach((row, idx) => {
      const v = req.body[`value_${row.id}`];
      if (v === undefined) return;
      update.run(
        Math.max(0, int(v) || 0),
        str(req.body[`label_${row.id}`], 60) || row.label,
        str(req.body[`suffix_${row.id}`], 6),
        req.body[`active_${row.id}`] ? 1 : 0,
        int(req.body[`sort_${row.id}`]) != null ? int(req.body[`sort_${row.id}`]) : idx,
        row.id
      );
    });
    if (req.body.new_value !== undefined && String(req.body.new_value).trim() !== '') {
      ins.run(Math.max(0, int(req.body.new_value) || 0), str(req.body.new_label, 60) || 'Statistik',
        str(req.body.new_suffix, 6), 1, rows.length);
    }
  })();
  res.redirect(back(req, '/admin/home-stats', { msg: 'stat-updated' }));
});

router.post('/home-stats/:id/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM home_stats WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/home-stats', { msg: 'stat-deleted' }));
});

/* ------------------------------------------------------------------ */
/* Team members (assignable crew, invited to the calendar event)       */
/* ------------------------------------------------------------------ */
router.get('/team', (req, res) => {
  const members = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM bookings b WHERE b.team_member_id = t.id) AS booking_count
                              FROM team_members t ORDER BY t.sort_order, t.id`).all();
  res.render('admin/team', { layout: 'admin/layout', title: 'Tim', pageTitle: 'Tim yang Bertugas', members });
});

router.get('/team/new', (req, res) => {
  res.render('admin/team-form', {
    layout: 'admin/layout', title: 'Tambah Anggota Tim', pageTitle: 'Tambah Anggota Tim',
    member: { id: null, name: '', email: '', role: '', is_active: 1, sort_order: 0 }, mode: 'create'
  });
});

router.get('/team/:id/edit', (req, res) => {
  const member = db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  if (!member) return res.redirect(back(req, '/admin/team', { err: 'Anggota tim tidak ditemukan.' }));
  res.render('admin/team-form', {
    layout: 'admin/layout', title: 'Edit Anggota Tim', pageTitle: 'Edit Anggota Tim', member, mode: 'edit'
  });
});

router.post('/team/save', auth.verifyCsrf, (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const name = str(req.body.name, 80);
  const email = str(req.body.email, 160).toLowerCase();
  if (name.length < 2) return res.redirect(back(req, '/admin/team', { err: 'Nama anggota tim minimal 2 karakter.' }));
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.redirect(back(req, '/admin/team', { err: 'Format email tidak valid.' }));
  }
  const data = {
    name,
    email,
    role: str(req.body.role, 80),
    is_active: bool(req.body.is_active),
    sort_order: int(req.body.sort_order) || 0
  };
  if (id) {
    db.prepare(`UPDATE team_members SET name=@name, email=@email, role=@role,
                is_active=@is_active, sort_order=@sort_order, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...data, id });
    return res.redirect(back(req, '/admin/team', { msg: 'team-updated' }));
  }
  db.prepare(`INSERT INTO team_members (name, email, role, is_active, sort_order)
              VALUES (@name, @email, @role, @is_active, @sort_order)`).run(data);
  res.redirect(back(req, '/admin/team', { msg: 'team-created' }));
});

router.post('/team/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare("UPDATE team_members SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);
  res.redirect(back(req, '/admin/team', { msg: 'team-updated' }));
});

router.post('/team/:id/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('UPDATE bookings SET team_member_id = NULL WHERE team_member_id = ?').run(req.params.id);
  db.prepare('DELETE FROM team_members WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/team', { msg: 'team-deleted' }));
});

/* ------------------------------------------------------------------ */
/* Private testimonial link                                           */
/* ------------------------------------------------------------------ */
function ensureTestimonialToken() {
  let token = getSettings().testimonial_form_token || '';
  if (!token) {
    token = require('crypto').randomBytes(18).toString('hex');
    saveSettings({ testimonial_form_token: token });
  }
  return token;
}

router.get('/testimonial-link', (req, res) => {
  const token = ensureTestimonialToken();
  const s = getSettings();
  res.render('admin/testimonial-link', {
    layout: 'admin/layout',
    title: 'Link Testimoni',
    pageTitle: 'Link Testimoni Klien',
    token,
    path: `/testimoni/${token}`,
    autoApprove: s.testimonial_auto_approve === '1',
    intro: s.testimonial_intro || '',
    notice: s.testimonial_form_notice || ''
  });
});

router.post('/testimonial-link', auth.verifyCsrf, (req, res) => {
  const action = String(req.body.action || 'save');
  if (action === 'regenerate') {
    saveSettings({ testimonial_form_token: require('crypto').randomBytes(18).toString('hex') });
    return res.redirect(back(req, '/admin/testimonial-link', { msg: 'testimonial-link-saved' }));
  }
  saveSettings({
    testimonial_auto_approve: req.body.auto_approve ? '1' : '0',
    testimonial_intro: str(req.body.intro, 600),
    testimonial_form_notice: str(req.body.notice, 300)
  });
  res.redirect(back(req, '/admin/testimonial-link', { msg: 'testimonial-link-saved' }));
});

/* ------------------------------------------------------------------ */
/* FAQs                                                               */
/* ------------------------------------------------------------------ */
router.get('/faqs', (req, res) => {
  const faqs = db.prepare('SELECT * FROM faqs ORDER BY sort_order, id').all();
  res.render('admin/faqs', { layout: 'admin/layout', title: 'FAQ', pageTitle: 'FAQ', faqs });
});

router.get('/faqs/new', (req, res) => {
  res.render('admin/faq-form', {
    layout: 'admin/layout', title: 'Tambah FAQ', pageTitle: 'Tambah FAQ',
    faq: { id: null, question: '', answer: '', sort_order: 0, is_active: 1 }, mode: 'create'
  });
});

router.get('/faqs/:id/edit', (req, res) => {
  const faq = db.prepare('SELECT * FROM faqs WHERE id = ?').get(req.params.id);
  if (!faq) return res.redirect(back(req, '/admin/faqs', { err: 'FAQ tidak ditemukan.' }));
  res.render('admin/faq-form', {
    layout: 'admin/layout', title: 'Edit FAQ', pageTitle: 'Edit FAQ', faq, mode: 'edit'
  });
});

router.post('/faqs/save', auth.verifyCsrf, (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const question = str(req.body.question, 240);
  const answer = str(req.body.answer, 2000);
  if (question.length < 5 || answer.length < 5) {
    return res.redirect(back(req, '/admin/faqs', { err: 'Pertanyaan dan jawaban wajib diisi.' }));
  }
  const data = { question, answer, sort_order: int(req.body.sort_order) || 0, is_active: bool(req.body.is_active) };
  if (id) {
    db.prepare(`UPDATE faqs SET question=@question, answer=@answer, sort_order=@sort_order,
                is_active=@is_active WHERE id=@id`).run({ ...data, id });
    return res.redirect(back(req, '/admin/faqs', { msg: 'faq-updated' }));
  }
  db.prepare(`INSERT INTO faqs (question, answer, sort_order, is_active)
              VALUES (@question, @answer, @sort_order, @is_active)`).run(data);
  res.redirect(back(req, '/admin/faqs', { msg: 'faq-created' }));
});

router.post('/faqs/:id/toggle', auth.verifyCsrf, (req, res) => {
  db.prepare('UPDATE faqs SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/faqs', { msg: 'faq-updated' }));
});

router.post('/faqs/:id/delete', auth.verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM faqs WHERE id = ?').run(req.params.id);
  res.redirect(back(req, '/admin/faqs', { msg: 'faq-deleted' }));
});


/* ------------------------------------------------------------------ */
/* Google Calendar                                                    */
/* ------------------------------------------------------------------ */
function gcalState(req) {
  const c = gcal.config();
  return {
    cfg: c,
    hasCredentials: gcal.hasCredentials(c),
    hasDriveCredentials: gcal.hasCredentialsFor('drive', c),
    driveOwnClient: gcal.clientFor('drive', c).own,
    connected: gcal.isConnected(c),
    active: gcal.isActive(c),
    driveScopes: c.driveScopes,
    driveConnected: gcal.isDriveConnected(c),
    driveOwnAccount: gcal.driveUsesOwnAccount(c),
    checkedAt: (getSettings().gcal_checked_at) || '',
    driveCheckedAt: (getSettings().gdrive_checked_at) || '',
    redirectUri: gcal.redirectUri(req)
  };
}

router.get('/google', (req, res) => {
  res.render('admin/google', {
    layout: 'admin/layout',
    title: 'Google Calendar',
    pageTitle: 'Google Calendar',
    ...gcalState(req),
    result: req.query.hasil || ''
  });
});

router.post('/google/save', auth.verifyCsrf, (req, res) => {
  const clientId = str(req.body.client_id, 300);
  const clientSecret = str(req.body.client_secret, 300);
  const calendarId = str(req.body.calendar_id, 200) || 'primary';
  const defaultTime = /^\d{2}:\d{2}$/.test(req.body.default_time || '') ? req.body.default_time : '09:00';
  const fallback = Math.min(600, Math.max(15, int(req.body.duration_fallback) || 60));
  const timezone = str(req.body.timezone, 60) || 'Asia/Jakarta';
  const enabled = bool(req.body.enabled);

  const current = gcal.config();
  const values = {
    gcal_calendar_id: calendarId,
    gcal_default_time: defaultTime,
    gcal_duration_fallback: String(fallback),
    gcal_timezone: timezone,
    gcal_team: str(req.body.team, 80),
    gcal_drive_enabled: req.body.drive_enabled ? '1' : '0',
    gcal_enabled: enabled ? '1' : '0'
  };

  const driveClientId = str(req.body.drive_client_id, 300);
  const driveClientSecret = str(req.body.drive_client_secret, 300);
  const clearDriveClient = req.body.clear_drive_client === '1';

  // Only overwrite credentials when the owner actually typed new ones.
  // A Client ID pasted into a Secret field used to be saved silently and only surfaced much
  // later as "The provided client secret is invalid" — after the tokens had already been wiped.
  // Reject it here, before anything is written.
  const badSecret = (value) => {
    if (!value) return false;
    return /apps\.googleusercontent\.com\s*$/i.test(value) || /^\d{10,}-/.test(value) || value.length > 80;
  };
  if (badSecret(clientSecret)) {
    return res.redirect(back(req, '/admin/google', {
      err: 'Client Secret Calendar ditolak: isian itu terlihat seperti Client ID (berakhiran '
        + '".apps.googleusercontent.com"). Tempel nilai dari kolom "Client secret" di Google Cloud Console.'
    }));
  }
  if (badSecret(driveClientSecret)) {
    return res.redirect(back(req, '/admin/google', {
      err: 'Client Secret Drive ditolak: isian itu terlihat seperti Client ID. '
        + 'Tempel nilai dari kolom "Client secret" (biasanya diawali GOCSPX-).'
    }));
  }

  if (clientId) values.gcal_client_id = clientId;
  if (clientSecret) values.gcal_client_secret = clientSecret;
  if (driveClientId) values.gdrive_client_id = driveClientId;
  if (driveClientSecret) values.gdrive_client_secret = driveClientSecret;
  if (clearDriveClient) {
    values.gdrive_client_id = '';
    values.gdrive_client_secret = '';
  }

  // A refresh token is bound to the CLIENT ID that issued it — NOT to the client secret.
  // Rotating the secret in Google Cloud therefore keeps existing tokens valid, so only a
  // changed client id may drop a token. (Wiping on a secret edit forced an unnecessary
  // re-consent and, when the new secret was wrong, left the connection dead.)
  const credentialChanged = Boolean(clientId && clientId !== current.clientId);
  if (credentialChanged) {
    values.gcal_refresh_token = '';
    values.gcal_connected_at = '';
    values.gcal_account = '';

    const driveKeepsOwnClient = Boolean(current.driveClientId && current.driveClientSecret);
    if (!driveKeepsOwnClient) {
      values.gdrive_refresh_token = '';
      values.gdrive_connected_at = '';
      values.gdrive_account = '';
    }
  }

  // Changing the DRIVE client id invalidates only the Drive token — Calendar must stay connected.
  const driveCredentialChanged = Boolean(driveClientId && driveClientId !== current.driveClientId)
    || clearDriveClient;
  if (driveCredentialChanged) {
    values.gdrive_refresh_token = '';
    values.gdrive_connected_at = '';
    values.gdrive_account = '';
    values.gdrive_last_error = '';
  }
  if (clientSecret || driveClientSecret) {
    // Keep the recorded error visible only when it was a real failure; a corrected secret
    // clears the stale message so the page stops shouting about a fixed problem.
    values.gcal_last_error = '';
    if (driveClientSecret) values.gdrive_last_error = '';
  }

  saveSettings(values);
  gcal.resetTokenCache();

  // "Dropped" only when a token that existed just before this save was cleared by it.
  const calendarDropped = Boolean(current.refreshToken) && values.gcal_refresh_token === '';
  const driveDropped = Boolean(current.driveRefreshToken) && values.gdrive_refresh_token === '';
  if (calendarDropped || driveDropped) {
    const which = [calendarDropped ? 'Calendar' : null, driveDropped ? 'Drive' : null].filter(Boolean).join(' & ');
    return res.redirect(back(req, '/admin/google', {
      err: `Pengaturan disimpan, tetapi kredensial ${which} berubah sehingga token lama dihapus. `
        + 'Klik "Hubungkan ulang Calendar"' + (driveDropped ? ' dan "Hubungkan akun Drive"' : '')
        + ' sekali lagi agar koneksi aktif kembali.'
    }));
  }
  res.redirect(back(req, '/admin/google', { msg: 'gcal-saved' }));
});

router.post('/google/connect', auth.verifyCsrf, (req, res) => {
  const c = gcal.config();
  if (!gcal.hasCredentials(c)) {
    return res.redirect(back(req, '/admin/google', { err: 'Isi Client ID dan Client Secret terlebih dahulu.' }));
  }
  const state = gcal.createState('calendar');
  res.redirect(gcal.buildAuthUrl(state, gcal.redirectUri(req), 'calendar'));
});

router.post('/google/connect-drive', auth.verifyCsrf, (req, res) => {
  const c = gcal.config();
  if (!gcal.hasCredentialsFor('drive', c)) {
    return res.redirect(back(req, '/admin/google', { err: 'Isi Client ID dan Client Secret untuk Drive terlebih dahulu.' }));
  }
  const state = gcal.createState('drive');
  res.redirect(gcal.buildAuthUrl(state, gcal.redirectUri(req), 'drive'));
});

router.post('/google/disconnect-drive', auth.verifyCsrf, (req, res) => {
  saveSettings({ gdrive_refresh_token: '', gdrive_connected_at: '', gdrive_account: '', gdrive_last_error: '' });
  gcal.resetTokenCache('drive');
  res.redirect(back(req, '/admin/google', { msg: 'gdrive-disconnected' }));
});

router.get('/google/callback', async (req, res) => {
  const fail = (message) => res.redirect(back(req, '/admin/google', { err: message }));

  // V9.2: the photo-selection Drive READER uses the same registered redirect URI but
  // its own state + scope, so it must be handled before the Calendar/Drive flow.
  if (drive.hasPendingState() && drive.consumeState(String(req.query.state || ''))) {
    if (req.query.error) {
      const hint = gcal.oauthHint(req.query.error, req.query.error_description);
      return res.redirect(back(req, '/admin/selection/settings',
        { err: `Google menolak izin baca Drive (${String(req.query.error).slice(0, 40)}). ${hint}`.slice(0, 400) }));
    }
    try {
      const tokens = await drive.exchangeCode(String(req.query.code || ''), gcal.redirectUri(req));
      saveSettings({
        gdrive_reader_refresh_token: tokens.refresh_token,
        gdrive_reader_connected_at: new Date().toISOString(),
        gdrive_reader_last_error: ''
      });
      drive.resetTokenCache();
      const check = await drive.selfCheck();
      if (check.ok && check.email) saveSettings({ gdrive_reader_account: check.email });
      return res.redirect(back(req, '/admin/selection/settings', {
        msg: 'selection-settings-saved',
        note: `Akun Drive untuk membaca foto berhasil terhubung${check.email ? ` (${check.email})` : ''}.`
      }));
    } catch (err) {
      saveSettings({ gdrive_reader_last_error: str(err.message, 300) });
      return res.redirect(back(req, '/admin/selection/settings', { err: str(err.message, 300) }));
    }
  }

  if (req.query.error) {
    const hint = gcal.oauthHint(req.query.error, req.query.error_description);
    return fail(`Google menolak otorisasi (${String(req.query.error).slice(0, 40)}). ${hint}`.slice(0, 400));
  }
  const kind = gcal.consumeState(String(req.query.state || ''));
  if (!kind) return fail('Sesi otorisasi tidak valid atau kedaluwarsa. Coba hubungkan lagi.');

  try {
    const tokens = await gcal.exchangeCode(String(req.query.code || ''), gcal.redirectUri(req), kind);
    const scopeText = str(tokens.scope, 200);
    if (kind === 'drive') {
      saveSettings({
        gdrive_refresh_token: tokens.refresh_token,
        gdrive_connected_at: new Date().toISOString(),
        gdrive_account: scopeText,
        gdrive_last_error: ''
      });
      gcal.resetTokenCache('drive');
    } else {
      saveSettings({
        gcal_refresh_token: tokens.refresh_token,
        gcal_connected_at: new Date().toISOString(),
        gcal_account: scopeText,
        gcal_last_error: ''
      });
      gcal.resetTokenCache('calendar');
    }

    const check = await gcal.selfCheck();
    if (kind === 'drive') {
      if (check.drive && check.drive.ok) {
        await gcal.fetchDriveAccount();
        return res.redirect(back(req, '/admin/google', { msg: 'gdrive-connected' }));
      }
      return fail(`Akun Drive terhubung, tetapi pengujian gagal: ${String((check.drive && check.drive.error) || '').slice(0, 180)}`);
    }

    if (check.calendar && check.calendar.ok) {
      // Backfill: confirmed bookings may have been created while the token was missing.
      let backfill = '';
      try {
        const results = await gcal.syncAll();
        const made = results.filter((r) => r.ok && (r.action === 'created' || r.action === 'updated')).length;
        if (made) backfill = ` ${made} booking terkonfirmasi otomatis dimasukkan ke kalender.`;
      } catch (err) {
        backfill = ' Sinkronisasi booking lama gagal — coba tombol "Sinkronkan semua booking terkonfirmasi".';
      }
      return res.redirect(back(req, '/admin/google', {
        msg: 'gcal-connected',
        note: backfill
      }));
    }
    return fail(`Akun terhubung, tetapi pengujian kalender gagal: ${String((check.calendar && check.calendar.error) || '').slice(0, 180)}`);
  } catch (err) {
    saveSettings(kind === 'drive'
      ? { gdrive_last_error: String(err.message).slice(0, 400) }
      : { gcal_last_error: String(err.message).slice(0, 400) });
    return fail(String(err.message).slice(0, 240));
  }
});

// Verifies the Client ID + Secret PAIRS with Google before trying to connect, so a wrong or
// swapped secret is reported immediately instead of failing at the consent callback (and
// after the old tokens were already dropped).
router.post('/google/verify', auth.verifyCsrf, async (req, res) => {
  const [cal, drv] = await Promise.all([
    gcal.verifyClientPair('calendar'),
    gcal.verifyClientPair('drive')
  ]);
  const lines = [cal.message, drv.message];
  const failed = cal.ok === false || drv.ok === false;
  const unknown = cal.ok === null || drv.ok === null;
  if (failed) return res.redirect(back(req, '/admin/google', { err: lines.join(' ').slice(0, 380) }));
  if (unknown) return res.redirect(back(req, '/admin/google', { note: lines.join(' ').slice(0, 380) }));
  res.redirect(back(req, '/admin/google', { note: lines.join(' ').slice(0, 380) }));
});

router.post('/google/test', auth.verifyCsrf, async (req, res) => {
  try {
    const check = await gcal.selfCheck();
    await gcal.fetchDriveAccount();
    const calOk = check.calendar && check.calendar.ok;
    const driveOk = check.drive && check.drive.ok;
    if (calOk && driveOk) {
      return res.redirect(back(req, '/admin/google', { msg: 'gcal-tested' }));
    }
    const parts = [];
    parts.push(calOk
      ? `Calendar OK${check.calendar && check.calendar.email ? ' (' + check.calendar.email + ')' : ''}`
      : `Calendar GAGAL: ${(check.calendar && check.calendar.error) || 'tidak diketahui'}`);
    parts.push(driveOk
      ? 'Drive OK'
      : `Drive GAGAL: ${(check.drive && check.drive.error) || 'tidak diketahui'}`);
    return res.redirect(back(req, '/admin/google', { err: parts.join(' | ').slice(0, 400) }));
  } catch (err) {
    res.redirect(back(req, '/admin/google', { err: String(err.message).slice(0, 240) }));
  }
});

router.post('/google/disconnect', auth.verifyCsrf, (req, res) => {
  saveSettings({
    gcal_refresh_token: '',
    gcal_connected_at: '',
    gcal_account: '',
    gcal_enabled: '0'
  });
  gcal.resetTokenCache('calendar');
  res.redirect(back(req, '/admin/google', { msg: 'gcal-disconnected' }));
});

router.post('/google/sync-all', auth.verifyCsrf, async (req, res) => {
  const results = await gcal.syncAll();
  const failed = results.filter((r) => r.ok === false && !r.skipped);
  if (failed.length) {
    return res.redirect(back(req, '/admin/google', {
      err: `${results.length - failed.length} booking tersinkron, ${failed.length} gagal. Cek detail di halaman Booking.`
    }));
  }
  res.redirect(back(req, '/admin/google', { msg: 'gcal-all-synced' }));
});

// Landing page for the per-booking Google actions: stay on the detail page when the
// action was triggered from there (the forms send `back_detail`), otherwise the list.
const googleLanding = (req, params) => (req.body.back_detail
  ? back(req, `/admin/bookings/${int(req.params.id)}`, { ...params, tab: 'workflow' })
  : back(req, '/admin/bookings', params));

router.post('/bookings/:id/drive', auth.verifyCsrf, async (req, res) => {
  const id = Number(req.params.id);
  const filters = {
    status: req.body.back_status || undefined,
    kota: req.body.back_kota || undefined,
    dari: req.body.back_dari || undefined,
    sampai: req.body.back_sampai || undefined
  };
  // Saving from the detail page returns to the SAME tab (not always "klien").
  const detailTab = ['detail', 'klien', 'pekerjaan', 'pembayaran', 'workflow'].includes(req.body.back_tab)
    ? req.body.back_tab
    : '';
  const detailId = int(req.params.id);
  if (detailTab) filters.tab = detailTab;

  const result = await gcal.ensureDriveFolder(id);
  if (!result.ok) {
    const reason = result.skipped
      ? 'Google Drive belum aktif atau belum terhubung. Buka menu Google Calendar.'
      : String(result.error || 'Gagal membuat folder.');
    return res.redirect(googleLanding(req, { ...filters, err: `Folder Drive gagal dibuat: ${reason.slice(0, 150)}` }));
  }

  // Push the fresh link into the calendar description right away.
  const synced = await gcal.syncBooking(id, { skipDrive: true });
  const folderNote = result.cached ? 'drive-exists' : 'drive-created';
  if (synced.ok === false && !synced.skipped) {
    return res.redirect(googleLanding(req, {
      ...filters,
      err: `Folder Drive siap, tetapi deskripsi kalender gagal diperbarui: ${String(synced.error || '').slice(0, 120)}`
    }));
  }
  return res.redirect(googleLanding(req, { ...filters, msg: folderNote }));
});

router.post('/bookings/:id/sync-calendar', auth.verifyCsrf, async (req, res) => {
  const result = await gcal.syncBooking(Number(req.params.id));
  const params = { status: req.body.back_status || undefined };
  if (result.ok || result.skipped) {
    if (result.drive && result.drive.ok === false) {
      return res.redirect(googleLanding(req, {
        ...params,
        err: `Kalender tersinkron, tetapi folder Drive gagal dibuat: ${String(result.drive.error || '').slice(0, 120)}`
      }));
    }
    return res.redirect(googleLanding(req, { ...params, msg: 'gcal-synced' }));
  }
  return res.redirect(googleLanding(req, { ...params, err: `Sinkron kalender gagal: ${String(result.error || '').slice(0, 140)}` }));
});


/* ------------------------------------------------------------------ */
/* Payment settings (used by the admin "Chat Klien" template)          */
/* ------------------------------------------------------------------ */
router.get('/payment', (req, res) => {
  const s = getSettings();
  res.render('admin/payment', {
    layout: 'admin/layout',
    title: 'Pembayaran',
    pageTitle: 'Pengaturan Pembayaran',
    values: {
      bankName: s.payment_bank_name || '',
      accountNumber: s.payment_account_number || '',
      accountHolder: s.payment_account_holder || '',
      dpAmount: s.payment_dp_amount || '100000',
      notes: s.payment_notes || ''
    },
    whatsapp: s.whatsapp_number || ''
  });
});

router.post('/payment', auth.verifyCsrf, (req, res) => {
  const dp = int(req.body.dp_amount);
  saveSettings({
    payment_bank_name: str(req.body.bank_name, 80),
    payment_account_number: str(req.body.account_number, 60),
    payment_account_holder: str(req.body.account_holder, 120),
    payment_dp_amount: String(dp && dp > 0 ? dp : 100000),
    payment_notes: str(req.body.notes, 500)
  });
  res.redirect(back(req, '/admin/payment', { msg: 'payment-saved' }));
});

/* ------------------------------------------------------------------ */
/* WhatsApp message template (admin "Chat Klien")                      */
/* ------------------------------------------------------------------ */
router.get('/wa-template', (req, res) => {
  const s = getSettings();
  const sampleVars = util.bookingTemplateVars({
    code: 'DLY-261128-A1B2',
    client_name: 'Nama Klien',
    client_phone: '6281234567890',
    instagram: 'namaklien',
    campus: 'Universitas Padjadjaran',
    faculty: 'Fakultas Teknik',
    major: 'Teknik Informatika',
    city_name: 'Bandung',
    shooting_date_label: 'Sabtu, 28 November 2026',
    shooting_time: '13:30',
    location: 'Unpad - Dipatiukur',
    category_name: 'Individual Package',
    package_name: 'Individu Package',
    duration_minutes: 90,
    price: 450000,
    package_price_snapshot: 450000,
    total_price_snapshot: 475000,
    addons_snapshot: '[{"name":"Extra Edit","price":25000}]',
    notes: 'Mohon sesi sore hari.',
    team_name_snapshot: 'Fadhli'
  });
  const templateNow = s.wa_admin_template || util.DEFAULT_ADMIN_TEMPLATE;
  const selectionTemplateNow = String(s.wa_selection_template || '').trim()
    || selection.DEFAULT_SELECTION_TEMPLATE;
  const selectionSampleVars = selection.waVars({
    portal: { quota: 30 },
    booking: {
      code: 'DLY-261128-A1B2',
      client_name: 'Nama Klien',
      campus: 'Universitas Padjadjaran',
      city_name: 'Bandung',
      package_name: 'Individu Package',
      shooting_date: '2026-11-28',
      shooting_time: '13:30'
    }
  }, 'https://dlygraduation.com/selection/contoh-token-portal');
  selectionSampleVars.folder_drive = 'https://drive.google.com/drive/folders/contoh-folder-id';
  selectionSampleVars.deadline = 'Sabtu, 12 Desember 2026';

  // V9.2: two dedicated WhatsApp actions on the booking card.
  const paymentSample = {
    dp: 'Rp' + Number(s.payment_dp_amount || 100000).toLocaleString('id-ID'),
    bank: s.payment_bank_name || '(nama bank)',
    rekening: s.payment_account_number || '(nomor rekening)',
    atas_nama: s.payment_account_holder || '(nama pemilik rekening)'
  };
  const withPayment = (text) => text
    .replace(/\{\{\s*dp\s*\}\}/gi, paymentSample.dp)
    .replace(/\{\{\s*bank\s*\}\}/gi, paymentSample.bank)
    .replace(/\{\{\s*rekening\s*\}\}/gi, paymentSample.rekening)
    .replace(/\{\{\s*atas_nama\s*\}\}/gi, paymentSample.atas_nama);
  const confirmTemplateNow = String(s.wa_confirm_template || '').trim() || util.DEFAULT_CONFIRM_TEMPLATE;
  const portalTemplateNow = String(s.wa_portal_template || '').trim() || util.DEFAULT_PORTAL_LINK_TEMPLATE;
  // Template tambahan (revisi pemilik): reschedule, daftar pilihan foto dari klien, H-1.
  const rescheduleTemplateNow = String(s.wa_reschedule_template || '').trim() || util.DEFAULT_RESCHEDULE_TEMPLATE;
  const submitTemplateNow = String(s.wa_submit_template || '').trim() || util.DEFAULT_SUBMIT_TEMPLATE;
  const h1TemplateNow = String(s.wa_h1_template || '').trim() || util.DEFAULT_H1_TEMPLATE;
  const rescheduleVars = {
    nama: 'Nama Klien', kode: 'DLY-WISUDA-NAMA001',
    tanggal_lama: 'Sabtu, 28 November 2026', jam_lama: '09:00 WIB', lokasi_lama: 'Unpad - Dipatiukur',
    tanggal_baru: 'Minggu, 29 November 2026', jam_baru: '13:30 WIB', lokasi_baru: 'Gedung Sate'
  };
  const submitVars = {
    nama: 'Nama Klien', kampus: 'Universitas Padjadjaran', paket: 'Individu Package',
    kode: 'DLY-WISUDA-NAMA001', jumlah: '3', daftar_foto: 'DLY00013\nDLY00021\nDLY00034'
  };
  const h1Vars = util.h1Vars({
    client_name: 'Nama Klien', team_label: 'Fadhli',
    date_label: 'Sabtu, 28 November 2026', time_label: '13:30–15:00',
    lokasi: 'Unpad - Dipatiukur', code: 'DLY-WISUDA-NAMA001',
    campus: 'Universitas Padjadjaran', package_name: 'Individu Package'
  });

  res.render('admin/wa-template', {
    layout: 'admin/layout',
    title: 'Template Chat',
    pageTitle: 'Template Chat',
    template: templateNow,
    preview: util.renderTemplate(templateNow, sampleVars),
    isDefault: !s.wa_admin_template,
    useEmoji: s.wa_booking_use_emoji === '1',
    // V9: portal seleksi foto
    selectionTemplate: selectionTemplateNow,
    selectionPreview: util.renderTemplate(selectionTemplateNow, selectionSampleVars),
    selectionIsDefault: !s.wa_selection_template,
    confirmTemplate: confirmTemplateNow,
    confirmPreview: withPayment(util.renderTemplate(confirmTemplateNow, sampleVars)),
    confirmIsDefault: !String(s.wa_confirm_template || '').trim(),
    portalTemplate: portalTemplateNow,
    portalPreview: util.renderTemplate(portalTemplateNow, selectionSampleVars),
    portalIsDefault: !String(s.wa_portal_template || '').trim(),
    selectionPlaceholders: [
      ['{{nama}}', 'Nama klien'], ['{{link}}', 'Link portal seleksi'],
      ['{{kuota}}', 'Kuota foto pilihan'], ['{{paket}}', 'Nama paket'],
      ['{{paket_text}}', 'Nama paket dengan awalan " — paket "'],
      ['{{folder_drive}}', 'Link folder Drive portal (bila ada)'],
      ['{{tanggal}}', 'Tanggal pemotretan'], ['{{jam}}', 'Jam pemotretan'],
      ['{{booking_id}}', 'Kode booking'], ['{{kampus}}', 'Kampus'], ['{{kota}}', 'Kota']
    ],
    rescheduleTemplate: rescheduleTemplateNow,
    reschedulePreview: util.renderTemplate(rescheduleTemplateNow, rescheduleVars),
    rescheduleIsDefault: !String(s.wa_reschedule_template || '').trim(),
    reschedulePlaceholders: [
      ['{{nama}}', 'Nama klien'], ['{{kode}}', 'Kode booking'],
      ['{{tanggal_lama}}', 'Tanggal lama'], ['{{jam_lama}}', 'Jam lama'],
      ['{{lokasi_lama}}', 'Lokasi lama'], ['{{tanggal_baru}}', 'Tanggal baru'],
      ['{{jam_baru}}', 'Jam baru'], ['{{lokasi_baru}}', 'Lokasi baru']
    ],
    submitTemplate: submitTemplateNow,
    submitPreview: util.renderTemplate(submitTemplateNow, submitVars),
    submitIsDefault: !String(s.wa_submit_template || '').trim(),
    submitPlaceholders: [
      ['{{nama}}', 'Nama klien'], ['{{kampus}}', 'Kampus'], ['{{paket}}', 'Nama paket'],
      ['{{kode}}', 'Kode booking'], ['{{jumlah}}', 'Jumlah foto dipilih'],
      ['{{daftar_foto}}', 'Daftar nama file (satu per baris)']
    ],
    h1Template: h1TemplateNow,
    h1Preview: util.renderTemplate(h1TemplateNow, h1Vars),
    h1IsDefault: !String(s.wa_h1_template || '').trim(),
    h1Placeholders: [
      ['{{nama}}', 'Nama klien'], ['{{tim}}', 'Tim yang bertugas'],
      ['{{tanggal}}', 'Tanggal sesi'], ['{{jam}}', 'Jam sesi'],
      ['{{lokasi}}', 'Lokasi'], ['{{kode}}', 'Kode booking'],
      ['{{kampus}}', 'Kampus'], ['{{paket}}', 'Nama paket']
    ],
    placeholders: [
      ['{{nama}}', 'Nama klien'], ['{{tanggal}}', 'Tanggal pemotretan'],
      ['{{jam}}', 'Jam pemotretan'], ['{{lokasi}}', 'Lokasi'],
      ['{{paket}}', 'Nama paket'], ['{{kategori}}', 'Kategori layanan'],
      ['{{durasi}}', 'Durasi'], ['{{kota}}', 'Kota'],
      ['{{harga}}', 'Harga paket'], ['{{total}}', 'Total estimasi'],
      ['{{addons}}', 'Daftar add-on'], ['{{tim}}', 'Tim yang bertugas'],
      ['{{whatsapp}}', 'Nomor WhatsApp klien'], ['{{instagram}}', 'Instagram klien'],
      ['{{kampus}}', 'Kampus'], ['{{fakultas}}', 'Fakultas'], ['{{jurusan}}', 'Jurusan'],
      ['{{booking_id}}', 'Kode booking'], ['{{catatan}}', 'Catatan klien']
    ]
  });
});

router.post('/wa-template', auth.verifyCsrf, (req, res) => {
  const action = String(req.body.action || 'save');
  if (action === 'reset') {
    saveSettings({ wa_admin_template: '' });
    return res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
  }
  saveSettings({
    wa_admin_template: str(req.body.template, 3000),
    wa_booking_use_emoji: req.body.use_emoji ? '1' : '0'
  });
  res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
});

// V9.2 — "Konfirmasi Booking & DP" template (first WhatsApp button).
router.post('/wa-template/confirm', auth.verifyCsrf, (req, res) => {
  if (String(req.body.action || 'save') === 'reset') {
    saveSettings({ wa_confirm_template: '' });
    return res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
  }
  saveSettings({ wa_confirm_template: str(req.body.template, 3000) });
  res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
});

// V9.2 — "Kirim Link Portal Seleksi Foto" template (second WhatsApp button).
router.post('/wa-template/portal', auth.verifyCsrf, (req, res) => {
  if (String(req.body.action || 'save') === 'reset') {
    saveSettings({ wa_portal_template: '' });
    return res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
  }
  saveSettings({ wa_portal_template: str(req.body.template, 3000) });
  res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
});

// V9 — WhatsApp invite for the client photo-selection portal.
router.post('/wa-template/selection', auth.verifyCsrf, (req, res) => {
  const action = String(req.body.action || 'save');
  if (action === 'reset') {
    saveSettings({ wa_selection_template: '' });
    return res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
  }
  saveSettings({ wa_selection_template: str(req.body.template, 3000) });
  res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
});

// Revisi: template chat tambahan — satu handler generik (whitelist key).
const EXTRA_WA_TEMPLATES = {
  reschedule: 'wa_reschedule_template',
  submit: 'wa_submit_template',
  h1: 'wa_h1_template'
};
router.post('/wa-template/:kind', auth.verifyCsrf, (req, res) => {
  const kind = String(req.params.kind || '');
  const key = EXTRA_WA_TEMPLATES[kind];
  if (!key) return res.status(404).redirect(back(req, '/admin/wa-template', { err: 'Template tidak dikenal.' }));
  if (String(req.body.action || 'save') === 'reset') {
    saveSettings({ [key]: '' });
    return res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
  }
  saveSettings({ [key]: str(req.body.template, 3000) });
  res.redirect(back(req, '/admin/wa-template', { msg: 'wa-template-saved' }));
});

/* ------------------------------------------------------------------ */
/* Page visibility / navigation                                        */
/* ------------------------------------------------------------------ */
const PAGE_TOGGLES = [
  { key: 'page_gallery_visible', label: 'Gallery', path: '/gallery', note: 'Portfolio foto' },
  { key: 'page_caraorder_visible', label: 'Cara Order', path: '/cara-order', note: 'Alur pemesanan' },
  { key: 'page_ulasan_visible', label: 'Ulasan', path: '/ulasan', note: 'Testimoni klien' },
  { key: 'page_artikel_visible', label: 'Artikel', path: '/artikel', note: 'Artikel & panduan' },
  { key: 'page_faq_visible', label: 'FAQ', path: '/faq', note: 'Pertanyaan umum' },
  { key: 'page_tentang_visible', label: 'Tentang Kami', path: '/tentang', note: 'Profil studio' },
  { key: 'page_tnc_visible', label: 'Syarat & Ketentuan', path: '/syarat-ketentuan', note: 'Halaman TnC' }
];

router.get('/pages', (req, res) => {
  const s = getSettings();
  const rows = PAGE_TOGGLES.map((p) => ({
    ...p,
    visible: s[p.key] !== '0',
    isDefault: s[p.key] === undefined
  }));
  res.render('admin/pages', {
    layout: 'admin/layout',
    title: 'Halaman & Navigasi',
    pageTitle: 'Halaman & Navigasi',
    pages: rows
  });
});

router.post('/pages', auth.verifyCsrf, (req, res) => {
  const values = {};
  PAGE_TOGGLES.forEach((p) => {
    values[p.key] = req.body[p.key] ? '1' : '0';
  });
  saveSettings(values);
  res.redirect(back(req, '/admin/pages', { msg: 'pages-saved' }));
});

/* ------------------------------------------------------------------ */
/* Contact settings + password                                        */
/* ------------------------------------------------------------------ */
router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    layout: 'admin/layout', title: 'Contact Settings', pageTitle: 'Contact Settings',
    values: getSettings(), adminUser: req.admin.username,
    // Panel Keamanan (Revisi 5) — status nyata, bukan teks statis.
    securityStatus: security.status(),
    securityHints: {
      https: String(req.get('x-forwarded-proto') || req.protocol || '') === 'https',
      loginWindowMinutes: 15,
      loginMaxAttempts: Number(auth.MAX_ATTEMPTS) || 6
    }
  });
});

router.post('/settings', auth.verifyCsrf, (req, res) => {
  const wa = util.normalizePhone(req.body.whatsapp_number);
  if (!util.isValidPhone(wa)) return res.redirect(back(req, '/admin/settings', { err: 'Nomor WhatsApp tidak valid.' }));
  saveSettings({
    whatsapp_number: wa,
    instagram_handle: String(req.body.instagram_handle || '').replace(/^@/, '').trim(),
    brand_name: str(req.body.brand_name, 80) || 'DLY Graduation',
    brand_tagline: str(req.body.brand_tagline, 120),
    planned_domain: str(req.body.planned_domain, 120),
    domain_note: str(req.body.domain_note, 300)
  });
  res.redirect(back(req, '/admin/settings', { msg: 'settings-saved' }));
});

router.post('/settings/password', auth.verifyCsrf, (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  // Kebijakan password (src/security.js): min 10 karakter, huruf + angka, bukan yang
  // mudah ditebak. Berlaku juga saat admin membuat password baru.
  const policy = security.checkPassword(next);
  if (!policy.ok) return res.redirect(back(req, '/admin/settings', { err: policy.message }));
  if (next !== String(req.body.confirm_password || '')) {
    return res.redirect(back(req, '/admin/settings', { err: 'Konfirmasi password tidak sama.' }));
  }
  if (!auth.changePassword(req.admin.id, current, next)) {
    return res.redirect(back(req, '/admin/settings', { err: 'Password saat ini salah.' }));
  }
  res.redirect(back(req, '/admin/settings', { msg: 'password-changed' }));
});

module.exports = router;

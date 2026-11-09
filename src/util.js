'use strict';

const crypto = require('crypto');
const { db, getSettings } = require('./db');

/**
 * Kategori portfolio BAWAAN. Sejak revisi terbaru daftar ini hidup di tabel
 * `portfolio_categories` dan bisa diubah admin (tambah/rename/urut/nonaktif), jadi
 * konstanta ini hanya dipakai sebagai fallback bila tabelnya belum terisi.
 * "Graduation Event" dihapus sesuai permintaan pemilik.
 */
const PORTFOLIO_CATEGORIES = [
  { value: 'individual', label: 'Individual' },
  { value: 'couple', label: 'Couple' },
  { value: 'group', label: 'Group' }
];

/**
 * Daftar kategori aktif dari database (single source of truth untuk form portfolio,
 * filter Gallery, dan label kartu). Bentuknya sama dengan PORTFOLIO_CATEGORIES
 * ({value, label}) supaya seluruh view/test lama tetap bekerja.
 * @param {{activeOnly?:boolean}} opts
 */
function portfolioCategories({ activeOnly = true } = {}) {
  let rows = [];
  try {
    rows = db.prepare(`SELECT slug, label, is_active FROM portfolio_categories
                       ${activeOnly ? 'WHERE is_active = 1' : ''}
                       ORDER BY sort_order, id`).all();
  } catch (err) { rows = []; }
  const list = rows.map((r) => ({
    value: String(r.slug),
    label: String(r.label || r.slug),
    active: Number(r.is_active) === 1
  }));
  return list.length ? list : PORTFOLIO_CATEGORIES.map((c) => ({ ...c, active: true }));
}

const portfolioCategoryLabel = (value) => (
  portfolioCategories({ activeOnly: false }).find((c) => c.value === String(value || '')) || {}
).label || String(value || '');

const STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' }
];

/** Status yang boleh dipilih saat admin menambah client manual (tanpa 'pending'). */
const MANUAL_STATUSES = STATUSES.filter((s) => s.value !== 'pending');

const COLLECTIONS = [
  { value: 'portfolio', label: 'Gallery saja' },
  { value: 'carousel', label: 'Carousel homepage saja' },
  { value: 'both', label: 'Gallery + carousel' }
];

const MAX_DURATION = 600;
const WEEKDAYS = [
  { value: 0, label: 'Minggu' }, { value: 1, label: 'Senin' }, { value: 2, label: 'Selasa' },
  { value: 3, label: 'Rabu' }, { value: 4, label: 'Kamis' }, { value: 5, label: 'Jumat' },
  { value: 6, label: 'Sabtu' }
];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function rupiah(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return 'Rp ' + n.toLocaleString('id-ID');
}

function cleanPrice(value) {
  if (value == null) return null;
  const raw = String(value).replace(/[^0-9]/g, '');
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

function formatDateID(value, withWeekday) {
  if (!value) return '';
  const d = new Date(String(value) + (String(value).length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(d.getTime())) return String(value);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (!withWeekday) return base;
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  return `${days[d.getDay()]}, ${base}`;
}

function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  return digits;
}

function isValidPhone(input) {
  return /^62\d{8,14}$/.test(normalizePhone(input));
}

function bookingCode(date) {
  const d = date ? new Date(date) : new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `DLY-${yy}${mm}${dd}-${rand}`;
}

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function facilitiesList(raw) {
  if (!raw) return [];
  return String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
}

function lines(raw) {
  if (!raw) return [];
  return String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** "Judul | Deskripsi" per line → [{title, description}] */
function pairedLines(raw) {
  return lines(raw).map((line) => {
    const [title, ...rest] = line.split('|');
    return { title: (title || '').trim(), description: rest.join('|').trim() };
  }).filter((p) => p.title);
}

function todayISO() {
  const now = new Date();
  const tz = new Date(now.getTime() + 7 * 3600 * 1000); // WIB
  return tz.toISOString().slice(0, 10);
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Add N WORKING days (Mon–Fri; Saturday and Sunday are skipped).
 * Used for the editing deadline (10 hari kerja from the client's submission).
 */
function addWorkingDaysISO(iso, days, holidays = []) {
  const skip = new Set((Array.isArray(holidays) ? holidays : []).map((h) => String(h).slice(0, 10)));
  let d = String(iso).slice(0, 10);
  let left = Math.max(0, Number(days) || 0);
  let guard = 0;
  while (left > 0 && guard < 3650) {
    d = addDaysISO(d, 1);
    const weekday = new Date(d + 'T00:00:00Z').getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (weekday !== 0 && weekday !== 6 && !skip.has(d)) left -= 1;
    guard += 1;
  }
  return d;
}

/** "2026-11-07 03:22:10" (UTC dari SQLite) → "7 November 2026, 10:22 WIB". */
function formatDateTimeWIB(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  if (!Number.isFinite(ms)) return raw;
  const wib = new Date(ms + 7 * 3600 * 1000);
  const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus',
    'September', 'Oktober', 'November', 'Desember'];
  const hh = String(wib.getUTCHours()).padStart(2, '0');
  const mm = String(wib.getUTCMinutes()).padStart(2, '0');
  return `${wib.getUTCDate()} ${months[wib.getUTCMonth()]} ${wib.getUTCFullYear()}, ${hh}:${mm} WIB`;
}

function whatsappLink(number, message) {
  const n = String(number || '').replace(/\D/g, '');
  return `https://wa.me/${n}` + (message ? `?text=${encodeURIComponent(message)}` : '');
}

/* ------------------------------------------------------------------ */
/* Cities & categories                                                 */
/* ------------------------------------------------------------------ */
const getActiveCities = () => db.prepare(
  'SELECT * FROM cities WHERE is_active = 1 ORDER BY sort_order ASC, name ASC'
).all();

const getAllCities = () => db.prepare(
  'SELECT * FROM cities ORDER BY sort_order ASC, name ASC'
).all();

const getActiveCategories = () => db.prepare(
  'SELECT * FROM package_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
).all();

const getAllCategories = () => db.prepare(
  'SELECT * FROM package_categories ORDER BY sort_order ASC, id ASC'
).all();

const getCityBySlug = (slug) => db.prepare('SELECT * FROM cities WHERE slug = ?').get(String(slug));

const durationsFor = (packageId, activeOnly = true) => db.prepare(
  `SELECT * FROM package_durations WHERE package_id = ? ${activeOnly ? 'AND is_active = 1' : ''}
   ORDER BY sort_order ASC, duration_minutes ASC`
).all(packageId);

/* ------------------------------------------------------------------ */
/* Add-ons                                                             */
/* ------------------------------------------------------------------ */
const addonSelect = `SELECT * FROM addons WHERE is_active = 1`;

/** Active add-ons, optionally limited to what a category supports. */
function addonsForCategory(categoryId) {
  const rows = db.prepare(`${addonSelect} ORDER BY sort_order ASC, id ASC`).all();
  const cat = categoryId
    ? db.prepare('SELECT slug FROM package_categories WHERE id = ?').get(categoryId)
    : null;
  return rows
    .filter((a) => {
      const scope = String(a.applies_to || 'all');
      if (scope === 'all') return true;
      if (!cat) return false;
      return scope.split(',').map((s) => s.trim()).filter(Boolean).includes(cat.slug);
    })
    .map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description || '',
      // price NULL/0 → shown as "Harga belum diatur" and NOT selectable publicly
      price: a.price == null || Number(a.price) <= 0 ? null : Number(a.price),
      applies_to: a.applies_to || 'all'
    }));
}

const getAllAddons = () => db.prepare('SELECT * FROM addons ORDER BY sort_order ASC, id ASC').all();

/* ------------------------------------------------------------------ */
/* Package benefits (V8): one row per benefit, each with an icon        */
/* ------------------------------------------------------------------ */
/** Active benefits for one package, already in display order. */
function benefitsForPackage(packageId) {
  return db.prepare(`SELECT id, text, icon, sort_order, is_active FROM package_benefits
                     WHERE package_id = ? AND is_active = 1
                     ORDER BY sort_order ASC, id ASC`).all(packageId);
}

/** Every benefit row (incl. inactive) — used by the admin editor. */
function allBenefitsForPackage(packageId) {
  return db.prepare(`SELECT id, text, icon, sort_order, is_active FROM package_benefits
                     WHERE package_id = ? ORDER BY sort_order ASC, id ASC`).all(packageId);
}

/* ------------------------------------------------------------------ */
/* Catalogue: city → category(→package) → durations                    */
/* ------------------------------------------------------------------ */
/**
 * One entry per package. Public callers only receive packages that are
 * active, belong to an active category and a city, and carry durations.
 */
function catalogForCity(cityId, { activeOnly = true } = {}) {
  const rows = db.prepare(
    `SELECT p.*, k.name AS category_name, k.slug AS category_slug, k.sort_order AS category_order
     FROM packages p
     JOIN package_categories k ON k.id = p.category_id
     WHERE p.city_id = ? ${activeOnly ? 'AND p.is_active = 1 AND k.is_active = 1' : ''}
     ORDER BY k.sort_order ASC, p.sort_order ASC, p.id ASC`
  ).all(cityId);

  return rows.map((p) => {
    const durations = durationsFor(p.id, activeOnly).map((d) => ({
      id: d.id,
      minutes: d.duration_minutes,
      price: d.price == null || Number(d.price) <= 0 ? null : Number(d.price),
      // Photo count belongs to the duration; fall back to the package value for old rows.
      edited_photos: d.edited_photos == null ? (p.edited_photos == null ? null : Number(p.edited_photos))
        : Number(d.edited_photos),
      description: d.description || ''
    }));
    const gallery = db.prepare(`SELECT id, image, caption, is_primary FROM package_images
                                WHERE package_id = ? ORDER BY is_primary DESC, sort_order, id`).all(p.id);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      label: p.label || '',
      tagline: p.tagline || '',
      terms: lines(p.terms),
      is_best_seller: Number(p.is_best_seller) === 1,
      // Label "Recommended" (revisi pemilik) — dipakai badge bintang di pricelist.
      is_recommended: Number(p.is_recommended) === 1,
      sold_visible: Number(p.sold_visible) !== 0,
      sold_count: p.sold_count == null ? null : Number(p.sold_count),
      sold_label: (p.sold_label || '').trim(),
      description: p.description || '',
      image: p.image || '',
      gallery,
      edited_photos: p.edited_photos,
      facilities: facilitiesList(p.facilities),
      // V8: benefits come from package_benefits (icon + order). The legacy
      // facilities text stays as a read-only fallback for rows with no benefit rows.
      benefits: (() => {
        const rows = benefitsForPackage(p.id);
        if (rows.length) return rows.map((b) => ({ id: b.id, text: b.text, icon: b.icon }));
        return facilitiesList(p.facilities).map((text) => ({ id: null, text, icon: 'check' }));
      })(),
      category_id: p.category_id,
      category_name: p.category_name,
      category_slug: p.category_slug,
      durations,
      priced: durations.some((d) => d.price),
      starting_price: durations.reduce((min, d) => (d.price && (!min || d.price < min) ? d.price : min), null)
    };
  });
}

/** Categories that actually have packages for a city, with add-ons attached. */
function categoriesWithPackages(cityId) {
  const packages = catalogForCity(cityId);
  return getActiveCategories()
    .map((k) => {
      const pkgs = packages.filter((p) => p.category_id === k.id);
      return {
        id: k.id,
        name: k.name,
        slug: k.slug,
        description: k.description || '',
        packages: pkgs,
        addons: pkgs.length ? addonsForCategory(k.id) : []
      };
    })
    .filter((k) => k.packages.length > 0);
}

function buildCatalog() {
  return getActiveCities().map((city) => ({
    id: city.id,
    name: city.name,
    slug: city.slug,
    categories: categoriesWithPackages(city.id),
    starting_price: (() => {
      const prices = catalogForCity(city.id).map((p) => p.starting_price).filter(Boolean);
      return prices.length ? Math.min(...prices) : null;
    })()
  }));
}

function packagePrice(packageId, minutes) {
  const row = db.prepare(`SELECT * FROM package_durations
                          WHERE package_id = ? AND duration_minutes = ? AND is_active = 1`).get(packageId, minutes);
  if (!row || row.price == null || Number(row.price) <= 0) return null;
  return Number(row.price);
}

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */
function availabilityRules() {
  const s = getSettings();
  const closed = String(s.booking_closed_weekdays || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return {
    leadDays: Math.max(0, Number(s.booking_lead_days) || 0),
    advanceDays: Math.min(730, Math.max(1, Number(s.booking_advance_days) || 180)),
    closedWeekdays: closed,
    dailyCapacity: Math.max(0, Number(s.booking_daily_capacity) || 0)
  };
}

const ACTIVE_BOOKING_STATUSES = "('pending','confirmed','completed')";

/** Bookings already occupying each date (only statuses that still hold a slot). */
/** Statuses that occupy a slot (cancelled bookings never hold capacity). */
const ACTIVE_BOOKING_STATUSES_SQL = ACTIVE_BOOKING_STATUSES;

/** Bookings that count toward capacity on one date, optionally excluding one booking. */
function bookedCountOn(dateISO, excludeBookingId = 0) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM bookings
                          WHERE status IN ${ACTIVE_BOOKING_STATUSES}
                            AND shooting_date = ? AND id <> ?`)
    .get(String(dateISO), Number(excludeBookingId) || 0);
  return Number(row.n) || 0;
}

function bookingCountsByDate(fromISO, toISO) {
  const rows = db.prepare(`SELECT shooting_date AS d, COUNT(*) AS n FROM bookings
                           WHERE status IN ${ACTIVE_BOOKING_STATUSES}
                             AND shooting_date BETWEEN ? AND ?
                           GROUP BY shooting_date`).all(fromISO, toISO);
  return Object.fromEntries(rows.map((r) => [r.d, r.n]));
}

function overridesBetween(fromISO, toISO) {
  const rows = db.prepare('SELECT * FROM availability_overrides WHERE date BETWEEN ? AND ?').all(fromISO, toISO);
  return Object.fromEntries(rows.map((r) => [r.date, r]));
}

/**
 * Real availability, computed from: lead time, advance window, closed weekdays,
 * manual overrides and existing bookings vs. daily capacity.
 */
function availabilityForRange(fromISO, toISO) {
  const rules = availabilityRules();
  const counts = bookingCountsByDate(fromISO, toISO);
  const overrides = overridesBetween(fromISO, toISO);
  const today = todayISO();
  const out = {};
  for (let d = fromISO; d <= toISO; d = addDaysISO(d, 1)) {
    if (d > addDaysISO(today, rules.advanceDays)) break;
    const ov = overrides[d];
    const weekday = new Date(d + 'T00:00:00Z').getUTCDay();
    let available = true;
    let reason = '';
    if (d < addDaysISO(today, rules.leadDays)) { available = false; reason = 'lead'; }
    else if (rules.closedWeekdays.includes(weekday)) { available = false; reason = 'closed'; }
    else if (rules.dailyCapacity > 0 && (counts[d] || 0) >= rules.dailyCapacity) { available = false; reason = 'full'; }

    // Manual override — priority: Ditutup > Full Booking manual > perhitungan kapasitas.
    if (ov) {
      if (Number(ov.is_available) === 0) {
        available = false;
        reason = 'blocked';
      } else if (Number(ov.full_booking) === 1) {
        available = false;
        reason = 'full-manual';
      } else if (reason === 'full') {
        // Re-opening a date must never pretend a genuinely full date is available.
        available = false;
      } else {
        available = true;
        reason = '';
      }
    }

    const booked = counts[d] || 0;
    const isFull = available ? false : (reason === 'full' || reason === 'full-manual');
    out[d] = {
      available,
      reason,
      note: ov && ov.note ? ov.note : '',
      booked,
      capacity: rules.dailyCapacity,
      manual_full: Boolean(ov && Number(ov.full_booking) === 1),
      closed: Boolean(ov && Number(ov.is_available) === 0),
      status: available ? 'available' : (reason === 'blocked' || reason === 'closed' ? 'closed' : (isFull ? 'full' : 'unavailable'))
    };
  }
  return out;
}

function isDateBookable(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) return false;
  const map = availabilityForRange(dateISO, dateISO);
  return Boolean(map[dateISO] && map[dateISO].available);
}

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */
/**
 * Renders a stored WhatsApp template. Placeholders use {{name}} so the owner can reorder
 * lines without touching code. Unknown placeholders are left as-is (visible, not silently dropped).
 */
/**
 * Struktur Syarat & Ketentuan (revisi pemilik): poin di dalam poin.
 *
 * Format teks (satu baris = satu item, diedit admin di Dashboard → Syarat & Ketentuan):
 *   "A. PEMESANAN DAN PEMBAYARAN"   → judul bagian (huruf/angka + titik, tanpa strip)
 *   "- Klien wajib membayar DP..."  → poin
 *   "-- Poin di dalam poin..."      → sub-poin (boleh juga "  - ..." / "* ...")
 *   "Teks biasa"                    → tetap dibaca sebagai poin (data lama tetap tampil)
 *
 * @returns {Array<{type:'section'|'point', label?:string, text?:string, subs:string[]}>}
 */
function tncStructure(text) {
  const rows = String(text || '').split(/\r?\n/);
  const out = [];
  let current = null;

  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

  rows.forEach((raw) => {
    const line = String(raw || '');
    if (!line.trim()) return;

    // Sub-poin: "-- ", "- - ", "o ", "* ", atau indentasi 2+ spasi lalu "- ".
    const sub = line.match(/^\s*(?:--+\s+|o\s+|\*\s+|\u2022\s*[-–]\s*|\s{2,}[-*•]\s*)(.+)$/);
    if (sub && current && current.type === 'point') {
      current.subs.push(clean(sub[1]));
      return;
    }

    // Judul bagian: "A. JUDUL", "1) JUDUL", atau "## JUDUL".
    const section = line.match(/^\s*(?:##\s*|([A-Za-z]|\d{1,2})\s*[.)]\s+)(.+)$/);
    if (section && (line.trim().startsWith('##') || /[A-Z]{2}/.test(section[2]))) {
      out.push({
        type: 'section',
        marker: clean(section[1] || ''),
        label: clean(section[2])
      });
      current = null;
      return;
    }

    // Poin biasa (strip/bullet di depan dibuang).
    const point = clean(line.replace(/^\s*[-*•]\s*/, ''));
    if (!point) return;
    current = { type: 'point', text: point, subs: [] };
    out.push(current);
  });

  return out;
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const k = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? '' : vars[k]) : whole;
  });
}

/** Variables shared by every booking template. */
function bookingTemplateVars(b) {
  const addons = Array.isArray(b.addons) ? b.addons : [];
  return {
    booking_id: b.code || '',
    nama: b.client_name || '',
    whatsapp: b.client_phone || '',
    instagram: b.instagram ? '@' + b.instagram : '-',
    kampus: b.campus || '-',
    fakultas: b.faculty || '-',
    jurusan: b.major || '-',
    kota: b.city_name || '-',
    tanggal: b.shooting_date_label || b.shooting_date || '-',
    jam: b.shooting_time ? b.shooting_time + ' WIB' : '-',
    lokasi: [b.location, b.location_address].filter(Boolean).join(' — ') || '-',
    kategori: b.category_name || '-',
    paket: b.package_name || '-',
    durasi: (b.duration_minutes || b.duration || '') + ' menit',
    addons: addons.length ? addons.map((a) => `${a.name} (${rupiah(a.price) || '-'})`).join(', ') : '-',
    harga: rupiah(b.package_price_snapshot || b.price) || '-',
    total: rupiah(b.total_price_snapshot || b.price) || '-',
    catatan: b.notes && String(b.notes).trim() ? b.notes : '-',
    tim: b.team_name_snapshot || '-',
    // Client Portal (blueprint §10.2): kode + PIN + tautan portal.
    kode: b.code || '-',
    pin: b.portal_pin || '(belum dibuat)',
    portal: b.portal_url || '-'
  };
}

/** Default admin confirmation template — plain text, no emoji, editable from the dashboard. */
const DEFAULT_CONFIRM_TEMPLATE = [
  'Halo Kak {{nama}}! 👋😊',
  '',
  'Terima kasih sudah booking sesi foto di *DLY Graduation*! Kami senang bisa menjadi bagian dari momen spesial Kakak. 📸✨',
  '',
  'Kami ingin mengonfirmasi jadwal sesi foto Kakak:',
  '',
  '📅 *Tanggal:* {{tanggal}}',
  '⏰ *Jam:* {{jam}}',
  '',
  'Apakah jadwal tersebut sudah benar, Kak? 😊',
  '',
  'Jika sudah sesuai, Kakak bisa melanjutkan ke tahap berikutnya dengan melakukan pembayaran DP terlebih dahulu yaa.',
  '',
  '🔐 *Client Portal DLY Graduation*',
  'Kode Booking: {{kode}}',
  'PIN: {{pin}}',
  'Masuk di: {{portal}}',
  '',
  '💳 *Pembayaran DP: {{dp}}*',
  '',
  'Dapat ditransfer melalui rekening berikut:',
  '',
  '🏦 *Bank:* {{bank}}',
  '🔢 *Nomor Rekening:* {{rekening}}',
  '👤 *Atas Nama:* {{atas_nama}}',
  '',
  'Setelah melakukan transfer, jangan lupa kirimkan bukti pembayarannya kepada kami ya, Kak, agar booking bisa segera kami proses. 😊🙏🏻'
].join('\n');

/** Default "kirim link portal seleksi" template (used by the second WhatsApp button). */
const DEFAULT_PORTAL_LINK_TEMPLATE = [
  'Halo Kak {{nama}}! 👋😊',
  '',
  'Foto-foto sesi wisuda Kakak sudah tersedia dan siap dipilih.',
  '',
  'Silakan buka link berikut untuk memilih foto yang ingin diedit:',
  '',
  '📸 *Link Portal:* {{link}}',
  '',
  'Jumlah maksimal pilihan: {{kuota}} foto.',
  'Batas waktu pemilihan: {{deadline}}.',
  '',
  'Silakan pilih foto favorit Kakak dan tekan tombol Kirim Pilihan setelah selesai yaa.',
  '',
  'Terima kasih sudah mempercayakan momen spesial Kakak kepada DLY Graduation! 📸✨'
].join('\n');
const DEFAULT_ADMIN_TEMPLATE = [
  'Halo Kak {{nama}}!',
  '',
  'Terima kasih sudah melakukan booking sesi foto di DLY Graduation.',
  '',
  'Kami ingin mengonfirmasi jadwal sesi foto Kakak:',
  '',
  'Tanggal: {{tanggal}}',
  'Jam: {{jam}}',
  'Lokasi: {{lokasi}}',
  'Paket: {{paket}}',
  '',
  'Apakah jadwal tersebut sudah sesuai, Kak?',
  '',
  'Jika sudah sesuai, Kakak dapat melanjutkan ke tahap berikutnya sesuai instruksi pembayaran dari admin.',
  '',
  'Terima kasih telah mempercayakan momen spesial Kakak kepada DLY Graduation.'
].join('\n');

/**
 * Template chat tambahan (revisi pemilik: SEMUA pesan WhatsApp bisa diubah admin).
 * Disimpan di settings; string kosong = pakai bawaan di bawah ini.
 */
const DEFAULT_RESCHEDULE_TEMPLATE = [
  'Halo Kak {{nama}}, kami ingin mengonfirmasi perubahan jadwal pemotretan DLY Graduation.',
  '',
  'Kode booking: {{kode}}',
  '',
  'Jadwal sebelumnya:',
  '{{tanggal_lama}} · {{jam_lama}}',
  'Lokasi sebelumnya: {{lokasi_lama}}',
  '',
  'Jadwal terbaru:',
  '{{tanggal_baru}} · {{jam_baru}}',
  'Lokasi terbaru: {{lokasi_baru}}',
  '',
  'Mohon konfirmasi apakah perubahan jadwal dan lokasi tersebut sudah sesuai ya, Kak. Terima kasih!'
].join('\n');

const DEFAULT_SUBMIT_TEMPLATE = [
  'Hallo kak, Berikut untuk daftar foto edit aku yaa',
  '',
  'Atas Nama: {{nama}}',
  '',
  'Kampus: {{kampus}}',
  '',
  '{{daftar_foto}}'
].join('\n');

const DEFAULT_H1_TEMPLATE = [
  'Halo kak {{nama}}',
  'Perkenalkan aku {{tim}} dari DLY Graduation. Izin konfirmasi ya kak untuk sesi foto besok.',
  '',
  '\uD83D\uDCC5 {{tanggal}}',
  '\uD83D\uDD58 {{jam}}',
  '\uD83D\uDCCD {{lokasi}}',
  '',
  'Apakah sudah benar? Terimakasih kak \uD83D\uDE4F'
].join('\n');

/** Variabel untuk template H-1 (dipakai juga di deskripsi Google Calendar). */
function h1Vars(b) {
  return {
    nama: b.client_name || 'Kak',
    tim: b.team_label || 'tim',
    tanggal: b.date_label || b.tanggal || '-',
    jam: b.time_label || '-',
    lokasi: b.lokasi || '-',
    kode: b.code || '-',
    kampus: b.campus || '-',
    paket: b.package_name || '-'
  };
}

function bookingMessage(b) {
  const addons = Array.isArray(b.addons) ? b.addons : [];
  const addonText = addons.length
    ? addons.map((a) => `${a.name}${a.price ? ' (' + rupiah(a.price) + ')' : ''}`).join(', ')
    : '-';
  return [
    'Halo DLY Graduation, saya ingin melakukan booking sesi foto wisuda.',
    '',
    `Booking ID: ${b.code}`,
    '',
    `Nama: ${b.client_name}`,
    `WhatsApp: ${b.client_phone}`,
    `Instagram: ${b.instagram || '-'}`,
    `Kampus: ${b.campus}`,
    `Fakultas: ${b.faculty || '-'}`,
    `Jurusan: ${b.major || '-'}`,
    '',
    `Kota: ${b.city_name}`,
    `Tanggal: ${b.shooting_date_label || b.shooting_date}`,
    `Jam: ${b.shooting_time ? b.shooting_time + ' WIB' : '-'}`,
    `Lokasi: ${b.location}${b.location_address ? ' — ' + b.location_address : ''}`,
    '',
    `Kategori: ${b.category_name || '-'}`,
    `Durasi: ${b.duration_label || (b.duration_minutes || b.duration) + ' menit'}`,
    `Harga Paket: ${rupiah(b.package_price_snapshot || b.price) || 'Harga belum tersedia'}`,
    '',
    `Add-ons: ${addonText}`,
    `Total Estimasi: ${rupiah(b.total_price_snapshot || b.price) || 'Harga belum tersedia'}`,
    '',
    `Catatan: ${b.notes && String(b.notes).trim() ? b.notes : '-'}`,
    '',
    'Mohon informasi lebih lanjut mengenai ketersediaan jadwal. Terima kasih.'
  ].join('\n');
}

function imageUrl(base, image) {
  if (!image) return null;
  if (/^https?:\/\//i.test(image)) return image;
  if (image.startsWith('/')) return base + image;
  return image;
}

module.exports = {
  tncStructure,
  renderTemplate,
  bookingTemplateVars,
  DEFAULT_ADMIN_TEMPLATE,
  DEFAULT_CONFIRM_TEMPLATE,
  DEFAULT_PORTAL_LINK_TEMPLATE,
  DEFAULT_RESCHEDULE_TEMPLATE,
  DEFAULT_SUBMIT_TEMPLATE,
  DEFAULT_H1_TEMPLATE,
  h1Vars,
  PORTFOLIO_CATEGORIES,
  portfolioCategories,
  portfolioCategoryLabel,
  STATUSES,
  MANUAL_STATUSES,
  COLLECTIONS,
  WEEKDAYS,
  MAX_DURATION,
  slugify,
  rupiah,
  cleanPrice,
  formatDateID,
  normalizePhone,
  isValidPhone,
  bookingCode,
  randomToken,
  facilitiesList,
  benefitsForPackage,
  allBenefitsForPackage,
  lines,
  pairedLines,
  todayISO,
  addDaysISO,
  addWorkingDaysISO,
  formatDateTimeWIB,
  whatsappLink,
  bookingMessage,
  imageUrl,
  getActiveCities,
  getAllCities,
  getActiveCategories,
  getAllCategories,
  getCityBySlug,
  durationsFor,
  addonsForCategory,
  getAllAddons,
  catalogForCity,
  categoriesWithPackages,
  buildCatalog,
  packagePrice,
  availabilityRules,
  availabilityForRange,
  isDateBookable,
  bookingCountsByDate,
  bookedCountOn
};

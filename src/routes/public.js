'use strict';

const express = require('express');
const path = require('path');
const { db } = require('../db');
const util = require('../util');
const content = require('../content');
const auth = require('../auth');
const selection = require('../selection');
const selectionCleanup = require('../selection-cleanup');
const editing = require('../editing');
const push = require('../push');
const portalview = require('../portalview');
const timeline = require('../timeline');
const bookingcode = require('../bookingcode');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const jsonForScript = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

const portfolioSelect = `
  SELECT p.*, COALESCE(NULLIF(p.image_url,''), p.image) AS image_src,
         c.name AS city_name, c.slug AS city_slug
  FROM portfolio p LEFT JOIN cities c ON c.id = p.city_id`;

/**
 * Attaches the extra photos of every portfolio entry in ONE query.
 * `photos` = cover + extras (used by the lightbox counter/thumbs),
 * `extra_photos` = extras only.
 */
function withPortfolioPhotos(items) {
  if (!items.length) return items;
  const ids = items.map((i) => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT portfolio_id, image, caption, is_primary FROM portfolio_images
                           WHERE portfolio_id IN (${placeholders})
                           ORDER BY is_primary DESC, sort_order, id`).all(...ids);
  const byId = new Map();
  rows.forEach((r) => {
    if (!byId.has(r.portfolio_id)) byId.set(r.portfolio_id, []);
    byId.get(r.portfolio_id).push(r);
  });
  return items.map((it) => {
    const cover = it.image_src || '';
    const extra = (byId.get(it.id) || []).filter((p) => p.image && p.image !== cover);
    const photos = [cover].concat(extra.map((p) => p.image)).filter(Boolean);
    return { ...it, extra_photos: extra, photos, photo_count: photos.length };
  });
}

/** "Nama Klien, S.Kom." — degree is optional, never invented. */
function portfolioTitle(item) {
  const name = String(item.client_name || item.title || '').trim();
  const degree = String(item.client_degree || '').trim();
  return degree ? `${name}, ${degree}` : name;
}

function getPortfolio({ cityId, category, featuredOnly, carouselOnly, limit } = {}) {
  const where = ['p.is_active = 1'];
  const params = {};
  if (cityId) { where.push('p.city_id = :city_id'); params.city_id = cityId; }
  if (category) { where.push('p.category = :category'); params.category = category; }
  if (featuredOnly) where.push('p.is_featured = 1');
  if (carouselOnly) where.push("p.collection IN ('carousel','both')");
  return withPortfolioPhotos(db.prepare(`${portfolioSelect}
    WHERE ${where.join(' AND ')}
    ORDER BY p.is_featured DESC, p.sort_order ASC, p.id DESC
    ${limit ? 'LIMIT ' + Number(limit) : ''}`).all(params));
}

const getActiveTestimonials = () => db.prepare(
  'SELECT * FROM testimonials WHERE is_active = 1 ORDER BY sort_order ASC, id ASC LIMIT 12'
).all();

const getFaqs = () => db.prepare(
  'SELECT * FROM faqs WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
).all();

function cityPayload(city) {
  return {
    id: city.id,
    name: city.name,
    slug: city.slug,
    description: city.description || '',
    cover_image: city.cover_image || '',
    categories: util.categoriesWithPackages(city.id),
    starting_price: (() => {
      const prices = util.catalogForCity(city.id).map((p) => p.starting_price).filter(Boolean);
      return prices.length ? Math.min(...prices) : null;
    })()
  };
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  const preview = req.preview;
  const cities = util.getActiveCities();
  const mainCity = cities[0] || null;
  const heroSlides = content.getHeroSlides({ preview });
  // Featured Portfolio = HANYA karya yang ditandai unggulan admin (+ urutan sort_order).
  // Tidak ada fallback ke seluruh portfolio dan tidak ada data dummy: kalau belum ada
  // unggulan, section-nya tidak dirender sama sekali (revisi v12).
  const featured = getPortfolio({ featuredOnly: true, limit: 9 });
  const carouselLimit = Math.min(24, Math.max(2, Number(req.site['carousel.limit']) || 8));
  const carousel = getPortfolio({ carouselOnly: true, limit: carouselLimit });
  const homeStats = res.locals.settings.home_stats_visible === '0'
    ? []
    : db.prepare('SELECT * FROM home_stats WHERE is_active = 1 ORDER BY sort_order, id').all();

  res.render('home', {
    title: req.site['seo.title'] || 'Fotografi Wisuda',
    pageDescription: req.site['seo.description'] || '',
    bodyClass: 'page-home',
    cities,
    mainCity,
    catalogCity: mainCity ? cityPayload(mainCity) : null,
    heroSlides,
    featured: featured,
    carousel: carousel.length ? carousel : [],
    testimonials: getActiveTestimonials(),
    homeStats,
    sectionMap: Object.fromEntries(res.locals.sections.map((s) => [s.key, s]))
  });
});

/* ------------------------------------------------------------------ */
/* Gallery (portfolio)                                                 */
/* ------------------------------------------------------------------ */
function renderGallery(req, res) {
  // Revisi 2 (05): dua dropdown filter — PAKET dan LOKASI — bisa dipakai bersamaan.
  //   - Paket  : nilai `portfolio.package_label` yang benar-benar dipakai karya aktif.
  //              Sumber datanya sama dengan yang diisi admin di form portfolio.
  //   - Lokasi : data kota aktif di dashboard (bukan daftar kota hardcode).
  // `?kategori=` (pil kategori lama) masih dibaca agar tautan lama tidak mati.
  // Revisi: filter pertama adalah KATEGORI (bukan paket) dan daftarnya berasal dari
  // tabel `portfolio_categories` yang dikelola admin — hanya kategori aktif.
  const categoryOptions = util.portfolioCategories().map((c) => ({
    ...c,
    total: db.prepare(`SELECT COUNT(*) AS n FROM portfolio
                       WHERE is_active = 1 AND category = ?`).get(c.value).n
  }));
  const wanted = String(req.query.kategori || '');
  const category = categoryOptions.some((c) => c.value === wanted) ? wanted : '';

  // `?paket=` masih diterima agar tautan hasil revisi sebelumnya tidak error; nilainya
  // dibaca sebagai label kategori lama bila cocok, selain itu diabaikan.
  const legacyPaket = String(req.query.paket || '');
  const citySlug = req.query.kota ? String(req.query.kota) : '';
  const city = citySlug ? util.getCityBySlug(citySlug) : null;

  const items = getPortfolio({
    cityId: city ? city.id : null,
    category: category || null
  });
  const carouselLimit = Math.min(24, Math.max(2, Number(req.site['carousel.limit']) || 8));
  const carousel = getPortfolio({ carouselOnly: true, limit: carouselLimit });

  res.render('gallery', {
    title: req.site['gallery.title'] || 'Gallery',
    pageDescription: req.site['gallery.description'] || '',
    bodyClass: 'page-gallery',
    items,
    // Only photos that the owner actually marked for the carousel collection are shown
    // in the strip; otherwise the page showed the same photos twice (strip + grid).
    carousel,
    categories: categoryOptions,
    cities: util.getActiveCities(),
    activeCategory: category,
    legacyPaket,
    activeCity: city ? city.slug : '',
    sectionMap: Object.fromEntries(res.locals.sections.map((s) => [s.key, s]))
  });
}

router.get('/gallery', renderGallery);
// Legacy URL kept working (old links / bookmarks). The per-client pages live below at
// /portfolio/<slug>, which is a different (and more specific) route.
router.get('/portfolio', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(301, `${req.basePath}/gallery${qs ? '?' + qs : ''}`);
});

/* ------------------------------------------------------------------ */
/* One client's portfolio page (Tahap 6)                               */
/* ------------------------------------------------------------------ */
// Only PUBLISHED entries (is_active = 1) are served. The gallery is built from the
// portfolio's own photos (cover + portfolio_images) — never from the private photo
// selection portal, and never from a booking record.
router.get('/portfolio/:slug', (req, res, next) => {
  const slug = String(req.params.slug || '').trim();
  if (!slug) return next();
  const item = db.prepare(`${portfolioSelect} WHERE p.slug = ?`).get(slug);
  // An inactive (or missing) entry must not reveal anything, including "it exists".
  if (!item || Number(item.is_active) !== 1) {
    return res.status(404).render('error', {
      title: 'Portfolio tidak ditemukan',
      status: 404,
      message: 'Halaman portfolio ini tidak tersedia atau sudah tidak dipublikasikan.'
    });
  }

  const withPhotos = withPortfolioPhotos([item])[0];
  const photos = (withPhotos.photos || []).map((src, i) => ({
    src,
    alt: i === 0
      ? (item.alt_text || portfolioTitle(item))
      : `${portfolioTitle(item)}${item.campus ? ' — ' + item.campus : ''} (foto ${i + 1})`
  }));

  // Other clients, so the page is a real gallery destination and not a dead end.
  const others = getPortfolio({ limit: 7 })
    .filter((p) => p.id !== item.id)
    .slice(0, 6);

  const catLabel = util.portfolioCategoryLabel(item.category);

  res.render('portfolio-detail', {
    title: `${portfolioTitle(item)}${item.campus ? ' — ' + item.campus : ''} | Portfolio`,
    pageDescription: [portfolioTitle(item), item.campus, item.taken_at ? util.formatDateID(item.taken_at) : '']
      .filter(Boolean).join(' · '),
    bodyClass: 'page-portfolio-detail',
    item,
    clientTitle: portfolioTitle(item),
    photos,
    others,
    categoryLabel: catLabel,
    showCity: res.locals.showPortfolioCity || Number(item.show_city) === 1
  });
});

/* ------------------------------------------------------------------ */
/* Pricelist                                                           */
/* ------------------------------------------------------------------ */
router.get('/pricelist', (req, res) => {
  const cities = util.getActiveCities();
  const wanted = req.query.kota ? String(req.query.kota) : '';
  const city = cities.find((c) => c.slug === wanted) || cities[0] || null;

  res.render('pricelist', {
    title: req.site['pricelist.title'] || 'Pricelist',
    pageDescription: req.site['pricelist.description'] || '',
    bodyClass: 'page-pricelist',
    cities,
    city,
    catalogCity: city ? cityPayload(city) : null,
    catalogJson: jsonForScript(util.buildCatalog()),
    notes: util.lines(req.site['pricelist.notes'])
  });
});

/* ------------------------------------------------------------------ */
/* Package detail page (Elevra-style, DLY identity)                    */
/* ------------------------------------------------------------------ */
router.get('/paket/:slug', (req, res) => {
  const pkg = db.prepare(`SELECT p.*, k.name AS category_name, k.slug AS category_slug,
                                 c.name AS city_name, c.slug AS city_slug, c.is_active AS city_active
                          FROM packages p
                          JOIN package_categories k ON k.id = p.category_id
                          JOIN cities c ON c.id = p.city_id
                          WHERE p.slug = ? AND p.is_active = 1`).get(req.params.slug);

  if (!pkg) {
    return res.status(404).render('error', {
      title: 'Paket tidak ditemukan',
      status: 404,
      message: 'Paket yang Anda cari tidak tersedia atau sudah tidak aktif.'
    });
  }

  const gallery = db.prepare(`SELECT * FROM package_images WHERE package_id = ?
                              ORDER BY is_primary DESC, sort_order, id`).all(pkg.id);
  const images = gallery.length
    ? gallery.map((g) => ({ src: g.image, caption: g.caption || '' }))
    : (pkg.image ? [{ src: pkg.image, caption: pkg.name }] : []);

  const durations = db.prepare(`SELECT * FROM package_durations
                                WHERE package_id = ? AND is_active = 1
                                ORDER BY sort_order, duration_minutes`).all(pkg.id)
    .map((d) => ({
      minutes: d.duration_minutes,
      price: d.price == null || Number(d.price) <= 0 ? null : Number(d.price),
      edited_photos: d.edited_photos == null ? pkg.edited_photos : d.edited_photos,
      description: d.description || ''
    }));

  const wantedDuration = Number(req.query.durasi) || null;
  const preset = durations.find((d) => d.minutes === wantedDuration && d.price)
    || durations.find((d) => d.price) || durations[0] || null;

  const related = db.prepare(`SELECT p.*, k.name AS category_name FROM packages p
                              JOIN package_categories k ON k.id = p.category_id
                              WHERE p.city_id = ? AND p.id <> ? AND p.is_active = 1
                              ORDER BY p.is_best_seller DESC, p.sort_order LIMIT 3`).all(pkg.city_id, pkg.id)
    .map((p) => ({
      id: p.id, name: p.name, slug: p.slug, image: p.image,
      category_name: p.category_name,
      starting_price: (() => {
        const row = db.prepare(`SELECT MIN(price) AS v FROM package_durations
                                WHERE package_id = ? AND is_active = 1 AND price > 0`).get(p.id);
        return row && row.v ? Number(row.v) : null;
      })()
    }));

  res.render('package-detail', {
    title: `${pkg.name} — ${pkg.category_name}`,
    pageDescription: (pkg.description || `${pkg.name} di ${pkg.city_name}.`).replace(/\s+/g, ' ').slice(0, 300),
    bodyClass: 'page-package-detail',
    pkg,
    images,
    durations,
    preset,
    facilities: util.lines(pkg.facilities),
    benefits: (() => {
      const rows = util.benefitsForPackage(pkg.id);
      if (rows.length) return rows.map((b) => ({ text: b.text, icon: b.icon }));
      return util.lines(pkg.facilities).map((text) => ({ text, icon: 'check' }));
    })(),
    terms: util.lines(pkg.terms),
    related,
    citySlug: pkg.city_slug,
    bestSeller: Number(pkg.is_best_seller) === 1,
    recommended: Number(pkg.is_recommended) === 1,
    soldVisible: Number(pkg.sold_visible) !== 0 && pkg.sold_count != null,
    soldCount: pkg.sold_count,
    soldLabel: (pkg.sold_label || '').trim() || 'Sesi Telah Dipesan'
  });
});

/* ------------------------------------------------------------------ */
/* Cities — "Archives by Location" with integrated pricelist           */
/* ------------------------------------------------------------------ */
router.get('/city', (req, res) => {
  const cities = util.getAllCities().map((c) => {
    const payload = c.is_active ? cityPayload(c) : null;
    return {
      ...c,
      package_count: db.prepare('SELECT COUNT(*) AS n FROM packages WHERE city_id = ? AND is_active = 1').get(c.id).n,
      photo_count: db.prepare('SELECT COUNT(*) AS n FROM portfolio WHERE city_id = ? AND is_active = 1').get(c.id).n,
      starting_price: payload ? payload.starting_price : null,
      payload
    };
  });
  const activeCities = cities.filter((c) => c.is_active);
  const wanted = req.query.kota ? String(req.query.kota) : '';
  const selected = activeCities.find((c) => c.slug === wanted) || null;

  res.render('city-archives', {
    title: req.site['cities.title'] || 'Archives by Location',
    pageDescription: req.site['cities.description'] || '',
    bodyClass: 'page-cities',
    cities,
    selected,
    gallery: selected ? getPortfolio({ cityId: selected.id, limit: 6 }) : []
  });
});

router.get('/city/:slug', (req, res) => {
  const city = util.getCityBySlug(req.params.slug);
  if (!city) {
    return res.status(404).render('error', {
      title: 'Kota tidak ditemukan',
      status: 404,
      message: 'Kota layanan yang Anda cari belum tersedia.'
    });
  }
  const payload = city.is_active ? cityPayload(city) : null;
  res.render('city', {
    title: `Fotografi Wisuda ${city.name}`,
    pageDescription: (city.description || `Layanan fotografi wisuda DLY Graduation di ${city.name}.`)
      .replace(/\s+/g, ' ').slice(0, 300),
    bodyClass: 'page-city',
    city,
    catalogCity: payload,
    gallery: city.is_active ? getPortfolio({ cityId: city.id, limit: 8 }) : [],
    otherCities: util.getActiveCities().filter((c) => c.id !== city.id)
  });
});

/* ------------------------------------------------------------------ */
/* Private testimonial form (unlisted — token required)                */
/* ------------------------------------------------------------------ */
const crypto = require('crypto');

function validTestimonialToken(req, res) {
  const expected = String(((res && res.locals.settings) || {}).testimonial_form_token || '');
  const got = String(req.params.token || '');
  if (!expected || got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch (err) {
    return false;
  }
}

function renderTestimonialForm(req, res, extra = {}) {
  const s = res.locals.settings || {};
  res.render('testimonial-form', {
    title: 'Kirim Testimoni',
    pageDescription: 'Formulir testimoni klien DLY Graduation.',
    bodyClass: 'page-testimonial-form',
    noindex: true,
    token: req.params.token,
    intro: s.testimonial_intro || '',
    notice: s.testimonial_form_notice || '',
    errors: extra.errors || [],
    done: Boolean(extra.done),
    values: extra.values || {}
  });
}

router.get('/testimoni/:token', (req, res) => {
  if (!validTestimonialToken(req, res)) {
    return res.status(404).render('error', {
      title: 'Link tidak berlaku',
      status: 404,
      message: 'Link testimoni ini tidak valid atau sudah diganti. Silakan minta link terbaru kepada admin DLY Graduation.'
    });
  }
  renderTestimonialForm(req, res);
});

const testimonialUpload = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/testimoni/:token', (req, res, next) => {
  testimonialUpload.single('photo')(req, res, (err) => {
    if (err) {
      return renderTestimonialForm(req, res, {
        errors: [err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran foto maksimal 10MB.' : 'Gagal mengunggah foto.'],
        values: req.body || {}
      });
    }
    next();
  });
}, async (req, res) => {
  if (!validTestimonialToken(req, res)) {
    return res.status(404).render('error', {
      title: 'Link tidak berlaku', status: 404,
      message: 'Link testimoni ini tidak valid atau sudah diganti.'
    });
  }

  const body = req.body || {};
  const values = {
    name: String(body.name || '').trim().slice(0, 120),
    campus: String(body.campus || '').trim().slice(0, 120),
    quote: String(body.quote || '').trim().slice(0, 1000),
    rating: Number(body.rating) || 0
  };
  const errors = [];
  if (values.name.length < 3) errors.push('Nama lengkap (beserta gelar) wajib diisi.');
  if (values.campus.length < 2) errors.push('Nama kampus wajib diisi.');
  if (values.quote.length < 20) errors.push('Testimoni minimal 20 karakter agar cukup menggambarkan pengalaman Anda.');
  if (!(values.rating >= 1 && values.rating <= 5)) errors.push('Pilih rating bintang 1 sampai 5.');

  let photo = '';
  if (req.file && req.file.buffer && req.file.buffer.length) {
    try {
      const { uploadImage } = require('../media');
      const uploaded = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
      photo = uploaded.src;
    } catch (err) {
      errors.push(err.message || 'Foto gagal diunggah.');
    }
  }

  if (errors.length) {
    return renderTestimonialForm(req, res, { errors, values });
  }

  const autoApprove = (res.locals.settings || {}).testimonial_auto_approve === '1';
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM testimonials').get().n;
  db.prepare(`INSERT INTO testimonials
      (client_name, client_meta, quote, rating, is_active, is_placeholder, sort_order, photo, campus, source)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'client')`)
    .run(values.name, values.campus, values.quote, values.rating, autoApprove ? 1 : 0, order, photo, values.campus);

  renderTestimonialForm(req, res, { done: true });
});

/* ------------------------------------------------------------------ */
/* Client photo-selection portal (unlisted — token required)           */
/* ------------------------------------------------------------------ */
// The token is the ONLY credential: it is 192-bit random, revocable by the admin,
// and every photo request re-checks that the photo belongs to that portal.
function loadSelectionPortal(req, res, next) {
  const portal = selection.portalByToken(req.params.token);
  if (!portal) {
    return res.status(404).render('error', {
      title: 'Link tidak berlaku',
      status: 404,
      message: 'Link portal seleksi ini tidak valid. Silakan minta link terbaru kepada admin DLY Graduation.'
    });
  }
  const ctx = selection.detail(portal);
  if (!ctx || !ctx.booking) {
    return res.status(404).render('error', {
      title: 'Link tidak berlaku', status: 404,
      message: 'Data booking untuk portal ini tidak ditemukan. Hubungi admin DLY Graduation.'
    });
  }
  req.selectionPortal = portal;
  req.selectionCtx = ctx;
  req.selectionAdminView = Boolean(auth.getSession(req));
  next();
}

const selectionGate = portalview.gate;

function renderSelection(req, res, extra = {}) {
  const portal = req.selectionPortal;
  const ctx = req.selectionCtx;
  const allPhotos = selection.photosFor(portal.id);
  const photos = allPhotos.filter((p) => Number(p.is_available) !== 0);
  const picks = new Set(ctx.picks);
  const gate = selectionGate(ctx, req.selectionAdminView);
  const base = req.basePath;
  const pickedList = selection.pickedPhotos(portal.id);
  const brand = (res.locals.settings.selection_brand_name || '').trim()
    || res.locals.brand.name;

  // Nama bersih (tanpa nomor urut & ekstensi) untuk daftar & pesan WhatsApp.
  const pickedNames = pickedList.map((p) => selection.photoBaseName(p));
  // Posisi (1..N) per foto untuk badge urutan — bukan jumlah total di semua tile.
  const positions = new Map(pickedList.map((p, i) => [p.id, Number(p.position) || (i + 1)]));

  res.render('selection', {
    layout: 'layout-portal',
    title: 'Seleksi Foto',
    pageTitle: 'Seleksi Foto',
    bodyClass: 'page-selection',
    portal,
    booking: ctx.booking,
    photos,
    unavailableCount: allPhotos.length - photos.length,
    picks,
    positions,
    quota: portal.quota,
    gate,
    adminView: req.selectionAdminView,
    sent: req.query.sent === '1',
    empty: req.query.empty === '1',
    allowDownload: Number(portal.allow_download) === 1,
    requireFullQuota: Number(portal.require_full_quota) === 1,
    drive: selection.driveFolderFor(portal, ctx.booking),
    // Tahap 5: editing stage, shown only after the client submitted. Status only —
    // the internal note and target date are never part of this object.
    // Always the 3-stage strip once submitted; `pendingView()` when nothing is queued yet.
    editingStatus: selectionGate(ctx, req.selectionAdminView).submitted
      ? (editing.clientView(portal.id) || editing.pendingView())
      : null,
    selectedNames: pickedNames,
    highlightCount: photos.filter((p) => Number(p.is_highlight) === 1).length,
    selectedCount: pickedNames.length,
    // Client → admin WhatsApp message, built from the DATABASE (file names, not DOM).
    submitWa: util.whatsappLink(res.locals.settings.whatsapp_number || '', selection.clientSubmitMessage(ctx)),
    portalBrand: brand,
    portalBrandName: brand,
    photoSrc: (id) => `${base}/selection/${portal.token}/photo/${id}`,
    selectionBaseName: selection.photoBaseName,
    downloadSrc: (id) => `${base}/selection/${portal.token}/download/${id}`,
    portalUrl: `${base}/selection/${portal.token}`,
    formatDateID: util.formatDateID,
    message: extra.message || '',
    error: extra.error || (req.query.error ? String(req.query.error).slice(0, 200) : '')
  });
}

router.get('/selection/:token', loadSelectionPortal, (req, res) => {
  renderSelection(req, res);
  // Hangatkan thumbnail di latar belakang: kunjungan berikutnya (dan perangkat lain)
  // langsung mendapat gambar dari cache, bukan menunggu unduhan Drive.
  selection.warmPreviewsInBackground(req.selectionPortal.id, { width: 320 });
});

// Confirmation screen before submitting (spec: review before sending).
router.get('/selection/:token/review', loadSelectionPortal, (req, res) => {
  const portal = req.selectionPortal;
  const ctx = req.selectionCtx;
  const gate = selectionGate(ctx, req.selectionAdminView);
  const picked = new Set(ctx.picks);
  const photos = selection.photosFor(portal.id).filter((p) => picked.has(p.id));

  if (gate.submitted || gate.closed) return res.redirect(`${req.basePath}/selection/${portal.token}`);
  if (!photos.length) {
    return res.redirect(`${req.basePath}/selection/${portal.token}?empty=1`);
  }

  res.render('selection-review', {
    layout: 'layout-portal',
    title: 'Konfirmasi Pilihan',
    pageTitle: 'Konfirmasi Pilihan Foto',
    bodyClass: 'page-selection page-selection--review',
    portalBrandName: ((res.locals.settings.selection_brand_name || '').trim() || res.locals.brand.name),
    portal,
    booking: ctx.booking,
    photos,
    quota: portal.quota,
    gate,
    adminView: req.selectionAdminView,
    drive: selection.driveFolderFor(portal, ctx.booking),
    // Tahap 5: editing stage, shown only after the client submitted. Status only —
    // the internal note and target date are never part of this object.
    // Always the 3-stage strip once submitted; `pendingView()` when nothing is queued yet.
    editingStatus: selectionGate(ctx, req.selectionAdminView).submitted
      ? (editing.clientView(portal.id) || editing.pendingView())
      : null,
    photoSrc: (id) => `${req.basePath}/selection/${portal.token}/photo/${id}`,
    portalUrl: `${req.basePath}/selection/${portal.token}`,
    formatDateID: util.formatDateID
  });
});

// Watermarked, token-scoped preview. The master file is never exposed.
// Drive photos are downloaded server-side, watermarked and cached — the browser never
// receives a Google Drive URL (or the file id) of the master.
/**
 * Loader ringan khusus gambar: hanya token → portal + foto. Middleware `loadSelectionPortal`
 * membangun seluruh konteks (booking, picks, dst) — untuk 45 thumbnail itu 45× kerja ekstra.
 */
function loadSelectionPhoto(req, res, next) {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{32,64}$/.test(token)) return res.status(404).end();
  const portal = selection.portalByToken(token);
  if (!portal) return res.status(404).end();
  const photo = selection.photoById(portal.id, Number(req.params.photoId));
  if (!photo) return res.status(404).end();
  req.selectionPortal = portal;
  req.selectionPhoto = photo;
  req.selectionAdminView = Boolean(auth.getSession(req));
  next();
}

router.get('/selection/:token/photo/:photoId', loadSelectionPhoto, async (req, res) => {
  const portal = req.selectionPortal;
  const photo = req.selectionPhoto;
  if (!portal.is_open && !req.selectionAdminView) return res.status(403).end();
  if (Number(photo.is_available) === 0) {
    return res.status(410).send('Foto ini sudah tidak tersedia di folder Drive.');
  }

  // Thumbnail galeri di-cache browser 30 hari; preview besar hanya 30 menit (temporary).
  const wantedWidth = Number(req.query.w);
  const width = selection.normalizeWidth(wantedWidth);
  res.set('Cache-Control', selection.isThumbWidth(width)
    ? 'private, max-age=2592000'
    : 'private, max-age=1800');
  res.set('X-Robots-Tag', 'noindex, nofollow, noimageindex');
  try {
    const out = await selection.ensurePreview(photo, width);
    res.type(out.format === 'webp' ? 'image/webp' : 'image/jpeg');
    res.sendFile(out.file);
  } catch (err) {
    // No ImageMagick / Drive unreachable: fall back to streaming the bytes through this
    // same token-protected route (never a public master URL).
    try {
      const bytes = await selection.masterBytes(photo);
      res.type(path.extname(String(photo.file_name || photo.image || '')) || '.jpg');
      res.send(bytes);
    } catch (err2) {
      res.set('X-Photo-Error', String(err2.message || 'unavailable').slice(0, 120));
      res.status(502).send('Foto gagal dimuat dari Google Drive.');
    }
  }
});

// Optional per-photo download (only when the admin enabled it, and only for picked photos).
router.get('/selection/:token/download/:photoId', loadSelectionPhoto, async (req, res) => {
  const portal = req.selectionPortal;
  if (Number(portal.allow_download) !== 1 && !req.selectionAdminView) {
    return res.status(403).send('Unduhan foto tidak diizinkan pada portal ini.');
  }
  const photo = req.selectionPhoto;
  if (Number(photo.is_available) === 0) return res.status(404).end();
  const picked = new Set(selection.pickedIds(portal.id));
  if (!picked.has(photo.id) && !req.selectionAdminView) {
    return res.status(403).send('Hanya foto yang sudah dipilih yang dapat diunduh.');
  }
  try {
    const bytes = await selection.masterBytes(photo);
    const name = String(photo.file_name || `${photo.code}.jpg`).replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.type(path.extname(name) || '.jpg');
    res.send(bytes);
  } catch (err) {
    res.status(502).send('Foto gagal diunduh dari Google Drive.');
  }
});

router.post('/selection/:token/pick', loadSelectionPortal, (req, res) => {
  const portal = req.selectionPortal;
  const gate = selectionGate(req.selectionCtx, req.selectionAdminView);
  const json = (code, payload) => res.status(code).json(payload);

  if (gate.closed) return json(403, { ok: false, message: 'Portal seleksi sudah ditutup oleh admin.' });
  if (gate.submitted) return json(409, { ok: false, message: 'Pilihan foto sudah dikirim dan tidak dapat diubah.' });
  if (gate.deadlinePassed) return json(403, { ok: false, message: 'Batas waktu pemilihan sudah lewat.' });

  const photo = selection.photoById(portal.id, Number(req.body.photoId));
  if (!photo) return json(404, { ok: false, message: 'Foto tidak ditemukan pada portal ini.' });

  const action = String(req.body.action || 'toggle');
  // V2 — id operasi: klien mengirim `opId` unik per klik. Kalau karena retry request yang
  // sama terkirim dua kali, hasilnya tetap satu baris (idempotent): perubahan hanya
  // diterapkan bila `opId` belum pernah tercatat untuk portal ini.
  const opId = String(req.body.opId || '').slice(0, 60);

  const result = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM photo_selections WHERE id = ?').get(portal.id);
    if (!fresh) return { code: 404, payload: { ok: false, message: 'Portal tidak ditemukan.' } };
    const existing = new Set(selection.pickedIds(fresh.id));
    const isPicked = existing.has(photo.id);
    const remove = action === 'remove' || (action === 'toggle' && isPicked);

    if (!remove) {
      if (Number(photo.is_available) === 0) {
        return { code: 409, payload: { ok: false, message: 'Foto ini sudah tidak tersedia di folder Drive.' } };
      }
      // Kuota diperiksa DI DALAM transaksi bersama INSERT → dua klik bersamaan tidak bisa
      // sama-sama lolos dan melewati kuota.
      if (existing.size >= Number(fresh.quota)) {
        return {
          code: 409,
          payload: {
            ok: false,
            message: `Batas pilihan sudah penuh (${fresh.quota} foto). Batalkan salah satu foto untuk memilih yang lain.`,
            count: existing.size,
            quota: Number(fresh.quota),
            rev: Number(fresh.picks_rev) || 0,
            picks: Array.from(existing),
            order: selection.pickedIds(fresh.id)
          }
        };
      }
      if (!isPicked) {
        const nextPos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM photo_selection_picks WHERE portal_id = ?')
          .get(fresh.id).n;
        db.prepare(`INSERT OR IGNORE INTO photo_selection_picks
                    (portal_id, photo_id, position, drive_file_id, file_name)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(fresh.id, photo.id, nextPos, photo.drive_file_id || null, selection.photoName(photo));
      }
    } else {
      db.prepare('DELETE FROM photo_selection_picks WHERE portal_id = ? AND photo_id = ?')
        .run(fresh.id, photo.id);
      normalizePickOrder(fresh.id);
    }

    // Naikkan revisi HANYA bila sesuatu benar-benar berubah — nilai inilah yang dipakai
    // klien untuk membuang respons lama. Naik di dalam transaksi yang sama = konsisten.
    const changed = remove ? isPicked : !isPicked;
    if (changed) {
      db.prepare(`UPDATE photo_selections SET picks_rev = COALESCE(picks_rev, 0) + 1,
                  first_pick_at = CASE WHEN ? THEN COALESCE(first_pick_at, datetime('now')) ELSE first_pick_at END,
                  updated_at = datetime('now') WHERE id = ?`)
        .run(remove ? 0 : 1, fresh.id);
    }
    const after = db.prepare('SELECT picks_rev FROM photo_selections WHERE id = ?').get(fresh.id);
    return {
      code: 200,
      payload: {
        ok: true,
        changed,
        opId,
        rev: Number(after.picks_rev) || 0,
        count: selection.pickCount(fresh.id),
        quota: Number(fresh.quota)
      }
    };
  })();

  if (result.code !== 200) return json(result.code, result.payload);

  // Payload daftar pilihan dibaca SETELAH commit; `rev` menandai versinya.
  const picked = selection.pickedPhotos(portal.id);
  return json(200, {
    ...result.payload,
    // `picks` & `order` selalu dari keadaan database terbaru; klien hanya memakainya bila
    // `rev` lebih besar dari yang sudah ia pegang.
    picks: picked.map((p) => p.id),
    order: picked.map((p) => p.id),
    positions: picked.map((p) => ({ id: p.id, position: Number(p.position) || 0 })),
    names: picked.map((p) => selection.photoBaseName(p))
  });
});

/** Keeps `position` contiguous (1..N) after an un-pick so order numbers stay readable. */
function normalizePickOrder(portalId) {
  const rows = selection.pickedPhotos(portalId);
  const upd = db.prepare('UPDATE photo_selection_picks SET position = ? WHERE portal_id = ? AND photo_id = ?');
  db.transaction(() => {
    rows.forEach((row, i) => upd.run(i + 1, portalId, row.id));
  })();
}

router.post('/selection/:token/submit', loadSelectionPortal, (req, res) => {
  const portal = req.selectionPortal;
  const gate = selectionGate(req.selectionCtx, req.selectionAdminView);
  const backTo = `${req.basePath}/selection/${portal.token}`;

  // JSON request (the confirmation modal posts via fetch).
  const wantsJson = String(req.get('accept') || '').includes('application/json')
    || String(req.get('content-type') || '').includes('application/json');

  /** Jawaban sukses yang sama dipakai submit pertama & submit ulang (idempotent). */
  const success = (count, alreadySubmitted) => {
    if (!wantsJson) return res.redirect(`${backTo}?sent=1`);
    const ctx = selection.detail(selection.portalById(portal.id));
    return res.json({
      ok: true,
      alreadySubmitted: Boolean(alreadySubmitted),
      count,
      wa: util.whatsappLink(res.locals.settings.whatsapp_number || '', selection.clientSubmitMessage(ctx))
    });
  };

  // V2 — IDEMPOTENT: klik "Kirim" dua kali (atau retry setelah koneksi putus) TIDAK boleh
  // menghasilkan error maupun pengiriman ganda. Kalau pilihan sudah tercatat submitted,
  // kembalikan jawaban sukses yang sama tanpa mengulang efek samping.
  if (gate.submitted) {
    const already = selection.pickedIds(portal.id);
    return success(already.length, true);
  }
  if (gate.closed || gate.deadlinePassed) {
    return wantsJson
      ? res.status(409).json({ ok: false, message: 'Portal sudah ditutup atau batas waktu pemilihan lewat.' })
      : res.redirect(backTo);
  }

  // ---- SATU TRANSAKSI: validasi → simpan → verifikasi jumlah → ubah status ----------
  // Tidak ada unduhan Drive, tidak ada pembuatan ulang thumbnail, tidak ada request
  // per-foto: seluruh pekerjaan submit adalah operasi database lokal.
  const outcome = db.transaction(() => {
    const ids = selection.pickedIds(portal.id);
    if (!ids.length) return { code: 422, message: 'Belum ada foto yang dipilih.', empty: true };
    if (ids.length > Number(portal.quota)) {
      return { code: 422, message: 'Jumlah foto terpilih melebihi batas.' };
    }
    if (Number(portal.require_full_quota) === 1 && ids.length < Number(portal.quota)) {
      return {
        code: 422,
        message: `Portal ini mewajibkan ${portal.quota} foto dipilih. Saat ini baru ${ids.length} foto.`
      };
    }
    // Verifikasi bahwa setiap ID benar-benar milik portal ini (bukan hasil kiriman klien,
    // tetapi tetap diperiksa: data lama/rusak tidak boleh lolos).
    const owned = db.prepare(`SELECT COUNT(*) AS n FROM photo_selection_picks pk
                              JOIN photo_selection_photos ph ON ph.id = pk.photo_id
                              WHERE pk.portal_id = ?`).get(portal.id).n;
    if (Number(owned) !== ids.length) {
      return { code: 409, message: 'Data pilihan tidak konsisten. Muat ulang halaman lalu coba lagi.' };
    }
    const upd = db.prepare(`UPDATE photo_selections SET status = 'submitted',
                            submitted_at = COALESCE(submitted_at, datetime('now')),
                            picks_rev = COALESCE(picks_rev, 0) + 1,
                            updated_at = datetime('now')
                            WHERE id = ? AND submitted_at IS NULL`).run(portal.id);
    const row = db.prepare('SELECT status, submitted_at FROM photo_selections WHERE id = ?').get(portal.id);
    if (row.status !== 'submitted') {
      return { code: 409, message: 'Pilihan sudah dikirim sebelumnya.' };
    }
    return { code: 200, count: ids.length, firstSubmit: upd.changes > 0, submittedAt: row.submitted_at };
  })();

  if (outcome.code !== 200) {
    if (wantsJson) {
      return res.status(outcome.code).json({ ok: false, message: outcome.message, empty: Boolean(outcome.empty) });
    }
    return res.redirect(`${backTo}${outcome.empty ? '/review?empty=1' : `?error=${encodeURIComponent(outcome.message)}`}`);
  }

  // ---- Setelah transaksi commit: antrean thumbnail (background), bukan penghapusan
  // langsung. Aman karena pilihan sudah tersimpan permanen; ini hanya membersihkan CACHE.
  try {
    selectionCleanup.enqueuePortal(portal.id, portal.booking_id, 'submitted');
  } catch (err) {
    console.error('[selection-cleanup] gagal masuk antrean', err.message);
  }

  // Tahap 5: job editing otomatis (tidak boleh menggagalkan submit klien).
  try {
    editing.enqueue(portal.booking_id, { actor: 'klien' });
  } catch (err) {
    console.error('[editing] gagal membuat job otomatis', err.message);
  }

  // Timeline klien: tahap 05/06/07 langsung tercatat saat submit (blueprint §8).
  try {
    timeline.record(portal.booking_id, 'submitted', { actor: 'klien', at: outcome.submittedAt || null });
    timeline.record(portal.booking_id, 'editing_queue', { at: outcome.submittedAt || null });
    timeline.record(portal.booking_id, 'editing', { at: outcome.submittedAt || null });
  } catch (err) {
    console.error('[timeline] gagal mencatat submit', err.message);
  }

  // Tahap 6: notifikasi admin. Dijalankan SETELAH respons terkirim supaya jaringan push
  // tidak pernah memperlambat submit klien (event id stabil → tidak pernah dobel).
  setImmediate(() => {
    try {
      push.notify('selection', {
        eventId: `selection:${portal.id}:submitted`,
        bookingId: portal.booking_id,
        portalId: portal.id,
        clientName: (req.selectionCtx && req.selectionCtx.booking && req.selectionCtx.booking.client_name) || '',
        campus: (req.selectionCtx && req.selectionCtx.booking && req.selectionCtx.booking.campus) || ''
      });
    } catch (err) {
      console.error('[push] gagal mengirim notifikasi submit', err.message);
    }
  });

  return success(outcome.count, !outcome.firstSubmit);
});

/* ------------------------------------------------------------------ */
/* Informational pages (CMS driven)                                    */
/* ------------------------------------------------------------------ */
router.get('/cara-order', (req, res) => {
  res.render('cara-order', {
    title: req.site['caraorder.title'] || 'Cara Order',
    pageDescription: req.site['caraorder.description'] || '',
    bodyClass: 'page-cara-order',
    steps: util.pairedLines(req.site['caraorder.steps']),
    faqs: getFaqs().slice(0, 4),
    mainCity: util.getActiveCities()[0] || null
  });
});

router.get('/artikel', (req, res) => {
  const articles = db.prepare(`SELECT * FROM articles WHERE is_published = 1
                               ORDER BY COALESCE(published_at, created_at) DESC, id DESC`).all();
  res.render('articles', {
    title: req.site['artikel.title'] || 'Artikel',
    pageDescription: req.site['artikel.description'] || '',
    bodyClass: 'page-articles',
    articles
  });
});

router.get('/artikel/:slug', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE slug = ? AND is_published = 1').get(req.params.slug);
  if (!article) {
    return res.status(404).render('error', {
      title: 'Artikel tidak ditemukan',
      status: 404,
      message: 'Artikel yang Anda cari tidak tersedia atau belum dipublikasikan.'
    });
  }
  const others = db.prepare(`SELECT * FROM articles WHERE is_published = 1 AND id <> ?
                             ORDER BY COALESCE(published_at, created_at) DESC LIMIT 3`).all(article.id);
  res.render('article', {
    title: article.title,
    pageDescription: article.excerpt || '',
    bodyClass: 'page-article',
    article,
    paragraphs: util.lines(article.body),
    others
  });
});

router.get('/ulasan', (req, res) => {
  res.render('reviews', {
    title: req.site['ulasan.title'] || 'Ulasan',
    pageDescription: req.site['ulasan.description'] || '',
    bodyClass: 'page-reviews',
    testimonials: getActiveTestimonials()
  });
});

router.get('/faq', (req, res) => {
  res.render('faq', {
    title: req.site['faq.title'] || 'FAQ',
    pageDescription: req.site['faq.description'] || '',
    bodyClass: 'page-faq',
    faqs: getFaqs(),
    mainCity: util.getActiveCities()[0] || null
  });
});

router.get('/syarat-ketentuan', (req, res) => {
  res.render('tnc', {
    title: req.site['tnc.title'] || 'Syarat & Ketentuan',
    pageDescription: req.site['tnc.description'] || '',
    bodyClass: 'page-tnc',
    sections: util.tncStructure(req.site['tnc.body']),
    // `points` tetap dikirim untuk kompatibilitas template/lama.
    points: util.lines(req.site['tnc.body'])
  });
});

router.get('/tentang', (req, res) => {
  res.render('about', {
    title: req.site['tentang.title'] || 'Tentang Kami',
    pageDescription: req.site['tentang.description'] || '',
    bodyClass: 'page-about',
    paragraphs: util.lines(req.site['tentang.body']),
    values: util.pairedLines(req.site['tentang.values']),
    cities: util.getActiveCities(),
    portfolio: getPortfolio({ limit: 4 })
  });
});

/* ------------------------------------------------------------------ */
/* Availability API (public, read-only)                                */
/* ------------------------------------------------------------------ */
router.get('/api/availability', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.bulan)) ? String(req.query.bulan) : null;
  if (!month) return res.status(400).json({ ok: false, message: 'Format bulan harus YYYY-MM.' });
  const [y, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) return res.status(400).json({ ok: false, message: 'Bulan tidak valid.' });
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const map = util.availabilityForRange(first, last);
  const rules = util.availabilityRules();
  res.json({
    ok: true,
    month,
    today: util.todayISO(),
    rules: { leadDays: rules.leadDays, advanceDays: rules.advanceDays },
    days: map
  });
});

/* ------------------------------------------------------------------ */
/* Booking — multi-step                                               */
/* ------------------------------------------------------------------ */
function bookingFormData(req, extra = {}) {
  const catalog = util.buildCatalog();
  const citySlug = (extra.values && extra.values.city) || req.query.kota || (catalog[0] ? catalog[0].slug : '');
  const city = catalog.find((c) => c.slug === citySlug) || catalog[0] || null;
  const today = util.todayISO();
  const rules = util.availabilityRules();
  return {
    title: req.site['booking.title'] || 'Booking Sesi Foto',
    pageDescription: req.site['booking.description'] || '',
    bodyClass: 'page-booking',
    catalog,
    catalogJson: jsonForScript(catalog),
    availabilityJson: jsonForScript(util.availabilityForRange(today, util.addDaysISO(today, 62))),
    today,
    rules,
    presetCity: city ? city.slug : '',
    presetPackage: extra.presetPackage || (req.query.paket ? Number(req.query.paket) : null),
    presetDuration: extra.presetDuration || (req.query.durasi ? Number(req.query.durasi) : null),
    errors: extra.errors || [],
    values: extra.values || {},
    addons: util.getAllAddons().filter((a) => Number(a.is_active) === 1)
      .map((a) => ({ ...a, price: a.price == null || Number(a.price) <= 0 ? null : Number(a.price) }))
  };
}

router.get('/booking', (req, res) => {
  const data = bookingFormData(req);
  if (!data.catalog.length) {
    return res.render('booking-empty', {
      title: 'Booking Sesi Foto',
      pageDescription: req.site['booking.description'] || '',
      bodyClass: 'page-booking'
    });
  }
  res.render('booking', data);
});

router.post('/booking', (req, res) => {
  const body = req.body || {};
  const errors = [];
  const values = {
    client_name: String(body.client_name || '').trim().slice(0, 120),
    client_phone: String(body.client_phone || '').trim(),
    instagram: String(body.instagram || '').trim().replace(/^@/, '').slice(0, 60),
    campus: String(body.campus || '').trim().slice(0, 160),
    faculty: String(body.faculty || '').trim().slice(0, 120),
    major: String(body.major || '').trim().slice(0, 120),
    mu_instagram: String(body.mu_instagram || '').trim().replace(/^@/, '').slice(0, 60),
    wardrobe_instagram: String(body.wardrobe_instagram || '').trim().replace(/^@/, '').slice(0, 60),
    city: String(body.city || '').trim(),
    shooting_date: String(body.shooting_date || '').trim(),
    shooting_time: String(body.shooting_time || '').trim(),
    location: String(body.location || '').trim().slice(0, 160),
    location_address: String(body.location_address || '').trim().slice(0, 300),
    package_id: String(body.package_id || '').trim(),
    duration: String(body.duration || '').trim(),
    notes: String(body.notes || '').trim().slice(0, 1000),
    terms: body.terms_consent ? 1 : 0,
    // Public form no longer asks for photo consent; it stays 0 unless set elsewhere.
    photo_consent: body.photo_consent ? 1 : 0
  };
  const addonIds = Array.isArray(body.addons) ? body.addons : (body.addons ? [body.addons] : []);

  /* --- identity --- */
  if (values.client_name.length < 3) errors.push('Nama lengkap wajib diisi (minimal 3 karakter).');
  if (!util.isValidPhone(values.client_phone)) errors.push('Nomor WhatsApp tidak valid. Contoh: 08123456789.');
  if (values.campus.length < 2) errors.push('Nama kampus wajib diisi.');
  if (!values.instagram) errors.push('Instagram wajib diisi.');
  else if (!/^[A-Za-z0-9._]{2,30}$/.test(values.instagram)) errors.push('Format Instagram tidak valid (huruf, angka, titik, garis bawah).');
  if (!values.terms) errors.push('Anda perlu menyetujui Syarat & Ketentuan sebelum melanjutkan.');

  /* --- session --- */
  const city = util.getCityBySlug(values.city);
  if (!city || !city.is_active) errors.push('Kota layanan wajib dipilih.');

  const pkg = city && values.package_id
    ? db.prepare(`SELECT p.*, k.name AS category_name, k.slug AS category_slug, k.is_active AS category_active
                  FROM packages p JOIN package_categories k ON k.id = p.category_id
                  WHERE p.id = ? AND p.city_id = ? AND p.is_active = 1`).get(Number(values.package_id), city.id)
    : null;
  if (!pkg) errors.push('Paket fotografi wajib dipilih sesuai kota layanan.');
  else if (!Number(pkg.category_active)) errors.push('Kategori paket ini sedang tidak tersedia.');

  const minutes = Number(values.duration);
  let durationRow = null;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    errors.push('Durasi pemotretan wajib dipilih.');
  } else if (pkg) {
    durationRow = db.prepare(`SELECT * FROM package_durations
                              WHERE package_id = ? AND duration_minutes = ? AND is_active = 1`)
      .get(pkg.id, minutes);
    if (!durationRow) errors.push('Durasi yang dipilih tidak tersedia untuk paket ini.');
  }

  let packagePrice = null;
  let editedPhotos = null;
  if (durationRow) {
    editedPhotos = durationRow.edited_photos == null
      ? (pkg && pkg.edited_photos != null ? Number(pkg.edited_photos) : null)
      : Number(durationRow.edited_photos);
    packagePrice = durationRow.price == null || Number(durationRow.price) <= 0 ? null : Number(durationRow.price);
    if (!packagePrice) errors.push('Harga untuk paket dan durasi ini belum diatur oleh admin. Silakan pilih kombinasi lain atau hubungi kami via WhatsApp.');
  }

  if (values.location.length < 3) errors.push('Lokasi pemotretan wajib diisi.');

  // Shooting time: required, HH:MM, within service hours.
  if (!/^\d{2}:\d{2}$/.test(values.shooting_time)) {
    errors.push('Jam pemotretan wajib dipilih.');
  } else {
    const [hh, mm] = values.shooting_time.split(':').map(Number);
    // Revisi: booking tersedia 24 JAM (00:00–23:59). Ketersediaan tanggal/slot tetap
    // divalidasi terpisah; 24 jam hanya membuka rentang pemilihan jam.
    if (!(hh >= 0 && hh <= 23) || !(mm >= 0 && mm <= 59)) {
      errors.push('Jam pemotretan harus antara 00:00 dan 23:59.');
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.shooting_date)) {
    errors.push('Tanggal pemotretan wajib diisi.');
  } else {
    const dayMap = util.availabilityForRange(values.shooting_date, values.shooting_date);
    const day = dayMap[values.shooting_date];
    if (!day || !day.available) {
      const reason = day && day.reason;
      if (reason === 'full' || reason === 'full-manual') {
        errors.push('Maaf, tanggal ini sudah Full Booking. Silakan pilih tanggal lainnya.');
      } else if (reason === 'blocked' || reason === 'closed') {
        errors.push('Maaf, tanggal ini ditutup untuk pemotretan. Silakan pilih tanggal lainnya.');
      } else if (reason === 'lead') {
        errors.push('Tanggal yang dipilih terlalu dekat dengan hari ini. Silakan pilih tanggal lain.');
      } else {
        errors.push('Tanggal yang dipilih tidak tersedia. Silakan pilih tanggal lain pada kalender.');
      }
    }
  }

  /* --- add-ons (validated against DB, price re-read server-side) --- */
  const snapshotAddons = [];
  if (addonIds.length) {
    if (!pkg) {
      errors.push('Add-on tidak dapat diproses tanpa paket yang valid.');
    } else {
      const allowed = util.addonsForCategory(pkg.category_id);
      addonIds.slice(0, 10).forEach((rawId) => {
        const id = Number(rawId);
        const addon = allowed.find((a) => a.id === id);
        if (!addon) return;
        if (!addon.price) {
          errors.push(`Add-on “${addon.name}” belum memiliki harga resmi sehingga belum dapat dipilih.`);
          return;
        }
        snapshotAddons.push({ id: addon.id, name: addon.name, price: addon.price });
      });
    }
  }

  const addonsTotal = snapshotAddons.reduce((sum, a) => sum + a.price, 0);
  const total = packagePrice ? packagePrice + addonsTotal : null;

  if (errors.length) {
    const data = bookingFormData(req, {
      errors, values,
      presetPackage: Number(values.package_id) || null,
      presetDuration: minutes || null
    });
    return res.status(422).render('booking', data);
  }

  // Kode portal format baru: DLY-WISUDA-NAMA### (blueprint §3).
  const code = bookingcode.generate({ clientName: values.client_name, service: 'WISUDA' });
  const accessToken = util.randomToken(16);
  let newBookingId = 0;
  try {
    // Re-validate + insert in ONE transaction: the availability check above ran outside it,
    // so two requests arriving together could both pass and overload the date. This second
    // check is the authoritative one.
    const insertBooking = db.transaction(() => {
      const fresh = util.availabilityForRange(values.shooting_date, values.shooting_date)[values.shooting_date];
      if (!fresh || !fresh.available) {
        const reason = fresh && fresh.reason;
        const message = (reason === 'full' || reason === 'full-manual')
          ? 'Maaf, tanggal ini sudah Full Booking. Silakan pilih tanggal lainnya.'
          : 'Tanggal tersebut baru saja tidak tersedia. Silakan pilih tanggal lain.';
        const err = new Error(message);
        err.userMessage = message;
        throw err;
      }
      return db.prepare(`INSERT INTO bookings
        (code, access_token, client_name, client_phone, instagram, campus, faculty, major,
         mu_instagram, wardrobe_instagram, city_id, shooting_date, shooting_time,
         location, location_address,
         package_id, category_id, duration, duration_minutes, price, package_price_snapshot,
         addons_snapshot, total_price_snapshot, edited_photos_snapshot,
         photo_consent, terms_consent, terms_consent_at, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(code, accessToken, values.client_name, util.normalizePhone(values.client_phone),
        values.instagram, values.campus, values.faculty, values.major,
        values.mu_instagram, values.wardrobe_instagram, city.id, values.shooting_date, values.shooting_time,
        values.location, '', pkg.id, pkg.category_id,
        minutes, minutes, packagePrice, packagePrice,
        JSON.stringify(snapshotAddons), total, editedPhotos,
        values.photo_consent, values.terms, values.terms ? new Date().toISOString() : null, values.notes);
    });
    const info = insertBooking();
    newBookingId = Number(info.lastInsertRowid) || 0;
  } catch (err) {
    console.error('[booking] insert failed', err);
    const userMessage = err && err.userMessage;
    return res.status(userMessage ? 422 : 500).render('booking', bookingFormData(req, {
      errors: [userMessage || 'Permintaan booking gagal disimpan karena gangguan pada server. Silakan coba lagi — jadwal Anda belum tercatat.'],
      values,
      presetPackage: Number(values.package_id) || null,
      presetDuration: minutes || null
    }));
  }

  // Tahap 6: notify the admin's devices. Fire-and-forget, generic wording only.
  if (newBookingId) {
    push.notify('booking', {
      eventId: `booking:${newBookingId}:created`,
      bookingId: newBookingId,
      clientName: values.client_name,
      campus: values.campus
    });
  }

  res.redirect(303, `${req.basePath}/booking/sukses/${code}?t=${accessToken}`);
});

router.get('/booking/sukses/:code', (req, res) => {
  const booking = db.prepare(`SELECT b.*, c.name AS city_name, p.name AS package_name, k.name AS category_name
                              FROM bookings b
                              JOIN cities c ON c.id = b.city_id
                              JOIN packages p ON p.id = b.package_id
                              LEFT JOIN package_categories k ON k.id = b.category_id
                              WHERE b.code = ?`).get(req.params.code);
  if (!booking || booking.access_token !== String(req.query.t || '')) {
    return res.status(404).render('error', {
      title: 'Booking tidak ditemukan',
      status: 404,
      message: 'Data booking tidak ditemukan. Jika Anda sudah mengirim detail melalui WhatsApp, tim kami akan membantu.'
    });
  }

  let addons = [];
  try { addons = JSON.parse(booking.addons_snapshot || '[]'); } catch (err) { addons = []; }
  const minutes = booking.duration_minutes || booking.duration;
  const view = {
    ...booking,
    addons,
    shooting_date_label: util.formatDateID(booking.shooting_date, true),
    shooting_time_label: booking.shooting_time ? booking.shooting_time + ' WIB' : '',
    duration_label: `${minutes} menit`,
    duration_minutes: minutes,
    package_price_snapshot: booking.package_price_snapshot || booking.price,
    total_price_snapshot: booking.total_price_snapshot || booking.price,
    edited_photos_snapshot: booking.edited_photos_snapshot
  };
  const message = util.bookingMessage(view);

  res.render('booking-success', {
    title: `Booking ${booking.code}`,
    pageDescription: 'Ringkasan permintaan booking sesi foto wisuda DLY Graduation.',
    bodyClass: 'page-booking-success',
    booking: view,
    addons,
    waUrl: util.whatsappLink(res.locals.settings.whatsapp_number, message),
    bookingMessage: message
  });
});

/* ------------------------------------------------------------------ */
/* PWA (Tahap 4)                                                       */
/* ------------------------------------------------------------------ */
// The manifest is generated per request so it carries the owner's brand name, tagline and
// theme colour. URLs are built from `req.basePath`, so the same manifest works at the
// default subdomain address and on a custom domain attached later.
router.get('/manifest.webmanifest', (req, res) => {
  const base = req.basePath;
  const settings = res.locals.settings;
  // Revisi 2 (02): ikon home screen memakai LOGO RESMI DLY (turunan /appicon/*),
  // bukan monogram generasi lama. Ikon bawaan hanya fallback bila belum ada logo.
  const iconAny = (size) => res.locals.appIcon(size, false) || `${base}/assets/icon-${size}.png`;
  const iconMaskable = res.locals.appIcon(512, true) || `${base}/assets/icon-maskable-512.png`;
  const manifest = {
    id: `${base}/`,
    name: res.locals.brand.name,
    // A launcher label, not a truncation of the full name: "DLY Graduation" → "DLY".
    short_name: (() => {
      const explicit = String(settings.brand_short_name || '').trim();
      if (explicit) return explicit.slice(0, 12);
      const words = String(res.locals.brand.name || 'DLY').trim().split(/\s+/).filter(Boolean);
      const first = (words[0] || 'DLY');
      // "Dly Graduation" → "DLY" (the brand mark), never a chopped "Dly Graduati".
      if (first.length <= 6) return first.toUpperCase();
      return first.slice(0, 12);
    })(),
    description: req.site['seo.description'] || res.locals.brand.tagline || '',
    lang: 'id',
    dir: 'ltr',
    start_url: `${base}/`,
    scope: `${base}/`,
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#F7F6F2',
    theme_color: res.locals.appearance.primary || '#0B2340',
    categories: ['business', 'photography', 'lifestyle'],
    icons: [
      { src: iconAny(192), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconAny(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: iconMaskable, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    shortcuts: [
      { name: 'Pricelist', short_name: 'Pricelist', url: `${base}/pricelist` },
      { name: 'Portfolio', short_name: 'Portfolio', url: `${base}/gallery` },
      { name: 'Booking', short_name: 'Booking', url: `${base}/booking` }
    ]
  };
  res.type('application/manifest+json')
    .set('Cache-Control', 'no-cache')
    .send(JSON.stringify(manifest));
});

// Offline fallback. Served as a real page (also reachable directly) and precached by sw.js.
router.get('/offline', (req, res) => {
  res.sendFile(require('path').join(__dirname, '..', '..', 'public', 'offline.html'));
});

/* ------------------------------------------------------------------ */
/* SEO                                                                 */
/* ------------------------------------------------------------------ */
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /selection/\nSitemap: ${req.protocol}://${req.get('host')}${req.basePath}/sitemap.xml\n`
  );
});

router.get('/sitemap.xml', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}${req.basePath}`;
  const staticPaths = ['/', '/pricelist', '/city', '/booking', '/syarat-ketentuan'];
  const optional = [
    ['page_gallery_visible', '/gallery'],
    ['page_caraorder_visible', '/cara-order'],
    ['page_ulasan_visible', '/ulasan'],
    ['page_artikel_visible', '/artikel'],
    ['page_faq_visible', '/faq'],
    ['page_tentang_visible', '/tentang']
  ];
  const settings = res.locals.settings || {};
  optional.forEach(([flag, path]) => {
    if (settings[flag] !== '0') staticPaths.push(path);
  });
  const urls = staticPaths.map((p) => `<url><loc>${origin}${p}</loc><changefreq>weekly</changefreq></url>`);
  util.getActiveCities().forEach((c) => {
    urls.push(`<url><loc>${origin}/city/${c.slug}</loc><changefreq>weekly</changefreq></url>`);
  });
  db.prepare('SELECT slug FROM packages WHERE is_active = 1').all().forEach((p) => {
    urls.push(`<url><loc>${origin}/paket/${p.slug}</loc><changefreq>weekly</changefreq></url>`);
  });
  // Published client portfolio pages (Tahap 6) — never the unpublished ones.
  db.prepare('SELECT slug FROM portfolio WHERE is_active = 1 AND slug IS NOT NULL').all().forEach((row) => {
    urls.push(`<url><loc>${origin}/portfolio/${encodeURIComponent(row.slug)}</loc><changefreq>monthly</changefreq></url>`);
  });
  db.prepare('SELECT slug, COALESCE(published_at, created_at) AS d FROM articles WHERE is_published = 1').all()
    .forEach((a) => {
      urls.push(`<url><loc>${origin}/artikel/${a.slug}</loc><lastmod>${String(a.d).slice(0, 10)}</lastmod></url>`);
    });
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`
  );
});

module.exports = router;

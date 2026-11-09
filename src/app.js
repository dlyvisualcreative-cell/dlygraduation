'use strict';

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const { db, getSettings } = require('./db');
const util = require('./util');
const content = require('./content');
const auth = require('./auth');
const security = require('./security');
const publiccache = require('./publiccache');
const images = require('./images');

const app = express();

// Asset cache-busting versions: browsers keep old CSS/JS for hours otherwise.
const assetStamp = (rel) => {
  try {
    return Math.round(fs.statSync(path.join(__dirname, '..', rel)).mtimeMs).toString(36);
  } catch (err) {
    return '1';
  }
};
const assetVersion = {
  app: `${assetStamp('public/assets/app.css')}-${assetStamp('public/assets/app.js')}`,
  admin: `${assetStamp('public/assets/admin.css')}-${assetStamp('public/assets/admin.js')}`,
  pushAdmin: `${assetStamp('public/assets/push-admin.js')}`,
  selection: `${assetStamp('public/assets/selection.css')}-${assetStamp('public/assets/selection.js')}`,
  portal: `${assetStamp('public/assets/client-portal.css')}-${assetStamp('public/assets/client-portal.js')}`,
  portfolioCarousel: `${assetStamp('public/assets/portfolio-carousel.js')}`
};

/* ------------------------------------------------------------------ */
/* Compression — the platform's proxy does not gzip, so text assets     */
/* were shipped raw (app.css alone was 106KB uncompressed).            */
/* ------------------------------------------------------------------ */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|xhtml\+xml|manifest\+json)|image\/svg\+xml)/i;
const MIN_COMPRESS = 1024;
const compressionCache = new Map(); // key → { buf, etag }

function compressionMiddleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const accept = String(req.headers['accept-encoding'] || '');
  const gzip = /\bgzip\b/.test(accept);
  const br = /\bbr\b/.test(accept);
  if (!gzip && !br) return next();

  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let buffered = [];
  let buffering = true;

  function shouldCompress() {
    if (res.getHeader('content-encoding')) return false;
    if (String(res.getHeader('cache-control') || '').includes('no-transform')) return false;
    const type = String(res.getHeader('content-type') || '');
    if (!COMPRESSIBLE.test(type)) return false;
    const len = Number(res.getHeader('content-length') || 0);
    return !len || len >= MIN_COMPRESS;
  }

  res.write = function write(chunk, enc, cb) {
    if (!buffering) return origWrite(chunk, enc, cb);
    if (chunk) buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8'));
    if (typeof cb === 'function') cb();
    return true;
  };

  res.end = function end(chunk, enc, cb) {
    if (!buffering) return origEnd(chunk, enc, cb);
    buffering = false;
    if (chunk) buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8'));
    const body = Buffer.concat(buffered);
    buffered = [];

    if (!shouldCompress() || body.length < MIN_COMPRESS) {
      res.removeHeader('content-length');
      res.setHeader('Content-Length', body.length);
      return origEnd(body, null, cb);
    }

    const etagBase = res.getHeader('etag');
    const key = `${br ? 'br' : 'gz'}|${etagBase || body.length + ':' + (res.getHeader('content-type') || '')}`;
    let cached = compressionCache.get(key);

    if (!cached) {
      cached = br
        ? { buf: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) }
        : { buf: zlib.gzipSync(body, { level: 6 }) };
      if (compressionCache.size > 60) compressionCache.clear();
      compressionCache.set(key, cached);
    }

    res.setHeader('Content-Encoding', br ? 'br' : 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.removeHeader('content-length');
    res.setHeader('Content-Length', cached.buf.length);
    return origEnd(cached.buf, null, cb);
  };

  next();
}

app.disable('x-powered-by');
app.set('trust proxy', true);
// Keamanan dasar untuk SEMUA respons (lihat src/security.js): header, penyaring path
// berbahaya, dan rate limit untuk permintaan yang mengubah data.
app.use(security.headers);
app.use(security.blockSensitivePaths);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '2mb' }));
// Rate limit per-IP untuk POST/PUT/PATCH/DELETE. Login admin & portal punya limit
// sendiri yang lebih ketat (auth.js / portal.js).
app.use(security.createLimiter({ limit: 150, windowMs: 60 * 1000 }));

// Static assets. The platform strips the /<slug> prefix before requests reach us,
// so these are mounted at the app root.
app.use(compressionMiddleware);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (/\.(html|xml|txt)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    // The service worker must never be pinned by an HTTP cache — a stale worker would keep
    // serving an old asset list until it expired.
    if (/[\\/]sw\.js$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    // CSS/JS are linked with ?v=<mtime>, so a changed file always gets a new URL and the
    // browser can keep the old one for a year instead of re-validating it every visit.
    else if (/\.(css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (/\.(svg|png|jpe?g|webp|gif|ico|woff2?)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=2592000');
  }
}));

/* ------------------------------------------------------------------ */
/* Mikro-cache HTML publik (P2) — 15 detik, hanya halaman publik.       */
/* Halaman admin/portal/booking/API SELALU dilewati (lihat src/publiccache.js). */
/* ------------------------------------------------------------------ */
app.use(publiccache.middleware());

/* ------------------------------------------------------------------ */
/* Responsive image derivatives: /media/<hash>-<width>.<webp|jpg>       */
/* Generated once from the untouched master, then cached indefinitely.  */
/* ------------------------------------------------------------------ */
app.get('/media/:name', async (req, res) => {
  const parsed = images.parseVariantName(req.params.name);
  if (!parsed) return res.status(404).end();

  const cached = path.join(images.CACHE_DIR, req.params.name);
  if (fs.existsSync(cached)) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(parsed.format === 'webp' ? 'image/webp' : 'image/jpeg');
    return res.sendFile(cached);
  }

  const src = images.sourceForHash(parsed.hash, parsed.width, parsed.format);
  if (!src) return res.status(404).end();

  try {
    const file = await images.buildVariant(src, parsed.width, parsed.format);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(parsed.format === 'webp' ? 'image/webp' : 'image/jpeg');
    return res.sendFile(file);
  } catch (err) {
    console.error('[media] gagal membuat turunan', req.params.name, err.message);
    // Never break the page: fall back to the original file.
    return res.redirect(301, (req.get('x-public-base-path') || '') + src);
  }
});

/* ------------------------------------------------------------------ */
/* Logo adaptif: /logo/<token>.png                                      */
/* Token berisi tone + sumber, jadi URL-nya self-healing (cache boleh   */
/* dihapus kapan saja). Dipakai agar logo putih muncul di latar gelap   */
/* dan logo navy di latar terang tanpa perlu upload dua file.           */
/* ------------------------------------------------------------------ */
app.get('/logo/:name', async (req, res) => {
  const parsed = images.parseLogoToken(req.params.name);
  if (!parsed) return res.status(404).end();
  try {
    const file = await images.buildLogoInk(parsed.src, parsed.tone, {
      width: parsed.width, format: parsed.format
    });
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(parsed.format === 'webp' ? 'image/webp' : 'image/png');
    return res.sendFile(file);
  } catch (err) {
    console.error('[logo] gagal membuat varian', parsed.tone, err.message);
    return res.redirect(302, (req.get('x-public-base-path') || '') + parsed.src);
  }
});

/* ------------------------------------------------------------------ */
/* Favicon dari logo resmi: /favicon/<token>.png                        */
/* Logo lockup lebar + padding transparan besar tidak terbaca di tab    */
/* browser, jadi dibuat turunan persegi (logo putih di kotak navy).     */
/* Dipakai publik, admin, portal admin, dan portal client.              */
/* ------------------------------------------------------------------ */
app.get('/favicon/:name', async (req, res) => {
  const src = images.parseFaviconToken(req.params.name);
  if (!src) return res.status(404).end();
  try {
    const file = await images.buildFavicon(src);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/png');
    return res.sendFile(file);
  } catch (err) {
    console.error('[favicon] gagal membuat ikon', err.message);
    return res.redirect(302, (req.get('x-public-base-path') || '') + '/assets/favicon.svg');
  }
});

/* ------------------------------------------------------------------ */
/* Ikon aplikasi (PWA, home screen, ikon notifikasi): /appicon/<token>.png
   Sumber = logo resmi DLY (Identitas Brand), bukan monogram. Dipakai oleh
   manifest.webmanifest dan service worker (push).                          */
/* ------------------------------------------------------------------ */
app.get('/appicon/:name', async (req, res) => {
  const parsed = images.parseAppIconToken(req.params.name);
  if (!parsed) return res.status(404).end();
  try {
    const file = await images.buildAppIcon(parsed.src, parsed.size, { maskable: parsed.maskable });
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/png');
    return res.sendFile(file);
  } catch (err) {
    console.error('[appicon] gagal membuat ikon', parsed.size, err.message);
    return res.redirect(302, (req.get('x-public-base-path') || '') + '/assets/icon-192.png');
  }
});

app.use((req, res, next) => {
  // Admin-editable content must never be served from a stale browser cache.
  res.set('Cache-Control', 'no-store');

  // The app is served under /<slug>/ on the default address and at the domain root
  // on a custom domain. X-Public-Base-Path tells us which, per request.
  req.basePath = req.get('x-public-base-path') || '';
  res.locals.base = req.basePath;
  res.locals.url = (p) => req.basePath + (p.startsWith('/') ? p : '/' + p);

  // Draft preview is available to a logged-in admin only.
  const wantsPreview = req.query.preview === '1';
  const preview = wantsPreview && Boolean(auth.getSession(req));
  req.preview = preview;
  res.locals.preview = preview;

  const settings = getSettings();
  const site = content.getSiteContent({ preview });
  const appearance = content.getAppearance({ preview });
  const theme = content.themeFromAppearance(appearance);

  // Exposed on req as well so route handlers can read content without res.locals.
  req.site = site;
  req.appearance = appearance;
  res.locals.settings = settings;
  res.locals.site = site;
  res.locals.appearance = appearance;
  res.locals.theme = theme;
  res.locals.sections = content.getSections({ preview });
  res.locals.activeSections = res.locals.sections.filter((s) => Number(s.is_active) === 1).map((s) => s.key);
  res.locals.lastPublishedAt = content.lastPublishedAt();
  // Logo resolution: each surface asks for the variant that stays legible on it.
  // A local /uploads path is only used when the file really exists, so a typo in the
  // dashboard can never render a broken image. Fallbacks: variant → legacy → another variant → SVG mark.
  const logoExists = (value) => {
    const v = String(value || '').trim();
    if (!v) return false;
    if (/^https?:\/\//i.test(v)) return true;
    if (!v.startsWith('/')) return false;
    try {
      return fs.existsSync(path.join(__dirname, '..', 'public', v.replace(/^\//, '')));
    } catch (err) {
      return false;
    }
  };
  const pickLogo = (...candidates) => candidates.find(logoExists) || '';
  const legacyLogo = appearance.logo || '';
  // Satu sumber logo, dua "tinta": putih untuk latar gelap, navy untuk latar terang.
  // Varian yang belum diunggah dibuat otomatis oleh /logo/<token>.png.
  const logoSources = images.logoSet([
    settings.selection_portal_logo,
    settings.logo_header_dark,
    settings.logo_header_light,
    settings.logo_footer_dark,
    settings.logo_footer_light,
    legacyLogo
  ]);
  const logoUrlFor = (tone) => {
    const src = logoSources[tone] || logoSources.light || logoSources.dark;
    if (!src) return '';
    // Selalu lewat turunan: walau warna aslinya sudah cocok (tone 'keep'), file
    // tetap perlu di-trim supaya tinggi CSS benar-benar sama dengan tinggi artwork.
    const natural = images.logoTone(src);
    return images.logoInkUrl(req.basePath, src, natural === tone ? 'keep' : tone) || src;
  };
  const logoSet = {
    // Nama lama dipertahankan supaya template lain tidak pecah.
    headerLight: logoUrlFor('light'),
    headerDark: logoUrlFor('dark'),
    footerLight: logoUrlFor('light'),
    footerDark: logoUrlFor('dark'),
    // Nama yang jelas: dipakai oleh template yang direvisi.
    onDark: logoUrlFor('light'),   // latar gelap → logo putih
    onLight: logoUrlFor('dark'),   // latar terang → logo navy (warna asli)
    hasFile: Boolean(logoSources.light || logoSources.dark),
    raw: logoSources
  };

  // Helper: logo apa pun (mis. logo portal khusus) tetap dicocokkan dengan latarnya.
  res.locals.logoFor = (src, tone) => {
    const value = String(src || '').trim();
    if (value && images.isProcessable(value)) {
      const natural = images.logoTone(value);
      // tone 'keep' = warna asli dipertahankan, tapi tetap di-trim (ukuran seragam).
      return images.logoInkUrl(req.basePath, value, natural === tone ? 'keep' : tone) || value;
    }
    return logoUrlFor(tone === 'light' ? 'light' : 'dark');
  };

  /* Favicon dari logo resmi — dipakai SEMUA permukaan (publik, admin, portal).
     Urutan: favicon khusus → favicon tampilan → logo brand → ikon SVG bawaan. */
  const faviconSource = pickLogo(
    settings.favicon_custom, appearance.favicon,
    settings.logo_header_light, settings.logo_footer_dark, legacyLogo
  );
  res.locals.favicon = {
    src: (faviconSource && images.isProcessable(faviconSource)
      ? images.faviconUrl(req.basePath, faviconSource)
      : faviconSource) || (req.basePath + '/assets/favicon.svg'),
    fallback: req.basePath + '/assets/favicon.svg'
  };
  // Ikon aplikasi (PWA/home screen/notifikasi) memakai logo resmi yang SAMA.
  // `appIcon(size, maskable)` mengembalikan '' bila belum ada file logo, sehingga
  // pemanggil bisa jatuh ke ikon bawaan.
  res.locals.appIconSource = faviconSource && images.isProcessable(faviconSource) ? faviconSource : '';
  res.locals.appIcon = (size = 192, maskable = false) => (
    res.locals.appIconSource
      ? images.appIconUrl(req.basePath, res.locals.appIconSource, size, { maskable })
      : ''
  );

  // Revisi 2 (04): menu "Lokasi" & "Paket" dihapus dari navigasi utama. Query data
  // dropdown lama ikut dihapus supaya tidak ada dua sumber kebenaran yang tertinggal —
  // data kota & paket tetap dipakai halaman /city, /paket dan /pricelist.
  res.locals.brand = {
    name: settings.brand_name || 'DLY Graduation',
    tagline: settings.brand_tagline || 'Your Graduation, Your Story.',
    instagram: settings.instagram_handle || 'dly.graduation',
    whatsapp: settings.whatsapp_number || '6289629619590',
    email: settings.brand_email || '',
    description: settings.brand_description || 'Professional Graduation Photography',
    showIdentity: settings.header_show_identity !== '0',
    sticky: settings.header_sticky !== '0',
    logos: logoSet
  };
  // Public navigation visibility (admin-controlled, never deletes pages).
  res.locals.pages = {
    gallery: settings.page_gallery_visible !== '0',
    caraorder: settings.page_caraorder_visible !== '0',
    ulasan: settings.page_ulasan_visible !== '0',
    artikel: settings.page_artikel_visible === '1',
    faq: settings.page_faq_visible === '1',
    tentang: settings.page_tentang_visible === '1',
    tnc: settings.page_tnc_visible !== '0'
  };
  res.locals.payment = {
    bankName: settings.payment_bank_name || '',
    accountNumber: settings.payment_account_number || '',
    accountHolder: settings.payment_account_holder || '',
    dpAmount: Number(settings.payment_dp_amount) || 100000,
    notes: settings.payment_notes || ''
  };
  res.locals.rupiah = util.rupiah;
  res.locals.waLink = util.whatsappLink;
  // V8: portfolio cover never shows the city unless the owner enables it.
  res.locals.showPortfolioCity = settings.portfolio_show_city === '1';
  res.locals.portfolioTitle = (item) => {
    const name = String((item && (item.client_name || item.title)) || '').trim();
    const degree = String((item && item.client_degree) || '').trim();
    return degree ? `${name}, ${degree}` : name;
  };

  // Per-section styling tokens (Google-Sites-like rows). Empty = inherit theme.
  const fontStackFor = (value) => {
    const f = require('./content-schema').FONT_OPTIONS.find((x) => x.value === value);
    return f ? f.stack : '';
  };
  res.locals.SECTION_ITEM_DEFAULTS = require('./content-schema').SECTION_ITEM_DEFAULTS;
  res.locals.sectionStyle = (sec) => {
    const parts = [];
    if (sec && sec.bg_color) parts.push(`--sec-bg:${sec.bg_color}`);
    if (sec && sec.text_color) parts.push(`--sec-text:${sec.text_color}`);
    if (sec && sec.font) {
      const stack = fontStackFor(sec.font);
      if (stack) parts.push(`--sec-font:${stack}`);
    }
    return parts.join(';');
  };
  res.locals.sectionClass = (sec, base) => {
    const cls = [base || ''];
    if (sec && sec.bg_color) cls.push('sec-custom-bg');
    if (sec && sec.text_color) cls.push('sec-tint');
    if (sec && sec.font) cls.push('sec-font');
    return cls.filter(Boolean).join(' ');
  };
  res.locals.rupieh = util.rupiah;
  res.locals.formatDateID = util.formatDateID;
  res.locals.formatDateTime = util.formatDateTimeWIB;
  res.locals.todayISO = util.todayISO();
  res.locals.currentPath = req.path;
  res.locals.origin = `${req.protocol}://${req.get('host')}${req.basePath}`;
  res.locals.imageUrl = (img) => util.imageUrl(req.basePath, img);
  /**
   * P2: URL untuk LIGHTBOX (foto diperbesar). Dulu memakai file master apa adanya —
   * satu klik di HP bisa mengunduh 0,25–6,14 MB. Sekarang memakai turunan 2000 px
   * (146–301 KB terukur) dan tetap jatuh ke file asli bila sumbernya bukan upload lokal.
   */
  res.locals.lightboxUrl = (img) => {
    const value = String(img || '');
    if (!value) return null;
    if (images.isProcessable(value)) return images.urlFor(req.basePath, value, 2000, 'webp');
    return util.imageUrl(req.basePath, value);
  };
  // Natural aspect ratio of an upload, for masonry tiles that must NOT crop the photo.
  // Read from the cached dimensions index (never runs `identify` on the request path);
  // 0 means "unknown" and the CSS fallback ratio applies. Clamped so an extreme panorama
  // or a tiny badge cannot blow the grid up.
  res.locals.imageAspect = (src) => {
    const d = images.dimensions(src);
    if (!d.width || !d.height) return 0;
    const ratio = d.width / d.height;
    return Math.round(Math.max(0.62, Math.min(1.45, ratio)) * 1000) / 1000;
  };
  // Responsive <picture> helper (WebP + srcset + explicit size + lazy/priority).
  // `base` is injected per request so published subpaths and custom domains both work.
  const basePath = req.basePath;
  res.locals.picture = (src, opts) => images.picture(basePath, src, opts);
  res.locals.mediaUrl = (src, width, format) => images.urlFor(basePath, src, width, format || 'webp');
  res.locals.year = new Date().getFullYear();
  res.locals.assetVersion = assetVersion;
  // Which self-hosted font files this page actually needs (preloaded in the layout).
  // P1: pemetaan font → file dibuat eksplisit (dulu hanya Fraunces & Instrument Sans
  // sehingga Montserrat selalu jatuh ke Google Fonts).
  res.locals.LOCAL_FONT_FILES = (() => {
    const schema = require('./content-schema');
    const FILES = {
      Fraunces: ['fraunces-latin.woff2'],
      'Instrument Sans': ['instrument-sans-latin.woff2'],
      Montserrat: ['montserrat-latin.woff2'],
      'Montserrat Light': ['montserrat-latin.woff2'],
      'Montserrat Bold': ['montserrat-latin.woff2']
    };
    const files = [];
    const local = new Set(schema.LOCAL_FONTS);
    [appearance.font_heading, appearance.font_body, appearance.font_ui].forEach((value) => {
      const key = String(value || '');
      if (!key || !local.has(key)) return;
      (FILES[key] || []).forEach((f) => files.push(f));
    });
    return Array.from(new Set(files));
  })();
  res.locals.query = req.query;
  res.locals.pageTitle = '';
  res.locals.pageDescription = '';
  res.locals.bodyClass = '';
  // Kategori portfolio sekarang dari database (bisa dikelola admin). Bentuknya tetap
  // {value,label} supaya view & test lama tidak perlu berubah.
  res.locals.PORTFOLIO_CATEGORIES = util.portfolioCategories({ activeOnly: false });
  res.locals.portfolioCategoryLabel = util.portfolioCategoryLabel;
  res.locals.STATUSES = util.STATUSES;
  // Inline SVG icon helper (benefit icons). Paths are authored in src/icons.js only.
  res.locals.icon = require('./icons').svg;
  res.locals.BENEFIT_ICONS = require('./icons').ICONS;
  next();
});

app.use('/portal', require('./routes/portal'));
app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Halaman tidak ditemukan',
    status: 404,
    message: 'Halaman yang Anda cari tidak tersedia atau sudah dipindahkan.'
  });
});

// Error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err && err.stack ? err.stack : err);
  const status = err && err.status ? err.status : 500;
  if (res.headersSent) return;
  res.status(status).render('error', {
    title: status === 404 ? 'Halaman tidak ditemukan' : 'Terjadi kesalahan',
    status,
    message: status === 500
      ? 'Terjadi kesalahan pada server. Silakan coba lagi atau hubungi kami via WhatsApp.'
      : (err.message || 'Permintaan tidak dapat diproses.')
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DLY Graduation listening on ${PORT}`);

  // Tahap 6 — Web Push: generate the VAPID pair on first boot and start the hourly
  // scheduler for the two time-based notifications (deadline + tomorrow's shoot).
  try {
    const push = require('./push');
    const cfg = push.config();
    if (cfg.ok) console.log('[push] VAPID siap, perangkat aktif:', push.deviceCount());
    push.startScheduler();
  } catch (err) {
    console.error('[push] gagal disiapkan', err.message);
  }

  // Housekeeping: drop orphaned temp files left by an interrupted image build
  // (the portal preview cache had grown to 328MB this way). Dijalankan saat boot DAN
  // berkala (P2) supaya uptime panjang tidak menumpuk lagi file sementara.
  const sweepTemp = () => {
    try {
      const cleaned = images.cleanTempDirs();
      if (cleaned.removed) {
        console.log(`[images] ${cleaned.removed} file sementara dibersihkan (${Math.round(cleaned.freed / 1024 / 1024)}MB)`);
      }
    } catch (err) {
      console.error('[images] cleanup gagal', err.message);
    }
  };
  sweepTemp();
  // Tiap 10 menit: file `.in-*`/`.gen-*` yatim (sisa konversi yang terpotong restart)
  // masing-masing sebesar master (1–6 MB) — ini penyebab preview-cache pernah 328 MB.
  setInterval(sweepTemp, 10 * 60 * 1000).unref();

  // V2 — pembersihan thumbnail seleksi (background worker, idempotent + retry).
  // Hanya file cache; data pilihan & master tidak pernah disentuh.
  try {
    require('./selection-cleanup').startWorker();
  } catch (err) {
    console.error('[selection-cleanup] worker gagal start', err.message);
  }

  // Keep image metadata + the most-used derivatives warm so the first visitor does not
  // pay for `identify`/`convert` on the request path. Runs after boot, never blocks.
  //
  // P0: hanya file yang BELUM terindeks (bukan 428 file setiap boot), semua proses lewat
  // antrean maks 2 (`withImageSlot`), dan varian yang benar-benar dipakai `<picture>`
  // ikut dihangatkan (termasuk 1600/2000 yang dulu terlewat → pengunjung pertama
  // menunggu 350–371 ms per gambar).
  setTimeout(() => {
    images.warmDimensions()
      .then((r) => console.log(`[images] dimensi: ${r.checked} file diperiksa (dari ${r.total})`))
      .catch((err) => console.error('[images] warm dimensi gagal', err.message));

    try {
      const { db, getSettings } = require('./db');
      const heroSlides = db.prepare(
        "SELECT image_url FROM hero_slides WHERE is_active = 1 ORDER BY sort_order LIMIT 4"
      ).all();
      const portfolio = db.prepare(
        'SELECT image FROM portfolio WHERE is_active = 1 ORDER BY is_featured DESC, sort_order LIMIT 8'
      ).all();
      // Harus sama dengan `widths` di section-hero.ejs / section-carousel.ejs.
      const jobs = [];
      heroSlides.forEach((h) => [480, 800, 1200, 1600, 2000].forEach((w) => jobs.push({ src: h.image_url, width: w })));
      portfolio.forEach((p) => [480, 800, 1600].forEach((w) => jobs.push({ src: p.image, width: w })));
      images.warm(jobs).then(() => console.log(`[images] ${jobs.length} turunan disiapkan`)).catch(() => {});

      // Logo: hitung tinta (terang/gelap) SEKALI di latar belakang, bukan saat render.
      const s = getSettings();
      let appearance = {};
      try { appearance = require('./content').getAppearance() || {}; } catch (err) { appearance = {}; }
      const logoSources = [
        s.selection_portal_logo, s.logo_header_dark, s.logo_header_light,
        s.logo_footer_dark, s.logo_footer_light, appearance.logo
      ].filter(Boolean);
      images.warmLogoTones(logoSources)
        .then(() => console.log('[images] tinta logo siap'))
        .catch(() => {});

      // Varian logo (WebP 96/192/320 × tinta terang+gelap) disiapkan di latar supaya
      // pengunjung pertama tidak menunggu `convert` (dulu ±800 ms untuk 6 varian).
      setTimeout(() => {
        const logoJobs = [];
        logoSources.slice(0, 3).forEach((src) => {
          ['keep', 'light', 'dark'].forEach((tone) => {
            images.LOGO_WIDTHS.forEach((w) => {
              logoJobs.push(images.buildLogoInk(src, tone, { width: w, format: 'webp', background: true }).catch(() => {}));
            });
          });
        });
        Promise.all(logoJobs).then(() => console.log(`[images] ${logoJobs.length} varian logo disiapkan`)).catch(() => {});
      }, 4000);
    } catch (err) {
      console.error('[images] warm turunan gagal', err.message);
    }
  }, 1500);
});

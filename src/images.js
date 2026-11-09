'use strict';

/**
 * Responsive image derivatives (V10).
 *
 * Masters stay exactly where they are (`public/uploads/…`, untouched). For every request
 * we generate — once — a downscaled WebP (plus a JPEG fallback) into
 * `DATA_DIR/image-cache/`, then serve it through `/media/…` with an immutable cache header.
 *
 * The URL carries everything needed to rebuild the file, so a wiped cache (or a new data
 * dir after a deploy) heals itself on the next request:
 *
 *   /media/<base64url(/uploads/foo.jpg)>.<width>.<webp|jpg>
 *
 * Only paths under /uploads with an image extension are accepted, so the route cannot be
 * used to read arbitrary files. Non-local sources (CDN URLs) are passed through unchanged.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { DATA_DIR } = require('./db');
const media = require('./media');

const CACHE_DIR = path.join(DATA_DIR, 'image-cache');
const INDEX_FILE = path.join(CACHE_DIR, 'dimensions.json');

/** Widths offered in srcset. Chosen to cover phones → retina desktop heroes. */
const WIDTHS = [96, 192, 320, 480, 640, 800, 1000, 1200, 1600, 2000];
const FORMATS = new Set(['webp', 'jpg']);

/**
 * Ukuran turunan logo. Logo selalu ditampilkan dengan TINGGI 40 px (--logo-h), jadi
 * 96/192/320 px lebar sudah cukup untuk 1×/2×/Retina tanpa mengirim PNG 560 px.
 * (Terukur: logo 49 KB PNG 560 px → 6 KB WebP 96 px, tampilan identik.)
 */
const LOGO_WIDTHS = [96, 192, 320];
const LOGO_FORMATS = new Set(['webp', 'png']);

const ALLOWED_EXT = /\.(jpe?g|png|webp|gif)$/i;

/* ------------------------------------------------------------------ */
/* Masters                                                             */
/* ------------------------------------------------------------------ */
/** Absolute path of a local upload, or null for CDN/remote sources. */
function masterPath(src) {
  const value = String(src || '');
  if (!value.startsWith('/uploads/')) return null;
  if (!ALLOWED_EXT.test(value)) return null;
  const p = media.localPathFor(value);
  if (!p) return null;
  return fs.existsSync(p) ? p : null;
}

const isProcessable = (src) => Boolean(masterPath(src));

/* ------------------------------------------------------------------ */
/* Antrean proses gambar (P0)                                          */
/* ------------------------------------------------------------------ */
/**
 * Semua `convert`/`identify` lewat antrean ini. Dulu warm-up boot melepas ~19–28 proses
 * `convert` sekaligus; di server yang dipakai bersama itu membuat CPU jenuh dan semua
 * request lain ikut menunggu (lonjakan 10–60 detik setelah publish). Sekarang maksimal
 * IMG_CONCURRENCY proses berjalan bersamaan, sisanya mengantre rapi.
 *
 * DUA TINGKAT PRIORITAS:
 *  - 'high' = permintaan pengunjung saat ini (varian gambar / logo yang sedang ditunggu)
 *  - 'low'  = pekerjaan latar (warm-up boot, indeks dimensi, deteksi tinta logo)
 * Tanpa ini, permintaan pengunjung bisa mengantre di belakang 30+ tugas warm-up dan
 * halaman terasa menggantung puluhan detik.
 */
const IMG_CONCURRENCY = Math.max(2, Number(process.env.IMG_CONCURRENCY || 3));
/** Pekerjaan latar tidak boleh memakai SEMUA slot: 1 slot selalu disisakan untuk
 *  permintaan pengunjung supaya halaman tidak pernah menunggu warm-up selesai. */
const IMG_LOW_MAX = Math.max(1, IMG_CONCURRENCY - 2);
let imgActive = 0;
let imgActiveLow = 0;
const imgQueues = { high: [], low: [] };
const imgStats = { queued: 0, done: 0, maxQueue: 0, high: 0, low: 0 };

function withImageSlot(fn, priority = 'high') {
  return new Promise((resolve, reject) => {
    const tier = priority === 'low' ? 'low' : 'high';
    const run = () => {
      imgActive += 1;
      if (tier === 'low') imgActiveLow += 1;
      imgStats[tier] += 1;
      Promise.resolve()
        .then(fn)
        .then((v) => {
          imgActive -= 1;
          if (tier === 'low') imgActiveLow -= 1;
          imgStats.done += 1;
          next();
          resolve(v);
        }, (e) => {
          imgActive -= 1;
          if (tier === 'low') imgActiveLow -= 1;
          next();
          reject(e);
        });
    };
    const canStart = tier === 'low'
      ? (imgActive < IMG_CONCURRENCY && imgActiveLow < IMG_LOW_MAX && !imgQueues.high.length)
      : imgActive < IMG_CONCURRENCY;
    if (canStart) run();
    else {
      imgQueues[tier].push(run);
      imgStats.queued += 1;
      imgStats.maxQueue = Math.max(imgStats.maxQueue, imgQueues.high.length + imgQueues.low.length);
    }
  });
}
function next() {
  if (imgActive >= IMG_CONCURRENCY) return;
  // Prioritas: permintaan pengunjung dulu, baru pekerjaan latar.
  const high = imgQueues.high.shift();
  if (high) { high(); return; }
  if (imgActiveLow < IMG_LOW_MAX) {
    const low = imgQueues.low.shift();
    if (low) low();
  }
}
const imageQueueStats = () => ({
  ...imgStats,
  active: imgActive,
  activeLow: imgActiveLow,
  waitingHigh: imgQueues.high.length,
  waitingLow: imgQueues.low.length,
  concurrency: IMG_CONCURRENCY
});

/* ------------------------------------------------------------------ */
/* Dimensions (for width/height attributes → no layout shift)           */
/* ------------------------------------------------------------------ */
let dimCache = null;

function loadIndex() {
  if (dimCache) return dimCache;
  try {
    dimCache = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (err) {
    dimCache = {};
  }
  return dimCache;
}

let indexDirty = false;
function saveIndex() {
  if (!indexDirty) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(dimCache));
    indexDirty = false;
  } catch (err) { /* non-fatal: dimensions are only used for aspect-ratio hints */ }
}

/**
 * Intrinsic size of a master. Memory/disk-cached only — this runs while a page is being
 * rendered, so it must never spawn a process. Missing entries are queued and filled in the
 * background by `warmDimensions()` (the first ever render may therefore omit width/height,
 * which is harmless: aspect-ratio is also set in CSS).
 *
 * P0: file yang GAGAL dibaca (mis. PNG rusak) ditandai `failed` dan tidak pernah dicoba
 * lagi. Sebelumnya 146 entri ber-`width:0` dicoba ulang setiap boot (131 di antaranya file
 * uji rusak) sehingga boot selalu men-spawn ±145 proses `identify`.
 */
const pendingDims = new Set();

function dimensions(src) {
  const file = masterPath(src);
  if (!file) return { width: 0, height: 0 };
  const index = loadIndex();
  const key = path.basename(file);
  const cached = index[key];
  if (cached && cached.width) return { width: cached.width, height: cached.height };
  // Gagal permanen → jangan diantrekan lagi.
  if (cached && cached.failed) return { width: 0, height: 0 };
  if (cached && cached.width === 0 && Date.now() - (cached.at || 0) < 3600 * 1000) {
    return { width: 0, height: 0 };
  }
  pendingDims.add(key);
  return { width: 0, height: 0 };
}

/**
 * Reads dimensions with `identify` OUTSIDE the request path (boot/idle).
 * P0: lewat antrean (maks 2 bersamaan) dan hasil GAGAL disimpan sebagai `failed` sehingga
 * file rusak tidak pernah di-identify ulang di boot berikutnya.
 */
async function fillDimension(name) {
  const file = path.join(media.LOCAL_DIR, name);
  if (!fs.existsSync(file)) return;
  const index = loadIndex();
  let stat;
  try { stat = fs.statSync(file); } catch (err) { return; }
  const cached = index[name];
  if (cached && cached.mtime === Math.round(stat.mtimeMs) && cached.width) return;
  if (cached && cached.failed && cached.mtime === Math.round(stat.mtimeMs)) return;
  try {
    const out = await withImageSlot(() => new Promise((resolve, reject) => {
      execFile('identify', ['-format', '%w %h', `${file}[0]`],
        { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
    }), 'low');
    const [w, h] = out.split(/\s+/).map(Number);
    if (!(w > 0 && h > 0)) throw new Error('dimensi tidak terbaca');
    index[name] = { width: w, height: h, mtime: Math.round(stat.mtimeMs), at: Date.now() };
    indexDirty = true;
  } catch (err) {
    index[name] = { width: 0, height: 0, failed: true, mtime: Math.round(stat.mtimeMs), at: Date.now() };
    indexDirty = true;
  }
}

/**
 * Backfills dimensions for every upload (batched, non-blocking at startup).
 * P0: hanya file yang belum punya dimensi — bukan seluruh 428 file setiap boot.
 */
async function warmDimensions() {
  let names = [];
  try {
    names = fs.readdirSync(media.LOCAL_DIR).filter((n) => ALLOWED_EXT.test(n));
  } catch (err) {
    return { total: 0, checked: 0 };
  }
  const index = loadIndex();
  const todo = [];
  for (const name of names) {
    let stat;
    try { stat = fs.statSync(path.join(media.LOCAL_DIR, name)); } catch (err) { continue; }
    const mtime = Math.round(stat.mtimeMs);
    const cached = index[name];
    if (cached && cached.mtime === mtime && (cached.width || cached.failed)) continue;
    todo.push(name);
  }
  for (const name of todo) {
    pendingDims.delete(name);
    // eslint-disable-next-line no-await-in-loop
    await fillDimension(name);
  }
  saveIndex();
  return { total: names.length, checked: todo.length };
}

/* ------------------------------------------------------------------ */
/* URL building                                                       */
/* ------------------------------------------------------------------ */
const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64 = (value) => Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** Canonical cache file name for one derivative (deterministic → safe to cache forever). */
function variantName(src, width, format) {
  const file = masterPath(src);
  const stamp = file ? Math.round(fs.statSync(file).mtimeMs) : 0;
  const hash = crypto.createHash('sha1').update(`${src}|${stamp}`).digest('hex').slice(0, 8);
  return `${hash}-${width}.${format}`;
}

/** Public URL of one derivative (relative to the app base path). */
function urlFor(base, src, width, format = 'webp') {
  const file = masterPath(src);
  if (!file) return '';
  return `${base}/media/${variantName(src, width, format)}`;
}

/* ------------------------------------------------------------------ */
/* Generation                                                         */
/* ------------------------------------------------------------------ */
const inflight = new Map();

function convert(args, timeout = 25000, priority = 'high') {
  // P0: lewat antrean agar tidak pernah ada puluhan proses `convert` sekaligus.
  return withImageSlot(() => new Promise((resolve, reject) => {
    execFile('convert', args, { timeout, stdio: ['ignore', 'ignore', 'pipe'] }, (err) => {
      if (err) reject(err);
      else resolve(true);
    });
  }), priority);
}

async function buildVariant(src, width, format, { background = false } = {}) {
  const file = masterPath(src);
  if (!file) throw new Error('not-local');
  const name = variantName(src, width, format);
  const target = path.join(CACHE_DIR, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;

  if (inflight.has(name)) return inflight.get(name);

  const job = (async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = path.join(CACHE_DIR, `.gen-${name}.${process.pid}.tmp`);
    const args = [
      `${file}[0]`, '-auto-orient', '-strip',
      '-resize', `${width}x${width}>`,
      '-quality', format === 'webp' ? '80' : '82'
    ];
    if (format === 'webp') args.push('-define', 'webp:method=4');
    args.push(`${format}:${tmp}`);
    try {
      await convert(args, 25000, background ? 'low' : 'high');
      fs.renameSync(tmp, target);
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
    }
    return target;
  })();

  inflight.set(name, job);
  try {
    return await job;
  } finally {
    inflight.delete(name);
  }
}

/** Resolves `/media/<hash>-<width>.<fmt>` back to its source + params (or null). */
function parseVariantName(name) {
  const m = /^([a-f0-9]{8})-(\d+)\.(webp|jpg)$/.exec(String(name || ''));
  if (!m) return null;
  const width = Number(m[2]);
  if (!WIDTHS.includes(width)) return null;
  if (!FORMATS.has(m[3])) return null;
  return { hash: m[1], width, format: m[3] };
}

/** Finds the master whose hash matches (uploads only — a bounded directory). */
function sourceForHash(hash, width, format) {
  let files = [];
  try {
    files = fs.readdirSync(media.LOCAL_DIR);
  } catch (err) {
    return null;
  }
  for (const name of files) {
    if (!ALLOWED_EXT.test(name)) continue;
    const src = `/uploads/${name}`;
    if (variantName(src, width, format) === `${hash}-${width}.${format}`) return src;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Markup helpers                                                     */
/* ------------------------------------------------------------------ */
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Membuat markup logo dari turunan `/logo/<token>`.
 * P0/P1: logo dulu dikirim sebagai PNG 560 px (49 KB) untuk tampilan 40 px — 34% berat
 * beranda. Sekarang: WebP 96/192/320 px + fallback PNG 192 px, ukuran & rasio eksplisit.
 */
function logoPicture(base, value, opts = {}) {
  const token = String(value).replace(/^.*\/logo\//, '').replace(/\.png$/i, '');
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return '';
  const alt = esc(opts.alt || '');
  // `opts.className` datang dari picture() sebagai string ` class="..."` (sudah siap pakai).
  // Jangan di-escape/dibungkus lagi — dulu sempat menghasilkan `class=" class="..."`.
  const rawClass = String(opts.className || '');
  const className = rawClass ? (rawClass.trim().startsWith('class=') ? ` ${rawClass.trim()}` : ` class="${esc(rawClass)}"`) : '';
  const sizes = opts.sizes || '180px';
  const loading = opts.priority || opts.eager ? 'eager' : (opts.loading || 'lazy');
  const priority = opts.priority ? ' fetchpriority="high"' : '';
  const widths = (opts.widths && opts.widths.length ? opts.widths : LOGO_WIDTHS)
    .filter((w) => LOGO_WIDTHS.includes(w)).sort((a, b) => a - b);
  const webpSet = widths.map((w) => `${base}/logo/${token}-${w}.webp ${w}w`).join(', ');
  const fallbackW = widths.includes(192) ? 192 : widths[widths.length - 1];
  return '<picture>'
    + `<source type="image/webp" srcset="${esc(webpSet)}" sizes="${esc(sizes)}">`
    + `<img src="${base}/logo/${token}-${fallbackW}.png" `
    + `srcset="${esc(widths.map((w) => `${base}/logo/${token}-${w}.png ${w}w`).join(', '))}" `
    + `sizes="${esc(sizes)}" alt="${alt}"${className} loading="${loading}"${priority} decoding="async">`
    + '</picture>';
}

/**
 * Builds a `<picture>` element with WebP + JPEG srcset, explicit width/height (no layout
 * shift), `loading`/`fetchpriority` and a matching `sizes` attribute.
 *
 * opts: { alt, widths, sizes, className, loading, priority, eager, displayWidth, displayHeight }
 */
function picture(base, src, opts = {}) {
  const value = String(src || '');
  if (!value) return '';
  const alt = opts.alt || '';
  const className = opts.className ? ` class="${esc(opts.className)}"` : '';
  // `priority` = the LCP candidate (one per page). `eager` = load now, normal priority
  // (logos, the first few portfolio cards). Everything else is lazy.
  const loading = opts.priority || opts.eager ? 'eager' : (opts.loading || 'lazy');
  const priority = opts.priority ? ' fetchpriority="high"' : '';
  const decoding = ' decoding="async"';

  // Logo adaptif (`/logo/<token>.png`) memakai turunan kecil + srcset WebP.
  if (/\/logo\/[A-Za-z0-9_-]+\.png$/i.test(value)) {
    return logoPicture(base, value, { ...opts, alt, className, loading, priority });
  }

  // Remote/CDN or SVG: nothing to transform — emit a plain <img> with the same hints.
  if (!isProcessable(value)) {
    return `<img src="${esc(value)}" alt="${esc(alt)}"${className} loading="${loading}"${priority}${decoding}>`;
  }

  const dims = dimensions(value);
  const widths = (opts.widths && opts.widths.length ? opts.widths : [480, 800, 1200])
    .filter((w) => WIDTHS.includes(w))
    .sort((a, b) => a - b);

  const fallback = widths[widths.length - 1];
  const webpSet = widths.map((w) => `${urlFor(base, value, w, 'webp')} ${w}w`).join(', ');
  const jpgSet = widths.map((w) => `${urlFor(base, value, w, 'jpg')} ${w}w`).join(', ');
  const sizes = opts.sizes || '100vw';

  const w = dims.width || opts.displayWidth || 0;
  const h = dims.height || opts.displayHeight || 0;
  const box = w && h ? ` width="${w}" height="${h}"` : '';

  return '<picture>'
    + `<source type="image/webp" srcset="${esc(webpSet)}" sizes="${esc(sizes)}">`
    + `<img src="${esc(urlFor(base, value, fallback, 'jpg'))}" srcset="${esc(jpgSet)}" `
    + `sizes="${esc(sizes)}" alt="${esc(alt)}"${className}${box} loading="${loading}"${priority}${decoding}>`
    + '</picture>';
}

/**
 * Plain srcset string for places that already have their own <img> markup
 * (e.g. the portal gallery where the source is a token-scoped route).
 */
function srcset(pairs) {
  return pairs.filter((p) => p && p[0]).map(([u, w]) => `${u} ${w}w`).join(', ');
}

/* ------------------------------------------------------------------ */
/* Logo adaptif (warna mengikuti latar)                                */
/* ------------------------------------------------------------------ */
/**
 * Pemilik hanya perlu mengunggah SATU file logo. Agar logo selalu terbaca, kita
 * menyiapkan dua "tinta":
 *   - tone 'light'  → logo putih, untuk latar gelap (hero foto, footer navy, sidebar)
 *   - tone 'dark'   → logo navy, untuk latar terang (header putih, kartu login)
 *
 * Bila file yang diunggah sudah berwarna sesuai (dideteksi dari warna piksel yang
 * opak), file itu dipakai apa adanya — "sesuai warna asli". Bila belum ada varian
 * untuk latar tertentu, turunannya dibuat otomatis (alpha dipertahankan, hanya RGB
 * yang diganti) lalu di-cache, jadi tetap satu sumber kebenaran.
 */
const LOGO_DIR = path.join(DATA_DIR, 'logo-cache');
const LOGO_INK = { light: '#FFFFFF', dark: '#0B2340' };
/**
 * Tone "keep" = jangan diwarnai, cukup trim + resize.
 *
 * Kenapa perlu: file logo dari pemilik adalah kanvas besar dengan ruang transparan
 * (contoh 5000x4000 sedangkan artwork-nya hanya 4480x2234). Kalau file asli dipakai
 * langsung, `height: 40px` menghasilkan artwork setinggi ~22px → logo tampak kecil
 * dan ukurannya berbeda-beda antar halaman (header vs footer vs portal vs admin).
 * Semua permukaan sekarang memakai turunan yang sudah di-trim (dan diwarnai bila
 * tintanya berbeda), jadi satu tinggi CSS = satu ukuran visual di mana pun.
 */
const isLogoTone = (tone) => tone === 'keep' || Object.prototype.hasOwnProperty.call(LOGO_INK, tone);
const toneCache = new Map();
const logoInflight = new Map();

const toToken = (raw) => Buffer.from(raw, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Token logo: base64url(`tone|src`), dengan ekstensi opsional `-<width>.<webp|png>`.
 *   /logo/<token>.png            → PNG 560 px (perilaku lama)
 *   /logo/<token>-192.webp       → WebP 192 px (dipakai srcset)
 */
function parseLogoToken(token) {
  const name = String(token || '');
  const sized = /^(.*)-(\d{2,4})\.(webp|png)$/i.exec(name);
  let value = name;
  let width = 0;
  let format = 'png';
  if (sized) {
    value = sized[1];
    width = Number(sized[2]);
    format = sized[3].toLowerCase();
    if (!LOGO_WIDTHS.includes(width)) return null;
  } else {
    value = value.replace(/\.png$/i, '');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let raw = '';
  try { raw = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (err) { return null; }
  const sp = raw.indexOf('|');
  if (sp < 1) return null;
  const tone = raw.slice(0, sp);
  const src = raw.slice(sp + 1);
  if (!isLogoTone(tone)) return null;
  if (!masterPath(src)) return null;
  return { tone, src, width, format };
}

const logoFileName = (src, tone) => `${crypto.createHash('sha1').update(`${src}|${tone}`).digest('hex').slice(0, 12)}-${tone}.png`;

/** URL turunan logo (relatif terhadap base path app). '' bila sumber bukan upload lokal. */
function logoInkUrl(base, src, tone) {
  if (!isLogoTone(tone) || !masterPath(src)) return '';
  return `${base}/logo/${toToken(`${tone}|${src}`)}.png`;
}

/**
 * Warna asli logo: 'light' (terang/putih), 'dark' (gelap/navy) atau 'unknown'
 * (berwarna banyak — jangan di-recolor, pakai apa adanya).
 *
 * P0: panggilan `convert` SINKRON dihapus. Dulu fungsi ini dipanggil saat render
 * (`res.locals.logoUrlFor`) dan `execFileSync` memblokir seluruh event loop 0,4–0,8 detik
 * per logo — profil CPU menunjukkan `spawnSync` sebagai 10% dari seluruh waktu CPU.
 *
 * Sekarang:
 *  - hasil disimpan permanen di `logo-cache/tones.json` (kunci: src|mtime),
 *  - render hanya MEMBACA cache; bila belum ada, dipakai `fallback` (tone yang diminta)
 *    sehingga logo tampil dengan warna aslinya (trim saja) — tidak pernah salah warna,
 *  - perhitungan dijalankan sekali di latar belakang (antrean) saat boot & saat logo diganti.
 */
const TONE_FILE = path.join(DATA_DIR, 'logo-cache', 'tones.json');
let toneDisk = null;
function loadTones() {
  if (toneDisk) return toneDisk;
  try { toneDisk = JSON.parse(fs.readFileSync(TONE_FILE, 'utf8')); } catch (err) { toneDisk = {}; }
  return toneDisk;
}
function saveTones() {
  try {
    fs.mkdirSync(path.dirname(TONE_FILE), { recursive: true });
    fs.writeFileSync(TONE_FILE, JSON.stringify(toneDisk || {}));
  } catch (err) { /* non-fatal */ }
}

const toneKey = (src) => {
  const file = masterPath(src);
  if (!file) return null;
  let stamp = 0;
  try { stamp = Math.round(fs.statSync(file).mtimeMs); } catch (err) { return null; }
  return { key: `${src}|${stamp}`, file };
};

function logoTone(src, fallback = 'unknown') {
  const info = toneKey(src);
  if (!info) return fallback;
  if (toneCache.has(info.key)) return toneCache.get(info.key);
  const disk = loadTones();
  if (disk[info.key] && disk[info.key].tone) {
    toneCache.set(info.key, disk[info.key].tone);
    return disk[info.key].tone;
  }
  // Belum diketahui: pakai warna diminta (= 'keep' / warna asli) & hitung di latar belakang.
  queueTone(info.key, info.file);
  return fallback;
}

const tonePending = new Set();
function queueTone(key, file) {
  if (tonePending.has(key)) return;
  tonePending.add(key);
  withImageSlot(() => new Promise((resolve) => {
    execFile('convert', [
      `${file}[0]`, '-trim', '+repage', '-resize', '24x24>', '-format', '%c', 'histogram:info:-'
    ], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }, (err, stdout) => {
      let tone = 'unknown';
      if (!err) {
        let weight = 0; let r = 0; let g = 0; let b = 0;
        String(stdout).split('\n').forEach((line) => {
          const m = /\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)/.exec(line);
          const count = Number((line.match(/^\s*(\d+):/) || [])[1] || 0);
          if (!m || !count) return;
          const alpha = Number(m[4]);
          if (!(alpha > 100)) return;
          const w = count * (alpha / 255);
          weight += w; r += Number(m[1]) * w; g += Number(m[2]) * w; b += Number(m[3]) * w;
        });
        if (weight > 0) {
          const lum = ((r / weight) * 0.2126 + (g / weight) * 0.7152 + (b / weight) * 0.0722) / 255;
          if (lum >= 0.62) tone = 'light';
          else if (lum <= 0.42) tone = 'dark';
        }
      }
      toneCache.set(key, tone);
      const disk = loadTones();
      disk[key] = { tone, at: Date.now() };
      // buang entri lama untuk sumber yang sama (mtime berbeda)
      const srcPrefix = `${key.split('|')[0]}|`;
      Object.keys(disk).forEach((k) => { if (k !== key && k.startsWith(srcPrefix)) delete disk[k]; });
      saveTones();
      tonePending.delete(key);
      resolve(tone);
    });
  }), 'low').catch(() => { tonePending.delete(key); });
}

/** Hitung tone untuk semua sumber logo yang dipakai (dipanggil saat boot / setelah upload). */
async function warmLogoTones(sources = []) {
  const list = Array.from(new Set(sources.filter(Boolean)));
  const results = await Promise.all(list.map((src) => new Promise((resolve) => {
    const info = toneKey(src);
    if (!info) return resolve(null);
    const disk = loadTones();
    if (disk[info.key] && disk[info.key].tone) return resolve(disk[info.key].tone);
    queueTone(info.key, info.file);
    return resolve('pending');
  })));
  return results;
}

/** Nama file turunan logo untuk (sumber, tinta, lebar, format). */
const logoVariantName = (src, tone, width, format) => `${crypto
  .createHash('sha1').update(`${src}|${tone}|${width}|${format}`).digest('hex').slice(0, 12)}-${tone}-${width}.${format}`;

/**
 * URL turunan logo (relatif terhadap base path app). '' bila sumber bukan upload lokal.
 * `width`/`format` opsional; default = PNG 560 px (perilaku lama, tetap didukung).
 */
function logoInkUrl(base, src, tone, width = 0, format = 'png') {
  if (!isLogoTone(tone) || !masterPath(src)) return '';
  const token = toToken(`${tone}|${src}`);
  if (!width) return `${base}/logo/${token}.png`;
  return `${base}/logo/${token}-${width}.${format}`;
}

/**
 * Master logo yang sudah di-trim (+ diwarnai bila perlu), disimpan sekali.
 * `-trim` pada PNG besar adalah bagian termahal (±700 ms); sebelumnya diulang untuk
 * SETIAP ukuran (96/192/320 × 2 tinta = 6×). Sekarang cukup sekali per (sumber, tinta),
 * lalu setiap ukuran hanya resize dari master kecil itu (±30–80 ms).
 */
async function logoTrimmedMaster(src, tone, { background = false } = {}) {
  const file = masterPath(src);
  if (!file || !isLogoTone(tone)) throw new Error('not-local');
  const name = `${crypto.createHash('sha1').update(`base|${src}|${tone}`).digest('hex').slice(0, 12)}-${tone}-base.png`;
  const target = path.join(LOGO_DIR, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  if (logoInflight.has(name)) return logoInflight.get(name);
  const job = (async () => {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    const tmp = path.join(LOGO_DIR, `.${name}.${process.pid}.tmp.png`);
    try {
      const args = [`${file}[0]`, '-trim', '+repage'];
      if (LOGO_INK[tone]) {
        args.push('-channel', 'RGB', '-fill', LOGO_INK[tone], '-colorize', '100', '+channel');
      }
      args.push('-resize', '640x640>', '-strip', `png:${tmp}`);
      await convert(args, 25000, background ? 'low' : 'high');
      fs.renameSync(tmp, target);
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
    }
    return target;
  })();
  logoInflight.set(name, job);
  try { return await job; } finally { logoInflight.delete(name); }
}

/**
 * Membuat (sekali) file logo dengan tinta tertentu; alpha tetap dipertahankan.
 * tone 'keep' → hanya trim + resize (warna asli dipertahankan).
 * width/format: turunan kecil untuk web (WebP) — `{ width }` kosong = 560 px PNG lama.
 */
async function buildLogoInk(src, tone, { width = 0, format = 'png', background = false } = {}) {
  const file = masterPath(src);
  if (!file || !isLogoTone(tone)) throw new Error('not-local');
  const safeWidth = width && LOGO_WIDTHS.includes(Number(width)) ? Number(width) : 0;
  const safeFormat = LOGO_FORMATS.has(format) ? format : 'png';
  const name = safeWidth ? logoVariantName(src, tone, safeWidth, safeFormat) : logoFileName(src, tone);
  const target = path.join(LOGO_DIR, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  if (logoInflight.has(name)) return logoInflight.get(name);

  const job = (async () => {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    const tmp = path.join(LOGO_DIR, `.${name}.${process.pid}.tmp.${safeFormat}`);
    try {
      // Langkah 1: master yang sudah di-trim/diwarnai (mahal, sekali saja).
      const base = await logoTrimmedMaster(src, tone, { background });
      const args = [`${base}[0]`];
      if (safeWidth) {
        args.push('-resize', `${safeWidth}x${safeWidth * 2}>`);
        if (safeFormat === 'webp') args.push('-quality', '86', '-define', 'webp:method=5');
      } else {
        args.push('-resize', '560x560>');
      }
      args.push('-strip', `${safeFormat}:${tmp}`);
      await convert(args, 25000, background ? 'low' : 'high');
      fs.renameSync(tmp, target);
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
    }
    return target;
  })();

  logoInflight.set(name, job);
  try {
    return await job;
  } finally {
    logoInflight.delete(name);
  }
}

/**
 * Favicon dari logo resmi: artwork di-trim, dijadikan putih, lalu diletakkan di
 * tengah kotak navy (warna identitas DLY) berukuran persegi.
 *
 * Logo pemilik adalah lockup lebar 2:1 dengan ruang transparan besar, jadi kalau
 * file aslinya dipakai langsung sebagai <link rel="icon"> hasilnya nyaris tak
 * terlihat di tab browser. Turunan ini TIDAK menggambar ulang logo — hanya
 * memakai artwork resmi yang sama, di-trim dan diletakkan di atas kotak brand.
 */
const FAVICON_SIZE = 256;
const FAVICON_BG = '#0B2340';
/**
 * Versi GENERATOR favicon. Browser meng-cache favicon sangat keras (dan alamat
 * `/favicon/<token>.png` di-cache `immutable` 1 tahun), jadi kalau cara pembuatannya
 * berubah tanpa mengubah token, tab browser tetap menampilkan ikon LAMA. Nilai ini
 * ikut masuk ke token → URL baru → paksa ambil ulang. Naikkan bila mengubah cara
 * pembuatan favicon.
 */
const FAVICON_GEN = 'v3';

/** Penanda isi file sumber: path + mtime (re-upload ke path yang sama tetap berubah). */
function sourceStamp(src) {
  const file = masterPath(src);
  let stamp = 0;
  try { stamp = file ? Math.round(fs.statSync(file).mtimeMs) : 0; } catch (err) { stamp = 0; }
  return `${src}|${stamp}`;
}

const faviconFileName = (src) => `fav-${crypto.createHash('sha1')
  .update(`${FAVICON_GEN}|${sourceStamp(src)}`).digest('hex').slice(0, 12)}.png`;

function parseFaviconToken(token) {
  const value = String(token || '').replace(/\.png$/i, '');
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let raw = '';
  try {
    raw = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (err) { return null; }
  if (!raw.startsWith('favicon|')) return null;
  // Format baru: favicon|<GEN>|<path> — format lama (favicon|<path>) tetap diterima.
  const parts = raw.split('|');
  const src = parts.length >= 3 && parts[1] === FAVICON_GEN ? parts.slice(2).join('|') : parts.slice(1).join('|');
  return masterPath(src) ? src : null;
}

/**
 * URL favicon turunan. '' bila sumber bukan upload lokal (mis. URL CDN).
 *
 * Token WAJIB memuat FAVICON_GEN: URL inilah kunci cache browser. Kalau cara pembuatan
 * favicon berubah tetapi URL-nya tetap, tab browser akan terus menampilkan ikon lama
 * (persis keluhan pemilik: "logo di tab belum berubah"). Dengan GEN di URL, deploy baru
 * otomatis memaksa browser mengambil ikon baru.
 */
function faviconUrl(base, src) {
  if (!masterPath(src)) return '';
  return `${base}/favicon/${toToken(`favicon|${FAVICON_GEN}|${src}`)}.png`;
}

async function buildFavicon(src) {
  const file = masterPath(src);
  if (!file) throw new Error('not-local');
  const name = faviconFileName(src);
  const target = path.join(LOGO_DIR, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  if (logoInflight.has(name)) return logoInflight.get(name);

  const size = FAVICON_SIZE;
  const job = (async () => {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    const mark = path.join(LOGO_DIR, `.${name}.${process.pid}.mark.png`);
    const tmp = path.join(LOGO_DIR, `.${name}.${process.pid}.tmp.png`);
    try {
      // 100%: logo lockup lebar (2:1) butuh seluruh lebar kotak supaya masih terbaca
      // saat browser mengecilkannya ke 16px di tab. Tidak ada bagian logo yang dipotong.
      const inner = size;
      await convert([
        `${file}[0]`, '-trim', '+repage',
        '-channel', 'RGB', '-fill', '#FFFFFF', '-colorize', '100', '+channel',
        '-resize', `${inner}x${inner}`,
        '-background', 'none', '-gravity', 'center', '-extent', `${size}x${size}`,
        `png:${mark}`
      ]);
      await convert([
        '-size', `${size}x${size}`, `xc:${FAVICON_BG}`,
        mark, '-gravity', 'center', '-composite', '-strip', `png:${tmp}`
      ]);
      fs.renameSync(tmp, target);
    } finally {
      [mark, tmp].forEach((f) => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (err) { /* ignore */ } });
    }
    return target;
  })();

  logoInflight.set(name, job);
  try {
    return await job;
  } finally {
    logoInflight.delete(name);
  }
}

/**
 * Memilih sumber logo untuk latar terang (`dark` ink) dan latar gelap (`light` ink)
 * dari daftar kandidat milik admin. Kandidat yang warnanya sudah cocok dipakai apa
 * adanya; kalau tidak ada, dipakai kandidat pertama sebagai sumber turunan.
 */
function logoSet(candidates) {
  const list = [];
  const seen = new Set();
  (candidates || []).forEach((src) => {
    const value = String(src || '').trim();
    if (!value || seen.has(value)) return;
    if (!masterPath(value)) return;
    seen.add(value);
    list.push({ src: value, tone: logoTone(value) });
  });
  const pick = (tone) => (list.find((l) => l.tone === tone) || {}).src || '';
  const fallback = (list[0] || {}).src || '';
  return {
    light: pick('light') || fallback,
    dark: pick('dark') || fallback,
    // true bila sumber belum punya warna yang cocok → perlu turunan
    lightDerived: !pick('light') && Boolean(fallback),
    darkDerived: !pick('dark') && Boolean(fallback),
    sources: list
  };
}

/* ------------------------------------------------------------------ */
/* Ikon aplikasi (PWA / home screen / ikon notifikasi)                */
/* ------------------------------------------------------------------ */
/**
 * Revisi 2 (01–02): ikon PWA & ikon notifikasi wajib memakai LOGO RESMI DLY, bukan
 * monogram yang digambar ulang. Sumbernya sama dengan favicon (logo brand dari
 * Dashboard Admin → Identitas Brand), hanya ukurannya beda.
 *
 * Sama seperti favicon: artwork di-trim lalu dijadikan putih di atas kotak navy
 * supaya tetap terbaca sebagai ikon persegi kecil. Varian `maskable` memakai area
 * aman 58% supaya logo tidak terpotong oleh mask bulat Android.
 */
const APP_ICON_SIZES = [192, 512];
const appIconFileName = (src, size, maskable) =>
  `app-${crypto.createHash('sha1')
    .update(`${FAVICON_GEN}|${sourceStamp(src)}|${size}|${maskable ? 'mask' : 'any'}`)
    .digest('hex').slice(0, 12)}-${size}${maskable ? 'm' : ''}.png`;

function parseAppIconToken(token) {
  const value = String(token || '').replace(/\.png$/i, '');
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let raw = '';
  try { raw = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (err) { return null; }
  if (!raw.startsWith('appicon|')) return null;
  const parts = raw.split('|'); // appicon | GEN? | size | maskable | src
  const hasGen = parts[1] === FAVICON_GEN;
  const offset = hasGen ? 2 : 1;
  const size = Number(parts[offset]);
  const maskable = parts[offset + 1] === '1';
  const src = parts.slice(offset + 2).join('|');
  if (!APP_ICON_SIZES.includes(size)) return null;
  if (!masterPath(src)) return null;
  return { src, size, maskable };
}

/** URL ikon turunan. '' bila sumber bukan upload lokal (mis. URL CDN). */
function appIconUrl(base, src, size = 192, { maskable = false } = {}) {
  if (!masterPath(src)) return '';
  if (!APP_ICON_SIZES.includes(Number(size))) return '';
  return `${base}/appicon/${toToken(`appicon|${FAVICON_GEN}|${Number(size)}|${maskable ? 1 : 0}|${src}`)}.png`;
}

async function buildAppIcon(src, size, { maskable = false } = {}) {
  const file = masterPath(src);
  if (!file) throw new Error('not-local');
  const px = APP_ICON_SIZES.includes(Number(size)) ? Number(size) : 192;
  const name = appIconFileName(src, px, maskable);
  const target = path.join(LOGO_DIR, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  if (logoInflight.has(name)) return logoInflight.get(name);

  const job = (async () => {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    const mark = path.join(LOGO_DIR, `.${name}.${process.pid}.mark.png`);
    const tmp = path.join(LOGO_DIR, `.${name}.${process.pid}.tmp.png`);
    try {
      const inner = Math.round(px * (maskable ? 0.58 : 0.82));
      await convert([
        `${file}[0]`, '-trim', '+repage',
        '-channel', 'RGB', '-fill', '#FFFFFF', '-colorize', '100', '+channel',
        '-resize', `${inner}x${inner}`,
        '-background', 'none', '-gravity', 'center', '-extent', `${px}x${px}`,
        `png:${mark}`
      ]);
      await convert([
        '-size', `${px}x${px}`, `xc:${FAVICON_BG}`,
        mark, '-gravity', 'center', '-composite', '-strip', `png:${tmp}`
      ]);
      fs.renameSync(tmp, target);
    } finally {
      [mark, tmp].forEach((f) => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (err) { /* ignore */ } });
    }
    return target;
  })();

  logoInflight.set(name, job);
  try {
    return await job;
  } finally {
    logoInflight.delete(name);
  }
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                       */
/* ------------------------------------------------------------------ */
/**
 * Removes orphaned temp files. Generation writes `.gen-*`/`.in-*` files; a deploy or a
 * crash in the middle of one used to leave multi-MB masters behind forever (the portal
 * preview cache had grown to 328MB this way).
 */
function cleanTempDirs(dirs = [CACHE_DIR, path.join(DATA_DIR, 'preview-cache')], olderThanMs = 10 * 60 * 1000) {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  let freed = 0;
  dirs.forEach((dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      return;
    }
    names.forEach((name) => {
      if (!/^(\.gen-|\.in-|\.out-)/.test(name) && !/\.tmp$/.test(name)) return;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > cutoff) return;
        freed += st.size;
        fs.unlinkSync(p);
        removed += 1;
      } catch (err) { /* in use — next boot */ }
    });
  });
  return { removed, freed };
}

/** Warm a handful of variants so the first visitor does not pay for generation. */
function warm(list) {
  const jobs = [];
  (list || []).forEach(({ src, width, format }) => {
    if (!isProcessable(src)) return;
    jobs.push(buildVariant(src, width, format || 'webp', { background: true }).catch(() => {}));
  });
  return Promise.all(jobs);
}

module.exports = {
  WIDTHS,
  CACHE_DIR,
  isProcessable,
  masterPath,
  dimensions,
  warmDimensions,
  variantName,
  urlFor,
  buildVariant,
  parseVariantName,
  sourceForHash,
  picture,
  srcset,
  cleanTempDirs,
  warm,
  LOGO_DIR,
  parseLogoToken,
  logoInkUrl,
  logoTone,
  warmLogoTones,
  LOGO_WIDTHS,
  buildLogoInk,
  logoSet,
  imageQueueStats,
  withImageSlot,
  parseFaviconToken,
  faviconUrl,
  buildFavicon,
  APP_ICON_SIZES,
  parseAppIconToken,
  appIconUrl,
  buildAppIcon
};

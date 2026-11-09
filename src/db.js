'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const schema = require('./content-schema');

/**
 * Local copy of util.addWorkingDaysISO: src/util.js requires THIS module, so requiring it
 * here would be a circular dependency. Kept byte-for-byte equivalent (Mon–Fri).
 */
function addWorkingDaysISO(iso, days) {
  const addDays = (value, n) => {
    const d = new Date(value + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  let d = String(iso).slice(0, 10);
  let left = Math.max(0, Number(days) || 0);
  let guard = 0;
  while (left > 0 && guard < 3650) {
    d = addDays(d, 1);
    const weekday = new Date(d + 'T00:00:00Z').getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
    guard += 1;
  }
  return d;
}

const todayISOForMigration = () => {
  const tz = new Date(Date.now() + 7 * 3600 * 1000);
  return tz.toISOString().slice(0, 10);
};

// Data dir can be overridden (e.g. for isolated tests) without touching the live DB.
// Always absolute: res.sendFile() refuses relative paths, and a relative DLY_DATA_DIR
// (used by the test harness) silently broke image delivery.
const DATA_DIR = path.resolve(process.env.DLY_DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt, no external dependency)                   */
/* ------------------------------------------------------------------ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(password), salt, 64);
    const known = Buffer.from(hash, 'hex');
    if (calc.length !== known.length) return false;
    return crypto.timingSafeEqual(calc, known);
  } catch (err) {
    return false;
  }
}

const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.DLY_ADMIN_PASSWORD || 'DlyGraduation2025';

/* ------------------------------------------------------------------ */
/* Migration helpers                                                   */
/* ------------------------------------------------------------------ */
function columns(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch (err) {
    return [];
  }
}

function addColumn(table, column, definition) {
  if (!columns(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/* ------------------------------------------------------------------ */
/* Schema + seed. One transaction → one disk commit on boot.           */
/* ------------------------------------------------------------------ */
const bootstrap = db.transaction(() => {
  /* ---- original tables (kept, so a fresh DB stays compatible) ---- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS cities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      description TEXT,
      cover_image TEXT,
      is_active   INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS packages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id       INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL,
      description   TEXT,
      edited_photos INTEGER,
      facilities    TEXT,
      price_60      INTEGER,
      price_90      INTEGER,
      price_120     INTEGER,
      is_active     INTEGER NOT NULL DEFAULT 1,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (city_id, slug)
    );

    CREATE TABLE IF NOT EXISTS portfolio (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT NOT NULL,
      image          TEXT NOT NULL,
      category       TEXT NOT NULL DEFAULT 'individual',
      city_id        INTEGER REFERENCES cities(id) ON DELETE SET NULL,
      description    TEXT,
      taken_at       TEXT,
      is_featured    INTEGER NOT NULL DEFAULT 0,
      is_placeholder INTEGER NOT NULL DEFAULT 0,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      code             TEXT NOT NULL UNIQUE,
      access_token     TEXT NOT NULL,
      client_name      TEXT NOT NULL,
      client_phone     TEXT NOT NULL,
      campus           TEXT NOT NULL,
      city_id          INTEGER NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
      shooting_date    TEXT NOT NULL,
      location         TEXT NOT NULL,
      package_id       INTEGER NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
      duration         INTEGER NOT NULL,
      price            INTEGER NOT NULL,
      notes            TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS package_images (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      image      TEXT NOT NULL,
      caption    TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS home_stats (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      value_num   INTEGER NOT NULL DEFAULT 0,
      label       TEXT NOT NULL DEFAULT '',
      suffix      TEXT NOT NULL DEFAULT '+',
      is_active   INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL DEFAULT '',
      role       TEXT NOT NULL DEFAULT '',
      is_active  INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS addons (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      slug         TEXT NOT NULL UNIQUE,
      description  TEXT NOT NULL DEFAULT '',
      price        INTEGER,
      applies_to   TEXT NOT NULL DEFAULT 'all',
      is_active    INTEGER NOT NULL DEFAULT 1,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Manual availability overrides. Absence of a row = default availability.
    CREATE TABLE IF NOT EXISTS availability_overrides (
      date         TEXT PRIMARY KEY,
      is_available INTEGER NOT NULL DEFAULT 0,
      note         TEXT NOT NULL DEFAULT '',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS articles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      slug         TEXT NOT NULL UNIQUE,
      excerpt      TEXT NOT NULL DEFAULT '',
      body         TEXT NOT NULL DEFAULT '',
      cover_image  TEXT NOT NULL DEFAULT '',
      is_published INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS faqs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      question   TEXT NOT NULL,
      answer     TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS testimonials (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name    TEXT NOT NULL,
      client_meta    TEXT,
      quote          TEXT NOT NULL,
      rating         INTEGER NOT NULL DEFAULT 5,
      is_active      INTEGER NOT NULL DEFAULT 1,
      is_placeholder INTEGER NOT NULL DEFAULT 0,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      csrf       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  /* ---- additive columns (never drops anything) -------------------- */
  addColumn('cities', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('packages', 'category_id', 'INTEGER REFERENCES package_categories(id) ON DELETE SET NULL');
  addColumn('packages', 'label', "TEXT NOT NULL DEFAULT ''");
  addColumn('portfolio', 'image_url', 'TEXT');
  addColumn('portfolio', 'alt_text', "TEXT NOT NULL DEFAULT ''");
  addColumn('portfolio', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('portfolio', 'collection', "TEXT NOT NULL DEFAULT 'portfolio'");
  addColumn('portfolio', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'category_id', 'INTEGER REFERENCES package_categories(id) ON DELETE SET NULL');
  addColumn('bookings', 'duration_minutes', 'INTEGER');
  addColumn('bookings', 'internal_notes', "TEXT NOT NULL DEFAULT ''");
  // ---- V3 booking fields (multi-step form + price snapshots) ----
  addColumn('bookings', 'instagram', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'faculty', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'major', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'mu_instagram', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'wardrobe_instagram', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'location_address', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'package_price_snapshot', 'INTEGER');
  addColumn('bookings', 'addons_snapshot', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('bookings', 'total_price_snapshot', 'INTEGER');
  addColumn('bookings', 'photo_consent', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('bookings', 'edited_photos_snapshot', 'INTEGER');
  // ---- Google Calendar sync state (one event per booking) ----
  addColumn('bookings', 'gcal_event_id', 'TEXT');
  addColumn('bookings', 'gcal_synced_at', 'TEXT');
  addColumn('bookings', 'gcal_status', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'gcal_error', "TEXT NOT NULL DEFAULT ''");
  // ---- Google Drive folder per booking ----
  addColumn('bookings', 'drive_folder_id', 'TEXT');
  addColumn('bookings', 'drive_folder_url', 'TEXT');
  addColumn('bookings', 'drive_folder_path', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'drive_synced_at', 'TEXT');
  addColumn('bookings', 'drive_error', "TEXT NOT NULL DEFAULT ''");
  // ---- V4: chosen shooting time + TnC consent timestamp ----
  addColumn('bookings', 'shooting_time', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'terms_consent_at', 'TEXT');
  // ---- V5: team assignment per booking ----
  addColumn('bookings', 'team_member_id', 'INTEGER REFERENCES team_members(id) ON DELETE SET NULL');
  addColumn('bookings', 'team_name_snapshot', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'team_email_snapshot', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'gcal_attendees', "TEXT NOT NULL DEFAULT ''");
  // ---- V5: client-submitted testimonials ----
  addColumn('testimonials', 'photo', "TEXT NOT NULL DEFAULT ''");
  addColumn('testimonials', 'campus', "TEXT NOT NULL DEFAULT ''");
  addColumn('testimonials', 'source', "TEXT NOT NULL DEFAULT 'admin'");
  // ---- V6: pricelist merchandising + package detail page ----
  addColumn('packages', 'is_best_seller', 'INTEGER NOT NULL DEFAULT 0');
  // Label "Recommended" (permintaan pemilik) — independen dari Best Seller.
  addColumn('packages', 'is_recommended', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('packages', 'sold_count', 'INTEGER');
  addColumn('packages', 'sold_label', "TEXT NOT NULL DEFAULT ''");
  addColumn('packages', 'sold_visible', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('packages', 'terms', "TEXT NOT NULL DEFAULT ''");
  addColumn('packages', 'tagline', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'terms_consent', 'INTEGER NOT NULL DEFAULT 0');
  // ---- packages: cover photo for pricelist cards ----
  addColumn('packages', 'image', "TEXT NOT NULL DEFAULT ''");

  /* ---- new tables ------------------------------------------------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS package_categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      description TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS package_durations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id       INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      duration_minutes INTEGER NOT NULL,
      price            INTEGER,
      description      TEXT,
      edited_photos    INTEGER,
      is_active        INTEGER NOT NULL DEFAULT 1,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (package_id, duration_minutes)
    );

    CREATE TABLE IF NOT EXISTS hero_slides (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      title            TEXT NOT NULL DEFAULT '',
      image_url        TEXT NOT NULL,
      alt_text         TEXT NOT NULL DEFAULT '',
      desktop_position TEXT NOT NULL DEFAULT 'center',
      mobile_position  TEXT NOT NULL DEFAULT 'center',
      is_active        INTEGER NOT NULL DEFAULT 1,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Draft/live pairs: public reads live_value, admin edits draft_value.
    CREATE TABLE IF NOT EXISTS site_content (
      key         TEXT PRIMARY KEY,
      draft_value TEXT,
      live_value  TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS website_sections (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      section_key       TEXT NOT NULL UNIQUE,
      title             TEXT NOT NULL DEFAULT '',
      description       TEXT NOT NULL DEFAULT '',
      content           TEXT NOT NULL DEFAULT '',
      layout            TEXT NOT NULL DEFAULT '',
      sort_order        INTEGER NOT NULL DEFAULT 0,
      is_active         INTEGER NOT NULL DEFAULT 1,
      draft_title       TEXT,
      draft_description TEXT,
      draft_content     TEXT,
      draft_layout      TEXT,
      draft_sort_order  INTEGER,
      draft_is_active   INTEGER,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_packages_city     ON packages(city_id);
    CREATE INDEX IF NOT EXISTS idx_packages_category ON packages(category_id);
    CREATE INDEX IF NOT EXISTS idx_durations_package ON package_durations(package_id);
    CREATE INDEX IF NOT EXISTS idx_portfolio_city    ON portfolio(city_id);
    CREATE INDEX IF NOT EXISTS idx_portfolio_cat     ON portfolio(category);
    CREATE INDEX IF NOT EXISTS idx_bookings_status   ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_exp      ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_hero_order        ON hero_slides(sort_order);
    CREATE INDEX IF NOT EXISTS idx_pkg_images        ON package_images(package_id);
    CREATE INDEX IF NOT EXISTS idx_home_stats        ON home_stats(sort_order);
    CREATE INDEX IF NOT EXISTS idx_addons_active     ON addons(is_active);
    CREATE INDEX IF NOT EXISTS idx_articles_pub      ON articles(is_published);
    CREATE INDEX IF NOT EXISTS idx_bookings_date     ON bookings(shooting_date);

    -- V8: package benefits carry their own icon + order (replaces the plain
    -- newline-separated packages.facilities text on the public site).
    CREATE TABLE IF NOT EXISTS package_benefits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      icon       TEXT NOT NULL DEFAULT 'check',
      is_active  INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- V8: extra photos for one portfolio entry (cover stays in portfolio.image).
    CREATE TABLE IF NOT EXISTS portfolio_images (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
      image        TEXT NOT NULL,
      caption      TEXT NOT NULL DEFAULT '',
      is_primary   INTEGER NOT NULL DEFAULT 0,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_benefits_package  ON package_benefits(package_id);
    CREATE INDEX IF NOT EXISTS idx_portfolio_images  ON portfolio_images(portfolio_id);

    -- V10 performance: indexes for the exact ORDER BY used by the public pages and the
    -- admin booking filters (additive only; no data is touched).
    CREATE INDEX IF NOT EXISTS idx_portfolio_active_order
      ON portfolio(is_active, is_featured DESC, sort_order ASC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_portfolio_img_order
      ON portfolio_images(portfolio_id, is_primary DESC, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_bookings_status_date
      ON bookings(status, shooting_date);
  `);

  // ---- V3.1: edited-photo count belongs to each duration, not the package ----
  addColumn('package_durations', 'edited_photos', 'INTEGER');

  // ---- V7: per-section styling + structured content (Google-Sites-like rows) ----
  addColumn('website_sections', 'bg_color', "TEXT NOT NULL DEFAULT ''");
  addColumn('website_sections', 'text_color', "TEXT NOT NULL DEFAULT ''");
  addColumn('website_sections', 'font', "TEXT NOT NULL DEFAULT ''");
  addColumn('website_sections', 'items_json', "TEXT NOT NULL DEFAULT ''");
  addColumn('website_sections', 'draft_bg_color', 'TEXT');
  addColumn('website_sections', 'draft_text_color', 'TEXT');
  addColumn('website_sections', 'draft_font', 'TEXT');
  addColumn('website_sections', 'draft_items_json', 'TEXT');

  // ---- V8: portfolio cover details + per-item city visibility ------------
  // Existing `title` stays as the legacy/internal label; the public cover now uses
  // client_name + client_degree + campus + taken_at.
  addColumn('portfolio', 'client_name', "TEXT NOT NULL DEFAULT ''");
  addColumn('portfolio', 'client_degree', "TEXT NOT NULL DEFAULT ''");
  addColumn('portfolio', 'campus', "TEXT NOT NULL DEFAULT ''");
  addColumn('portfolio', 'show_city', 'INTEGER NOT NULL DEFAULT 0');

  // ---- V8: testimonials show a date on the card --------------------------
  addColumn('testimonials', 'display_date', "TEXT NOT NULL DEFAULT ''");

  /* ---- V9: client photo-selection portal ------------------------------ */
  // One portal per booking. `token` is the only thing that grants a client access —
  // the booking code/ID is never enough on its own. `image` on the photo rows stores
  // the MASTER file, which is never rendered publicly; clients only ever receive a
  // token-scoped, watermarked preview through /selection/:token/photo/:id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS photo_selections (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id    INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      token         TEXT NOT NULL UNIQUE,
      quota         INTEGER NOT NULL DEFAULT 20,
      instructions  TEXT NOT NULL DEFAULT '',
      deadline      TEXT,
      is_open       INTEGER NOT NULL DEFAULT 1,
      status        TEXT NOT NULL DEFAULT 'waiting',
      admin_note    TEXT NOT NULL DEFAULT '',
      first_pick_at TEXT,
      submitted_at  TEXT,
      token_rotated_at TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /* v15 — audit log perubahan akses/deadline Portal Pilih Foto.
       Hanya ditulis oleh aksi ADMIN (buka kembali / tutup / ubah deadline).
       Timestamp disimpan UTC seperti tabel lain; ditampilkan dalam WIB. */
    CREATE TABLE IF NOT EXISTS selection_access_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_id    INTEGER NOT NULL,
      booking_id   INTEGER,
      action       TEXT NOT NULL,                -- reopen | close | deadline
      actor        TEXT NOT NULL DEFAULT '',     -- username admin
      reason       TEXT NOT NULL DEFAULT '',
      old_deadline TEXT,
      new_deadline TEXT,
      result       TEXT NOT NULL DEFAULT 'ok',
      ip           TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sel_access_portal ON selection_access_log(portal_id, id DESC);

    CREATE TABLE IF NOT EXISTS photo_selection_photos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_id  INTEGER NOT NULL REFERENCES photo_selections(id) ON DELETE CASCADE,
      code       TEXT NOT NULL DEFAULT '',
      image      TEXT NOT NULL,
      caption    TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS photo_selection_picks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_id  INTEGER NOT NULL REFERENCES photo_selections(id) ON DELETE CASCADE,
      photo_id   INTEGER NOT NULL REFERENCES photo_selection_photos(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (portal_id, photo_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sel_booking  ON photo_selections(booking_id);
    CREATE INDEX IF NOT EXISTS idx_sel_token    ON photo_selections(token);
    CREATE INDEX IF NOT EXISTS idx_sel_photos   ON photo_selection_photos(portal_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_sel_picks    ON photo_selection_picks(portal_id);
    CREATE INDEX IF NOT EXISTS idx_sel_pick_ph  ON photo_selection_picks(photo_id);
  `);

  // ---- V9.1: Drive folder link shown in the portal --------------------
  // No extra Google permission is involved: the owner either reuses the folder the app
  // already created for this booking, or pastes any Drive folder link. The link is only
  // ever DISPLAYED — the app never reads files from Drive.
  addColumn('photo_selections', 'drive_url', "TEXT NOT NULL DEFAULT ''");   // '' ⇒ fall back to the booking's folder
  addColumn('photo_selections', 'drive_show', 'INTEGER NOT NULL DEFAULT 1'); // show the link to the client

  // ---- V9.2: Google Drive as the photo source -------------------------
  // Photos are streamed server-side from Drive (never copied to app storage unless a
  // watermarked preview cache is generated), and the Drive file id is the identity:
  // a re-sync can never duplicate a photo.
  addColumn('photo_selection_photos', 'source', "TEXT NOT NULL DEFAULT 'upload'"); // 'upload' | 'drive'
  addColumn('photo_selection_photos', 'drive_file_id', 'TEXT');
  addColumn('photo_selection_photos', 'file_name', "TEXT NOT NULL DEFAULT ''");
  addColumn('photo_selection_photos', 'mime_type', "TEXT NOT NULL DEFAULT ''");
  addColumn('photo_selection_photos', 'file_size', 'INTEGER');
  addColumn('photo_selection_photos', 'is_available', 'INTEGER NOT NULL DEFAULT 1');
  // Portal behaviour requested by the owner (all editable in the dashboard).
  addColumn('photo_selections', 'drive_folder_id', 'TEXT');
  addColumn('photo_selections', 'sync_at', 'TEXT');
  addColumn('photo_selections', 'sync_error', "TEXT NOT NULL DEFAULT ''");
  addColumn('photo_selections', 'sync_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('photo_selections', 'allow_download', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('photo_selections', 'require_full_quota', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('photo_selections', 'expires_at', 'TEXT');   // portal auto-inactive after this date
  // V2 (akurasi pilihan): nomor revisi pilihan. Setiap perubahan pilihan menaikkan nilai
  // ini DI DALAM transaksi yang sama, sehingga klien bisa membuang respons yang datang
  // terlambat (stale) — penyebab bug "pilihan baris 1 & 3 hilang".
  addColumn('photo_selections', 'picks_rev', 'INTEGER NOT NULL DEFAULT 0');
  // Picks: snapshot the file identity + order so history survives a re-sync or a rename.
  addColumn('photo_selection_picks', 'position', 'INTEGER');
  addColumn('photo_selection_picks', 'drive_file_id', 'TEXT');
  addColumn('photo_selection_picks', 'file_name', "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sel_photos_drive ON photo_selection_photos(portal_id, drive_file_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sel_photos_drive_uniq
      ON photo_selection_photos(portal_id, drive_file_id)
      WHERE drive_file_id IS NOT NULL;
  `);

  /* ---- V2 (thumbnail retention): antrean pembersihan thumbnail ----------------
   * Hanya menghapus file CACHE (preview-cache) — master Drive/upload tidak pernah disentuh.
   * Ditulis SETELAH submit terverifikasi (transaksi commit), dikerjakan background worker
   * dengan retry + idempotent delete, dan setiap aksi dicatat di selection_access_log.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS selection_cleanup_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_id   INTEGER NOT NULL,
      booking_id  INTEGER,
      photo_id    INTEGER,
      scope       TEXT NOT NULL DEFAULT 'portal',   -- portal | photo
      reason      TEXT NOT NULL DEFAULT 'submitted',-- submitted | expired | idle
      due_at      TEXT NOT NULL DEFAULT (datetime('now')),
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT NOT NULL DEFAULT '',
      files       INTEGER NOT NULL DEFAULT 0,
      bytes       INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      done_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sel_cleanup_status ON selection_cleanup_queue(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_sel_cleanup_portal ON selection_cleanup_queue(portal_id, status);
  `);

  /* ---- V16 (Client Portal): kredensial portal, timeline, hasil final ----------
   * Portal diakses dengan Kode Booking + PIN 4 digit (tanpa akun/email/password).
   * PIN disimpan sebagai hash scrypt — tidak pernah dikembalikan ke client.
   * `legacy_code` menyimpan kode lama supaya link/WhatsApp lama tetap bisa dipakai.
   */
  addColumn('bookings', 'legacy_code', 'TEXT');
  addColumn('bookings', 'portal_pin', 'TEXT');
  addColumn('bookings', 'portal_pin_at', 'TEXT');
  // v15: PIN portal disimpan sebagai HASH (scrypt). Kolom `portal_pin` hanya dipakai
  // untuk kompatibilitas data lama dan dikosongkan setelah hash dibuat.
  addColumn('bookings', 'portal_pin_hash', 'TEXT');
  addColumn('bookings', 'final_url', 'TEXT');
  addColumn('bookings', 'final_at', 'TEXT');
  // Subfolder Drive 01/02/03 (blueprint). NULL = belum dibuat (folder lama).
  addColumn('bookings', 'drive_raw_id', 'TEXT');
  addColumn('bookings', 'drive_sortir_id', 'TEXT');
  addColumn('bookings', 'drive_edit_id', 'TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_legacy_code
      ON bookings(legacy_code) WHERE legacy_code IS NOT NULL;

    /* Sesi portal: cookie httpOnly berisi id acak; data sesi di server. */
    CREATE TABLE IF NOT EXISTS portal_sessions (
      id         TEXT PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      ip         TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_booking ON portal_sessions(booking_id);

    /* Rate limit percobaan masuk (kode + PIN). Dibersihkan otomatis saat dipakai. */
    CREATE TABLE IF NOT EXISTS portal_attempts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ip         TEXT NOT NULL DEFAULT '',
      code       TEXT NOT NULL DEFAULT '',
      ok         INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_portal_attempts_ip ON portal_attempts(ip, created_at);

    /* Timeline order: satu baris per tahap yang SUDAH tercapai (idempoten).
       Tahap yang belum tercapai tidak pernah disimpan → tidak pernah tampil. */
    CREATE TABLE IF NOT EXISTS booking_timeline (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      stage       TEXT NOT NULL,
      actor       TEXT NOT NULL DEFAULT 'sistem',
      note        TEXT NOT NULL DEFAULT '',
      happened_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (booking_id, stage)
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_booking ON booking_timeline(booking_id, happened_at);
  `);

  /* ---- V14 (Tahap 7): booking team, reschedule history, manual full booking ----
   * `booking_team` replaces the single `bookings.team_member_id` for NEW assignments.
   * The legacy column is kept and mirrored to the FIRST member so old code/exports/tests
   * keep working. Name/email/role are snapshotted per row: renaming or deleting a crew
   * member later must not rewrite the history of an event that already happened.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_team (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      member_id  INTEGER,
      name       TEXT NOT NULL DEFAULT '',
      email      TEXT NOT NULL DEFAULT '',
      role       TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (booking_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS idx_booking_team ON booking_team(booking_id, sort_order);

    /* Every reschedule keeps its own row, so the old schedule is never lost. */
    CREATE TABLE IF NOT EXISTS booking_reschedules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id    INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      old_date      TEXT NOT NULL DEFAULT '',
      old_time      TEXT NOT NULL DEFAULT '',
      old_location  TEXT NOT NULL DEFAULT '',
      new_date      TEXT NOT NULL DEFAULT '',
      new_time      TEXT NOT NULL DEFAULT '',
      new_location  TEXT NOT NULL DEFAULT '',
      reason        TEXT NOT NULL DEFAULT '',
      actor         TEXT NOT NULL DEFAULT '',
      gcal_status   TEXT NOT NULL DEFAULT '',
      gcal_error    TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reschedules_booking ON booking_reschedules(booking_id, id DESC);
  `);

  // Revisi: admin bisa menandai foto "Highlight" (tab Highlight di portal klien).
  addColumn('photo_selection_photos', 'is_highlight', 'INTEGER NOT NULL DEFAULT 0');
  // Nomor tampilan (DLY0001) untuk file yang namanya bukan pola DLY.
  addColumn('photo_selection_photos', 'display_no', 'INTEGER');

  // Manual "Full Booking" flag, deliberately SEPARATE from is_available:
  //   is_available = 0 → Ditutup (highest priority, set by the owner)
  //   full_booking = 1 → Full Booking manual (even when capacity is not reached)
  addColumn('availability_overrides', 'full_booking', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('bookings', 'confirmed_at', 'TEXT');
  addColumn('bookings', 'gcal_event_url', 'TEXT');
  addColumn('bookings', 'reschedule_count', 'INTEGER NOT NULL DEFAULT 0');

  // ---- V13 (Tahap 6): public client page for each portfolio entry ----------
  // `slug` gives every portfolio a stable, readable URL (/portfolio/vieke-melani).
  // `session_time` is the shoot time shown in the client page header. Both additive.
  addColumn('portfolio', 'slug', 'TEXT');
  addColumn('portfolio', 'session_time', "TEXT NOT NULL DEFAULT ''");
  // Revisi 2 (05): satu label "Paket" per karya portfolio, diisi admin di form portfolio.
  // Filter Paket di halaman Gallery dibangun dari nilai yang BENAR-BENAR dipakai, jadi
  // tidak ada daftar paket hardcode dan tidak ada karya yang "hilang" dari filter.
  addColumn('portfolio', 'package_label', "TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_slug ON portfolio(slug) WHERE slug IS NOT NULL');

  // ---- V11 (Tahap 3): per-booking payment records + activity log -------------
  // A booking's paid amount is DERIVED from these rows (never stored twice), so an old
  // booking with no payments simply reads as "Belum ada pembayaran tercatat".
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_payments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      amount     INTEGER NOT NULL,
      paid_at    TEXT NOT NULL,
      method     TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS booking_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL DEFAULT 'status',
      from_status TEXT NOT NULL DEFAULT '',
      to_status   TEXT NOT NULL DEFAULT '',
      actor       TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payments_booking ON booking_payments(booking_id, paid_at);
    CREATE INDEX IF NOT EXISTS idx_events_booking   ON booking_events(booking_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_recent    ON booking_events(id DESC);
  `);

  addColumn('booking_payments', 'kind', "TEXT NOT NULL DEFAULT 'manual'");

  /* ---- V12 (Tahap 5): editing queue ---------------------------------------
   * Three stages only (queued → editing → done), one ACTIVE job per booking
   * (enforced by a partial unique index, so history rows stay possible).
   * `photo_count` is a snapshot of how many photos the client picked when the job
   * entered the queue — the queue never rewrites the client's selection.
   * `note` is internal and must never reach the client portal.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS editing_jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      portal_id   INTEGER REFERENCES photo_selections(id) ON DELETE SET NULL,
      status      TEXT NOT NULL DEFAULT 'queued',
      editor_id   INTEGER,
      editor_name TEXT NOT NULL DEFAULT '',
      due_at      TEXT,
      note        TEXT NOT NULL DEFAULT '',
      photo_count INTEGER NOT NULL DEFAULT 0,
      started_at  TEXT,
      finished_at TEXT,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_editing_status  ON editing_jobs(status, position, id);
    CREATE INDEX IF NOT EXISTS idx_editing_booking ON editing_jobs(booking_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_editing_active
      ON editing_jobs(booking_id) WHERE status IN ('queued', 'editing');
  `);

  /* ---- V13 (Tahap 6): Web Push ------------------------------------------
   * One row per browser/device. `endpoint` is UNIQUE, which is what prevents the same
   * device from being stored (and therefore notified) twice when it re-subscribes.
   * Rows are deactivated (never silently kept) as soon as the push service answers
   * 404/410 — that endpoint no longer exists.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint    TEXT NOT NULL UNIQUE,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      label       TEXT NOT NULL DEFAULT '',
      platform    TEXT NOT NULL DEFAULT '',
      user_agent  TEXT NOT NULL DEFAULT '',
      is_active   INTEGER NOT NULL DEFAULT 1,
      failures    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT NOT NULL DEFAULT '',
      last_ok_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /* V17: penerima dipisah per ROLE. Admin = booking_id NULL.
     * Client = booking_id miliknya sendiri (didaftarkan dari Client Portal).
     * fg/editor disiapkan untuk Team Portal (belum mengirim). */
    CREATE TABLE IF NOT EXISTS push_deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT '',
      role         TEXT NOT NULL DEFAULT 'admin',
      booking_id   INTEGER,
      subscription_id INTEGER,
      device       TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',  -- sent | failed | gone
      http_status  INTEGER NOT NULL DEFAULT 0,
      reason       TEXT NOT NULL DEFAULT '',
      retry        INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /* Every push that was actually attempted gets one row keyed by its dedupe key
     * (e.g. "job:42:2026-11-30"), so the hourly scheduler can never notify twice for
     * the same event, across restarts as well. */
    CREATE TABLE IF NOT EXISTS push_log (
      dedupe_key TEXT PRIMARY KEY,
      kind       TEXT NOT NULL DEFAULT '',
      ok         INTEGER NOT NULL DEFAULT 0,
      sent       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_log_created ON push_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_push_active ON push_subscriptions(is_active);
    CREATE INDEX IF NOT EXISTS idx_push_deliveries_event ON push_deliveries(event_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_push_deliveries_created ON push_deliveries(created_at DESC);
  `);

  // Kolom role/booking_id untuk tabel yang mungkin sudah dibuat versi sebelumnya.
  addColumn('push_subscriptions', 'role', "TEXT NOT NULL DEFAULT 'admin'");
  addColumn('push_subscriptions', 'booking_id', 'INTEGER');
  addColumn('push_log', 'event_id', 'TEXT');

  /* ---- settings --------------------------------------------------- */
  const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  // Notification centre (Tahap 4): everything newer than this timestamp is "unread".
  setDefault.run('notifications_seen_at', '');
  // Web Push (Tahap 6): VAPID keys + which events are pushed. Keys are generated on the
  // first boot (src/push.js) because they must be a matching pair.
  setDefault.run('push_vapid_public', '');
  setDefault.run('push_vapid_private', '');
  setDefault.run('push_vapid_subject', 'mailto:dlyvisualcreative@gmail.com');
  setDefault.run('push_enabled', '1');
  setDefault.run('push_type_booking', '1');
  setDefault.run('push_type_payment', '1');
  setDefault.run('push_type_selection', '1');
  setDefault.run('push_type_deadline', '1');
  setDefault.run('push_type_job', '1');
  setDefault.run('push_type_editing', '0');
  // Notifikasi CLIENT (daftar disepakati — jangan menambah jenis lain tanpa persetujuan).
  setDefault.run('push_client_confirmed', '1');
  setDefault.run('push_client_photos', '1');
  setDefault.run('push_client_deadline', '1');
  setDefault.run('push_client_final', '1');
  setDefault.run('push_client_reschedule', '1');
  // Revisi 2: pembayaran/DP terkonfirmasi juga dikirim ke client (default aktif).
  setDefault.run('push_client_payment', '1');
  setDefault.run('push_last_run_at', '');
  // Extra Time (revisi): harga diatur admin kapan saja. 0 = belum diatur → tombol
  // pengajuan dinonaktifkan (tidak ada nominal yang dikarang sistem).
  setDefault.run('extra_time_30_price', '0');
  setDefault.run('extra_time_60_price', '0');
  setDefault.run('whatsapp_number', '6289629619590');
  setDefault.run('instagram_handle', 'dly.graduation');
  setDefault.run('brand_name', 'DLY Graduation');
  setDefault.run('brand_tagline', 'Your Graduation, Your Story.');
  setDefault.run('planned_domain', 'dlygraduation.com');
  setDefault.run('domain_note', '');
  setDefault.run('booking_lead_days', '2');
  setDefault.run('booking_advance_days', '180');
  setDefault.run('booking_closed_weekdays', '');
  setDefault.run('booking_daily_capacity', '0');

  // Google Calendar — off until the owner saves credentials and connects.
  setDefault.run('gcal_enabled', '0');
  setDefault.run('gcal_client_id', '');
  setDefault.run('gcal_client_secret', '');
  setDefault.run('gcal_refresh_token', '');
  setDefault.run('gcal_calendar_id', 'primary');
  setDefault.run('gcal_default_time', '09:00');
  setDefault.run('gcal_duration_fallback', '60');
  setDefault.run('gcal_timezone', 'Asia/Jakarta');
  setDefault.run('gcal_connected_at', '');
  setDefault.run('gcal_account', '');
  setDefault.run('gcal_last_error', '');
  setDefault.run('gcal_team', '');
  setDefault.run('gcal_drive_enabled', '1');
  setDefault.run('gcal_drive_scopes', '0');
  // Optional SECOND Google authorization, dedicated to Drive (owner may use another account).
  setDefault.run('gdrive_client_id', '');
  setDefault.run('gdrive_client_secret', '');
  setDefault.run('gdrive_refresh_token', '');
  setDefault.run('gdrive_connected_at', '');
  setDefault.run('gdrive_account', '');

  // Nav/page visibility (owner can show/hide without deleting anything)
  setDefault.run('page_artikel_visible', '0');
  setDefault.run('page_faq_visible', '0');
  setDefault.run('page_tentang_visible', '0');
  setDefault.run('page_ulasan_visible', '1');
  setDefault.run('page_gallery_visible', '1');
  setDefault.run('page_caraorder_visible', '1');
  setDefault.run('page_tnc_visible', '1');

  // V8: portfolio cover — the city stays stored & filterable but is hidden on the
  // public cover unless the owner turns this on.
  setDefault.run('portfolio_show_city', '0');

  // V9: client photo-selection portal defaults (editable in the dashboard).
  setDefault.run('wa_selection_template', '');   // empty ⇒ util.DEFAULT_SELECTION_TEMPLATE
  // V11 (Tahap 3): a booking counts as "Baru" for this many days (dashboard + filter).
  setDefault.run('booking_new_days', '7');
  setDefault.run('selection_default_instructions',
    'Silakan pilih foto favorit Kakak dari hasil sesi pemotretan di bawah ini.\n'
    + 'Klik foto untuk melihat lebih besar, lalu tekan tombol "Pilih" pada foto yang Kakak suka.\n'
    + 'Jumlah foto yang bisa dipilih mengikuti kuota paket Kakak.');
  setDefault.run('selection_watermark', '1');
  // ---- V9.2 portal + Drive defaults (all editable in the dashboard) ----
  setDefault.run('gdrive_reader_client_id', '');      // '' ⇒ fall back to the Drive/Calendar client
  setDefault.run('gdrive_reader_client_secret', '');
  setDefault.run('gdrive_reader_refresh_token', '');  // set by the read-only consent flow
  setDefault.run('gdrive_reader_account', '');
  setDefault.run('gdrive_reader_connected_at', '');
  setDefault.run('gdrive_reader_last_error', '');
  setDefault.run('gdrive_api_key', '');               // fallback: read public/shared folders
  setDefault.run('selection_default_quota', '40');
  setDefault.run('selection_default_days', '14');     // default deadline = today + N days
  setDefault.run('selection_allow_download', '0');
  setDefault.run('selection_require_full_quota', '0');
  setDefault.run('selection_portal_ttl_days', '0');   // 0 = portal never expires by itself
  setDefault.run('selection_brand_name', '');         // '' ⇒ brand_name
  setDefault.run('selection_brand_note', 'Pilih foto favoritmu untuk kami edit.');
  setDefault.run('selection_portal_logo', '');        // '' ⇒ header logo
  setDefault.run('wa_confirm_template', '');          // Konfirmasi Booking & DP
  setDefault.run('wa_portal_template', '');           // Kirim Link Portal Seleksi Foto

  // Payment details used by the admin's "Chat Klien" WhatsApp template
  setDefault.run('payment_bank_name', '');
  setDefault.run('payment_account_number', '');
  setDefault.run('payment_account_holder', '');
  setDefault.run('payment_dp_amount', '100000');
  setDefault.run('payment_notes', '');

  // Private testimonial form (never linked from the public navigation)
  setDefault.run('testimonial_form_token', '');
  setDefault.run('testimonial_auto_approve', '0');
  setDefault.run('testimonial_intro', 'Ceritakan pengalaman sesi foto Anda. Testimoni yang Anda kirim akan tampil di website DLY Graduation.');
  setDefault.run('testimonial_form_notice', '');

  // ---- V6 brand identity (logo variants + studio description) ----
  setDefault.run('brand_description', 'Professional Graduation Photography');
  setDefault.run('brand_email', '');
  setDefault.run('logo_header_light', '');   // dipakai di header transparan (di atas foto)
  setDefault.run('logo_header_dark', '');    // dipakai di header solid/putih
  setDefault.run('logo_footer_light', '');   // dipakai di footer gelap
  setDefault.run('logo_footer_dark', '');    // dipakai di footer terang
  setDefault.run('favicon_custom', '');      // ikon tab browser (PNG/ICO/SVG)
  setDefault.run('header_show_identity', '1'); // 1 = logo + nama studio + deskripsi
  setDefault.run('header_sticky', '1');

  // ---- V6 typography (max 3 families) ----
  setDefault.run('font_heading', 'Cormorant Garamond');
  setDefault.run('font_body', 'Inter');
  setDefault.run('font_ui', '');             // opsional; kosong = ikut font body
  setDefault.run('font_scale', '100');       // 90–115 (%)
  setDefault.run('font_heading_weight', '500');

  // ---- V6 WhatsApp templates (plain text by default for compatibility) ----
  setDefault.run('wa_booking_use_emoji', '0');
  setDefault.run('wa_admin_template', '');
  setDefault.run('home_stats_visible', '1');

  /* ---- admin ------------------------------------------------------ */
  if (db.prepare('SELECT COUNT(*) AS n FROM admins').get().n === 0) {
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .run(DEFAULT_ADMIN_USER, hashPassword(DEFAULT_ADMIN_PASSWORD));
  }

  /* ---- CMS content: seed defaults (live == draft so nothing changes) */
  const contentCount = db.prepare('SELECT COUNT(*) AS n FROM site_content').get().n;
  if (contentCount === 0) {
    const ins = db.prepare(`INSERT INTO site_content (key, draft_value, live_value)
                            VALUES (?, ?, ?)`);
    const defaults = schema.defaultContentMap();
    Object.entries(defaults).forEach(([k, v]) => ins.run(k, v, v));
  } else {
    // Add any newly introduced keys without touching edited values.
    const ins = db.prepare('INSERT OR IGNORE INTO site_content (key, draft_value, live_value) VALUES (?, ?, ?)');
    const defaults = schema.defaultContentMap();
    Object.entries(defaults).forEach(([k, v]) => ins.run(k, v, v));
  }

  /* ---- website sections registry ---------------------------------- */
  const secIns = db.prepare(`INSERT OR IGNORE INTO website_sections
      (section_key, title, description, layout, sort_order, is_active,
       draft_title, draft_description, draft_content, draft_layout, draft_sort_order, draft_is_active)
      VALUES (@section_key, @title, @description, @layout, @sort_order, @is_active,
       @title, @description, '', @layout, @sort_order, @is_active)`);
  schema.SECTION_DEFAULTS.forEach((s) => secIns.run(s));

  /* ---- first city ------------------------------------------------ */
  if (db.prepare('SELECT COUNT(*) AS n FROM cities').get().n === 0) {
    db.prepare(`INSERT INTO cities (name, slug, description, cover_image, is_active, sort_order, updated_at)
                VALUES (?, ?, ?, ?, 1, 0, datetime('now'))`).run(
      'Bandung',
      'bandung',
      'Bandung dan sekitarnya — kampus, taman kota, hingga studio indoor. Tim kami terbiasa memotret wisuda di area ITB, Unpad, Unpar, Telkom University, dan lokasi favorit lainnya di kota ini.',
      '/ph/city-bandung.svg'
    );
  }

  /* ---- package categories ---------------------------------------- */
  const categorySeed = [
    ['Individual Package', 'individual', 'Sesi foto wisuda untuk satu wisudawan.', 0],
    ['Couple Package', 'couple', 'Sesi foto wisuda berdua — pasangan, sahabat, atau kakak-adik.', 1],
    ['Group Package', 'group', 'Sesi foto wisuda kelompok atau satu angkatan.', 2]
  ];
  const catIns = db.prepare(`INSERT OR IGNORE INTO package_categories (name, slug, description, sort_order)
                             VALUES (?, ?, ?, ?)`);
  categorySeed.forEach((c) => catIns.run(c[0], c[1], c[2], c[3]));

  const catBySlug = (slug) => db.prepare('SELECT * FROM package_categories WHERE slug = ?').get(slug);
  const individual = catBySlug('individual');
  const couple = catBySlug('couple');
  const group = catBySlug('group');

  /* ---- migrate legacy packages into the Individual category ------ */
  const legacyNames = { 'Paket A': 'Basic', 'Paket B': 'Standard', 'Paket C': 'Premium' };
  const legacySlugs = { 'paket-a': 'individual-basic', 'paket-b': 'individual-standard', 'paket-c': 'individual-premium' };
  db.prepare('SELECT * FROM packages WHERE category_id IS NULL ORDER BY id').all().forEach((p, i) => {
    const name = legacyNames[p.name] || p.name;
    const slug = legacySlugs[p.slug] || p.slug;
    db.prepare('UPDATE packages SET category_id = ?, name = ?, slug = ? WHERE id = ?')
      .run((individual || {}).id || null, name, slug, p.id);
  });

  /* ---- ensure Basic / Standard / Premium per category ------------ */
  const bandung = db.prepare('SELECT * FROM cities WHERE slug = ?').get('bandung');
  const tiers = [
    { name: 'Basic', slug: 'basic', label: '', photos: { individual: 10, couple: 15, group: 20 },
      desc: 'Sesi ringkas untuk kebutuhan foto formal dan personal branding.',
      facilities: '1 lokasi pemotretan dalam kota\nSesi foto sesuai kategori\nEditing warna & retouch dasar\nSemua foto hasil sesi dikirim via Google Drive\nKonsultasi konsep sebelum sesi',
      durations: [60, 90], sort: 0 },
    { name: 'Standard', slug: 'standard', label: 'Paling dipilih', photos: { individual: 20, couple: 25, group: 30 },
      desc: 'Sesi lebih leluasa dengan waktu berpindah lokasi dan hasil foto lebih banyak.',
      facilities: 'Hingga 2 lokasi pemotretan dalam kota\nSesi foto sesuai kategori\nEditing warna & retouch dasar\nSemua foto hasil sesi dikirim via Google Drive\nKonsultasi konsep sebelum sesi',
      durations: [60, 90, 120], sort: 1 },
    { name: 'Premium', slug: 'premium', label: 'Terlengkap', photos: { individual: 30, couple: 35, group: 45 },
      desc: 'Paket terlengkap dengan durasi panjang, lokasi lebih banyak, dan hasil edit maksimal.',
      facilities: 'Hingga 3 lokasi pemotretan dalam kota\nSesi foto sesuai kategori\nEditing warna & retouch lanjutan\nSemua foto hasil sesi dikirim via Google Drive\nPrioritas jadwal akhir pekan',
      durations: [90, 120], sort: 2 }
  ];

  // Only seed the legacy tiers on a brand-new database. Once the V3 collapse has run,
  // re-running this would silently resurrect Basic/Standard/Premium on every restart.
  const tiersAlreadyMigrated = db.prepare("SELECT value FROM settings WHERE key = 'migration.v3_packages'").get();
  if (bandung && !tiersAlreadyMigrated) {
    [individual, couple, group].forEach((cat) => {
      if (!cat) return;
      tiers.forEach((t) => {
        const pkgSlug = `${cat.slug}-${t.slug}`;
        const existing = db.prepare('SELECT * FROM packages WHERE city_id = ? AND slug = ?').get(bandung.id, pkgSlug);
        let pkgId;
        if (!existing) {
          const info = db.prepare(`INSERT INTO packages
            (city_id, category_id, name, slug, description, edited_photos, facilities, is_active, sort_order, label)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
            bandung.id, cat.id, t.name, pkgSlug, t.desc, t.photos[cat.slug] || 10,
            t.facilities, t.sort, t.label
          );
          pkgId = Number(info.lastInsertRowid);
        } else {
          pkgId = existing.id;
          if (!existing.category_id) {
            db.prepare('UPDATE packages SET category_id = ? WHERE id = ?').run(cat.id, existing.id);
          }
        }

        // Seed durations for packages that do not have any yet.
        const durCount = db.prepare('SELECT COUNT(*) AS n FROM package_durations WHERE package_id = ?').get(pkgId).n;
        if (durCount === 0) {
          const legacy = db.prepare('SELECT price_60, price_90, price_120 FROM packages WHERE id = ?').get(pkgId) || {};
          const ins = db.prepare(`INSERT OR IGNORE INTO package_durations
            (package_id, duration_minutes, price, is_active, sort_order) VALUES (?, ?, ?, 1, ?)`);
          t.durations.forEach((d, idx) => {
            const legacyPrice = legacy['price_' + d] || null;
            ins.run(pkgId, d, legacyPrice, idx);
          });
        }
      });
    });
  }

  /* ---- portfolio: keep existing rows, fill new columns ----------- */
  db.prepare('UPDATE portfolio SET image_url = COALESCE(image_url, image) WHERE image_url IS NULL').run();
  db.prepare("UPDATE portfolio SET alt_text = title WHERE alt_text = ''").run();
  db.prepare("UPDATE portfolio SET updated_at = datetime('now') WHERE updated_at = ''").run();
  db.prepare("UPDATE cities SET updated_at = datetime('now') WHERE updated_at = ''").run();

  const pfCount = db.prepare('SELECT COUNT(*) AS n FROM portfolio').get().n;
  if (pfCount === 0 && bandung) {
    const insPf = db.prepare(`INSERT INTO portfolio
      (title, image, image_url, alt_text, category, city_id, description, taken_at, is_featured, is_active, is_placeholder, sort_order, collection)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'portfolio')`);
    const items = [
      ['Golden Hour di Kampus', '/ph/portfolio-portrait-1.svg', 'individual', 'Contoh layout foto individu dengan cahaya sore di area kampus.', '2025-08-16', 1, 0],
      ['Toga & Senyum', '/ph/portfolio-portrait-2.svg', 'individual', 'Contoh layout portrait close-up dengan nuansa studio minimalis.', '2025-09-02', 1, 1],
      ['Dua Wisudawan', '/ph/portfolio-couple.svg', 'couple', 'Contoh layout foto berdua dengan komposisi simetris.', '2025-07-21', 1, 2],
      ['Sahabat Satu Angkatan', '/ph/portfolio-group.svg', 'group', 'Contoh layout foto kelompok dengan pose santai.', '2025-06-14', 1, 3],
      ['Lorong Kampus', '/ph/portfolio-campus.svg', 'individual', 'Contoh layout foto editorial di koridor kampus.', '2025-05-30', 0, 4],
      ['Selebrasi', '/ph/portfolio-cap.svg', 'group', 'Contoh layout momen lempar toga.', '2025-04-12', 0, 5],
      ['Graduation Event', '/ph/portfolio-event.svg', 'event', 'Contoh layout liputan acara wisuda (graduation event).', '2025-03-08', 0, 6]
    ];
    items.forEach((it) => insPf.run(
      it[0], it[1], it[1], it[0] + ' — ' + it[2] + ' graduation photography',
      it[2], bandung.id, it[3], it[4], it[5], it[6]
    ));
  }

  // Ensure the Graduation Event filter has at least one sample photo.
  const hasEvent = db.prepare("SELECT COUNT(*) AS n FROM portfolio WHERE category = 'event'").get().n;
  if (!hasEvent && bandung) {
    db.prepare(`INSERT INTO portfolio
      (title, image, image_url, alt_text, category, city_id, description, taken_at,
       is_featured, is_active, is_placeholder, sort_order, collection)
      VALUES (?, ?, ?, ?, 'event', ?, ?, ?, 0, 1, 1, 90, 'portfolio')`).run(
      'Graduation Event', '/ph/portfolio-event.svg', '/ph/portfolio-event.svg',
      'Contoh layout liputan acara wisuda (graduation event)', bandung.id,
      'Contoh layout liputan acara wisuda (graduation event).', '2025-03-08'
    );
  }

  /* ---- hero slides ----------------------------------------------- */
  if (db.prepare('SELECT COUNT(*) AS n FROM hero_slides').get().n === 0) {
    const insHero = db.prepare(`INSERT INTO hero_slides
      (title, image_url, alt_text, desktop_position, mobile_position, is_active, sort_order)
      VALUES (?, ?, ?, ?, ?, 1, ?)`);
    const slides = [
      ['Golden Hour', '/ph/hero-1.svg', 'Siluet wisudawan dengan toga saat golden hour di area kampus', 'center', 'center'],
      ['Toga Toss', '/ph/hero-2.svg', 'Momen melempar toga bersama satu angkatan', 'center', 'center'],
      ['Campus Walk', '/ph/hero-3.svg', 'Wisudawan berjalan di koridor kampus', 'center', 'center'],
      ['Portrait Studio', '/ph/hero-4.svg', 'Portrait wisudawan dengan nuansa studio', 'center', 'center']
    ];
    slides.forEach((s, i) => insHero.run(s[0], s[1], s[2], s[3], s[4], i));
  }

  /* ---- testimonials (clearly flagged as contoh) ------------------ */
  if (db.prepare('SELECT COUNT(*) AS n FROM testimonials').get().n === 0) {
    const insT = db.prepare(`INSERT INTO testimonials
      (client_name, client_meta, quote, rating, is_active, is_placeholder, sort_order)
      VALUES (?, ?, ?, 5, 1, 1, ?)`);
    insT.run('Contoh Testimoni', 'Wisudawan — Bandung',
      'Tulis testimoni klien di sini melalui dashboard admin. Kolom ini hanya contoh tampilan, bukan ulasan asli.', 0);
    insT.run('Contoh Testimoni', 'Wisudawan — Bandung',
      'Setiap testimoni dapat diaktifkan atau dinonaktifkan, sehingga hanya ulasan asli yang ingin ditampilkan yang muncul di website.', 1);
    insT.run('Contoh Testimoni', 'Wisudawan — Bandung',
      'Ganti teks ini dengan pengalaman klien Anda setelah sesi pemotretan selesai.', 2);
  }


  /* ================================================================ */
  /* V3 migration 1 — collapse tier packages into one package per     */
  /* category. The owner asked to drop Basic/Standard/Premium; only   */
  /* the package names are removed, every duration/price row is kept. */
  /* Bookings are re-pointed to the surviving package so no history   */
  /* is lost. Runs once (guarded by a settings flag).                 */
  /* ================================================================ */
  const v3Flag = db.prepare("SELECT value FROM settings WHERE key = 'migration.v3_packages'").get();
  if (!v3Flag) {
    const groups = db.prepare(`SELECT city_id, category_id FROM packages
                               WHERE category_id IS NOT NULL
                               GROUP BY city_id, category_id`).all();
    groups.forEach((g) => {
      const siblings = db.prepare(`SELECT * FROM packages WHERE city_id = ? AND category_id = ?
                                   ORDER BY id`).all(g.city_id, g.category_id);
      if (!siblings.length) return;

      // Survivor: the package with the most durations (ties → lowest id).
      let survivor = siblings[0];
      let best = -1;
      siblings.forEach((p) => {
        const n = db.prepare('SELECT COUNT(*) AS n FROM package_durations WHERE package_id = ?').get(p.id).n;
        if (n > best) { best = n; survivor = p; }
      });

      const insertDur = db.prepare(`INSERT OR IGNORE INTO package_durations
        (package_id, duration_minutes, price, description, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const updatePrice = db.prepare(`UPDATE package_durations SET price = ?
                                      WHERE package_id = ? AND duration_minutes = ? AND (price IS NULL OR price <= 0)`);

      siblings.forEach((p) => {
        if (p.id === survivor.id) return;
        db.prepare('SELECT * FROM package_durations WHERE package_id = ? ORDER BY sort_order, duration_minutes').all(p.id)
          .forEach((d, i) => {
            const existing = db.prepare(`SELECT * FROM package_durations
                                         WHERE package_id = ? AND duration_minutes = ?`).get(survivor.id, d.duration_minutes);
            if (!existing) {
              insertDur.run(survivor.id, d.duration_minutes, d.price, d.description, d.is_active, i);
            } else if (d.price && (!existing.price || existing.price <= 0)) {
              updatePrice.run(d.price, survivor.id, d.duration_minutes);
            }
          });
        // keep history pointing at a package that still exists
        db.prepare('UPDATE bookings SET package_id = ? WHERE package_id = ?').run(survivor.id, p.id);
        // only drop the tier when nothing references it any more
        const used = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE package_id = ?').get(p.id).n;
        if (used === 0) db.prepare('DELETE FROM packages WHERE id = ?').run(p.id);
        else db.prepare('UPDATE packages SET is_active = 0 WHERE id = ?').run(p.id);
      });

      // Name the survivor after its category (no invented tier names).
      const cat = db.prepare('SELECT * FROM package_categories WHERE id = ?').get(g.category_id);
      if (cat) {
        const baseSlug = cat.slug;
        let slug = baseSlug;
        let n = 2;
        while (db.prepare('SELECT id FROM packages WHERE city_id = ? AND slug = ? AND id <> ?')
          .get(g.city_id, slug, survivor.id)) {
          slug = `${baseSlug}-${n++}`;
        }
        // Merge facilities/photos from siblings so nothing configured is lost.
        let facilities = survivor.facilities || '';
        let photos = survivor.edited_photos;
        let description = survivor.description || '';
        siblings.forEach((p) => {
          if (p.id === survivor.id) return;
          if (!facilities && p.facilities) facilities = p.facilities;
          if ((photos == null) && p.edited_photos != null) photos = p.edited_photos;
          if (!description && p.description) description = p.description;
        });
        db.prepare(`UPDATE packages SET name = ?, slug = ?, facilities = ?, edited_photos = ?,
                    description = ?, label = '', updated_at = datetime('now') WHERE id = ?`)
          .run(cat.name, slug, facilities, photos, description, survivor.id);
      }
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v3_packages', 'done')").run();
  }

  /* ================================================================ */
  /* V3 migration 2 — homepage sections: add Introduction & Services, */
  /* then lay them out in the order the owner specified.              */
  /* ================================================================ */
  const sectionSeedV3 = [
    { section_key: 'intro', title: 'Introduction', description: '', layout: 'split', sort_order: 1, is_active: 1 },
    { section_key: 'services', title: 'Our Services', description: '', layout: 'grid-4', sort_order: 4, is_active: 1 }
  ];
  sectionSeedV3.forEach((sec) => {
    const exists = db.prepare('SELECT id FROM website_sections WHERE section_key = ?').get(sec.section_key);
    if (!exists) {
      db.prepare(`INSERT INTO website_sections
        (section_key, title, description, layout, sort_order, is_active,
         draft_title, draft_description, draft_content, draft_layout, draft_sort_order, draft_is_active)
        VALUES (@section_key, @title, @description, @layout, @sort_order, @is_active,
         @title, @description, '', @layout, @sort_order, @is_active)`).run(sec);
    }
  });

  const v3Order = ['hero', 'intro', 'featured', 'carousel', 'services', 'advantages',
    'packages', 'process', 'testimonials', 'cta'];
  const orderFlag = db.prepare("SELECT value FROM settings WHERE key = 'migration.v3_sections'").get();
  if (!orderFlag) {
    v3Order.forEach((key, idx) => {
      db.prepare('UPDATE website_sections SET sort_order = ?, draft_sort_order = ? WHERE section_key = ?')
        .run(idx, idx, key);
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v3_sections', 'done')").run();
  }

  /* ================================================================ */
  /* V3 — FAQ entries describing how the system actually behaves.     */
  /* The owner can edit/delete these in the dashboard.                */
  /* ================================================================ */
  if (db.prepare('SELECT COUNT(*) AS n FROM faqs').get().n === 0) {
    const insFaq = db.prepare('INSERT INTO faqs (question, answer, sort_order, is_active) VALUES (?, ?, ?, 1)');
    [
      ['Bagaimana cara melakukan booking?',
        'Pilih kota layanan, kategori, dan durasi pada halaman pricelist atau booking. Lengkapi data diri, pilih tanggal dan lokasi, lalu kirim permintaan booking. Detail booking Anda akan diteruskan ke WhatsApp kami untuk dikonfirmasi admin.'],
      ['Apakah jadwal langsung terkunci setelah booking?',
        'Belum. Permintaan booking tercatat dengan status Pending. Admin akan menghubungi Anda melalui WhatsApp untuk memastikan ketersediaan jadwal sebelum status berubah menjadi Confirmed.'],
      ['Mengapa harga sebuah durasi tertulis “Harga belum tersedia”?',
        'Harga resmi diisi langsung oleh admin untuk setiap kombinasi paket dan durasi. Selama admin belum mengisi harga tersebut, booking untuk kombinasi itu tidak dapat diproses agar tidak terjadi kesalahpahaman biaya.'],
      ['Apakah bisa menambah add-on saat booking?',
        'Ya, jika admin mengaktifkan add-on untuk kategori layanan tersebut. Add-on yang tersedia muncul pada langkah pertama form booking beserta harganya, dan total estimasi diperbarui otomatis.'],
      ['Bagaimana cara mengubah jadwal yang sudah diajukan?',
        'Hubungi admin melalui WhatsApp dengan menyertakan kode booking Anda. Perubahan jadwal mengikuti ketersediaan tanggal pada kalender booking.']
    ].forEach((f, i) => insFaq.run(f[0], f[1], i));
  }

  /* ================================================================ */
  /* V3 — add-on structure (inactive + no price until the owner sets  */
  /* a real price and enables it). No invented pricing.               */
  /* ================================================================ */
  if (db.prepare('SELECT COUNT(*) AS n FROM addons').get().n === 0) {
    const insAddon = db.prepare(`INSERT INTO addons
      (name, slug, description, price, applies_to, is_active, sort_order)
      VALUES (?, ?, ?, NULL, 'all', 0, ?)`);
    [
      ['Extra Edit', 'extra-edit', 'Tambahan jumlah foto yang diedit di luar paket.', 0],
      ['Extra 30 Minutes', 'extra-30-minutes', 'Perpanjangan durasi sesi selama 30 menit.', 1],
      ['Fast Edit', 'fast-edit', 'Prioritas pengerjaan hasil edit lebih cepat.', 2],
      ['Additional Props', 'additional-props', 'Properti tambahan untuk kebutuhan sesi (toga, bunga, dan lain-lain).', 3]
    ].forEach((a) => insAddon.run(a[0], a[1], a[2], a[3]));
  }

  /* ================================================================ */
  /* V3 — article drafts (unpublished, for the owner to review first) */
  /* ================================================================ */
  if (db.prepare('SELECT COUNT(*) AS n FROM articles').get().n === 0) {
    const insArt = db.prepare(`INSERT INTO articles
      (title, slug, excerpt, body, cover_image, is_published, sort_order)
      VALUES (?, ?, ?, ?, ?, 0, ?)`);
    insArt.run(
      'Persiapan Sesi Foto Wisuda: Panduan Singkat',
      'persiapan-sesi-foto-wisuda',
      'Hal-hal sederhana yang membuat sesi foto wisuda berjalan lebih tenang dan hasilnya lebih maksimal.',
      'Sesi foto wisuda yang nyaman biasanya dimulai jauh sebelum kamera diangkat.\n\n1. Siapkan detail toga\nPastikan toga, topi, dan atribut sudah disetrika dan lengkap. Cek juga sepatu serta aksesori pendukung.\n\n2. Diskusikan konsep\nTentukan apakah Anda ingin tampil formal, casual, atau keduanya. Sampaikan referensi visual kepada fotografer sebelum hari-H.\n\n3. Pilih lokasi yang realistis\nSesuaikan jumlah lokasi dengan durasi yang Anda pilih agar sesi tidak terburu-buru.\n\n4. Datang lebih awal\nWaktu tambahan membantu Anda beradaptasi dengan lokasi dan rileks di depan kamera.\n\n5. Bawa air minum dan alas bedak\nDetail kecil ini membantu menjaga kenyamanan selama sesi berlangsung.',
      '', 0
    );
    insArt.run(
      'Memilih Durasi Pemotretan yang Sesuai Kebutuhan',
      'memilih-durasi-pemotretan',
      'Durasi 60, 90, atau 120 menit bukan sekadar angka — masing-masing memberi ruang berbeda untuk eksplorasi.',
      'Durasi pemotretan menentukan seberapa leluasa Anda berpindah lokasi dan berekspresi.\n\nDurasi singkat\nCocok untuk kebutuhan foto formal, portrait close-up, dan foto bersama keluarga inti di satu lokasi.\n\nDurasi menengah\nMemberi ruang untuk dua lokasi atau kombinasi foto formal dan casual, termasuk sesi couple bersama orang terdekat.\n\nDurasi panjang\nCocok untuk Anda yang ingin mengeksplorasi beberapa lokasi, banyak pose, serta sesi group bersama teman satu angkatan.\n\nSesuaikan durasi dengan jumlah orang yang difoto dan jumlah lokasi. Jika ragu, tanyakan kepada admin sebelum booking.',
      '', 0
    );
  }

  /* ---- V3: refresh the city-page copy when it still holds the V2 default ---- */
  const cityCopyFlag = db.prepare("SELECT value FROM settings WHERE key = 'migration.v3_citycopy'").get();
  if (!cityCopyFlag) {
    const swap = (key, oldValue, newValue) => {
      db.prepare(`UPDATE site_content SET draft_value = ?, live_value = ?
                  WHERE key = ? AND live_value = ?`).run(newValue, newValue, key, oldValue);
    };
    swap('cities.title', 'Pilih kota Anda', 'Archives by Location');
    swap('cities.description',
      'Setiap kota memiliki paket, jadwal, dan tim fotografernya sendiri. Pilih kota untuk melihat paket yang tersedia.',
      'Select a city to explore our graduation photography collections and available sessions.');
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v3_citycopy', 'done')").run();
  }

  /* ---- V3.1 backfill: one-time copy of the package-level photo count ---- */
  const photosFlag = db.prepare("SELECT value FROM settings WHERE key = 'migration.v3_1_duration_photos'").get();
  if (!photosFlag) {
    db.prepare(`UPDATE package_durations
                SET edited_photos = (SELECT p.edited_photos FROM packages p WHERE p.id = package_durations.package_id)
                WHERE edited_photos IS NULL`).run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v3_1_duration_photos', 'done')").run();
  }

  /* ---- V4: mark the TnC-consent timestamp for rows that consented before the column existed ---- */
  const tncFlag = db.prepare("SELECT value FROM settings WHERE key = 'migration.v4_terms_at'").get();
  if (!tncFlag) {
    db.prepare(`UPDATE bookings SET terms_consent_at = created_at
                WHERE terms_consent = 1 AND terms_consent_at IS NULL`).run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v4_terms_at', 'done')").run();
  }

  /* ---- V6: homepage counters (owner-provided starting values) ---- */
  if (db.prepare('SELECT COUNT(*) AS n FROM home_stats').get().n === 0) {
    const insStat = db.prepare(`INSERT INTO home_stats (value_num, label, suffix, is_active, sort_order)
                                VALUES (?, ?, '+', 1, ?)`);
    insStat.run(800, 'Client', 0);
    insStat.run(50, 'Kampus Populer', 1);
    insStat.run(10, 'Kota Tersedia', 2);
  }

  /* ---- V8: turn each existing `packages.facilities` line into a benefit row ---- */
  const benefitsFlag = db.prepare("SELECT value FROM settings WHERE key = 'migration.v8_benefits'").get();
  if (!benefitsFlag) {
    const seeded = db.prepare('SELECT COUNT(*) AS n FROM package_benefits').get().n;
    if (seeded === 0) {
      const insBenefit = db.prepare(`INSERT INTO package_benefits (package_id, text, icon, is_active, sort_order)
                                     VALUES (?, ?, 'check', 1, ?)`);
      db.prepare('SELECT id, facilities FROM packages').all().forEach((pkg) => {
        String(pkg.facilities || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((text, i) => insBenefit.run(pkg.id, text.slice(0, 200), i));
      });
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v8_benefits', 'done')").run();
  }

  /* ---- V8: derive portfolio client name / campus from the legacy title ---- */
  const clientFlag = db.prepare("SELECT value FROM settings WHERE key = 'migration.v8_portfolio_client'").get();
  if (!clientFlag) {
    const upd = db.prepare('UPDATE portfolio SET client_name = ?, campus = ? WHERE id = ?');
    db.prepare("SELECT id, title, client_name, campus FROM portfolio").all().forEach((row) => {
      if (row.client_name || row.campus) return;
      // e.g. "Graduation Vieke - UPI" → client "Vieke", campus "UPI"
      const m = /^\s*(?:graduation|wisuda)\s+(.+?)\s+-\s+(.+?)\s*$/i.exec(row.title || '');
      if (!m) return;
      upd.run(m[1].slice(0, 80), m[2].slice(0, 80), row.id);
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v8_portfolio_client', 'done')").run();
  }

  /* ---- V13 (Tahap 6): give every portfolio entry a public slug --------------
   * Guarded by a settings flag, so it runs once. Existing slugs are kept; a collision
   * gets a numeric suffix instead of overwriting someone else's URL. Rows whose client
   * name is empty fall back to the legacy `title`.
   */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v13_portfolio_slug'").get()) {
    const slugify = (value) => String(value || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const rows = db.prepare('SELECT id, client_name, title, slug FROM portfolio ORDER BY id').all();
    const taken = new Set(rows.map((r) => r.slug).filter(Boolean));
    const upd = db.prepare('UPDATE portfolio SET slug = ? WHERE id = ?');
    rows.forEach((row) => {
      if (row.slug) return;
      const base = slugify(row.client_name || row.title) || `portfolio-${row.id}`;
      let slug = base;
      let n = 2;
      while (taken.has(slug)) { slug = `${base}-${n++}`; }
      taken.add(slug);
      upd.run(slug, row.id);
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v13_portfolio_slug', 'done')").run();
  }

  /* ---- V13 (Tahap 6): typography refresh -------------------------------
   * The old global pair (Playfair Display / Cormorant Garamond + Inter) is exactly the
   * "generic serif + Inter" look the owner asked to move away from. Only an UNTOUCHED
   * previous default is migrated; a pair the owner picked deliberately is left alone.
   * Everything stays changeable in Admin → Warna & Font.
   */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v13_typography'").get()) {
    const get = (k) => db.prepare('SELECT * FROM site_content WHERE key = ?').get(k);
    const head = get('appearance.font_heading');
    const body = get('appearance.font_body');
    const oldHeads = ['', 'Playfair Display', 'Cormorant Garamond'];
    const oldBody = ['', 'Inter'];
    const upd = db.prepare(`UPDATE site_content SET live_value = ?, draft_value = ?,
                            updated_at = datetime('now') WHERE key = ?`);
    if (!head || oldHeads.includes(String(head.live_value || ''))) upd.run('Fraunces', 'Fraunces', 'appearance.font_heading');
    if (!body || oldBody.includes(String(body.live_value || ''))) upd.run('Instrument Sans', 'Instrument Sans', 'appearance.font_body');
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v13_typography', 'done')").run();
  }

  /* ---- V14: mirror the legacy single crew column into booking_team (once) ---- */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v14_booking_team'").get()) {
    const rows = db.prepare(`SELECT b.id, b.team_member_id, b.team_name_snapshot, b.team_email_snapshot,
                                    t.role
                             FROM bookings b LEFT JOIN team_members t ON t.id = b.team_member_id
                             WHERE b.team_member_id IS NOT NULL`).all();
    const ins = db.prepare(`INSERT OR IGNORE INTO booking_team
        (booking_id, member_id, name, email, role, sort_order) VALUES (?, ?, ?, ?, ?, 0)`);
    rows.forEach((r) => ins.run(r.id, r.team_member_id, r.team_name_snapshot || '',
      r.team_email_snapshot || '', r.role || ''));
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v14_booking_team', 'done')").run();
  }

  /* ---- Revisi Tahap 7: deadline antrean editing = 10 hari kerja -------------
   * Job yang sudah ada tetapi belum punya due_at dihitung dari tanggal masuknya
   * (created_at), supaya kartu antrean langsung menampilkan tenggat yang masuk akal.
   * Hanya baris yang due_at-nya KOSONG; tanggal yang sudah diatur admin tidak diubah.
   */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v15_editing_due'").get()) {
    const rows = db.prepare("SELECT id, created_at FROM editing_jobs WHERE due_at IS NULL OR due_at = ''").all();
    const upd = db.prepare('UPDATE editing_jobs SET due_at = ? WHERE id = ?');
    rows.forEach((row) => {
      const start = String(row.created_at || '').slice(0, 10) || todayISOForMigration();
      upd.run(addWorkingDaysISO(start, 10), row.id);
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v15_editing_due', 'done')").run();
  }

  /* ---- V16: kode booking format baru + PIN portal -------------------------
   * Semua booking (baru & lama) memakai DLY-WISUDA-NAMA###. Kode lama disimpan di
   * `legacy_code` sehingga link/WhatsApp lama tetap bisa dipakai masuk portal.
   * PIN 4 digit dibuat sekali per booking; hash scrypt (tidak bisa dibaca balik).
   */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v16_portal'").get()) {
    const rows = db.prepare('SELECT id, code, legacy_code, client_name, category_id FROM bookings ORDER BY id').all();
    const categoryOf = db.prepare('SELECT name FROM package_categories WHERE id = ?');
    const upd = db.prepare('UPDATE bookings SET code = ?, legacy_code = ? WHERE id = ?');
    rows.forEach((row) => {
      const cat = row.category_id ? categoryOf.get(row.category_id) : null;
      const svc = cat && /couple|group|event/i.test(cat.name) ? 'WISUDA' : 'WISUDA';
      const current = String(row.code || '');
      if (/^DLY-[A-Z]+-[A-Z]{3,10}\d{3}$/.test(current)) return; // sudah format baru
      // generate() membaca tabel, jadi hitung manual di sini agar tidak bentrok antar baris.
      const name = String(row.client_name || 'KLIEN')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
      const nm = (name.find((w) => w.length >= 3) || name[0] || 'KLIEN').toUpperCase().slice(0, 10);
      const prefix = `DLY-${svc}-${nm}`;
      let n = 1;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const candidate = `${prefix}${String(n).padStart(3, '0')}`;
        const clash = db.prepare('SELECT id FROM bookings WHERE code = ? OR legacy_code = ?').get(candidate, candidate);
        if (!clash) { upd.run(candidate, current, row.id); break; }
        n += 1;
      }
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v16_portal', 'done')").run();
  }

  /* ---- V16b: PIN portal untuk booking yang sudah dikonfirmasi --------------
   * Supaya admin bisa langsung mengirim akses (kode + PIN) tanpa membuka tiap booking.
   * Hanya baris yang PIN-nya KOSONG; PIN yang sudah ada tidak pernah diubah.
   */
  /* ---- v15: simpan hash PIN sebagai cadangan (PIN tetap terbaca) -------------
   * V20 sempat mengosongkan PIN terbaca; pemilik memutuskan PIN harus bisa
   * ditampilkan lagi di dashboard, jadi migrasi ini sekarang hanya MELENGKAPI hash
   * dan tidak pernah menghapus PIN. Migrasi v21 di bawah memulihkan baris yang
   * terlanjur kehilangan PIN-nya.
   */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v20_pin_hash'").get()) {
    const rows = db.prepare("SELECT id, portal_pin FROM bookings WHERE portal_pin IS NOT NULL AND portal_pin <> ''").all();
    const upd = db.prepare('UPDATE bookings SET portal_pin_hash = ? WHERE id = ?');
    rows.forEach((r) => {
      if (/^\d{4}$/.test(String(r.portal_pin))) upd.run(hashPassword(String(r.portal_pin)), r.id);
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v20_pin_hash', 'done')").run();
  }

  /* ---- v21: PIN portal WAJIB terbaca (bisa ditampilkan di dashboard) --------
   * Baris yang sempat di-hash oleh V20 kehilangan PIN terbacanya (hash tidak bisa
   * dibalik), jadi dibuatkan PIN baru — satu kali saja. PIN lama otomatis tidak
   * berlaku dan admin perlu mengirim ulang PIN ke klien tersebut.
   */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v21_pin_plain'").get()) {
    const rows = db.prepare(`SELECT id FROM bookings
                             WHERE portal_pin IS NULL OR portal_pin = ''`).all();
    const upd = db.prepare(`UPDATE bookings SET portal_pin = ?, portal_pin_hash = NULL,
                            portal_pin_at = datetime('now') WHERE id = ?`);
    rows.forEach((row) => upd.run(String(crypto.randomInt(1000, 10000)), row.id));
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v21_pin_plain', 'done')").run();
  }

  /* ---- v23: pengajuan upgrade paket & extra time ---- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_upgrades (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id   INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL DEFAULT 'package',
      package_id   INTEGER,
      package_name TEXT NOT NULL DEFAULT '',
      minutes      INTEGER NOT NULL DEFAULT 0,
      price        INTEGER NOT NULL DEFAULT 0,
      note         TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at   TEXT,
      decided_by   TEXT NOT NULL DEFAULT ''
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_upgrades_booking ON booking_upgrades(booking_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_upgrades_status ON booking_upgrades(status)');

  /* ---- v24: pengajuan reschedule oleh KLIEN (disetujui/ditolak admin) -------------
   * Klien hanya mengirim PENGAJUAN (tanggal, jam, lokasi). Booking tidak berubah sampai
   * admin menyetujui — persetujuan memakai mesin reschedule yang sama dengan form admin
   * (cek kapasitas, tim bentrok, Google Calendar, riwayat, notifikasi klien).
   * `bookings.reschedule_override` = pintu manual admin: membuka menu Reschedule klien
   * walaupun sudah masuk H-7 (di dalam 7 hari sebelum sesi).
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS reschedule_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id   INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      old_date     TEXT NOT NULL DEFAULT '',
      old_time     TEXT NOT NULL DEFAULT '',
      old_location TEXT NOT NULL DEFAULT '',
      new_date     TEXT NOT NULL DEFAULT '',
      new_time     TEXT NOT NULL DEFAULT '',
      new_location TEXT NOT NULL DEFAULT '',
      reason       TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      conflict     TEXT NOT NULL DEFAULT '',
      admin_note   TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at   TEXT,
      decided_by   TEXT NOT NULL DEFAULT ''
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_resreq_booking ON reschedule_requests(booking_id, id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_resreq_status ON reschedule_requests(status)');
  addColumn('bookings', 'reschedule_override', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('bookings', 'reschedule_override_at', 'TEXT');
  addColumn('bookings', 'reschedule_override_by', "TEXT NOT NULL DEFAULT ''");

  /* ---- v25: catatan peristiwa keamanan (login gagal, rate limit) -------------
   * Ditulis oleh src/security.js + route login. Dipakai panel "Keamanan" di
   * /admin/settings supaya pemilik bisa melihat percobaan masuk yang mencurigakan.
   * Tanpa data pribadi klien — hanya jenis, IP, dan keterangan singkat.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL DEFAULT '',
      ip         TEXT NOT NULL DEFAULT '',
      detail     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at)');

  /* ---- v23: kategori portfolio (dikelola admin) ---- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL,
      is_active  INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);

  /* ---- v23: kategori portfolio dikelola admin -----------------------------
   * Sebelumnya kategori portfolio adalah daftar tetap di kode (Individual / Couple /
   * Group / Graduation Event). Sekarang tabel ini sumber kebenarannya supaya admin bisa
   * menambah, mengganti nama, mengurutkan, dan menonaktifkan kategori tanpa deploy.
   * "Graduation Event" sengaja TIDAK di-seed (permintaan pemilik). Baris portfolio lama
   * yang masih memakai kategori tsb tidak diubah — datanya tetap utuh.
   */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v23_portfolio_categories'").get()) {
    const seed = db.prepare(`INSERT OR IGNORE INTO portfolio_categories (slug, label, is_active, sort_order)
                             VALUES (?, ?, 1, ?)`);
    [['individual', 'Individual'], ['couple', 'Couple'], ['group', 'Group']]
      .forEach((row, i) => seed.run(row[0], row[1], i));
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v23_portfolio_categories', 'done')").run();
  }

  /* ---- v23: Syarat & Ketentuan bertingkat (judul bagian + poin + sub-poin) --------
   * Hanya MENAMBAH judul bagian pada konten yang masih datar; teks poin yang sudah ada
   * tidak diubah satu kata pun. Dilewati bila admin sudah memakai penanda bagian
   * (mis. "A. …") atau bila jumlah barisnya sudah tidak seperti daftar awal.
   */
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v23_tnc_sections'").get()) {
    try {
      const row = db.prepare("SELECT draft_value, live_value FROM site_content WHERE key = 'tnc.body'").get();
      const body = String((row && (row.live_value || row.draft_value)) || '');
      const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const hasSections = lines.some((l) => /^(##\s+|[A-Za-z]\s*[.)]\s+\S)/.test(l) && /[A-Z]{2}/.test(l));
      if (!hasSections && lines.length === 10) {
        const grouped = [
          'A. PEMESANAN DAN PEMBAYARAN',
          ...lines.slice(0, 3).map((l) => `- ${l}`),
          'B. JADWAL DAN KETERLAMBATAN',
          ...lines.slice(3, 6).map((l) => `- ${l}`),
          'C. HASIL FOTO DAN DATA PRIBADI',
          ...lines.slice(6).map((l) => `- ${l}`)
        ].join('\n');
        db.prepare("UPDATE site_content SET draft_value = ?, live_value = ?, updated_at = datetime('now') WHERE key = 'tnc.body'")
          .run(grouped, grouped);
      }
    } catch (err) { /* konten belum ada — tidak apa-apa */ }
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v23_tnc_sections', 'done')").run();
  }

  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration.v16_portal_pin'").get()) {
    const rows = db.prepare(`SELECT id FROM bookings
                             WHERE (portal_pin IS NULL OR portal_pin = '')
                               AND status IN ('pending','confirmed','completed')`).all();
    const upd = db.prepare("UPDATE bookings SET portal_pin = ?, portal_pin_at = datetime('now') WHERE id = ?");
    rows.forEach((row) => {
      upd.run(String(1000 + Math.floor(Math.random() * 9000)), row.id);
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration.v16_portal_pin', 'done')").run();
  }

  /* ---- backfill V3 price snapshots so old rows stay consistent ---- */  db.prepare('UPDATE bookings SET package_price_snapshot = price WHERE package_price_snapshot IS NULL').run();
  db.prepare('UPDATE bookings SET total_price_snapshot = price WHERE total_price_snapshot IS NULL').run();

  /* ---- backfill booking snapshots -------------------------------- */
  db.prepare(`UPDATE bookings SET duration_minutes = duration WHERE duration_minutes IS NULL`).run();
  db.prepare(`UPDATE bookings SET category_id = (
      SELECT p.category_id FROM packages p WHERE p.id = bookings.package_id
    ) WHERE category_id IS NULL`).run();
});

bootstrap();

/* ------------------------------------------------------------------ */
/* Settings helpers                                                    */
/* ------------------------------------------------------------------ */
const settingsCache = { list: null };
function getSettings() {
  if (!settingsCache.list) {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    settingsCache.list = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  return settingsCache.list;
}
function saveSettings(pairs) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(pairs)) stmt.run(k, v == null ? '' : String(v));
  })();
  settingsCache.list = null;
}

module.exports = {
  db,
  DATA_DIR,
  hashPassword,
  verifyPassword,
  getSettings,
  saveSettings,
  DEFAULT_ADMIN_USER,
  DEFAULT_ADMIN_PASSWORD,
  tableExists
};

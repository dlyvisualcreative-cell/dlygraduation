# DLY Graduation — project notes

Platform fotografi wisuda + CMS. Node 20, Express 4, better-sqlite3 12.9.0, EJS (express-ejs-layouts).
Live: `https://dlyvisualcreative.vibecoder.co.id/dlygraduation` (folder name = slug).

## Structure

```
server.js               entry (process.env.PORT)
src/app.js              express setup; per-request locals: site content, appearance/theme, sections, base path, asset versions
src/db.js               connection + single-transaction idempotent migration/seed (runs on every boot)
src/content-schema.js   declarative CMS registry (CONTENT_FIELDS, SECTION_DEFAULTS, SECTION_LAYOUTS, APPEARANCE_*, FONT_OPTIONS)
src/content.js          draft/live engine (site content, sections, appearance, hero snapshot, publish/cancel)
src/auth.js             sessions (SQLite), scrypt, CSRF, login throttling
src/util.js             rupiah/dates/phone, catalogue (city→category→package→durations), add-ons,
                        availability engine, V3 WhatsApp message builder
src/media.js            upload → platform app-media proxy (token .vibecoder-media-token) else public/uploads
src/selection.js        V9 client photo-selection portal: portal rows, derived status, watermarked preview
                        cache (ImageMagick), Drive sync, WhatsApp invite/client message, CSV + ZIP export
src/drive.js            V9.2 Google Drive READER (drive.readonly OAuth or API key) — folder parsing,
                        paginated photo listing, byte download, error mapping. Separate from gcal.js.
src/routes/public.js    home, /gallery (+/portfolio→301), /pricelist, /city(+?kota=), /city/:slug,
                        /cara-order, /artikel(+/:slug), /ulasan, /faq, /tentang,
                        /api/availability?bulan=YYYY-MM, /booking (+ /booking/sukses/:code),
                        /selection/:token (+/review, /photo/:id, POST pick/submit), sitemap/robots
src/routes/admin.js     login, publish/cancel/preview, content, appearance, sections, hero, cities, categories,
                        packages(+durations), durations, addons, portfolio, availability, bookings,
                        articles, faqs, testimonials, settings, reorder API
views/                  layout + partials/section-*.ejs (homepage = loop over active sections)
views/layout-portal.ejs minimal client-portal layout (no marketing nav, noindex, own CSS/JS)
views/admin/            one view per CMS screen (sidebar is grouped, not counted)
src/images.js           V10 responsive image derivatives (/media route), dimensions index, temp cleanup
public/assets/          app.css / app.js (public), admin.css / admin.js,
                        selection.css / selection.js (client portal only)
scripts/perf.js         before/after perf harness (Chromium + CDP Slow 3G)
scripts/verify-pages.js every page + every referenced image must load (56 checks)
scripts/check-hero.js   deferred hero slideshow behaviour (15 checks)
scripts/weight.js       per-request weight breakdown for one page
public/ph/              hand-built SVG placeholder artwork
scripts/smoke.js        135-check Playwright acceptance suite
scripts/check-selection.js / check-drive.js  portal acceptance suites (77 / 51 checks)
scripts/mock-drive.js   local drive/v3 mock used by check-drive.js
```

## V3 data model

- `package_categories` → `packages` (city_id + category_id, one package per category after the V3 migration)
  → `package_durations` (**each package owns its own duration list**: minutes + price + note + active).
  `price` NULL ⇒ "Harga belum tersedia" everywhere, CTA disabled, and POST /booking rejected with 422.
  Legacy `packages.price_60/90/120` columns remain for compatibility but are unused.
- `packages.image` = cover photo used on pricelist cards (empty ⇒ neutral navy panel, never a fake photo).
- **Edited-photo count lives on `package_durations.edited_photos`** (V3.1), not on the package: 60 min can give
  20 photos while 120 min gives 50. `packages.edited_photos` is only a fallback for rows created before V3.1
  (backfilled once by `migration.v3_1_duration_photos`). Admin edits it in *Paket → table durasi* or the
  *Harga & Foto Edit* screen; the public card, duration chips, booking wizard, review step and booking snapshot
  (`bookings.edited_photos_snapshot`) all follow the selected duration.
- `addons(name, price, applies_to, is_active, sort_order)`: `applies_to` = `'all'` or comma-separated category
  slugs. An add-on is shown publicly **only if active AND priced**.
- `availability_overrides(date, is_available, note)` + settings `booking_lead_days`, `booking_advance_days`,
  `booking_closed_weekdays`, `booking_daily_capacity`. `util.availabilityForRange()` merges rules +
  overrides + existing booking counts into a per-day `{available, reason}` map used by both the public
  calendar (`/api/availability`) and the server validator.
- `articles`, `faqs` — CMS content pages. Articles are drafts by default; only `is_published=1` is public.
- `bookings` keeps a **price snapshot**: `package_price_snapshot`, `addons_snapshot` (JSON),
  `total_price_snapshot`, `duration_minutes`, `category_id`; plus `instagram`, `faculty`, `major`,
  `mu_instagram`, `wardrobe_instagram`, `location_address`, `photo_consent`, `terms_consent`, `internal_notes`.
- **Google Calendar + Drive** (`src/gcal.js`): OAuth2 authorization-code flow → refresh token stored in `settings`;
  one event per booking (`bookings.gcal_event_id`). confirmed/completed ⇒ create or PATCH; pending/cancelled ⇒
  delete; deleting a booking cancels its event first. `settings.gcal_default_time` is the start time (bookings
  only store a date) and the event end = start + `duration_minutes`. Failures never block saving the status —
  they're recorded in `bookings.gcal_error` + `settings.gcal_last_error` and retried via the per-booking sync
  button. Endpoint bases are env-overridable (`GCAL_TOKEN_URL`, `GCAL_AUTH_URL`, `GCAL_API_BASE`) so
  `scripts/mock-google.js` can test the whole flow; production uses the real Google endpoints.
  - **Two independent authorizations**, each able to use its OWN OAuth client:
    `gcal_client_id/secret` (Calendar) and optional `gdrive_client_id/secret` (Drive). `clientFor(kind)`
    picks the pair; an incomplete Drive pair falls back to the Calendar client rather than mixing id+secret.
    A refresh token is bound to the client that issued it, so `driveConnection()` refuses to reuse the
    Calendar token when Drive has its own client — that combination would always fail with
    `unauthorized_client`. Changing Drive credentials clears only the Drive token; changing Calendar
    credentials clears the Calendar token and — only when Drive has NO own client — the Drive token too
    (a Drive token issued by its own client stays valid; wiping it was a real bug that forced reconnection). The owner may connect a different Google account for Drive — e.g. the
    account that actually has storage. When `gdrive_refresh_token` is empty, Drive falls back to the calendar token.
    Each connection has its own token cache slot (`tokenCache.calendar` / `tokenCache.drive`), its own
    connect/disconnect buttons and its own error field (`gcal_last_error` / `gdrive_last_error`).
  - Both OAuth clients must list the same redirect URI (`/admin/google/callback`) in their Cloud project.
  - Scopes are requested per connection (`SCOPE_CALENDAR` for Calendar, `SCOPE_DRIVE` for Drive); the OAuth
    `state` records which connection it belongs to so the callback writes to the right slot.
  - **Both APIs must be enabled in the Google Cloud project** (Calendar API *and* Drive API). Google returns
    "has not been used in project … or it is disabled" — `markScopeProblem()` detects this and stores an
    actionable `friendly` message instead of the raw text.
  - Event description follows the owner's "DLY GRADUATION - DETAIL BOOKING" template (fields → Drive link →
    notes → separator → H-1 chat template). The booking code lives in `extendedProperties.private`, not the body.
  - Drive structure: `<Bulan> <Tahun>` → `Graduation <klien> - <kampus>` (year included so years never mix).
    A cached folder link is re-verified via `GET /files/{id}`; if the owner deleted the folder in Drive the stale
    link is cleared and the folder is rebuilt (otherwise the button silently returned a dead URL).
    `bookings.drive_folder_id/url/path` cache it. Created automatically on confirm, or via the per-booking
    "Buat folder Drive" button (`POST /admin/bookings/:id/drive`), which also re-pushes the calendar description.
- `hero_slides` = draft table; publish snapshots it into `site_content['hero.slides_json']` (live).

## V4 additions

- **Page visibility** lives in settings (`page_<page>_visible`), read into `res.locals.pages` and used by
  `partials/header.ejs` + `partials/footer.ejs`. Hidden pages are NOT deleted — they still answer 200 on their
  URL, which is what keeps old links and data intact. Managed at `Admin → Halaman & Navigasi`.
- **Syarat & Ketentuan** is a real CMS page: content keys `tnc.title/description/body` (body = one term per line),
  route `/syarat-ketentuan`, view `views/tnc.ejs`.
- **Shooting time**: `bookings.shooting_time` ('HH:MM', WIB). Required by the public form and validated server-side
  (06:00–21:00). `gcal.buildEvent()` prefers it over `settings.gcal_default_time`; the default is now only a
  fallback for bookings created before V4. Duration still drives the event end.
- **Duration cards**: the booking wizard renders `.slot` labels (`.slot__box` inside) — navy when selected,
  white with a thin border otherwise, rounded 12px, one compact line: `60 Menit — Rp375.000 — 30 Foto Edit`.
  Pricelist/city pages keep the `package-browser.ejs` editorial cards.
- **Personal data**: name, WhatsApp, Instagram (required, `[A-Za-z0-9._]{2,30}`) and campus are required;
  faculty/major/notes optional. `mu_instagram` + `wardrobe_instagram` are hidden from the public form but the
  columns and any stored values are kept.
- **TnC consent**: `terms_consent` + `terms_consent_at` (ISO timestamp). Photo-publication consent stays a
  separate optional checkbox (`photo_consent`).
- **Payment settings** (`payment_bank_name/number/holder/dp_amount/notes`) feed the admin "Chat Klien" WhatsApp
  template — nothing is hardcoded. `dp_amount` defaults to 100000.
- **Admin booking cards** use `.bk-card` (navy `#0B2340`, white text). All operational buttons stay: status
  update, internal notes, Chat Klien, calendar sync, Drive folder, delete.

## V5 additions

- **Calendar description** no longer prints `Harga:` or `Foto edit:` (owner request). Keep it that way —
  the price is intentionally not written to a calendar that may be shared.
- **Team assignment**: `team_members(name, email, role, is_active, sort_order)` + `bookings.team_member_id`
  with `team_name_snapshot` / `team_email_snapshot` so an event keeps the crew name even if the member is
  renamed or deleted. The booking card has a per-booking `<select>` inside the update form.
  When the member has an email it becomes a calendar **attendee**, and every event write uses
  `?sendUpdates=all` so Google actually emails the invitation (PATCH/DELETE included).
- **Private testimonial link**: `/testimoni/<token>` where the token lives in
  `settings.testimonial_form_token` (regenerate from Admin → Link Testimoni). Never linked from the public
  site (asserted by the test suite) and served with `noindex`. Submissions store name+degree, campus, quote,
  rating and one photo into `testimonials` with `source='client'`; they stay hidden until approved unless
  `settings.testimonial_auto_approve = '1'`.
- **Scroll reveal**: `app.js` adds `.reveal` to role-based selectors and reveals them with
  IntersectionObserver. Elements already in view get `.is-in` immediately (no flash of hidden content), it is
  skipped on the booking/testimonial/confirmation pages, and `prefers-reduced-motion` disables it.

## V6 additions

- **Admin design system** lives at the end of `admin.css` (tokens `--r-*`, `--sh-*`). Surfaces are rounded
  14–22px with soft shadows; `admin.js` adds sidebar collapse (remembered in localStorage), count-up for
  `[data-count]`, a toast (`window.adminToast`, auto-fed by `.admin-flash`) and an unsaved-changes guard.
  Nav icons come from the `ICON` map in `admin/layout.ejs`.
- **Brand identity** (`/admin/brand`): four logo slots (`logo_header_light/dark`, `logo_footer_light/dark`)
  plus `brand_description`, `header_show_identity`, `header_sticky`. `src/app.js` builds `brand.logos` with
  `pickLogo()`, which **verifies local /uploads paths exist** — a typo in the dashboard can never render a
  broken image (falls back to another variant, then the built-in SVG mark). The brand page lists broken
  paths and refuses to save a new one.
- **Homepage stats** (`home_stats` + `/admin/home-stats`): numbers/labels/suffix/order/active, count-up once
  per page load via IntersectionObserver (`[data-countup]`), section toggled by `home_stats_visible`.
- **Pricelist merchandising**: `packages.is_best_seller`, `sold_count`, `sold_label`, `sold_visible`,
  `tagline`, `terms`; `package_images` for the multi-photo gallery (cover stays in sync via
  `packages.image`). Card CTA now opens `/paket/:slug` ("Pesan Sesimu Sekarang").
- **Package detail page** `/paket/:slug`: gallery slider + thumbs, dynamic duration pricing, terms,
  related packages, sticky mobile CTA that carries `paket` + `durasi` into the booking form.
- **Booking order (V6)**: step 1 = identity, step 2 = session, step 3 = review. Photo-publication consent
  was removed from the public form (`photo_consent` column kept for history). Tests use
  `openSessionStep()` to pass identity before touching session fields.
- **WhatsApp template** (`/admin/wa-template`): `settings.wa_admin_template` with `{{placeholder}}` syntax,
  rendered by `util.renderTemplate` + `util.bookingTemplateVars`. The built-in default is plain text (no
  emoji) on purpose; the owner may add emoji, and the tests then assert the data contract instead of wording.

## V7 additions

- **Homepage stats moved**: rendered inside the section loop, right after the `hero` row (not at the top).
- **Section styling is per row**: `website_sections` gained `bg_color`, `text_color`, `font`, `items_json`
  (+ `draft_*` twins, so draft→publish still applies). `sectionStyle()`/`sectionClass()` in `app.js` turn them
  into inline CSS vars; `admin/sections.ejs` is the Google-Sites-like editor (colour pickers, font select,
  add/remove rows, per-row image upload).
- **Structured rows**: `services` / `advantages` / `process` store JSON arrays in `items_json`.
  `SECTION_ITEM_DEFAULTS` in `content-schema.js` is shared by BOTH the public fallback and the editor prefill —
  never duplicate those defaults in a view again.
- **`--line-strong` did not exist**; a `border: 1px solid var(--line-strong)` therefore computed to 0px.
  It is now defined in `:root` (and used with a fallback). This is why the carousel outline was invisible.
- **Carousel** thumbnails are square (2px radius) with a 1px outline; caption sits in its own outlined strip.
- **Booking**: review submit button reads "Lanjut"; calendar CSS is fully width-based (`max-width: 100%`),
  with narrower cells at ≤430px and larger ones on tablet; thank-you page drops the photo-consent row and puts
  the WhatsApp button in its own `success-card__actions` row.
- **Favicon**: `settings.favicon_custom` + upload in `/admin/brand`; layout also emits `apple-touch-icon`.
- **TnC editor**: `/admin/tnc` — one textarea row per point, add/remove, save draft or publish immediately.
- **Cara Order** cards: 2px navy outline, white background, navy text.
- **Fonts**: Montserrat, Montserrat Light (300), Montserrat Bold (700), Poppins added to `FONT_OPTIONS`.

## V8 additions

- **Mobile nav CTA was invisible**: `.mobile-nav > a` (colour `--primary`) also matched the panel's
  `<a class="btn btn--primary btn--block">` and, having higher specificity than `.btn--primary`, painted the
  label navy on a navy fill. Selector is now `.mobile-nav > a:not(.btn)`, and
  `.mobile-nav .btn` / `.site-header--over:not(.is-scrolled) .mobile-nav .btn--primary` restore the solid navy
  fill + white label (the panel is a white surface, so the transparent "over hero" CTA rule must not leak in).
  Rule of thumb: any new header rule that targets `.btn--primary` inside `.site-header` also hits the mobile panel.
- **Homepage stats on phones**: `.stat-band` is grid `auto-fit minmax(140px,1fr)`, which wrapped 3 stats into
  2 + 1 left-aligned. ≤559px it is now flex-wrap with `flex: 0 0 calc((100% - 8px)/3)` and `justify-content:center`
  — one compact row of three, remaining items centered — with smaller value/label type (and a ≤359px tweak so
  "Kampus Populer" stays on one line at 320px).

## V8 additions

- **Testimonial rating is 1→5, left→right, everywhere.** The public form (`views/testimonial-form.ejs`),
  the admin form (`views/admin/testimonial-form.ejs`) and the read-only display all use the same trick:
  the DOM stays **5→1** and CSS reverses the row (`flex-direction: row-reverse`), which is what lets the
  `~` sibling rules fill the hovered/checked star *and every star to its left* with no JavaScript.
  Do not "fix" the DOM order to 1→5 — the fill would then paint the wrong side. Ratings are stored as
  integers 1–5 (`testimonials.rating`) and rendered by `views/partials/stars.ejs` (always 5 stars: filled
  + neutral), never by repeating `'★'.repeat(rating)`.
- **Testimonial cards** (`views/partials/section-testimonials.ejs`, `views/reviews.ejs`) show rating, name,
  avatar (photo or initial), campus, quote and a date (`testimonials.display_date` or `created_at`).
  The homepage uses `.tst-carousel` (scroll-snap, 1/2/3 cards per view, arrows auto-hidden when everything
  fits — `initTestimonialCarousel()` in app.js); `/ulasan` uses the same cards in a responsive grid.
- **Package benefits live in `package_benefits`** (`package_id, text, icon, is_active, sort_order`), NOT in
  the legacy `packages.facilities` text. `util.benefitsForPackage()` feeds the pricelist cards, the package
  detail page and the booking catalogue, so both public pages always show the same rows.
  `packages.facilities` is kept in sync on every save (newline-joined active benefits) purely as a legacy
  fallback for rows that predate the table. Seeded once by `migration.v8_benefits`.
- **Icons** come from `src/icons.js` (17 inline SVGs, `icon(key)` helper exposed to views as `icon`).
  Unknown/missing keys fall back to `check`. The admin picker is a `<details>` grid of radios in
  `views/admin/package-form.ejs`; `admin.js` mirrors the chosen icon into the `<summary>`.
- **Benefit ordering**: the `Urutan` field is authoritative — rows are sorted by it and renumbered 0..N-1
  on save; on a tie a **new** row wins, otherwise form order is kept (so "set it to 1" behaves as expected).
- **Portfolio covers no longer show the city.** Cover = `client_name` (+ `client_degree`), `campus`,
  `taken_at`. The city stays in `portfolio.city_id` for filters/grouping and appears on the cover only when
  `settings.portfolio_show_city = '1'` (global, `/admin/portfolio`) **or** the per-item `portfolio.show_city`
  is checked. `migration.v8_portfolio_client` derives client/campus once from legacy titles like
  "Graduation Vieke - UPI"; `portfolio.title` is still written (kept equal to the client name) because the
  column is NOT NULL and old exports/links may read it.
- **Multi-photo portfolio**: extra photos in `portfolio_images`; the cover stays in `portfolio.image` and
  "Jadikan cover" swaps them. Reorder with the ↑/↓ buttons. The public card emits them as `data-more`
  (|-separated) and the lightbox walks that one portfolio's set (counter + thumbnails + swipe).
- **Editorial portfolio grid** = `views/partials/portfolio-card.ejs` used by BOTH the Featured section and
  the Gallery page (`.portfolio-grid` 2/3/4 columns with lead/tall/wide variants; `.gallery-masonry` CSS
  columns). The carousel strip intentionally keeps the V7 **square + outline** look — don't round it.
- **The Featured Portfolio section was disabled on the live site** (the carousel strip was the visible
  portfolio). V8 turned `featured` on and `carousel` off so the homepage shows the editorial grid; both are
  one checkbox in *Admin → Bagian Website* if the owner prefers the old strip.
- `scripts/check-v8.js` (73 checks) covers rating 1–5 + hover preview, benefit icon picker/order/visibility,
  portfolio cover info, city visibility, multi-photo lightbox and the mobile layouts.
- **`scripts/check-selection.js` (76 checks)** covers the V9 portal end-to-end (see the V9 section).

## V9 additions — client photo-selection portal

Owner flow: booking → **Portal Seleksi Foto** button on the booking card (`POST /admin/selection/create`,
idempotent) → portal editor → upload photos → set quota/instructions/deadline → send link via WhatsApp
→ client picks → client submits → admin exports codes / downloads the picked photos.

- **Tables** (created by `src/db.js` bootstrap, additive only):
  `photo_selections` (UNIQUE `booking_id`, UNIQUE `token`, `quota`, `instructions`, `deadline`, `is_open`,
  `status`, `admin_note`, `first_pick_at`, `submitted_at`, `token_rotated_at`),
  `photo_selection_photos` (`portal_id`, `code` = `001…`, **`image` = master file**, `is_primary`, `sort_order`),
  `photo_selection_picks` (UNIQUE `portal_id + photo_id`, `ON DELETE CASCADE`).
  Deleting a booking cascades its portal; the booking-delete route drops the cached previews first.
- **Status is derived, not just stored** (`selection.deriveStatus`): `none` (Belum Dibuat) | `waiting`
  (Menunggu Seleksi) | `picking` (Sedang Dipilih — computed from pick count) | `submitted` | `processing` |
  `done`. Picking/unpicking is stored per click, so the status flips without admin action. "Sedang Dipilih"
  and "Menunggu Seleksi" are never written to `status`; the admin only sets waiting/submitted/processing/done.
- **Quota default = `edited_photos_snapshot`** (falls back to the duration/package edited-photo count, else 20).
  Never invents a number and never writes back to the booking.
- **Security model** — the token (24 random bytes → 48 hex chars) is the only credential:
  token compare via indexed SELECT, `/selection/:token` 404s on anything else, every photo is streamed from
  `/selection/:token/photo/:id` after checking the photo belongs to that portal. **Master URLs are never
  rendered** — neither in HTML, nor via redirect. Client HTML has no `/uploads/` photo paths at all.
  Closed portal ⇒ 403 on photos, 403 on pick, plus a "ditutup" screen; admins see closed portals anyway.
  Rotating the token instantly invalidates every previously shared link. `robots.txt` disallows `/selection/`
  and the portal layout is `noindex, nofollow, noarchive, noimageindex` + `referrer: no-referrer`.
- **Watermark**: `src/selection.js` builds a cached derivative at `DATA_DIR/preview-cache/p<photoId>.jpg`
  with ImageMagick (`convert -resize 1600x1600> -quality 82` + diagonal "DLY GRADUATION" + photo code,
  DejaVu font path — `convert` is present on the host but has no fontconfig, so pass a `.ttf` path, never a
  family name). Preview is written at upload time from the same buffer (client portal opens instantly) and
  regenerated lazily if the cache is lost. If ImageMagick is unavailable the master bytes are still served
  **through the same token-scoped route** — never as a public URL.
- **Quota is enforced server-side** (`POST /selection/:token/pick` → 409 with a message); the browser counter
  is only a mirror. Submit re-validates count>0, count≤quota, portal open, deadline not passed, and refuses a
  second submit (409).
- **Review before submit**: `/selection/:token/review` (separate page, photos + quota) → POST
  `/selection/:token/submit` → `status='submitted'`, `submitted_at`, redirect with `?sent=1`.
- **Deadline** (`deadline` ISO date, nullable) is compared against `util.todayISO()` (WIB); past it the client
  can only view, and the pick/submit endpoints refuse.
- **Exports (admin only)**: `GET /admin/selection/:id/export.csv` (no, code, caption, dipilih) and
  `GET /admin/selection/:id/download.zip` — a dependency-free **store-method streaming ZIP** in
  `selection.streamZip()` (fetches one master at a time, so a 200-photo selection never sits in memory).
- **WhatsApp invite**: `settings.wa_selection_template` (editable at `/admin/wa-template`, second panel) with
  `{{nama}} {{link}} {{kuota}} {{paket}} {{paket_text}} {{tanggal}} {{jam}} {{booking_id}} {{kampus}} {{kota}}`.
  The built-in default carries emoji on purpose; `encodeURIComponent` is what keeps them intact.
- **Uploads** use a dedicated multer instance (15MB/file, 40 files per POST) instead of the 10MB CMS one.
  `media.js` gained `DLY_UPLOAD_DIR` (test isolation) and `localPathFor()` (master → on-disk path).
- **Lightbox group**: triggers sharing `data-lb-group` (portal tiles) walk the whole session with
  next/prev/counter/swipe; `data-lb-group` is what made per-tile data-more (O(n²) HTML) unnecessary.
- Tests: `BASE=… DLY_DATA_DIR=… node scripts/check-selection.js` (76 checks — upload, quota refusal,
  persistence, review/submit, CSV/ZIP, token rotation, closed portal 403s, cross-portal photo 404,
  WhatsApp emoji, Drive folder link, mobile 2-column/no overflow).
- **`scripts/check-drive.js` (51 checks)** + `scripts/mock-drive.js` cover the V9.2 Drive import end-to-end.
  It copies `app.sqlite*` (WAL included!) into its own dir, spawns the mock and the app itself, and picks a
  booking **without** an existing portal — the live DB already contains real portals created by the owner.

### V9.1 — Drive folder link in the portal (display only)

Owner asked to "take the photos from Google Drive". **Importing is not possible with the current
authorization**: the Drive connection uses `https://www.googleapis.com/auth/drive.file`, which only exposes
files the app itself created. Verified against the real account — the per-booking folders are visible but
list **0 children**, because the team uploads photos from outside the app. Importing would need a
`drive.readonly` re-connect (a new consent screen + read access to the whole Drive, since Drive has no
per-folder scope without the Picker). The owner chose the display-only option instead; **do not add a Drive
scope to the existing connections** unless they explicitly ask — that is the configuration that currently
works and must not break.

- `photo_selections.drive_url` (`''` ⇒ fall back to `bookings.drive_folder_url`) + `photo_selections.drive_show`
  (default 1). `selection.driveFolderFor(portal, booking)` resolves `{url, source: custom|booking|none, visible}`.
- `selection.normalizeDriveUrl()` accepts a pasted `drive.google.com`/`docs.google.com` link **or a bare
  folder id** (→ `https://drive.google.com/drive/folders/<id>`) and returns `null` for anything else, so a
  non-Drive URL can never reach the client portal (the settings POST shows an error and keeps the old value).
- The admin field is `type="text" inputmode="url"` on purpose — `type="url"` silently blocks a bare folder id.
- Rendered on the client portal (and on the review page) by `views/partials/selection-drive.ejs` as a card with
  a `rel="noopener noreferrer"` button. No Google API call happens at render time — it is a plain link.
- `{{folder_drive}}` was added to the WhatsApp selection template vars (default template unchanged, so an
  already-saved template keeps working; it renders `-` when no folder is visible).

## V9.2 additions — Google Drive as the photo source

Owner flow: booking → **Buat Portal Seleksi Foto** (`/admin/bookings/:id/portal`) → paste the Drive folder
link → **Cek Folder & Hitung Foto** (validates + counts, creates nothing) → set quota/deadline/download/
full-quota → **Buat Portal Sekarang** → photos are imported from Drive → send the link via WhatsApp.

### Why a SEPARATE Drive authorization (`src/drive.js`)

`src/gcal.js` connects Drive with `drive.file`, which only sees files **the app itself created**. Verified on
the live account: the per-booking folders are visible but list **0 children**, because photos are uploaded by
a human from Drive/phone. Reading them needs either:

1. **OAuth `drive.readonly`** — sees everything that account can see (own Drive + shared). Set up with
   `/admin/selection/drive/connect`, which reuses the ALREADY REGISTERED redirect URI
   (`/admin/google/callback`) with its own state (`selection_drive_state`) and its own token
   (`gdrive_reader_refresh_token`). `admin.js` `GET /google/callback` delegates to `drive.js` when
   `drive.hasPendingState()` + `consumeState()` match — so `gcal.js` and its working Calendar/Drive-folder
   flow are untouched (and `check-gcal.js` still asserts `drive.file` for the folder connection).
2. **API key** (`gdrive_api_key`) — works for folders shared "anyone with the link", no consent screen.

With neither configured, every Drive action returns an actionable message; **no dummy photos are ever
created**. Errors are mapped in `mapApiError()` (auth / permission / not-found / quota / api-disabled).

- `parseFolderId()` accepts `/folders/<id>`, `/drive/u/N/folders/<id>`, `?id=<id>`, a bare id; rejects file
  links, non-Drive hosts and garbage — each with its own message.
- `listFolderPhotos()` paginates (`pageSize 1000`, `nextPageToken`, hard stop at 30 pages) and reports
  `truncated` instead of silently importing a partial gallery. Duplicate file ids are dropped per page set.
- Every Drive call happens **server-side**; the browser only ever sees `/selection/:token/photo/:id`.

### Import + sync rules (`selection.syncFromDrive`)

- Upsert keyed on **`photo_selection_photos.drive_file_id`** (plus a UNIQUE(portal_id, drive_file_id) index)
  ⇒ re-syncing can never duplicate a photo.
- A file that disappeared from the folder is marked `is_available = 0` — **never deleted** — so picked rows
  keep their file name / id and the editing history stays intact. Returning files are re-available.
- New files are appended at the end; existing codes/order are untouched. **Client picks are never modified.**
- Previews are generated lazily from Drive bytes by the existing watermarked-preview pipeline
  (`ensurePreview` → `masterBytes` → ImageMagick → `DATA_DIR/preview-cache`); the master never reaches the
  browser and no photo is copied into app storage.
- ZIP export and the optional client download stream `files.get?alt=media` per file (30MB cap each).

### Portal data model additions (all additive)

`photo_selections`: `drive_folder_id`, `sync_at`, `sync_error`, `sync_count`, `allow_download`,
`require_full_quota`, `expires_at`, plus the earlier `drive_url`/`drive_show`.
`photo_selection_photos`: `source` ('upload'|'drive'), `drive_file_id`, `file_name`, `mime_type`,
`file_size`, `is_available`.
`photo_selection_picks`: `position` (1..N, renumbered on un-pick), `drive_file_id`, `file_name` snapshots.

### Statuses (derived, `deriveStatus`)

`none` Belum Dibuat · `waiting` Menunggu Pilihan · `picking` Sedang Memilih (from pick count) · `submitted`
Pilihan Terkirim · `processing` Sedang Diproses · `done` Selesai · `expired` Deadline Berakhir ·
`disabled` Dinonaktifkan. Only waiting/submitted/processing/done are stored; the rest are computed, so
closing the portal or passing the deadline changes the status without admin action.

### Client portal (redesigned)

Hero with brand + client name + limit + live counter; tabs **Semua Foto / Foto Terpilih**; filename search;
sort (folder order / A→Z / Z→A); picked tiles show a numbered order badge; sticky bottom bar with
**Lihat Pilihan** + **Kirim Pilihan**; confirmation **modal** (count, numbered file names, `Salin Daftar
Foto`, `Simpan & Buka WhatsApp`). The modal list is rendered from `data-names` (server data) and refreshed
from each `/pick` response — never scraped from the DOM. `require_full_quota` blocks submit until the quota
is met; otherwise any non-zero selection may be submitted.

### WhatsApp

- Every `/pick` bumps `position`; `POST /selection/:token/submit` (JSON) stores `submitted_at` and returns the
  client→admin WhatsApp URL built by `selection.clientSubmitMessage()` from the DB (file names, not DOM).
- Two DIFFERENT admin buttons on each booking card: **Konfirmasi Booking & DP** (`wa_confirm_template`,
  placeholders `{{dp}} {{bank}} {{rekening}} {{atas_nama}}` from the payment settings) and **Kirim Link
  Portal Seleksi Foto** (`wa_portal_template`, `{{link}} {{kuota}} {{deadline}} …`). The second is a disabled
  link with an explanatory tooltip when there is no portal / no photos yet. Both are editable at
  `/admin/wa-template` (panels 1 and 2).

### Tests

- `node scripts/check-drive.js` — 51 checks against `scripts/mock-drive.js` (a local drive/v3 mock): invalid
  link, not-found, no-permission, quota, empty folder, pagination counting, import of 5 photos, idempotent
  create, search/sort/tabs, order badges, quota refusal, confirmation modal + clipboard + submit, DB shape
  (drive id/name/position), admin table + CSV, sync add/remove/no-duplicates/picks-preserved, closed portal.
- `node scripts/check-selection.js` — 77 checks (manual upload path, security, token rotation, Drive link
  card, WhatsApp encoding).



Admin edits write drafts (`site_content.draft_value`, `website_sections.draft_*`). **Publish** copies
draft→live in one transaction (content, sections, hero snapshot). **Cancel** resets draft←live.
`?preview=1` renders drafts **only for a logged-in admin**; anonymous requests silently get live.
Packages/cities/portfolio/add-ons/availability/bookings are data and apply immediately (prices must be instant).

## Incident log — Google credentials (2026-11-06)

**Symptom:** Calendar AND Drive connect failed with "Gagal menukar kode otorisasi: The provided
client secret is invalid." on /admin/google.

**Cause (verified against Google's token endpoint, not guessed):**
- `gcal_client_secret` contained a **Client ID** (72 chars, ending `.apps.googleusercontent.com`) — a
  Client ID was pasted into the Secret box on /admin/google.
- `gdrive_client_secret` held a secret Google no longer accepts (that OAuth client's secret had been
  regenerated in Cloud); the still-valid secret was sitting in `gdrive_reader_client_secret`.
- Neither was caused by the portal feature: `gcal_client_secret` is only ever written by `/admin/google/save`.

**Fix:** the working pairs were restored **through the admin form** (never by editing the DB — the live DB
is read-only from Bash). Calendar id + old secret was accepted by Google; Drive id + reader secret was
accepted, and the EXISTING Drive refresh token still works with it (a refresh token is bound to the CLIENT
ID, not to the secret). Result: `Tes kredensial` → both "cocok", `Tes koneksi` → "Drive OK".
The Calendar refresh token had already been wiped, so **Calendar needs one manual reconnect**
(`Hubungkan ulang Calendar`) — only the owner's consent can restore that.

**Guards so it cannot repeat:**
- `/admin/google/save` and `/admin/selection/settings` REJECT a Secret field that looks like a Client ID
  (`…apps.googleusercontent.com`, `^\d{10,}-`, or >80 chars) with an explicit message, BEFORE writing.
- Rotating only the **secret** no longer drops tokens; only a changed **client id** does.
- Button **Tes kredensial** (`POST /admin/google/verify` → `gcal.verifyClientPair`) checks a pair without a
  consent screen: a token request with a bogus code answers `invalid_client` when the pair is wrong and
  `invalid_grant` when it is right.
- `drive.consumeState()` no longer clears a pending reader state on mismatch (it used to destroy the reader
  state when the Calendar callback arrived first).
- `str()` in admin routes takes the FIRST value of a duplicated form field; the wizard's
  "Buat tanpa folder Drive" button used to post a SECOND `drive_url` field (Express → array → `','` →
  "link tidak valid") — it now posts `no_drive=1`.

**Also:** at ~08:51 the live DB had 0 bookings (only test rows existed: Budi/Jokowi/Ujang/Gibran); every
other table is intact (95 content keys, packages + prices, portfolio, testimonials, hero, settings).
`check-selection.js` now creates its own fixtures in the copy (`ensureFixtureBookings`) and
`check-gcal.js`'s "create a booking" fallback was stale (pre-V6 field order) — both fixed.

## V10 additions — performance (Tahap 2)

Measured with `scripts/perf.js` (Chromium + CDP throttling; numbers below are mobile 390px, Slow 3G):

| Page | Before | After |
|---|---|---|
| Home | 4056 KB, 81.5s load, LCP 54.6s | **974 KB, 16.6s, LCP 2.9s** |
| Gallery | 2061 KB, 41.6s | **459 KB, 6.9s** |
| Pricelist | 1510 KB | **431 KB** |
| Portal (45 photos) | 7083 KB, 120s | **~1000 KB, 4.2s** |

- **`src/images.js`** — responsive derivatives. Masters stay untouched in `public/uploads`;
  `/media/<hash8>-<width>.<webp|jpg>` serves a generated, immutable-cached variant
  (`WIDTHS = 96…2000`). The URL carries everything needed to rebuild the file, so a wiped cache heals
  itself. Only `/uploads/*` with an image extension is accepted (no traversal, 404 otherwise).
  `picture(base, src, opts)` returns a `<picture>` with WebP+JPEG srcset, explicit width/height and
  `loading`/`fetchpriority`; `picture { display: contents }` in `app.css` keeps all existing
  `.parent img` rules working. **Emit one `priority: true` per page only** (the LCP candidate);
  logos/eager cards use `eager: true` instead.
- **Dimensions are never read on the request path** — `identify` runs in `warmDimensions()` at boot
  (background). A missing entry only means the `<img>` ships without width/height that one time.
- **Compression** — the platform proxy does not gzip, so `compressionMiddleware` in `app.js` brotli/gzip's
  text responses in-process (cache keyed by ETag). app.css: 106 KB → 18 KB, HTML: 54 KB → 8 KB.
- **Cache headers** — CSS/JS are linked with `?v=<mtime>` and therefore served
  `max-age=31536000, immutable`; `/media/*` is immutable too. HTML stays `no-store`.
- **Hero slideshow** — only slide 1 ships an `<img>`; the rest keep their markup in
  `<template data-hero-defer>` (inert, downloads nothing) and `app.js` hydrates a slide ~2 s before it
  appears. The old `<link rel=preload as=image>` was **removed**: it downloaded the ORIGINAL 481 KB JPEG
  in addition to the responsive WebP on every visit.
- **Portal thumbnails** — `/selection/:token/photo/:id?w=400|800|1600` (`selection.PREVIEW_WIDTHS`);
  watermark point sizes scale with the width. Tiles use `?w=400` + srcset, lightbox keeps 1600.
- **Offscreen rendering** — `content-visibility: auto` + `contain-intrinsic-size` on portfolio cards,
  carousel items, portal tiles; shimmer placeholder while an image loads; all of it disabled under
  `prefers-reduced-motion`.
- **Preview cache leak fixed** — `images.cleanTempDirs()` runs at boot and deletes orphaned
  `.in-*`/`.gen-*`/`*.tmp` files older than 10 min. The portal preview cache had grown to **328 MB** of
  leaked temp files from interrupted builds; `/media` uses the same cleanup.
- **DB indexes** (additive): `idx_portfolio_active_order`, `idx_portfolio_img_order`,
  `idx_bookings_status_date`. `DATA_DIR` is now always absolute (`res.sendFile` refuses relative paths).
- **Tests**: `scripts/perf.js` (before/after harness), `scripts/weight.js` (per-request weight breakdown),
  `scripts/verify-pages.js` (56 checks: every page + all 202 referenced images load), `scripts/check-hero.js`
  (15 checks: deferred hero still crossfades). `smoke.js`'s "Our Services" assertion is now data-aware —
  the owner switched that section off in the dashboard, and the suite asserts the relationship instead
  of a fixed card count.



Admin edits write drafts (`site_content.draft_value`, `website_sections.draft_*`). **Publish** copies
draft→live in one transaction (content, sections, hero snapshot). **Cancel** resets draft←live.
`?preview=1` renders drafts **only for a logged-in admin**; anonymous requests silently get live.
Packages/cities/portfolio/add-ons/availability/bookings are data and apply immediately (prices must be
instant).

## Gotchas learned the hard way

- **The legacy tier seeder is guarded by `migration.v3_packages`.** Before that guard, every restart re-created
  Basic/Standard/Premium (3 → 12 packages) after the V3 collapse. Never re-introduce an unguarded seeder that
  inserts catalogue rows.
- **Hero snapshot must be INSERT … ON CONFLICT DO UPDATE.** A plain UPDATE silently affects 0 rows the first
  time, the snapshot never exists, and the public site falls back to the draft table (unpublished slides leak).
- **CSS cascade**: appearance tokens are injected in a `<style>` *after* `app.css`; before the stylesheet they
  were silently overridden by `:root`.
- Route handlers must use the mirrored `req.site` / `req.appearance`, not `res.locals`.
- `input[type=color]` can't be `fill()`ed in Playwright → set `.value` + dispatch `input` in `$eval`.
- `.site-nav` only fits 8 items from **1100px**; 900–1099px uses the mobile panel (don't add
  `display:none !important` at 900px or the toggle stops working).
- In Playwright here: **1 open tab per browser instance** (use a separate `chromium.launch()` for concurrency),
  and form posts need `waitForNavigation()` instead of `waitForLoadState()`.
- The published app's DB files are read-only from Bash. **Never test on `data/`** — copy to `/tmp/...` and run
  with `DLY_DATA_DIR=/tmp/...`.
- `data-price-*` attributes are not camelCased by `dataset` (hyphen+digit) → `getAttribute()`.
- Drive's `drive.file` scope only sees files the app itself created — folder lookup by name+parent works only
  because every folder was created by this app. Never switch to listing someone's whole Drive.
- Tests must derive "today" from the server (`/api/availability` returns `today` in WIB). The sandbox clock is UTC,
  so a local `new Date()` is one day behind and produces false "date not available" failures.
- `settings.gcal_account` stores the connected Gmail (taken from the calendar's `summary`, since
  `calendar.events` cannot read the profile). It used to hold the granted-scope string, which made it
  impossible to tell which account was connected. `gcal_checked_at` / `gdrive_checked_at` record the last
  successful self-check; the Google page shows a "Diagnostik koneksi" panel from these values.
- Google OAuth failures on the callback are translated through `OAUTH_HINTS` (access_denied,
  redirect_uri_mismatch, invalid_client, admin_policy_enforced, …) instead of showing raw codes.
- When testing calendar behaviour against REAL Google, always run on a DB copy and delete the created event
  afterwards (`DELETE /calendars/{id}/events/{eventId}`) so the owner's calendar stays clean.
- The Calendar `api()` helper retries once with a freshly minted token on HTTP 401 — without that, a stale
  in-memory access token silently breaks every sync after Google rotates it.
- When adding a column to a multi-row `INSERT`, count placeholders against the column list — a `status` literal
  at the end means placeholders must be `columns - 1`. A mismatch surfaces only at runtime as
  "N values for M columns" and the user sees a generic 500.
- **Admin badge/status text is uppercased by CSS**, so `innerText` from Playwright returns "PORTAL AKTIF",
  not "Portal aktif" — assertions must be case-insensitive. Same for "DIKIRIM:".
- **ImageMagick has no fontconfig on this host**: `-font DejaVu-Sans` only prints warnings and draws
  nothing; always pass an absolute `.ttf` path (`/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`).
- **Copying only `app.sqlite` loses recent rows** — this DB runs in WAL mode, so a test copy must include
  `app.sqlite-wal` and `app.sqlite-shm` (`cp data/app.sqlite*`). A copy without them looks empty.
- **A local named `drive` shadows the `require('../drive')` module** inside that route; it silently turned
  `drive.mode()` into `driveFolderFor().mode()`. Use `driveLink`/`driveResult` for locals.
- `scripts/smoke.js` still expects 4 services (`Our Services shows 4 services — cards=3` fails). The owner's live
  data has 3 service rows; it is a stale test expectation, not a regression. Update or relax that check when
  touching the suite.

## V3 migration notes (one-time, guarded by settings flags)

`migration.v3_packages` collapses the old Basic/Standard/Premium tiers into **one package per category**:
the package with the most durations survives, sibling durations are merged (prices kept, never invented),
bookings are re-pointed to the survivor, then unused duplicate packages are deleted. `migration.v3_sections`
orders homepage sections (hero → intro → featured → carousel → services → advantages → packages → process →
testimonials → cta) and `migration.v3_citycopy` updates the old city-page copy to "Archives by Location".

## Testing

```
# perf harness (spawns its own app on a /tmp DB copy):
node scripts/perf.js                 # numbers, per page
node scripts/weight.js / --mobile    # which requests are heavy
node scripts/verify-pages.js         # every page + every image
node scripts/check-hero.js           # hero slideshow after deferring slides
```

```
rm -rf /tmp/t && mkdir -p /tmp/t && cp data/app.sqlite* /tmp/t/
DLY_DATA_DIR=/tmp/t PORT=4420 node server.js &
SMOKE_BASE=http://127.0.0.1:4420 node scripts/smoke.js        # 136 checks
BASE=http://127.0.0.1:4420 node scripts/check-duration-photos.js  # per-duration photo count

# V9 portal — its own upload dir so fixture photos never land in public/uploads:
DLY_DATA_DIR=/tmp/t DLY_UPLOAD_DIR=/tmp/t/uploads PORT=4420 node server.js &
BASE=http://127.0.0.1:4420 DLY_DATA_DIR=/tmp/t node scripts/check-selection.js   # 77 checks

# V9.2 Drive import (spawns its own mock + app, needs nothing running):
node scripts/check-drive.js                                                     # 51 checks

# Google Calendar (no real credentials needed — points at the local mock):
node scripts/mock-google.js &
DLY_DATA_DIR=/tmp/t PORT=4520 GCAL_TOKEN_URL=http://127.0.0.1:4599/token \
  GCAL_API_BASE=http://127.0.0.1:4599/calendar/v3 node server.js &
BASE=http://127.0.0.1:4520 MOCK=http://127.0.0.1:4599 node scripts/check-gcal.js   # 65 checks
#   server also needs GDRIVE_API_BASE=http://127.0.0.1:4599/drive/v3
```
Covers: hero slideshow, nav/pages, city archives with inline pricelist, editorial cards + dynamic pricing,
add-on visibility rules, 3-step wizard (calendar, validation, review, totals), WhatsApp message fields,
server-side guards (price/date/terms), booking management + filters, availability block/reopen + rules,
draft→publish→preview isolation, section toggles, appearance colours, articles & FAQ CRUD, auth protection,
and mobile layouts at 390px. It cleans up everything it creates.

Default admin: `admin` / `DlyGraduation2025` (change in /admin/settings).
**No prices are seeded anywhere** — the owner fills them in Packages & Pricing / Package Durations.

## V11 — Tahap 3: admin dashboard, Kelola Booking, public redesign (2026-11-06)

Scope delivered here: Tahap 3A (dashboard + booking workflow + payments) and Tahap 3B
(pricelist + portfolio restoration). Tahap 4 (notifications/PWA) and Tahap 5 (editing
queue) are intentionally NOT implemented — both appear in the sidebar as disabled rows
with a "Tahap 4/5" chip, never as links that go nowhere.

### 3A — admin

- **`src/payments.js`** (new) is the single source for money and history:
  `summary(booking)` / `summariesFor(bookings)` derive everything from `booking_payments`
  rows (`total` comes from the booking's price snapshot, never re-invented), and
  `logEvent()` / `eventsFor()` / `recentEvents()` write/read `booking_events`.
  Tables are created additively in `db.js` (`booking_payments`, `booking_events` + 3
  indexes) inside the existing single bootstrap transaction.
  A booking with **no** payment rows reads `unrecorded` ("Belum Tercatat") or `unpaid`
  when a bill is known — no fake nominal is ever inserted.
- **Sidebar** (`views/admin/layout.ejs`): 6 collapsible groups (Dashboard, Konten Website,
  Katalog & Harga, Operasional, Komunikasi, Pengaturan) using `data-nav-group` +
  `[data-nav-toggle-group]`. The group holding the active page starts open; every other
  group's state is remembered in `localStorage` (`admin.js`), so it survives navigation.
  Badges are real counts (`navBadges`): pending on *Kelola Booking*, new bookings on
  *Overview*, submitted portals on *Seleksi Foto*. Mobile = drawer (`[data-side-toggle]`).
- **Overview** (`views/admin/dashboard.ejs`): navy hero (today/tomorrow/pending/new),
  5 stat cards (total, pending, confirmed, done, money received from recorded payments
  only), "Jadwal terdekat", "Perlu ditindak", "Aktivitas terbaru" (from `booking_events`),
  missing-price warning and quick actions.
- **Kelola Booking** (`views/admin/bookings.ejs`, route `GET /admin/bookings`):
  9 quick tabs (`Semua`, `Job Hari Ini`, `Job Besok`, `Booking Baru`, `Menunggu Konfirmasi`,
  `Confirmed`, `Sedang Berlangsung`, `Selesai`, `Dibatalkan`) + independent facets
  (kategori, kota, tim, status pembayaran, **one** `tanggal` date picker, search).
  Facets never clear each other (the tab travels in a hidden field; legacy `?status=`,
  `?dari=`, `?sampai=` still work).
  Four view modes share the same row set: `grid` (compact `.bk-card`), `calendar`
  (month grid, events coloured by status, day click → list filtered to that date),
  `list` (table + 20/page pagination), `kanban` (drag & drop → `POST
  /admin/bookings/:id/status`, backend validates the status, CSRF-checked, logged to
  `booking_events`). The chosen view is stored in `localStorage`.
- **Detail booking** (`views/admin/booking-detail.ejs`, `GET /admin/bookings/:id`):
  4 tabs — Klien / Pekerjaan / Pembayaran / Workflow. Saving from a tab returns to the
  same tab (`back_tab`). Two SEPARATE WhatsApp buttons are kept: **Konfirmasi Booking &
  DP** (`wa_confirm_template`) and **Kirim Link Portal Seleksi Foto** (`wa_portal_template`).
- **Payments tab**: records `amount`, `paid_at`, `method`, `note`; lists every payment with
  a delete action; shows Bill / Paid / Remaining / Status (`Belum Tercatat`, `Belum Bayar`,
  `DP Dibayar`, `Lunas`). Deleting a payment re-derives the status automatically.
  **Price snapshots are never rewritten** by any of this.
- `scripts/check-admin-t3.js` (72 checks) drives the whole flow on its own DB copy
  (filters, 4 views, kanban endpoint + CSRF, payments, tab persistence, mobile drawer,
  no horizontal overflow, no JS errors).

### 3B — public site

**The real cause of "tampilan jadi aneh" was a V10 side effect**: `images.picture()` emits
`width`/`height` ATTRIBUTES, which are presentational hints for the CSS `height` property.
Any element sized by `aspect-ratio` (carousel, intro media, hero cards) was therefore
rendered at the attribute height — the gallery carousel was **1889px tall per tile**.
Fixed with one zero-specificity rule near the top of `app.css`:

```css
:where(img[width][height]) { height: auto; }
```

`:where()` keeps specificity at 0, so every real `height:100%` rule (media boxes,
hero) still wins, while any element with no height rule falls back to its aspect ratio.
**Do not** change it to `img[width][height]` (specificity 0,1,1) — that beat `.hero__img`
and blew the hero up instead.

- **Pricelist** (`views/partials/package-browser.ejs` + the `V11 / Tahap 3B` block in
  `app.css`): photo-led editorial card. Media column wider than the text column from
  900px, stacked below it (photo in its own block) under 900px. Rounded 20px, 1px
  `--border`, soft shadow, best-seller badge on the photo, `--ar`-free (uses `object-fit`
  with `object-position: center 42%`). Body hierarchy: category → title → sold → desc →
  one compact fact line → duration chips (3-up grid, still `.dur-card` + `data-*` contract)
  → benefits (`package_benefits`, check icons in circles) → pinned price + CTA.
  `pkg.gallery` renders a small thumb strip when the package really has extra photos;
  every thumb is a lightbox trigger (`data-lightbox` + `data-more`).
  Card heights measured: 1440px → 633px (was 784), 390px → ~1120px (was 1451).
- **Portfolio / Gallery** (`views/gallery.ejs`, `views/partials/portfolio-card.ejs`):
  masonry keeps each photo's **natural aspect ratio** (`res.locals.imageAspect(src)` →
  `--ar`, from the dimensions index; fallback 4:5 when unknown, e.g. a fresh upload
  before the background indexer runs). No more forced `4/3` "wide" tile that cropped a
  portrait in half. `gallery-masonry` = 2/3 columns, consistent 12/16/20px gaps, 14–18px
  radius, soft shadow, hover lift. The homepage featured grid is uniform 4:5 (no lead
  tile, no cropped variants). The `?kota=` parameter still works, but the second row of
  city pills is gone (filters fit on one line; city is an admin concern now).
  The gallery page no longer duplicates the same photos in a carousel strip — the strip
  only appears when the owner marks items for the `carousel` collection.
- Filters: `Individual / Couple / Group / Graduation Event` (+ "Semua") as rounded pills.
- Lightbox unchanged (thumbs, counter, swipe); only radius/padding polished.

### Testing / tooling added

- `node scripts/measure-layout.js /pricelist --mobile` — boots a DB copy, prints section
  heights, component boxes and any **image rendered >1.35× its container** (that detector
  is what found the 1800px images).
- `node scripts/probe-lcp.js /` — throttled resource timeline (which request is late).
- `node scripts/review-shots.js` — demo-data screenshot set + `index.html` gallery written
  to `public/review-t3-c3fcc682f33c77b7/` (noindex, safe to delete; demo client names only).
- `scripts/perf.js` now copies `data/image-cache` into its temp dir (cold-cache runs made
  LCP look like 16s) and prints the LCP element.
- Updated stale assertions: `check-v8.js` ("tiles keep natural ratio" instead of
  "heights vary"), `check-duration-photos.js` (6 `.nav-group` blocks, not 5
  `.admin-nav__group`).

## V12 — Tahap 4 (notifikasi + PWA) & Tahap 5 (antrean editing)

Scope was agreed with the owner before building: **dashboard-only notification centre**
(no Web Push), **PWA installing the public pages with offline access** (home / pricelist /
portfolio), **three editing stages**, and **the client sees the editing stage** — status only,
never the internal note.

### Tahap 4 — notification centre (`src/notify.js`)

- **Nothing is stored.** Every item is derived from the database on each request, so a
  deleted booking simply stops appearing (no stale rows, no extra migration later).
- Five sources: `booking` (created within `settings.booking_new_days`), `payment`
  (`booking_payments.created_at`), `selection` (client submitted picks — an admin status
  change is NOT news), `deadline` (open portal, deadline ≤ +3 days or already passed and
  nothing submitted), `job` (shoot TOMORROW, status ≠ cancelled).
- **Unread = one watermark** (`settings.notifications_seen_at`, added by the bootstrap
  `setDefault`). Marking all read moves it to now. Deadline/job items carry **today's date
  at 00:00 UTC** as their timestamp, so they are unread once per day instead of being an
  un-clearable badge forever.
- Pages: `GET /admin/notifications` (+ `?tipe=`, `?baca=belum`) and
  `POST /admin/notifications/read`. Topbar **bell** (`.admin-bell` + unread badge) and the
  sidebar row both point there; `navBadges.notifications` is computed in the admin
  middleware.
- No WhatsApp reminders / no push subscription table — explicitly out of scope.

### Tahap 4 — PWA

- `GET /manifest.webmanifest` is **generated per request** (brand name, tagline, theme
  colour from appearance) and builds every URL from `req.basePath`, so it is correct both
  at `/dlygraduation/` and on a custom domain attached later. `short_name` = first word
  uppercased (`DLY`), never a chopped "Dly Graduati".
- Icons are generated by `node scripts/make-icons.js` (navy square + cream DLY monogram):
  `public/assets/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`. **Do not swap in
  the uploaded brand logo** — it is often a wide lockup and makes a bad app icon.
- `public/sw.js` rules, in priority order: admin and `/selection/*` are **never** cached
  (pass through to the network), `?preview=1` is never cached, only the public marketing
  routes are cached for navigation (network-first, cache only as a fallback), and
  `/assets|/media|/uploads|/ph` are cache-first because those URLs are versioned/hashed.
  Uncached navigation failures fall back to `public/offline.html` (self-contained CSS, no
  network).
- The worker is registered **inline in `views/layout.ejs`** (not in app.js) because the
  registration URL needs the server-computed `<%= base %>`: `register('<base>/sw.js',
  { scope: '<base>/' })`. It is skipped when `preview` is true.
- `src/app.js` static `setHeaders` forces `Cache-Control: no-cache` for `sw.js`; without it
  express.static's 7-day max-age can pin an old worker.
- Optional "Pasang aplikasi" chip (`[data-install-app]` in layout + the PWA block at the
  end of `app.js`): hidden unless `beforeinstallprompt` fires, dismissible via
  `localStorage`, never shown in standalone mode.
- Verified on the LIVE url by `scripts/check-live.js` (manifest at the subpath, icons,
  worker scope = app subpath, public pages cached, admin/portal never cached, pricelist /
  gallery / home opening with `context.setOffline(true)`).

### Tahap 5 — editing queue (`src/editing.js`)

- `editing_jobs` (additive, created in the bootstrap transaction): `booking_id`, `portal_id`,
  `status` (`queued|editing|done`), `editor_id` + `editor_name` snapshot, `due_at`, `note`
  (INTERNAL), `photo_count` snapshot, `started_at`, `finished_at`, `position`, timestamps.
  A **partial unique index** `idx_editing_active ON (booking_id) WHERE status IN
  ('queued','editing')` guarantees one active job per booking while keeping history rows.
- `POST /selection/:token/submit` enqueues automatically (wrapped in try/catch so a queue
  problem can never block the client's submit). The admin can also queue/requeue from
  *Detail Booking → Workflow* (`POST /admin/bookings/:id/editing`, idempotent — a double
  submission answers `msg=editing-already` instead of creating a second job).
- `GET /admin/editing` = 3-column board (Masuk Antrean / Diedit / Selesai) with drag & drop
  (`POST /admin/editing/:id/status`, JSON + CSRF, unknown stage → 422, optimistic move
  rolled back on failure). Per-card `<details>` form updates editor / target date / note.
- **Stage → client portal**: `editing` sets `photo_selections.status='processing'`, `done`
  sets `'done'` (queued leaves it alone). Every move writes a `booking_events` row
  (`kind='editing'`) so it appears in the booking activity history.
- **Client view** is `editing.clientView(portalId)` → `{status,label,hint,tone,index,stages}`
  only. `note` and `due_at` are deliberately absent; `scripts/check-t4-t5.js` asserts the
  internal note and the target date never appear in the portal HTML.
- The portal renders the status card (`views/selection.ejs` + the `sel-edit` block in
  `selection.css`, in `layout-portal.ejs` there is NO service worker, on purpose): 3-step
  progress strip + current stage label. `pendingView()` supplies the same strip with no
  active step when nothing is queued yet ("Menunggu masuk antrean"), so the client always
  sees the three stages instead of a paragraph.
- Booking detail Workflow tab now shows the real stage, links to the queue, and shows the
  internal note in an admin-only panel.

### Tests / tooling

- `node scripts/check-t4-t5.js` — **74 checks** (manifest/icons/worker/offline incl. admin
  NOT cached, all five notification sources + mark-all-read + filters, auto-queue on client
  submit, board/stages, drag endpoint validation, CSRF, portal mirroring, internal note
  isolation, idempotent enqueue, mobile overflow, no JS errors). Runs on its own DB copy.
- `scripts/check-live.js` gained the live PWA section (now **54 checks**).
- `scripts/review-shots.js` now also captures notifications, the editing board, the workflow
  tab and the client status card (clipped — the client's photos never appear in a PNG).
- **`check-admin-t3.js` is now data-aware**: the owner really uses the dashboard, so money
  assertions compare against the payments that already exist (`paidBefore`) instead of
  assuming an empty `booking_payments`. Same reason its sidebar check now expects
  *Antrean Editing* to be a real link. Never re-introduce "expects zero" money assertions.


## V13 — Tahap 6: Web Push, portfolio klien, carousel, UI/UX

### Web Push (`src/push.js`, `push-admin.js`, `/admin/push`)

- **Dependency**: `web-push@4` (pure JS, no native build). It is in `dependencies`, and
  `node_modules/` ships with the app — the platform does not run `npm install` on publish.
- **VAPID keys** are generated on the FIRST boot only (`push_vapid_public/private` in
  `settings`). Regenerating them invalidates every subscription, so the button is behind a
  confirm and `push.resetConfig()` clears the module's cached pair.
- **Tables**: `push_subscriptions` (`endpoint` UNIQUE — one row per device) and `push_log`
  (`dedupe_key` PRIMARY KEY). `push_log` is the "never notify twice" guarantee, across
  restarts and multiple admin tabs; `pruneLog()` keeps 180 days.
- **Events** (`EVENTS` in `src/push.js`): booking / payment / selection / deadline / job /
  editing. Each has its own admin toggle (`push_type_*`, editing defaults to OFF) plus a
  global `push_enabled`. `src/routes/{public,admin}.js` call `push.notify(...)` with a
  dedupe key; every call is wrapped so a push failure can never break the main action.
- **Payload is generic on purpose**: no client name, phone, amount or campus — the tests
  assert that. The detail lives behind the tap, and the tap opens an ADMIN url.
- **Dead endpoints** (404/410) are deactivated immediately, transient errors only increment
  `failures` + `last_error`. Nothing is retried forever.
- **Scheduler**: `startScheduler()` (hourly, first run +20 s after boot, `unref()`ed,
  `DLY_DISABLE_PUSH_SCHEDULER=1` disables it in tests) handles the two TIME-based events
  (deadline ≤3 days / passed, and tomorrow's shoot). Per-day dedupe keys mean an hourly
  tick notifies once per day.
- **Service worker**: the SAME `public/sw.js` (v2) gained `push` + `notificationclick`.
  Click URLs are re-prefixed with the SW scope AND resolved against
  `self.registration.scope`, otherwise a tap on a published subpath would open
  `https://host/admin/...` (404). Admin + `/selection/*` remain network-only.
- The permission prompt is requested ONLY in the button handler (`push-admin.js`), never on
  load; the iOS guide explains Add-to-Home-Screen (Web Push needs iOS 16.4+ AND standalone
  mode). `Notification.permission === 'denied'` is reported as such instead of silently
  failing.

### Portfolio — one public page per client

- `portfolio.slug` (UNIQUE index, backfilled once by `migration.v13_portfolio_slug`, derived
  from the client name) + `portfolio.session_time`.
- `/portfolio/:slug` (`views/portfolio-detail.ejs`): identity header (name+degree, campus,
  date, session time), cover + masonry gallery, lightbox with the whole set, "other clients"
  grid, CTA. **Only `is_active = 1`**; an unpublished slug answers 404 (not a soft "empty"
  page). Unpublished entries are also excluded from `sitemap.xml`.
- The data source is the `portfolio` + `portfolio_images` tables ONLY. Nothing is pulled
  from a booking, payment, or the client photo-selection portal — asserted by a test that
  greps the rendered HTML.
- **Cards now LINK to the client page** (`a.portfolio-card__btn`), they are no longer
  lightbox triggers. The lightbox moved to the detail page. `check-v8.js` was updated to the
  new flow deliberately.
- Admin form gained session time + slug (with a live preview of `/portfolio/<slug>` and a
  "Lihat halaman publik" link); editing covers name/degree, campus, date/time, cover,
  gallery photos, order, publish status, delete.

### Pricelist — package photo carousel

- `views/partials/package-browser.ejs` renders `.pkg-carousel` with one slide per photo
  (cover + `package_images`, de-duplicated). Autoplay 5.5 s, scroll-snap (native swipe),
  arrows + dots + counter, pauses on hover/focus/touch AND when the tab is hidden, and is
  disabled entirely under `prefers-reduced-motion`.
- Each slide keeps `data-lightbox` and the `pkg-feature__shot` class (older checks and the
  lightbox contract still work). The media box keeps its `aspect-ratio`, so a photo change
  never shifts the layout (verified by measuring card height before/after autoplay).
- Packages without photos render the navy placeholder — never a fake image.

### UI/UX

- **City buttons**: `.city-pill` (pin icon in a circle, radius 99px, navy fill when active,
  `aria-current`), used on /pricelist and the city archive page.
- **Category tabs**: `.cat-pill` cards — name → 1px divider → caption, rounded 16px, navy
  fill + white text when active, whole row animates in on switch.
- **Header**: the studio name next to the logo is gone. The name is only rendered when NO
  logo file exists (otherwise the header would lose its identity); `alt`/`aria-label` keep
  it for SEO/screen readers.
- **Mobile dropdown**: a floating rounded card under the header with a backdrop, animated
  open/close (`hidden` is restored only after the transition), Escape / outside click /
  resize closes it, hamburger morphs into an X (`.nav-open`).
- **Admin sidebar**: same 6 accordion groups, now with a group icon, fade+height transition,
  clearer active rail; collapsed rail shows icons only.
- **Typography**: default pair is now **Fraunces** (heading) + **Instrument Sans** (body),
  self-hosted in `public/fonts/*.woff2` and preloaded — when both are local **no Google
  Fonts request is made at all** (`theme.fontsUrl` becomes empty). `migration.v13_typography`
  only rewrites an UNTOUCHED previous default (Playfair/Cormorant + Inter); a deliberate
  choice is kept. New families (Newsreader, Instrument Serif, Karla) are in `FONT_OPTIONS`.
  A type scale (`--step-*`), `text-wrap: balance/pretty`, tabular numerals and a
  non-bold uppercase label style live at the end of `app.css`.

### Performance (measured with `scripts/perf.js`, mobile 390, Slow 3G)

| | Tahap 5 | Tahap 6 |
|---|---|---|
| Home | 971 KB · CLS 0.031 | **968 KB · CLS 0.001** |
| Gallery | 466 KB | 496 KB |
| Pricelist | 446 KB | 477 KB |
| Portal (45 photos) | 1014 KB | 1054 KB |

Self-hosting the fonts removed 2 requests (Google CSS + gstatic woff2) and killed the
font-swap CLS on the hero (`.hero__title { min-height: 2.1em }` reserves the two headline
lines). The carousel adds ~1 KB of JS and no extra image weight (same `<picture>` set).

### Tests

- `node scripts/check-t6.js` — **90 checks** (client page + card hierarchy + 404 for
  unpublished + lightbox set + no private data + sitemap + admin slug/session time +
  carousel autoplay/pause/dots/reduced-motion/no-shift + city pills + category cards +
  header + mobile dropdown + sidebar + typography). Own DB copy with seeded fixtures.
- `node scripts/check-push-engine.js` — **48 checks** with a STUBBED
  `webpush.sendNotification`: payload shape and the "no sensitive data" rule, dedupe,
  per-type + global toggles, 410 pruning, transient failures, device CRUD, scheduler
  idempotency, SW wiring.
- `node scripts/check-t6-live-copy.js` — **31 checks** on a copy of the REAL database:
  boot migrations, every public page without overflow, both fonts loading, and the push API
  (subscribe/upsert/test/settings/delete) with a fake endpoint.
- Updated older suites for the INTENDED new behaviour: `check-v8.js` (card → client page,
  lightbox on the detail page), `smoke.js` (reads `.admin-nav__label` instead of the whole
  `<a>`, which now contains a numeric badge).
- **Not testable here**: a real push delivery (no FCM/APNs from the sandbox, and headless
  Chromium cannot create a push subscription) and iOS Safari behaviour. Everything up to the
  last hop is covered; the owner must press "Aktifkan Notifikasi" on a real phone.

## V14 — Tahap 7: booking operations, team, Google, payments, reschedule, full booking

### Data model (additive, all idempotent)

- **`booking_team`** (booking_id, member_id, name, email, role, sort_order, UNIQUE(booking_id,
  member_id)). One booking may now carry SEVERAL crew members. Name/email/role are
  snapshotted so renaming/deleting a member never rewrites an old event. The legacy
  `bookings.team_member_id/team_name_snapshot/team_email_snapshot` columns are kept and
  mirrored to the FIRST member (old code, exports and tests read them).
  Backfilled once by `migration.v14_booking_team`.
- **`booking_reschedules`** — one row per reschedule (old/new date, time, location, reason,
  actor, gcal_status, gcal_error). The old schedule is never lost.
- `availability_overrides.full_booking` (manual Full Booking, separate from `is_available`),
  `bookings.confirmed_at`, `bookings.gcal_event_url`, `bookings.reschedule_count`,
  `booking_payments.kind` (`dp` | `settlement` | `manual`).
- `src/team.js` is the only writer for crew assignment (`setTeam`, `attendeesFor`,
  `conflictsOnDate`, `selectableMembers`). Only ACTIVE members can be picked.

### Confirmation (`POST /admin/bookings/:id/confirm`)

One button in Workflow → **Konfirmasi Booking**, with a JS summary (client, schedule,
location, package, team) before it runs. Server-side order: validate crew → availability
re-check (override checkbox + reason) → status `confirmed` + `confirmed_at` → `gcal.syncBooking`
(creates/patches the event, ensures the Drive folder) → activity log → push. Idempotent: a
second POST reuses the stored event id and folder (`ensureDriveFolder` re-verifies the cached
folder and only rebuilds it when Drive says 404). Each service reports its own success/failure
and the flash message never claims more than what happened.

### Google Calendar (`src/gcal.js`)

- Title is now **`Dly Visual | <first two words of the client name> | Graduation`**.
- Description contains name, **booking code**, campus, date/time, location, package, crew
  names, Drive link, notes and the H-1 template. `attendees` = every crew member with a valid
  email; `sendUpdates=all` on POST/PATCH/DELETE so Google emails the invitations.
  `setSyncState` also stores `htmlLink` (`gcal_event_url`) and the attendee list.
- **Team change after confirmation** PATCHes the SAME event: Google adds the new members,
  removes the ones no longer assigned, and mails them (`gcal.syncBooking` is called by the
  team route when the booking is already confirmed). No new event is created.
- **`gcal.resendInvites(bookingId)`** → `POST /admin/bookings/:id/resend-invites`: PATCH the
  existing event's `attendees` with `sendUpdates=all`, returns the recipient list, refuses when
  there is no event/connection/valid email.
- **Naming gotcha:** inside `buildEvent` never name a local `team` — it shadows the
  `require('./team')` module and silently printed `[object Object]` in the H-1 template.
  It is `teamLabel` now and `check-ops.js` asserts `[object Object]` never appears.
- **`gcalReady`/`driveReady` are `res.locals`.** Declaring `const gcalReady = ...` in
  `booking-detail.ejs` throws a TDZ ReferenceError; use different local names (`gcalOk`).

### Google Drive

Folder name is now **`<Client> - <Campus> - <Code>`** (`clientFolderName`). Existing folders
keep their old name — a cached folder is reused, never renamed or duplicated.
`POST /admin/bookings/:id/drive` remains the manual retry.

### Payments

`POST /admin/bookings/:id/payments/quick` with `kind=dp|settlement`:
- DP amount = `min(payment_dp_amount, remaining)` (Rp100.000 default);
- settlement = remaining;
- refuses an amount above the remaining bill unless `allow_over=1`;
- writes `booking_payments.kind` and logs an activity event.
Buttons only appear when they make sense (unpaid → DP; partially paid → Pelunasan; paid →
no buttons). The manual form stays visible for partial payments and is hidden when Lunas.
**Never touch `total_price_snapshot`.**

### Reschedule (`POST /admin/bookings/:id/reschedule`)

Edits the SAME booking (code, price snapshot, payments, Drive folder, portal, photo picks
untouched). Server validates: date format, time range, non-empty location, availability
(manual Full/Ditutup blocked unless `allow_override`, with a logged reason), capacity
(recomputed EXCLUDING this booking), and crew conflicts (blocked unless `conflict_ack`).
Then: update booking → insert `booking_reschedules` → activity log → `gcal.syncBooking`
(same event id, `sendUpdates=all` so the crew gets the updated invitation). The booking change
is saved even if Google fails, and the failure is reported as a separate status. The Workflow
tab shows the history (old → new, reason, calendar status) and a WhatsApp link built from the
last reschedule (never sent automatically).

### Full Booking / availability

`util.availabilityForRange()` now reports `{ available, reason, booked, capacity, manual_full,
closed, status }` with priority **Ditutup > Full Booking manual > kapasitas**. Manual flags
live in `availability_overrides.full_booking`; "Buka kembali" deletes the override so capacity
is recalculated (a genuinely full date stays full). Public calendar tooltips and the booking
form show a specific message ("Maaf, tanggal ini sudah Full Booking…"), and the server rejects
it with 422 — the availability check + INSERT now run inside ONE `db.transaction()` so two
simultaneous requests cannot take the same last slot.

### Admin UI

- Workflow is grouped: status summary → **Tim** (multi-select picker, warns about missing
  emails) → **Konfirmasi & Google** (confirm / resync / resend / open calendar / open Drive) →
  **Reschedule** (form + history + WhatsApp) → status/internal notes → activity history.
  All of it is wrapped in `<div id="workflow">`, because older code/tests select
  `#workflow .bd-update-form`.
- Availability: day cells are buttons opening a panel (Tandai Full Booking / Tutup / Buka
  kembali) with a note; the calendar shows bookings count and the four states + legend.
- Sidebar: same 6 accordions, now with group icons and a `padding-bottom` transition so the
  groups below move smoothly; `offsetTop` is what `check-ui7.js` measures (viewport rects go
  negative once the sidebar scrolls).
- Portfolio form rebuilt in 3 sections (Informasi Client / Cover & pengaturan / Galeri).
  Gallery: multi-file upload with client-side preview (name + size, remove before upload),
  XHR progress, separate URL path, drag & drop ordering **plus** ↑/↓ buttons for touch, and
  `POST /admin/portfolio/:id/photos/reorder` persists the order the public page renders.
- Pricelist category cards gained icons (user / two users / users) — names and data untouched.
- Admin form controls get `min-width:0; max-width:100%`; a `file` input with a long filename
  used to widen the whole page on a phone by 7px.

### Tests

- `node scripts/check-ops.js` — **62 checks** against `scripts/mock-google.js`: confirm →
  event title/description/attendees/timezone, Drive folder name, idempotent re-confirm,
  crew swap (attendees updated, no new event), resync, resend, DP → settlement → Lunas,
  reschedule (same event id, old schedule kept, WhatsApp text), manual full/closed/reopen,
  capacity auto-full, backend rejection with the exact message. No real Google call.
- `node scripts/check-ui7.js` — **47 checks**: category icons, portfolio identity on Gallery
  and Featured, client page, sidebar geometry (groups below really move up/down, animation
  samples monotonic), availability panel, portfolio form sections, multi-file preview,
  reorder persistence, mobile overflow at 390px.
- `scripts/smoke.js` updated to the new availability UI (day button + panel action) and
  reads `.admin-nav__label`; `check-v8.js` counts `.pf-photo` and uses `[data-upload-submit]`.
- `scripts/review-shots7.js` produces the Tahap 7 screenshot set + the exact Google payloads
  (`calendar-event.json`, `drive-folders.json`) in `public/review-t7/`.

### Late fixes found while running the suites against the LIVE-touched DB

- The owner now actively uses the dashboard (2 bookings, 3 push devices, a portal, one
  editing job). Tests must therefore never assume "the first queued card" is their fixture —
  `check-t4-t5.js` resolves its job id from the database by `booking_id`.
- `editing.setStatus` now resolves `portal_id` from the booking when the job was queued
  BEFORE its portal existed (that combination left the client status stuck on `submitted`).
- `check-t6-live-copy.js` measures push devices against a baseline: the real database already
  contains the owner's macOS/Android/iPhone subscriptions.
- Existing calendar events keep the OLD title until a resync. The owner can press
  **Sinkronisasi Ulang Google Calendar** per booking; we never touch their real calendar from
  the sandbox.

## V15 — Revisi pemilik setelah Tahap 7 (portal seleksi + penyederhanaan)

### 1. Sidebar accordion — celah kosong (BUG NYATA, sudah diperbaiki)

Gejala di screenshot pemilik: grup yang ditutup **tidak** mengecil, sehingga ada celah besar
di antara grup dan menu di bawahnya tidak naik.

Penyebab: `.nav-group__body { display:grid; grid-template-rows: 0fr }` hanya meringkas
**satu** baris. Grup punya 5–8 `<a>` anak langsung → baris pertama 0, sisanya masuk baris
implisit (`auto`) dan tetap setinggi penuh.
Perbaikan: semua item dibungkus satu `<div class="nav-group__inner">`, jadi grid selalu punya
tepat satu baris yang dianimasikan. Diukur di live: semua grup tertutup = top 106/142/178/214/
250/286, tinggi 34 masing-masing (rapat, tanpa celah).

### 2. Antrean Editing — editor dihapus, deadline otomatis 10 hari kerja

- Pilihan **editor dihapus** dari kartu job (dan dari `editing.update()`).
- Deadline = **10 hari kerja** (Sabtu/Minggu dilewati) sejak klien mengirim pilihan:
  `util.addWorkingDaysISO(todayISO(), 10)` di `editing.enqueue()`. `WORKING_DAYS = 10`.
- `src/db.js` punya SALINAN lokal `addWorkingDaysISO` (bukan require util) karena `util.js`
  me-require `db.js` → kalau di-require dari db akan sirkular.
- Migrasi `migration.v15_editing_due` hanya mengisi `due_at` yang **kosong** dari `created_at`;
  tanggal yang sudah diatur admin TIDAK ditimpa. Tenggat tetap bisa diubah manual.

### 3. Workflow booking — satu dropdown tim + satu tombol

- Tim = **satu anggota** lewat `<select name="member_id">`; **tidak ada tombol "Simpan tim"**.
- `POST /bookings/:id/confirm` sekarang menerima `member_id`, menyimpan tim lalu langsung
  mengonfirmasi (status + Calendar + Drive + undangan) dalam satu aksi.
- Setelah konfirmasi, dropdown yang sama menyimpan otomatis saat diganti
  (`[data-auto-submit-team]`) dan menyinkronkan attendees event yang sama.
- Semua bagian Workflow tetap dibungkus `<div id="workflow">` karena kode/pengujian lama
  memakai `#workflow .bd-update-form`.
- JANGAN menamai variabel lokal sama dengan res.locals (`gcalReady`, `driveReady`) di EJS —
  `const` dengan nama sama memicu TDZ ReferenceError (500).

### 4. Portal seleksi klien

- **Galeri bisa dilipat** (`.sel-foldable` + `.is-collapsed`, grid-template-rows dengan SATU
  wrapper). `hidden` harus punya aturan `display:none` eksplisit karena `display:grid` menang.
- **Tab**: Semua / Highlight / Terpilih / Swipe. Tab Highlight hanya muncul bila ada foto
  bertanda highlight (kolom baru `photo_selection_photos.is_highlight`, toggle di
  `/admin/selection/:id`). Swipe = mode satu foto besar + geser + tombol pilih.
- Counter besar di header memakai `data-sel-counter-big` (JANGAN `data-sel-counter` — itu
  sudah dipakai chip lain; dua elemen dengan atribut sama memicu strict-mode error).
- **Nama file untuk WhatsApp/daftar salin**: `selection.photoBaseName()` → tanpa nomor urut
  (`1. `), tanpa ekstensi (`.jpg`). Dipakai di `clientSubmitMessage`, `pickedFileList`,
  `selectedNames`, DAN respons `POST /pick` (`names`) — kalau salah satu memakai `photoName`
  (yang masih berekstensi), modal menampilkan `.jpg` lagi.
- Format pesan: `Hallo kak, Berikut untuk daftar foto edit aku yaa` → `Atas Nama:` →
  `Kampus:` → satu nama file per baris.
- `html { scroll-padding-top }` + `.sel-fold { position:relative; z-index:5 }` supaya tombol
  lipat tidak tertutup header sticky saat digulir.

### 5. Performa portal (keluhan utama: lambat di HP saat konfirmasi)

Akar masalahnya: setiap thumbnail pertama kali = **unduh master penuh dari Drive + convert
ImageMagick** (~1s/foto, 45 foto = puluhan detik), dan `loadSelectionPortal` membangun seluruh
konteks untuk SETIAP request gambar.

- `selection.warmPreviews(portalId, {width:320, concurrency:2})` mengisi cache di latar
  belakang; dipanggil setelah impor/sinkronisasi Drive, setelah upload, dan saat portal dibuka
  (via `warmPreviewsInBackground`, **jeda 4s** supaya HTML + thumbnail pertama tidak berebut CPU).
- `ensurePreview()` kini membangun SEMUA varian dari satu unduhan master (sebelumnya lightbox
  mengunduh ulang file yang sama).
- Lebar preview: **320 / 640 / 1600** (grid HP pakai 320; sebelumnya 400/800/1600).
- Convert: `-define jpeg:size=…`, `-strip`, progressive JPEG → decode lebih cepat.
- Route gambar memakai loader ringan `loadSelectionPhoto` (token → portal → foto), bukan
  `loadSelectionPortal` yang membangun booking + picks.
- Galeri: hanya 4 foto pertama `eager`, sisanya `lazy`.
- Diukur `node scripts/perf-portal.js` (390px, DPR2): **COLD** HTML 2.5s / 8 thumbnail 4.6s →
  **WARM** HTML 181ms / 16 thumbnail 760ms (**≈83% lebih cepat**).

### 6. Form Buat Portal (redesain, referensi Pilihin + brand DLY)

`views/admin/selection-new.ejs` → 4 bagian bernomor (Sumber Foto / Aturan Seleksi /
Informasi Client / Unduhan), kartu lebar nyaman, preset deadline 3/7/14/30 hari, switch
unduhan & wajib-kuota, satu tombol utama. Kelas CSS `xx-*` di `admin.css`.

### 7. Gotcha pengujian (UTC vs WIB)

`util.todayISO()` memakai **WIB**, sedangkan `datetime('now')` SQLite memakai **UTC**. Antara
17:00–24:00 UTC tanggalnya berbeda, sehingga:
- fixture uji "hari ini/besok" harus dihitung dari WIB (bukan `new Date().toISOString()`);
- `notify.js` meng-clamp `dayStamp` ke masa lalu (`Math.min(dayStamp, Date.now()-60s)`) —
  tanpa itu item "job besok"/"deadline" tidak pernah bisa ditandai terbaca.

### 8. Suite setelah revisi

`check-selection.js` **78** (termasuk nama file bersih), `check-ops.js` 61 (dropdown tim),
`check-ui7.js` 47, `check-t6.js` 90, `check-admin-t3.js` 72, `check-t4-t5.js` 75,
`check-v8.js` 73, `smoke.js` 135, `verify-pages.js` 56, `check-push-engine.js` 48.
Screenshot: `scripts/review-shots-rev.js` → `public/review-revisi/`.

## V16 — Client Portal (blueprint "PORTAL CLIENT DLY.pdf")

Fokus tahap ini: portal klien dengan **Kode Booking + PIN**, sidebar 4 menu, Ringkasan,
Pilih Foto Favorit, Pantau Order (timeline 8 tahap), dan Link Google Drive final.
Portal TIM belum dikerjakan (di luar cakupan blueprint).

### Kode booking baru + alias

- Format: `DLY-WISUDA-<NAMA><NNN>` (`src/bookingcode.js`). NAMA = kata pertama ≥3 huruf,
  uppercase, tanpa gelar; NNN = urut per nama, tidak pernah dipakai ulang.
- **Migrasi `migration.v16_portal`** mengganti kode SEMUA booking (pilihan pemilik) dan
  menyimpan kode lama di `bookings.legacy_code` (unique index parsial). Kode lama tetap
  bisa dipakai masuk portal → link/WhatsApp lama tidak mati.
- `POST /admin/bookings/:id/new-code` membuat kode baru; kode lama menjadi alias.
- PENTING: `util.bookingCode()` (format lama) tidak dipakai lagi di jalur booking publik;
  `bookingcode.generate()` dipakai saat booking dibuat. `smoke.js` sudah disesuaikan.

### Akses portal (`src/portal.js`, `src/routes/portal.js`)

- **Kode + PIN 4 digit**, tanpa akun/email/Google. PIN dibuat otomatis (migrasi V16b untuk
  booking lama, `ensurePin()` saat halaman detail/konfirmasi dibuka) dan **disimpan terbaca**
  karena admin harus bisa mengirimkannya lagi lewat WhatsApp; nilainya tidak pernah dirender
  di halaman klien.
- **Rate limit**: 8 percobaan gagal / 15 menit per IP (`portal_attempts`). Setelah itu pesan
  "Terlalu banyak percobaan…". Booking `cancelled` tidak bisa masuk.
- **Sesi**: tabel `portal_sessions`, cookie `dly_portal` (httpOnly, SameSite=Lax, 12 jam).
  `requirePortal` menjaga semua halaman `/portal/*`; data selalu diambil dari booking milik
  SESI — tidak ada parameter id di URL, jadi tidak ada IDOR.
- Halaman: `/portal` (masuk), `/portal/ringkasan`, `/portal/pilih-foto`,
  `/portal/pantau-order`, `/portal/drive`, `POST /portal/keluar`.
- Layout `views/layout-client.ejs` + `public/assets/client-portal.css/.js`: sidebar
  desktop permanen, drawer di mobile (backdrop, Escape, auto-tutup saat pilih menu).

### Ringkasan & timeline

- Ringkasan: identitas (nama+gelar, WhatsApp, IG, kampus, fakultas, jurusan, kode, tanggal
  booking, tanggal sesi, paket, persetujuan S&K + tanggal) + **status terbaru** + deadline
  editing + pintasan ke Pilih Foto / Foto Final.
- `src/timeline.js`: 8 tahap (01 konfirmasi → 08 foto siap). **Hanya tahap tercapai yang
  dirender** (bukan abu-abu). Tahap 06 & 07 aktif BERSAMAAN setelah submit. Setiap tahap
  dicatat di `booking_timeline` (UNIQUE booking_id+stage, idempoten) dengan aktor
  admin/sistem/klien; waktu ditampilkan WIB (`util.formatDateTimeWIB`).
- Deadline editing = **10 hari kerja** sejak pilihan dikirim; Sabtu/Minggu **dan hari libur**
  (`settings.portal_holidays`, satu tanggal per baris) dilewati. `addWorkingDaysISO(iso, n,
  holidays)`.

### Pilih Foto Favorit

- Markup pemilihan diekstrak ke `views/portal/partials/photo-app.ejs` dan dipakai DUA tempat:
  `/selection/<token>` (link token lama) dan `/portal/pilih-foto`. Satu file JS
  (`assets/selection.js`) mengurus keduanya; kuota & kunci tetap dijaga server.
- **Submit dua jalur**: `POST /selection/:token/submit` menyimpan pilihan + status + timeline
  DULU, baru klien diarahkan ke WhatsApp. Kalau klien tidak mengirim WhatsApp, data tetap
  tersimpan. Pilihan terkunci setelah submit (koreksi lewat admin).
- Klien **boleh submit di bawah kuota** (kecuali portal disetel wajib penuh).
- Nama file untuk WhatsApp/daftar salin (`selection.photoBaseName`):
  - file asli DLY → **dipertahankan persis** (`DLY00013` tetap `DLY00013`);
  - file non-DLY (mis. "Tangkapan Layar …") → nomor urut otomatis `DLY####` yang
    melanjutkan nomor DLY tertinggi (`photo_selection_photos.display_no`, stabil);
  - tanpa nomor urut pilihan & tanpa ekstensi.
- Pesan WhatsApp (blueprint §7.2): "Hallo kak, Berikut untuk daftar foto edit aku yaa" →
  `Atas Nama:` → `Kampus:` → satu nama file per baris.

### Link Google Drive final

- Admin: `POST /admin/bookings/:id/complete-order` menyimpan `final_url` + `final_at`
  (validasi harus tautan Drive) dan mencatat tahap 08. `clear=1` membatalkan.
- Klien: `/portal/drive` menampilkan "Foto Final Kamu" + tombol BUKA GOOGLE DRIVE hanya
  setelah `final_url` ada; sebelumnya "belum tersedia".

### Drive: subfolder 01/02/03

- `gcal.ensureSubfolders()` membuat `01. FILE MENTAH`, `02. FILE SORTIR`, `03. FILE EDIT`
  di dalam folder klien, menyimpan id di `bookings.drive_raw_id/drive_sortir_id/drive_edit_id`.
- Dipanggil otomatis saat folder dibuat DAN saat folder lama dipakai ulang (tanpa rename
  folder, tanpa memindahkan file). Ada tombol manual **Siapkan Subfolder 01/02/03**.

### Admin: kartu Client Portal di tab Workflow

Kode booking (+ alias), PIN (buat/reset), tombol **Kirim Kode & PIN via WhatsApp**, tautan
portal, link foto langsung, Selesaikan Order + link final, dan ringkasan timeline klien.
Template WhatsApp konfirmasi mendapat placeholder `{{kode}} {{pin}} {{portal}}`; bila
template pemilik belum memuatnya, blok akses ditambahkan otomatis di akhir pesan.

### Gotcha yang ditemukan saat mengerjakan ini

- `views/admin/booking-detail.ejs` TIDAK boleh memakai `res.locals` (tidak tersedia di EJS
  template) — pakai variabel `origin`. Dan jangan mendeklarasikan `const gcalReady`
  (TDZ, sudah dicatat di V15).
- Copy DB produksi **belum** punya kolom baru sampai app boot → fixture uji harus ditulis
  SETELAH server jalan (bukan sebelum).
- Playwright: `waitForNavigation` bisa kalah balapan pada POST→302 ke URL yang sama
  (form tim auto-submit, sync kalender). Pakai `submitAndSettle()` + verifikasi lewat DB.
- Token portal WAJIB hex 48 karakter (`portalByToken` menolak yang lain) — fixture screenshot
  sempat memakai token non-hex dan semua `/pick` menjadi 404.
- `data-sel-counter` vs `data-sel-counter-big`: dua elemen tidak boleh memakai atribut yang
  sama (strict mode error di Playwright).
- Pemilik menandai beberapa tanggal **Full Booking manual** (mis. 12 & 21 Nov 2026) dan
  mengubah font ke Montserrat. Uji tidak boleh mengasumsikan tanggal kosong / font default:
  fixture `check-ops.js` membersihkan override pada tanggal ujinya, dan
  `check-t6-live-copy.js` memvalidasi font terhadap `FONT_OPTIONS`, bukan nama tertentu.

### Tes

- `node scripts/check-portal.js` — **79 checks**: format kode, PIN admin, login (salah PIN,
  kode tak dikenal, kode lama/alias, huruf kecil), 4 menu, ringkasan, isolasi antar booking,
  buat portal dari admin, galeri, pilih/batalkan, submit di bawah kuota, simpan-sebelum-WhatsApp,
  nama file bersih, kunci setelah submit, timeline 05/06/07, deadline 10 hari kerja,
  drive final sebelum/sesudah, logout, rate limit, mobile drawer & overflow.
- `scripts/review-shots-portal.js` → `public/review-portal/` (18 tangkapan + index).
- Suite lain tetap hijau (smoke 135, selection 78, ops 61, ui7 47, t6 90, t4t5 75,
  admin-t3 72, v8 73, verify-pages 56, push 48, t6-live-copy 31).

## V17 — Revisi implementasi (notifikasi → carousel portfolio)

### 01. Notifikasi: audit + perbaikan (BUG NYATA)

**Bukti dari `push_log` produksi** (sebelum diperbaiki): `booking-confirmed:<id>:<Date.now()>`
(tidak idempoten), `booking:<id>` + `booking-confirmed:<id>` untuk booking yang SAMA (dobel),
`editing:2:queued/editing/done` tiga notifikasi dalam 15 detik, dan `job:<tanggal>` terkirim
saat server boot.

**Penyebab yang ditemukan:**
1. `POST /bookings/:id/complete-order` mengirim event **`job`** ("Jadwal pemotretan besok")
   dengan `force: true` → notifikasi "spontan" dengan isi tidak sesuai aktivitas.
2. Konfirmasi booking mengirim notifikasi `booking` KEDUA (booking baru sudah dinotifikasi
   saat dibuat) dan dedupe key-nya memakai `Date.now()` → tidak pernah dianggap duplikat.
3. Semua event di-broadcast ke semua perangkat (tidak ada role); setiap perpindahan tahap
   editing ikut mengirim push.
4. **Bug di engine:** `send()` memanggil `eventEnabled(def.setting)` padahal fungsi itu
   menerima JENIS event → SEMUA notifikasi dianggap `type-disabled` dan tidak terkirim.

**Perbaikan:**
- `EVENTS` v2 punya `role` (`admin` | `client`), `title`, `body(ctx)`, `url(ctx)`, `tag`.
  `recipientsFor(role, bookingId)` — **tidak ada broadcast lintas role**. `fg`/`editor`
  tercatat di `PREPARED_ROLES` tetapi tidak pernah dikirimi (Team Portal belum ada).
- **`event_id` deterministik** wajib untuk setiap kiriman; tanpa event_id → ditolak
  (`no-event-id`). Contoh: `booking:9:created`, `selection:7:submitted`, `booking:9:confirmed`,
  `booking:9:final`, `booking:9:reschedule:<rowId>`, `payment:<paymentId>`, `job:<tanggal>:<ids>`,
  `client-deadline:<portalId>:<tanggal>`, `test:<ts>`.
- Tabel **`push_deliveries`**: satu baris per perangkat per event (status sent/failed/gone,
  http_status, alasan, retry). Retry maksimal 2× untuk kegagalan sementara; 404/410 langsung
  menonaktifkan endpoint. Halaman `/admin/push` menampilkan log ini + toggle dikelompokkan
  per role + jumlah perangkat admin/client.
- Format isi (disepakati): title = nama event ("Booking baru masuk"); body =
  `"<Nama> - <Kampus>"` lalu kalimat ajakan. Nomor HP & nominal TIDAK pernah masuk payload.
- Client punya 5 notifikasi saja (dikonfirmasi, foto siap dipilih, pengingat deadline,
  foto final siap, jadwal berubah). Subscription client didaftarkan dari Client Portal
  (`POST /portal/push/subscribe`) dengan `role='client'` + `booking_id` milik sesi.
- Admin TIDAK menerima notifikasi saat client hanya mencentang foto; hanya saat submit.
- Scheduler: kiriman pertama 10 menit setelah boot (bukan 20 detik) supaya deploy tidak
  memicu notifikasi; event harian tetap idempoten per tanggal.
- Test: `scripts/check-push-rules.js` (24 checks) + `check-push-engine.js` (49 checks,
  disesuaikan ke eventId).

### 02–03. Client Portal responsif + login baru

- **`layout-portal.ejs`** kini mendukung `extraCss` → halaman login memuat
  `client-portal.css` (sebelumnya tidak termuat sama sekali, jadi modal login tampil tanpa
  gaya: kartu selebar layar, tombol kotak).
- Login: modal putih max 460px, radius 26px, latar gelap bergradasi + blur, heading
  "Selamat Datang" (Montserrat 600), eyebrow kapital ber-tracking, input tinggi rounded
  (14px), tombol **pill** navy selebar kartu, animasi masuk halus (dimatikan saat reduced
  motion). Diuji pada 320/390/820/1440 tanpa overflow.
- Mobile-first: ukuran teks, logo sidebar, footer, dan padding diperkecil di ≤640px;
  `env(safe-area-inset-*)` dipakai di topbar/footer/bottom bar.

### 04. Booking 24 jam

- Validasi server: jam 00:00–23:59 (sebelumnya 06:00–21:00). `input[type=time]` min/max
  diperbarui. Ketersediaan tanggal/slot tetap divalidasi terpisah.

### 05–07, 10. Portfolio carousel

- `views/partials/section-featured.ejs` → **carousel horizontal** (`[data-pf-carousel]`),
  menggantikan grid. Markup: heading (`Portfolio Highlights.`) + panah + tombol
  `EXPLORE MORE WORKS` + viewport scroll-snap + dots.
- Mobile: 1 kartu + peek (84%); ≥700px 46%; ≥1000px 30%; ≥1300px 28%. Kartu portrait 4:5,
  radius 18px, shadow lembut.
- Keterangan **menempel pada foto** (overlay gradient + text-shadow, tanpa kotak solid),
  **dua baris**: nama (Montserrat 700) dan `Kampus • Tanggal` (Montserrat 500).
  `section-06`: garis kedua memakai `•`; kota global tetap didukung sebagai baris tambahan
  hanya bila admin menyalakannya.
- `public/assets/portfolio-carousel.js`: scroll container = **viewport** (bukan track!),
  titik snap dihitung dari `offsetLeft` tiap slide (bukan kelipatan lebar) agar slide
  terakhir yang hanya sebagian tergeser tetap tercapai; autoplay berhenti saat interaksi
  (pointer/touch/wheel/hover/focus) dan lanjut setelah 9 detik; reduced motion → mati;
  `startAuto()` dicoba ulang setelah `load` karena `maxScroll` masih 0 saat script jalan.
- Tipografi carousel & overlay memakai **Montserrat** (bukan serif) sesuai keputusan akhir.

### 08–09. Hero, heading, paket

- Hero: judul putih (bobot 600), overlay sisi teks lebih tegas, tombol portofolio
  `btn--hero-primary` (navy + teks putih, font 700), ukuran judul mobile dibatasi.
- Heading `h1–h5` + `.section-head h2` → 600; `.pkg-feature__title` 700; harga total 700;
  deskripsi tetap 400 (hierarki terjaga).
- Indikator "N Sesi Telah Dipesan" pindah ke **samping judul paket** (`.pkg-feature__titlerow`)
  dengan dot beranimasi `soldPulse` (dimatikan saat reduced motion) dan hanya muncul bila
  `sold_count` dari database ada.

### Tes

- `scripts/check-rev2.js` — **64 checks** (carousel desktop/mobile/autoplay/pause/reduced
  motion/caption 2 baris/Montserrat/overlay, hero, paket & indikator, booking 24 jam,
  login portal 4 ukuran layar, halaman portal tanpa overflow).
- Suite lain tetap hijau: smoke 135, portal 79, selection 78, ops 61, ui7 47, t6 90,
  t4t5 75, admin-t3 72, v8 73, verify-pages 56, push-engine 49, push-rules 24,
  t6-live-copy 31.
- Penyesuaian uji karena perilaku SENGAJA berubah: `check-v8.js` (homepage = carousel),
  `check-selection.js` (nama klien di portal menyertakan gelar), `check-push-engine.js`
  (eventId menggantikan dedupeKey).
- Screenshot: `scripts/review-shots-rev2.js` → `public/review-revisi-2/`.

## V18 — Revisi lanjutan (gallery slider, logo portal, status sesi real-time)

### 01. Audit notifikasi (tanpa perubahan kode — hasil audit)

Bukti dari `push_log` + `push_deliveries` produksi sesudah perbaikan V17:
- Setelah 2026-11-07 16:37 hanya ada kiriman nyata: `booking:14:created` (3 perangkat admin)
  dan `booking:14:confirmed` (0 kiriman karena belum ada subscription role `client`), plus
  dua `test:<ts>` yang dikirim MANUAL dari `/admin/push`.
- Tidak ada baris `job:<tanggal>`, `editing:*`, atau event dengan `event_id` NULL setelah
  perbaikan → tidak ada notifikasi spontan/palsu lagi. Scheduler tetap idempoten per tanggal
  dan tidak mengirim saat boot.
- Kesimpulan: aturan role/event_id/log V17 tidak diubah pada revisi ini.

### 11–12. Gallery publik = horizontal auto-slider (bukan masonry 2×2)

- `views/gallery.ejs` sekarang merender `<div class="pf-carousel pf-carousel--gallery"
  data-pf-carousel>` (track + viewport + dots + panah). Grid `gallery-masonry` dan tombol
  "Muat lebih banyak" DIHAPUS dari halaman ini.
- Kartu memakai `partials/portfolio-card.ejs` yang sama → overlay Nama Client (Montserrat 700)
  dan `Kampus • Tanggal` (Montserrat 500) dari data portfolio, bukan caption terpisah.
- `public/assets/portfolio-carousel.js` sekarang menginisialisasi SEMUA `[data-pf-carousel]`
  (bukan hanya yang pertama) dan mencari panah di dalam root (fallback ke `<section>` terdekat
  untuk homepage yang menaruh panah di header). Tanpa clone slide → tidak ada duplikat
  untuk screen reader.
- **Gotcha penting:** `scroll-snap` memakai *snapport*; kalau viewport punya `padding-left`
  besar (desktop full-bleed) tetapi `scroll-padding-left` tidak disamakan, slide pertama
  "terkunci" di posisi padding dan carousel hanya bisa bergeser ±25px. Karena itu
  `.pf-carousel__viewport { scroll-padding-left: <padding-left yang sama> }` wajib.
- `step()` juga melewati posisi scroll kembar (slide terakhir di-clamp ke `maxScroll`) supaya
  panah/autoplay tidak macet dan tetap berputar ke awal.

### 13 & 17. Badge jumlah sesi + harga panel "Harga"

- Halaman `/paket/:slug`: judul + badge dipindah ke `.pkg-detail__titlerow` (satu baris), badge
  memakai `.pkg-sold--inline` (bukan chip abu terpisah di baris meta).
- `.pkg-sold--inline` diberi soft blue glow (2 lapis box-shadow) + dot `soldPulse`.
- `.pkg-detail__price strong` 500 → **700** (sama dengan sticky booking bar). Judul paket 700.

### 15. Logo resmi di login Client Portal

- `views/portal/login.ejs`: `.cp-login__mark` ("DLY" kotak biru) diganti `picture(settings.
  selection_portal_logo || brand.logos.headerDark || brand.logos.headerLight)` — asset yang
  sama dengan header website. CSS `.cp-login__logo` (height clamp 84–112px, object-fit contain)
  supaya ruang transparan asset tidak membuat logo terlihat kecil.
- Fallback teks "DLY" hanya dipakai bila belum ada file logo sama sekali.

### 14 & 18. Timeline checkmark + tahap 03 otomatis saat jam sesi

- **Bug nyata:** `views/portal/timeline.ejs` memakai `<%= '&#10003;' %>` → EJS meng-escape,
  sehingga tahap selesai menampilkan teks literal `&#10003;`. Diganti SVG centang.
- `src/timeline.js`: tahap 03 (`session_done`) kini dicatat **tepat saat jam sesi tiba**
  (`shooting_date` + `shooting_time` WIB), bukan setelah `durasi + 60 menit`. Judul tahap
  menjadi "Sesi Pemotretan Dimulai". `happened_at` = jam mulai sesi (UTC di DB, tampil WIB).
- Idempoten lewat `UNIQUE(booking_id, stage)` + `INSERT OR IGNORE`; reschedule sebelum sesi
  otomatis memakai jadwal terbaru. Baris lama TIDAK dihapus (riwayat tetap).
- Copy pengingat `SESSION_REMINDER` tampil di kartu status + timeline hanya saat tahap 03 aktif.
- **Auto-refresh:** `timeline.list()` mengembalikan `nextSessionAt` (epoch ms). Route baru
  `GET /portal/status` (JSON, tanpa data pribadi) + `client-portal.js` menjadwalkan reload
  tepat pada `nextSessionAt` dan polling 45 detik sebagai jaring pengaman. Tidak perlu refresh
  manual; jam perangkat client tidak dipakai untuk menentukan status.
- Badge "Sedang Berlangsung" kini compact (Montserrat 600), punya dot hijau `cpLivePulse` +
  soft glow; indikator tahap aktif `cpDotPulse`. Semua animasi mati saat reduced motion.
- Halaman admin (`/admin/bookings/:id`) memakai `timeline.list()` yang sama → judul tahap 03
  ikut berubah; tidak ada kolom/timestamp lain yang diubah.

### Tes

- `scripts/check-rev3.js` — **42 checks** (unit transisi 04:22:59 vs 04:23:00 + idempotensi,
  gallery satu jalur desktop/mobile, overlay Montserrat, autoplay + putaran panah, swipe,
  reduced motion, "Portfolio klien lain" mobile, badge/harga paket, logo login,
  status/timeline/pengingat, kontrak `/portal/status`, auto-reload tepat waktu).
  `REV3_FAST=1` melewati uji tunggu ~1 menit.
- Diperbarui karena perilaku SENGAJA berubah: `check-v8.js` (gallery masonry → carousel satu
  jalur + crop 4:5).
- Suite lain dijalankan ulang: check-rev2 64, smoke 135, portal 79, t4t5 75, verify-pages 56,
  v8 73 — semua hijau.

### Gotcha pengujian (2026-11-08)

- **File bernama `app.sqlite` di dalam folder app diproteksi platform**: `rm`/`mv` ke nama lain
  gagal dengan `Device or resource busy` walau tidak ada proses yang membukanya. Jangan
  membuat salinan DB uji di dalam folder project — salin ke `/tmp` **di dalam satu proses
  skrip** (pola `spawn` + `DLY_DATA_DIR=/tmp/...`). `/tmp` juga tampak bersih antar pemanggilan
  Bash, jadi selesaikan copy + uji + kill app dalam satu perintah.
- Jam sistem sandbox = UTC; DB menyimpan timestamp UTC (`datetime('now')`). Jam sesi booking
  adalah WIB, jadi perbandingan wajib memakai `...+07:00` dan `toISOString()` untuk menyimpan.
- **Slide carousel wajib `min-width: 0`.** Tanpa itu, `min-content` gambar membuat slide
  melebar melebihi `flex-basis` di HP 320px (kartu 320px di dalam viewport 276px, terpotong).
  Berlaku juga untuk carousel homepage yang sudah ada sejak V13.


## V19 — Revisi pemilik #2 (captions, grid portfolio, dropdown nav, logo adaptif)

### BUG NYATA — nama client tidak pernah terlihat di kartu portfolio

`public/assets/app.css` punya `.portfolio-card__btn img { position: relative; z-index: 1 }`
(placeholder shimmer V10). Gradient + caption posisinya `absolute` **tanpa z-index**, jadi
foto menutupi keterangan di SEMUA kartu portfolio (gallery, homepage, carousel "klien lain").
Dibuktikan dengan `document.elementFromPoint()` pada titik tengah caption → hasilnya `<img>`.
Perbaikan: `.portfolio-card__shade { z-index: 2 }`, `.portfolio-card__caption { z-index: 3 }`,
`__count`/`badge-sample { z-index: 4 }`. **Kalau caption "hilang" lagi, cek stacking ini dulu.**

### Portfolio jadi DINDING GRID (bukan carousel geser)

- Class baru `.pf-wall` (`public/assets/app.css`): 1 kolom < 700px, 2 kolom ≥ 700px,
  3 kolom ≥ 1024px; gap 18 / 22 / 26px. Kartu portrait 4:5, radius 18px, shadow lembut.
- `views/gallery.ejs` & `views/partials/section-featured.ejs` memakai `.pf-wall`
  (`data-portfolio-wall`) + `partials/portfolio-card.ejs`. Tidak ada lagi
  `data-pf-carousel`, panah, dots, autoplay, atau tombol "Muat lebih banyak" di dua tempat itu.
- Slide wajib `min-width: 0` (di bawah ini) — kalau tidak, `min-content` gambar membuat kartu
  melebar melebihi kolom di layar 320px.
- `.pf-carousel` MASIH dipakai untuk "Portfolio klien lain" (`views/portfolio-detail.ejs`)
  dan `section-carousel.ejs` (strip carousel lama di halaman gallery), jadi CSS/JS-nya jangan
  dihapus. `portfolio-carousel.js` sekarang menginisialisasi SEMUA `[data-pf-carousel]`.

### Menu dropdown "Lokasi" & "Paket" (`views/partials/header.ejs`)

- Dua tombol dropdown di `.site-nav` (urutan: Home, Gallery, **Lokasi ▾**, **Paket ▾**,
  Pricelist, Cara Order, …). Data dari `res.locals.navLocations` / `navPackages`
  (`src/app.js`, query aktif-nyata: kota yang punya paket aktif; paket `is_active = 1`).
- Lokasi → `/city/<slug>` (+ "Semua lokasi" → `/city`), Paket → `/paket/<slug>`
  (+ "Semua paket & harga" → `/pricelist`).
- **Jangan tampilkan harga (Rp) di panel dropdown**: `scripts/check-t6.js` menjaga halaman
  portfolio klien agar tidak memuat pola harga/pembayaran; harga di nav membuatnya gagal.
- JS: `initNavDropdowns()` di `app.js` (satu panel aktif, Esc/klik luar menutup, hover di
  desktop, accordion `[data-mobile-group]` di menu mobile).
- Lebar 1100–1279px: gap & font nav dikecilkan supaya 8 item + CTA tetap satu baris
  (diuji 1100/1200/1280/1440 tanpa overflow).

### Logo adaptif warna (tidak perlu upload dua file)

- `src/images.js`: `logoTone(src)` mendeteksi warna asli logo dari histogram piksel opak
  (≥0.62 = terang, ≤0.42 = gelap, selain itu "unknown" → dipakai apa adanya),
  `buildLogoInk(src, tone)` membuat turunan alpha-preserving dengan RGB diganti
  (`#FFFFFF` atau `#0B2340`), `logoSet(candidates)` memilih sumber per tinta.
- Route `GET /logo/<token>.png` (`src/app.js`) menyajikan turunan tsb; token = base64
  `tone|src` sehingga URL-nya self-healing (cache boleh dihapus).
- `res.locals.logoFor(src, tone)` + `brand.logos = { onLight, onDark, ... }`.
  Pemakaian: header (`--solid` = onLight di header putih, `--over` = onDark di atas hero),
  footer (gelap → onDark), sidebar portal klien (gelap → onDark), header portal & kartu
  login (putih → onLight).
- Kelas CSS logo berubah: **`logo__img--over` (putih) / `logo__img--solid` (gelap)**
  menggantikan `--light` / `--dark`. Aturan tampil: `--solid` default, `--over` hanya saat
  `.site-header--over:not(.is-scrolled)`.
- Kondisi situs saat ini: admin mengunggah logo navy (`...-2-*.png`) dan logo putih
  (`...-*.png`), jadi keduanya dipakai apa adanya tanpa turunan.

### Tes

- `scripts/check-rev3.js` — **45 checks** (gallery grid + caption benar-benar di atas foto,
  mobile 1 kolom, dropdown Lokasi/Paket dari data, logo adaptif + file logo 200,
  paket badge/harga, timeline/status, auto-refresh). `REV3_FAST=1` melewati tunggu 1 menit.
- `scripts/check-rev2.js` — 63 checks (bagian carousel homepage diganti grid 3/2/1 kolom).
- `scripts/check-v8.js` — 73 checks (gallery & homepage: masonry/carousel → grid).
- `scripts/check-v4.js` — diperbaiki: regex kode booking masih format lama
  (`DLY-\d{6}-[0-9A-F]{4}`) sehingga 6 check gagal sejak V16. Sekarang
  `/DLY-[A-Z]+-[A-Z0-9]{3,}\d{3}/`; **ALL PASSED**.
- Suite lain tetap hijau: smoke 135, portal 79, t6 90, t4t5 75, verify-pages 56,
  selection 78 (jalankan dengan `DLY_DATA_DIR=...` untuk proses tesnya juga, kalau tidak
  fixture booking dilewati), push engine/rules, ui7.
- Screenshot: `scripts/review-shots-rev3.js` → `public/review-revisi-3/`
  (gallery grid, dropdown Paket/Lokasi, paket, login, status, timeline).

## V20 — Logo seragam + logo/favicon di admin & portal (2026-11-08)

### Kenapa logo terlihat kecil / tidak sama di tiap halaman

File logo pemilik adalah kanvas besar dengan ruang transparan menganga:
`DLY-GRADUATION-2-*.png` = 5000x4000 px tapi artwork-nya hanya 4480x2234,
`DLY-GRADUATION-*.png` = 1620x1620 tapi artwork 1063x521. Selama file mentah dipakai,
`height: 40px` hanya menampilkan artwork ~22px → logo tampak kecil DAN berbeda antar
halaman (header 38px vs 40px vs 34px mobile vs sidebar portal 32/26px vs login 84–112px).

**Perbaikan:** semua logo sekarang lewat turunan `/logo/<token>.png` yang di-`-trim` dan
di-resize (maks 560px). Tone baru **`keep`** = jangan diwarnai, hanya trim — dipakai ketika
warna asli logo sudah cocok dengan latarnya. Dulu kasus itu mengembalikan file MENTAH
(`if (natural === tone) return src`), jadi padding-nya masih ada; sekarang selalu turunan.
`logoUrlFor()` dan `logoFor()` di `src/app.js` memakai aturan `natural === tone ? 'keep' : tone`.

Satu token ukuran: **`--logo-h: 40px`** di `app.css`, `admin.css` (dan fallback
`var(--logo-h, 40px)` di `selection.css` / `client-portal.css`). Kelas yang memakainya:
`.logo__img` (header + footer publik), `.portal-brand__logo` (header portal seleksi),
`.cp-side__logo` (sidebar portal client), `.cp-login__logo` (login portal),
`.admin-side__logoimg` (sidebar admin + login admin). **Jangan** menulis tinggi px lain —
kalau butuh ubah ukuran, ubah `--logo-h` saja.

Pengecualian satu-satunya: rail admin yang diciutkan (`body.side-collapsed`, lebar 78px,
isi 58px) — logo 82px tidak mungkin muat, jadi di sana `width: 100%; max-width: 58px`.

### Logo resmi di Dashboard Admin & login admin

`views/admin/layout.ejs` dan `views/admin/login.ejs` sebelumnya memakai `<span>` "DLY"
(kotak krem). Sekarang memakai asset resmi: sidebar gelap → `brand.logos.onDark` (putih),
kartu login putih → `brand.logos.onLight` (navy). Teks "DLY" hanya fallback bila belum
ada file logo sama sekali.

### Favicon logo DLY di semua permukaan

Sebelumnya `views/admin/layout.ejs` + `layout-blank.ejs` meng-hardcode
`/assets/favicon.svg` (ikon topi wisuda generik), sedangkan layout publik/portal memakai
`settings.favicon_custom` — yang isinya logo lockup lebar, sehingga di tab browser nyaris
tak terlihat.

Route baru **`GET /favicon/<token>.png`** (`src/images.js: buildFavicon`): artwork logo
di-trim → dijadikan putih → diletakkan di tengah kotak navy `#0B2340` 256x256. Ini memakai
artwork resmi (tidak menggambar ulang logo dengan teks/ikon lain, sesuai revisi 15).
Token = base64 `favicon|<src>`; cache di `data/logo-cache/fav-<sha1>.png` (immutable).
`res.locals.favicon = { src, fallback }` dipakai oleh kelima layout (publik, admin,
admin-blank, portal seleksi, portal client). Fallback tetap `/assets/favicon.svg`.

### Bug tambahan yang ditemukan saat verifikasi

`addColumn('booking_payments', 'kind', …)` di `src/db.js` dijalankan SEBELUM
`CREATE TABLE IF NOT EXISTS booking_payments` → boot pada database BARU crash
(`no such table: booking_payments`). Baris itu dipindah ke setelah blok CREATE TABLE.
DB yang sudah ada tidak terpengaruh (`addColumn` no-op).

### Tes

- `scripts/check-logo-size.js` — **127 checks**: tinggi logo = 40px di home (desktop/
  tablet/mobile), pricelist, gallery, booking, login portal (HP + desktop), header portal
  seleksi, sidebar admin + admin mobile, login admin; semua URL logo = turunan `/logo/`;
  favicon `/favicon/` 200 + `image/png` + 256x256 + berisi artwork (>8 warna); tidak ada
  horizontal overflow di 390/820/1440; rail ciut tetap memuat logo.
- `scripts/check-rev3.js`: assertion "logo login > 60px" diganti "tinggi 40px seragam"
  (perilaku SENGAJA berubah). 43 checks hijau.
- `verify-pages.js` 56, `smoke.js` 135 hijau.

### Status revisi dokumen "REVISI 1" (audit 2026-11-08)

Sudah ada (V17–V19, tidak diubah lagi): notifikasi role/idempotency/log, portal client
responsif, login modal, booking 24 jam, carousel/grid portfolio + overlay caption
Montserrat, hero putih + tombol portfolio, heading & harga tebal, badge jumlah sesi di
samping judul, checkmark timeline, tahap 03 otomatis, logo login portal, Portfolio
Highlights (`/gallery`) + detail per karya (`/portfolio/:slug`), penanda unggulan
(`portfolio.is_featured`) + urutan (`sort_order`).

Belum diimplementasikan (menunggu keputusan pemilik): v13 (Featured Portfolio Home sebagai
carousel autoplay yang BERBEDA dari gallery — sekarang keduanya `.pf-wall`), v14 (tab admin
Detail Booking/Pembayaran/Workflow, hapus panel "Status & catatan internal", hapus input URL
Drive di Foto Final, portal pilih foto selaras portal client, tombol "Lihat Foto Mentah
Lengkap"), v15 (aksi admin "Buka Kembali Portal" + alasan + audit log), v16 (tipografi
Dashboard Admin → Montserrat; sekarang heading masih Cormorant Garamond + body Inter).

## V20 — Carousel portfolio, v14 (admin booking + portal pilih foto), v15 (reopen + PIN hash), v16 (tipografi admin)

### Carousel portfolio (dokumen revisi 11/12/16 + v13)

Dua varian carousel yang SENGAJA berbeda (dulu keduanya `.pf-wall` grid):

| | Home — Featured Portfolio | Gallery / Portfolio Highlights |
|---|---|---|
| Sumber | HANYA `portfolio.is_featured = 1` (+ `sort_order`) | semua karya `is_active = 1` |
| Markup | `.pf-carousel--featured`, **tanpa dots** | `.pf-carousel--gallery`, **dengan dots** |
| Perilaku | autoplay 6 dtk, panah + `EXPLORE MORE WORKS` | autoplay 5,2 dtk + panah + dots |

- `views/partials/section-featured.ejs` **tidak merender apa pun** bila belum ada karya
  unggulan (tidak ada fallback ke seluruh portfolio, tidak ada data dummy).
- `/gallery` tidak lagi memuat strip `section-carousel` di atas grid (dulu karya tampil DUA
  kali di halaman yang sama).
- `public/assets/portfolio-carousel.js` sekarang memuat **semua** `[data-pf-carousel]` dan
  menambahkan **drag dengan mouse** (dulu hanya bisa natively di layar sentuh):
  `pointerdown/pointermove/pointerup`, snap dimatikan sementara, klik setelah menyeret
  diblokir lewat capture-phase listener. Tanpa ini panah bekerja tapi drag tidak.
- `#home` & `/gallery` memuat `portfolio-carousel.js` dari `layout.ejs` (halaman detail karya
  memuatnya sendiri).
- **Rasio kartu dipindah ke figure** (`.pf-carousel .portfolio-card { aspect-ratio: 4/5 }`
  + `.portfolio-card__btn { position:absolute; inset:0 }`). Sebelumnya `height:100%` pada
  slide membuat figure lebih pendek dari gambarnya (320 vs 425 px) sehingga overlay caption
  keluar dari foto — ini yang membuat tes "caption di dalam foto" gagal.
- `max-width` di desktop (400–430px) supaya carousel tetap bisa digeser saat karya sedikit.

### v14 — Detail booking admin & Portal Pilih Foto

- Tab: **Detail Booking · Pembayaran · Workflow** (3). "Identitas Client" + "Detail
  Pekerjaan" digabung ke panel `#detail`. URL lama `?tab=klien` / `?tab=pekerjaan` tetap
  bekerja (dipetakan ke `detail`) — lihat `tab:` di `GET /admin/bookings/:id`.
- Panel "Status & catatan internal" **dihapus**; kemampuan ubah status dipindah ke form
  ringkas `.bd-statusform` di Workflow (mengirim `internal_notes` lewat hidden input supaya
  catatan lama tidak terhapus oleh route `/update`). Aksi "Buka antrean"/"Masuk Antrean
  Editing" dipindah ke baris "Status editing".
- **Foto Final tanpa input URL**: `POST /bookings/:id/complete-order` memakai
  `bookings.drive_edit_id` (folder "03. FILE EDIT"), menyiapkan subfolder bila perlu, lalu
  **memvalidasi** lewat `gcal.driveFolderInfo()` (baru): `GET /files/{id}` → 404/403/trashed
  ditolak dengan pesan yang bisa ditindaklanjuti, order TIDAK ditandai selesai. Link final
  yang disimpan = `webViewLink` ASLI dari Google, bukan URL yang dirakit sendiri.
  Idempoten: klik berulang tidak menambah timeline/notifikasi/log.
- Portal Pilih Foto: banner "Mode admin — portal ini sedang…" diganti chip ringkas
  `.sel-adminchip`; tombol **"Lihat Foto Mentah Lengkap Kamu di Sini"** memakai
  `drive.raw` = `https://drive.google.com/drive/folders/<drive_raw_id>` (dibentuk dari ID
  yang TERSIMPAN, hanya dirender bila ada). Kartu yang sama muncul di Portal Client
  (`portal/foto.ejs`).

### v15 — Buka kembali portal setelah deadline + PIN di-hash

- Tabel baru **`selection_access_log`** (portal_id, booking_id, action, actor, reason,
  old_deadline, new_deadline, result, ip, created_at UTC → tampil WIB).
- Route admin baru: `POST /admin/selection/:id/reopen` (wajib deadline baru ≥ hari ini,
  alasan ≥5 karakter, `confirm=1`) dan `POST /admin/selection/:id/close` (alasan wajib).
  Toggle buka/tutup lama ikut mencatat log. Semua tercatat juga di `booking_events`.
- UI di `views/admin/selection-detail.ejs` (`#akses-portal`) + tabel riwayat 15 terakhir.
  **Tidak ada** tombol/jalur reopen di Portal Client atau halaman publik (endpoint-nya hanya
  ada di router admin yang terautentikasi).
- Reopen **tidak** membuka kunci submission yang sudah terkirim (dinyatakan eksplisit di UI
  dan pesan flash).
- **PIN portal sekarang hash scrypt** (`bookings.portal_pin_hash`, kolom `portal_pin`
  dikosongkan oleh migrasi `migration.v20_pin_hash`). Konsekuensi: PIN tidak bisa
  ditampilkan lagi. PIN yang BARU dibuat ditahan di memori proses 15 menit
  (`portal.recentPin`) hanya agar bisa ikut pesan WhatsApp; setelah itu hilang.
  Login lama (plaintext) tetap jalan sekali lalu otomatis di-upgrade jadi hash.
- **Fixture tes**: setiap suite yang menyetel PIN plaintext WAJIB juga mengosongkan
  `portal_pin_hash` (kalau tidak verifikasi memakai hash lama dan login gagal).

### v16 — Tipografi Dashboard Admin = Montserrat

- `--font-body` dan `--font-heading` di `admin.css` keduanya Montserrat; Cormorant Garamond
  dihapus dari `admin/layout.ejs` & `layout-blank.ejs` (Google Fonts → Montserrat 400–700).
- Token skala: `--fs-page-title/--fs-section/--fs-subhead/--fs-body/--fs-small/--fs-caption`
  + `--fw-heading 700 / --fw-subhead 600 / --fw-body 400`.
- **`button, input, select, textarea, optgroup, code, kbd, samp, pre { font-family: inherit }`**
  — tanpa ini kontrol form & `<code>` tetap Arial/monospace (UA default) dan halaman admin
  campur font. Ini penyebab utama kegagalan tes "semua teks Montserrat".
- Cakupan: Overview, Kelola Booking, Detail Booking, Pembayaran, Seleksi Foto (+detail),
  Konten, Paket, Portfolio, Pengaturan, Notifikasi HP, dan halaman login.

### Tes

- Baru: `scripts/check-logo-size.js` (127), `check-carousel.js` (40),
  `check-rev4.js` (38 — v14+v15), `check-admin-type.js` (134 — v16).
- Diperbarui karena perilaku SENGAJA berubah: `check-v8.js` (grid → carousel di gallery &
  home), `check-rev2.js` (grid → carousel, 65), `check-rev3.js` (44), `check-admin-t3.js`
  (3 tab, panel `#detail`), `check-t4-t5.js` (label "Buka antrean"), `smoke.js` (panel
  catatan internal dihapus), `check-portal.js` (link final disiapkan lewat DB karena
  validasi Drive butuh koneksi Google asli — jalur validasinya diuji di `check-rev4.js`).
- Suite lain tetap hijau: portal 79, selection 78, t6 90, ops 61, ui7 47, t3 72, t4t5 75,
  verify-pages 56, push-engine 49, push-rules 24.
- Screenshot: `public/review-carousel/`, `public/review-admin-type/`.

## V21 — Revisi pemilik: PIN tampil di dashboard + link final = folder utama booking

### 1. PIN portal kembali TERBACA (bisa ditampilkan di dashboard)

- `bookings.portal_pin` diisi lagi dengan PIN 4 digit terbaca; `portal_pin_hash` hanya
  dibiarkan sebagai cadangan/legacy dan TIDAK lagi menjadi sumber kebenaran.
- `src/portal.js`: `ensurePin()` mengembalikan PIN terbaca (membuat baru bila kosong),
  `verifyPin()` memakai perbandingan waktu-konstan pada PIN terbaca dan — untuk baris lama
  yang hanya punya hash (data V20) — memverifikasi hash lalu otomatis menyimpannya kembali
  sebagai PIN terbaca. Helper memori `recentPin` dihapus, diganti `visiblePin()`.
- Dashboard (`views/admin/booking-detail.ejs`, tab Workflow → Client Portal) menampilkan PIN
  apa adanya; tombolnya kembali "Tampilkan / pastikan PIN" + "Reset PIN".
- Pesan WhatsApp konfirmasi (`attachWhatsApp`) memakai `b.portal_pin` sehingga PIN selalu
  ikut terkirim tanpa aksi tambahan.
- **Migrasi `migration.v21_pin_plain`**: baris yang PIN terbacanya sudah dikosongkan V20
  dibuatkan PIN BARU (hash tidak bisa dibalik). Efek nyata: klien lama perlu dikirimi PIN
  baru sekali. Migrasi `migration.v20_pin_hash` diubah agar tidak lagi mengosongkan
  `portal_pin` (hanya melengkapi hash) supaya kejadian ini tidak terulang di DB baru.
- Konsekuensi keamanan (disepakati pemilik): PIN 4 digit tersimpan terbaca. Proteksi tetap
  bergantung pada rate limit login (8 gagal/15 menit), sesi httpOnly, dan cek kepemilikan
  booking di backend.

### 2. "Selesaikan Order" membagikan folder UTAMA booking

- Sumber link = `bookings.drive_folder_id` (folder klien, mis.
  `November 2026 / Jokowi - UPI - DLY-WISUDA-JOKOWI001`), **bukan** `drive_edit_id`
  ("03. FILE EDIT").
- `final_url` diisi dari `webViewLink` ASLI hasil `gcal.driveFolderInfo(drive_folder_id)`
  (tetap divalidasi: 404/403/trashed → order TIDAK selesai + pesan actionable).
- Subfolder 01/02/03 hanya **dilengkapi bila belum ada** lewat `ensureSubfolders()`; kegagalan
  di tahap ini tidak menggagalkan penyelesaian order (link yang dibagikan tetap folder utama).
- **Folder TIDAK dibuat otomatis** dari tombol ini — pembuatan folder tetap aksi eksplisit
  admin ("Buat folder Drive"). Ini juga mencegah folder ganda & mencegah tes menyentuh Drive asli.
- UI admin menyebut "seluruh folder booking" + path foldernya + daftar isi 01–03.
  Portal Client (`portal/drive.ejs`) menjelaskan folder berisi 01. FILE MENTAH →
  03. FILE EDIT dan tombolnya membuka folder utama.

### Tes

- Baru: `scripts/check-final-link.js` — **17 checks**. Token + Drive API diarahkan ke mock
  lokal (`GCAL_TOKEN_URL` / `GDRIVE_API_BASE`), jadi TIDAK ada panggilan Google asli.
  Menguji: link = folder utama (bukan subfolder), link dari `webViewLink`, folder hilang →
  order ditolak, subfolder dilengkapi otomatis, Portal Client memakai link yang sama,
  idempotensi tahap 08.
- `check-rev4.js` (38) diperbarui: bagian PIN kini menguji PIN tampil di dashboard, PIN
  salah tetap ditolak, baris tanpa PIN dibuatkan PIN baru, reset PIN; bagian Foto Final
  menguji teks "seluruh folder booking" + penolakan saat folder booking tidak ada.
- Suite lain dijalankan ulang & hijau: smoke 135, portal 79, selection 78, rev2 65, rev3 44,
  t3 72, t4t5 75, verify-pages 56.

## V22 — Revisi 2 pemilik (dokumen "DLY GRADUATION | WEBSITE V2")

Delapan kelompok revisi. Fondasi (identitas visual, Montserrat, struktur, database, fitur
lama) dipertahankan; tidak ada tabel/data yang dihapus.

### 01–02. Logo resmi di favicon, PWA & ikon notifikasi

- Route baru **`GET /appicon/<token>.png`** (`src/images.js`: `parseAppIconToken`,
  `appIconUrl`, `buildAppIcon`). Sumber = logo brand yang SAMA dengan favicon
  (`settings.favicon_custom` → `appearance.favicon` → logo header/footer). Artwork di-trim,
  dijadikan putih, diletakkan di kotak navy; `maskable` memakai area aman 58%.
  Ukuran yang dilayani hanya `APP_ICON_SIZES` = 192 & 512 (token berisi size + flag maskable,
  jadi URL-nya self-healing dan boleh di-cache `immutable`).
- `manifest.webmanifest` sekarang memakai `/appicon/...`; `assets/icon-*.png` (monogram lama)
  hanya fallback bila belum ada file logo.
- **`public/sw.js` (v3)**: ikon/badge notifikasi dibaca dari manifest
  (`brandIcons()` → `fetch(SCOPE + 'manifest.webmanifest')`), jadi mengganti logo di
  Dashboard Admin otomatis mengganti ikon notifikasi. Jangan kembali ke path hardcode.
- `res.locals.appIcon(size, maskable)` / `res.locals.appIconSource` disediakan `src/app.js`.
- Favicon tetap `/favicon/<token>.png` (256) di kelima layout; logo adaptif (terang/gelap)
  tidak berubah (V19/V20).

### 03. Notifikasi event-driven

- `client_final` → judul **"Editan kamu sudah selesai"**, body menyebut menu
  **Orderanmu Siap** di Client Portal.
- Event baru **`client_payment`** (`role: 'client'`, setting `push_client_payment`, default
  aktif). Dikirim dari `POST /bookings/:id/payments` dan `.../payments/quick` dengan
  `eventId = payment:<id>:client` (terpisah dari event admin supaya dedupe per penerima).
  Judul mengikuti jenis: DP / pelunasan / manual.
- `EVENTS[*].title` sekarang boleh **fungsi** (`send()` menyelesaikannya dengan ctx);
  `label` statis dipakai halaman `/admin/push` untuk nama toggle.
- Aturan lama tidak berubah: role-based recipients, `event_id` deterministik, `push_log`
  anti-duplikat, scheduler tidak mengirim saat boot, dan **tidak ada notifikasi tanpa event**.

### 04. Navigasi utama tanpa "Lokasi" & "Paket"

- Dua dropdown (desktop) + dua accordion (mobile) DIHAPUS dari `views/partials/header.ejs`.
  Menu sekarang: Home, Gallery, Pricelist, Cara Order, Ulasan (+ S&K; halaman lain mengikuti
  `page_*_visible`).
- `res.locals.navLocations` / `navPackages` beserta query-nya dihapus dari `src/app.js`.
- **Data & halaman TIDAK dihapus**: `/city`, `/city/:slug`, `/paket/:slug`, `/pricelist`
  tetap 200 dan tetap dipakai booking/admin. `initNavDropdowns()` di `app.js` diganti
  `initGalleryFilter()`.

### 05. Gallery: filter dropdown Paket + Lokasi

- Kolom baru **`portfolio.package_label`** (TEXT, ditambahkan idempoten di `db.js`).
  Diisi admin di form portfolio (input teks + `<datalist>` berisi nama paket aktif dan label
  yang sudah dipakai) — halaman admin juga menandai karya yang belum punya label.
- `/gallery` menerima `?paket=` dan `?kota=` (bisa digabung), default "Semua Paket" /
  "Semua Lokasi". Opsi **Paket** = `SELECT DISTINCT package_label` dari karya aktif; opsi
  **Lokasi** = kota aktif (`util.getActiveCities()`), bukan daftar hardcode.
- `?kategori=` lama masih dibaca (tautan lama tidak mati) dan dibawa sebagai hidden field.
- Markup filter = `<form method="get" data-gallery-filter>` berisi dua `<select>`; pilihan
  berubah → form langsung dikirim (`initGalleryFilter`), jadi hasil tetap URL yang bisa
  dibagikan. Empty state khusus ("Belum ada karya pada filter ini") + tombol reset.
- Filter tidak pernah mengubah/menghapus data portfolio (dijaga `check-rev5.js`).

### 06. Client Portal — "Orderanmu Siap"

- Label sidebar `menusFor()` → **Orderanmu Siap** (key/route tetap `drive`, halaman tetap
  `/portal/drive`, h1 tetap "Foto Final Kamu"). Judul halaman = "Orderanmu Siap".
- Saat `final_url` ada: tombol **BUKA GOOGLE DRIVE** + kartu ajakan
  **"Bagikan pengalamanmu sekarang yukk dengan mengisi ulasan"** + tombol
  **Isi Ulasan Sekarang** → `${base}/testimoni/<settings.testimonial_form_token>` (halaman
  testimoni yang MEMANG sudah ada; tidak ada form baru), fallback `${base}/ulasan` bila token
  belum dibuat. Tombol ini TIDAK dirender saat order belum selesai.

### 07. Antrean editing = dua kolom + tombol SELESAI

- `editing.board()` mengembalikan `{active, done, doneTotal}`; `active` = semua job
  `queued` + `editing`, diurutkan menurut posisi antrean dan diberi `queue_no`/`queue_total`.
  Status internal queued/editing TETAP ada karena dipakai timeline client.
- `editing.queuePosition(bookingId)` + `editing.activeQueue()`: posisi dihitung dari DATABASE.
  `editing.refreshActive()` membuat kartu **#1 otomatis berstatus `editing`** (dan portal
  klien → `processing`), kartu lain kembali `queued`. Dipanggil di GET /admin/editing,
  `enqueue()` dan `setStatus()`.
- **`src/ordercompletion.js`** (baru) = satu jalur "Selesaikan Order" untuk
  `POST /bookings/:id/complete-order` DAN `POST /admin/editing/:id/finish`:
  validasi `gcal.driveFolderInfo(bookings.drive_folder_id)` → link `webViewLink` asli,
  lengkapi subfolder 01/02/03 bila perlu, simpan `final_url`/`final_at`, **status booking →
  `completed`** (kecuali cancelled), catat tahap 08, log event, kirim `client_final`.
  Idempoten. `clearFinal()` menangani "Batalkan selesai".
- `editing.setStatus('done')` DITOLAK (`code: 'no-final-link'`) bila `bookings.final_url`
  kosong — menutup jalur pintas (drag/POST langsung) yang bisa menyelesaikan order tanpa
  link Drive valid.
- Kartu antrean menampilkan badge kondisi link Drive, tombol **SELESAI** (100% lebar,
  `data-confirm`), dan tidak lagi `draggable`. Tombol "Atur job" tetap ada (catatan internal).

### 08. Timeline client 8 tahap

- `src/timeline.js`: tahap 02 = **DP Terkonfirmasi** (key baru `dp_confirmed`, dicatat dari
  `booking_payments` paling awal — tidak ada nominal yang dikarang), tahap 03 = **Sesi Foto
  Selesai** (key `session_done` dipertahankan). `waiting_session` tidak dipakai lagi; baris
  lama tetap di DB dan hanya tidak dirender.
- Tahap 03 dicatat saat jam sesi tiba; `state` = `active` selama sesi berjalan dan `done`
  setelah `sessionEnd()` (mulai + `duration_minutes` + 60 menit).
- Tahap 06 menampilkan **posisi antrean aktual** ("Antreanmu saat ini ke-N dari M") dari
  `editing.queuePosition()`. Tahap 07 hanya dicatat saat posisi **#1** (atau job sudah
  dikerjakan). Tahap 08 **selalu `state: 'done'`** → centang hijau, tanpa badge
  "Sedang Berlangsung". Tahap yang belum terjadi tidak dirender.
- View `portal/timeline.ejs` & `portal/ringkasan.ejs` memakai `s.state`; badge "Selesai"
  (`cp-chip--done`) untuk tahap terminal.
- `[data-cp-live]` sekarang juga membawa `data-state` + `data-queue`; `client-portal.js`
  menyegarkan halaman bila stage/state/posisi antrean berubah (polling 45 dtk tetap ada).
  `/portal/status` mengembalikan `state` + `queue`.

### Tes

- Baru: **`scripts/check-rev5.js` — 51 checks** (ikon manifest/appicon/favicon + SW, event
  notifikasi client, navigasi tanpa dropdown, dropdown Gallery + kombinasi + empty state,
  field Paket admin → opsi filter, "Orderanmu Siap" + tombol ulasan + halaman ulasan 200,
  timeline DP/posisi/#1/08 centang, papan 2 kolom + SELESAI ditolak tanpa link Drive).
- Diperbarui karena perilaku SENGAJA berubah: `check-rev3.js` (dropdown nav → pengecekan
  ketiadaan + menu wajib; nama tahap 03), `check-t4-t5.js` (2 kolom, tombol SELESAI,
  penolakan `done` tanpa final_url, job uji digeser ke posisi #1), `check-portal.js` (label
  "Orderanmu Siap", regex tahap, dua tombol primary, cek tombol ulasan),
  `check-push-rules.js` (`client_final` pindah ke ordercompletion.js + event client_payment).
- Hijau: rev5 51, rev3 45, t4t5 78, portal 81, final-link 17, rev4 38, rev2 65, v8 73/74,
  ui7 47, carousel 40, admin-t3 72, logo-size 127, push-engine 49, push-rules 25,
  verify-pages 56.
- **Gagal karena DATA pemilik (bukan regresi, sudah diperiksa):** `check-v8.js` 1 gagal
  ("Migrated benefits default to the check icon" — ikon benefit pertama di data asli bukan
  `check`); `check-t6.js` gagal di bagian carousel foto paket + crash locator karena
  `package_images` kosong/1 foto pada paket pertama (dots & autoplay memang tidak aktif
  untuk 1 slide); `smoke.js` gagal 3 assertion pricelist karena katalog sekarang hanya
  punya kategori "individu" (1 tab) dan durasi 30 menit pada paket kedua.

### Catatan sisa (sengaja TIDAK dibersihkan)

Markup dua dropdown nav sudah dihapus, tetapi blok CSS `.nav-drop*` di akhir `app.css` dan
logika drag & drop di `admin.js` (`initEditingBoard`) masih ada. Keduanya kini tidak terpakai:
kartu antrean tidak lagi `draggable`, dan kalau pun ada POST `status=done` langsung,
`editing.setStatus()` menolaknya tanpa `final_url`. Jangan "menghidupkan" drag antar kolom
lagi tanpa tombol SELESAI — validasi link Drive harus tetap satu-satunya jalan menyelesaikan
order.

## V23 — Revisi 3 pemilik (favicon, masa akses portal, timeline sesi, kategori, upgrade, TnC, template chat)

### 1. Favicon di tab browser "belum berubah" — akar masalah & perbaikan

Bukan favicon-nya salah (sejak V20 tab memang memakai `/favicon/<token>.png`), tetapi:

1. Token hanya berisi PATH logo, dan URL-nya di-cache `immutable` 1 tahun. Saat **cara
   pembuatan** favicon berubah (V20), URL-nya tetap sama → browser terus memakai PNG lama.
   Solusi: `FAVICON_GEN` (`images.js`) **ikut ditulis di token** — formatnya sekarang
   `favicon|<GEN>|<path>` dan `appicon|<GEN>|<size>|<maskable>|<path>` (parser tetap menerima
   token format lama). Ditambah `sourceStamp()` (path + mtime) sehingga re-upload ke path
   yang sama juga menghasilkan URL baru. **Naikkan `FAVICON_GEN` setiap kali algoritma
   favicon/app-icon berubah** — tanpa itu URL tetap dan tab browser tetap memakai ikon lama
   (ini penyebab keluhan "logo di tab belum berubah").
2. Logo lockup 2:1 yang dikecilkan ke 16px hanya mengisi ~13% kotak → tampak seperti titik.
   Sekarang favicon memakai seluruh lebar kotak (`inner = size`) → ~21% cakupan tinta
   (masih satu-satunya perbaikan yang tidak memotong artwork). Ikon PWA tetap 82%/58%.
3. Browser tetap bisa menahan favicon di cache lokal; refresh keras / buka di tab baru
   diperlukan sekali setelah deploy.

### 2. Kode portal booking PENDING hanya 24 jam

- `src/portal.js`: `PENDING_ACCESS_HOURS = 24`, `accessExpiresAt()` = `created_at + 24 jam`
  **hanya** untuk status `pending`/`cancelled`. `accessState()` mengembalikan
  `{ok, expiresAt, expired, hours, label}`.
- Ditegakkan di DUA tempat: `POST /portal/masuk` (ditolak dengan pesan "Masa akses portal
  sudah berakhir…") dan middleware `requirePortal` (sesi yang sudah aktif diputus +
  `expireSessionsFor`). `GET /portal?expired=1` menampilkan penjelasan yang sama.
- Booking `confirmed`/`completed` TIDAK dibatasi — portal tetap permanen.
- **Booking tidak dihapus** (riwayat, pembayaran, dan folder Drive tetap utuh). Yang
  dihapus adalah aksesnya (kode + PIN + sesi). Dashboard menampilkan badge
  "Akses portal sementara/kedaluwarsa/permanen" di kartu Client Portal.

### 3. Tahap 03 timeline — tiga keadaan

`timeline.sessionCopy(booking, state)`:

| state | judul | keterangan |
|---|---|---|
| `upcoming` | Sesi Foto | "Sesi fotomu akan dimulai pada <tanggal, jam WIB>. Jangan telat ya…" |
| `active` | Sesi Fotomu Dimulai | + `SESSION_REMINDER` |
| `done` | Sesi Foto Selesai | sesi selesai |

- Baris `upcoming` **disintesis** di `list()` (tidak ditulis ke `booking_timeline`) selama
  booking confirmed dan jam sesi belum tiba; `state = 'upcoming'`, dot = ring putus-putus,
  dan TIDAK dihitung di `progress`/`reached`.
- `current` = tahap tercapai terakhir (upcoming tidak pernah jadi `current`).

### 4. Gallery: KATEGORI (bukan paket) + kategori dikelola admin

- Tabel baru **`portfolio_categories`** (slug, label, is_active, sort_order) dibuat di
  bootstrap; migrasi `migration.v23_portfolio_categories` men-seed individual/couple/group.
  **"Graduation Event" sengaja tidak di-seed.** Baris portfolio lama tidak diubah.
- `util.portfolioCategories({activeOnly})` + `util.portfolioCategoryLabel()` = satu sumber
  untuk filter publik, form portfolio, dan label kartu. `res.locals.PORTFOLIO_CATEGORIES`
  kini diisi dari tabel (bentuk `{value,label}` tetap) sehingga view/test lama aman.
- Admin: `/admin/portfolio-categories` (tambah, rename, urutan, aktif/nonaktif, hapus).
  Kategori yang **masih dipakai karya tidak bisa dihapus** (hanya dinonaktifkan).
- `/gallery`: dropdown **Kategori** + **Lokasi** (bisa digabung, default Semua). Field
  `portfolio.package_label` dari V22 **tidak dipakai lagi** (kolom dibiarkan, tidak dihapus)
  — `getPortfolio()` juga tidak lagi menerima `packageLabel`.

### 5. Pricelist: label "Recommended"

- `packages.is_recommended` (additive) + checkbox di form paket.
- Badge `.pkg-best--recommended` (emas lembut) dengan ikon bintang **SVG** di kartu
  pricelist dan halaman detail paket; bisa tampil bersama Best Seller (badge kedua turun
  36px lewat `.pkg-best--on-media + .pkg-best--on-media` / `.pkg-detail__badge--second`).
- `util.catalogForCity()` wajib memetakan `is_recommended` (kalau tidak, badge tidak pernah
  muncul di pricelist — ini yang sempat terjadi dan sudah diperbaiki).
- Ejaan yang dipakai: **Recommended** (bukan "Recomended").

### 6. TnC bertingkat

- `util.tncStructure(text)` mengurai: `A. JUDUL`/`## JUDUL` → section; `- …` → poin;
  `-- …` / `  - …` / `* …` → sub-poin; baris biasa → poin (data lama tetap tampil).
- `views/tnc.ejs` merender `.tnc__section` / `.tnc__point` / `.tnc__subs` (CSS baru di
  `app.css`). Editor admin (`/admin/tnc`) menjelaskan formatnya.
- Migrasi `migration.v23_tnc_sections` **hanya menambah judul bagian** pada konten datar
  10 baris (3/3/4) tanpa mengubah satu kata pun; dilewati bila admin sudah memakai penanda.

### 7. "Template Chat" — semua pesan WA editable

- Sidebar: `Template WhatsApp` → **Template Chat** (`/admin/wa-template`), 7 panel:
  1 Chat Klien · 2 Konfirmasi Booking & DP · 3 Kirim Link Portal · 4 Undangan Seleksi ·
  **5 Konfirmasi Reschedule** · **6 Daftar Foto dari Klien** · **7 Pengingat H-1**.
- Setting baru: `wa_reschedule_template` (dipakai `booking-detail.ejs`, menggantikan teks
  hardcode), `wa_submit_template` (dipakai `selection.clientSubmitMessage()`),
  `wa_h1_template` (dipakai `gcal.buildEvent()`).
- Satu handler generik `POST /admin/wa-template/:kind` dengan whitelist
  `EXTRA_WA_TEMPLATES`; tombol reset mengosongkan setting → kembali ke default di
  `util.DEFAULT_*_TEMPLATE`.
- `{{daftar_foto}}` tetap berisi nama file dari DB (satu per baris, tanpa nomor/ekstensi).

### 8. Upgrade Paket + Extra Time

- Tabel **`booking_upgrades`** (booking_id, kind `package|extra`, package_id, package_name,
  minutes, price, note, status `pending|approved|rejected`, decided_at/by).
- Portal: menu sidebar **Upgrade Paket** (`/portal/upgrade`) — kartu gaya pricelist
  (`.cp-up__*`): foto, nama, chip durasi, "Mulai dari", selisih harga, tombol Ajukan.
  **Hanya paket yang lebih mahal** yang ditawarkan; server juga menolak downgrade
  (`upgrades.requestPackage` membandingkan harga durasi termurah vs harga booking).
- **Extra Time 30/60 menit**: selalu tampil, tapi `.is-locked` + tanpa tombol sampai sesi
  foto selesai (`sessionDone` dihitung dari `timeline.list()`). Endpoint POST menolak juga
  (403-ish via redirect pesan) walau dipaksa.
- Harga diatur admin di **`/admin/extra-time`** (`extra_time_30_price` / `extra_time_60_price`,
  default `0` = "Belum diatur admin" dan tombol dinonaktifkan — tidak ada nominal karangan).
- Pengajuan **tidak** mengubah tagihan. Admin menyetujui di `/admin/upgrades`
  (badge di Detail Booking juga ada). `upgrades.approve()` dalam satu transaksi:
  package → `package_id`, `category_id`, `price`, `package_price_snapshot`,
  `total_price_snapshot` (= harga + add-on), `edited_photos_snapshot`; extra → durasi
  +N menit dan total +harga. Semua dicatat di `booking_events`.
- Extra-time price fields & table bisa diubah kapan saja tanpa deploy.

### Tes

- Baru: **`scripts/check-rev6.js` — 50 checks** (favicon bertoken, 24 jam, tiga keadaan
  tahap 03, filter Kategori + kategori admin, badge Recommended, TnC bertingkat, 7 template
  chat + simpan, upgrade hanya naik, Extra Time terkunci/terbuka + harga admin + persetujuan).
- Diperbarui karena perilaku SENGAJA berubah: `check-rev5.js` (Paket → Kategori, 52),
  `check-rev3.js` (judul tahap 03 dinamis, 47), `check-portal.js` (5 menu sidebar, 81).
- Hijau: rev6 50, rev5 52, rev3 47, portal 81, t4t5 78, rev4 38, rev2 65, ui7 47,
  carousel 40, admin-t3 72, admin-type 134, logo-size 127, verify-pages 56, selection 78,
  final-link 17, push-rules 25.
- **Gagal karena DATA pemilik (bukan regresi):** `check-v8.js` (1: ikon benefit pertama di
  data asli bukan `check`), `check-t6.js` (6: paket pertama belum punya foto galeri sehingga
  carousel 1 slide), `smoke.js` (3: katalog hanya 1 kategori & durasi 30 menit).

### Gotcha baru

- **`util.formatDateTimeWIB` menambah +7 jam**, jadi input harus UTC tanpa zona. Jangan
  melempar string ber-zona `+07:00` (hasilnya geser 7 jam). Untuk waktu sesi gunakan
  `sessionStart()` → `toISOString()`.
- Sandbox clock bisa **malam UTC** (WIB sudah tanggal berikutnya). Fixture "sesi sudah
  selesai" harus memakai tanggal KEMARIN, bukan "hari ini jam 08:00".
- Playwright: `waitForNavigation` bisa kalah balapan pada POST→redirect ke URL yang sama;
  pakai helper `submitAndSettle()` (klik + tunggu `domcontentloaded` + jeda).
- Menyimpan form paket lewat klik tombol rawan kalau halaman punya form lain; untuk uji
  deterministik, POST multipart langsung ke `/admin/packages/save` dengan data dari DB.

## V24 — Revisi 4 pemilik (foto siap dipilih, reschedule klien, portal pilih foto ringkas, sesi otomatis selesai, upgrade durasi)

### 1. "Foto Siap Dipilih" — satu tombol, sumber folder `01. FILE MENTAH`
`POST /admin/bookings/:id/photos-ready` (tombol di kartu booking + hero & panel detail +
halaman portal seleksi). Satu aksi:
1. sumber foto = `bookings.drive_raw_id` (`01. FILE MENTAH`); bila kosong, dicoba
   `gcal.ensureSubfolders()` dulu (tanpa rename / memindahkan file);
2. portal seleksi dibuat bila belum ada (`selection.createForBooking`, kuota dari paket);
3. `photo_selections.drive_url` = link folder mentah + `drive_show = 1`;
4. `selection.syncFromDrive()` → foto masuk, pilihan klien tidak diubah;
5. `timeline.record(booking, 'photos_ready', { actor:'admin' })` (tahap 04);
6. `push.notify('client_photos_ready')` (event id stabil per portal ⇒ tidak dobel).
Booking harus `confirmed`/`completed`. Idempoten: tekan dua kali tidak menggandakan foto
maupun tahap. WhatsApp tetap dikirim admin lewat tombol "Kirim Link Portal Seleksi Foto"
(tidak ada API WhatsApp otomatis).

### 2. Reschedule dari sisi KLIEN (`src/reschedule.js`)
- Tabel **`reschedule_requests`**: satu baris per pengajuan (`new_date/new_time/new_location`,
  `old_*` snapshot, `status pending|approved|rejected`, `conflict`, `admin_note`, `decided_*`).
  `booking_reschedules` tetap dipakai sebagai riwayat perubahan jadwal yang BENAR-BENAR terjadi.
- Portal: menu **Reschedule** (`/portal/reschedule`) — form HANYA Tanggal, Jam, Lokasi.
  Pengajuan TIDAK mengubah booking. Admin menyetujui / menolak di tab Workflow booking
  (`POST /bookings/:id/reschedule-requests/:reqId/approve|reject`).
- Persetujuan memakai mesin yang sama dengan form reschedule admin (`reschedule.applySchedule`):
  validasi tanggal, kapasitas harian, bentrok tim, update `booking_reschedules`, log aktivitas,
  push `client_reschedule`, dan PATCH Google Calendar (event id sama). Override (tanggal penuh /
  tim bentrok) tersedia sebagai checkbox di form persetujuan.
- **Batas H-7**: menu hanya terbuka bila sesi masih > `HOLD_DAYS = 7` hari lagi
  (`accessState().daysLeft`). H-7 atau kurang ⇒ terkunci; halaman menampilkan alasannya +
  tombol WhatsApp ke admin. `POST /portal/reschedule` juga menolak (bukan hanya tampilan).
- Admin bisa membuka manual per booking: `bookings.reschedule_override` (0/1) lewat
  `POST /admin/bookings/:id/reschedule-access`; statusnya tampil di panel Workflow.
- Tab baru **"Pengajuan Reschedule"** di `/admin/bookings` (+ kolom `reschedule_pending`
  pada `BOOKING_SELECT` untuk hitungan tab & badge di kartu booking).

### 3. Portal pilih foto di admin disederhanakan
- Sumber foto tidak lagi diketik: bila `drive_raw_id` ada, wizard (`selection-new.ejs`) dan
  halaman pengaturan (`selection-detail.ejs`) menampilkan **link `01. FILE MENTAH` yang
  read-only & sudah terisi**. Booking lama tanpa subfolder mentah tetap boleh memakai link
  manual (jalur ini masih diuji `check-selection.js`).
- `POST /selection/:id/settings` mengabaikan `drive_url` kiriman form bila booking sudah punya
  subfolder mentah (nilainya dipaksa ke folder itu).
- `POST /selection/:id/sync` ("Perbarui dari 01. File Mentah") SELALU membaca
  `selection.rawFolderOf(portal.booking_id)` lebih dulu, lalu menyetel `drive_url`/`drive_show`
  portal. Ini yang membuat "Perbarui" memperbarui daftar file folder mentah.
- Tautan cepat: panel Workflow menunjuk langsung ke `/admin/selection/<id>` (atau wizard bila
  belum ada portal) + "Daftar semua seleksi foto".

### 4. Pantau Order: sesi otomatis selesai + ikon centang
- `timeline.SESSION_BUFFER_MINUTES` = **0** (dulu 60). Booking 60 menit 07.00–08.00 menjadi
  "Sesi Fotomu Selesai" tepat setelah 08.00.
- Teks tahap selesai (permintaan pemilik): "Kamu sudah menyelesaikan sesi foto, dan sekarang
  tinggal nunggu fotografer kamu untuk meng upload file mentahnya ya."
- Tepat SATU tahap boleh `active` (badge "Sedang Berlangsung"): tahap terakhir yang tercapai
  dan hanya bila tahap itu memang berjalan (`session_done` selama sesi, `editing_queue`,
  `editing`). Konfirmasi / DP / Foto Siap Dipilih / Pilihan Terkirim / Foto Editmu Siap selalu
  centang hijau (`is-done`). Ini memperbaiki regresi dua `is-current` sekaligus.

### 5. Upgrade durasi paket + Extra Time saat sesi DIMULAI
- `upgrades.durationCandidates()` → daftar `package_durations` pada paket yang SAMA dengan
  durasi lebih panjang & harga lebih tinggi (60 → 90/120). Ditampilkan sebagai kartu gaya
  pricelist (`.cp-up__card--duration`). `POST /portal/upgrade/duration`,
  `booking_upgrades.kind = 'duration'`; persetujuan admin MENGGANTI `duration_minutes`
  (+ `package_price_snapshot`, `total_price_snapshot`, `edited_photos_snapshot`).
  Downgrade (durasi lebih pendek / tidak lebih mahal) ditolak server.
- Extra Time: `sessionStarted` (sesi `active`) ATAU `sessionDone` membuka pengajuan.
  Sebelum jam sesi tiba kartu `.is-locked` + server menolak.

### Tes
- Baru: **`scripts/check-rev7.js` — 51 checks** (mock Drive + mock Google + salinan DB):
  foto siap dipilih (foto/portal/tahap 04/push/idempoten), reschedule (pengajuan, H-7,
  buka manual, setujui, tolak, tanggal lampau), link Drive read-only & Perbarui, tahap sesi
  selesai tanpa buffer + satu badge aktif, upgrade durasi + Extra Time saat sesi dimulai.
- Diperbarui karena perilaku SENGAJA berubah: `check-rev6.js` (teks Extra Time + judul
  "Sesi Fotomu Selesai"), `check-portal.js` (6 menu sidebar, judul tahap sesi),
  `check-drive.js` (fixture tanpa subfolder mentah + selector wizard `.xx-actions`),
  `check-selection.js` (fixture link manual melepas `drive_raw_id`, 78), `check-rev3.js`
  (keluar eksplisit setelah hasil).
- Hijau: rev7 51 · rev6 50 · rev5 52 · rev3 47 · portal 81 · drive 51 · selection 78 · t4t5 78.

### Gotcha baru
- `data/app.sqlite*` di workspace ini **read-only** (dijaga platform): uji manual harus memakai
  `DLY_DATA_DIR` di `/tmp` atau skrip yang menyalin DB ke `os.tmpdir()`.
  **Salinan `app.sqlite` di dalam folder proyek juga ikut terkunci** dan tidak bisa dihapus —
  taruh salinan uji di luar folder proyek (mis. `os.tmpdir()`), jangan di `./.devdata`.
- Setting yang ditulis langsung ke DB **setelah app hidup** tidak terbaca (`getSettings()` cache).
  Fixture setting (mis. `gdrive_api_key`) harus ditulis SEBELUM proses app di-spawn.
- `check-selection.js` butuh server yang sudah listening (`BASE=… node scripts/check-selection.js`).

## V25 — Revisi 5 pemilik (tahap sesi, reschedule→kalender+tim, upgrade gaya pricelist, tagihan, keamanan)

### 1. BUG NYATA — tahap sesi terbaca "selesai" padahal baru mulai
Gejala dari pemilik: booking 9 Nov 13:11 baru mulai, tetapi timeline sudah
"Sesi Fotomu Selesai". Penyebab: status tahap 03 ikut ditentukan oleh "tahap terakhir
yang tercapai" (`item.key !== lastKey → done`), sehingga karena `photos_ready` lebih akhir,
tahap sesi dipaksa `done`.
Perbaikan di `src/timeline.js`:
- `sessionStarted` / `sessionOver` dihitung dari JAM booking + durasi (buffer 0).
- Tahap `session_done` SELALU `sessionOver ? 'done' : 'active'`.
- Selama sesi berjalan, hanya tahap sesi yang `active` (tidak mungkin dua badge).
- `staleSessionRow`: baris `booking_timeline.session_done` dari jadwal LAMA (booking sudah
  di-reschedule ke depan) diabaikan → tampil sebagai `upcoming`, bukan selesai.
- Copy resmi (permintaan pemilik): `upcoming` **"Menunggu sesi foto"** (+ "Sesi fotomu
  dijadwalkan <tgl, jam> – <jam> WIB, jangan telat"), `active` **"Sesi foto dimulai"** +
  chip kedap-kedip **"Sedang berlangsung"**, `done` **"Sesimu sudah selesai"** (+ teks
  "…tinggal nunggu fotografer kamu untuk meng upload file mentahnya ya").
- Label chip ditulis huruf kecil "Sedang berlangsung" (test lama yang memakai
  /Sedang Berlangsung/ case-sensitive sudah disesuaikan).
- **Stempel jam tahap 03 mengikuti keadaan, bukan kapan baris dicatat** (susulan keluhan
  pemilik "cek tanggal dan jam"): `upcoming` = jadwal mulai, `active` = rentang
  "13:11 – 14:41 WIB", `done` = **jam sesi berakhir**. Baris `booking_timeline` tetap
  dicatat saat jam sesi tiba, jadi tanpa override ini klien membaca "Sesimu sudah selesai ·
  13:11" padahal sesi 90 menit baru berakhir 14:41.

### 2. Reschedule klien → Google Calendar + tim
- `reschedule.applySchedule()` sudah PATCH event yang sama (`sendUpdates=all`) sehingga
  undangan baru otomatis sampai ke attendee; hasilnya kini melaporkan `teamInvited`
  (jumlah email tim) di pesan sukses admin.
- Panel Workflow: tombol **"Kirim Jadwal ke Tim"** (`POST /bookings/:id/resend-invites`)
  di samping saklar akses reschedule/upgrade.

### 3. Upgrade paket = tampilan pricelist, downgrade DIKUNCI
- `upgrades.packageCards(booking)` mengembalikan SEMUA paket aktif di kota itu dengan
  `state: current|upgrade|locked` + `durations[].durationState`. Paket/durasi lebih murah
  TETAP DITAMPILKAN tetapi `.is-locked` + CTA `disabled` (permintaan pemilik: "kunci saja").
- Halaman `/portal/upgrade` memakai komponen pricelist asli (`.pkg-feature`, `.dur-card`,
  `.benefit-list`) di dalam `.cp-pkgcard` — bukan kartu kecil lagi. Chip durasi pada paket
  yang sedang dipakai adalah titik pengajuan upgrade durasi.
- `upgrades.accessState()`: pengajuan paket/durasi/add-on **dikunci H-7** (memakai
  `bookings.reschedule_override` yang sama dengan reschedule; extra time dikecualikan karena
  aturannya sendiri: hanya saat sesi sudah dimulai). Server menolak di route, bukan hanya UI.

### 4. Add-on & ringkasan paket
- `booking_upgrades.kind = 'addon'` (kolom `package_id` dipakai ulang untuk id add-on,
  `package_name` untuk namanya — tanpa migrasi baru). `POST /portal/upgrade/addon`.
  Persetujuan admin menambahkan `{id,name,price}` ke `bookings.addons_snapshot` dan
  menambah `total_price_snapshot`.
- `upgrades.currentSummary(booking)` → "Paket kamu sekarang" satu baris:
  `<durasi> <harga> <kota> | Extra Time 30 Menit Rp… | Add-on Fish Eye Rp…`
  (hanya yang SUDAH disetujui; polos bila tidak ada). Ringkasan ikut berubah setelah
  upgrade/extra/add-on disetujui.

### 5. Ringkasan portal — tiga kotak tagihan
`views/portal/ringkasan.ejs` + `.cp-pay`: **Total Harga Paket** (dari
`total_price_snapshot`), **Yang Sudah di Bayar** (dari baris `booking_payments`, label
"Pembayaran baru DP"/"Pembayaran Lunas"), **Yang Belum di Bayar** (selisih). Di bawahnya
catatan pelunasan H-1 + rekening dari **Pengaturan Pembayaran** (`payment_bank_name`,
`payment_account_number`, `payment_account_holder`, `payment_notes`) — tidak ada nomor
rekening yang ditulis di kode.

### 6. Keamanan (`src/security.js`)
- Header untuk SEMUA respons: CSP (script/style 'self' + 'unsafe-inline' karena template
  memakai inline, img https: untuk CDN media), `X-Frame-Options: DENY` + `frame-ancestors
  'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, HSTS saat HTTPS,
  `X-Powered-By` dimatikan.
- `blockSensitivePaths`: `.env`, `.git`, `*.sqlite*`, `*.sql`, backup, log, `node_modules`,
  path traversal → 404 + dicatat (tidak mengonfirmasi keberadaan file).
- `createLimiter`: 150 permintaan berubah-data per IP/menit (login admin 6/15 menit,
  login portal 8/15 menit tetap lebih ketat).
- Password admin: minimal 10 karakter, wajib huruf + angka, daftar password lemah ditolak
  (`security.checkPassword`, dipakai route ganti password).
- Tabel `security_events` + panel **Keamanan Website** di `/admin/settings` (login gagal,
  path sensitif ditolak, rate limit, sesi aktif, 8 peristiwa terakhir).

### Tes
- Baru: **`scripts/check-rev8.js` — 57 checks** (mock Google): 3 keadaan tahap sesi termasuk
  kasus bug **dan stempel jamnya** (rentang saat berjalan, jam selesai saat selesai),
  reschedule → event kalender + attendee tim, kartu pricelist + downgrade terkunci,
  add-on → disetujui → ringkasan, extra time di ringkasan, kunci H-7 (UI + server),
  3 kotak tagihan + rekening, dan seluruh header/path/rate-limit/password.
- Diperbarui karena perilaku SENGAJA berubah: `check-rev7.js` (chip durasi pricelist, 52),
  `check-rev6.js` (judul "Menunggu sesi foto", kartu pricelist, paket murah terkunci, dan
  fixture upgrade +20 hari karena H-7, 50), `check-rev3.js` (label "Sedang berlangsung", 47),
  `check-portal.js` (judul tahap sesi, 81), `review-rev4.js` (judul baru).
- Hijau: rev8 57 · rev7 52 · rev6 50 · rev5 52 · rev3 47 · portal 81 · ops 61 · drive 51 ·
  selection 78 · t4t5 78 · ui7 47 · verify-pages 56.
- Screenshot: `node scripts/review-rev5.js` → `public/review-rev5/`.

### Gotcha baru
- `package_durations` TIDAK punya kolom `note` — yang ada `description` (sempat bikin
  `/portal/upgrade` 500).
- `booking_team` menyimpan snapshot dengan kolom `name/email/role`, bukan
  `member_name/member_email/member_role`.
- Timeline: JANGAN menentukan status tahap dari urutan tahap lain; tahap 03 murni dari jam.

### Catatan tambahan Revisi 5 (pengujian)
- `X-Robots-Tag: noindex` HANYA untuk `/portal`, `/admin`, `/selection`, `/testimoni`
  (`security.PRIVATE_PATH`). Jangan pernah memasangnya global — halaman publik harus tetap
  bisa di-index Google (SEO pemilik).
- `check-ui7.js` dulu memakai id booking tetap (`/admin/bookings/9`); pemilik menghapus
  booking itu sehingga suite crash. Sekarang id diambil dari kartu pertama (data-aware).
- `check-admin-t3.js`: tab filter jadi **10** (ada "Pengajuan Reschedule"); kartu grid boleh
  berisi `<form>` tombol aksi, yang dilarang adalah input/select/textarea inline.
- `check-t6-live-copy.js`: jumlah durasi berharga dibuat `>= 1` (pemilik menambah paket).
- `check-t6.js` tetap gagal karena data pemilik (paket pertama tanpa foto galeri) — bukan regresi.

## V26 — Revisi 6 pemilik: tambah client manual + kunci upgrade setelah sesi selesai

### 1. Tambah client manual (data klien lama / sudah lewat)
- Tombol **“+ Tambah Client Manual”** di header `/admin/bookings` → `/admin/bookings/new`
  (`views/admin/booking-new.ejs`, route GET/POST `/bookings/new`, keduanya **sebelum**
  `/bookings/:id` supaya `new` tidak dibaca sebagai id).
- **Tanggal sesi BEBAS**: route ini TIDAK memakai `util.availabilityForRange` sama sekali —
  tanggal lampau, hari yang ditutup (`availability_overrides`), dan tanggal penuh semuanya
  boleh (dipakai untuk memasukkan klien yang sudah selesai sesi supaya tetap bisa memantau
  progres di portal). Tidak ada validasi H-1/hari tutup.
- **Link folder Google Drive manual** (`#drive_url`) → `drive.parseFolderId()` lalu disimpan
  di `drive_folder_id`/`drive_folder_url`. TIDAK memanggil API Drive, TIDAK membuat folder,
  TIDAK menyinkronkan Google Calendar (data lama tidak perlu memicu undangan baru; tombol
  sinkron tetap ada di detail booking).
- Harga: otomatis dari `package_durations.price` (JS mengisi saat durasi dipilih); kolom
  `#price` boleh diisi manual untuk harga khusus → jadi `package_price_snapshot` +
  `total_price_snapshot`.
- `kota`/`category_id` DITURUNKAN dari paket yang dipilih (tidak ada dropdown kota terpisah
  → tidak ada kemungkinan kota vs paket tidak cocok).
- Status form memakai `util.MANUAL_STATUSES` (**tanpa `pending`**): masa akses portal untuk
  booking pending hanya 24 jam sejak `created_at`, sedangkan data lama sengaja bertanggal
  lampau sehingga portalnya akan langsung kedaluwarsa.
- PIN portal langsung dibuat (`portalAccess.ensurePin`) dan kode + PIN ditampilkan di flash
  (`?note=`): “Kode DLY-WISUDA-… · PIN portal 1234”.
- `created_at` = “Tanggal booking dicatat” (opsional, default hari ini) supaya data lama tidak
  tampil sebagai booking hari ini.

### 2. Upgrade paket OTOMATIS terkunci setelah sesi foto selesai
`upgrades.accessState()` sekarang menambah `sessionOver` (dari `timeline.sessionEnd()`:
tanggal + jam + durasi, buffer 0 — sumber waktu yang sama dengan tahap 03 pembeli):
- `locked = sessionOver || holdLocked`. Kunci **sesi selesai tidak bisa dibuka** dengan
  `bookings.reschedule_override` (saklar itu tetap khusus H-7): fakta sesi sudah lewat.
- Berlaku untuk pengajuan **paket, durasi, dan add-on** (semuanya lewat `accessState`).
- **Extra Time dikecualikan**: `requestExtra()` sengaja tidak memanggil `accessState`.
- UI `/portal/upgrade`: judul “Upgrade sudah ditutup”, label `Dikunci (sesi selesai)`
  (bukan H-7), tanpa form pengajuan; menu sidebar “Upgrade Paket” diberi badge “Terkunci”.

### Tes
- Baru: **`scripts/check-manual.js` — 40 checks** (salinan DB): tombol + form, validasi
  server, tanggal lampau yang ditutup & penuh tetap tersimpan, harga manual, link Drive
  manual, PIN otomatis, login portal client manual, timeline “Sesimu sudah selesai”,
  3 kotak tagihan, upgrade paket/durasi ditolak server setelah sesi selesai, Extra Time
  diterima, sesi +30 hari tetap terbuka, dan H-7 tetap terkunci.
- Hijau: manual 40 · rev8 57 · rev7 52 · rev6 50 · rev5 52 · rev3 47 · portal 81 ·
  verify-pages 53 (jumlah halaman ikut data pemilik).

### Data-aware pada tes lama (bukan regresi)
- `check-rev3.js` dulu memakai id booking **13**; pemilik menghapus booking itu sehingga
  semua fixture-nya tidak kena. Sekarang id diambil dari DB (`13` bila ada, kalau tidak
  booking pertama) dan dipakai di seluruh fixture (`FIX_ID`).
- `check-portal.js`: status portal boleh `submitted` ATAU `processing` — bila antrean editing
  kosong, job baru langsung jadi #1 sehingga `src/editing.js` mengubah status ke
  `processing`.

## V27 — Optimasi performa (Tahap 2): P0 + P1 + P2

Laporan audit lengkap ada di balasan chat (angka sebelum/sesudah). Ringkasnya:

### P0 — boot tidak lagi "stampede"
- `src/images.js`: **antrean proses gambar** `withImageSlot(fn, priority)`.
  `IMG_CONCURRENCY=3`, pekerjaan latar maks `IMG_CONCURRENCY-2` (1 slot selalu bebas
  untuk pengunjung). `convert()` dan `identify` WAJIB lewat antrean ini.
  Dulu warm-up boot melepas 19–28 `convert` + 145 `identify` sekaligus →
  request pengunjung mengantre sampai puluhan detik setelah publish.
- `warmDimensions()` hanya memeriksa file yang **belum punya metadata**. Index
  (`data/image-cache/dimensions.json`) menyimpan `failed: true` untuk file yang gagal
  dibaca (PNG rusak), sehingga TIDAK dicoba ulang setiap boot (dulu 146 file/boot).
- `logoTone()` **tidak lagi memakai `execFileSync`** (dulu memblokir event loop 0,4–0,8 s
  dan muncul sebagai 10% sampel `--cpu-prof`). Hasilnya disimpan di
  `data/logo-cache/tones.json` (kunci `src|mtime`); saat render hanya DIBACA, dan
  perhitungan dijalankan sekali di latar (`warmLogoTones`) → tidak pernah salah warna
  karena fallback = tinta yang diminta (trim saja, warna asli).
- Warm-up boot sekarang ikut menyiapkan varian **1600/2000** (dulu hanya 480/800/1200
  sehingga pengunjung pertama menunggu 350–371 ms per gambar).

### P1 — berat aset
- **Logo WebP + srcset**: `/logo/<token>-<96|192|320>.webp` (+ PNG fallback).
  Terukur: logo 560 px PNG 48,9 KB + 27,8 KB → **2,2/5,8/10,8 KB** per varian;
  satu halaman kini 4 KB (1×) / 11 KB (2×) / 20 KB (3×), sebelumnya 76 KB.
  `sizes: '96px'` di header/footer/portal (logo dirender 80×40 px).
  `logoPicture()` dipanggil otomatis dari `picture()` bila src berbentuk `/logo/…png`.
  **Gotcha**: `opts.className` dari `picture()` sudah berupa string ` class="…"` —
  jangan dibungkus lagi (pernah menghasilkan `class=" class="…""` sehingga semua
  selektor `.logo__img` hilang dan 4 cek logo di `check-rev3.js` gagal).
- **Montserrat self-host**: `public/fonts/montserrat-latin.woff2` (variabel 300–700,
  subset latin, 37.956 B) + `@font-face` di `app.css`. `FONT_OPTIONS` Montserrat /
  Montserrat Light / Montserrat Bold ditandai `local: true` → `fontsUrl` kosong
  (tidak ada request ke fonts.googleapis.com). `LOCAL_FONT_FILES` sekarang memakai
  peta font→file eksplisit dan ikut memuat `font_ui`.
- `buildLogoInk()` menyimpan **master logo yang sudah di-trim** sekali per (sumber, tinta);
  `-trim` pada PNG besar ±700 ms dan dulu diulang untuk tiap ukuran.

### P2 — cache & pembersihan
- `src/publiccache.js`: mikro-cache HTML **15 detik** (`PUBLIC_CACHE_MS`, 0 = mati)
  untuk halaman publik saja (`/`, `/gallery`, `/pricelist`, `/city`, `/cara-order`,
  `/ulasan`, `/faq`, `/tentang`, `/syarat-ketentuan`, `/artikel`, `/city/:slug`,
  `/artikel/:slug`, `/portfolio/:slug`, `/paket/:slug`).
  **Tidak pernah** di-cache: admin, portal, selection, testimoni, booking, api, aset,
  request ber-query, dan request dengan cookie `dly_sid` (admin login).
  Header browser tetap `no-store` (cache ini hanya menghemat RENDER di server, bukan
  mengubah cache browser). Invalidasi: `publiccache.clear()` saat publish/kancel dan
  pada SETIAP POST/PUT/PATCH/DELETE di `/admin` (`res.on('finish')`).
  Suite yang menulis `site_content` langsung ke DB menjalankan app dengan
  `PUBLIC_CACHE_MS=0` (check-rev5/rev6/t6/t6-live-copy/ui7).
- Lightbox memakai turunan 2000 px (`res.locals.lightboxUrl`), bukan file master
  (dulu satu klik bisa mengunduh 0,25–6,14 MB). Dipakai di 8 titik `data-src`/`data-more`.
- `sweepTemp()` (bersihkan `.in-*/.gen-*/.out-*`) sekarang juga berjalan tiap 30 menit,
  bukan hanya saat boot.

### Tes
- Baru: `.testrun/verify-publiccache.js` (HIT/MISS, portal & admin tidak di-cache, TTL),
  `.testrun/verify-boot-twice.js` (spawn boot-1 vs boot-2), `.testrun/audit-*.js`
  (instrumentasi child_process + SQL counter + load test bertahap).
- `scripts/verify-pages.js` kini menyalin `image-cache`/`logo-cache`/`preview-cache`
  dan melewati portal seleksi kecuali `SKIP_SELECTION=0` — portal seleksi memuat foto
  dari **Google Drive** (533 foto), sehingga memeriksa semuanya butuh belasan menit dan
  mengukur jaringan Drive, bukan aplikasi.
- Hijau: rev8 57 · rev7 52 · rev6 50 · rev5 52 · rev3 47 · portal 81 · manual 40 ·
  ui7 48 · selection 78 · t6copy 31 · push 49 · verify-pages 53.

## V28 — Seleksi foto V2: akurasi pilihan, kebijakan thumbnail, submit cepat

### 1. BUG NYATA — pilihan foto saling menghilangkan (SUDAH DIPERBAIKI)
Reproduksi: pilih baris 1 → baris 3 → baris 2 dengan respons jaringan **tidak berurutan**
(proxy menahan respons pertama 900 ms) → layar hanya menampilkan 1 foto, padahal database
menyimpan 3. Terbukti oleh `.testrun/proof-pick-bug.js` (`RESULT=FAIL` sebelum perbaikan).

Penyebab pasti: `public/assets/selection.js` menerima **daftar pilihan penuh** dari
`POST /selection/:token/pick` lalu mengganti seluruh state:
`picked = new Set(response.picks)`. Bila respons yang lebih LAMA tiba belakangan
(koneksi HP, dua klik berdekatan), snapshot lama menimpa pilihan baru.

Perbaikan (server + klien):
- `photo_selections.picks_rev` (migrasi `addColumn`) — dinaikkan **di dalam transaksi**
  yang sama dengan perubahan pilihan. Respons `/pick` menyertakan `rev`.
- Klien menyimpan `picksRev` tertinggi dan **mengabaikan respons dengan `rev <= picksRev`**
  (`reconcile()`), menerapkan perubahan **per ID** (bukan mengganti seluruh daftar), dan
  mempertahankan pilihan yang requestnya masih `pending`.
  → hasil sekarang `RESULT=PASS`: layar = database (3 foto).
- Badge urutan tiap tile memakai **posisi** foto itu (`positions`), bukan `picks.size`
  (dulu semua tile menampilkan angka yang sama).
- `opId` per klik → server idempotent (retry tidak menggandakan).
- Kuota diperiksa DI DALAM transaksi bersama INSERT → dua tambah bersamaan tidak bisa
  melewati kuota (dulu cek di luar transaksi).

### 2. Kebijakan thumbnail (retensi)
- Thumbnail galeri (320/640) sekarang **WebP** (`-quality 78`); preview besar tetap JPEG
  progressive. Terukur: 320 px = 4–10 KB, 640 px = 10–18 KB (target pemilik 50–100 KB,
  jauh di bawahnya; RMSE vs JPEG q80 hanya 1,5% → visual setara).
- **Lebar tak dikenal TIDAK lagi jatuh ke 1600 px** (`normalizeWidth()`): dulu view
  meminta `?w=400`/`?w=800` yang tidak ada di `PREVIEW_WIDTHS` sehingga setiap tile
  mengunduh 1600 px (84 KB). Views sekarang memakai 320/640, dan lebar asing di-snap ke
  varian terdekat.
- Konversi preview seleksi juga **lewat antrean `images.withImageSlot`** (`runConvert` di
  `src/selection.js`): permintaan pengunjung `high`, warm-up latar `low`. Tanpa ini, membuka
  satu portal bisa menjalankan belasan `convert` sekaligus (server tersendat).
- **Gotcha nyata**: file `.in-*` sementara (satu salinan master 1–6 MB per konversi) tertinggal
  bila proses dimatikan di tengah konversi (publish/restart). Ini penyebab `preview-cache`
  pernah membengkak sampai 328 MB. Sekarang: `writePreviewFromBuffer` melacak file aktif
  (`activeTempFiles`) dan menghapusnya pada SIGTERM/SIGINT/exit, dan `sweepTemp()` jalan
  tiap **10 menit** (bukan 30).
- `src/selection-cleanup.js`: antrean `selection_cleanup_queue` + worker.
  Setelah submit commit → `enqueuePortal(...)`; worker (5 menit) menghapus file **cache**
  saja, idempotent (ENOENT = sukses), retry maks 5×, dicatat di `selection_access_log`
  (`action='cleanup'`). Retensi: thumbnail > 30 hari, preview besar idle > 7 hari atau
  > 30 hari. **Baris `photo_selection_picks` dan master Drive/upload tidak pernah disentuh.**
  Portal yang belum submit TIDAK dihapus cache-nya (dijaga di `runOne`).
- Master foto di Google Drive tetap satu-satunya sumber; cache bisa dibuat ulang kapan saja
  (admin membuka kembali portal → `ensurePreview` membuat ulang).

### 3. Submit cepat & idempotent
- Satu transaksi: validasi (pilih kosong / melebihi kuota / wajib penuh / jumlah baris
  JOIN konsisten) → `UPDATE ... WHERE submitted_at IS NULL` → verifikasi status.
- Submit ulang (klik dua kali / retry) → **200 dengan payload sukses yang sama**
  (`alreadySubmitted: true`), `submitted_at` tidak berubah, antrean tidak dobel.
- `push.notify` dipindah ke `setImmediate` (setelah respons) → jaringan push tidak pernah
  memperlambat submit.
- Terukur (300–700 pilihan): p50 28–66 ms, p95 37–93 ms. Tidak ada unduhan Drive, tidak ada
  pembuatan ulang thumbnail saat submit.

### Tes
- Baru: **`scripts/check-selection-v2.js` — 47 checks** (fixture 700 foto lokal + proxy
  respons tidak berurutan): bug pilihan, pilih acak 24 foto, batalkan satu, scroll,
  refresh, buka ulang portal, request bersamaan, kuota, submit 50/100/300/700 (p50/95/99),
  submit ganda, kegagalan koneksi (pilihan utuh + bisa retry), kebijakan thumbnail
  (WebP ≤100 KB, w=400 tidak jadi 1600), dan pembersihan (hanya setelah submit,
  idempotent, audit log, master tidak tersentuh, retensi 30 hari).
- Helper: `.testrun/proof-pick-bug.js` (bukti bug + perbaikan), `.testrun/selection-fixture.js`.
- `scripts/verify-pages.js` juga menyalin `preview-cache` dan melewati portal seleksi
  kecuali `SKIP_SELECTION=0` (portal seleksi memuat foto dari Drive → belasan menit).
- Hijau: sel-v2 47 · rev8 57 · rev7 52 · rev6 50 · rev5 52 · rev3 47 · portal 81 ·
  manual 40 · ui7 48 · selection 78 · drive 51 · t4t5 78 · ops 61 · admin-t3 72 ·
  t6copy 31 · push 49 · verify-pages 53.

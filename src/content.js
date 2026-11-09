'use strict';

/**
 * CMS engine: draft/live content, appearance tokens, section registry,
 * hero slides and the publish pipeline.
 *
 * Public pages read LIVE values. Admin edits DRAFT values and publishes.
 * `?preview=1` (admin session only) renders DRAFT values.
 */

const { db } = require('./db');
const schema = require('./content-schema');

const HERO_SLIDES_KEY = 'hero.slides_json';
const PUBLISHED_AT_KEY = 'publish.last_at';

/* ------------------------------------------------------------------ */
/* Content (text + appearance tokens)                                  */
/* ------------------------------------------------------------------ */
function contentRows() {
  return db.prepare('SELECT key, draft_value, live_value, updated_at FROM site_content').all();
}

function getSiteContent({ preview = false } = {}) {
  const col = preview ? 'draft_value' : 'live_value';
  const out = {};
  contentRows().forEach((r) => {
    out[r.key] = r[col] == null ? '' : r[col];
  });
  // Fill gaps from the registry so new keys always render.
  const defaults = schema.defaultContentMap();
  Object.entries(defaults).forEach(([k, v]) => {
    if (out[k] === undefined || out[k] === null) out[k] = v;
  });
  return out;
}

function saveDraftValues(values) {
  const stmt = db.prepare(`UPDATE site_content SET draft_value = ?, updated_at = datetime('now') WHERE key = ?`);
  const ins = db.prepare(`INSERT INTO site_content (key, draft_value, live_value, updated_at)
                          VALUES (?, ?, ?, datetime('now'))`);
  const defaults = schema.defaultContentMap();
  db.transaction(() => {
    for (const [key, raw] of Object.entries(values)) {
      const value = raw == null ? '' : String(raw);
      const changed = stmt.run(value, key).changes;
      if (!changed) ins.run(key, value, defaults[key] == null ? value : defaults[key]);
    }
  })();
}

/* ------------------------------------------------------------------ */
/* Website sections                                                    */
/* ------------------------------------------------------------------ */
function getSections({ preview = false } = {}) {
  const rows = db.prepare('SELECT * FROM website_sections ORDER BY sort_order, id').all();
  const list = rows.map((r) => ({
    key: r.section_key,
    title: preview ? (r.draft_title != null ? r.draft_title : r.title) : r.title,
    description: preview ? (r.draft_description != null ? r.draft_description : r.description) : r.description,
    content: preview ? (r.draft_content != null ? r.draft_content : r.content) : r.content,
    layout: preview ? (r.draft_layout || r.layout) : r.layout,
    sort_order: preview ? (r.draft_sort_order != null ? r.draft_sort_order : r.sort_order) : r.sort_order,
    is_active: preview ? (r.draft_is_active != null ? Number(r.draft_is_active) : r.is_active) : r.is_active,
    bg_color: preview ? (r.draft_bg_color != null ? r.draft_bg_color : r.bg_color) : r.bg_color,
    text_color: preview ? (r.draft_text_color != null ? r.draft_text_color : r.text_color) : r.text_color,
    font: preview ? (r.draft_font != null ? r.draft_font : r.font) : r.font,
    items: (() => {
      const raw = preview ? (r.draft_items_json != null ? r.draft_items_json : r.items_json) : r.items_json;
      if (!raw) return [];
      try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (e) { return []; }
    })(),
    items_json: preview ? (r.draft_items_json != null ? r.draft_items_json : r.items_json) : r.items_json,
    layouts: schema.SECTION_LAYOUTS[r.section_key] || [r.layout],
    label: (schema.SECTION_DEFAULTS.find((s) => s.section_key === r.section_key) || {}).title || r.section_key
  }));
  return list.sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
}

function activeSectionKeys({ preview = false } = {}) {
  return getSections({ preview }).filter((s) => Number(s.is_active) === 1).map((s) => s.key);
}

function saveSectionDrafts(items) {
  const stmt = db.prepare(`UPDATE website_sections SET
      draft_title = ?, draft_description = ?, draft_content = ?, draft_layout = ?,
      draft_sort_order = ?, draft_is_active = ?,
      draft_bg_color = ?, draft_text_color = ?, draft_font = ?, draft_items_json = ?,
      updated_at = datetime('now')
    WHERE section_key = ?`);
  db.transaction(() => {
    items.forEach((it, idx) => {
      stmt.run(
        String(it.title == null ? '' : it.title),
        String(it.description == null ? '' : it.description),
        String(it.content == null ? '' : it.content),
        String(it.layout || ''),
        Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : idx,
        it.is_active ? 1 : 0,
        String(it.bg_color == null ? '' : it.bg_color),
        String(it.text_color == null ? '' : it.text_color),
        String(it.font == null ? '' : it.font),
        String(it.items_json == null ? '' : it.items_json),
        String(it.section_key || it.key)
      );
    });
  })();
}

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */
function getAppearance({ preview = false } = {}) {
  const prefix = 'appearance.';
  const raw = getSiteContent({ preview });
  const out = {};
  schema.APPEARANCE_FIELDS.forEach((f) => {
    const v = raw[prefix + f.key];
    out[f.key] = v == null || v === '' ? f.default : v;
  });
  out.preset = raw[prefix + 'preset'] || 'minimal_navy';
  return out;
}

function fontByValue(value) {
  return schema.FONT_OPTIONS.find((f) => f.value === value) || schema.FONT_OPTIONS[0];
}

/** CSS custom properties + Google Fonts URL derived from appearance tokens. */
function themeFromAppearance(app) {
  const heading = fontByValue(app.font_heading);
  const body = fontByValue(app.font_body);
  // Self-hosted families (Fraunces / Instrument Sans) are declared in app.css and preloaded
  // from /fonts, so they are left OUT of the Google Fonts request. When both are local the
  // stylesheet URL is empty and no external font request is made at all.
  const remote = [heading, body].filter((f) => !f.local).map((f) => f.google);
  const fonts = Array.from(new Set(remote)).join('&family=');
  const radius = app.button_style === 'pill' ? '999px' : app.button_style === 'soft' ? '10px' : '2px';
  const spacing = app.section_spacing === 'compact' ? '0.78' : app.section_spacing === 'airy' ? '1.22' : '1';
  return {
    headingFont: heading.stack,
    bodyFont: body.stack,
    fontsUrl: fonts ? `https://fonts.googleapis.com/css2?family=${fonts}&display=swap` : '',
    vars: [
      `--primary:${app.primary}`,
      `--secondary:${app.secondary}`,
      `--bg:${app.background}`,
      `--text:${app.text}`,
      `--border:${app.border}`,
      `--font-heading:${heading.stack}`,
      `--font-body:${body.stack}`,
      `--radius-btn:${radius}`,
      `--space-scale:${spacing}`
    ].join(';')
  };
}

/* ------------------------------------------------------------------ */
/* Hero slides                                                         */
/* ------------------------------------------------------------------ */
function draftHeroSlides() {
  return db.prepare('SELECT * FROM hero_slides ORDER BY sort_order, id').all();
}

function publishedHeroSlides() {
  const row = db.prepare('SELECT live_value FROM site_content WHERE key = ?').get(HERO_SLIDES_KEY);
  if (!row || !row.live_value) return null;
  try {
    const parsed = JSON.parse(row.live_value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

/** Slides used for rendering. Preview → draft rows; public → last published snapshot. */
function getHeroSlides({ preview = false } = {}) {
  if (preview) return draftHeroSlides().filter((s) => Number(s.is_active) === 1);
  const published = publishedHeroSlides();
  if (published && published.length) return published.filter((s) => Number(s.is_active) === 1);
  // Never published yet: fall back to the current active rows.
  return draftHeroSlides().filter((s) => Number(s.is_active) === 1);
}

function getHeroSlidesForAdmin() {
  return draftHeroSlides();
}

/* ------------------------------------------------------------------ */
/* Draft / publish pipeline                                            */
/* ------------------------------------------------------------------ */
function pendingChanges() {
  const content = db.prepare(`SELECT COUNT(*) AS n FROM site_content
                              WHERE COALESCE(draft_value,'') <> COALESCE(live_value,'')`).get().n;
  const sections = db.prepare(`SELECT COUNT(*) AS n FROM website_sections
      WHERE COALESCE(draft_title, title) <> title
         OR COALESCE(draft_description, description) <> description
         OR COALESCE(draft_content, content) <> content
         OR COALESCE(draft_bg_color, '') <> COALESCE(bg_color, '')
         OR COALESCE(draft_text_color, '') <> COALESCE(text_color, '')
         OR COALESCE(draft_font, '') <> COALESCE(font, '')
         OR COALESCE(draft_items_json, '') <> COALESCE(items_json, '')
         OR COALESCE(draft_layout, layout) <> layout
         OR COALESCE(draft_sort_order, sort_order) <> sort_order
         OR COALESCE(draft_is_active, is_active) <> is_active`).get().n;
  const draftSlides = JSON.stringify(draftHeroSlides().map(slideSnapshot));
  const publishedSlides = JSON.stringify(publishedHeroSlides() || []);
  const slides = draftSlides === publishedSlides ? 0 : 1;
  return { content, sections, slides, total: content + sections + slides };
}

function slideSnapshot(s) {
  return {
    id: s.id,
    title: s.title,
    image_url: s.image_url,
    alt_text: s.alt_text,
    desktop_position: s.desktop_position,
    mobile_position: s.mobile_position,
    is_active: Number(s.is_active),
    sort_order: Number(s.sort_order)
  };
}

function publishChanges() {
  const snapshot = JSON.stringify(draftHeroSlides().map(slideSnapshot));
  db.transaction(() => {
    db.prepare('UPDATE site_content SET live_value = draft_value, updated_at = datetime(\'now\')').run();
    // Slice slides must be INSERTED the first time (UPDATE alone would silently do nothing
    // and the public site would keep reading the draft table).
    db.prepare(`INSERT INTO site_content (key, draft_value, live_value, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET draft_value = excluded.draft_value,
                  live_value = excluded.live_value, updated_at = datetime('now')`)
      .run(HERO_SLIDES_KEY, snapshot, snapshot);
    db.prepare(`UPDATE website_sections SET
        title = COALESCE(draft_title, title),
        description = COALESCE(draft_description, description),
        content = COALESCE(draft_content, content),
        layout = COALESCE(draft_layout, layout),
        sort_order = COALESCE(draft_sort_order, sort_order),
        is_active = COALESCE(draft_is_active, is_active),
        bg_color = COALESCE(draft_bg_color, ''),
        text_color = COALESCE(draft_text_color, ''),
        font = COALESCE(draft_font, ''),
        items_json = COALESCE(draft_items_json, ''),
        updated_at = datetime('now')`).run();
    db.prepare(`INSERT INTO site_content (key, draft_value, live_value, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET draft_value = excluded.draft_value,
                  live_value = excluded.live_value, updated_at = datetime('now')`)
      .run(PUBLISHED_AT_KEY, new Date().toISOString(), new Date().toISOString());
  })();
  return { slides: JSON.parse(snapshot).length };
}

/** Discard every unpublished change (draft ← live). */
function cancelChanges() {
  const published = publishedHeroSlides();
  db.transaction(() => {
    db.prepare('UPDATE site_content SET draft_value = live_value, updated_at = datetime(\'now\')').run();
    db.prepare(`UPDATE website_sections SET
        draft_title = title, draft_description = description, draft_content = content,
        draft_layout = layout, draft_sort_order = sort_order, draft_is_active = is_active,
        draft_bg_color = bg_color, draft_text_color = text_color,
        draft_font = font, draft_items_json = items_json`).run();
    // Restore the slide working table from the published snapshot.
    if (published && published.length) {
      db.prepare('DELETE FROM hero_slides').run();
      const ins = db.prepare(`INSERT INTO hero_slides
        (id, title, image_url, alt_text, desktop_position, mobile_position, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      published.forEach((s) => ins.run(s.id, s.title, s.image_url, s.alt_text,
        s.desktop_position, s.mobile_position, s.is_active, s.sort_order));
    }
  })();
}

function lastPublishedAt() {
  const row = db.prepare('SELECT live_value FROM site_content WHERE key = ?').get(PUBLISHED_AT_KEY);
  return row ? row.live_value : null;
}

module.exports = {
  HERO_SLIDES_KEY,
  getSiteContent,
  saveDraftValues,
  getSections,
  activeSectionKeys,
  saveSectionDrafts,
  getAppearance,
  themeFromAppearance,
  fontByValue,
  getHeroSlides,
  getHeroSlidesForAdmin,
  pendingChanges,
  publishChanges,
  cancelChanges,
  lastPublishedAt
};

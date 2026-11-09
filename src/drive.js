'use strict';

/**
 * Google Drive reader (V9.2) — reads photos from a folder the owner pastes in.
 *
 * IMPORTANT — why this is a SEPARATE authorization:
 * `src/gcal.js` uses the `drive.file` scope, which only sees files the app itself
 * created. Photos uploaded by a human from Drive/phone are invisible to it (verified
 * against the live account: the booking folders list 0 children). Reading them needs
 * either
 *   (a) OAuth with `drive.readonly` — sees everything the connected account can see
 *       (its own Drive + anything shared with it), or
 *   (b) an API key — works for folders shared as "anyone with the link".
 * Both are supported here and NEITHER touches the Calendar / folder-creation
 * connection in gcal.js, so the working OAuth setup stays exactly as it is.
 *
 * The owner enables one of them at Admin → Seleksi Foto → Pengaturan.
 * With neither configured, every Drive action fails with an actionable message
 * (never dummy photos).
 */

const crypto = require('crypto');
const { getSettings, saveSettings } = require('./db');

const TOKEN_URL = process.env.GCAL_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const AUTH_URL = process.env.GCAL_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_BASE = process.env.GDRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';

const SCOPE_READ = 'https://www.googleapis.com/auth/drive.readonly';
const STATE_KEY = 'selection_drive_state';
const MAX_PAGES = 30;             // 30 × 1000 files — a hard stop, never a silent truncation
const PAGE_SIZE = 1000;
const MAX_BYTES = 30 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
function config() {
  const s = getSettings();
  return {
    apiKey: (s.gdrive_api_key || '').trim(),
    clientId: (s.gdrive_reader_client_id || s.gdrive_client_id || '').trim(),
    clientSecret: (s.gdrive_reader_client_secret || s.gdrive_client_secret || '').trim(),
    refreshToken: (s.gdrive_reader_refresh_token || '').trim(),
    account: (s.gdrive_reader_account || '').trim(),
    connectedAt: (s.gdrive_reader_connected_at || '').trim(),
    lastError: (s.gdrive_reader_last_error || '').trim()
  };
}

const oauthReady = (c = config()) => Boolean(c.clientId && c.clientSecret && c.refreshToken);
const apiKeyReady = (c = config()) => Boolean(c.apiKey);
/** True when photos can be read at all. */
const isConfigured = (c = config()) => oauthReady(c) || apiKeyReady(c);
const mode = (c = config()) => (oauthReady(c) ? 'oauth' : apiKeyReady(c) ? 'apikey' : 'none');

/* ------------------------------------------------------------------ */
/* Error mapping — every failure explains itself to the admin          */
/* ------------------------------------------------------------------ */
function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function mapApiError(res, data) {
  const raw = data && data.error ? data.error : {};
  const msg = String(raw.message || `HTTP ${res.status}`);
  const reasons = (raw.errors || []).map((e) => e.reason).join(',');
  const detail = `${msg}${reasons ? ` [${reasons}]` : ''}`;

  if (res.status === 401) {
    return fail('auth', 'Akses Google Drive ditolak (401). Hubungkan ulang akun Drive untuk membaca foto.', { status: res.status });
  }
  if (res.status === 403) {
    if (/quota|rateLimit|dailyLimit/i.test(detail)) {
      return fail('quota', 'Kuota Google Drive API terlampaui. Tunggu beberapa menit (atau besok) lalu coba lagi.', { status: res.status });
    }
    if (/accessNotConfigured|has not been used|is disabled/i.test(detail)) {
      return fail('api-disabled', 'Google Drive API belum diaktifkan di project Google Cloud. Aktifkan "Google Drive API" di APIs & Services → Library, tunggu ±2 menit, lalu coba lagi.', { status: res.status });
    }
    return fail('permission', 'Folder ini tidak bisa dibaca dengan izin yang ada. Pastikan folder dibagikan ke akun Drive yang terhubung (atau atur "Siapa saja yang memiliki link"), lalu coba lagi.', { status: res.status });
  }
  if (res.status === 404) {
    return fail('not-found', 'Folder atau file tidak ditemukan. Periksa kembali link folder Drive-nya — pastikan folder masih ada dan belum dipindahkan ke Trash.', { status: res.status });
  }
  if (res.status === 429) {
    return fail('quota', 'Terlalu banyak permintaan ke Google Drive. Tunggu sebentar lalu coba lagi.', { status: res.status });
  }
  return fail('api', `Google Drive menolak permintaan: ${detail}`, { status: res.status });
}

function requireConfigured() {
  const c = config();
  if (!isConfigured(c)) {
    throw fail('not-configured',
      'Akses baca Google Drive belum diatur. Buka Pengaturan Seleksi Foto untuk mengisi API key '
      + 'atau menghubungkan akun Drive dengan izin baca.');
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* OAuth (reader only — scope drive.readonly)                          */
/* ------------------------------------------------------------------ */
function createState() {
  const state = crypto.randomBytes(24).toString('hex');
  saveSettings({ [STATE_KEY]: `${state}:${Date.now()}` });
  return state;
}

function consumeState(state) {
  const raw = String(getSettings()[STATE_KEY] || '');
  if (!raw || !state) return false;
  const [saved, ts] = raw.split(':');
  // Only clear when THIS callback is the one that started the reader flow. Clearing on a
  // mismatch destroyed a pending reader state whenever the Calendar/Drive callback arrived
  // first (two connect flows open at once), which then failed with "state invalid".
  if (saved !== state) return false;
  saveSettings({ [STATE_KEY]: '' });
  return Date.now() - Number(ts) < 15 * 60 * 1000;
}

/** True while an OAuth round-trip started by this module is pending. */
const hasPendingState = () => Boolean(getSettings()[STATE_KEY]);

function buildAuthUrl(state, uri) {
  const c = config();
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: uri,
    response_type: 'code',
    scope: SCOPE_READ,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code, uri) {
  const c = config();
  const body = new URLSearchParams({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: uri,
    grant_type: 'authorization_code'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    const msg = data.error_description || data.error
      || 'Google tidak mengirim refresh token. Ulangi dan pastikan Anda menekan "Allow" pada izin baca Drive.';
    throw fail('oauth', `Gagal menghubungkan akun Drive: ${msg}`);
  }
  return data;
}

let cached = { value: '', expiresAt: 0 };

async function accessToken(force = false) {
  const c = requireConfigured();
  if (!oauthReady(c)) return '';
  if (!force && cached.value && Date.now() < cached.expiresAt - 60_000) return cached.value;
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    cached = { value: '', expiresAt: 0 };
    if (data.error === 'invalid_grant') {
      saveSettings({
        gdrive_reader_refresh_token: '',
        gdrive_reader_last_error: 'Akses baca Drive dicabut atau kedaluwarsa. Hubungkan ulang akun Drive.'
      });
    }
    throw fail('auth', `Gagal memperbarui token Google Drive: ${data.error_description || data.error || `HTTP ${res.status}`}`);
  }
  cached = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cached.value;
}

function resetTokenCache() {
  cached = { value: '', expiresAt: 0 };
}

/* ------------------------------------------------------------------ */
/* Authenticated request                                               */
/* ------------------------------------------------------------------ */
async function apiFetch(path, { retried = false, raw = false } = {}) {
  const c = requireConfigured();
  const params = new URLSearchParams();
  let auth = '';
  if (oauthReady(c)) {
    const token = await accessToken(retried);
    auth = `Bearer ${token}`;
  } else {
    // API-key mode: only public/shared folders are readable, no consent needed.
    params.set('key', c.apiKey);
    auth = '';
  }
  const url = `${DRIVE_BASE}${path}${path.includes('?') ? '&' : '?'}${params.toString()}`;
  const headers = auth ? { Authorization: auth } : {};
  const res = await fetch(url, { headers });

  if (res.status === 401 && !retried && oauthReady(c)) {
    resetTokenCache();
    return apiFetch(path, { retried: true, raw });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = mapApiError(res, data);
    saveSettings({ gdrive_reader_last_error: err.message });
    throw err;
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  saveSettings({ gdrive_reader_last_error: '' });
  return data;
}

/* ------------------------------------------------------------------ */
/* Folder id parsing                                                   */
/* ------------------------------------------------------------------ */
/**
 * Accepts the many shapes a Drive folder link arrives in and returns the folder id:
 *   https://drive.google.com/drive/folders/<id>?usp=sharing
 *   https://drive.google.com/drive/u/1/folders/<id>
 *   https://drive.google.com/open?id=<id>
 *   https://drive.google.com/file/d/<id>/view      (a file, not a folder — rejected)
 *   <bare id>
 */
function parseFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, message: 'Link folder Google Drive belum diisi.' };

  if (/^[A-Za-z0-9_-]{15,}$/.test(raw)) return { ok: true, id: raw };

  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return { ok: false, message: 'Link tidak valid. Tempel link folder Google Drive yang lengkap (https://drive.google.com/…).' };
  }
  if (!/^https?:$/.test(url.protocol) || !/(^|\.)drive\.google\.com$/i.test(url.hostname)) {
    return { ok: false, message: 'Link harus berasal dari drive.google.com (link folder Google Drive).' };
  }

  const patterns = [
    /\/folders\/([A-Za-z0-9_-]{10,})/,
    /\/drive\/u\/\d+\/folders\/([A-Za-z0-9_-]{10,})/
  ];
  for (const re of patterns) {
    const m = re.exec(url.pathname + url.search);
    if (m) return { ok: true, id: m[1] };
  }
  const byQuery = url.searchParams.get('id');
  if (byQuery && /^[A-Za-z0-9_-]{10,}$/.test(byQuery)) return { ok: true, id: byQuery };

  if (/\/file\/d\//.test(url.pathname)) {
    return { ok: false, message: 'Link yang ditempel adalah link FILE, bukan folder. Buka folder induknya di Drive lalu salin link foldernya.' };
  }
  return { ok: false, message: 'Folder ID tidak ditemukan pada link tersebut. Gunakan link berbentuk https://drive.google.com/drive/folders/…' };
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */
const escapeQ = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const FOLDER_FIELDS = 'id,name,mimeType,webViewLink';

/** Folder metadata (also the cheapest way to verify access + give a clear error). */
async function getFolder(folderId) {
  const qs = new URLSearchParams({
    fields: FOLDER_FIELDS,
    supportsAllDrives: 'true'
  });
  try {
    const data = await apiFetch(`/files/${encodeURIComponent(folderId)}?${qs.toString()}`);
    if (data && data.mimeType && data.mimeType !== 'application/vnd.google-apps.folder') {
      throw fail('not-folder', 'Link yang ditempel mengarah ke file, bukan folder Drive.');
    }
    return { ok: true, folder: { id: data.id, name: data.name || '', url: data.webViewLink || '' } };
  } catch (err) {
    if (err.code === 'not-found') {
      throw fail('not-found',
        'Folder tidak ditemukan atau belum dibagikan ke akun Drive yang terhubung. '
        + 'Pastikan link benar dan folder dibagikan (minimal "Siapa saja yang memiliki link" atau ke email akun Drive tersebut).');
    }
    throw err;
  }
}

/**
 * Lists every image in a folder, following nextPageToken.
 * Resolves `{ files, truncated, pages }`; a `truncated` result is surfaced to the admin
 * instead of silently importing a partial gallery.
 */
async function listFolderPhotos(folderId, { onPage } = {}) {
  const files = [];
  let pageToken = '';
  let pages = 0;
  let truncated = false;
  const seen = new Set();

  for (;;) {
    const qs = new URLSearchParams({
      q: `'${escapeQ(folderId)}' in parents and trashed = false and mimeType contains 'image/'`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,imageMediaMetadata(width,height))',
      pageSize: String(PAGE_SIZE),
      orderBy: 'name_natural',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });
    if (pageToken) qs.set('pageToken', pageToken);

    const data = await apiFetch(`/files?${qs.toString()}`);
    const batch = (data && data.files) || [];
    batch.forEach((f) => {
      if (!f || !f.id || seen.has(f.id)) return; // never import the same file twice
      seen.add(f.id);
      files.push({
        id: f.id,
        name: f.name || f.id,
        mimeType: f.mimeType || '',
        size: Number(f.size) || 0,
        modifiedTime: f.modifiedTime || '',
        width: (f.imageMediaMetadata && Number(f.imageMediaMetadata.width)) || 0,
        height: (f.imageMediaMetadata && Number(f.imageMediaMetadata.height)) || 0
      });
    });
    pages += 1;
    if (onPage) onPage(files.length, pages);

    pageToken = (data && data.nextPageToken) || '';
    if (!pageToken) break;
    if (pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
  }

  return { files, pages, truncated };
}

/* ------------------------------------------------------------------ */
/* File bytes (server-side only — the browser never talks to Google)   */
/* ------------------------------------------------------------------ */
async function downloadBytes(fileId) {
  const path = `/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await apiFetch(path, { raw: true });
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) {
    throw fail('too-large', `Ukuran file melebihi batas ${Math.round(MAX_BYTES / 1024 / 1024)}MB sehingga tidak dapat diproses.`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) {
    throw fail('too-large', `Ukuran file melebihi batas ${Math.round(MAX_BYTES / 1024 / 1024)}MB sehingga tidak dapat diproses.`);
  }
  return buffer;
}

/** Verifies the credential really can read (used by the settings "Test" button). */
async function selfCheck() {
  const c = config();
  if (!isConfigured(c)) {
    return { ok: false, mode: 'none', message: 'Belum ada API key maupun akun Drive yang terhubung.' };
  }
  try {
    const data = await apiFetch('/about?fields=user(emailAddress,displayName,photoLink)');
    const user = (data && data.user) || {};
    if (user.emailAddress) saveSettings({ gdrive_reader_account: user.emailAddress });
    return { ok: true, mode: mode(), email: user.emailAddress || '', name: user.displayName || '' };
  } catch (err) {
    return { ok: false, mode: mode(), message: err.message, code: err.code || 'api' };
  }
}

module.exports = {
  SCOPE_READ,
  config,
  mode,
  isConfigured,
  oauthReady,
  apiKeyReady,
  parseFolderId,
  getFolder,
  listFolderPhotos,
  downloadBytes,
  selfCheck,
  createState,
  consumeState,
  hasPendingState,
  buildAuthUrl,
  exchangeCode,
  resetTokenCache,
  fail
};

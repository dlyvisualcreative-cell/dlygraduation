'use strict';

/**
 * Google Calendar + Google Drive integration (OAuth 2.0, no external dependencies).
 *
 * Calendar: one event per booking. confirmed/completed ⇒ create/PATCH, pending/cancelled ⇒ delete.
 * Drive:   <Month Year>/Graduation <Client> - <Campus>/ is created on demand; its link is written
 *          into the calendar description automatically.
 *
 * Endpoint bases are env-overridable so the test suite can point them at a local mock
 * (scripts/mock-google.js). Production always uses the real Google endpoints.
 */

const crypto = require('crypto');
const { db, getSettings, saveSettings } = require('./db');
const team = require('./team');
const util = require('./util');

const TOKEN_URL = process.env.GCAL_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const AUTH_URL = process.env.GCAL_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const API_BASE = process.env.GCAL_API_BASE || 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = process.env.GDRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';

const SCOPE_CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.file';
const SCOPE = `${SCOPE_CALENDAR} ${SCOPE_DRIVE}`;

const STATE_KEY = 'gcal_oauth_state';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
  'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
function config() {
  const s = getSettings();
  return {
    enabled: s.gcal_enabled === '1',
    clientId: (s.gcal_client_id || '').trim(),
    clientSecret: (s.gcal_client_secret || '').trim(),
    refreshToken: (s.gcal_refresh_token || '').trim(),
    calendarId: (s.gcal_calendar_id || 'primary').trim() || 'primary',
    defaultTime: /^\d{2}:\d{2}$/.test(s.gcal_default_time || '') ? s.gcal_default_time : '09:00',
    durationFallback: Math.max(15, Number(s.gcal_duration_fallback) || 60),
    timezone: (s.gcal_timezone || 'Asia/Jakarta').trim() || 'Asia/Jakarta',
    team: (s.gcal_team || '').trim(),
    driveEnabled: s.gcal_drive_enabled !== '0',
    connectedAt: s.gcal_connected_at || '',
    account: s.gcal_account || '',
    lastError: s.gcal_last_error || '',
    driveScopes: s.gcal_drive_scopes === '1',
    // Optional separate OAuth client for Drive (may live in another Cloud project).
    driveClientId: (s.gdrive_client_id || '').trim(),
    driveClientSecret: (s.gdrive_client_secret || '').trim(),
    // Optional separate Google account for Drive (e.g. the one with storage).
    driveRefreshToken: (s.gdrive_refresh_token || '').trim(),
    driveConnectedAt: s.gdrive_connected_at || '',
    driveAccount: s.gdrive_account || '',
    driveError: s.gdrive_last_error || ''
  };
}

const hasCredentials = (c = config()) => Boolean(c.clientId && c.clientSecret);

/**
 * Which OAuth client to use for a connection.
 * Drive may have its own client (different Cloud project / different owner);
 * when it does not, both connections share the Calendar client.
 * A client id and secret must always come from the SAME client, so a partial
 * pair falls back to the shared one instead of mixing credentials.
 */
function clientFor(kind, c = config()) {
  if (kind === 'drive' && c.driveClientId && c.driveClientSecret) {
    return { id: c.driveClientId, secret: c.driveClientSecret, own: true };
  }
  return { id: c.clientId, secret: c.clientSecret, own: false };
}

const hasCredentialsFor = (kind, c = config()) => {
  const client = clientFor(kind, c);
  return Boolean(client.id && client.secret);
};

/** Calendar connection: the primary authorization. */
const isConnected = (c = config()) => Boolean(hasCredentials(c) && c.refreshToken);

/**
 * Resolve the Drive authorization.
 * A refresh token is bound to the OAuth client that issued it, so:
 *  - Drive with its own client ⇒ MUST have its own refresh token;
 *  - Drive sharing the Calendar client ⇒ may reuse the Calendar token.
 * Mixing them would make every Drive call fail with unauthorized_client.
 */
function driveConnection(c = config()) {
  const client = clientFor('drive', c);
  const haveClient = Boolean(client.id && client.secret);
  if (c.driveRefreshToken && haveClient) {
    return { ok: true, token: c.driveRefreshToken, ownToken: true, ownClient: client.own };
  }
  if (!client.own && c.refreshToken) {
    return { ok: true, token: c.refreshToken, ownToken: false, ownClient: false };
  }
  return { ok: false, token: '', ownToken: false, ownClient: client.own };
}

const isDriveConnected = (c = config()) => driveConnection(c).ok;
const driveUsesOwnAccount = (c = config()) => Boolean(c.driveRefreshToken);
const isActive = (c = config()) => Boolean(c.enabled && isConnected(c));

function redirectUri(req) {
  return `${req.protocol}://${req.get('host')}${req.basePath}/admin/google/callback`;
}

/* ------------------------------------------------------------------ */
/* OAuth                                                               */
/* ------------------------------------------------------------------ */
function createState(kind = 'calendar') {
  const state = crypto.randomBytes(24).toString('hex');
  saveSettings({ [STATE_KEY]: `${state}:${Date.now()}:${kind}` });
  return state;
}

/** Returns the connection kind ('calendar' | 'drive') or false when invalid. */
function consumeState(state) {
  const raw = getSettings()[STATE_KEY] || '';
  saveSettings({ [STATE_KEY]: '' });
  if (!raw || !state) return false;
  const [saved, ts, kind] = raw.split(':');
  if (saved !== state) return false;
  if (Date.now() - Number(ts) >= 15 * 60 * 1000) return false;
  return kind === 'drive' ? 'drive' : 'calendar';
}

function buildAuthUrl(state, uri, kind = 'calendar') {
  const c = config();
  const client = clientFor(kind, c);
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: uri,
    response_type: 'code',
    scope: kind === 'drive' ? SCOPE_DRIVE : SCOPE_CALENDAR,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code, uri, kind = 'calendar') {
  const c = config();
  const client = clientFor(kind, c);
  const body = new URLSearchParams({
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: uri,
    grant_type: 'authorization_code'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Gagal menukar kode otorisasi: ${msg}`);
  }
  if (!data.refresh_token) {
    // Google sometimes returns only an access token (e.g. consent already granted).
    // Keep the previously stored refresh token instead of breaking the connection.
    const previous = kind === 'drive' ? c.driveRefreshToken : c.refreshToken;
    if (previous) return { ...data, refresh_token: previous, reused: true };
    throw new Error('Google tidak mengirim refresh token. Buka ulang halaman ini dan hubungkan lagi, pastikan Anda menekan "Allow"/"Izinkan" pada semua izin.');
  }
  return data;
}

// One cache slot per connection so the two accounts never share a token.
const tokenCache = { calendar: { value: '', expiresAt: 0 }, drive: { value: '', expiresAt: 0 } };

function resetTokenCache(kind) {
  if (kind) tokenCache[kind] = { value: '', expiresAt: 0 };
  else {
    tokenCache.calendar = { value: '', expiresAt: 0 };
    tokenCache.drive = { value: '', expiresAt: 0 };
  }
}

async function accessToken(kind = 'calendar', force = false) {
  const c = config();
  const cache = tokenCache[kind] || tokenCache.calendar;

  const refreshToken = kind === 'drive' ? driveConnection(c).token : c.refreshToken;
  if (!refreshToken) throw new Error(kind === 'drive' ? 'Google Drive belum terhubung.' : 'Google Calendar belum terhubung.');
  if (!force && cache.value && Date.now() < cache.expiresAt - 60_000) return cache.value;

  const client = clientFor(kind, c);
  const body = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    if (data.error === 'invalid_grant') {
      if (kind === 'drive' && c.driveRefreshToken) {
        saveSettings({ gdrive_refresh_token: '', gdrive_last_error: 'Akses Drive dicabut. Hubungkan ulang akun Drive.' });
      } else {
        saveSettings({ gcal_refresh_token: '', gcal_last_error: 'Akses Google dicabut. Silakan hubungkan ulang.' });
      }
      resetTokenCache(kind);
    }
    throw new Error(`Gagal memperbarui token Google: ${msg}`);
  }
  tokenCache[kind] = {
    value: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
  };
  return tokenCache[kind].value;
}

const OAUTH_HINTS = {
  access_denied: 'Anda menekan "Tolak"/menutup layar izin, atau akun Google ini belum terdaftar sebagai Test user di project OAuth. Tambahkan email tersebut di OAuth consent screen → Test users.',
  redirect_uri_mismatch: 'Redirect URI belum terdaftar di OAuth client Google Cloud. Tambahkan URI yang tampil di halaman ini (harus sama persis, termasuk https dan tanpa garis miring di akhir).',
  invalid_client: 'Client ID / Client Secret tidak cocok atau sudah dihapus di Google Cloud. Periksa kembali nilainya.',
  unauthorized_client: 'Client ini tidak diizinkan memakai refresh token tersebut. Hubungkan ulang akunnya.',
  invalid_grant: 'Akses sudah dicabut atau kedaluwarsa. Hubungkan ulang akunnya.',
  admin_policy_enforced: 'Akun Google Workspace Anda memblokir aplikasi ini. Hubungi admin Workspace atau pakai akun Gmail biasa.',
  org_internal: 'OAuth consent screen disetel "Internal" sehingga hanya akun dalam organisasi yang boleh masuk. Ubah menjadi "External".',
  invalid_scope: 'Izin yang diminta tidak valid untuk client ini. Pastikan Calendar API dan Drive API sudah diaktifkan di project tersebut.'
};

function oauthHint(code, description) {
  const key = String(code || '').trim();
  if (OAUTH_HINTS[key]) return OAUTH_HINTS[key];
  return description || '';
}

const API_DISABLED = /has not been used in project|is disabled|accessNotConfigured|SERVICE_DISABLED/i;

/** Turns Google's raw messages into something actionable, and flags the cause. */
function markScopeProblem(err, kind = 'calendar') {
  const msg = String((err && err.message) || '');
  if (API_DISABLED.test(msg)) {
    err.apiDisabled = true;
    err.friendly = kind === 'drive'
      ? 'Google Drive API belum diaktifkan di project Google Cloud Anda. Buka console.cloud.google.com → APIs & Services → Library → aktifkan "Google Drive API", tunggu ±2 menit, lalu coba lagi.'
      : 'Google Calendar API belum diaktifkan di project Google Cloud Anda. Aktifkan di APIs & Services → Library.';
    saveSettings(kind === 'drive' ? { gdrive_last_error: err.friendly } : { gcal_last_error: err.friendly });
    return err;
  }
  if (err && err.status === 403 && /insufficient|scope/i.test(msg)) {
    err.scopeMissing = true;
    err.friendly = kind === 'drive'
      ? 'Izin Google Drive belum diberikan untuk akun ini. Klik "Hubungkan akun Drive".'
      : 'Izin Google Calendar belum diberikan. Klik "Hubungkan ulang".';
    saveSettings(kind === 'drive'
      ? { gdrive_last_error: err.friendly }
      : { gcal_drive_scopes: '0', gcal_last_error: err.friendly });
  }
  return err;
}

async function request(base, path, options = {}, retried = false, kind = 'calendar') {
  const token = await accessToken(kind, retried);
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (res.status === 204) return { ok: true, data: null };
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && !retried) {
    resetTokenCache(kind);
    return request(base, path, options, true, kind);
  }
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || `HTTP ${res.status}`;
    const err = new Error(typeof msg === 'string' ? msg : `HTTP ${res.status}`);
    err.status = res.status;
    throw markScopeProblem(err, kind);
  }
  return { ok: true, data };
}

const api = (path, options) => request(API_BASE, path, options, false, 'calendar');
const drive = (path, options) => request(DRIVE_BASE, path, options, false, 'drive');

/**
 * Which Gmail is authorized for Calendar?
 * `calendar.events` cannot read the user profile, but the events list returns the calendar
 * name, which for `primary` is the account's email address.
 */
async function fetchCalendarAccount() {
  const c = config();
  if (!isConnected(c)) return null;
  try {
    const cal = encodeURIComponent(c.calendarId);
    const res = await api(`/calendars/${cal}/events?maxResults=1&singleEvents=true`);
    const summary = (res.data && res.data.summary) || '';
    if (summary) saveSettings({ gcal_account: summary });
    return { email: summary };
  } catch (err) {
    return null;
  }
}

/**
 * Which Gmail is authorized for Drive? `drive.file` is enough to read the basic user profile,
 * so we can show the owner the exact address instead of guessing between two accounts.
 */
async function fetchDriveAccount() {
  const c = config();
  if (!isDriveConnected(c)) return null;
  try {
    const res = await drive('/about?fields=user(displayName,emailAddress)');
    const user = (res.data && res.data.user) || {};
    const email = user.emailAddress || '';
    if (email) saveSettings({ gdrive_account: email });
    return { email, name: user.displayName || '' };
  } catch (err) {
    return null;
  }
}

/**
 * Checks that a Client ID + Client Secret really belong to each other, WITHOUT needing a
 * user consent screen: a token request carrying a bogus authorization code makes Google
 * authenticate the client first. Google answers `invalid_client` when the pair does not
 * match, and `invalid_grant` / `redirect_uri_mismatch` when the pair itself is fine.
 *
 * Returns { ok: true|false|null, message } (null = Google unreachable, verdict unknown).
 * Never throws, never stores anything.
 */
async function verifyClientPair(kind = 'calendar', c = config()) {
  const client = clientFor(kind, c);
  const label = kind === 'drive' ? 'Drive' : 'Calendar';
  if (!client.id || !client.secret) {
    return { ok: false, message: `${label}: Client ID/Secret belum lengkap.` };
  }
  const body = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    code: 'dly-pair-check',
    grant_type: 'authorization_code',
    redirect_uri: 'http://localhost/dly-pair-check'
  });
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await res.json().catch(() => ({}));
    const err = String(data.error || '');
    if (err === 'invalid_client') {
      return {
        ok: false,
        message: `${label}: Client ID dan Client Secret TIDAK cocok (Google menolak: invalid_client). `
          + 'Salin ulang pasangan dari Google Cloud Console → Credentials → OAuth client.'
      };
    }
    if (err === 'invalid_grant' || err === 'redirect_uri_mismatch' || err === '') {
      return { ok: true, message: `${label}: Client ID & Secret cocok.` };
    }
    return { ok: true, message: `${label}: Client ID & Secret diterima (${err}).` };
  } catch (err) {
    return { ok: null, message: `${label}: tidak dapat menghubungi Google (${err.message}).` };
  }
}

/** Verifies both connections; reports each one separately. */
async function selfCheck() {
  const c = config();
  const result = { calendar: { ok: false }, drive: { ok: false } };

  if (isConnected(c)) {
    try {
      const cal = encodeURIComponent(c.calendarId);
      const r = await api(`/calendars/${cal}/events?maxResults=1&singleEvents=true`);
      result.calendar = { ok: true, email: (r.data && r.data.summary) || '' };
      saveSettings({
        gcal_last_error: '',
        gcal_checked_at: new Date().toISOString(),
        ...(r.data && r.data.summary ? { gcal_account: r.data.summary } : {})
      });
    } catch (err) {
      result.calendar = { ok: false, error: err.friendly || err.message };
    }
  } else {
    result.calendar = { ok: false, error: 'Google Calendar belum terhubung.' };
  }

  if (isDriveConnected(c)) {
    try {
      await drive('/files?pageSize=1&fields=files(id)');
      result.drive = { ok: true };
      await fetchDriveAccount();
      saveSettings({ gcal_drive_scopes: '1', gdrive_last_error: '', gdrive_checked_at: new Date().toISOString() });
    } catch (err) {
      result.drive = { ok: false, error: err.friendly || err.message, apiDisabled: Boolean(err.apiDisabled) };
      if (!err.apiDisabled) saveSettings({ gdrive_last_error: err.friendly || err.message });
    }
  } else {
    result.drive = { ok: false, error: 'Google Drive belum terhubung.' };
  }

  if (!result.calendar.ok && result.calendar.error) {
    return { ...result, ok: false, error: result.calendar.error };
  }
  return { ...result, ok: result.calendar.ok && result.drive.ok };
}

/* ------------------------------------------------------------------ */
/* Google Drive                                                        */
/* ------------------------------------------------------------------ */
const escapeQ = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function findFolder(name, parentId) {
  const parts = [
    `name = '${escapeQ(name)}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false'
  ];
  if (parentId) parts.push(`'${escapeQ(parentId)}' in parents`);
  const qs = new URLSearchParams({
    q: parts.join(' and '),
    fields: 'files(id,name,webViewLink)',
    pageSize: '10',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const res = await drive(`/files?${qs.toString()}`);
  const files = (res.data && res.data.files) || [];
  return files[0] || null;
}

async function createFolder(name, parentId) {
  const body = { name, mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  const qs = new URLSearchParams({ fields: 'id,name,webViewLink', supportsAllDrives: 'true' });
  const res = await drive(`/files?${qs.toString()}`, { method: 'POST', body: JSON.stringify(body) });
  return res.data;
}

async function ensureFolder(name, parentId) {
  const existing = await findFolder(name, parentId);
  if (existing) return { ...existing, created: false };
  const created = await createFolder(name, parentId);
  return { ...created, created: true };
}

/** "November 2026" — includes the year so next year's bookings never mix in. */
function monthFolderName(dateISO) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  return `${MONTHS_ID[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function clientFolderName(booking) {
  const client = String(booking.client_name || '').trim();
  const campus = String(booking.campus || '').trim();
  const code = String(booking.code || '').trim();
  // Tahap 7 format: "<Nama Client> - <Kampus> - <Kode Booking>"
  // (existing folders keep their old name — a cached folder is reused, never renamed)
  const base = [client, campus, code].filter(Boolean).join(' - ') || 'Graduation';
  // Google Drive rejects "/" and some other characters in names.
  return base.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Subfolder standar di dalam folder klien (blueprint §10.1):
 *   01. FILE MENTAH · 02. FILE SORTIR · 03. FILE EDIT
 * Dibuat bila belum ada; folder lama TIDAK di-rename dan file TIDAK dipindahkan.
 * Return { ok, ids:{raw,sortir,edit}, created }.
 */
const DRIVE_SUBFOLDERS = [
  { key: 'raw', name: '01. FILE MENTAH', column: 'drive_raw_id' },
  { key: 'sortir', name: '02. FILE SORTIR', column: 'drive_sortir_id' },
  { key: 'edit', name: '03. FILE EDIT', column: 'drive_edit_id' }
];

async function ensureSubfolders(bookingId, parentId, existing = {}) {
  if (!parentId) return { ok: false, skipped: true, reason: 'no-parent' };
  const ids = {};
  let created = 0;
  for (const def of DRIVE_SUBFOLDERS) {
    const known = existing[def.key];
    if (known) {
      // Verifikasi ringan: folder yang dihapus owner akan dibuat ulang.
      try {
        await drive(`/files/${encodeURIComponent(known)}?fields=id&supportsAllDrives=true`);
        ids[def.key] = known;
        continue;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const folder = await ensureFolder(def.name, parentId);
    if (folder.created) created += 1;
    ids[def.key] = folder.id;
  }
  db.prepare(`UPDATE bookings SET drive_raw_id = ?, drive_sortir_id = ?, drive_edit_id = ?
              WHERE id = ?`).run(ids.raw || null, ids.sortir || null, ids.edit || null, Number(bookingId));
  return { ok: true, ids, created };
}

/**
 * Membaca satu folder Drive yang SUDAH tersimpan pada booking.
 *
 * Dipakai saat admin menekan "Selesaikan Order": link final tidak lagi diketik
 * manual, jadi sistem harus memastikan folder "03. FILE EDIT" milik booking ini
 * benar-benar ada dan bisa diakses, lalu memakai `webViewLink` ASLI dari Google
 * (bukan URL yang dirakit sendiri dari ID).
 *
 * Return { ok:true, id, url, name }. Melempar Error dengan pesan yang bisa
 * ditampilkan ke admin bila folder hilang / Drive belum terhubung.
 */
async function driveFolderInfo(folderId) {
  const id = String(folderId || '').trim();
  if (!id) {
    const err = new Error('Folder Drive belum tersimpan untuk booking ini.');
    err.code = 'no-folder';
    throw err;
  }
  const c = config();
  if (!isDriveConnected(c)) {
    const err = new Error('Google Drive belum terhubung, jadi folder final tidak bisa diverifikasi.');
    err.code = 'drive-off';
    throw err;
  }
  try {
    const res = await drive(`/files/${encodeURIComponent(id)}?fields=id,name,webViewLink,mimeType,trashed&supportsAllDrives=true`);
    const data = res.data || {};
    if (data.trashed) {
      const err = new Error('Folder final sudah dihapus (ada di Trash) di Google Drive.');
      err.code = 'trashed';
      throw err;
    }
    if (!data.webViewLink) {
      const err = new Error('Google tidak mengembalikan link folder final.');
      err.code = 'no-link';
      throw err;
    }
    return { ok: true, id: data.id || id, url: data.webViewLink, name: data.name || '' };
  } catch (err) {
    if (err.code) throw err;
    if (err.status === 404) {
      const e = new Error('Folder final tidak ditemukan di Google Drive (mungkin sudah dihapus atau dipindah).');
      e.code = 'gone';
      throw e;
    }
    if (err.status === 403) {
      const e = new Error('Akses ke folder final ditolak. Pastikan akun Google yang terhubung masih punya izin.');
      e.code = 'forbidden';
      throw e;
    }
    throw err;
  }
}

/**
 * Creates <Month Year>/<Graduation client - campus> for a booking and stores the link.
 * Returns { ok, url, path, created } — never throws.
 */
async function ensureDriveFolder(bookingId) {
  const c = config();
  const booking = loadBooking(bookingId);
  if (!booking) return { ok: false, skipped: true, reason: 'not-found' };
  if (!c.enabled || !c.driveEnabled) return { ok: false, skipped: true, reason: 'disabled' };
  if (!isDriveConnected(c)) return { ok: false, skipped: true, reason: 'drive-not-connected' };

  // Reuse the cached folder only while it still exists in Drive (the owner may have deleted it).
  if (booking.drive_folder_url && booking.drive_folder_id) {
    try {
      await drive(`/files/${encodeURIComponent(booking.drive_folder_id)}?fields=id,webViewLink&supportsAllDrives=true`);
      // Folder lama tetap dipakai; subfolder 01/02/03 ditambahkan bila belum ada.
      let subfolders = { ok: true, ids: {} };
      try {
        subfolders = await ensureSubfolders(booking.id, booking.drive_folder_id, {
          raw: booking.drive_raw_id, sortir: booking.drive_sortir_id, edit: booking.drive_edit_id
        });
      } catch (err) { /* subfolder opsional: jangan gagalkan folder utama */ }
      return {
        ok: true,
        url: booking.drive_folder_url,
        path: booking.drive_folder_path,
        cached: true,
        subfolders: subfolders.ids || {}
      };
    } catch (err) {
      if (err.status !== 404) {
        const message = String(err.friendly || err.message || err).slice(0, 400);
        db.prepare('UPDATE bookings SET drive_error = ? WHERE id = ?').run(message, booking.id);
        return { ok: false, error: message };
      }
      // folder is gone → forget the stale link and rebuild it below
      db.prepare(`UPDATE bookings SET drive_folder_id = NULL, drive_folder_url = NULL,
                  drive_folder_path = '' WHERE id = ?`).run(booking.id);
    }
  }

  if (!isDriveConnected(c)) return { ok: false, skipped: true, reason: 'drive-not-connected' };

  try {
    const month = await ensureFolder(monthFolderName(booking.shooting_date), null);
    const clientFolder = await ensureFolder(clientFolderName(booking), month.id);
    const path = `${month.name}/${clientFolder.name}`;
    db.prepare(`UPDATE bookings SET drive_folder_id = ?, drive_folder_url = ?, drive_folder_path = ?,
                drive_synced_at = datetime('now') WHERE id = ?`)
      .run(clientFolder.id, clientFolder.webViewLink, path, booking.id);
    saveSettings({ gcal_drive_scopes: '1' });
    let subfolders = { ok: true, ids: {} };
    try {
      subfolders = await ensureSubfolders(booking.id, clientFolder.id, {});
    } catch (err) { /* subfolder opsional */ }
    return {
      ok: true,
      url: clientFolder.webViewLink,
      id: clientFolder.id,
      path,
      createdAt: month.created || clientFolder.created,
      created: month.created || clientFolder.created,
      subfolders: subfolders.ids || {}
    };
  } catch (err) {
    const message = String(err.friendly || err.message || err).slice(0, 400);
    db.prepare("UPDATE bookings SET drive_error = ? WHERE id = ?").run(message, booking.id);
    if (!err.scopeMissing && !err.apiDisabled) saveSettings({ gdrive_last_error: message });
    return {
      ok: false,
      error: message,
      scopeMissing: Boolean(err.scopeMissing),
      apiDisabled: Boolean(err.apiDisabled)
    };
  }
}

/* ------------------------------------------------------------------ */
/* Event payload                                                       */
/* ------------------------------------------------------------------ */
function pad(n) { return String(n).padStart(2, '0'); }

function addMinutesToLocal(dateISO, time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(`${dateISO}T${pad(h)}:${pad(m)}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

const STATUS_LABEL = {
  pending: 'MENUNGGU KONFIRMASI',
  confirmed: 'SUDAH TERKONFIRMASI',
  completed: 'SELESAI',
  cancelled: 'DIBATALKAN'
};

function slotTimes(booking, c) {
  const minutes = Number(booking.duration_minutes || booking.duration) || c.durationFallback;
  // The client's chosen time wins; the dashboard default is only a fallback for older bookings.
  const bookingTime = /^\d{2}:\d{2}$/.test(booking.shooting_time || '') ? booking.shooting_time : null;
  const startHM = bookingTime || c.defaultTime;
  const start = `${booking.shooting_date}T${startHM}:00`;
  const end = addMinutesToLocal(booking.shooting_date, startHM, minutes);
  return { start, end, minutes, startHM, endHM: end.slice(11, 16), usesBookingTime: Boolean(bookingTime) };
}

function longDate(dateISO) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  return `${DAYS_ID[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_ID[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Calendar description in the "DLY GRADUATION - DETAIL BOOKING" layout:
 * field list → Drive link → notes → separator → H-1 chat template.
 */
function buildEvent(booking) {
  const c = config();
  const { start, end, minutes, startHM, endHM } = slotTimes(booking, c);

  let addons = [];
  try { addons = JSON.parse(booking.addons_snapshot || '[]'); } catch (err) { addons = []; }

  const money = (n) => (n ? 'Rp ' + Number(n).toLocaleString('id-ID') : '-');
  const dash = (v) => (v && String(v).trim() ? String(v).trim() : '-');
  const location = [booking.location, booking.location_address].filter(Boolean).join(', ');
  // Team: every assigned member (Tahap 7), falling back to the legacy single column and
  // finally to the dashboard default.
  const teamName = (booking.teamNames || '').trim()
    || (booking.team_name_snapshot || '').trim() || c.team || '-';
  const teamLabel = teamName; // NOTE: never name this `team` — it would shadow the module
  const driveUrl = booking.drive_folder_url || '';

  const details = [
    'DLY GRADUATION - DETAIL BOOKING',
    '',
    `Nama: ${booking.client_name}`,
    `Kode Booking: ${booking.code}`,
    `Acara: ${String(booking.category_name || 'Sesi Foto Wisuda').toUpperCase()}`,
    `WhatsApp: ${booking.client_phone}`,
    `Instagram: ${booking.instagram ? '@' + booking.instagram : '-'}`,
    `Kampus: ${dash(booking.campus)}${booking.faculty || booking.major
      ? ' — ' + [booking.faculty, booking.major].filter(Boolean).join(' / ') : ''}`,
    `Lokasi: ${dash(location)}`,
    `Paket: ${booking.package_name || '-'}`,
    `Jam: ${startHM}–${endHM} WIB`,
    `Durasi: ${minutes} menit`,
    `Addon: ${addons.length ? addons.map((a) => a.name).join(', ') : '-'}`,
    `Tim yang bertugas: ${teamLabel}`,
    `Status: ${STATUS_LABEL[booking.status] || String(booking.status).toUpperCase()}`,
    '',
    '\uD83D\uDCC1 LINK GOOGLE DRIVE',
    driveUrl || 'Link Menyusul',
    '',
    `Catatan: ${booking.notes && booking.notes.trim() ? booking.notes : '-'}`,
    '',
    '================================',
    '',
    'Template Chat Client H-1',
    '',
    // Teks H-1 bisa diubah admin di Dashboard → Template Chat (`wa_h1_template`).
    util.renderTemplate(
      String(getSettings().wa_h1_template || '').trim() || util.DEFAULT_H1_TEMPLATE,
      util.h1Vars({
        client_name: booking.client_name,
        team_label: teamLabel !== '-' ? teamLabel : 'tim',
        date_label: longDate(booking.shooting_date),
        time_label: `${startHM}–${endHM}`,
        lokasi: dash(location),
        code: booking.code,
        campus: booking.campus,
        package_name: booking.package_name
      })
    )
  ];

  // Invite EVERY assigned crew member with a valid email (Google sends the invitations).
  const attendees = booking.teamList && booking.teamList.length
    ? team.attendeesFor(booking.id)
    : (() => {
      const email = (booking.team_email_snapshot || '').trim();
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
        ? [{ email, displayName: teamName !== '-' ? teamName : undefined }]
        : [];
    })();

  // Title format requested by the owner: "Dly Visual | <Nama Client> | Graduation".
  // The first word keeps it short enough to read on a phone's calendar.
  const shortName = String(booking.client_name || '').trim().split(/\s+/).slice(0, 2).join(' ');

  return {
    summary: `Dly Visual | ${shortName || 'Client'} | Graduation`,
    description: details.join('\n'),
    location: location || undefined,
    start: { dateTime: start, timeZone: c.timezone },
    end: { dateTime: end, timeZone: c.timezone },
    ...(attendees.length ? { attendees } : {}),
    guestsCanInviteOthers: false,
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        dlyBookingCode: booking.code,
        dlyBookingId: String(booking.id),
        ...(driveUrl ? { dlyDriveFolder: driveUrl } : {})
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Sync                                                               */
/* ------------------------------------------------------------------ */
function loadBooking(id) {
  const booking = db.prepare(`SELECT b.*, c.name AS city_name, p.name AS package_name, k.name AS category_name,
                            t.name AS team_member_name, t.email AS team_member_email
                     FROM bookings b
                     JOIN cities c ON c.id = b.city_id
                     JOIN packages p ON p.id = b.package_id
                     LEFT JOIN package_categories k ON k.id = b.category_id
                     LEFT JOIN team_members t ON t.id = b.team_member_id
                     WHERE b.id = ?`).get(id);
  if (booking) {
    // Tahap 7: a booking can carry SEVERAL crew members (booking_team). The legacy single
    // member stays available for old code paths.
    booking.teamList = team.membersFor(booking.id);
    if (!booking.teamList.length && booking.team_member_id) {
      booking.teamList = [{
        member_id: booking.team_member_id,
        name: booking.team_name_snapshot || '',
        email: booking.team_email_snapshot || ''
      }];
    }
    booking.teamNames = booking.teamList.map((m) => m.name).filter(Boolean).join(', ');
  }
  return booking;
}

function setSyncState(id, { eventId, status, error, url, attendees }) {
  db.prepare(`UPDATE bookings SET
      gcal_event_id = COALESCE(?, gcal_event_id),
      gcal_event_url = COALESCE(?, gcal_event_url),
      gcal_attendees = COALESCE(?, gcal_attendees),
      gcal_status = ?,
      gcal_error = ?,
      gcal_synced_at = datetime('now')
    WHERE id = ?`).run(
    eventId === undefined ? null : eventId,
    url === undefined ? null : url,
    attendees === undefined ? null : attendees,
    status || '', error || '', id
  );
}

/**
 * Bring one booking's calendar event in line with its status.
 * Confirmed/completed also make sure a Drive folder exists so the link is always in the description.
 * Never throws: saving the booking must succeed even if Google is down.
 */
async function syncBooking(bookingId, { skipDrive = false } = {}) {
  const c = config();
  let booking = loadBooking(bookingId);
  if (!booking) return { ok: false, skipped: true, reason: 'not-found' };

  const shouldExist = booking.status === 'confirmed' || booking.status === 'completed';
  const msg = {
    disabled: 'Integrasi Google Calendar sedang dimatikan (centang "Aktifkan" di halaman Google Calendar).',
    'not-connected': 'Google Calendar belum terhubung. Hubungkan dulu di halaman Google Calendar.'
  };

  if (!c.enabled) {
    if (shouldExist) setSyncState(booking.id, { status: 'error', error: msg.disabled });
    return { ok: false, skipped: true, reason: 'disabled', message: msg.disabled };
  }

  if (!isConnected(c)) {
    if (shouldExist) setSyncState(booking.id, { status: 'error', error: msg['not-connected'] });
    return { ok: false, skipped: true, reason: 'not-connected', message: msg['not-connected'] };
  }

  // Create the Drive folder first so its link lands in the description on the very first save.
  let driveResult = { ok: true, skipped: true };
  if (shouldExist && c.driveEnabled && !skipDrive) {
    driveResult = await ensureDriveFolder(booking.id);
    if (driveResult.ok && driveResult.url) {
      booking = loadBooking(bookingId); // pick up drive_folder_url
    }
  }

  const cal = encodeURIComponent(c.calendarId);

  try {
    if (shouldExist) {
      const payload = buildEvent(booking);
      if (booking.gcal_event_id) {
        try {
          const patched = await api(`/calendars/${cal}/events/${encodeURIComponent(booking.gcal_event_id)}?sendUpdates=all`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
          });
          const patchedData = (patched && patched.data) || {};
          const attendeeList = (patchedData.attendees || payload.attendees || [])
            .map((a) => a.email).filter(Boolean).join(', ');
          setSyncState(booking.id, {
            status: 'synced',
            error: driveResult.ok === false ? 'Drive: ' + driveResult.error : '',
            url: patchedData.htmlLink || undefined,
            attendees: attendeeList
          });
          return {
            ok: true,
            action: 'updated',
            eventId: booking.gcal_event_id,
            eventUrl: patchedData.htmlLink || '',
            attendees: attendeeList,
            drive: driveResult
          };
        } catch (err) {
          if (err.status !== 404 && err.status !== 410) throw err;
        }
      }
      const res = await api(`/calendars/${cal}/events?sendUpdates=all`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const eventId = res.data && res.data.id;
      const attendeeList = ((res.data && res.data.attendees) || payload.attendees || [])
        .map((a) => a.email).filter(Boolean).join(', ');
      setSyncState(booking.id, {
        eventId,
        status: 'synced',
        error: driveResult.ok === false ? 'Drive: ' + driveResult.error : '',
        url: (res.data && res.data.htmlLink) || undefined,
        attendees: attendeeList
      });
      return {
        ok: true,
        action: 'created',
        eventId,
        eventUrl: (res.data && res.data.htmlLink) || '',
        attendees: attendeeList,
        drive: driveResult
      };
    }

    if (booking.gcal_event_id) {
      try {
        await api(`/calendars/${cal}/events/${encodeURIComponent(booking.gcal_event_id)}?sendUpdates=all`, { method: 'DELETE' });
      } catch (err) {
        if (err.status !== 404 && err.status !== 410) throw err;
      }
      setSyncState(booking.id, { eventId: '', status: 'removed', error: '' });
      return { ok: true, action: 'removed' };
    }
    setSyncState(booking.id, { status: 'removed', error: '' });
    return { ok: true, action: 'noop' };
  } catch (err) {
    const message = String(err.friendly || err.message || err).slice(0, 400);
    setSyncState(booking.id, { status: 'error', error: message });
    if (!err.apiDisabled) saveSettings({ gcal_last_error: message });
    return { ok: false, error: message, scopeMissing: Boolean(err.scopeMissing), drive: driveResult };
  }
}

/**
 * Send the calendar invitation again to the CURRENT crew (Tahap 7).
 *
 * Only a PATCH of the existing event is issued — a new event is never created here.
 * `sendUpdates=all` makes Google notify every guest about the update; removed members were
 * already dropped from `attendees` by the team-change sync.
 */
async function resendInvites(bookingId) {
  const c = config();
  const booking = loadBooking(bookingId);
  if (!booking) return { ok: false, message: 'Booking tidak ditemukan.' };
  if (!c.enabled || !isConnected(c)) {
    return { ok: false, message: 'Google Calendar belum terhubung. Hubungkan dulu di halaman Google Calendar.' };
  }
  if (!booking.gcal_event_id) {
    return { ok: false, message: 'Event kalender belum ada. Jalankan "Sinkronisasi Ulang Google Calendar" terlebih dahulu.' };
  }
  const attendees = team.attendeesFor(booking.id);
  if (!attendees.length) {
    return { ok: false, message: 'Tidak ada anggota tim dengan email valid, jadi tidak ada undangan yang bisa dikirim.' };
  }

  const cal = encodeURIComponent(c.calendarId);
  try {
    const res = await api(`/calendars/${cal}/events/${encodeURIComponent(booking.gcal_event_id)}?sendUpdates=all`, {
      method: 'PATCH',
      body: JSON.stringify({ attendees })
    });
    const emails = attendees.map((a) => a.email);
    setSyncState(booking.id, {
      status: 'synced',
      error: '',
      attendees: emails.join(', '),
      url: (res && res.data && res.data.htmlLink) || undefined
    });
    return { ok: true, emails, eventId: booking.gcal_event_id };
  } catch (err) {
    const message = String(err.friendly || err.message || err).slice(0, 400);
    setSyncState(booking.id, { status: 'error', error: message });
    return { ok: false, error: message };
  }
}

async function syncAll() {
  const rows = db.prepare("SELECT id FROM bookings WHERE status IN ('confirmed','completed') ORDER BY id").all();
  const results = [];
  for (const row of rows) {
    results.push({ id: row.id, ...(await syncBooking(row.id)) });
  }
  return results;
}

module.exports = {
  config,
  hasCredentials,
  hasCredentialsFor,
  clientFor,
  driveConnection,
  isConnected,
  isDriveConnected,
  driveUsesOwnAccount,
  isActive,
  resetTokenCache,
  redirectUri,
  createState,
  consumeState,
  buildAuthUrl,
  exchangeCode,
  selfCheck,
  buildEvent,
  ensureDriveFolder,
  ensureSubfolders,
  driveFolderInfo,
  DRIVE_SUBFOLDERS,
  fetchDriveAccount,
  fetchCalendarAccount,
  oauthHint,
  verifyClientPair,
  monthFolderName,
  clientFolderName,
  syncBooking,
  syncAll,
  resendInvites,
  loadBooking,
  SCOPE,
  SCOPE_DRIVE
};

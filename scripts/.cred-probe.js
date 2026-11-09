'use strict';
// TEMPORARY — read-only credential probe. Prints only classifications, never secrets.
// A token POST with a bogus code tells us whether Google accepts the client id+secret
// PAIR: valid pair → invalid_grant / redirect_uri_mismatch; wrong pair → invalid_client.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const COPY = '/tmp/credcheck';
fs.rmSync(COPY, { recursive: true, force: true });
fs.mkdirSync(COPY, { recursive: true });
fs.readdirSync(path.join(__dirname, '..', 'data'))
  .filter((f) => f.startsWith('app.sqlite'))
  .forEach((f) => fs.copyFileSync(path.join(__dirname, '..', 'data', f), path.join(COPY, f)));

const db = new Database(path.join(COPY, 'app.sqlite'), { readonly: true });
const s = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
db.close();

const REDIRECT = 'https://dlygraduation.com/admin/google/callback';

async function classify(label, clientId, clientSecret) {
  if (!clientId || !clientSecret) return console.log(`${label}: (kosong)`);
  const looksLikeId = /apps\.googleusercontent\.com$/.test(clientSecret) || /^\d{10,}-/.test(clientSecret);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: 'bogus-probe-code',
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT
  });
  let data = {};
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    return console.log(`${label}: jaringan gagal (${err.message})`);
  }
  const err = String(data.error || '');
  const desc = String(data.error_description || '');
  const pairOk = err === 'invalid_grant' || err === 'redirect_uri_mismatch';
  console.log(
    `${label}: ${pairOk ? 'PASANGAN VALID' : 'PASANGAN DITOLAK'}`
    + ` [error=${err || '-'}]${looksLikeId ? ' ← nilai secret tampak seperti CLIENT ID!' : ''}`
    + `${desc ? ` (${desc.slice(0, 70)})` : ''}`
  );
}

async function tryRefresh(label, clientId, clientSecret, refreshToken) {
  if (!clientId || !clientSecret || !refreshToken) return console.log(`${label}: (tidak ada refresh token)`);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  let data = {};
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    return console.log(`${label}: jaringan gagal`);
  }
  if (data.access_token) return console.log(`${label}: REFRESH OK (token masih berlaku)`);
  console.log(`${label}: refresh GAGAL [${data.error}] ${String(data.error_description || '').slice(0, 70)}`);
}

const OLD_CALENDAR_SECRET = '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'; // captured before the paste error

(async () => {
  console.log('== Pasangan Client ID + Secret ==');
  await classify('calendar  (id 1031…) + secret TERSIMPAN sekarang', s.gcal_client_id, s.gcal_client_secret);
  await classify('calendar  (id 1031…) + secret LAMA (sebelum rusak)', s.gcal_client_id, OLD_CALENDAR_SECRET);
  await classify('drive     (id 6701…) + secret TERSIMPAN sekarang', s.gdrive_client_id, s.gdrive_client_secret);
  await classify('drive     (id 6701…) + secret READER (yang berhasil tadi)', s.gdrive_client_id, s.gdrive_reader_client_secret);

  console.log('\n== Refresh token Drive dengan secret yang berbeda ==');
  await tryRefresh('drive + secret TERSIMPAN', s.gdrive_client_id, s.gdrive_client_secret, s.gdrive_refresh_token);
  await tryRefresh('drive + secret READER  ', s.gdrive_client_id, s.gdrive_reader_client_secret, s.gdrive_refresh_token);
  await tryRefresh('reader                  ', s.gdrive_reader_client_id, s.gdrive_reader_client_secret, s.gdrive_reader_refresh_token);
})();

'use strict';

/**
 * v21 — "Selesaikan Order" membagikan folder UTAMA booking.
 *
 * Yang diuji:
 *  1. Link final = folder utama booking (mis. ".../Jokowi - UPI - DLY-WISUDA-JOKOWI001"),
 *     BUKAN subfolder "03. FILE EDIT".
 *  2. Link diambil dari `webViewLink` Google (bukan URL yang dirakit sendiri).
 *  3. Folder utama hilang/404 → order TIDAK ditandai selesai + pesan jelas.
 *  4. Subfolder 01/02/03 dilengkapi otomatis bila belum ada, tanpa menggagalkan order.
 *  5. Portal Client menampilkan link folder utama itu.
 *  6. Dashboard admin menyebut "seluruh folder booking" + path foldernya.
 *
 * Google TIDAK dipanggil sama sekali: token & Drive API diarahkan ke mock lokal
 * (GCAL_TOKEN_URL / GDRIVE_API_BASE), sesuai aturan "uji wajib pakai mock".
 *
 * node scripts/check-final-link.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `dly-finallink-${process.pid}`);
const APP_PORT = 3800 + (process.pid % 60);
const TOKEN_PORT = APP_PORT + 100;
const DRIVE_PORT = APP_PORT + 200;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const SID = `finallink${Date.now()}`;
const CSRF = 'csrf-finallink';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PARENT_ID = 'ParentFolderJokowi001';
const PARENT_NAME = 'Jokowi - UPI - DLY-WISUDA-JOKOWI001';
const EDIT_ID = 'SubfolderEdit003';

let pass = 0;
const fails = [];
function ck(label, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok  ', label, extra); }
  else { fails.push(label + (extra ? ` — ${extra}` : '')); console.log('  FAIL', label, extra); }
}

/* ---------------- mock Google (token + drive) ---------------- */
const state = { parentMissing: false, created: [] };

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function startMocks() {
  const token = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => json(res, 200, { access_token: 'mock-access-token', expires_in: 3600 }));
  });
  const drive = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname.replace(/^\/drive\/v3/, '');

    if (req.method === 'GET' && p === '/files') {
      return json(res, 200, { files: [] });          // pencarian nama folder → kosong
    }
    if (req.method === 'POST' && p === '/files') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let name = 'Folder Baru';
        try { name = JSON.parse(body).name || name; } catch (err) { /* ignore */ }
        const id = `NewSub${state.created.length + 1}`;
        state.created.push(name);
        json(res, 200, { id, name, webViewLink: `https://drive.google.com/drive/folders/${id}` });
      });
      return undefined;
    }
    const m = /^\/files\/([^/]+)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (id === PARENT_ID && state.parentMissing) {
        return json(res, 404, { error: { code: 404, message: 'File not found' } });
      }
      if (id === PARENT_ID) {
        return json(res, 200, {
          id,
          name: PARENT_NAME,
          mimeType: 'application/vnd.google-apps.folder',
          webViewLink: `https://drive.google.com/drive/folders/${id}`,
          trashed: false
        });
      }
      return json(res, 200, {
        id,
        name: 'Subfolder',
        mimeType: 'application/vnd.google-apps.folder',
        webViewLink: `https://drive.google.com/drive/folders/${id}`,
        trashed: false
      });
    }
    return json(res, 404, { error: { code: 404, message: `Unhandled ${p}` } });
  });
  return { token, drive };
}

/* ---------------- fixture ---------------- */
function prepare() {
  fs.mkdirSync(TMP, { recursive: true });
  ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'].forEach((f) => {
    const src = path.join(ROOT, 'data', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, f));
  });
  const db = new Database(path.join(TMP, 'app.sqlite'));
  const admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get();
  db.prepare(`INSERT OR REPLACE INTO sessions (id, admin_id, csrf, expires_at)
              VALUES (?, ?, ?, datetime('now', '+1 day'))`).run(SID, admin.id, CSRF);

  // Drive "terhubung" lewat mock (client id/secret + refresh token).
  const setS = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  setS.run('gcal_client_id', 'mock-client');
  setS.run('gcal_client_secret', 'mock-secret');
  setS.run('gdrive_refresh_token', 'mock-refresh');
  setS.run('gcal_drive_enabled', '1');

  const booking = db.prepare("SELECT * FROM bookings ORDER BY id LIMIT 1").get();
  db.prepare(`UPDATE bookings SET drive_folder_id = ?, drive_folder_path = ?,
              drive_folder_url = ?, drive_raw_id = 'raw01', drive_sortir_id = 'sortir02',
              drive_edit_id = ?, final_url = '', final_at = NULL WHERE id = ?`)
    .run(PARENT_ID, `November 2026 / ${PARENT_NAME}`,
      `https://drive.google.com/drive/folders/${PARENT_ID}`, EDIT_ID, booking.id);
  db.prepare("DELETE FROM booking_timeline WHERE booking_id = ? AND stage = 'final_ready'").run(booking.id);
  db.close();
  return booking;
}

async function waitUp(url) {
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (err) { /* retry */ }
    await sleep(300);
  }
  return false;
}

async function run() {
  const booking = prepare();
  const { token, drive } = startMocks();
  await new Promise((r) => token.listen(TOKEN_PORT, r));
  await new Promise((r) => drive.listen(DRIVE_PORT, r));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DLY_DATA_DIR: TMP,
      GCAL_TOKEN_URL: `http://127.0.0.1:${TOKEN_PORT}/token`,
      GDRIVE_API_BASE: `http://127.0.0.1:${DRIVE_PORT}/drive/v3`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (b) => logs.push(String(b)));
  child.stderr.on('data', (b) => logs.push(String(b)));
  if (!(await waitUp(BASE + '/'))) {
    console.error('server tidak siap\n' + logs.join(''));
    child.kill('SIGKILL'); token.close(); drive.close();
    process.exit(1);
  }

  const db = () => new Database(path.join(TMP, 'app.sqlite'));
  const post = (url, form) => fetch(BASE + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: `dly_sid=${SID}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  });

  /* ---- 1. dashboard menyebut seluruh folder ---- */
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addCookies([{ name: 'dly_sid', value: SID, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/bookings/${booking.id}?tab=workflow`, { waitUntil: 'networkidle' });
  const card = await page.evaluate(() => {
    const el = document.querySelector('.cp-admin-final');
    if (!el) return null;
    return {
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      hasUrlInput: Boolean(el.querySelector('input[type="text"], input[inputmode="url"]'))
    };
  });
  ck('Foto Final: seluruh folder booking disebut di UI',
    Boolean(card) && /seluruh folder booking/i.test(card.text), card && card.text.slice(0, 120));
  ck('Foto Final: path folder booking tampil',
    Boolean(card) && /November 2026/i.test(card.text) && /Jokowi - UPI/i.test(card.text));
  ck('Foto Final: subfolder 01–03 disebut sebagai isi folder',
    Boolean(card) && /01\. FILE MENTAH/i.test(card.text) && /03\. FILE EDIT/i.test(card.text));
  ck('Foto Final: tidak ada kolom URL lagi', Boolean(card) && !card.hasUrlInput);

  /* ---- 2. Selesaikan Order → final_url = folder utama ---- */
  let res = await post(`/admin/bookings/${booking.id}/complete-order`, { _csrf: CSRF });
  ck('Selesaikan Order menerima aksi', res.status === 302, String(res.status));

  let d = db();
  let row = d.prepare('SELECT final_url, final_at, drive_edit_id, drive_folder_id FROM bookings WHERE id = ?').get(booking.id);
  const tl = d.prepare("SELECT stage FROM booking_timeline WHERE booking_id = ? AND stage = 'final_ready'").get(booking.id);
  d.close();

  ck('Link final = folder UTAMA booking (bukan subfolder 03)',
    row.final_url === `https://drive.google.com/drive/folders/${PARENT_ID}`, row.final_url);
  ck('Link final TIDAK menunjuk subfolder "03. FILE EDIT"', !String(row.final_url).includes(EDIT_ID), row.final_url);
  ck('Order ditandai selesai + tahap 08 tercatat', Boolean(row.final_at && tl), String(row.final_at));
  ck('ID folder/subfolder booking tidak diubah oleh penyelesaian order',
    row.drive_folder_id === PARENT_ID && row.drive_edit_id === EDIT_ID,
    `${row.drive_folder_id}/${row.drive_edit_id}`);

  /* ---- 3. Portal Client memakai link yang sama ---- */
  d = db();
  const code = d.prepare('SELECT code FROM bookings WHERE id = ?').get(booking.id).code;
  const pin = d.prepare('SELECT portal_pin FROM bookings WHERE id = ?').get(booking.id).portal_pin;
  d.close();
  const login = await fetch(`${BASE}/portal/masuk`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, pin: String(pin) }).toString()
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const drivePage = await (await fetch(`${BASE}/portal/drive`, { headers: { cookie } })).text();
  ck('Portal Client: tombol Google Drive memakai folder utama',
    drivePage.includes(`https://drive.google.com/drive/folders/${PARENT_ID}`));
  ck('Portal Client: menjelaskan isi folder 01 → 03',
    /01\. FILE MENTAH/i.test(drivePage) && /03\. FILE EDIT/i.test(drivePage));

  /* ---- 4. folder utama hilang → order ditolak ---- */
  d = db();
  d.prepare("UPDATE bookings SET final_url = '', final_at = NULL WHERE id = ?").run(booking.id);
  d.prepare("DELETE FROM booking_timeline WHERE booking_id = ? AND stage = 'final_ready'").run(booking.id);
  d.close();
  state.parentMissing = true;
  res = await post(`/admin/bookings/${booking.id}/complete-order`, { _csrf: CSRF });
  const loc = decodeURIComponent(res.headers.get('location') || '').replace(/\+/g, ' ');
  d = db();
  row = d.prepare('SELECT final_url, final_at FROM bookings WHERE id = ?').get(booking.id);
  d.close();
  ck('Folder utama tidak ditemukan → order TIDAK ditandai selesai', !row.final_url && !row.final_at);
  ck('Pesan error menyebut folder booking & langkah perbaikan',
    /folder booking/i.test(loc) && /coba lagi/i.test(loc), loc.slice(0, 180));
  state.parentMissing = false;

  /* ---- 5. subfolder belum lengkap → dilengkapi, order tetap selesai ---- */
  d = db();
  d.prepare("UPDATE bookings SET drive_raw_id = NULL, drive_sortir_id = NULL, drive_edit_id = NULL WHERE id = ?").run(booking.id);
  d.close();
  state.created.length = 0;
  res = await post(`/admin/bookings/${booking.id}/complete-order`, { _csrf: CSRF });
  d = db();
  row = d.prepare(`SELECT final_url, drive_raw_id, drive_sortir_id, drive_edit_id FROM bookings WHERE id = ?`).get(booking.id);
  d.close();
  ck('Subfolder 01/02/03 dibuat otomatis saat menyelesaikan order',
    Boolean(row.drive_raw_id && row.drive_sortir_id && row.drive_edit_id),
    `${row.drive_raw_id}/${row.drive_sortir_id}/${row.drive_edit_id}`);
  ck('Link final tetap folder utama walau subfolder baru dibuat',
    row.final_url === `https://drive.google.com/drive/folders/${PARENT_ID}`, row.final_url);
  ck('Tiga subfolder yang dibuat: 01. FILE MENTAH, 02. FILE SORTIR, 03. FILE EDIT',
    state.created.length === 3 && state.created.includes('01. FILE MENTAH')
      && state.created.includes('03. FILE EDIT'), state.created.join(' | '));

  /* ---- 6. idempoten ---- */
  const before = db();
  const tlBefore = before.prepare("SELECT COUNT(*) AS n FROM booking_timeline WHERE booking_id = ? AND stage = 'final_ready'").get(booking.id).n;
  before.close();
  await post(`/admin/bookings/${booking.id}/complete-order`, { _csrf: CSRF });
  const after = db();
  const tlAfter = after.prepare("SELECT COUNT(*) AS n FROM booking_timeline WHERE booking_id = ? AND stage = 'final_ready'").get(booking.id).n;
  after.close();
  ck('Klik berulang tidak menggandakan tahap 08', tlBefore === tlAfter && tlAfter === 1, `${tlBefore} → ${tlAfter}`);

  await page.close();
  await ctx.close();
  await browser.close();
  child.kill('SIGKILL');
  token.close();
  drive.close();

  console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
  if (fails.length) { fails.forEach((f) => console.log(' - ' + f)); process.exit(1); }
}

run().catch((err) => { console.error(err); process.exit(1); });

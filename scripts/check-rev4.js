'use strict';

/**
 * V20 — verifikasi revisi v14 + v15.
 *
 * v14
 *  - Detail booking admin: 3 tab (Detail Booking · Pembayaran · Workflow),
 *    URL lama ?tab=klien / ?tab=pekerjaan tetap menampilkan "Detail Booking".
 *  - Panel "Status & catatan internal" hilang; status booking tetap bisa diubah
 *    (form ringkas di Workflow) dan catatan internal lama tidak terhapus.
 *  - Foto Final: TIDAK ada kolom URL Google Drive; Selesaikan Order memakai folder
 *    folder UTAMA booking (berisi 01. FILE MENTAH s/d 03. FILE EDIT).
 *  - Portal Pilih Foto: penanda admin ringkas (bukan banner teknis), tombol
 *    "Lihat Foto Mentah Lengkap Kamu di Sini" menuju folder mentah booking.
 *  - Deadline: pilih/submit ditolak di BACKEND setelah deadline, submission sah
 *    sebelum deadline tetap terkunci.
 *
 * v15
 *  - Admin bisa membuka kembali portal setelah deadline (deadline baru + alasan),
 *    tercatat di `selection_access_log` + riwayat booking.
 *  - Validasi: tanggal lampau / alasan kosong ditolak, deadline tidak berubah.
 *  - Portal Client TIDAK memuat tombol/jalur reopen.
 *  - PIN portal bisa DITAMPILKAN di dashboard (permintaan pemilik) dan login tetap jalan.
 *
 * node scripts/check-rev4.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `dly-rev4-${process.pid}`);
const PORT = 3600 + (process.pid % 60);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
function ck(label, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok  ', label, extra); }
  else { fails.push(label + (extra ? ` — ${extra}` : '')); console.log('  FAIL', label, extra); }
}

const SID = `rev4${Date.now()}`;
const CSRF = 'rev4csrf';

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

  // Fixture: booking + portal seleksi dengan deadline LEWAT, folder mentah/edit terisi.
  const booking = db.prepare("SELECT * FROM bookings WHERE status <> 'cancelled' ORDER BY id LIMIT 1").get();
  if (!booking) throw new Error('butuh minimal satu booking di DB');
  const past = '2026-01-05';
  const future = '2027-12-31';
  db.prepare(`UPDATE bookings SET drive_raw_id = 'rawfolderTEST', drive_edit_id = 'editfolderTEST',
              drive_folder_id = 'parentTEST', drive_folder_url = 'https://drive.google.com/drive/folders/parentTEST'
              WHERE id = ?`).run(booking.id);

  let portal = db.prepare('SELECT * FROM photo_selections WHERE booking_id = ?').get(booking.id);
  if (!portal) {
    db.prepare(`INSERT INTO photo_selections (booking_id, token, quota, instructions, deadline, is_open)
                VALUES (?, ?, 10, '', ?, 1)`).run(booking.id, 'rev4token' + Date.now(), past);
    portal = db.prepare('SELECT * FROM photo_selections WHERE booking_id = ?').get(booking.id);
  }
  db.prepare(`UPDATE photo_selections SET deadline = ?, is_open = 1, submitted_at = NULL,
              status = 'waiting' WHERE id = ?`).run(past, portal.id);
  // Foto contoh supaya halaman portal tidak kosong.
  if (!db.prepare('SELECT COUNT(*) AS n FROM photo_selection_photos WHERE portal_id = ?').get(portal.id).n) {
    db.prepare(`INSERT INTO photo_selection_photos (portal_id, code, image, file_name, source, sort_order, is_available)
                VALUES (?, '001', '/ph/portfolio-couple.svg', 'DLY0001.jpg', 'upload', 0, 1)`).run(portal.id);
  }
  // `selection_access_log` baru dibuat saat server boot (migrasi idempoten), jadi
  // pembersihannya dilakukan setelah server siap — lihat pemanggilan di run().
  try { db.prepare('DELETE FROM selection_access_log WHERE portal_id = ?').run(portal.id); } catch (err) { /* belum ada */ }
  db.prepare("DELETE FROM photo_selection_picks WHERE portal_id = ?").run(portal.id);
  db.prepare('UPDATE photo_selections SET submitted_at = NULL, status = ? WHERE id = ?')
    .run('waiting', portal.id);

  const booking2 = db.prepare('SELECT * FROM bookings WHERE id <> ? ORDER BY id LIMIT 1').get(booking.id) || booking;
  db.close();
  return { booking, portal, portalToken: portal.token, future, past, booking2 };
}

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return true; } catch (err) { /* retry */ }
    await sleep(400);
  }
  return false;
}

async function run() {
  const fx = prepare();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: TMP },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (b) => logs.push(String(b)));
  child.stderr.on('data', (b) => logs.push(String(b)));
  if (!(await waitUp())) {
    console.error('server tidak siap\n' + logs.join(''));
    child.kill('SIGKILL');
    process.exit(1);
  }

  const db = () => new Database(path.join(TMP, 'app.sqlite'));
  { const d = db(); d.prepare('DELETE FROM selection_access_log WHERE portal_id = ?').run(fx.portal.id); d.close(); }
  const adminReq = async (url, { method = 'GET', form } = {}) => {
    const body = form ? new URLSearchParams(form).toString() : undefined;
    return fetch(BASE + url, {
      method,
      redirect: 'manual',
      headers: {
        cookie: `dly_sid=${SID}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
      },
      body
    });
  };

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'dly_sid', value: SID, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();

  /* ============================ v14.1–.2 tab & panel ============================ */
  const detailUrl = `${BASE}/admin/bookings/${fx.booking.id}`;
  await page.goto(detailUrl, { waitUntil: 'networkidle' });
  const tabs = await page.$$eval('.bd-tabs .bd-tab', (els) => els.map((e) => e.textContent.trim()));
  ck('Tab admin tepat 3: Detail Booking · Pembayaran · Workflow',
    tabs.length === 3 && tabs[0] === 'Detail Booking' && tabs[1] === 'Pembayaran' && tabs[2] === 'Workflow',
    tabs.join(' | '));
  const tabsSameRow = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.bd-tabs .bd-tab'));
    return new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size === 1;
  });
  ck('Workflow sejajar dengan Detail Booking (satu baris tab)', tabsSameRow);

  const identity = await page.textContent('#detail');
  ck('Tab Detail Booking memuat identitas client',
    /Identitas Client/i.test(identity) && /Nama lengkap/i.test(identity));
  ck('Tab Detail Booking memuat detail pekerjaan (paket/durasi)',
    /Detail Pekerjaan/i.test(identity) && /Paket/i.test(identity) && /Durasi/i.test(identity));

  for (const legacy of ['klien', 'pekerjaan']) {
    await page.goto(`${detailUrl}?tab=${legacy}`, { waitUntil: 'networkidle' });
    const active = await page.textContent('.bd-tab.is-active');
    ck(`URL lama ?tab=${legacy} tetap membuka "Detail Booking"`, active.trim() === 'Detail Booking', active.trim());
  }

  await page.goto(`${detailUrl}?tab=workflow`, { waitUntil: 'networkidle' });
  const bodyText = await page.textContent('body');
  ck('Panel "Status & catatan internal" sudah TIDAK ada',
    !/Status & catatan internal/i.test(bodyText));
  ck('Status booking tetap bisa diubah (form ringkas di Workflow)',
    (await page.locator('#workflow #status-' + fx.booking.id).count()) === 1);
  ck('Riwayat aktivitas tetap tampil', /Riwayat aktivitas/i.test(await page.textContent('body')));

  /* ============================ v14.3 Foto Final tanpa URL ============================ */
  const finalForm = await page.evaluate(() => {
    const card = document.querySelector('.cp-admin-final');
    if (!card) return null;
    const form = card.querySelector('form');
    return {
      hasTextInput: Boolean(card.querySelector('input[type="text"], input[inputmode="url"]')),
      button: form ? form.querySelector('button[type="submit"]').textContent.trim() : '',
      mentionsWholeFolder: /seluruh folder booking/i.test(card.textContent),
      mentionsAllSubfolders: /01\. FILE MENTAH/i.test(card.textContent) && /03\. FILE EDIT/i.test(card.textContent)
    };
  });
  ck('Foto Final tidak lagi meminta URL Google Drive', finalForm && !finalForm.hasTextInput, JSON.stringify(finalForm));
  ck('Tombol "Selesaikan Order" menyebut SELURUH folder booking (01 → 03)',
    finalForm && /Selesaikan Order/i.test(finalForm.button)
      && finalForm.mentionsWholeFolder && finalForm.mentionsAllSubfolders,
    JSON.stringify(finalForm));

  // Tanpa folder booking → order TIDAK boleh selesai + pesan jelas.
  {
    const d = db();
    d.prepare(`UPDATE bookings SET drive_folder_id = NULL, drive_folder_url = NULL,
               drive_edit_id = NULL, final_url = '', final_at = NULL WHERE id = ?`).run(fx.booking.id);
    d.close();
    const res = await adminReq(`/admin/bookings/${fx.booking.id}/complete-order`, { method: 'POST', form: { _csrf: CSRF } });
    const loc = decodeURIComponent(res.headers.get('location') || '').replace(/\+/g, ' ');
    const d2 = db();
    const after = d2.prepare('SELECT final_url, final_at FROM bookings WHERE id = ?').get(fx.booking.id);
    d2.close();
    ck('Selesaikan Order DITOLAK bila folder booking belum ada', !after.final_url && !after.final_at);
    ck('Pesan error menjelaskan cara memperbaikinya',
      /Buat folder Drive/i.test(loc) && /Selesaikan Order lagi/i.test(loc), loc.slice(0, 200));
  }

  /* ============================ v14.4–.6 portal pilih foto ============================ */
  await page.goto(`${BASE}/selection/${fx.portalToken}`, { waitUntil: 'networkidle' });
  const selPage = await page.textContent('body');
  ck('Mode admin memakai penanda ringkas (bukan banner teknis)',
    (await page.locator('.sel-adminchip').count()) === 1);
  ck('Banner lama "Mode admin — portal ini sedang…" sudah tidak ada',
    !/portal ini sedang (aktif|ditutup)/i.test(selPage));
  const rawBtn = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find((x) => /Lihat Foto Mentah Lengkap Kamu di Sini/i.test(x.textContent));
    return a ? a.getAttribute('href') : '';
  });
  ck('Tombol "Lihat Foto Mentah Lengkap Kamu di Sini" menuju folder mentah booking',
    rawBtn === 'https://drive.google.com/drive/folders/rawfolderTEST', rawBtn);
  ck('Halaman tidak membocorkan ID folder booking lain / kredensial',
    !/client_secret|refresh_token/i.test(selPage));

  // Deadline lewat → UI memberi tahu
  ck('Deadline lewat ditampilkan ke client dengan arahan menghubungi admin',
    /Batas waktu pemilihan sudah lewat|sudah lewat/i.test(selPage));

  /* ============================ v14.5 deadline di backend ============================ */
  {
    const res = await fetch(`${BASE}/selection/${fx.portalToken}/pick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ photoId: 1, action: 'toggle' })
    });
    const json = await res.json().catch(() => ({}));
    ck('Setelah deadline: pilih foto DITOLAK backend (403)', res.status === 403, `${res.status} ${json.message || ''}`);
    const res2 = await fetch(`${BASE}/selection/${fx.portalToken}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({})
    });
    ck('Setelah deadline: submit DITOLAK backend', res2.status === 409 || res2.status === 422, String(res2.status));
  }

  // Submission sah SEBELUM deadline tetap terkunci sesudah deadline.
  {
    const d = db();
    const future = '2099-12-31';
    d.prepare('UPDATE photo_selections SET deadline = ?, submitted_at = ?, status = ? WHERE id = ?')
      .run(future, '2026-11-08 01:00:00', 'submitted', fx.portal.id);
    d.close();
    const res = await fetch(`${BASE}/selection/${fx.portalToken}/pick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ photoId: 1, action: 'toggle' })
    });
    ck('Submission sah tetap terkunci (tidak bisa diubah)', res.status === 409, String(res.status));
    const d2 = db();
    d2.prepare('UPDATE photo_selections SET deadline = ?, submitted_at = NULL, status = ? WHERE id = ?')
      .run(fx.past, 'waiting', fx.portal.id);
    d2.close();
  }

  /* ============================ v15.1 buka kembali portal ============================ */
  {
    const d = db();
    d.prepare('DELETE FROM selection_access_log WHERE portal_id = ?').run(fx.portal.id);
    d.close();

    // Input tidak valid: tanggal lampau
    let res = await adminReq(`/admin/selection/${fx.portal.id}/reopen`, {
      method: 'POST', form: { _csrf: CSRF, confirm: '1', deadline: '2020-01-01', reason: 'perpanjangan klien' }
    });
    let d2 = db();
    let p = d2.prepare('SELECT deadline FROM photo_selections WHERE id = ?').get(fx.portal.id);
    let logCount = d2.prepare('SELECT COUNT(*) AS n FROM selection_access_log WHERE portal_id = ?').get(fx.portal.id).n;
    d2.close();
    ck('Reopen dengan tanggal lampau ditolak', p.deadline === fx.past && logCount === 0, `${p.deadline}/${logCount}`);

    // Input tidak valid: alasan kosong
    res = await adminReq(`/admin/selection/${fx.portal.id}/reopen`, {
      method: 'POST', form: { _csrf: CSRF, confirm: '1', deadline: fx.future, reason: '' }
    });
    d2 = db();
    p = d2.prepare('SELECT deadline FROM photo_selections WHERE id = ?').get(fx.portal.id);
    logCount = d2.prepare('SELECT COUNT(*) AS n FROM selection_access_log WHERE portal_id = ?').get(fx.portal.id).n;
    d2.close();
    ck('Reopen tanpa alasan ditolak', p.deadline === fx.past && logCount === 0, `${p.deadline}/${logCount}`);

    // Aksi sah
    res = await adminReq(`/admin/selection/${fx.portal.id}/reopen`, {
      method: 'POST',
      form: { _csrf: CSRF, confirm: '1', deadline: fx.future, reason: 'Klien minta perpanjangan (jaringan bermasalah)' }
    });
    d2 = db();
    p = d2.prepare('SELECT deadline, is_open FROM photo_selections WHERE id = ?').get(fx.portal.id);
    const log = d2.prepare('SELECT * FROM selection_access_log WHERE portal_id = ? ORDER BY id DESC LIMIT 1').get(fx.portal.id);
    const ev = d2.prepare("SELECT * FROM booking_events WHERE booking_id = ? ORDER BY id DESC LIMIT 1").get(fx.booking.id);
    d2.close();
    ck('Admin berhasil membuka kembali portal dengan deadline baru',
      p.deadline === fx.future && Number(p.is_open) === 1, JSON.stringify(p));
    ck('Audit log mencatat aksi reopen (actor, alasan, deadline lama→baru)',
      Boolean(log) && log.action === 'reopen' && /perpanjangan/i.test(log.reason)
      && log.old_deadline === fx.past && log.new_deadline === fx.future && Boolean(log.actor),
      JSON.stringify(log));
    ck('Riwayat aktivitas booking ikut mencatat perubahan',
      Boolean(ev) && /dibuka kembali/i.test(ev.note || ''), ev && ev.note);
  }

  // Setelah dibuka kembali, client bisa memilih lagi sampai deadline baru.
  {
    const res = await fetch(`${BASE}/selection/${fx.portalToken}/pick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ photoId: 1, action: 'toggle' })
    });
    ck('Client bisa memilih foto lagi setelah portal dibuka kembali', res.status === 200, String(res.status));
  }

  // Tutup manual tercatat
  {
    await adminReq(`/admin/selection/${fx.portal.id}/close`, {
      method: 'POST', form: { _csrf: CSRF, reason: 'Hasil edit sudah mulai dikerjakan' }
    });
    const d = db();
    const log = d.prepare('SELECT * FROM selection_access_log WHERE portal_id = ? ORDER BY id DESC LIMIT 1').get(fx.portal.id);
    const p = d.prepare('SELECT is_open FROM photo_selections WHERE id = ?').get(fx.portal.id);
    d.close();
    ck('Aksi tutup manual tercatat di audit log', log.action === 'close' && Number(p.is_open) === 0, `${log.action}/${p.is_open}`);
  }

  /* ============================ v15.1 tidak ada di portal client ============================ */
  {
    await page.goto(`${BASE}/selection/${fx.portalToken}`, { waitUntil: 'networkidle' });
    const text = await page.textContent('body');
    ck('Portal client tidak memuat tombol/aksi reopen', !/buka kembali portal|reopen/i.test(text));
    ck('Portal client tidak memuat form deadline admin',
      (await page.locator('input[name="reason"]').count()) === 0);
    const res = await fetch(`${BASE}/selection/${fx.portalToken}/reopen`, { method: 'POST' });
    ck('Endpoint reopen tidak bisa dipanggil dari sisi client (bukan route publik)',
      res.status === 404, String(res.status));
  }

  /* ==================== v21: PIN tampil lagi di dashboard ==================== */
  {
    const d = db();
    d.prepare('UPDATE bookings SET portal_pin = ?, portal_pin_hash = NULL WHERE id = ?').run('4321', fx.booking.id);
    const code = fx.booking.code;
    d.close();

    // Dashboard admin harus MENAMPILKAN PIN apa adanya (tanpa aksi tambahan).
    // Kotak PIN berada di tab Workflow (bagian Client Portal).
    await page.goto(`${BASE}/admin/bookings/${fx.booking.id}?tab=workflow`, { waitUntil: 'networkidle' });
    const shownPin = (await page.locator('[data-cp-pin]').first().innerText()).trim();
    ck('PIN portal ditampilkan terbaca di dashboard admin', shownPin === '4321', shownPin);

    const login = await fetch(`${BASE}/portal/masuk`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, pin: '4321' }).toString()
    });
    ck('Login portal berhasil dengan PIN yang ditampilkan', login.status === 302, String(login.status));

    const d2 = db();
    const row = d2.prepare('SELECT portal_pin, portal_pin_hash FROM bookings WHERE id = ?').get(fx.booking.id);
    d2.close();
    ck('PIN tetap tersimpan & bisa dibaca ulang (tidak dikosongkan)', row.portal_pin === '4321', String(row.portal_pin));

    const wrong = await fetch(`${BASE}/portal/masuk`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, pin: '0000' }).toString()
    });
    ck('PIN salah tetap ditolak', wrong.status >= 400 && wrong.status < 500, String(wrong.status));

    // PIN yang hanya tersisa sebagai hash (data V20) dipulihkan menjadi PIN terbaca.
    const d3 = db();
    const legacyHash = require('crypto').createHash('sha256').digest('hex');
    d3.prepare("UPDATE bookings SET portal_pin = NULL, portal_pin_hash = '' WHERE id = ?").run(fx.booking.id);
    d3.close();
    const pinRes = await adminReq(`/admin/bookings/${fx.booking.id}/portal-pin`, { method: 'POST', form: { _csrf: CSRF } });
    const loc = decodeURIComponent(pinRes.headers.get('location') || '').replace(/\+/g, ' ');
    const d4 = db();
    const restored = d4.prepare('SELECT portal_pin FROM bookings WHERE id = ?').get(fx.booking.id);
    d4.close();
    ck('Booking tanpa PIN terbaca otomatis dibuatkan PIN baru',
      /^\d{4}$/.test(String(restored.portal_pin)), String(restored.portal_pin));
    ck('PIN baru langsung dikirim di pesan/notifikasi admin', /PIN portal:\s*\d{4}/.test(loc), loc.slice(0, 140));

    // Reset PIN tetap tersedia untuk klien yang lupa.
    const resetRes = await adminReq(`/admin/bookings/${fx.booking.id}/portal-pin`, { method: 'POST', form: { _csrf: CSRF, reset: '1' } });
    const loc2 = decodeURIComponent(resetRes.headers.get('location') || '').replace(/\+/g, ' ');
    ck('Admin bisa mereset PIN (PIN baru ditampilkan)', /PIN portal:\s*\d{4}/.test(loc2), loc2.slice(0, 140));
  }

  await browser.close();
  child.kill('SIGKILL');
  console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
  if (fails.length) { fails.forEach((f) => console.log(' - ' + f)); process.exit(1); }
}

run().catch((err) => { console.error(err); process.exit(1); });

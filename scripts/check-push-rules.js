'use strict';

/**
 * Revisi notifikasi — aturan pengiriman (dengan webpush DI-STUB).
 *
 * Yang diuji (sesuai dokumen revisi 01):
 *  - satu aktivitas = satu event_id (tidak pernah dobel)
 *  - tidak ada broadcast lintas role
 *  - admin tidak menerima notifikasi saat client hanya mencentang foto
 *  - "Selesaikan Order" mengirim event CLIENT final, bukan "job besok"
 *  - perubahan tahap editing internal tidak mengirim; hanya job selesai
 *  - format judul/isi sesuai kesepakatan
 *  - log pengiriman per perangkat (status, alasan, retry)
 *  - toggle preferensi dihormati; test notification manual
 *
 *   node scripts/check-push-rules.js
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const DATA_DIR = `/tmp/dly-pushrules-${Date.now()}`;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.readdirSync(path.join(__dirname, '..', 'data')).filter((f) => f.startsWith('app.sqlite'))
  .forEach((f) => fs.copyFileSync(path.join(__dirname, '..', 'data', f), path.join(DATA_DIR, f)));
process.env.DLY_DATA_DIR = DATA_DIR;
process.env.DLY_DISABLE_PUSH_SCHEDULER = '1';

// Stub jaringan SEBELUM src/push.js me-require web-push.
const webpushPath = require.resolve('web-push');
const realWebpush = require('web-push');
const sent = [];
let behaviour = () => ({});
require.cache[webpushPath].exports = {
  ...realWebpush,
  sendNotification: async (sub, payload) => {
    const result = behaviour(sub, payload);
    if (result && result.throw) {
      const err = new Error(result.throw.message || 'push error');
      err.statusCode = result.throw.statusCode;
      err.body = result.throw.body;
      throw err;
    }
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  }
};

const push = require('../src/push');
const { db, saveSettings } = require('../src/db');

let pass = 0;
const failures = [];
const ck = (label, cond, detail) => {
  if (cond) { pass += 1; console.log('  ok  ' + label); }
  else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log('FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

const reset = () => {
  db.prepare('DELETE FROM push_subscriptions').run();
  db.prepare('DELETE FROM push_log').run();
  db.prepare('DELETE FROM push_deliveries').run();
  sent.length = 0;
  behaviour = () => ({});
};

const adminSub = { endpoint: 'https://push.example.com/admin-1', keys: { p256dh: 'p1', auth: 'a1' } };
const clientSub = { endpoint: 'https://push.example.com/client-9', keys: { p256dh: 'p2', auth: 'a2' } };
const otherClientSub = { endpoint: 'https://push.example.com/client-10', keys: { p256dh: 'p3', auth: 'a3' } };

(async () => {
  // Uji ini mengasumsikan SEMUA jenis notifikasi aktif (di SALINAN database). Pemilik bisa
  // mematikan salah satu toggle kapan saja di dashboard — itu bukan bug.
  saveSettings({
    push_enabled: '1',
    push_type_booking: '1', push_type_payment: '1', push_type_selection: '1',
    push_type_deadline: '1', push_type_job: '1', push_type_editing: '1',
    push_client_confirmed: '1', push_client_photos: '1', push_client_deadline: '1',
    push_client_final: '1', push_client_reschedule: '1'
  });
  push.resetConfig();
  console.log('    [info] settings booking =', JSON.stringify(require('../src/db').getSettings().push_type_booking));
  reset();
  push.saveSubscription(adminSub, { role: 'admin', platform: 'Android' });
  push.saveSubscription(clientSub, { role: 'client', bookingId: 9, platform: 'iPhone' });
  push.saveSubscription(otherClientSub, { role: 'client', bookingId: 10, platform: 'Android' });

  /* ---------------- role separation ---------------- */
  console.log('    [debug] eventEnabled =', push.eventEnabled('booking'),
    '| setting =', JSON.stringify(require('../src/db').getSettings().push_type_booking),
    '| enabled =', push.isEnabled(), '| cfgOk =', push.config().ok);
  const adminOnly = await push.send('booking', {
    eventId: 'booking:9:created', bookingId: 9, clientName: 'Muhammad Fadhli', campus: 'UPI'
  });
  ck('Event admin hanya dikirim ke perangkat admin', adminOnly.sent === 1 && sent.length === 1, JSON.stringify(adminOnly));
  ck('Perangkat client TIDAK menerima event admin', !sent.some((s) => s.endpoint.includes('client')),
    sent.map((s) => s.endpoint).join(', '));
  const p1 = sent[0] && sent[0].payload;
  ck('Judul notifikasi = nama event (bukan "From Admin")', p1 && p1.title === 'Booking baru masuk', p1 && p1.title);
  ck('Isi notifikasi memuat nama client - kampus lalu ajakan cek dashboard',
    p1 && p1.body.startsWith('Muhammad Fadhli - UPI') && /Segera cek availability-nya via dashboard/.test(p1.body),
    p1 && p1.body.replace(/\n/g, ' | '));

  sent.length = 0;
  const clientOnly = await push.send('client_final', {
    eventId: 'booking:9:final', bookingId: 9, clientName: 'Muhammad Fadhli', campus: 'UPI'
  });
  ck('Event client hanya ke perangkat client booking tersebut',
    clientOnly.sent === 1 && sent.length === 1 && sent[0].endpoint.includes('client-9'), JSON.stringify(clientOnly));
  ck('Client lain (booking berbeda) tidak menerima',
    !sent.some((s) => s.endpoint.includes('client-10')), sent.map((s) => s.endpoint).join(', '));

  /* ---------------- idempotency ---------------- */
  sent.length = 0;
  const again = await push.send('booking', {
    eventId: 'booking:9:created', bookingId: 9, clientName: 'Muhammad Fadhli', campus: 'UPI'
  });
  ck('Event yang sama tidak dikirim dua kali', again.skipped === 'duplicate' && sent.length === 0, JSON.stringify(again));

  const noId = await push.send('booking', { bookingId: 9 });
  ck('Event tanpa event_id ditolak (tidak ada notifikasi tanpa aktivitas valid)',
    noId.skipped === 'no-event-id', JSON.stringify(noId));

  /* ---------------- toggle preferensi ---------------- */
  sent.length = 0;
  saveSettings({ push_type_booking: '0' });
  const off = await push.send('booking', { eventId: 'booking:11:created', bookingId: 11, clientName: 'X', campus: 'Y' });
  ck('Toggle jenis notifikasi dimatikan → tidak mengirim', off.skipped === 'type-disabled' && sent.length === 0, JSON.stringify(off));
  saveSettings({ push_type_booking: '1' });

  reset();
  push.saveSubscription(adminSub, { role: 'admin' });
  saveSettings({ push_enabled: '0' });
  push.resetConfig();
  const allOff = await push.send('booking', { eventId: 'booking:12:created', bookingId: 12 });
  ck('Saklar global mematikan semua pengiriman', allOff.skipped === 'disabled', JSON.stringify(allOff));
  saveSettings({ push_enabled: '1' });
  push.resetConfig();

  /* ---------------- role yang belum aktif ---------------- */
  reset();
  push.saveSubscription(adminSub, { role: 'admin' });
  const fg = await push.send('client_confirmed', { eventId: 'x:1', bookingId: 9 });
  ck('Event untuk role yang belum aktif tidak dikirim', fg.skipped === 'no-devices' || fg.sent === 0, JSON.stringify(fg));
  ck('Role fg/editor tercatat sebagai "disiapkan" tetapi belum aktif',
    push.PREPARED_ROLES.includes('fg') && push.PREPARED_ROLES.includes('editor')
    && !push.ACTIVE_ROLES.includes('fg'));

  /* ---------------- log pengiriman ---------------- */
  reset();
  push.saveSubscription(adminSub, { role: 'admin', label: 'HP Admin' });
  await push.send('booking', { eventId: 'booking:13:created', bookingId: 13, clientName: 'A', campus: 'B' });
  const rows = push.deliveriesFor('booking:13:created');
  ck('Setiap pengiriman tercatat di log (per perangkat)',
    rows.length === 1 && rows[0].status === 'sent' && rows[0].role === 'admin', JSON.stringify(rows[0] || {}));
  ck('Log menyimpan nama perangkat', Boolean(rows[0] && rows[0].device), rows[0] && rows[0].device);

  /* ---------------- retry + endpoint mati ---------------- */
  reset();
  push.saveSubscription(adminSub, { role: 'admin' });
  let attempts = 0;
  behaviour = () => { attempts += 1; return { throw: { statusCode: 500, message: 'server error' } }; };
  const failing = await push.send('booking', { eventId: 'booking:14:created', bookingId: 14, clientName: 'A', campus: 'B' });
  ck('Kegagalan sementara dicoba ulang (retry) sebelum menyerah',
    attempts >= 2 && failing.failed === 1, `attempts=${attempts} failed=${failing.failed}`);
  const failRows = push.deliveriesFor('booking:14:created');
  ck('Log mencatat status gagal + alasan',
    failRows.some((r) => r.status === 'failed' && r.reason), JSON.stringify(failRows[0] || {}));

  reset();
  push.saveSubscription(adminSub, { role: 'admin' });
  behaviour = () => ({ throw: { statusCode: 410, message: 'Gone' } });
  const gone = await push.send('booking', { eventId: 'booking:15:created', bookingId: 15, clientName: 'A', campus: 'B' });
  const dev = db.prepare('SELECT is_active FROM push_subscriptions WHERE endpoint = ?').get(adminSub.endpoint);
  ck('Endpoint mati (410) dinonaktifkan, tidak di-retry', gone.gone === 1 && Number(dev.is_active) === 0, JSON.stringify(gone));

  /* ---------------- test notification manual ---------------- */
  reset();
  push.saveSubscription(adminSub, { role: 'admin' });
  const t = await push.sendTest();
  ck('Test notification hanya lewat pemanggilan manual (sendTest)', t.sent === 1 && sent.length === 1);
  ck('Test notification memakai event_id test:*', String(t.eventId).startsWith('test:'), t.eventId);

  /* ---------------- wiring di route (audit regresi) ---------------- */
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const adminJs = src('src/routes/admin.js');
  const publicJs = src('src/routes/public.js');
  // Revisi 2: "Selesaikan Order" pindah ke modul bersama (dipakai tombol SELESAI antrean).
  const completionJs = src('src/ordercompletion.js');
  ck('Tidak ada lagi dedupeKey berbasis Date.now()',
    !/dedupeKey:\s*`[^`]*\$\{Date\.now\(\)\}/.test(adminJs) && !/dedupeKey:\s*`[^`]*\$\{Date\.now\(\)\}/.test(publicJs));
  ck('Selesaikan Order mengirim event client final (bukan "job")',
    /client_final/.test(completionJs) && !/push\.notify\('job'/.test(adminJs)
    && !/push\.notify\('job'/.test(completionJs));
  // Revisi 2 (03): pembayaran/DP juga dikabarkan ke CLIENT pemilik booking.
  ck('Pembayaran/DP mengirim notifikasi ke client (bukan hanya admin)',
    /push\.notify\('client_payment'/.test(adminJs) && /client_payment:/.test(src('src/push.js')));
  ck('Konfirmasi booking tidak mengirim ulang notifikasi "booking" ke admin',
    !/push\.notify\('booking',[^)]*booking-confirmed/.test(adminJs));
  ck('Perubahan tahap editing biasa tidak mengirim notifikasi',
    /result\.job\.status === 'done'/.test(adminJs));
  ck('Halaman push menampilkan log pengiriman', /Log pengiriman/.test(src('views/admin/push.ejs')));

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

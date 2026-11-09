'use strict';

/**
 * Unit test for the Web Push engine (Tahap 6).
 *
 * There is no real push service in this sandbox (headless Chromium has no FCM/APNs
 * connection), so this test drives `src/push.js` directly with a STUBBED
 * `webpush.sendNotification`. That covers everything except the last hop to Google/Apple:
 * payload shape, dedupe, per-type toggles, disabled-device pruning, and the "no sensitive
 * data" rule.
 *
 *   node scripts/check-push-engine.js
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const DATA_DIR = `/tmp/dly-push-${Date.now()}`;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.readdirSync(path.join(__dirname, '..', 'data')).filter((f) => f.startsWith('app.sqlite'))
  .forEach((f) => fs.copyFileSync(path.join(__dirname, '..', 'data', f), path.join(DATA_DIR, f)));
process.env.DLY_DATA_DIR = DATA_DIR;

// Stub the network call BEFORE src/push.js is required (it captures the module object).
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
const { db, getSettings, saveSettings } = require('../src/db');

let pass = 0;
const failures = [];
const ck = (label, cond, detail) => {
  if (cond) { pass += 1; console.log('  ok  ' + label); }
  else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log('FAIL  ' + label + (detail ? ` — ${detail}` : '')); }
};

const reset = () => {
  db.prepare('DELETE FROM push_subscriptions').run();
  db.prepare('DELETE FROM push_log').run();
  sent.length = 0;
  behaviour = () => ({});
};

(async () => {
  /* ---------------- VAPID ---------------- */
  const cfg = push.config();
  ck('VAPID pair exists on first boot', Boolean(cfg.publicKey) && cfg.ok, JSON.stringify(cfg).slice(0, 80));
  ck('VAPID public key is a base64url P-256 point (87 chars)', /^[A-Za-z0-9_-]{87}$/.test(cfg.publicKey), String(cfg.publicKey.length));
  const again = push.config();
  ck('The key pair is stable (not regenerated on each call)', again.publicKey === cfg.publicKey);

  /* ---------------- subscription storage ---------------- */
  reset();
  const subA = { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p1', auth: 'a1' } };
  const subB = { endpoint: 'https://push.example.com/b', keys: { p256dh: 'p2', auth: 'a2' } };

  const first = push.saveSubscription(subA, { platform: 'Android', label: 'HP Admin' });
  ck('A device subscription is stored', first.created === true && push.deviceCount() === 1);
  const dup = push.saveSubscription(subA, { platform: 'Android' });
  ck('Re-subscribing the same endpoint does not create a second row',
    dup.created === false && push.deviceCount() === 1, String(push.deviceCount()));
  push.saveSubscription(subB, { platform: 'iPhone (Home Screen)' });
  ck('A second device is stored separately', push.deviceCount() === 2, String(push.deviceCount()));

  let bad = null;
  try { push.saveSubscription({ endpoint: 'http://insecure', keys: {} }); } catch (err) { bad = err; }
  ck('An incomplete/insecure subscription is rejected', Boolean(bad) && bad.status === 422);

  /* ---------------- sending ---------------- */
  reset();
  push.saveSubscription(subA, { platform: 'Android' });
  push.saveSubscription(subB, { platform: 'iPhone' });

  const r1 = await push.send('booking', {
    eventId: 'booking:9:created', bookingId: 9, clientName: 'Muhammad Fadhli', campus: 'UPI'
  });
  ck('A booking push is delivered to every active device', r1.sent === 2 && r1.failed === 0, JSON.stringify(r1));
  ck('The payload carries a title, a body, a tag and an admin URL',
    sent[0] && sent[0].payload.title && sent[0].payload.body && sent[0].payload.tag
    && sent[0].payload.url === '/admin/bookings/9' && Boolean(sent[0].payload.eventId),
    JSON.stringify(sent[0] && sent[0].payload));

  // Revisi pemilik: nama client + kampus MEMANG ditampilkan (format yang disepakati),
  // tetapi nomor HP / nominal pembayaran tetap tidak boleh ikut.
  const payloadText = JSON.stringify(sent.map((s) => s.payload));
  ck('No phone number or payment amount leaks into the notification',
    !/\d{10,}|Rp\s?\d/.test(payloadText), payloadText.slice(0, 160));
  ck('Client name + campus appear in the agreed format',
    /Muhammad Fadhli/.test(payloadText) && /UPI/.test(payloadText), payloadText.slice(0, 120));

  const r2 = await push.send('booking', { eventId: 'booking:9:created', bookingId: 9, clientName: 'Muhammad Fadhli', campus: 'UPI' });
  ck('The same event is never pushed twice (dedupe key)', r2.skipped === 'duplicate', JSON.stringify(r2));
  ck('…and no further request is made', sent.length === 2, String(sent.length));

  const r3 = await push.send('booking', { eventId: 'booking:10:created', bookingId: 10, clientName: 'Muhammad Fadhli', campus: 'UPI' });
  ck('A different event still goes out', r3.sent === 2, JSON.stringify(r3));

  /* ---------------- per-type toggles ---------------- */
  reset();
  push.saveSubscription(subA, {});
  saveSettings({ push_type_payment: '0' });
  const off = await push.send('payment', { eventId: 'payment:1' });
  ck('A disabled notification type is not sent', off.skipped === 'type-disabled' && sent.length === 0, JSON.stringify(off));
  saveSettings({ push_type_payment: '1' });
  const on = await push.send('payment', { eventId: 'payment:1' });
  ck('Re-enabling the type sends it again', on.sent === 1, JSON.stringify(on));

  saveSettings({ push_enabled: '0' });
  push.resetConfig();
  const allOff = await push.send('booking', { eventId: 'booking:11:created' });
  ck('The global switch stops everything', allOff.skipped === 'disabled', JSON.stringify(allOff));
  saveSettings({ push_enabled: '1' });
  push.resetConfig();

  /* ---------------- dead endpoints are pruned ---------------- */
  reset();
  push.saveSubscription(subA, { platform: 'Android' });
  push.saveSubscription(subB, { platform: 'iPhone' });
  behaviour = (sub) => (sub.endpoint.endsWith('/a')
    ? { throw: { statusCode: 410, message: 'Gone' } }
    : {});
  const pruned = await push.send('job', { eventId: 'job:2026-01-01:1' });
  ck('A 410 endpoint is counted as gone', pruned.gone === 1 && pruned.sent === 1, JSON.stringify(pruned));
  const rows = push.devices();
  const dead = rows.find((r) => r.endpoint.endsWith('/a'));
  ck('A dead endpoint is deactivated automatically', dead && Number(dead.is_active) === 0, JSON.stringify(dead && dead.is_active));
  ck('…and the reason is recorded', /tidak berlaku/i.test(dead.last_error || ''), dead.last_error);
  ck('The healthy device is still active', rows.find((r) => r.endpoint.endsWith('/b')).is_active === 1);
  ck('Only active devices are counted', push.deviceCount() === 1, String(push.deviceCount()));

  behaviour = () => ({ throw: { statusCode: 500, message: 'server error' } });
  const failing = await push.send('job', { eventId: 'job:2026-01-02:1' });
  ck('A transient failure is reported, not silently swallowed', failing.failed === 1, JSON.stringify(failing));
  const stillActive = push.devices().find((r) => r.endpoint.endsWith('/b'));
  ck('A transient failure does NOT deactivate the device', Number(stillActive.is_active) === 1);

  /* ---------------- device management ---------------- */
  reset();
  const idOne = push.saveSubscription(subA, {}).id;
  ck('A device can be switched off', push.setDeviceActive(idOne, false) === 1 && push.deviceCount() === 0);
  ck('A device can be switched back on', push.setDeviceActive(idOne, true) === 1 && push.deviceCount() === 1);
  ck('A device can be removed', push.removeDevice(idOne) === 1 && push.devices().length === 0);
  push.saveSubscription(subA, {});
  ck('Unsubscribe-by-endpoint removes the row', push.removeByEndpoint(subA.endpoint) === 1 && push.devices().length === 0);

  /* ---------------- no devices ---------------- */
  reset();
  const none = await push.send('booking', { eventId: 'booking:12:created' });
  ck('With no device the send is a clean no-op', none.ok === true && none.skipped === 'no-devices', JSON.stringify(none));

  /* ---------------- scheduled events ---------------- */
  reset();
  push.saveSubscription(subA, { platform: 'Android' });
  const run1 = await push.runScheduled();
  const run2 = await push.runScheduled();
  const jobRows = db.prepare("SELECT COUNT(*) AS n FROM push_log WHERE kind = 'job'").get().n;
  ck('The hourly scheduler never sends the same day twice',
    jobRows <= 1, `job log rows=${jobRows}`);
  ck('runScheduled returns a result object', run1 && typeof run1 === 'object' && run2 && typeof run2 === 'object');
  ck('The scheduler records when it last ran', Boolean(getSettings().push_last_run_at));

  /* ---------------- server-side wiring exists ---------------- */
  const src = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  ck('Booking creation triggers a push', /push\.notify\('booking'/.test(src('src/routes/public.js')));
  ck('Payment recording triggers a push', /push\.notify\('payment'/.test(src('src/routes/admin.js')));
  ck('Client selection submit triggers a push', /push\.notify\('selection'/.test(src('src/routes/public.js')));
  ck('Editing stage change can trigger a push', /push\.notify\('editing'/.test(src('src/routes/admin.js')));
  ck('Deadline + tomorrow shoot run on a schedule', /startScheduler/.test(src('src/app.js')));

  const sw = src('public/sw.js');
  ck('The existing service worker handles push (no second worker)', /addEventListener\('push'/.test(sw));
  ck('The existing service worker handles notification clicks', /addEventListener\('notificationclick'/.test(sw));
  ck('A click opens an admin URL', /data\.url/.test(sw) && /admin/.test(sw));
  ck('A click URL is re-prefixed with the app scope (works on the published subpath)',
    /raw\.startsWith\('\/'\) \? SCOPE \+ raw\.slice\(1\)/.test(sw));
  ck('Click URLs resolve against the registration scope, not the origin',
    /new URL\(target, self\.registration\.scope\)/.test(sw));
  ck('Admin and the client portal stay out of the cache', /isPrivate/.test(sw) && /selection\//.test(sw));

  const page = src('views/admin/push.ejs');
  ck('The settings page explains the iPhone Home Screen requirement', /Layar Utama/.test(page));
  ck('The settings page has an activate button', /data-push-enable/.test(page));
  ck('The settings page lists devices with delete/toggle controls',
    /push\/devices\/<%= d\.id %>\/delete/.test(page) && /push\/devices\/<%= d\.id %>\/toggle/.test(page));
  ck('The settings page offers a test notification', /push\/test/.test(page));

  const script = src('public/assets/push-admin.js');
  ck('Permission is requested on click, not on load',
    !/^\s*Notification\.requestPermission\(\)/m.test(script.split('btn.addEventListener')[0]));
  ck('The client registers the EXISTING service worker', /sw\.js/.test(script));

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os'); const fs = require('fs');
const Database = require('better-sqlite3');
const DATA = path.join(os.tmpdir(), 'dly-csp');
fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });
fs.readdirSync(path.join(__dirname, 'data')).filter((f) => f.startsWith('app.sqlite')).forEach((f) => fs.copyFileSync(path.join(__dirname, 'data', f), path.join(DATA, f)));
try { fs.cpSync(path.join(__dirname, 'data', 'preview-cache'), path.join(DATA, 'preview-cache'), { recursive: true }); } catch (e) {}
const db = new Database(path.join(DATA, 'app.sqlite'));
const row = db.prepare(`SELECT code, portal_pin FROM bookings WHERE status='confirmed' AND portal_pin IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
db.close();
const PORT = 4491; const BASE = `http://127.0.0.1:${PORT}`;
const app = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) {} await sleep(250); }
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
  const violations = [];
  p.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) violations.push(t.slice(0, 200)); });
  p.on('pageerror', (e) => violations.push('JS ' + String(e).slice(0, 160)));
  const pages = ['/', '/gallery', '/pricelist', '/booking', '/cara-order', '/ulasan', '/faq', '/tentang', '/portal'];
  for (const u of pages) { await p.goto(BASE + u, { waitUntil: 'load' }); await sleep(400); }
  // admin
  await p.goto(BASE + '/admin/login', { waitUntil: 'load' });
  await p.fill('input[name="username"]', 'admin');
  await p.fill('input[name="password"]', 'DlyGraduation2025');
  await Promise.all([p.waitForNavigation().catch(() => {}), p.click('button[type="submit"]')]);
  const adminPages = ['/admin', '/admin/bookings?view=grid', '/admin/bookings?view=calendar', '/admin/selection', '/admin/editing', '/admin/upgrades', '/admin/settings', '/admin/wa-template', '/admin/packages', '/admin/notifications', '/admin/push', '/admin/google', '/admin/availability'];
  for (const u of adminPages) { await p.goto(BASE + u, { waitUntil: 'load' }); await sleep(300); }
  // portal klien
  const b2 = await chromium.launch();
  const c = await b2.newPage({ viewport: { width: 390, height: 860 } });
  c.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) violations.push(t.slice(0, 200)); });
  c.on('pageerror', (e) => violations.push('JS ' + String(e).slice(0, 160)));
  await c.goto(BASE + '/portal', { waitUntil: 'load' });
  await c.fill('input[name="code"]', row.code);
  await c.fill('input[name="pin"]', row.portal_pin);
  await Promise.all([c.waitForNavigation().catch(() => {}), c.click('button[type="submit"]')]);
  for (const u of ['/portal/ringkasan', '/portal/pilih-foto', '/portal/pantau-order', '/portal/reschedule', '/portal/upgrade', '/portal/drive']) {
    await c.goto(BASE + u, { waitUntil: 'load' }); await sleep(350);
  }
  console.log('violations:', violations.length ? violations.join('\n') : 'none');
  await b.close(); await b2.close(); app.kill();
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); app.kill(); process.exit(1); });

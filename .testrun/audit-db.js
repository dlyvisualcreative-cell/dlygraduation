'use strict';
/* AUDIT ONLY — database: PRAGMA, ukuran tabel/index, query plan untuk query panas. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const APP = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'dly-audit-db-' + process.pid);
fs.mkdirSync(DATA, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, 'data'))) {
  if (f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f));
}
const db = new Database(path.join(DATA, 'app.sqlite'));

console.log('=== PRAGMA ===');
['journal_mode', 'synchronous', 'cache_size', 'page_size', 'mmap_size', 'busy_timeout',
  'foreign_keys', 'temp_store', 'wal_autocheckpoint', 'locking_mode'].forEach((p) => {
  try { console.log(`  ${p.padEnd(18)} = ${JSON.stringify(db.pragma(p, { simple: true }))}`); } catch (e) { console.log(`  ${p} = (tidak ada)`); }
});

console.log('\n=== UKURAN FILE & TABEL ===');
const files = fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'));
files.forEach((f) => {
  const s = fs.statSync(path.join(APP, 'data', f));
  console.log(`  ${f.padEnd(18)} ${(s.size / 1024 / 1024).toFixed(2)} MB`);
});
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const sizes = [];
tables.forEach((t) => {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;
  sizes.push({ name: t.name, rows: n });
});
sizes.sort((a, b) => b.rows - a.rows);
console.log('  baris per tabel (10 terbesar):');
sizes.slice(0, 10).forEach((t) => console.log(`    ${t.name.padEnd(28)} ${String(t.rows).padStart(6)}`));
console.log(`  total tabel: ${sizes.length}, total baris: ${sizes.reduce((s, t) => s + t.rows, 0)}`);

console.log('\n=== INDEX ===');
const idx = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name").all();
const byTable = {};
idx.forEach((i) => { (byTable[i.tbl_name] = byTable[i.tbl_name] || []).push(i.name); });
Object.entries(byTable).forEach(([t, list]) => console.log(`  ${t.padEnd(26)} ${list.length} index: ${list.join(', ').slice(0, 120)}`));
const noIdx = sizes.filter((t) => t.rows > 30 && !byTable[t.name]);
console.log(`  tabel >30 baris TANPA index: ${noIdx.length ? noIdx.map((t) => t.name + '(' + t.rows + ')').join(', ') : 'tidak ada'}`);

console.log('\n=== QUERY PLAN (query panas) ===');
const hot = [
  ['timeline per booking', 'SELECT * FROM booking_timeline WHERE booking_id = 1'],
  ['pembayaran pertama', 'SELECT MIN(paid_at) FROM booking_payments WHERE booking_id = 1 AND amount > 0'],
  ['booking aktif + join', `SELECT b.*, c.name, p.name FROM bookings b JOIN cities c ON c.id=b.city_id
      JOIN packages p ON p.id=b.package_id LEFT JOIN photo_selections ps ON ps.booking_id=b.id
      ORDER BY b.shooting_date DESC LIMIT 20`],
  ['booking per tanggal', "SELECT * FROM bookings WHERE shooting_date >= '2026-11-01' AND shooting_date <= '2026-11-30' ORDER BY shooting_time"],
  ['foto portal', 'SELECT * FROM photo_selection_photos WHERE portal_id = 1 ORDER BY position'],
  ['pilihan klien', 'SELECT * FROM photo_selection_picks WHERE portal_id = 1'],
  ['upgrade pending', "SELECT * FROM booking_upgrades WHERE booking_id = 1 AND kind='extra' AND status='pending'"],
  ['antrean editing', "SELECT * FROM editing_jobs WHERE status IN ('queued','editing') ORDER BY created_at"],
  ['portfolio aktif', 'SELECT * FROM portfolio WHERE is_active = 1 ORDER BY is_featured DESC, sort_order'],
  ['paket + durasi', 'SELECT * FROM package_durations WHERE package_id = 1 AND is_active = 1'],
  ['sesi aktif', "SELECT * FROM portal_sessions WHERE expires_at > datetime('now')"],
  ['log push', 'SELECT * FROM push_log ORDER BY id DESC LIMIT 20'],
  ['event booking', 'SELECT * FROM booking_events WHERE booking_id = 1 ORDER BY id DESC LIMIT 50']
];
hot.forEach(([label, sql]) => {
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
    const scan = /SCAN (?!.*USING)/i.test(plan) || /TEMP B-TREE/i.test(plan) || /AUTOMATIC/i.test(plan);
    console.log(`  ${scan ? 'WARN' : ' ok '} ${label.padEnd(22)} ${plan.slice(0, 130)}`);
  } catch (err) { console.log(`  ???  ${label} → ${err.message}`); }
});

/* DB dibuka aplikasi dengan mode apa? (dari src/db.js)
   Cek jumlah koneksi: satu koneksi global better-sqlite3 (sinkron) — verifikasi di laporan. */
db.close();
fs.rmSync(DATA, { recursive: true, force: true });

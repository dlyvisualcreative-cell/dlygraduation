'use strict';
/*
 * BASELINE / VERIFIKASI — ukur portal seleksi dengan N foto (fixture lokal):
 *  1. ukuran thumbnail yang BENAR-BENAR dikirim untuk ?w=400 (grid)
 *  2. waktu muat halaman portal (HTML) + jumlah foto
 *  3. waktu submit untuk 50/100/300/700 pilihan
 *  4. kekonsistenan: jumlah pick di DB vs jumlah yang dikembalikan API
 *
 *   node .testrun/measure-selection.js [jumlahFoto]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { makeDataDir, seedPortal } = require('./selection-fixture');

const APP = path.join(__dirname, '..');
const COUNT = Number(process.argv[2] || 700);
const PORT = 4901;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = makeDataDir('dly-measure');
  const seeded = seedPortal({ dir, count: COUNT });
  const token = seeded.token;
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: dir, DLY_DISABLE_PUSH_SCHEDULER: '1', PUBLIC_CACHE_MS: '0' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  app.stderr.on('data', (d) => { const t = String(d); if (!/listening|VAPID|images|push/.test(t)) process.stderr.write('[app] ' + t); });
  for (let i = 0; i < 400; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(3000);

  console.log(`\n=== PORTAL ${COUNT} FOTO (fixture lokal) ===`);

  // 1) HTML portal
  const t0 = Date.now();
  const html = await (await fetch(`${BASE}/selection/${token}`)).text();
  const htmlMs = Date.now() - t0;
  const tiles = (html.match(/class="sel-tile/g) || []).length;
  console.log(`HTML portal: ${htmlMs} ms · ${Math.round(html.length / 1024)} KB · ${tiles} tile`);

  // 2) Thumbnail seperti yang diminta grid (?w=400 & ?w=800)
  const firstId = seeded.photoIds[0];
  for (const w of [400, 800, 320, 640, 1600]) {
    const t = Date.now();
    const r = await fetch(`${BASE}/selection/${token}/photo/${firstId}?w=${w}`);
    const buf = await r.arrayBuffer();
    const ms = Date.now() - t;
    const dims = (() => {
      try {
        const { execFileSync } = require('child_process');
        const tmp = path.join(os.tmpdir(), `probe-${process.pid}-${w}.jpg`);
        fs.writeFileSync(tmp, Buffer.from(buf));
        const out = execFileSync('identify', ['-format', '%wx%h', tmp], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        fs.unlinkSync(tmp);
        return out;
      } catch (e) { return '?'; }
    })();
    console.log(`  ?w=${String(w).padEnd(4)} → ${r.status} ${String(Math.round(buf.byteLength / 1024)).padStart(4)} KB  ${dims.padEnd(10)} ${ms} ms`);
  }

  // 3) Submit: 50 / 100 / 300 / 700 pilihan
  console.log('\n--- submit ---');
  const db = () => new Database(path.join(dir, 'app.sqlite'));
  for (const n of [50, 100, 300, COUNT]) {
    if (n > COUNT) continue;
    // siapkan pilihan langsung di DB (mensimulasikan klien yang sudah memilih n foto)
    const d = db();
    d.prepare('DELETE FROM photo_selection_picks WHERE portal_id = ?').run(seeded.portalId);
    d.prepare("UPDATE photo_selections SET status = 'waiting', submitted_at = NULL WHERE id = ?").run(seeded.portalId);
    const ins = d.prepare('INSERT INTO photo_selection_picks (portal_id, photo_id, position, file_name) VALUES (?,?,?,?)');
    d.transaction(() => {
      seeded.photoIds.slice(0, n).forEach((pid, i) => ins.run(seeded.portalId, pid, i + 1, `DLY-SEL-${String(i + 1).padStart(3, '0')}.jpg`));
    })();
    const before = d.prepare('SELECT COUNT(*) n FROM photo_selection_picks WHERE portal_id = ?').get(seeded.portalId).n;
    d.close();

    const t = Date.now();
    const res = await fetch(`${BASE}/selection/${token}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}'
    });
    const body = await res.json().catch(() => ({}));
    const ms = Date.now() - t;
    const d2 = db();
    const after = d2.prepare('SELECT COUNT(*) n FROM photo_selection_picks WHERE portal_id = ?').get(seeded.portalId).n;
    const st = d2.prepare('SELECT status, submitted_at FROM photo_selections WHERE id = ?').get(seeded.portalId);
    d2.close();
    console.log(`  ${String(n).padStart(3)} pilihan → ${res.status} ${ms} ms · picks ${before}→${after} · status ${st.status}`);
    if (!body.ok && res.status !== 409) console.log('     respons:', JSON.stringify(body).slice(0, 140));
  }

  app.kill('SIGTERM');
  await sleep(700);
  const leftover = fs.existsSync(path.join(dir, 'preview-cache')) ? fs.readdirSync(path.join(dir, 'preview-cache')).length : 0;
  console.log(`\nfile di preview-cache setelah uji: ${leftover}`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

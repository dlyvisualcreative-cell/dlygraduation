'use strict';
/*
 * REPRODUKSI BUG PILIHAN (sebelum perbaikan) — memakai salinan lokal + 40 foto.
 *
 * Skenario persis seperti laporan pemilik:
 *   pilih foto baris 1 → pilih foto baris 3 → pilih foto baris 2
 * lalu diperiksa: apakah pilihan baris 1 & 3 masih ada.
 *
 * Respons jaringan dibuat TIDAK berurutan (respons pertama ditahan 900 ms) — ini yang
 * terjadi pada koneksi HP ketika klien mengetuk cepat.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { makeDataDir, seedPortal } = require('./selection-fixture');

const APP = path.join(__dirname, '..');
const PORT = 4905;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = makeDataDir('dly-repro');
  const seeded = seedPortal({ dir, count: 40, quota: 40 });
  const token = seeded.token;
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DLY_DATA_DIR: dir, DLY_DISABLE_PUSH_SCHEDULER: '1', PUBLIC_CACHE_MS: '0' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  for (let i = 0; i < 400; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(2500);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.addInitScript(() => {
    window.__pickLog = [];
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      const label = String(url).split('/').pop();
      return origFetch.apply(this, arguments).then((res) => {
        const clone = res.clone();
        clone.text().then((body) => {
          window.__pickLog.push({ at: Math.round(performance.now()), url: label, body: body.slice(0, 120) });
        }).catch(() => {});
        return res;
      });
    };
  });

  // Tahan respons pick PERTAMA 900 ms → responsnya tiba SETELAH klik ke-2 dan ke-3.
  let pickCount = 0;
  // PENTING: server memproses berurutan, tetapi RESPONS pertama ditahan 900 ms sehingga
  // tiba SETELAH respons klik ke-2 dan ke-3 (persis kejadian di koneksi HP).
  await page.route('**/selection/*/pick', async (route) => {
    pickCount += 1;
    const first = pickCount === 1;
    const response = await route.fetch();
    const body = await response.text();
    if (first) await sleep(900);
    await route.fulfill({ response, body });
  });

  await page.goto(`${BASE}/selection/${token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sel-tile');

  const state = async () => page.evaluate(() => ({
    picked: Array.from(document.querySelectorAll('.sel-tile.is-picked')).map((t) => Number(t.getAttribute('data-photo'))),
    counter: (document.querySelector('[data-sel-counter-big]') || {}).textContent || '',
    saved: (document.querySelector('[data-picked-count]') || {}).textContent || ''
  }));

  const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('.sel-tile')).map((t) => Number(t.getAttribute('data-photo'))));
  const row1 = tiles[0];
  const row2 = tiles[1];
  const row3 = tiles[2];

  const click = async (id) => {
    await page.click(`.sel-tile[data-photo="${id}"] [data-pick]`);
  };

  console.log(`foto: baris1=${row1} baris2=${row2} baris3=${row3}`);
  await click(row1);            // baris 1
  await sleep(120);
  await click(row3);            // baris 3 (respons pertama masih ditahan)
  await sleep(120);
  await click(row2);            // baris 2 ← di sinilah bug muncul
  await sleep(1500);            // tunggu semua respons selesai

  const after = await state();
  console.log('setelah 3 klik (respons tidak berurutan):', JSON.stringify(after));
  const log = await page.evaluate(() => window.__pickLog);
  log.forEach((l) => console.log(`   [${l.at}ms] ${l.url} ← ${l.body}`));

  // Pembanding: apa yang sebenarnya tersimpan di server?
  const server = await (await fetch(`${BASE}/selection/${token}`, { headers: { accept: 'text/html' } })).text();
  const dbPicked = (server.match(/data-photo="(\d+)"/g) || []).length;
  console.log('jumlah tile bertanda terpilih di HTML (server):', dbPicked);

  const Database = require(path.join(APP, 'node_modules', 'better-sqlite3'));
  const d = new Database(path.join(dir, 'app.sqlite'), { readonly: true });
  const dbIds = d.prepare('SELECT photo_id FROM photo_selection_picks WHERE portal_id = ? ORDER BY position').all(seeded.portalId).map((r) => r.photo_id);
  d.close();
  console.log('tersimpan di DATABASE:', JSON.stringify(dbIds));

  const domSet = new Set(after.picked);
  const lostInUi = dbIds.filter((id) => !domSet.has(id));
  console.log(lostInUi.length
    ? `BUG TERBUKTI: ${lostInUi.length} foto tersimpan di DB tapi TIDAK tampil terpilih di layar → ${JSON.stringify(lostInUi)}`
    : 'Tidak ada pilihan yang hilang di skenario ini.');

  await browser.close();
  app.kill('SIGTERM');
  await sleep(600);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

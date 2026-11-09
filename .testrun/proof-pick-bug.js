'use strict';
/*
 * REPRODUKSI BUG PILIHAN — memakai PROXY yang menahan respons /pick PERTAMA,
 * sehingga respons tiba tidak berurutan (persis perilaku jaringan HP yang lambat).
 *
 *   baris 1 → baris 3 → baris 2
 * Diperiksa: apakah pilihan baris 1 & 3 masih tampil terpilih di layar.
 *
 * Argumen: --proof=before|after (hanya label), --delay=900
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { makeDataDir, seedPortal } = require('./selection-fixture');

const APP = path.join(__dirname, '..');
const LABEL = (process.argv.find((a) => a.startsWith('--proof=')) || '--proof=?').split('=')[1];
const DELAY = Number((process.argv.find((a) => a.startsWith('--delay=')) || '--delay=900').split('=')[1]);
const APP_PORT = 4911;
const PROXY_PORT = 4912;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Proxy: teruskan ke app; tahan body respons /pick pertama selama DELAY ms. */
function startProxy() {
  let pickSeen = 0;
  const server = http.createServer((req, res) => {
    const isPick = /\/pick(\?|$)/.test(req.url);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const proxyReq = http.request({
        host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method, headers: req.headers
      }, (proxyRes) => {
        const bufs = [];
        proxyRes.on('data', (c) => bufs.push(c));
        proxyRes.on('end', () => {
          const body = Buffer.concat(bufs);
          const send = () => {
            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
            res.end(body);
          };
          if (isPick) {
            pickSeen += 1;
            if (pickSeen === 1) { setTimeout(send, DELAY); return; } // respons pertama ditahan
          }
          send();
        });
      });
      proxyReq.on('error', () => { res.writeHead(502); res.end('proxy error'); });
      if (chunks.length) proxyReq.write(Buffer.concat(chunks));
      proxyReq.end();
    });
  });
  server.listen(PROXY_PORT, '127.0.0.1');
  return server;
}

(async () => {
  const dir = makeDataDir('dly-proof');
  const seeded = seedPortal({ dir, count: 40, quota: 40 });
  const token = seeded.token;
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(APP_PORT), DLY_DATA_DIR: dir, DLY_DISABLE_PUSH_SCHEDULER: '1', PUBLIC_CACHE_MS: '0' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  for (let i = 0; i < 400; i++) { try { const r = await fetch(`http://127.0.0.1:${APP_PORT}/`); if (r.ok) break; } catch (e) {} await sleep(100); }
  await sleep(2500);
  const proxy = startProxy();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.addInitScript(() => {
    window.__selDebug = [];
    window.__pickLog = [];
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      const label = String(url).split('/').pop();
      return origFetch.apply(this, arguments).then((res) => {
        res.clone().text().then((body) => {
          let picks = null;
          try { picks = JSON.parse(body).picks; } catch (e) { /* bukan json */ }
          window.__pickLog.push({ at: Math.round(performance.now()), url: label, picks });
        }).catch(() => {});
        return res;
      });
    };
  });

  await page.goto(`${BASE}/selection/${token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sel-tile');

  const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('.sel-tile')).map((t) => Number(t.getAttribute('data-photo'))));
  const [row1, row2, row3] = tiles;

  const state = () => page.evaluate(() => ({
    uiPicked: Array.from(document.querySelectorAll('.sel-tile.is-picked')).map((t) => Number(t.getAttribute('data-photo'))),
    counter: (document.querySelector('[data-sel-counter-big]') || {}).textContent || ''
  }));

  console.log(`\n=== [${LABEL}] portal ${seeded.photoIds.length} foto · respons /pick pertama ditahan ${DELAY} ms ===`);
  console.log(`klik: baris1=${row1} → baris3=${row3} → baris2=${row2}`);
  const click = (id) => page.evaluate((photoId) => {
    const btn = document.querySelector(`.sel-tile[data-photo="${photoId}"] [data-pick]`);
    if (btn) btn.click();
    window.__clickLog = window.__clickLog || [];
    window.__clickLog.push({ at: Math.round(performance.now()), id: photoId });
  }, id).then(() => sleep(160));

  await click(row1);
  await sleep(150);
  await click(row3);
  await sleep(150);
  await click(row2);
  await sleep(DELAY + 1500);

  const ui = await state();
  const dbg = await page.evaluate(() => window.__selDebug || []);
  dbg.forEach((d) => console.log('   dbg', JSON.stringify(d)));
  const clicks = await page.evaluate(() => window.__clickLog || []);
  console.log('   klik:', JSON.stringify(clicks));
  const log = await page.evaluate(() => window.__pickLog);
  log.forEach((l) => console.log(`   [${String(l.at).padStart(5)}ms] respons ${l.url} → picks=${JSON.stringify(l.picks)}`));

  const Database = require(path.join(APP, 'node_modules', 'better-sqlite3'));
  const d = new Database(path.join(dir, 'app.sqlite'), { readonly: true });
  const dbIds = d.prepare('SELECT photo_id FROM photo_selection_picks WHERE portal_id = ? ORDER BY position').all(seeded.portalId).map((r) => r.photo_id);
  d.close();

  console.log(`   LAYAR menampilkan terpilih : ${JSON.stringify(ui.uiPicked)} (${ui.counter})`);
  console.log(`   DATABASE menyimpan          : ${JSON.stringify(dbIds)}`);
  const uiSet = new Set(ui.uiPicked);
  const lost = dbIds.filter((id) => !uiSet.has(id));
  const verdict = lost.length ? `BUG: ${lost.length} foto HILANG dari layar → ${JSON.stringify(lost)}` : 'OK: layar = database';
  console.log(`   ${verdict}`);
  console.log(`   RESULT=${lost.length ? 'FAIL' : 'PASS'}`);

  await browser.close();
  proxy.close();
  app.kill('SIGTERM');
  await sleep(600);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* file terkunci */ }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

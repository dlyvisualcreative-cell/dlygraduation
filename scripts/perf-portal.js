'use strict';

/**
 * Portal seleksi — ukur dampak optimasi (cold vs warm preview cache).
 *
 *   node scripts/perf-portal.js
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PPERF_PORT || 4572);
const DATA = '/tmp/dly-perfportal';
// src/db.js membaca env ini saat di-require → harus diset SEBELUM selection.js dimuat,
// kalau tidak modul membuka database produksi (read-only dari sandbox).
process.env.DLY_DATA_DIR = DATA;
process.env.DLY_DISABLE_PUSH_SCHEDULER = '1';

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA, f)));

  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DLY_DATA_DIR: DATA, DLY_DISABLE_PUSH_SCHEDULER: '1' },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch (e) { /* boot */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const db = new Database(path.join(DATA, 'app.sqlite'));
    const row = db.prepare(`SELECT p.id, p.token,
        (SELECT COUNT(*) FROM photo_selection_photos ph WHERE ph.portal_id = p.id) n
      FROM photo_selections p ORDER BY n DESC LIMIT 1`).get();
    db.prepare("UPDATE photo_selections SET submitted_at = NULL, status = 'waiting', is_open = 1 WHERE id = ?").run(row.id);
    db.close();
    if (!row) { console.log('no portal in this database'); return; }

    const url = `http://127.0.0.1:${PORT}/selection/${row.token}`;
    const measure = async (label) => {
      const browser = await chromium.launch();
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2
      });
      const page = await ctx.newPage();
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'load' });
      const loadMs = Date.now() - t0;
      // Thumbnail memakai loading="lazy": gulir sekali supaya baris kedua ikut diminta,
      // lalu tunggu sampai 8 request /photo/ BENAR-BENAR selesai.
      await page.evaluate(() => window.scrollBy(0, 900));
      let imgsMs = 0;
      for (let i = 0; i < 300; i += 1) {
        const done = await page.evaluate(() => performance.getEntriesByType('resource')
          .filter((r) => r.name.includes('/photo/') && r.responseEnd > 0).length);
        if (done >= 8) { imgsMs = Date.now() - t0; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!imgsMs) imgsMs = Date.now() - t0;
      const stats = await page.evaluate(() => {
        const res = performance.getEntriesByType('resource').filter((r) => r.name.includes('/photo/'));
        return { n: res.length, kb: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024) };
      });
      console.log(`${label}: HTML ${loadMs}ms · 12 thumbnail pertama ${imgsMs}ms · ${stats.n} request gambar · ${stats.kb}KB`);
      await browser.close();
      return { loadMs, imgsMs };
    };

    const cold = await measure('COLD  (cache kosong)');
    const selection = require(path.join(APP, 'src', 'selection.js'));
    // Tunggu sampai penghangatan latar belakang (dipicu halaman) benar-benar selesai:
    // pantau jumlah file preview sampai tidak bertambah lagi.
    const cacheDir = path.join(DATA, 'preview-cache');
    const countFiles = () => { try { return fs.readdirSync(cacheDir).filter((f) => f.startsWith('p')).length; } catch (e) { return 0; } };
    let last = -1;
    let stable = 0;
    const tWait = Date.now();
    while (stable < 4 && Date.now() - tWait < 180000) {
      const now = countFiles();
      stable = now === last ? stable + 1 : 0;
      last = now;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`cache terisi: ${last} file setelah ${((Date.now() - tWait) / 1000).toFixed(1)}s (melanjutkan sisa)`);
    const t1 = Date.now();
    const res = await selection.warmPreviews(row.id, { width: 320 });
    console.log(`warmPreviews sisa: ${res.built} dari ${res.total} foto dalam ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    const warm = await measure('WARM  (cache terisi)');
    console.log(`\nPerbaikan waktu muat galeri: ${Math.round((1 - warm.imgsMs / Math.max(1, cold.imgsMs)) * 100)}% lebih cepat`);
  } finally {
    app.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });

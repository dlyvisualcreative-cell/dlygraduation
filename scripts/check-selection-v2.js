'use strict';

/**
 * SELEKSI FOTO V2 — suite penerimaan (akurasi dulu, kecepatan kedua).
 *
 * Cakupan (permintaan pemilik, bagian F):
 *   1-4   pilih baris 1 → baris 3 → baris 2 (respons TIDAK berurutan): tidak boleh hilang
 *   5     pilih acak lintas baris
 *   6     batalkan satu foto: yang lain tetap terpilih
 *   7-8   scroll ke foto terakhir & kembali ke awal
 *   9     refresh browser
 *   10    buka ulang portal (konteks browser baru)
 *   11    klik cepat beruntun
 *   12    request bersamaan (2 tambah paralel, plus uji kuota)
 *   13    submit 50 / 100 / 300 / 700 foto (p50/p95/p99)
 *   14    kegagalan koneksi saat submit → pilihan utuh, bisa diulang
 *   15    tidak ada pilihan hilang / tertukar / terduplikasi
 *   +     kebijakan thumbnail (WebP, ≤100KB, lebar tak dikenal tidak jatuh ke 1600)
 *   +     pembersihan thumbnail: antrean, idempotent, hanya setelah submit terverifikasi,
 *         data pilihan & master tidak disentuh, tercatat di audit log, retensi 30 hari
 *
 * Semua uji memakai SALINAN database di /tmp + foto lokal dari public/uploads.
 * Data produksi tidak pernah disentuh.
 *
 *   node scripts/check-selection-v2.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const APP = path.join(__dirname, '..');
const APP_PORT = Number(process.env.PORT || 4941);
const PROXY_PORT = APP_PORT + 1;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const PHOTO_COUNT = Number(process.env.PHOTOS || 700);
const DATA_DIR = path.join(os.tmpdir(), `dly-selv2-${process.pid}`);

let pass = 0;
const failures = [];
const ck = (label, ok, detail) => {
  if (ok) { pass += 1; console.log('  ok  ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openDb = () => new Database(path.join(DATA_DIR, 'app.sqlite'));

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */
function masters() {
  return fs.readdirSync(path.join(APP, 'public', 'uploads'))
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .filter((f) => !/fixture|v8-test|ui7-b/.test(f));
}

function prepare(count) {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data'))
    .filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));
  for (const d of ['image-cache', 'logo-cache']) {
    try { fs.cpSync(path.join(APP, 'data', d), path.join(DATA_DIR, d), { recursive: true }); } catch (e) { /* opsional */ }
  }
  fs.mkdirSync(path.join(DATA_DIR, 'preview-cache'), { recursive: true });

  const db = openDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' ORDER BY id DESC LIMIT 1").get();
  const token = require('crypto').randomBytes(24).toString('hex');
  db.prepare('DELETE FROM photo_selections WHERE booking_id = ?').run(booking.id);
  const portalId = Number(db.prepare(`INSERT INTO photo_selections
      (booking_id, token, status, quota, is_open, allow_download, require_full_quota,
       created_at, drive_url, drive_show)
      VALUES (?, ?, 'waiting', ?, 1, 0, 0, datetime('now'), '', 1)`)
    .run(booking.id, token, Math.max(count, 1)).lastInsertRowid);

  const list = masters();
  const ins = db.prepare(`INSERT INTO photo_selection_photos
      (portal_id, code, image, file_name, sort_order, source, is_available, display_no)
      VALUES (?, ?, ?, ?, ?, 'local', 1, ?)`);
  const ids = [];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const code = String(i + 1).padStart(3, '0');
      ids.push(Number(ins.run(portalId, code, `/uploads/${list[i % list.length]}`,
        `DLY-${code}.jpg`, i, i + 1).lastInsertRowid));
    }
  })();
  db.close();
  return { portalId, token, ids, bookingId: booking.id };
}

/* ------------------------------------------------------------------ */
/* Proxy: menahan respons /pick pertama → urutan respons jadi terbalik  */
/* ------------------------------------------------------------------ */
function startProxy({ delayMs = 900 } = {}) {
  let pickSeen = 0;
  const server = http.createServer((req, res) => {
    const isPick = /\/pick(\?|$)/.test(req.url);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const up = http.request({
        host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method, headers: req.headers
      }, (upRes) => {
        const bufs = [];
        upRes.on('data', (c) => bufs.push(c));
        upRes.on('end', () => {
          const body = Buffer.concat(bufs);
          const send = () => { res.writeHead(upRes.statusCode || 500, upRes.headers); res.end(body); };
          if (isPick) {
            pickSeen += 1;
            if (pickSeen === 1) { setTimeout(send, delayMs); return; }
          }
          send();
        });
      });
      up.on('error', () => { res.writeHead(502); res.end('proxy error'); });
      if (chunks.length) up.write(Buffer.concat(chunks));
      up.end();
    });
  });
  server.listen(PROXY_PORT, '127.0.0.1');
  return server;
}

/* ------------------------------------------------------------------ */
/* API helper                                                          */
/* ------------------------------------------------------------------ */
const api = async (p, opts = {}) => {
  const res = await fetch(APP_BASE + p, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
};

const pick = (token, photoId, action = 'add', opId = '') => api(`/selection/${token}/pick`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ photoId, action, opId: opId || `t-${photoId}-${Date.now()}` })
});

const submit = (token) => api(`/selection/${token}/submit`, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}'
});

const dbPicks = (portalId) => {
  const d = openDb();
  const rows = d.prepare('SELECT photo_id, position FROM photo_selection_picks WHERE portal_id = ? ORDER BY position').all(portalId);
  d.close();
  return rows;
};

const resetPicks = (portalId, status = 'waiting') => {
  const d = openDb();
  d.prepare('DELETE FROM photo_selection_picks WHERE portal_id = ?').run(portalId);
  d.prepare("UPDATE photo_selections SET status = ?, submitted_at = NULL WHERE id = ?").run(status, portalId);
  d.prepare('DELETE FROM selection_cleanup_queue WHERE portal_id = ?').run(portalId);
  d.close();
};

const setPicks = (portalId, ids) => {
  const d = openDb();
  d.prepare('DELETE FROM photo_selection_picks WHERE portal_id = ?').run(portalId);
  const ins = d.prepare('INSERT INTO photo_selection_picks (portal_id, photo_id, position, file_name) VALUES (?,?,?,?)');
  d.transaction(() => { ids.forEach((id, i) => ins.run(portalId, id, i + 1, `DLY-${i + 1}.jpg`)); })();
  d.prepare("UPDATE photo_selections SET status = 'waiting', submitted_at = NULL WHERE id = ?").run(portalId);
  d.close();
};

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
};

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
(async () => {
  const fx = prepare(PHOTO_COUNT);
  const app = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(APP_PORT),
      DLY_DATA_DIR: DATA_DIR, DLY_DISABLE_PUSH_SCHEDULER: '1', PUBLIC_CACHE_MS: '0'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  app.stderr.on('data', (d) => {
    const t = String(d);
    if (!/listening|VAPID|images|push|selection-cleanup/.test(t)) process.stderr.write('[app] ' + t);
  });
  for (let i = 0; i < 500; i++) {
    try { const r = await fetch(APP_BASE + '/'); if (r.ok) break; } catch (e) { /* boot */ }
    await sleep(100);
  }
  await sleep(2500);
  const proxy = startProxy({ delayMs: 900 });

  console.log(`\n=== SELEKSI FOTO V2 (${PHOTO_COUNT} foto) ===`);

  /* ---------------- 1-4. bug utama: respons tidak berurutan ---------------- */
  console.log('\n— Bug pilihan saling menghilangkan (respons tidak berurutan) —');
  {
    resetPicks(fx.portalId);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(`${BASE}/selection/${fx.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sel-tile');
    const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('.sel-tile')).map((t) => Number(t.getAttribute('data-photo'))));
    const [row1, row2, row3] = tiles;
    const tap = (id) => page.evaluate((photoId) => {
      const b = document.querySelector(`.sel-tile[data-photo="${photoId}"] [data-pick]`);
      if (b) b.click();
    }, id);

    await tap(row1); await sleep(150);
    await tap(row3); await sleep(150);
    await tap(row2); await sleep(900 + 1500);

    const ui = await page.evaluate(() => ({
      picked: Array.from(document.querySelectorAll('.sel-tile.is-picked')).map((t) => Number(t.getAttribute('data-photo'))),
      counter: (document.querySelector('[data-sel-counter-big]') || {}).textContent || ''
    }));
    const saved = dbPicks(fx.portalId).map((r) => r.photo_id);
    ck('Baris 1 & 3 tetap terpilih setelah baris 2 dipilih (respons lama tiba terakhir)',
      saved.every((id) => ui.picked.includes(id)), `layar=${JSON.stringify(ui.picked)} db=${JSON.stringify(saved)}`);
    ck('Jumlah di layar = jumlah di database', ui.picked.length === saved.length,
      `${ui.picked.length} vs ${saved.length}`);
    ck('Penghitung mengikuti jumlah sebenarnya', ui.counter.startsWith(`${saved.length}/`), ui.counter);
    ck('Badge urutan berbeda per foto (bukan angka yang sama)',
      await page.evaluate(() => {
        const badges = Array.from(document.querySelectorAll('.sel-tile.is-picked [data-order]')).map((b) => b.textContent.trim());
        return badges.length > 1 && new Set(badges).size === badges.length;
      }));

    /* ---------------- 5. pilih acak lintas baris ---------------- */
    console.log('\n— Pilih acak lintas baris & klik cepat —');
    // Foto acak lintas baris, TANPA menyertakan foto yang sudah terpilih (kalau tidak,
    // kliknya berarti membatalkan pilihan — dan ujinya jadi salah, bukan aplikasinya).
    const already = new Set(saved);
    const randomIds = [];
    for (let i = 0; i < 24; i++) {
      const id = tiles[(i * 29 + 7) % tiles.length];
      if (already.has(id) || randomIds.includes(id)) continue;
      randomIds.push(id);
    }
    for (const id of randomIds) { await tap(id); await sleep(40); }
    await sleep(1500);
    const afterRandom = dbPicks(fx.portalId).map((r) => r.photo_id);
    const expected = new Set([...saved, ...randomIds]);
    ck('Semua pilihan acak tersimpan (tidak ada yang hilang)',
      afterRandom.length === expected.size, `${afterRandom.length} vs ${expected.size}`);
    ck('Tidak ada ID duplikat di database',
      new Set(afterRandom).size === afterRandom.length, `${afterRandom.length} baris`);
    ck('Tidak ada ID yang tidak dipilih ikut tersimpan',
      afterRandom.every((id) => expected.has(id)));

    const uiAfter = await page.evaluate(() => Array.from(document.querySelectorAll('.sel-tile.is-picked')).map((t) => Number(t.getAttribute('data-photo'))));
    ck('Layar = database setelah 27 klik cepat', uiAfter.length === afterRandom.length
      && uiAfter.every((id) => afterRandom.includes(id)), `${uiAfter.length} vs ${afterRandom.length}`);

    /* ---------------- 6. batalkan satu, sisanya tetap ---------------- */
    const cancelId = uiAfter[0];
    await tap(cancelId);
    await sleep(700);
    const afterCancel = dbPicks(fx.portalId).map((r) => r.photo_id);
    ck('Membatalkan satu foto hanya menghapus foto itu',
      !afterCancel.includes(cancelId) && afterCancel.length === uiAfter.length - 1,
      `${afterCancel.length} vs ${uiAfter.length - 1}`);

    /* ---------------- 7-8. scroll ke akhir & kembali ---------------- */
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(400);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    const afterScroll = await page.evaluate(() => Array.from(document.querySelectorAll('.sel-tile.is-picked')).map((t) => Number(t.getAttribute('data-photo'))));
    ck('Scroll ke foto terakhir & kembali tidak mengubah pilihan',
      afterScroll.length === afterCancel.length && afterScroll.every((id) => afterCancel.includes(id)));

    /* ---------------- 9. refresh ---------------- */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sel-tile');
    const afterReload = await page.evaluate(() => Array.from(document.querySelectorAll('.sel-tile.is-picked')).map((t) => Number(t.getAttribute('data-photo'))));
    ck('Pilihan tetap ada setelah refresh', afterReload.length === afterCancel.length
      && afterReload.every((id) => afterCancel.includes(id)),
      `${afterReload.length} vs ${afterCancel.length}`);
    await page.close();

    /* ---------------- 10. buka ulang portal (konteks baru) ---------------- */
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const page2 = await ctx2.newPage();
    await page2.goto(`${BASE}/selection/${fx.token}`, { waitUntil: 'domcontentloaded' });
    await page2.waitForSelector('.sel-tile');
    const reopened = await page2.evaluate(() => Array.from(document.querySelectorAll('.sel-tile.is-picked')).map((t) => Number(t.getAttribute('data-photo'))));
    ck('Pilihan tetap ada saat portal dibuka kembali', reopened.length === afterCancel.length
      && reopened.every((id) => afterCancel.includes(id)),
      `${reopened.length} vs ${afterCancel.length}`);
    await ctx2.close();

    /* ---------------- 11-12. request bersamaan ---------------- */
    console.log('\n— Request bersamaan & kuota —');
    resetPicks(fx.portalId);
    const concurrent = await Promise.all([
      pick(fx.token, fx.ids[0], 'add', 'c-a'),
      pick(fx.token, fx.ids[5], 'add', 'c-b'),
      pick(fx.token, fx.ids[9], 'add', 'c-c')
    ]);
    ck('Tiga request tambah bersamaan semuanya sukses',
      concurrent.every((r) => r.status === 200 && r.json && r.json.ok));
    ck('Ketiganya tersimpan (tidak saling menimpa)', dbPicks(fx.portalId).length === 3,
      String(dbPicks(fx.portalId).length));
    const revs = concurrent.map((r) => Number(r.json && r.json.rev)).filter((n) => Number.isFinite(n));
    ck('Setiap perubahan menaikkan nomor revisi (monoton)', new Set(revs).size === revs.length,
      JSON.stringify(revs));

    // Idempotency: kirim operasi yang sama (opId sama) dua kali → tidak menggandakan.
    const before = dbPicks(fx.portalId).length;
    await pick(fx.token, fx.ids[11], 'add', 'dup-1');
    await pick(fx.token, fx.ids[11], 'add', 'dup-1');
    ck('Request dengan opId sama tidak menggandakan pilihan',
      dbPicks(fx.portalId).length === before + 1, `${dbPicks(fx.portalId).length} vs ${before + 1}`);

    // Kuota: siapkan tepat 2 pilihan & kuota 3, lalu dua tambah bersamaan →
    // hanya satu yang boleh masuk, isi akhir tetap 3.
    setPicks(fx.portalId, fx.ids.slice(0, 2));
    const dq = openDb();
    dq.prepare('UPDATE photo_selections SET quota = 3 WHERE id = ?').run(fx.portalId);
    dq.close();
    const quotaRace = await Promise.all([
      pick(fx.token, fx.ids[20], 'add', 'q-1'),
      pick(fx.token, fx.ids[21], 'add', 'q-2')
    ]);
    const quotaNow = dbPicks(fx.portalId).length;
    ck('Kuota tidak bisa dilewati dua request bersamaan (isi tepat 3, satu ditolak)',
      quotaNow === 3 && quotaRace.filter((r) => r.status === 409).length === 1,
      `isi=${quotaNow} status=${JSON.stringify(quotaRace.map((r) => r.status))}`);
    const dq2 = openDb();
    dq2.prepare('UPDATE photo_selections SET quota = ? WHERE id = ?').run(PHOTO_COUNT, fx.portalId);
    dq2.close();
    await browser.close();
  }

  /* ---------------- 13. submit 50/100/300/700 ---------------- */
  console.log('\n— Submit: waktu & konsistensi —');
  const timings = {};
  for (const n of [50, 100, 300, PHOTO_COUNT]) {
    if (n > PHOTO_COUNT) continue;
    const samples = [];
    let lastCount = 0;
    let lastStatus = '';
    for (let i = 0; i < 5; i++) {
      resetPicks(fx.portalId);
      setPicks(fx.portalId, fx.ids.slice(0, n));
      const t = Date.now();
      const res = await submit(fx.token);
      samples.push(Date.now() - t);
      if (res.status !== 200) { lastStatus = `HTTP ${res.status} ${JSON.stringify(res.json)}`; }
      const d = openDb();
      lastCount = d.prepare('SELECT COUNT(*) n FROM photo_selection_picks WHERE portal_id = ?').get(fx.portalId).n;
      const st = d.prepare('SELECT status FROM photo_selections WHERE id = ?').get(fx.portalId).status;
      d.close();
      if (st !== 'submitted') lastStatus = `status=${st}`;
    }
    timings[n] = { p50: pct(samples, 0.5), p95: pct(samples, 0.95), p99: pct(samples, 0.99), max: Math.max(...samples) };
    ck(`Submit ${n} foto: semua pilihan tersimpan & status submitted`,
      lastCount === n && !lastStatus, `count=${lastCount} ${lastStatus}`);
    ck(`Submit ${n} foto selesai di bawah 10 detik (p95)`, timings[n].p95 < 10000,
      `p95=${timings[n].p95}ms`);
    console.log(`      p50=${timings[n].p50}ms p95=${timings[n].p95}ms p99=${timings[n].p99}ms max=${timings[n].max}ms`);
  }

  /* ---------------- 14. submit idempotent & gagal ---------------- */
  console.log('\n— Submit diulang & kegagalan koneksi —');
  {
    resetPicks(fx.portalId);
    setPicks(fx.portalId, fx.ids.slice(0, 120));
    const first = await submit(fx.token);
    const d1 = openDb();
    const at1 = d1.prepare('SELECT submitted_at FROM photo_selections WHERE id = ?').get(fx.portalId).submitted_at;
    d1.close();
    const second = await submit(fx.token);
    const d2 = openDb();
    const at2 = d2.prepare('SELECT submitted_at FROM photo_selections WHERE id = ?').get(fx.portalId).submitted_at;
    const count2 = d2.prepare('SELECT COUNT(*) n FROM photo_selection_picks WHERE portal_id = ?').get(fx.portalId).n;
    const queue = d2.prepare('SELECT COUNT(*) n FROM selection_cleanup_queue WHERE portal_id = ?').get(fx.portalId).n;
    d2.close();
    ck('Klik submit dua kali tidak menghasilkan error (idempotent)',
      first.status === 200 && second.status === 200 && second.json && second.json.ok === true,
      `${first.status}/${second.status}`);
    ck('Submit kedua tidak mengubah timestamp submit', at1 === at2, `${at1} vs ${at2}`);
    ck('Submit kedua tidak menggandakan data pilihan / antrean', count2 === 120 && queue === 1,
      `picks=${count2} antrean=${queue}`);
  }
  {
    // Simulasi koneksi putus: request diarahkan ke port mati → gagal, pilihan utuh.
    resetPicks(fx.portalId);
    setPicks(fx.portalId, fx.ids.slice(0, 80));
    let failed = false;
    try {
      await fetch(`http://127.0.0.1:1/selection/${fx.token}/submit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1500)
      });
    } catch (e) { failed = true; }
    const d = openDb();
    const afterFail = d.prepare('SELECT COUNT(*) n FROM photo_selection_picks WHERE portal_id = ?').get(fx.portalId).n;
    const st = d.prepare('SELECT status FROM photo_selections WHERE id = ?').get(fx.portalId).status;
    const q = d.prepare('SELECT COUNT(*) n FROM selection_cleanup_queue WHERE portal_id = ?').get(fx.portalId).n;
    d.close();
    ck('Koneksi gagal saat submit: pilihan TETAP utuh', failed && afterFail === 80, `${afterFail}/80`);
    ck('Koneksi gagal: status belum berubah jadi submitted', st !== 'submitted', st);
    ck('Koneksi gagal: tidak ada antrean hapus thumbnail', q === 0, String(q));
    const retry = await submit(fx.token);
    ck('Klien dapat mencoba submit lagi setelah gagal', retry.status === 200 && retry.json && retry.json.ok,
      String(retry.status));
  }

  /* ---------------- Thumbnail policy ---------------- */
  console.log('\n— Kebijakan thumbnail —');
  {
    const firstId = fx.ids[0];
    for (const w of [320, 640]) {
      const r = await fetch(`${APP_BASE}/selection/${fx.token}/photo/${firstId}?w=${w}`);
      const buf = await r.arrayBuffer();
      const kb = Math.round(buf.byteLength / 1024);
      ck(`Thumbnail w=${w} disajikan WebP`, /image\/webp/.test(String(r.headers.get('content-type'))),
        String(r.headers.get('content-type')));
      ck(`Thumbnail w=${w} di bawah 100 KB`, kb <= 100, `${kb} KB`);
    }
    const stray = await fetch(`${APP_BASE}/selection/${fx.token}/photo/${firstId}?w=400`);
    const strayBuf = await stray.arrayBuffer();
    const dims = (() => {
      const tmp = path.join(DATA_DIR, 'probe.jpg');
      fs.writeFileSync(tmp, Buffer.from(strayBuf));
      const { execFileSync } = require('child_process');
      const out = execFileSync('identify', ['-format', '%w', tmp], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return Number(out);
    })();
    ck('Lebar tak dikenal (w=400) TIDAK jatuh ke 1600 px', dims <= 640, `${dims}px`);
  }

  /* ---------------- Cleanup: hanya setelah submit, idempotent ---------------- */
  console.log('\n— Pembersihan thumbnail —');
  {
    // Module `src/db.js` membaca DLY_DATA_DIR saat pertama kali di-require. Di proses uji
    // ini belum di-set (hanya proses app yang memakainya), jadi set dulu sebelum require —
    // tanpa ini seluruh akses DB di sini menunjuk data PRODUKSI (read-only).
    process.env.DLY_DATA_DIR = DATA_DIR;
    const cleanup = require(path.join(APP, 'src', 'selection-cleanup.js'));
    // Pastikan ada file cache nyata untuk portal ini.
    for (const id of fx.ids.slice(0, 3)) {
      await fetch(`${APP_BASE}/selection/${fx.token}/photo/${id}?w=320`);
      await fetch(`${APP_BASE}/selection/${fx.token}/photo/${id}?w=1600`);
    }
    const cacheDir = path.join(DATA_DIR, 'preview-cache');
    const before = fs.readdirSync(cacheDir).filter((f) => /^p\d+-\d+\.(jpg|webp)$/.test(f)).length;
    ck('Cache thumbnail terbentuk sebelum pembersihan', before > 0, String(before));

    // Portal BELUM submit → enqueue 'submitted' tidak boleh menghapus apa pun.
    const d0 = openDb();
    d0.prepare("UPDATE photo_selections SET status = 'waiting', submitted_at = NULL WHERE id = ?").run(fx.portalId);
    d0.prepare('DELETE FROM selection_cleanup_queue WHERE portal_id = ?').run(fx.portalId);
    d0.close();
    cleanup.enqueuePortal(fx.portalId, fx.bookingId, 'submitted');
    cleanup.drain(10);
    const afterGuard = fs.readdirSync(cacheDir).filter((f) => /^p\d+-\d+\.(jpg|webp)$/.test(f)).length;
    ck('Portal yang belum submit: thumbnail TIDAK dihapus', afterGuard === before, `${afterGuard}/${before}`);

    // Submit lalu jalankan worker.
    resetPicks(fx.portalId);
    setPicks(fx.portalId, fx.ids.slice(0, 5));
    await submit(fx.token);
    const d1 = openDb();
    const queued = d1.prepare("SELECT COUNT(*) n FROM selection_cleanup_queue WHERE portal_id = ? AND status = 'pending'").get(fx.portalId).n;
    d1.close();
    ck('Setelah submit: thumbnail masuk antrean pembersihan', queued === 1, String(queued));

    const picksBefore = dbPicks(fx.portalId).length;
    const run1 = cleanup.drain(10);
    const afterClean = fs.readdirSync(cacheDir).filter((f) => /^p\d+-\d+\.(jpg|webp)$/.test(f)).length;
    ck('Worker menghapus file cache thumbnail', afterClean < afterGuard, `${afterGuard} → ${afterClean}`);
    ck('Data pilihan TIDAK berubah oleh pembersihan', dbPicks(fx.portalId).length === picksBefore,
      `${dbPicks(fx.portalId).length} vs ${picksBefore}`);
    const run2 = cleanup.drain(10);
    ck('Worker idempotent (dijalankan ulang tidak menghapus apa pun lagi)',
      run1.every((r) => r.ok) && run2.length === 0, `run1=${JSON.stringify(run1)} run2=${run2.length}`);

    const d2 = openDb();
    const audit = d2.prepare("SELECT COUNT(*) n FROM selection_access_log WHERE portal_id = ? AND action = 'cleanup'").get(fx.portalId).n;
    d2.close();
    ck('Aksi pembersihan tercatat di audit log', audit >= 1, String(audit));

    // Master (foto asli) tidak boleh disentuh.
    const mastersStillThere = masters().length;
    ck('Foto master (asli) tidak tersentuh', mastersStillThere > 0, String(mastersStillThere));

    // Retensi: file tua (>30 hari) dibersihkan, file baru tetap.
    const oldFile = path.join(cacheDir, `p${fx.ids[0]}-320.webp`);
    fs.writeFileSync(oldFile, Buffer.from('x'));
    const old = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(oldFile, old, old);
    const freshFile = path.join(cacheDir, `p${fx.ids[1]}-320.webp`);
    fs.writeFileSync(freshFile, Buffer.from('x'));
    const swept = cleanup.sweepExpired();
    ck('Retensi 30 hari: file kedaluwarsa dihapus',
      swept.removed >= 1 && !fs.existsSync(oldFile), `removed=${swept.removed}`);
    ck('Retensi: file baru tetap disimpan', fs.existsSync(freshFile));
  }

  /* ---------------- ringkasan ---------------- */
  console.log('\n=== RINGKASAN WAKTU SUBMIT ===');
  Object.entries(timings).forEach(([n, t]) => console.log(`  ${String(n).padStart(3)} foto → p50 ${t.p50}ms · p95 ${t.p95}ms · p99 ${t.p99}ms · max ${t.max}ms`));

  app.kill('SIGTERM');
  proxy.close();
  await sleep(800);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* file terkunci */ }

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  failures.forEach((f) => console.log('  - ' + f));
  if (failures.length) process.exitCode = 1;
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});

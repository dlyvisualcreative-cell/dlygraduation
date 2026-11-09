'use strict';
/*
 * AUDIT ONLY — preload yang MENGUKUR tanpa mengubah kode aplikasi.
 * Dipakai: node --require ./.testrun/audit-instrument.js server.js
 *
 * Yang dihitung:
 *  - panggilan child_process (identify / convert / spawn lain) beserta durasinya
 *  - pernyataan SQL (prepare + get/all/run) per request HTTP (deteksi N+1)
 *  - waktu proses JS yang memblokir event loop (execFileSync / spawnSync)
 * Hasil ditulis ke JSON saat proses menerima SIGTERM/SIGINT atau lewat endpoint /__audit.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const OUT = process.env.AUDIT_OUT || '/tmp/audit-instrument.json';
const T0 = Date.now();
const state = {
  startedAt: T0,
  boot: { spawns: [], syncBlocks: [] },
  requests: [],
  totals: { prepare: 0, stmts: 0, execFile: 0, execFileSync: 0, spawn: 0, convert: 0, identify: 0 },
  inRequest: null
};

const short = (cmd, args) => {
  const a = (args || []).map((x) => String(x));
  const bin = path.basename(String(cmd).split(' ')[0]);
  const label = bin === 'convert' ? 'convert' : (bin === 'identify' ? 'identify' : bin);
  // Tandai operasi besar: resize ke >= 1200px atau sumber di uploads/
  const big = a.some((x) => /^\d{3,4}x\d{0,4}>?$/.test(x) && Number(x.split('x')[0]) >= 1200)
    || a.some((x) => /public\/uploads/.test(x));
  return { label, big, arg0: a.slice(0, 4).join(' ') };
};

const track = (kind) => {
  const bucket = state.inRequest || state.boot;
  const list = bucket.spawns || bucket;
  state.totals.execFile += kind === 'execFile' ? 1 : 0;
  state.totals.execFileSync += kind === 'execFileSync' ? 1 : 0;
  state.totals.spawn += (kind === 'spawn' || kind === 'spawnSync') ? 1 : 0;
  return (cmd, args) => {
    const meta = short(cmd, args);
    if (meta.label === 'convert') state.totals.convert += 1;
    if (meta.label === 'identify') state.totals.identify += 1;
    return meta;
  };
};

/* ---- patch child_process ---- */
for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const orig = cp[name];
  if (typeof orig !== 'function') continue;
  cp[name] = function patched(cmd, args, opts, cb) {
    const meta = track(name)(cmd, Array.isArray(args) ? args : []);
    const started = Date.now();
    const done = (err) => {
      const rec = {
        at: Date.now() - T0, kind: name, label: meta.label, big: meta.big,
        ms: Date.now() - started, arg0: meta.arg0,
        ok: !err, inRequest: Boolean(state.inRequest)
      };
      const bucket = state.inRequest || state.boot;
      if (bucket.spawns) bucket.spawns.push(rec);
      if (name === 'execFileSync' || name === 'spawnSync') {
        state.boot.syncBlocks.push({ at: Date.now() - T0, ms: rec.ms, label: rec.label });
      }
    };
    try {
      if (name === 'execFile' || name === 'spawn') {
        // callback terakhir
        const args2 = Array.from(arguments);
        const cbIndex = args2.length - 1;
        if (typeof args2[cbIndex] === 'function') {
          const userCb = args2[cbIndex];
          args2[cbIndex] = function () { done(arguments[0]); return userCb.apply(this, arguments); };
        }
        return orig.apply(cp, args2);
      }
      const res = orig.apply(cp, arguments);
      done(null);
      return res;
    } catch (err) {
      done(err);
      throw err;
    }
  };
}

/* ---- patch better-sqlite3 (hitung pernyataan & baris) ---- */
try {
  const indexPath = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
  const Database = require(indexPath);
  const proto = Database.prototype;
  const origPrepare = proto.prepare;
  proto.prepare = function patchedPrepare(sql) {
    state.totals.prepare += 1;
    const stmt = origPrepare.call(this, sql);
    const text = String(sql).replace(/\s+/g, ' ').slice(0, 160);
    ['get', 'all', 'run', 'iterate', 'pluck'].forEach((m) => {
      if (typeof stmt[m] !== 'function' || stmt[m].__wrapped) return;
      const orig = stmt[m].bind(stmt);
      const wrapped = function () {
        state.totals.stmts += 1;
        const r = orig.apply(null, arguments);
        if (state.inRequest) {
          state.inRequest.stmts += 1;
          state.inRequest.sql.push(text);
          if (Array.isArray(r)) state.inRequest.rows += r.length;
        }
        return r;
      };
      wrapped.__wrapped = true;
      stmt[m] = wrapped;
    });
    return stmt;
  };
} catch (err) {
  console.error('[audit] better-sqlite3 patch gagal:', err.message);
}

/* ---- ukur per-request ---- */
const origOn = http.Server.prototype.on;
http.Server.prototype.on = function patchedOn(event, fn) {
  if (event !== 'request' || typeof fn !== 'function') return origOn.call(this, event, fn);
  const wrapped = function (req, res) {
    if (String(req.url).startsWith('/__audit')) return fn.apply(this, arguments);
    const rec = { url: req.url.split('?')[0], method: req.method, start: Date.now(), stmts: 0, rows: 0, sql: [], convert: 0, identify: 0, spawnsBefore: null };
    const before = (state.boot.spawns || []).length;
    state.inRequest = rec;
    res.on('finish', () => {
      rec.ms = Date.now() - rec.start;
      rec.status = res.statusCode;
      const after = (state.boot.spawns || []).slice(before);
      rec.convert = after.filter((s) => s.label === 'convert').length;
      rec.identify = after.filter((s) => s.label === 'identify').length;
      rec.spawnMs = after.reduce((s, x) => s + x.ms, 0);
      state.inRequest = null;
      if (state.requests.length < 4000) state.requests.push(rec);
    });
    return fn.apply(this, arguments);
  };
  return origOn.call(this, event, wrapped);
};

/* ---- dump ---- */
function dump() {
  try {
    const payload = {
      uptimeMs: Date.now() - T0,
      totals: state.totals,
      boot: {
        spawnCount: (state.boot.spawns || []).length,
        spawnsByLabel: (state.boot.spawns || []).reduce((acc, s) => {
          acc[s.label] = (acc[s.label] || 0) + 1; return acc;
        }, {}),
        spawnMsTotal: (state.boot.spawns || []).reduce((s, x) => s + x.ms, 0),
        syncBlocks: state.boot.syncBlocks || [],
        slowest: (state.boot.spawns || []).slice().sort((a, b) => b.ms - a.ms).slice(0, 10)
      },
      requests: state.requests
    };
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
    console.error(`[audit] ditulis ${OUT} (${state.requests.length} request)`);
  } catch (err) {
    console.error('[audit] dump gagal', err.message);
  }
}
process.on('SIGTERM', () => { dump(); process.exit(0); });
process.on('SIGINT', () => { dump(); process.exit(0); });
process.on('exit', dump);

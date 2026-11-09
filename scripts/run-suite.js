'use strict';

/**
 * Runs one acceptance suite against a throw-away server on a COPY of the database.
 * Keeps the "start server → run suite → stop server" cycle inside ONE process so it
 * works regardless of how the sandbox handles background jobs between commands.
 *
 *   node scripts/run-suite.js check-v4
 *   node scripts/run-suite.js check-gcal --mock
 *
 * Env knobs: SUITE_PORT (default 4570), MOCK_PORT (4599).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const SUITE = process.argv[2];
const WITH_MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.SUITE_PORT || 4570);
const MOCK_PORT = Number(process.env.MOCK_PORT || 4599);
const DATA_DIR = `/tmp/dly-suite-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SUITE) {
  console.error('usage: node scripts/run-suite.js <suite-script-basename> [--mock]');
  process.exit(2);
}

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.readdirSync(path.join(APP, 'data')).filter((f) => f.startsWith('app.sqlite'))
    .forEach((f) => fs.copyFileSync(path.join(APP, 'data', f), path.join(DATA_DIR, f)));

  const procs = [];
  const start = (label, file, env) => {
    const child = spawn(process.execPath, [file], {
      cwd: APP,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
    procs.push(child);
    return child;
  };
  const stopAll = () => procs.forEach((p) => { try { p.kill(); } catch (err) { /* ignore */ } });

  try {
    if (WITH_MOCK) {
      start('mock', path.join(APP, 'scripts', 'mock-google.js'), { PORT: String(MOCK_PORT) });
    }
    start('app', path.join(APP, 'server.js'), {
      PORT: String(PORT),
      DLY_DATA_DIR: DATA_DIR,
      ...(WITH_MOCK ? {
        GCAL_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/token`,
        // AUTH_URL intentionally left at the real Google endpoint: the suite asserts the
        // authorize URL shape and then drives the callback directly.
        GCAL_API_BASE: `http://127.0.0.1:${MOCK_PORT}/calendar/v3`,
        GDRIVE_API_BASE: `http://127.0.0.1:${MOCK_PORT}/drive/v3`
      } : {})
    });

    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch (err) { /* boot */ }
      await sleep(250);
    }

    const args = [path.join(APP, 'scripts', `${SUITE}.js`)];
    const suite = spawn(process.execPath, args, {
      cwd: APP,
      env: {
        ...process.env,
        BASE: `http://127.0.0.1:${PORT}`,
        SMOKE_BASE: `http://127.0.0.1:${PORT}`,
        MOCK: `http://127.0.0.1:${MOCK_PORT}`,
        DLY_DATA_DIR: DATA_DIR,
        PERF_PORT: String(PORT)
      },
      stdio: 'inherit'
    });
    const code = await new Promise((resolve) => suite.on('exit', resolve));
    stopAll();
    process.exit(code == null ? 1 : code);
  } catch (err) {
    stopAll();
    throw err;
  }
})();

'use strict';

/**
 * Minimal Google Drive API mock for the photo-selection integration tests.
 * Speaks just enough of drive/v3 to exercise listing, pagination, media download and
 * the error paths (404 folder, 403 permission, 429 quota, API disabled).
 *
 * Control endpoints (test-only):
 *   POST /mock/reset?n=5&page=2      → rebuild the folder with n images, page size
 *   POST /mock/add?name=DLY00099.JPG → add one image
 *   POST /mock/remove?name=…         → delete one image
 *   POST /mock/mode?mode=ok|notfound|forbidden|quota|disabled
 */

const http = require('http');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4699);
const FOLDER_ID = process.env.FOLDER_ID || 'MockFolderIdAAAAAAAAAAAA';
const EMPTY_FOLDER_ID = 'MockEmptyFolderBBBBBBBBBBBB';

const state = {
  mode: 'ok',
  pageSize: 2,
  files: [] // { id, name, size }
};

function png(label, colour) {
  const tmp = path.join('/tmp', `mock-drive-${label}.png`);
  execFileSync('convert', ['-size', '600x800', `xc:${colour}`, tmp], { stdio: 'ignore' });
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf;
}

const PALETTE = ['#0B2340', '#2C5E73', '#5B7C8D', '#8A6E4B', '#6B7280', '#1B455F', '#24505f'];
const cache = new Map();
function imageFor(name) {
  if (!cache.has(name)) {
    const idx = Math.abs([...name].reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length;
    cache.set(name, png(String(cache.size), PALETTE[idx]));
  }
  return cache.get(name);
}

function reset(n, page) {
  state.files = [];
  state.pageSize = Math.max(1, Number(page) || 2);
  for (let i = 1; i <= n; i += 1) {
    const name = `DLY${String(i).padStart(5, '0')}.JPG`;
    state.files.push({ id: `mockfile${String(i).padStart(4, '0')}`, name, size: 120000 + i });
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function errorBody(res, status, reason, message) {
  return json(res, status, { error: { code: status, message, errors: [{ reason }] } });
}

reset(5, 2);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  /* ---------- control ---------- */
  if (p === '/mock/reset') {
    reset(Number(url.searchParams.get('n') || 5), Number(url.searchParams.get('page') || 2));
    return json(res, 200, { ok: true, count: state.files.length });
  }
  if (p === '/mock/add') {
    const name = url.searchParams.get('name') || `DLY${Date.now()}.JPG`;
    state.files.push({ id: `mockfile${Math.random().toString(16).slice(2, 10)}`, name, size: 130000 });
    return json(res, 200, { ok: true, count: state.files.length });
  }
  if (p === '/mock/remove') {
    const name = url.searchParams.get('name');
    state.files = state.files.filter((f) => f.name !== name);
    return json(res, 200, { ok: true, count: state.files.length });
  }
  if (p === '/mock/mode') {
    state.mode = url.searchParams.get('mode') || 'ok';
    return json(res, 200, { ok: true, mode: state.mode });
  }
  if (p === '/mock/state') {
    return json(res, 200, { files: state.files.map((f) => f.name), pageSize: state.pageSize, mode: state.mode });
  }

  /* ---------- drive/v3 ---------- */
  if (!state.mode || state.mode === 'ok') { /* normal */ }
  if (state.mode === 'disabled') {
    return errorBody(res, 403, 'accessNotConfigured',
      'Google Drive API has not been used in project 123 before or it is disabled.');
  }
  if (state.mode === 'quota') {
    return errorBody(res, 403, 'rateLimitExceeded', 'Rate Limit Exceeded');
  }

  if (p === '/drive/v3/about') {
    return json(res, 200, { user: { displayName: 'Mock Drive', emailAddress: 'mock@example.com' } });
  }

  if (p === '/drive/v3/files') {
    const q = url.searchParams.get('q') || '';
    const m = /'([^']+)' in parents/.exec(q);
    const parent = m ? m[1] : FOLDER_ID;

    if (parent === EMPTY_FOLDER_ID) {
      return json(res, 200, { files: [] });
    }
    if (state.mode === 'forbidden') {
      return errorBody(res, 403, 'insufficientFilePermissions',
        'The user does not have sufficient permissions for this file.');
    }
    if (state.mode === 'notfound') {
      return errorBody(res, 404, 'notFound', 'File not found');
    }
    if (parent !== FOLDER_ID) {
      return errorBody(res, 404, 'notFound', `File not found: ${parent}`);
    }

    const pageToken = url.searchParams.get('pageToken');
    const start = pageToken ? Number(pageToken) : 0;
    const slice = state.files.slice(start, start + state.pageSize);
    const next = start + state.pageSize < state.files.length ? String(start + state.pageSize) : undefined;
    return json(res, 200, {
      ...(next ? { nextPageToken: next } : {}),
      files: slice.map((f, i) => ({
        id: f.id,
        name: f.name,
        mimeType: 'image/jpeg',
        size: String(f.size),
        modifiedTime: '2026-11-01T10:00:00.000Z',
        imageMediaMetadata: { width: 600, height: 800 },
        thumbnailLink: `http://127.0.0.1:${PORT}/thumb/${f.id}`
      }))
    });
  }

  const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (fileMatch) {
    const id = decodeURIComponent(fileMatch[1]);
    if (url.searchParams.get('alt') === 'media') {
      const target = state.files.find((f) => f.id === id);
      if (!target) return errorBody(res, 404, 'notFound', 'File not found');
      const buf = imageFor(target.name);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (id === FOLDER_ID) {
      return json(res, 200, {
        id: FOLDER_ID,
        name: 'Folder Mock Sesi Wisuda',
        mimeType: 'application/vnd.google-apps.folder',
        webViewLink: `https://drive.google.com/drive/folders/${FOLDER_ID}`
      });
    }
    if (id === EMPTY_FOLDER_ID) {
      return json(res, 200, {
        id: EMPTY_FOLDER_ID,
        name: 'Folder Kosong',
        mimeType: 'application/vnd.google-apps.folder',
        webViewLink: `https://drive.google.com/drive/folders/${EMPTY_FOLDER_ID}`
      });
    }
    if (state.mode === 'forbidden') {
      return errorBody(res, 403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
    }
    if (state.mode === 'notfound') {
      return errorBody(res, 404, 'notFound', 'File not found');
    }
    return json(res, 200, {
      id,
      name: 'Folder Mock Sesi Wisuda',
      mimeType: 'application/vnd.google-apps.folder',
      webViewLink: `https://drive.google.com/drive/folders/${id}`
    });
  }

  return json(res, 404, { error: { code: 404, message: `Unhandled mock path ${p}` } });
});

server.listen(PORT, () => {
  console.log(`mock drive on ${PORT} (folder ${FOLDER_ID})`);
});

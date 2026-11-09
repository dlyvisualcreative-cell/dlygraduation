'use strict';
/* Local stand-in for Google's OAuth + Calendar API so the integration can be tested
   end-to-end without real credentials. Mirrors the shapes we actually consume. */
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 4599);
const state = {
  events: new Map(),      // id -> event
  folders: new Map(),     // id -> {id, name, parents, webViewLink}
  issuedTokens: new Set(),
  refreshCalls: 0,
  failNext: 0,
  clientLog: [],   // { grant, client_id }
  seq: 1
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    // ---- control endpoints for the test driver ----
    if (url.pathname === '/__reset') {
      state.events.clear();
      state.folders.clear();
      state.clientLog = [];
      state.issuedTokens.clear();
      state.refreshCalls = 0;
      state.failNext = 0;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__state') {
      return json(res, 200, {
        events: Array.from(state.events.values()),
        folders: Array.from(state.folders.values()),
        refreshCalls: state.refreshCalls,
        clientLog: state.clientLog
      });
    }
    if (url.pathname === '/__fail_next') {
      state.failNext = Number(url.searchParams.get('n') || 1);
      return json(res, 200, { ok: true });
    }

    // ---- OAuth token endpoint ----
    if (url.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(raw);
      const grant = params.get('grant_type');
      state.clientLog.push({ grant, client_id: params.get('client_id') || '' });

      // Known test clients: a Drive token may only be refreshed by the Drive client.
      const cid = params.get('client_id') || '';
      const rt0 = params.get('refresh_token') || '';
      if (cid === 'drive-client.apps.googleusercontent.com' && rt0 === 'test-refresh-token') {
        return json(res, 401, { error: 'unauthorized_client', error_description: 'Drive client cannot use the calendar token' });
      }
      if ((cid === 'test-client.apps.googleusercontent.com' || cid === '') && rt0 === 'test-refresh-drive') {
        return json(res, 401, { error: 'unauthorized_client', error_description: 'Calendar client cannot use the drive token' });
      }
      if (grant === 'authorization_code') {
        const code = params.get('code') || '';
        if (code !== 'test-auth-code' && code !== 'test-drive-code') {
          return json(res, 400, { error: 'invalid_grant', error_description: 'Bad code' });
        }
        const isDrive = code === 'test-drive-code';
        const token = 'access-' + (state.seq++);
        state.issuedTokens.add(token);
        return json(res, 200, {
          access_token: token,
          refresh_token: isDrive ? 'test-refresh-drive' : 'test-refresh-token',
          expires_in: 3600,
          scope: isDrive ? 'https://www.googleapis.com/auth/drive.file'
            : 'https://www.googleapis.com/auth/calendar.events',
          token_type: 'Bearer'
        });
      }
      if (grant === 'refresh_token') {
        state.refreshCalls += 1;
        const rt = params.get('refresh_token');
        if (rt !== 'test-refresh-token' && rt !== 'test-refresh-drive') {
          return json(res, 400, { error: 'invalid_grant', error_description: 'Token revoked' });
        }
        const token = 'access-' + (state.seq++);
        state.issuedTokens.add(token);
        return json(res, 200, { access_token: token, expires_in: 3600, token_type: 'Bearer' });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---- Calendar API ----
    const auth = req.headers.authorization || '';
    const bearer = auth.replace(/^Bearer\s+/i, '');
    if (url.pathname.startsWith('/calendar/v3/')) {
      if (state.failNext > 0) {
        state.failNext -= 1;
        return json(res, 500, { error: { message: 'Simulated Google outage' } });
      }
      if (!state.issuedTokens.has(bearer)) {
        return json(res, 401, { error: { message: 'Invalid Credentials', code: 401 } });
      }

      const mEvents = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
      const mOne = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/);

      if (mEvents && req.method === 'GET') {
        return json(res, 200, { items: Array.from(state.events.values()).slice(0, 1) });
      }
      if (mEvents && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        if (!body.start || !body.start.dateTime || !body.end || !body.end.dateTime) {
          return json(res, 400, { error: { message: 'Missing start/end' } });
        }
        const id = 'evt' + (state.seq++);
        // Real Google returns htmlLink; the app stores it for the "open in Calendar" button.
        const htmlLink = 'https://calendar.google.com/calendar/event?eid=' + id;
        state.events.set(id, { id, ...body });
        return json(res, 200, { id, htmlLink, ...body });
      }
      if (mOne && req.method === 'PATCH') {
        const id = decodeURIComponent(mOne[2]);
        if (!state.events.has(id)) return json(res, 404, { error: { message: 'Not Found', code: 404 } });
        const body = JSON.parse(raw || '{}');
        const htmlLink = 'https://calendar.google.com/calendar/event?eid=' + id;
        state.events.set(id, { id, ...body });
        return json(res, 200, { id, htmlLink, ...body });
      }
      if (mOne && req.method === 'DELETE') {
        const id = decodeURIComponent(mOne[2]);
        if (!state.events.has(id)) return json(res, 404, { error: { message: 'Not Found', code: 404 } });
        state.events.delete(id);
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { error: { message: 'Unknown path ' + url.pathname } });
    }

    if (url.pathname === '/drive/v3/about') {
      if (!state.issuedTokens.has(bearer)) {
        return json(res, 401, { error: { message: 'Invalid Credentials', code: 401 } });
      }
      const isDriveToken = state.issuedTokens.has(bearer);
      return json(res, 200, { user: { displayName: 'DLY Drive', emailAddress: 'drive-account@example.com' } });
    }

    // ---- Drive API (v3, subset we actually use) ----
    const mDriveOne = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (mDriveOne && req.method === 'GET') {
      if (!state.issuedTokens.has(bearer)) {
        return json(res, 401, { error: { message: 'Invalid Credentials', code: 401 } });
      }
      const folder = state.folders.get(decodeURIComponent(mDriveOne[1]));
      if (!folder) return json(res, 404, { error: { message: 'File not found', code: 404 } });
      return json(res, 200, { id: folder.id, webViewLink: folder.webViewLink });
    }

    if (url.pathname === '/drive/v3/files') {
      if (state.failNext > 0) {
        state.failNext -= 1;
        return json(res, 500, { error: { message: 'Simulated Drive outage' } });
      }
      if (!state.issuedTokens.has(bearer)) {
        return json(res, 401, { error: { message: 'Invalid Credentials', code: 401 } });
      }

      if (req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const nameMatch = q.match(/name = '((?:\\.|[^'])*)'/);
        const parentMatch = q.match(/'([^']+)' in parents/);
        const wantName = nameMatch ? nameMatch[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\') : null;
        const wantParent = parentMatch ? parentMatch[1] : null;

        let items = Array.from(state.folders.values());
        if (wantName !== null) items = items.filter((f) => f.name === wantName);
        if (wantParent) items = items.filter((f) => (f.parents || []).includes(wantParent));
        return json(res, 200, { files: items.slice(0, 10) });
      }

      if (req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        if (!body.name) return json(res, 400, { error: { message: 'Missing name' } });
        const id = 'fld' + (state.seq++);
        const folder = {
          id,
          name: body.name,
          mimeType: body.mimeType || 'application/vnd.google-apps.folder',
          parents: body.parents || [],
          webViewLink: 'https://drive.google.com/drive/folders/' + id
        };
        state.folders.set(id, folder);
        return json(res, 200, folder);
      }
      return json(res, 405, { error: { message: 'Method not allowed' } });
    }

    json(res, 404, { error: 'not found' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock google on ' + PORT);
});

'use strict';

const crypto = require('crypto');
const { db, verifyPassword } = require('./db');
const { randomToken } = require('./util');

const COOKIE_NAME = 'dly_sid';
const SESSION_HOURS = 8;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function cleanup() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

function login(username, password) {
  cleanup();
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
  if (!admin) return null;
  if (!verifyPassword(password, admin.password_hash)) return null;
  const id = randomToken(24);
  const csrf = randomToken(24);
  db.prepare(`INSERT INTO sessions (id, admin_id, csrf, expires_at)
              VALUES (?, ?, ?, datetime('now', ?))`)
    .run(id, admin.id, csrf, `+${SESSION_HOURS} hours`);
  return { id, csrf, admin: { id: admin.id, username: admin.username } };
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  if (!sid) return null;
  const row = db.prepare(`SELECT s.id, s.csrf, s.expires_at, a.id AS admin_id, a.username
                          FROM sessions s JOIN admins a ON a.id = s.admin_id
                          WHERE s.id = ?`).get(sid);
  if (!row) return null;
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return null;
  }
  return row;
}

function destroySession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}

function cookieFor(req, sid, maxAgeSeconds) {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearCookie(req) {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

// Simple in-memory login throttling (per IP).
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 6;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    rec.count += 1;
  }
}

function resetAttempts(ip) {
  attempts.delete(ip);
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) {
    const target = req.originalUrl || '/admin';
    return res.redirect(`${req.basePath}/admin/login?next=${encodeURIComponent(target)}`);
  }
  req.admin = { id: session.admin_id, username: session.username };
  req.session = session;
  res.locals.admin = req.admin;
  res.locals.csrf = session.csrf;
  next();
}

function verifyCsrf(req, res, next) {
  const token = req.body && req.body._csrf ? String(req.body._csrf) : req.get('x-csrf-token');
  if (!req.session || !token || token !== req.session.csrf) {
    return res.status(403).render('error', {
      title: 'Sesi tidak valid',
      status: 403,
      message: 'Token keamanan tidak cocok. Muat ulang halaman lalu coba lagi.'
    });
  }
  next();
}

function changePassword(adminId, current, next) {
  const { hashPassword, verifyPassword: vp } = require('./db');
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!admin || !vp(current, admin.password_hash)) return false;
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), adminId);
  return true;
}

module.exports = {
  COOKIE_NAME,
  MAX_ATTEMPTS,
  WINDOW_MINUTES: WINDOW_MS / 60000,
  parseCookies,
  login,
  getSession,
  destroySession,
  cookieFor,
  clearCookie,
  requireAdmin,
  verifyCsrf,
  tooManyAttempts,
  recordAttempt,
  resetAttempts,
  changePassword,
  randomToken,
  crypto
};

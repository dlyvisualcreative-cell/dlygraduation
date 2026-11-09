/* DLY Graduation — service worker (Tahap 4)
 *
 * Goal, in plain terms: the home, pricelist and portfolio pages keep working when the
 * connection drops, and nothing private is ever stored.
 *
 * Rules, in order of importance:
 *   1. Admin and the client photo-selection portal are NEVER cached — not the HTML, not
 *      the JSON, not a photo. They fall straight through to the network.
 *   2. `?preview=1` (draft preview) is never cached either, so a preview can never be
 *      replayed from the cache.
 *   3. Only the public marketing routes are cached for navigation, network-first, and only
 *      as a fallback when the request actually fails.
 *   4. Images/CSS/JS are cache-first but the URL carries a version/hash, so a new deploy
 *      is a new URL — there is no way to get stuck on an old asset.
 */
'use strict';

const VERSION = 'dly-v3';
const SCOPE = new URL(self.registration.scope).pathname; // e.g. "/dlygraduation/"
const OFFLINE_URL = SCOPE + 'offline.html';
const PRECACHE = [
  OFFLINE_URL,
  SCOPE + 'assets/favicon.svg',
  SCOPE + 'assets/icon-192.png',
  SCOPE + 'assets/icon-512.png'
];

/** Public routes worth keeping offline. Everything else is network-only. */
const CACHEABLE_PAGES = [
  /^$/, /^index\.html$/,
  /^pricelist$/, /^gallery$/, /^portfolio$/,
  /^paket\/[a-z0-9-]+$/,
  /^cara-order$/, /^faq$/, /^ulasan$/, /^tentang$/,
  /^syarat-ketentuan$/, /^artikel$/, /^artikel\/[a-z0-9-]+$/
];

/** Never touch these, under any circumstance. */
function isPrivate(rel) {
  return rel === 'admin' || rel.startsWith('admin/')
    || rel.startsWith('selection/')
    || rel.startsWith('api/')
    || rel === 'sw.js';
}

const isStaticAsset = (rel) => /^(assets|media|uploads|ph)\//.test(rel);
const isCacheablePage = (rel) => CACHEABLE_PAGES.some((re) => re.test(rel));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Individually, so one missing icon cannot fail the whole installation.
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/** Try the network first; fall back to the cached copy, then to the offline page. */
async function navigateStrategy(request, rel, url) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok && isCacheablePage(rel) && !url.searchParams.has('preview')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    // ignoreSearch so a page cached as "/pricelist" still answers "/pricelist?kota=bandung"
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const offline = await cache.match(OFFLINE_URL);
    return offline || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function staticStrategy(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

/* ==========================================================================
   Web Push (Tahap 6)
   --------------------------------------------------------------------------
   The payload is written by src/push.js and is deliberately GENERIC: no client name,
   phone number, amount or campus. Someone glancing at the lock screen learns that
   "there is a new booking", not who it is for.
   ========================================================================== */

/**
 * Ikon brand untuk notifikasi, diambil dari manifest yang dibuat server.
 * Fallback ke ikon bawaan bila manifest belum punya ikon turunan logo.
 */
let iconPromise = null;
function brandIcons() {
  if (iconPromise) return iconPromise;
  iconPromise = (async () => {
    const fallback = SCOPE + 'assets/icon-192.png';
    try {
      const res = await fetch(SCOPE + 'manifest.webmanifest', { cache: 'no-store' });
      if (!res.ok) return { icon: fallback, badge: fallback };
      const manifest = await res.json();
      const list = Array.isArray(manifest.icons) ? manifest.icons : [];
      const any = list.filter((i) => String(i.purpose || 'any') !== 'maskable');
      const abs = (src) => new URL(src, self.registration.scope).toString();
      const icon = (any[0] || list[0]);
      const badge = (any.find((i) => String(i.sizes) === '192x192') || any[0] || list[0]);
      return {
        icon: icon && icon.src ? abs(icon.src) : fallback,
        badge: badge && badge.src ? abs(badge.src) : fallback
      };
    } catch (err) {
      return { icon: fallback, badge: fallback };
    }
  })();
  return iconPromise;
}
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (err) { data = {}; }

  const title = data.title || 'DLY Graduation';
  // Ikon notifikasi = logo resmi DLY. URL-nya dibaca dari manifest (yang dibuat server
  // dari Identitas Brand), jadi mengganti logo di dashboard otomatis ikut terpakai —
  // tidak ada path logo yang ditulis manual di sini.
  event.waitUntil((async () => {
    const ic = await brandIcons();
    const options = {
      body: data.body || 'Ada pembaruan di dashboard DLY Graduation.',
      icon: ic.icon,
      badge: ic.badge,
      // `tag` + `renotify: false` collapses repeats of the same event type instead of
      // stacking identical notifications on the lock screen.
      tag: data.tag || 'dly-admin',
      renotify: false,
      data: { url: data.url || (SCOPE + 'admin/notifications'), kind: data.kind || '' },
      // No actions, no vibration patterns, no image: keep it quiet and professional.
      silent: false
    };
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Payload URLs are app-relative ("/admin/bookings/9"). On the published subpath the app
  // lives under SCOPE, so a bare leading slash must be re-prefixed or the tap would land on
  // https://host/admin/... (a 404 on the platform).
  const raw = (event.notification.data && event.notification.data.url) || 'admin/notifications';
  const target = raw.startsWith('/') ? SCOPE + raw.slice(1) : raw;
  // Resolve against the registration SCOPE (not the origin) so even a relative URL stays
  // inside the app on a published subpath or a custom domain.
  const url = new URL(target, self.registration.scope).toString();

  // The admin pages live under the same scope; open (or focus) a single window so a tap
  // never leaves five dashboard tabs behind.
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      try {
        const existing = new URL(client.url);
        if (existing.origin === self.location.origin && existing.pathname.startsWith(SCOPE + 'admin')) {
          await client.focus();
          if ('navigate' in client) { await client.navigate(url); return; }
        }
      } catch (err) { /* keep looking */ }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;      // fonts/CDN handled by the browser
  if (!url.pathname.startsWith(SCOPE)) return;          // another app on the same host

  const rel = url.pathname.slice(SCOPE.length);
  if (isPrivate(rel)) return;                           // admin + client portal: network only
  if (url.searchParams.has('preview')) return;          // draft preview must never be cached

  if (request.mode === 'navigate') {
    event.respondWith(navigateStrategy(request, rel, url));
    return;
  }
  if (isStaticAsset(rel)) {
    event.respondWith(staticStrategy(request));
  }
});

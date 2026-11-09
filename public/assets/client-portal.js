'use strict';

/* ==========================================================================
   Client Portal — drawer sidebar (mobile) + interaksi ringan.
   Tidak ada dependensi; tidak menyentuh data (semua validasi di backend).
   ========================================================================== */
(function () {
  var body = document.body;
  var side = document.querySelector('[data-cp-side]');
  var toggle = document.querySelector('[data-cp-toggle]');
  var backdrop = document.querySelector('[data-cp-backdrop]');
  if (!side || !toggle) return;

  function setOpen(open) {
    body.classList.toggle('cp-nav-open', open);
    side.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Tutup menu' : 'Buka menu');
    if (backdrop) {
      if (open) backdrop.hidden = false;
      backdrop.classList.toggle('is-open', open);
      if (!open) setTimeout(function () { backdrop.hidden = true; }, 240);
    }
  }

  toggle.addEventListener('click', function () {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  if (backdrop) backdrop.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') setOpen(false);
  });
  side.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () { if (window.innerWidth < 1000) setOpen(false); });
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth >= 1000) setOpen(false);
  });

  /* PIN: hanya angka. Submit lewat tombol (tidak auto-submit) supaya klien tidak
     terkirim tanpa sengaja saat salah ketik digit terakhir. */
  var pin = document.querySelector('.cp-login__pin');
  if (pin) {
    pin.addEventListener('input', function () {
      pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
    });
  }
})();

/* ==========================================================================
   Notifikasi client (opt-in). Izin HANYA diminta setelah tombol ditekan.
   Subscription terikat ke booking milik sesi ini (server-side).
   ========================================================================== */
(function () {
  var box = document.querySelector('[data-cp-push]');
  if (!box) return;
  var base = box.getAttribute('data-base') || '';
  var vapidKey = box.getAttribute('data-key') || '';
  var onBtn = box.querySelector('[data-cp-push-on]');
  var offBtn = box.querySelector('[data-cp-push-off]');
  var state = box.querySelector('[data-cp-push-state]');

  function setState(text, tone) {
    if (!state) return;
    state.textContent = text;
    state.className = 'cp-small-note cp-notify__state' + (tone ? ' is-' + tone : '');
  }
  function supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function standalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }
  function urlB64(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var s = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }
  function post(path, payload) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  if (!supported()) {
    if (onBtn) onBtn.hidden = true;
    setState(isIos() && !standalone()
      ? 'Di iPhone, tambahkan situs ini ke Layar Utama dulu untuk mengaktifkan notifikasi.'
      : 'Browser ini tidak mendukung notifikasi.', 'warn');
    return;
  }

  navigator.serviceWorker.getRegistration(base + '/').then(function (reg) {
    return reg ? reg.pushManager.getSubscription() : null;
  }).then(function (sub) {
    if (sub) {
      setState('Notifikasi aktif di perangkat ini.', 'ok');
      if (onBtn) onBtn.hidden = true;
      if (offBtn) offBtn.hidden = false;
    } else if (Notification.permission === 'denied') {
      setState('Izin notifikasi diblokir browser. Ubah lewat pengaturan situs.', 'warn');
    } else {
      setState('Belum aktif di perangkat ini.');
    }
  }).catch(function () { setState('Status notifikasi tidak terbaca.'); });

  if (onBtn) {
    onBtn.addEventListener('click', function () {
      onBtn.disabled = true;
      setState('Meminta izin…');
      Notification.requestPermission().then(function (permission) {
        if (permission !== 'granted') {
          onBtn.disabled = false;
          setState('Izin belum diberikan. Notifikasi tidak bisa dikirim.', 'warn');
          return null;
        }
        return navigator.serviceWorker.register(base + '/sw.js', { scope: base + '/' })
          .then(function () { return navigator.serviceWorker.ready; })
          .then(function (reg) {
            return reg.pushManager.getSubscription().then(function (existing) {
              return existing || reg.pushManager.subscribe({
                userVisibleOnly: true, applicationServerKey: urlB64(vapidKey)
              });
            });
          })
          .then(function (sub) {
            var json = sub.toJSON ? sub.toJSON() : sub;
            return post('/portal/push/subscribe', { subscription: json, platform: 'Client' });
          })
          .then(function (result) {
            if (!result || !result.ok) {
              onBtn.disabled = false;
              setState((result && result.message) || 'Gagal menyimpan langganan.', 'warn');
              return;
            }
            setState('Notifikasi aktif. Kamu akan diberi tahu soal booking ini.', 'ok');
            onBtn.hidden = true;
            if (offBtn) offBtn.hidden = false;
          });
      }).catch(function (err) {
        onBtn.disabled = false;
        setState(String(err && err.message ? err.message : err), 'warn');
      });
    });
  }

  if (offBtn) {
    offBtn.addEventListener('click', function () {
      offBtn.disabled = true;
      navigator.serviceWorker.getRegistration(base + '/').then(function (reg) {
        return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
      }).then(function (sub) {
        if (!sub) return post('/portal/push/unsubscribe', { endpoint: '' });
        var endpoint = sub.endpoint;
        return sub.unsubscribe().then(function () {
          return post('/portal/push/unsubscribe', { endpoint: endpoint });
        });
      }).then(function () {
        setState('Notifikasi dimatikan di perangkat ini.');
        offBtn.hidden = true;
        if (onBtn) { onBtn.hidden = false; onBtn.disabled = false; }
      }).catch(function () {
        offBtn.disabled = false;
        setState('Gagal mematikan notifikasi. Coba lagi.', 'warn');
      });
    });
  }
})();

/* ==========================================================================
   Status order otomatis (revisi 18)
   - Halaman Ringkasan & Pantau Order menyegarkan dirinya sendiri TEPAT saat jadwal
     sesi pemotretan tiba (timestamp booking + jam server), tanpa refresh manual.
   - Pemeriksaan berkala 45 detik sebagai jaring pengaman (mis. tab dibuka lama).
   - Tidak ada data pribadi di request/response; hanya tahap order milik sesi ini.
   ========================================================================== */
(function () {
  var live = document.querySelector('[data-cp-live]');
  if (!live) return;
  var base = document.body.getAttribute('data-base') || '';
  var stage = live.getAttribute('data-stage') || '';
  // Revisi 2 (08): tahap bisa berubah STATUS tanpa berganti tahap (tahap 03 selesai,
  // tahap 07 mulai, tahap 08 jadi centang) dan posisi antrean bisa bergeser — semuanya
  // perlu memicu penyegaran, bukan hanya pergantian nama tahap.
  var state = live.getAttribute('data-state') || '';
  var queue = live.getAttribute('data-queue') || '';
  var nextAt = Number(live.getAttribute('data-next-at') || 0) || 0;
  var reloading = false;
  var retry = 0;

  function refresh() {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  }

  function schedule(ts) {
    if (reloading || !ts) return;
    var wait = ts - Date.now() + 1200;
    if (!(wait > 0)) wait = 2500;              // waktu sudah lewat: beri server jeda singkat
    window.setTimeout(check, Math.min(wait, 2147483000));
  }

  function check() {
    if (reloading || document.hidden) return;
    fetch(base + '/portal/status', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store'
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (reloading || !data || !data.ok) return;
      var nextQueue = data.queue && data.queue.position ? String(data.queue.position) : '';
      if (String(data.stage || '') !== stage
        || String(data.state || '') !== state
        || nextQueue !== queue) { refresh(); return; }
      if (data.nextSessionAt) { schedule(Number(data.nextSessionAt)); return; }
      // Server belum mencatat tahap baru (mis. selisih jam): coba beberapa kali lagi.
      if (nextAt && Date.now() >= nextAt && retry < 8) {
        retry += 1;
        window.setTimeout(check, 5000);
      }
    }).catch(function () { /* offline: halaman tetap seperti apa adanya */ });
  }

  schedule(nextAt);
  window.setInterval(check, 45000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) check();
  });
})();

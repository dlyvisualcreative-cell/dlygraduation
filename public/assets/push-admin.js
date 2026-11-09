'use strict';

/**
 * Admin side of Web Push (Tahap 6).
 *
 * Nothing here runs on page load. The notification permission prompt is requested ONLY
 * after the "Aktifkan Notifikasi" button is pressed — that is both a browser requirement
 * on iOS and a deliberate UX choice.
 */
(function () {
  'use strict';

  var btn = document.querySelector('[data-push-enable]');
  var offBtn = document.querySelector('[data-push-disable]');
  var stateEl = document.querySelector('[data-push-state]');
  var hintEl = document.querySelector('[data-push-hint]');
  if (!btn) return;

  var base = btn.getAttribute('data-base') || '';
  var csrf = btn.getAttribute('data-csrf') || '';
  var vapidKey = btn.getAttribute('data-key') || '';

  function setState(text, tone) {
    if (!stateEl) return;
    stateEl.textContent = text;
    stateEl.className = 'push-state' + (tone ? ' push-state--' + tone : '');
  }
  function setHint(text) { if (hintEl) hintEl.textContent = text || ''; }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      // iPadOS 13+ reports itself as a Mac; the touch points give it away.
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }
  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function platformLabel() {
    if (isIos()) return isStandalone() ? 'iPhone (Home Screen)' : 'iPhone (Safari)';
    if (/Android/i.test(navigator.userAgent)) return 'Android';
    if (/Macintosh/i.test(navigator.userAgent)) return 'macOS';
    if (/Windows/i.test(navigator.userAgent)) return 'Windows';
    return 'Desktop';
  }

  function postJSON(path, payload) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok && data.ok !== false, data: data };
      });
    });
  }

  function refresh() {
    if (!supported()) {
      if (isIos() && !isStandalone()) {
        setState('Belum bisa di iPhone', 'warn');
        setHint('Tambahkan website ini ke Layar Utama (Bagikan → Add to Home Screen), lalu buka dari ikon tersebut.');
      } else {
        setState('Browser tidak mendukung Web Push', 'warn');
      }
      btn.disabled = true;
      return;
    }
    if (isIos() && !isStandalone()) {
      setState('Perlu ditambahkan ke Layar Utama', 'warn');
      setHint('Safari di iPhone baru mengizinkan notifikasi setelah website ditambahkan ke Layar Utama. Lihat panduan di bawah.');
    }

    navigator.serviceWorker.getRegistration(base + '/').then(function (reg) {
      if (!reg) return null;
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      var granted = Notification.permission === 'granted';
      if (sub && granted) {
        setState('Notifikasi aktif di perangkat ini', 'ok');
        btn.hidden = true;
        if (offBtn) offBtn.hidden = false;
        setHint('Perangkat ini sudah terdaftar dan akan menerima notifikasi.');
      } else if (Notification.permission === 'denied') {
        setState('Izin notifikasi diblokir', 'err');
        setHint('Buka pengaturan situs di browser (ikon gembok di address bar) → Notifikasi → Izinkan, lalu muat ulang halaman.');
      } else {
        setState('Belum aktif di perangkat ini', '');
        if (!(isIos() && !isStandalone())) {
          setHint('Tekan tombol di atas untuk mengaktifkan. Browser akan meminta izin setelahnya.');
        }
      }
    }).catch(function () {
      setState('Status tidak terbaca', 'warn');
    });
  }

  btn.addEventListener('click', function () {
    if (!vapidKey) { setHint('Kunci VAPID belum tersedia di server.'); return; }
    if (!supported()) { setHint('Browser ini tidak mendukung Web Push.'); return; }
    if (isIos() && !isStandalone()) {
      setHint('Tambahkan dulu ke Layar Utama, lalu buka dari ikonnya dan tekan tombol ini lagi.');
      return;
    }

    btn.disabled = true;
    setState('Meminta izin…', 'info');

    // 1) permission — only now, because a click happened.
    Notification.requestPermission().then(function (permission) {
      if (permission !== 'granted') {
        btn.disabled = false;
        setState(permission === 'denied' ? 'Izin ditolak' : 'Izin belum diberikan', 'err');
        setHint(permission === 'denied'
          ? 'Izinkan notifikasi dari pengaturan situs di browser, lalu coba lagi.'
          : 'Izin dibutuhkan agar notifikasi bisa dikirim.');
        return null;
      }
      setState('Menyiapkan langganan…', 'info');
      return navigator.serviceWorker.register(base + '/sw.js', { scope: base + '/' })
        .then(function (reg) { return navigator.serviceWorker.ready; })
        .then(function (reg) {
          return reg.pushManager.getSubscription().then(function (existing) {
            if (existing) return existing;
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(vapidKey)
            });
          });
        })
        .then(function (sub) {
          var json = sub.toJSON ? sub.toJSON() : sub;
          return postJSON('/admin/push/subscribe', {
            subscription: json,
            platform: platformLabel(),
            label: platformLabel() + ' · ' + new Date().toLocaleDateString('id-ID')
          });
        })
        .then(function (result) {
          if (!result || !result.ok) {
            setState('Gagal menyimpan langganan', 'err');
            setHint((result && result.data && result.data.message) || 'Coba lagi, atau muat ulang halaman.');
            btn.disabled = false;
            return;
          }
          setState('Notifikasi aktif di perangkat ini', 'ok');
          setHint('Berhasil. Perangkat ini akan menerima notifikasi. Klik "Kirim notifikasi percobaan" untuk memastikan.');
          btn.hidden = true;
          if (offBtn) offBtn.hidden = false;
          setTimeout(function () { location.reload(); }, 900);
        });
    }).catch(function (err) {
      btn.disabled = false;
      setState('Gagal mengaktifkan', 'err');
      setHint(String(err && err.message ? err.message : err));
    });
  });

  if (offBtn) {
    offBtn.addEventListener('click', function () {
      offBtn.disabled = true;
      navigator.serviceWorker.getRegistration(base + '/').then(function (reg) {
        return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
      }).then(function (sub) {
        if (!sub) return postJSON('/admin/push/unsubscribe', { endpoint: '' });
        var endpoint = sub.endpoint;
        return sub.unsubscribe().then(function () {
          return postJSON('/admin/push/unsubscribe', { endpoint: endpoint });
        });
      }).then(function () {
        setState('Perangkat ini dilepas', '');
        setHint('Notifikasi tidak lagi dikirim ke perangkat ini. Anda bisa mengaktifkannya lagi kapan saja.');
        location.reload();
      }).catch(function () {
        offBtn.disabled = false;
        setHint('Gagal melepas perangkat. Coba lagi.');
      });
    });
  }

  refresh();
})();

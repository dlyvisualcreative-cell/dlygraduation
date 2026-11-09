'use strict';

/* ==========================================================================
   Portfolio horizontal carousel (dipakai di beberapa tempat)
   --------------------------------------------------------------------------
   - Homepage "Portfolio Highlights" (section-featured.ejs)
   - Halaman Gallery /gallery (satu jalur horizontal, auto-slider)
   - "Portfolio klien lain" di halaman portfolio klien

   Setiap `[data-pf-carousel]` diinisialisasi sendiri (bukan hanya yang pertama),
   dan tombol panah dicari di dalam root-nya (atau section terdekat untuk homepage
   yang menaruh panah di header section).

   - Scroll container = `.pf-carousel__viewport` (overflow-x + scroll-snap).
   - Titik snap dihitung dari offsetLeft tiap slide (bukan kelipatan lebar), supaya
     slide terakhir yang hanya bisa tergeser sebagian tetap bisa dicapai.
   - Autoplay halus dan berulang (kembali ke karya pertama); berhenti saat pengguna
     menyentuh/menggeser, lanjut setelah tenang.
   - prefers-reduced-motion → autoplay tidak pernah aktif.
   - Tidak ada slide duplikat/clone, jadi screen reader tidak menemukan konten ganda.
   ========================================================================== */
(function () {
  var roots = Array.prototype.slice.call(document.querySelectorAll('[data-pf-carousel]'));
  if (!roots.length) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function init(root) {
    var viewport = root.querySelector('[data-pf-viewport]');
    var track = root.querySelector('[data-pf-track]');
    var dotsWrap = root.querySelector('[data-pf-dots]');
    if (!viewport || !track) return;

    // Panah: di dalam root (gallery/others) atau di section terdekat (homepage).
    var controlScope = root.querySelector('[data-pf-prev]')
      ? root
      : (root.closest('section') || root);
    var prev = controlScope.querySelector('[data-pf-prev]');
    var next = controlScope.querySelector('[data-pf-next]');

    var slides = Array.prototype.slice.call(track.querySelectorAll('.pf-carousel__slide'));
    if (!slides.length) return;

    var interval = Math.max(3500, Number(root.getAttribute('data-interval')) || 5200);
    var timer = null;
    var paused = false;
    var userPausedUntil = 0;
    var resumeTimer = null;

    var maxScroll = function () { return Math.max(0, viewport.scrollWidth - viewport.clientWidth); };

    /** Posisi scroll (px) untuk tiap slide, dihitung dari offsetLeft relatif track. */
    function targets() {
      if (!slides.length) return [0];
      var limit = maxScroll();
      var base = slides[0].offsetLeft;
      return slides.map(function (s) {
        return Math.max(0, Math.min(Math.round(s.offsetLeft - base), limit));
      });
    }

    function nearestIndex() {
      var list = targets();
      var x = viewport.scrollLeft;
      var best = 0;
      var bestDist = Infinity;
      list.forEach(function (pos, i) {
        var d = Math.abs(pos - x);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      return best;
    }

    function paintDots() {
      if (!dotsWrap) return;
      var active = nearestIndex();
      Array.prototype.forEach.call(dotsWrap.children, function (dot, i) {
        dot.classList.toggle('is-active', i === active);
        dot.setAttribute('aria-selected', i === active ? 'true' : 'false');
      });
    }

    function buildDots() {
      if (!dotsWrap) return;
      dotsWrap.innerHTML = '';
      slides.forEach(function (_, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pf-carousel__dot' + (i === 0 ? ' is-active' : '');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-label', 'Karya ' + (i + 1));
        b.addEventListener('click', function () { pauseForInteraction(); goTo(i); });
        dotsWrap.appendChild(b);
      });
    }

    function goTo(i, smooth) {
      var list = targets();
      var idx = Math.max(0, Math.min(i, list.length - 1));
      var left = list[idx];
      try {
        viewport.scrollTo({ left: left, behavior: (reduce || smooth === false) ? 'auto' : 'smooth' });
      } catch (e) { viewport.scrollLeft = left; }
      paintDots();
    }

    function step(delta) {
      var list = targets();
      if (list.length < 2 || maxScroll() < 8) return;
      var current = nearestIndex();
      var target = current + delta;
      if (target >= list.length) target = 0;         // berulang: kembali ke karya pertama
      if (target < 0) target = list.length - 1;
      // Beberapa slide terakhir bisa punya posisi scroll yang SAMA (di-clamp ke maxScroll),
      // sehingga `step` bisa terlihat macet. Lewati posisi kembar dan lanjut ke posisi
      // berbeda berikutnya — termasuk berputar kembali ke awal.
      var guard = 0;
      while (list[target] === list[current] && target !== current && guard < list.length) {
        target += delta;
        if (target >= list.length) target = 0;
        if (target < 0) target = list.length - 1;
        guard += 1;
      }
      goTo(target);
    }

    function startAuto() {
      if (reduce || paused || Date.now() < userPausedUntil || document.hidden || timer) return;
      if (maxScroll() < 8) return;                   // semua kartu sudah muat: tidak perlu autoplay
      timer = window.setInterval(function () {
        if (maxScroll() < 8) { stopAuto(); return; }
        step(1);
      }, interval);
    }
    function stopAuto() {
      if (timer) { window.clearInterval(timer); timer = null; }
    }
    /** Interaksi pengguna: hentikan, lanjutkan otomatis setelah 9 detik tanpa interaksi. */
    function pauseForInteraction() {
      stopAuto();
      paused = true;
      userPausedUntil = Date.now() + 9000;
      if (resumeTimer) window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(function () { paused = false; startAuto(); }, 9000);
    }
    function holdPause() { paused = true; stopAuto(); }
    function releasePause() { if (Date.now() >= userPausedUntil) paused = false; startAuto(); }

    if (prev) prev.addEventListener('click', function () { pauseForInteraction(); step(-1); });
    if (next) next.addEventListener('click', function () { pauseForInteraction(); step(1); });

    ['pointerdown', 'touchstart', 'wheel'].forEach(function (ev) {
      viewport.addEventListener(ev, pauseForInteraction, { passive: true });
    });
    viewport.addEventListener('mouseenter', holdPause);
    viewport.addEventListener('mouseleave', releasePause);
    viewport.addEventListener('focusin', holdPause);
    viewport.addEventListener('focusout', releasePause);
    viewport.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); pauseForInteraction(); step(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); pauseForInteraction(); step(-1); }
    });

    /* ------------------------------------------------------------------
       Drag dengan MOUSE (desktop/laptop).
       `overflow-x: auto` hanya bisa di-drag natively di layar sentuh, jadi tanpa
       ini pengguna desktop tidak bisa "menggeser" carousel — padahal revisi
       meminta swipe MAUPUN drag. Snap dimatikan sementara saat menyeret supaya
       tidak "melawan" gerakan tangan, lalu dirapikan ke slide terdekat.
       Klik kartu setelah menyeret tidak boleh ikut membuka halaman detail.
       ------------------------------------------------------------------ */
    var drag = null;
    var suppressClick = false;
    viewport.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (maxScroll() < 8) return;
      drag = { x: e.clientX, start: viewport.scrollLeft, moved: false };
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < 6) return;                // masih klik, bukan geser
        drag.moved = true;
        pauseForInteraction();
        viewport.style.scrollSnapType = 'none';
        viewport.classList.add('is-dragging');
      }
      viewport.scrollLeft = drag.start - dx;
      paintDots();
    });
    function endDrag() {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      viewport.style.scrollSnapType = '';
      viewport.classList.remove('is-dragging');
      if (moved) {
        suppressClick = true;
        goTo(nearestIndex());
        window.setTimeout(function () { suppressClick = false; }, 320);
      }
    }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('click', function (e) {
      if (!suppressClick) return;
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }, true);

    var scrollTick = null;
    viewport.addEventListener('scroll', function () {
      if (scrollTick) return;
      scrollTick = window.setTimeout(function () { scrollTick = null; paintDots(); }, 90);
    }, { passive: true });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopAuto(); else startAuto();
    });
    window.addEventListener('resize', function () { paintDots(); });

    buildDots();
    paintDots();
    // Gambar/layout belum selesai saat script jalan → maxScroll masih 0 sehingga autoplay
    // tidak pernah mulai. Coba lagi setelah semua aset selesai dimuat.
    startAuto();
    window.addEventListener('load', function () { setTimeout(startAuto, 400); });
    setTimeout(startAuto, 1500);
    setTimeout(startAuto, 3000);
  }

  roots.forEach(init);
})();

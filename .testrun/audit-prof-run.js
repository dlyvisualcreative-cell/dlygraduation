'use strict';
/* AUDIT ONLY — pembungkus untuk mengambil profil CPU: jalankan app, lalu keluar bersih. */
const EXIT_AFTER = Number(process.env.PROF_EXIT_MS || 12000);
require('../server.js');
setTimeout(() => process.exit(0), EXIT_AFTER).unref();

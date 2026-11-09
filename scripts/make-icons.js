'use strict';

/**
 * Generates the PWA icons from the brand colours (navy #0B2340 + warm cream letters).
 *
 * Run once, commit the PNGs to public/assets/:
 *   node scripts/make-icons.js
 *
 * The site's own uploaded logo is NOT used on purpose: a logo can be a wide lockup or
 * have a transparent background, which makes a poor app icon. These are always square.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'assets');
const FONTS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
];
const FONT = FONTS.find((f) => fs.existsSync(f));

if (!FONT) {
  console.error('No usable .ttf font found (ImageMagick here has no fontconfig).');
  process.exit(1);
}

function make(size, file, { padding = 0 } = {}) {
  const target = path.join(OUT, file);
  const inner = Math.round(size * (1 - padding * 2));
  const fontSize = Math.round(inner * 0.30);
  // A navy square with the DLY monogram: legible at 48px and safe as a maskable icon.
  execFileSync('convert', [
    '-size', `${size}x${size}`, 'xc:#0B2340',
    '-fill', '#F3E8D5',
    '-font', FONT,
    '-pointsize', String(fontSize),
    '-gravity', 'center',
    '-annotate', '+0+0', 'DLY',
    '-fill', 'rgba(243,232,213,0.55)',
    '-pointsize', String(Math.round(fontSize * 0.30)),
    '-gravity', 'center',
    '-annotate', `+0+${Math.round(fontSize * 0.78)}`, 'GRADUATION',
    target
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log('icon', file, `${size}x${size}`);
}

fs.mkdirSync(OUT, { recursive: true });
make(192, 'icon-192.png');
make(512, 'icon-512.png');
// Maskable: keep the wordmark inside the safe circle (40% padding on each side).
make(512, 'icon-maskable-512.png', { padding: 0.16 });
console.log('done →', OUT);

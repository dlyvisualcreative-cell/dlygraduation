'use strict';

/**
 * Inline icon library for package benefits.
 *
 * One shared list for BOTH the public benefit list and the admin icon picker, so a
 * benefit's `icon` key can never drift from what the admin was offered.
 * Stroke-based (feather-like) paths, 24×24 viewBox, `currentColor` — no icon font,
 * no external request, and the colour follows CSS.
 */

const ICONS = [
  { key: 'check', label: 'Centang / benefit umum', paths: ['<path d="M20 6 9 17l-5-5"/>'] },
  { key: 'clock', label: 'Durasi sesi', paths: ['<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'] },
  { key: 'map-pin', label: 'Lokasi', paths: ['<path d="M20 10c0 5.5-8 12-8 12s-8-6.5-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.8"/>'] },
  { key: 'image', label: 'Foto hasil edit', paths: ['<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5 3 3L15 12l5 5"/>'] },
  { key: 'images', label: 'Jumlah foto', paths: ['<rect x="7" y="6" width="14" height="14" rx="2.5"/><path d="M17 3H5.5A2.5 2.5 0 0 0 3 5.5V17"/><circle cx="12" cy="11" r="1.4"/><path d="m8 17 3-3 2 2 2.5-2.5L20 18"/>'] },
  { key: 'users', label: 'Jumlah orang', paths: ['<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16.5 5.2a3.4 3.4 0 0 1 0 6.6"/><path d="M18 14.6a6.5 6.5 0 0 1 3.5 5.4"/>'] },
  { key: 'graduation-cap', label: 'Kampus', paths: ['<path d="M12 4 2.5 8.5 12 13l9.5-4.5L12 4Z"/><path d="M6 10.6V16c0 1.9 2.7 3.4 6 3.4s6-1.5 6-3.4v-5.4"/><path d="M21.5 8.5v5"/>'] },
  { key: 'cloud', label: 'File digital / cloud', paths: ['<path d="M17.5 19a4.5 4.5 0 0 0 .3-9 6 6 0 0 0-11.6 1.6A3.9 3.9 0 0 0 7 19h10.5Z"/>'] },
  { key: 'download', label: 'Unduhan file', paths: ['<path d="M12 4v10"/><path d="m8 11 4 4 4-4"/><path d="M4 18.5h16"/>'] },
  { key: 'car', label: 'Transportasi', paths: ['<path d="M4 16.5V12l1.8-5A2 2 0 0 1 7.7 5.6h8.6A2 2 0 0 1 18.2 7L20 12v4.5"/><path d="M4 16.5h16"/><circle cx="7.5" cy="16.8" r="1.7"/><circle cx="16.5" cy="16.8" r="1.7"/><path d="M5.5 12h13"/>'] },
  { key: 'message-circle', label: 'Konsultasi', paths: ['<path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.6A8 8 0 1 1 20.5 11.5Z"/>'] },
  { key: 'shirt', label: 'Outfit / wardrobe', paths: ['<path d="M8.5 3.5 12 6l3.5-2.5 4 2.5-2 4-2-1V20H8V9L6 10 4 6l4.5-2.5Z"/>'] },
  { key: 'camera', label: 'Kamera / fotografi', paths: ['<path d="M3 8.5A2 2 0 0 1 5 6.5h2l1.2-2h7.6L17 6.5h2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5Z"/><circle cx="12" cy="12.8" r="3.3"/>'] },
  { key: 'book-image', label: 'Album cetak', paths: ['<path d="M4 4.5h11.5A2.5 2.5 0 0 1 18 7v13H6.5A2.5 2.5 0 0 1 4 17.5v-13Z"/><path d="M18 20h1.5"/><circle cx="9" cy="9.5" r="1.3"/><path d="m5.5 16 3.5-3.5 2.5 2.5 2-2 4 4"/>'] },
  { key: 'video', label: 'Video', paths: ['<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="m15.5 11 5.5-3v8l-5.5-3v-2Z"/>'] },
  { key: 'calendar', label: 'Jadwal', paths: ['<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/>'] },
  { key: 'sparkles', label: 'Fasilitas tambahan', paths: ['<path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z"/><path d="M18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z"/>'] }
];

const KEYS = ICONS.map((i) => i.key);
const DEFAULT_ICON = 'check';

function isIcon(key) {
  return KEYS.includes(String(key || ''));
}

/** Sanitised icon key — unknown values fall back to the check circle. */
function iconKey(key) {
  return isIcon(key) ? String(key) : DEFAULT_ICON;
}

/**
 * Renders an inline SVG. Every path string above is authored here (never user input),
 * so this output is safe to inject with <%- %>.
 */
function svg(key, className) {
  const icon = ICONS.find((i) => i.key === iconKey(key)) || ICONS[0];
  const cls = className ? ` class="${className}"` : '';
  return `<svg${cls} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"` +
    ` stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
    icon.paths.join('') + '</svg>';
}

module.exports = { ICONS, KEYS, DEFAULT_ICON, isIcon, iconKey, svg };

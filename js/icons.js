// Inline SVG icon set for the console: 24-unit grid, 1.5 stroke, currentColor.
// Loaded before main.js so it can decorate the static chrome (rail links, topbar buttons)
// with icons on boot; views import icon(name) to build their own tool columns.
// No external assets: every glyph is a hand-drawn path so the app stays offline and private.

const PATHS = {
  // ---- views ----
  plan: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 12h8M11 3v9M11 12v9"/><path d="M11 21a6 6 0 0 1 6-6" stroke-dasharray="2 2"/><path d="M17 15v6"/>',
  model: '<path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M12 12 20.5 7M12 12 3.5 7M12 12v9.5"/>',
  materials: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/><path d="m13.5 19 5.5-5.5M15.5 21l5.5-5.5" stroke-width="1"/>',
  photos: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m21 16-5-5-8 8"/>',
  projects: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 11.5 2 2 4-4"/><path d="M8 17h8"/>',
  products: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  budget: '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M14.8 9.6c0-1.3-1.25-2.3-2.8-2.3s-2.8 1-2.8 2.3 1.25 2.3 2.8 2.3 2.8 1 2.8 2.3-1.25 2.3-2.8 2.3-2.8-1-2.8-2.3"/>',
  schedule: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h3M13 14h3M8 17.5h3"/>',
  sheets: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  // ---- topbar ----
  export: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  import: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  demo: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  // ---- 2D tools ----
  select: '<path d="M4 4l7.1 17 2.5-7.4L21 11.1z"/>',
  wall: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9.3h18M3 14.7h18M9 4v5.3M15 9.3v5.4M9 14.7V20"/>',
  door: '<path d="M4 20h16"/><path d="M6 20V6"/><path d="M6 6a14 14 0 0 1 14 14" stroke-dasharray="2.5 2.5"/>',
  window: '<rect x="3" y="7" width="18" height="10" rx="1"/><path d="M3 12h18M3 9.5h18" stroke-width="1"/>',
  room: '<path d="M4 4h10v6h6v10H4z"/><path d="M9 20v-6" stroke-dasharray="2 2"/>',
  calibrate: '<rect x="2" y="8" width="20" height="8" rx="1.5"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>',
  upload: '<path d="M12 17V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/><path d="M4 21h16"/>',
  snap: '<path d="M6 3v7a6 6 0 0 0 12 0V3"/><path d="M4 3h4M16 3h4"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  dims: '<path d="M4 15h16"/><path d="m8 11-4 4 4 4M16 11l4 4-4 4"/><path d="M4 4v5M20 4v5"/>',
  // ---- 3D tools ----
  frame: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3"/>',
  top: '<path d="M12 3v7"/><path d="m8.5 6.5 3.5 3.5 3.5-3.5"/><rect x="3" y="13" width="18" height="8" rx="1.5"/>',
  walk: '<circle cx="13.5" cy="4" r="1.7"/><path d="m8 21 2.6-6.4M14.2 21l-1.8-4.6-2.8-2.5.9-4.5"/><path d="m10.5 7.9 2.4-.9 2.4 2.9 2.7 1.1"/><path d="m10.5 7.9-3 1.6-1 3.5"/>',
  section: '<path d="M3 12h18"/><path d="M6 12V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6"/><path d="M6 12v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6" stroke-dasharray="2.5 2"/>',
  xray: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2" stroke-width="1"/>',
  move: '<path d="M12 2v20M2 12h20"/><path d="m8 6 4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4"/>',
  measure: '<path d="M3 12h18"/><path d="m7 8-4 4 4 4M17 8l4 4-4 4"/><path d="M3 4v4M21 4v4" stroke-width="1"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5"/>',
  pin: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  scan: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><g fill="currentColor" stroke="none"><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="9" cy="15" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="12" cy="8" r=".7"/><circle cx="16" cy="12" r=".7"/><circle cx="8" cy="12" r=".7"/><circle cx="12" cy="16" r=".7"/></g>',
  splat: '<circle cx="9" cy="10" r="4.5"/><circle cx="15.5" cy="13.5" r="3.5"/><circle cx="14" cy="6.5" r="2"/><circle cx="8" cy="17.5" r="1.6"/>',
  // ---- generic ----
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 5.8A10 10 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17 17 0 0 1-2.6 3.4M6.6 6.6C3.6 8.6 2 12 2 12s3.5 6.5 10 6.5c1.5 0 2.9-.3 4.1-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m21 16-5-5-8 8"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  drag: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  north: '<circle cx="12" cy="12" r="9"/><path d="M12 5.5 9 13l3-1.5 3 1.5z" fill="currentColor"/><path d="M12 11.5V18.5" stroke-width="1"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v5h5"/>',
  ruler: '<rect x="2" y="8" width="20" height="8" rx="1.5"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/>',
  'lock': '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};

export const ICON_NAMES = Object.keys(PATHS);

// icon('wall') -> '<svg ...>...</svg>'; icon('wall', { size: 14, cls: 'x' }).
// Unknown names return an empty string so callers never render a broken glyph.
export function icon(name, opts) {
  const body = PATHS[name];
  if (!body) return '';
  const size = (opts && opts.size) || 16;
  const cls = 'ic ic-' + name + ((opts && opts.cls) ? ' ' + opts.cls : '');
  const label = opts && opts.label ? ` role="img" aria-label="${opts.label}"` : ' aria-hidden="true"';
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false"${label}>${body}</svg>`;
}

// Put an icon before the text of a button/link, wrapping the existing text in a label span so
// CSS can hide labels in compact layouts. Idempotent: skips elements that already carry an icon.
export function decorate(elm, name) {
  if (!elm || elm.querySelector('.ic')) return;
  const text = elm.textContent.trim();
  elm.innerHTML = icon(name) + (text ? `<span class="lbl">${text}</span>` : '');
}

// Boot-time decoration of the static chrome in index.html. Every id and data-view is kept; the
// text becomes a label span next to the glyph.
function decorateChrome() {
  document.querySelectorAll('#rail a[data-view]').forEach(a => decorate(a, a.dataset.view));
  document.querySelectorAll('#rail .rail-foot a').forEach(a => decorate(a, 'github'));
  decorate(document.getElementById('btn-save'), 'save');
  decorate(document.getElementById('btn-file'), 'file');
  const add = document.getElementById('property-new');
  if (add && !add.querySelector('.ic')) add.innerHTML = icon('plus');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorateChrome);
  else decorateChrome();
}

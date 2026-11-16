import { escapeHtml, fmtLen } from './store.js';
import { sectionOf, isCrownProfile, crownRelief } from './trim-profiles.js';
import { trimTemplate, trimLayout, setFrameLayout } from './trims.js';

const points = pts => pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

// An oblique cutaway from the same section the model sweeps. Only the sample's
// length is chosen for the drawing; the two axes of the cut share one scale.
export function trimCutaway(p) {
  const crown = isCrownProfile(p.profile);
  const width = escapeHtml(fmtLen(p.W)), depth = escapeHtml(fmtLen(p.T));
  const description = crown ? `${width} drop × ${depth} projection` : `${width} wide × ${depth} thick`;
  const scale = Math.min(57 / p.W, 49 / p.T);
  const h = p.W * scale, w = p.T * scale, x = 65, y = 10 + (57 - h) / 2;
  const cut = sectionOf(p.profile, p.W, p.T).map(([a, d]) => [x + d * scale, y + (crown ? a : p.W - a) * scale]);
  const shift = ([a, b]) => [a + 70, b - 6];
  const sides = [];
  for (let i = 0; i < cut.length; i++) {
    const a = cut[i], b = cut[(i + 1) % cut.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx * 6 + dy * 70 >= 0) continue;
    const light = Math.round(83 - 15 * dx / Math.hypot(dx, dy));
    sides.push(`<polygon fill="hsl(38 12% ${light}%)" points="${points([a, b, shift(b), shift(a)])}"/>`);
  }
  const relief = crown && crownRelief(p.profile, p.W, p.T, 0, 71 / scale);
  const pattern = relief ? relief.contours.map(contour => `<polygon class="tp-prof-relief" points="${points(contour.map(([u, a]) => [x + (relief.front + u) * scale, y + (a - u * 6 / 70) * scale]))}"/>`).join('') : '';
  const midY = y + h / 2, dimY = y + h + 7;
  return `<svg class="tp-prof" viewBox="0 0 192 94" role="img" aria-label="${description}">
    <g class="tp-prof-sides">${sides.join('')}${pattern}</g>
    <polygon class="tp-prof-cut" points="${points(cut)}"/>
    <path class="tp-prof-dims" d="M${x - 7} ${y}h-8m4 0v${h}m-4 0h8 M${x} ${dimY - 3}v6m0 -3h${w}m0 -3v6"/>
    <text x="${x - 18}" y="${midY}" text-anchor="end" dominant-baseline="middle">${width}</text>
    <text x="${x + w / 2}" y="${dimY + 11}" text-anchor="middle">${depth}</text>
  </svg>`;
}

// A small wall elevation using actual layout parts, including split and nested frames.
export function trimElevation(p, layout) {
  const H = 2.44;
  const fieldHeight = layout || p.style === 'full-height-paneling' ? H : 1.25;
  const wall = { id: 'sample', ax: 0, ay: 0, bx: 4, by: 0, height: H };
  const t = trimTemplate(p.style, p.id, wall, 1, { wallHeight: H, y: 0, h: fieldHeight });
  setFrameLayout(t, layout);
  const { parts } = trimLayout(t, wall, []);
  const scaleX = 35, scaleY = 56 / H;
  const shapes = parts.map(part => {
    const x = part.x0 * scaleX, y = (H - part.y1) * scaleY;
    const w = (part.x1 - part.x0) * scaleX, h = (part.y1 - part.y0) * scaleY;
    const dims = `x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"`;
    if (part.kind === 'frame') return `<rect ${dims} class="tp-elevation-frame"/>`;
    const panel = part.profile === 'flat';
    return `<rect ${dims} class="${panel ? 'tp-elevation-panel' : 'tp-elevation-board'}"/>`;
  });
  return `<svg class="tp-elevation" viewBox="-2 -2 144 64" aria-hidden="true">${shapes.join('')}<path d="M0 59h140"/></svg>`;
}

// The same ink geometry for the live preview, saved strokes and exported pictures. There is
// no DOM dependency: the caller supplies its context, coordinate mapping and scale.
import { evenPressure, penWidth, strokeOpacity } from './markups.js';

const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// A quadratic centreline stays inside the sampled points' convex hull, preserving the exact
// first and last samples. Pressure follows the same curve as position, avoiding abrupt width
// steps. `spacing` is in the input's units (normally pixels). The subdivision cap also bounds
// the work for imported strokes with extremely distant points.
export function smoothInkPoints(pts, spacing = 2) {
  const n = Math.floor(pts.length / 3);
  if (n <= 2) return pts.slice(0, n * 3);
  const at = i => pts.slice(i * 3, i * 3 + 3);
  const out = at(0);
  let start = out.slice();
  const step = Number.isFinite(spacing) && spacing > 0 ? spacing : 2;
  for (let i = 1; i < n - 1; i++) {
    const control = at(i), end = mix(control, at(i + 1), 0.5);
    const count = Math.max(1, Math.min(64, Math.ceil((distance(start, control) + distance(control, end)) / step)));
    for (let j = 1; j <= count; j++) {
      const t = j / count;
      out.push(...mix(mix(start, control, t), mix(control, end, t), t));
    }
    start = end;
  }
  out.push(...at(n - 1));
  return out;
}

function roundDisc(ctx, x, y, radius) {
  ctx.moveTo(x + radius, y);
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.closePath();
}

// Draw a single silhouette, so translucent ink has one opacity everywhere within a stroke,
// including bends, pressure changes and crossings. Separate strokes still layer normally.
export function drawStroke(ctx, s, map, unit) {
  const p = s.pts || [], n = Math.floor(p.length / 3);
  if (!n) return;
  const base = Math.max(0.75, s.width * unit), marker = s.tool === 'marker';
  const at = i => map(p[i * 3], p[i * 3 + 1]);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.globalAlpha = strokeOpacity(s);
  if (n === 1) {
    const [x, y] = at(0);
    ctx.beginPath(); roundDisc(ctx, x, y, (marker ? base : penWidth(base, p[2])) / 2); ctx.fill();
  } else if (marker || evenPressure(p)) {
    // Native curves are resolution independent and composite as one path, even where the
    // highlighter crosses itself. Round joins keep sharp turns from producing spikes.
    ctx.lineWidth = marker ? base : penWidth(base, p[2]);
    ctx.beginPath();
    let a = at(0);
    ctx.moveTo(a[0], a[1]);
    for (let i = 1; i < n - 1; i++) {
      const b = at(i), c = at(i + 1);
      ctx.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2);
    }
    a = at(n - 1); ctx.lineTo(a[0], a[1]); ctx.stroke();
  } else {
    const mapped = [];
    for (let i = 0; i < n; i++) mapped.push(...at(i), p[i * 3 + 2]);
    const points = smoothInkPoints(mapped);
    ctx.beginPath();
    let a = null;
    for (let i = 0; i < points.length; i += 3) {
      const b = [points[i], points[i + 1], penWidth(base, points[i + 2]) / 2];
      if (a) {
        const d = distance(a, b);
        if (d > 1e-8) {
          const nx = -(b[1] - a[1]) / d, ny = (b[0] - a[0]) / d;
          // All strips and discs have the same winding. Nonzero fill makes their union,
          // instead of applying translucent paint once for every overlapping segment.
          ctx.moveTo(a[0] + nx * a[2], a[1] + ny * a[2]);
          ctx.lineTo(a[0] - nx * a[2], a[1] - ny * a[2]);
          ctx.lineTo(b[0] - nx * b[2], b[1] - ny * b[2]);
          ctx.lineTo(b[0] + nx * b[2], b[1] + ny * b[2]);
          ctx.closePath();
        }
      }
      roundDisc(ctx, b[0], b[1], b[2]);
      a = b;
    }
    ctx.fill();
  }
  ctx.restore();
}

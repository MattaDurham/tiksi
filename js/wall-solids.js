// Wall pieces around openings, in wall-local coordinates. No three.js here: the 3D view
// and the SketchUp mirror both cut walls from these spans, so they always agree.

// The openings on one wall as spans along it: clamped to the wall, never overlapping an
// earlier opening (the later one gives way), too-narrow leftovers dropped. Solids and trim
// are both cut from these so they always agree.
export function openingSpans(wall, openings, L) {
  const spans = openings
    .filter(o => o.wallId === wall.id)
    .map(o => {
      const w = Math.min(o.width || 0, L);
      const c = Math.min(Math.max((o.t || 0) * L, w / 2), L - w / 2);
      return { s0: Math.max(0, c - w / 2), s1: Math.min(L, c + w / 2), o };
    })
    .sort((a, b) => a.s0 - b.s0);
  const out = [];
  let cursor = 0;
  for (const sp of spans) {
    sp.s0 = Math.max(sp.s0, cursor);
    if (sp.s1 - sp.s0 < 0.05) continue;
    out.push(sp);
    cursor = sp.s1;
  }
  return out;
}

// Solid pieces of one wall in local coords: s along wall [0..L], v vertical [0..H].
export function wallSolids(wall, openings, defaultHeight) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const H = wall.height || defaultHeight;
  if (L < 0.01) return { solids: [], glass: [], L, H };

  const solids = [];
  const glass = [];
  let cursor = 0;
  for (const { s0, s1, o } of openingSpans(wall, openings, L)) {
    if (s0 > cursor + 0.005) solids.push({ s0: cursor, s1: s0, v0: 0, v1: H });
    const top = Math.min((o.type === 'window' ? (o.sill || 0) + o.height : o.height), H);
    if (top < H - 0.01) solids.push({ s0, s1, v0: top, v1: H });          // header
    if (o.type === 'window' && (o.sill || 0) > 0.01) solids.push({ s0, s1, v0: 0, v1: o.sill }); // sill wall below
    if (o.type === 'window') glass.push({ s0, s1, v0: (o.sill || 0), v1: top, id: o.id });
    cursor = s1;
  }
  if (cursor < L - 0.005) solids.push({ s0: cursor, s1: L, v0: 0, v1: H });
  return { solids, glass, L, H };
}

// Physical members from the same layout and finished faces used by MODEL.
import { trimDesign } from './trim-design.js';
import { trimProduct } from './trims.js';
import { catalogItem } from './trim-catalog.js';
import { levelOfWall, wallsOn, roomsOn, openingsOn, wallHeightOf } from './store.js';

function runEnd(position, faceEnd, wallEnd, mitred) {
  if (Math.abs(position - faceEnd) > .0001) return 'square';
  const extension = wallEnd === 0 ? -faceEnd : faceEnd - wallEnd;
  if (extension > .001) return 'outside corner';
  if (extension < -.001) return 'inside corner';
  return mitred ? 'corner' : 'square';
}

export function designPieces(prop, projects, profile = {}) {
  const design = trimDesign({ prop, projects, levelOf: w => levelOfWall(prop,w).id,
    wallsOn: id => wallsOn(prop,id), roomsOn: id => roomsOn(prop,id),
    openingsOn: id => openingsOn(prop,id), heightOf: w => wallHeightOf(prop,w) });
  const pieces = [], warnings = [];
  const names = new Map((profile.rooms || []).map(r => [r.subproject, r.name]));
  for (const section of prop.trims || []) {
    const i = design.info(section), product = trimProduct(section);
    if (!i || !product) { warnings.push('Review the wall or product for ' + (section.name || section.id)); continue; }
    const wall = i.wall, unit = [(wall.bx - wall.ax) / i.L, (wall.by - wall.ay) / i.L];
    const point = x => [wall.ax + unit[0] * x, wall.ay + unit[1] * x];
    const room = names.get(section.projectId) || i.roomName;
    const base = { room, roomKey: names.has(section.projectId) ? section.projectId : i.roomKey,
      section: section.id, project: section.projectId || '', wallId: section.wallId,
      face: section.wallId + '/' + section.side, wallName: (section.name || wall.name || 'Wall').split(':')[0],
      style: section.style, product: product.id, endA:'square', endB:'square' };
    let frame = 0;
    for (const q of design.layout(section).parts) {
      if (q.role === 'backer') { warnings.push(room + ' · Sheet backing needs a separate allowance.'); continue; }
      const width = q.x1 - q.x0, height = q.y1 - q.y0;
      if (q.kind === 'run') {
        pieces.push({...base, kind:'run', len:width, y:q.y, pA:point(q.x0), pB:point(q.x1), u:unit,
          endA:runEnd(q.x0,i.x0,0,q.mitreA), endB:runEnd(q.x1,i.x1,i.L,q.mitreB),
          leftIsA:section.side !== -1});
      } else if (q.kind === 'frame') {
        frame++;
        for (const side of ['top','bottom','left','right']) pieces.push({...base, kind:'frame', frame, side,
          endA:'miter 45°', endB:'miter 45°', len:['top','bottom'].includes(side) ? width : height});
      } else if (q.kind === 'board') {
        const vertical = q.dir === 'v';
        const role = vertical ? 'stile' : height > product.W + .0001 ? 'topRail' : 'bottomRail';
        const part = product.parts ? catalogItem(product.parts[role]) : product;
        if (!part) { warnings.push(room + ' · Missing board for ' + role); continue; }
        pieces.push({...base, product:part.id, kind:vertical ? 'batten' : 'rail', side:role, len:vertical ? height : width});
      }
    }
  }
  return { pieces:pieces.concat(profile.supplement || []), warnings:[...new Set(warnings)] };
}

// An inside joint has one coped end and one square end. A detached return stays a field check.
export function joinedPieces(source) {
  const pieces = source.map(p => ({...p})), ends = [];
  for (const piece of pieces) {
    if (piece.kind !== 'run' || !piece.pA || !piece.pB) continue;
    for (const key of ['endA','endB']) ends.push({piece,key,pt:key === 'endA' ? piece.pA : piece.pB});
  }
  function nearest(a, candidates, limit) {
    let found;
    for (const b of candidates) {
      if (b.piece === a.piece || b.piece.roomKey !== a.piece.roomKey || b.piece.product !== a.piece.product ||
          Math.abs(b.piece.y - a.piece.y) > .01) continue;
      const d = Math.hypot(b.pt[0]-a.pt[0], b.pt[1]-a.pt[1]);
      if (d < limit) { limit = d; found = b; }
    }
    return found;
  }
  for (const a of ends.filter(e => e.piece[e.key] === 'corner')) {
    const b = nearest(a,ends,.3), u = a.piece.u, v = b?.piece.u;
    const adjoining = b?.piece[b.key];
    a.piece[a.key] = v && Math.abs(u[0]*v[0]+u[1]*v[1]) > .99 ? 'joint' :
      ['inside corner','outside corner'].includes(adjoining) ? adjoining : 'check on site';
  }
  const corners = ends.filter(e => e.piece[e.key] === 'inside corner'), used = new Set();
  for (const a of corners) {
    if (used.has(a)) continue;
    const b = nearest(a,corners.filter(e => !used.has(e)),.4);
    if (!b) continue;
    const longer = a.piece.len >= b.piece.len ? a : b;
    longer.piece[longer.key] = 'square into corner';
    used.add(a); used.add(b);
  }
  return pieces;
}

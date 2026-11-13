import { doorDetail, wallSides } from './wall-solids.js';
export function jambWidth(o) {
  return doorDetail(o, o.width || 0.8, o.height || 2.03, false).jambWidth;
}
export function doorDimensions(o, wallWidth=o.width, interior=false) {
  const d = doorDetail(o, wallWidth, o.height || 2.03, interior);
  return { wallWidth, frameClearWidth: wallWidth - 2 * d.jambWidth,
    slabWidth: d.leaves ? d.leafWidth : null, slabHeight: d.leaves ? d.leafHeight : null, leaves: d.leaves };

}
export function wallWidthFromSlab(o, slabWidth, count=doorDimensions(o).leaves) {
  if(!count || !Number.isFinite(slabWidth)||slabWidth<=0) return null;
  return count*slabWidth+2*jambWidth(o)+(count===2?.009:.006);
}

export function openingDimensions(prop, opening) {
  const wall=prop.walls?.find(w=>w.id===opening.wallId);
  const fallback=prop.levels?.[0]?.id;
  const rooms=(prop.rooms || []).filter(r=>(r.level || fallback)===(wall?.level || fallback));
  const sides=wall ? wallSides(wall,rooms) : {};
  return doorDimensions(opening,opening.width,!!(sides.pos && sides.neg));
}

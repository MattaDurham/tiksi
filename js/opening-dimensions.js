import { doorLeaves, wallSides } from './wall-solids.js';
export function jambWidth(o) {
  const v=o.profile?.jambWidth; return Number.isFinite(v) && v>0 && v<=.3 ? v : .05;
}
export function doorDimensions(o, wallWidth=o.width, interior=false) {
  const count=doorLeaves(o,wallWidth,interior), gap=count===2?.009:.006;
  return {wallWidth, frameClearWidth:wallWidth-2*jambWidth(o), slabWidth:count ? (wallWidth-2*jambWidth(o)-gap)/count : null,
    slabHeight:count ? o.height-jambWidth(o)-.012 : null, leaves:count};
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

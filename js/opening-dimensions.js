export function jambWidth(o) {
  const v=o.profile?.jambWidth; return Number.isFinite(v) && v>0 && v<=.3 ? v : .05;
}
export function doorDimensions(o, wallWidth=o.width) {
  const count=o.leaves===2?2:1, gap=count===2?.009:.006;
  return {wallWidth, frameClearWidth:wallWidth-2*jambWidth(o), slabWidth:(wallWidth-2*jambWidth(o)-gap)/count,
    slabHeight:o.height-jambWidth(o)-.012, leaves:count};
}
export function wallWidthFromSlab(o, slabWidth) {
  const count=o.leaves===2?2:1;
  if(!Number.isFinite(slabWidth)||slabWidth<=0) return null;
  return count*slabWidth+2*jambWidth(o)+(count===2?.009:.006);
}

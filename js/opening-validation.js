// Width/height in the plan record describe the hole in the wall, not the door slab.
export function openingProblems(prop, opening) {
  const wall = prop.walls?.find(w => w.id === opening.wallId);
  if (!wall) return ['Missing host wall'];
  const length = Math.hypot(wall.bx-wall.ax, wall.by-wall.ay);
  const interval = o => [o.t*length-o.width/2, o.t*length+o.width/2];
  const [a,b] = interval(opening), problems = [];
  if (![a,b,opening.height].every(Number.isFinite) || opening.width <= 0 || opening.height <= 0) return ['Invalid opening dimensions'];
  if (a < -1e-6 || b > length+1e-6) problems.push('Opening extends beyond its wall');
  const low = o => o.type === 'window' ? o.sill || 0 : 0;
  for (const other of prop.openings || []) {
    if (other.id === opening.id || other.wallId !== wall.id) continue;
    const [c,d] = interval(other);
    if (Math.min(b,d)-Math.max(a,c) > 1e-6 && Math.min(low(opening)+opening.height,low(other)+other.height)-Math.max(low(opening),low(other)) > 1e-6) problems.push('Overlaps opening ' + other.id);
  }
  return problems;
}

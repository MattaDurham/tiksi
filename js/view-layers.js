// View layers shared by PLAN and MODEL. A property's imported scans and models fall into
// three layers: the raw capture (a Polycam mesh, point cloud or splat), furnishings
// (furniture, cabinets, fixtures and appliances modelled as their own file) and any other
// model. A record's own `layer` wins; older records are classified by kind and name.
export const LAYERS = ['scan', 'furnishings', 'model'];
export const LAYER_LABELS = { scan: 'Scan capture', furnishings: 'Furniture & fixtures', model: 'Other model' };

const FURNISHING = /furni|fixture|cabinet|casework|millwork|joinery|appliance|decor/i;
const CAPTURE = /polycam|survey|\bscan|capture|lidar|matterport|point ?cloud|splat/i;

export function scanLayer(scan) {
  if (!scan) return 'model';
  if (LAYERS.includes(scan.layer)) return scan.layer;
  const name = String(scan.name || '');
  if (FURNISHING.test(name)) return 'furnishings';
  if (scan.kind === 'points' || scan.kind === 'splat' || CAPTURE.test(name)) return 'scan';
  return 'model';
}

export function layerScans(prop, layer) {
  return ((prop && prop.scans) || []).filter(s => scanLayer(s) === layer);
}

// Fixtures (fixtures.js) of kind 'furniture' follow the furnishings layer too, through
// prop.env.hideFurniture; built-ins (counter and cabinet runs, appliances, bath) are part of
// the building and always show, like walls.
export const isFurnitureFixture = f => !!f && f.kind === 'furniture';
export function layerFixtures(prop, layer) {
  return layer === 'furnishings' ? ((prop && prop.fixtures) || []).filter(isFurnitureFixture) : [];
}
export function fixtureShown(prop, f) {
  return !isFurnitureFixture(f) || !(prop && prop.env && prop.env.hideFurniture);
}
export function layerHasMembers(prop, layer) {
  return layerScans(prop, layer).length + layerFixtures(prop, layer).length > 0;
}

// A layer reads as shown while any of its records is visible.
export function layerShown(prop, layer) {
  return layerScans(prop, layer).some(s => s.visible !== false) ||
    layerFixtures(prop, layer).some(f => fixtureShown(prop, f));
}

// Show or hide every record in the layer; returns the scan records whose visibility changed
// (furniture fixtures follow prop.env.hideFurniture, set here too).
export function setLayerShown(prop, layer, on) {
  if (layerFixtures(prop, layer).length && prop.env) prop.env.hideFurniture = !on;
  const changed = [];
  for (const s of layerScans(prop, layer)) {
    if ((s.visible !== false) === !!on) continue;
    s.visible = !!on;
    changed.push(s);
  }
  return changed;
}

// Plan footprints of a placed object: one convex outline per mesh in world X/Z (the plan's
// x/y), with the mesh's world height range so the plan can keep only the current storey.
// Specks under `minArea` square metres (chair legs, knobs) are dropped.
export function meshFootprints(root, { minArea = 0.0025 } = {}) {
  const out = [];
  if (!root) return out;
  root.updateMatrixWorld(true);
  root.traverse(mesh => {
    if (!mesh.isMesh || mesh.userData.pickBox || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos || !pos.count) return;
    const e = mesh.matrixWorld.elements, pts = [];
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
      const wx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      const wy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      const wz = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
      if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) continue;
      pts.push([wx, wz]);
      if (wy < y0) y0 = wy;
      if (wy > y1) y1 = wy;
    }
    const hull = convexHull(pts);
    if (hull.length < 3 || polygonArea(hull) < minArea) return;
    out.push({ name: mesh.name || '', pts: hull, y0, y1 });
  });
  return out;
}

// Keep the footprints that stand on a storey: their base sits between just under its floor
// and just under its ceiling.
export function footprintsOnLevel(footprints, elevation, height) {
  return footprints.filter(f => f.y0 >= elevation - 0.15 && f.y0 < elevation + height - 0.1);
}

export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

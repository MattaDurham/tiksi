// Model -> three.js scene generation.
// Plan coordinates are meters, x east / y south (canvas convention).
// World mapping: plan (x, y) -> world (x, z); height is world y.
// Walls become sets of boxes computed around openings (no CSG needed):
// full-height segments between openings, headers above doors/windows, sills below windows.

import * as THREE from 'three';
import { materialById } from './store.js';

const FALLBACK_WALL = '#d8d4cc';
const FALLBACK_FLOOR = '#97999b';

function threeMat(color, opts) {
  return new THREE.MeshStandardMaterial(Object.assign({
    color: new THREE.Color(color),
    roughness: 0.9,
    metalness: 0.02,
  }, opts || {}));
}

// Solid pieces of one wall in local coords: s along wall [0..L], v vertical [0..H].
export function wallSolids(wall, openings, defaultHeight) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const H = wall.height || defaultHeight;
  if (L < 0.01) return { solids: [], glass: [], L, H };

  const ops = openings
    .filter(o => o.wallId === wall.id)
    .map(o => {
      const c = Math.min(Math.max(o.t * L, o.width / 2), L - o.width / 2);
      return { s0: c - o.width / 2, s1: c + o.width / 2, o };
    })
    .filter(x => x.s1 > x.s0 + 0.01 && x.s0 < L)
    .sort((a, b) => a.s0 - b.s0);

  const solids = [];
  const glass = [];
  let cursor = 0;
  for (const { s0, s1, o } of ops) {
    if (s0 > cursor + 0.005) solids.push({ s0: cursor, s1: s0, v0: 0, v1: H });
    const top = Math.min((o.type === 'window' ? (o.sill || 0) + o.height : o.height), H);
    if (top < H - 0.01) solids.push({ s0, s1, v0: top, v1: H });          // header
    if (o.type === 'window' && (o.sill || 0) > 0.01) solids.push({ s0, s1, v0: 0, v1: o.sill }); // sill wall below
    if (o.type === 'window') glass.push({ s0, s1, v0: (o.sill || 0), v1: top, id: o.id });
    cursor = Math.max(cursor, s1);
  }
  if (cursor < L - 0.005) solids.push({ s0: cursor, s1: L, v0: 0, v1: H });
  return { solids, glass, L, H };
}

export function buildWallGroup(wall, openings, property) {
  const { solids, glass, L, H } = wallSolids(wall, openings, property.wallHeight);
  const group = new THREE.Group();
  group.userData = { kind: 'wall', id: wall.id };

  const ux = (wall.bx - wall.ax) / (L || 1);
  const uy = (wall.by - wall.ay) / (L || 1);
  const angle = Math.atan2(uy, ux);
  const th = wall.thickness || 0.114;
  const mat = materialById(wall.material);
  const material = threeMat(mat ? mat.color : FALLBACK_WALL);

  for (const s of solids) {
    const len = s.s1 - s.s0;
    const h = s.v1 - s.v0;
    const geo = new THREE.BoxGeometry(len, h, th);
    const mesh = new THREE.Mesh(geo, material);
    const mid = s.s0 + len / 2;
    mesh.position.set(wall.ax + ux * mid, s.v0 + h / 2, wall.ay + uy * mid);
    mesh.rotation.y = -angle;
    mesh.userData = { kind: 'wall', id: wall.id };
    group.add(mesh);
  }

  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x9fd4e8, transparent: true, opacity: 0.32, roughness: 0.1, metalness: 0.1,
  });
  for (const g of glass) {
    const len = g.s1 - g.s0;
    const h = g.v1 - g.v0;
    if (len <= 0 || h <= 0) continue;
    const geo = new THREE.BoxGeometry(len, h, Math.min(th * 0.3, 0.04));
    const mesh = new THREE.Mesh(geo, glassMaterial);
    const mid = g.s0 + len / 2;
    mesh.position.set(wall.ax + ux * mid, g.v0 + h / 2, wall.ay + uy * mid);
    mesh.rotation.y = -angle;
    mesh.userData = { kind: 'wall', id: wall.id };
    group.add(mesh);
  }
  return group;
}

export function buildRoomFloor(room) {
  if (!room.pts || room.pts.length < 3) return null;
  const shape = new THREE.Shape();
  shape.moveTo(room.pts[0][0], room.pts[0][1]);
  for (let i = 1; i < room.pts.length; i++) shape.lineTo(room.pts[i][0], room.pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
  // Shape lies in XY; rotate so plan-y becomes world-z, extrusion goes down.
  geo.rotateX(Math.PI / 2);
  const mat = materialById(room.material);
  const mesh = new THREE.Mesh(geo, threeMat(mat ? mat.color : FALLBACK_FLOOR, { roughness: 0.85 }));
  mesh.position.y = 0.06;
  mesh.userData = { kind: 'room', id: room.id };
  const group = new THREE.Group();
  group.userData = { kind: 'room', id: room.id };
  group.add(mesh);
  return group;
}

export function buildPropertyGroup(property) {
  const root = new THREE.Group();
  root.name = 'property';
  for (const room of property.rooms) {
    const g = buildRoomFloor(room);
    if (g) root.add(g);
  }
  for (const wall of property.walls) {
    root.add(buildWallGroup(wall, property.openings, property));
  }
  return root;
}

export function modelBounds(property) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const w of property.walls) { eat(w.ax, w.ay); eat(w.bx, w.by); }
  for (const r of property.rooms) for (const [x, y] of r.pts) eat(x, y);
  if (property.plan && property.plan.img) {
    eat(property.plan.offsetX || 0, property.plan.offsetY || 0);
    eat((property.plan.offsetX || 0) + property.plan.imgW * property.plan.mPerPx,
        (property.plan.offsetY || 0) + property.plan.imgH * property.plan.mPerPx);
  }
  if (minX === Infinity) return { minX: -5, minY: -5, maxX: 5, maxY: 5 };
  return { minX, minY, maxX, maxY };
}

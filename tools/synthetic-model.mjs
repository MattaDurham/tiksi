// Synthetic SketchUp-like GLB models for the 3D view's drawing checks. No real project data:
// everything is generated. The output is shaped like the converter's files: every part is its
// own glTF node and mesh with its own copy of one of a few dozen materials, SketchUp tags sit
// in node extras, and (as repeated components will arrive) a repeated part is many nodes that
// share one mesh.
//
//   node tools/synthetic-model.mjs [out.glb] [--components]
//       writes the wine-cellar model, flattened as the converter wrote it until now, or with
//       --components as the components converter writes it (default: the system temporary folder)
//
// The module has no Node imports, so the browser checks import it too.

// ---------- geometry ----------
// A box of w x h x d centred on the origin, each face split seg x seg (2 * seg^2 triangles per face).
export function boxGeometry(w, h, d, seg = 1) {
  const P = [], N = [], U = [], I = [];
  const face = (o, a, b, n) => {   // origin corner o, edge vectors a and b, normal n
    const base = P.length / 3;
    for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
      const s = i / seg, t = j / seg;
      P.push(o[0] + a[0] * s + b[0] * t, o[1] + a[1] * s + b[1] * t, o[2] + a[2] * s + b[2] * t);
      N.push(...n); U.push(s, t);
    }
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const k = base + j * (seg + 1) + i;
      I.push(k, k + 1, k + seg + 2, k, k + seg + 2, k + seg + 1);
    }
  };
  const x = w / 2, y = h / 2, z = d / 2;
  face([-x, -y, z], [w, 0, 0], [0, h, 0], [0, 0, 1]);
  face([x, -y, -z], [-w, 0, 0], [0, h, 0], [0, 0, -1]);
  face([x, -y, z], [0, 0, -d], [0, h, 0], [1, 0, 0]);
  face([-x, -y, -z], [0, 0, d], [0, h, 0], [-1, 0, 0]);
  face([-x, y, z], [w, 0, 0], [0, 0, -d], [0, 1, 0]);
  face([-x, -y, -z], [w, 0, 0], [0, 0, d], [0, -1, 0]);
  return { positions: P, normals: N, uvs: U, indices: I };
}

// A wine bottle lying along +z: a lathe of `around` segments over a 12-point profile
// (about 500 triangles at 24 segments).
export function bottleGeometry(around = 24) {
  const profile = [[0, 0], [0.036, 0], [0.037, 0.01], [0.037, 0.2], [0.034, 0.22], [0.022, 0.24], [0.013, 0.26], [0.0125, 0.3], [0.014, 0.302], [0.014, 0.315], [0.01, 0.318], [0, 0.318]];
  const P = [], N = [], U = [], I = [];
  for (let j = 0; j < profile.length; j++) {
    const [r, z] = profile[j];
    const prev = profile[Math.max(0, j - 1)], next = profile[Math.min(profile.length - 1, j + 1)];
    const dz = next[1] - prev[1], dr = next[0] - prev[0];
    const len = Math.hypot(dz, dr) || 1;
    for (let i = 0; i <= around; i++) {
      const a = (i / around) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      P.push(r * c, r * s, z - 0.16);
      N.push((dz / len) * c, (dz / len) * s, -dr / len);
      U.push(i / around, j / (profile.length - 1));
    }
  }
  for (let j = 0; j < profile.length - 1; j++) for (let i = 0; i < around; i++) {
    const k = j * (around + 1) + i, k2 = k + around + 1;
    I.push(k, k2, k + 1, k + 1, k2, k2 + 1);
  }
  return { positions: P, normals: N, uvs: U, indices: I };
}

// ---------- a tiny PNG (stored deflate, no compression library needed) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function adler32(bytes) { let a = 1, b = 0; for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
export function checkerPng(size = 16, c1 = [150, 102, 60], c2 = [118, 78, 44]) {
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(((x >> 2) + (y >> 1)) % 2 ? c1 : c2, y * (size * 3 + 1) + 1 + x * 3);
  }
  const zlib = new Uint8Array(2 + 5 + raw.length + 4);
  zlib.set([0x78, 0x01, 0x01, raw.length & 0xff, raw.length >> 8, ~raw.length & 0xff, (~raw.length >> 8) & 0xff]);
  zlib.set(raw, 7);
  new DataView(zlib.buffer).setUint32(7 + raw.length, adler32(raw));
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}

// ---------- GLB writer ----------
// looks: [{ name, color: [r,g,b,a], roughness, metalness, textured, unlit, blend, doubleSided }]
// meshes: [{ geometry, look }] (one glTF mesh each; a look becomes a fresh material per mesh,
//   as the converter writes it, unless `sharedMaterial` is set)
// nodes: [{ name, mesh, translation, rotation, scale, tag, extras, children }] under one root
//   node; `children` nest (component instances over shared meshes, as the converter writes them)
// texture: PNG bytes for the textured looks (default: a 16 pixel checker)
export function writeGlb({ looks, meshes, nodes, rootName = 'SketchUp model', texture = null }) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [], accessors = [];
  const view = (bytes, target) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); byteLength += pad; }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    chunks.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };
  const accessor = (array, type, componentType, target, minmax) => {
    const bv = view(array, target), size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    const a = { bufferView: bv, componentType, count: array.length / size, type };
    if (minmax) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < array.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], array[i + k]); max[k] = Math.max(max[k], array[i + k]); }
      a.min = min; a.max = max;
    }
    accessors.push(a);
    return accessors.length - 1;
  };
  const materials = [];
  const material = look => {
    const pbr = { baseColorFactor: look.color, roughnessFactor: look.roughness ?? 0.8, metallicFactor: look.metalness ?? 0 };
    if (look.textured) pbr.baseColorTexture = { index: 0 };
    const m = { name: look.name, pbrMetallicRoughness: pbr };
    if (look.blend) m.alphaMode = 'BLEND';
    if (look.doubleSided) m.doubleSided = true;
    if (look.unlit) m.extensions = { KHR_materials_unlit: {} };
    materials.push(m);
    return materials.length - 1;
  };
  const shared = new Map();
  let triangles = 0;
  const gltfMeshes = meshes.map((m, i) => {
    const g = m.geometry;
    const attributes = {
      POSITION: accessor(new Float32Array(g.positions), 'VEC3', 5126, 34962, true),
      NORMAL: accessor(new Float32Array(g.normals), 'VEC3', 5126, 34962),
      TEXCOORD_0: accessor(new Float32Array(g.uvs), 'VEC2', 5126, 34962),
    };
    const vertexCount = g.positions.length / 3;
    const indices = accessor(vertexCount > 65535 ? new Uint32Array(g.indices) : new Uint16Array(g.indices), 'SCALAR', vertexCount > 65535 ? 5125 : 5123, 34963);
    let mat;
    if (m.sharedMaterial) { if (!shared.has(m.look)) shared.set(m.look, material(looks[m.look])); mat = shared.get(m.look); }
    else mat = material(looks[m.look]);
    m.triangles = g.indices.length / 3;
    return { name: m.name || 'Mesh ' + i, primitives: [{ attributes, indices, material: mat }] };
  });
  const gltfNodes = [{ name: rootName, children: [] }];
  let meshNodes = 0;
  const place = n => {
    const node = { name: n.name };
    gltfNodes.push(node);
    const index = gltfNodes.length - 1;
    if (n.mesh !== undefined) { node.mesh = n.mesh; triangles += meshes[n.mesh].triangles; meshNodes++; }
    if (n.translation) node.translation = n.translation;
    if (n.rotation) node.rotation = n.rotation;
    if (n.scale) node.scale = n.scale;
    if (n.tag || n.extras) node.extras = { ...(n.extras || {}), ...(n.tag ? { sketchupTag: n.tag } : {}) };
    if (n.children && n.children.length) node.children = n.children.map(place);
    return index;
  };
  gltfNodes[0].children = nodes.map(place);
  const usesTexture = looks.some(l => l.textured), usesUnlit = looks.some(l => l.unlit);
  const json = {
    asset: { version: '2.0', generator: 'Tiksi synthetic model' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: gltfNodes, meshes: gltfMeshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  if (usesUnlit) json.extensionsUsed = ['KHR_materials_unlit'];
  if (usesTexture) {
    const png = texture || checkerPng();
    json.images = [{ bufferView: view(png), mimeType: 'image/png' }];
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    json.textures = [{ sampler: 0, source: 0 }];
  }
  const binPad = (4 - (byteLength % 4)) % 4;
  if (binPad) { chunks.push(new Uint8Array(binPad)); byteLength += binPad; }
  json.buffers[0].byteLength = byteLength;
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.length + 8 + byteLength;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  dv.setUint32(o, byteLength, true); dv.setUint32(o + 4, 0x004e4942, true); o += 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { glb: out, stats: { meshNodes, gltfMeshes: meshes.length, materials: materials.length, looks: new Set(meshes.map(m => m.look)).size, triangles } };
}

// ---------- the wine cellar ----------
// Deterministic pseudo-random numbers, so every run writes the same file.
function random(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// About 3,000 meshes over 35 looks plus `bottles` bottles that share one mesh: a 7 x 5 m room
// with racks along the walls and an island, every board its own mesh and material copy.
export function wineCellar({ parts = 3000, looks = 35, bottles = 300, seg = 2 } = {}) {
  const rnd = random(7);
  const L = [];
  for (let i = 0; i < looks; i++) {
    const h = (i * 0.137) % 1, warm = i % 3 === 0;
    const c = warm ? [0.45 + 0.4 * h, 0.28 + 0.2 * h, 0.16 + 0.1 * h] : [0.3 + 0.5 * ((h * 7) % 1), 0.3 + 0.4 * ((h * 3) % 1), 0.3 + 0.5 * ((h * 5) % 1)];
    L.push({ name: 'Look ' + i, color: [...c, 1], roughness: 0.4 + 0.5 * ((i * 0.31) % 1), metalness: i % 11 === 5 ? 0.8 : 0, textured: i < 3, doubleSided: i % 4 === 1 });
  }
  L[looks - 1] = { name: 'Glass', color: [0.7, 0.8, 0.85, 0.3], roughness: 0.05, metalness: 0, blend: true };
  const bottleLook = L.length;
  L.push({ name: 'Bottle glass', color: [0.08, 0.2, 0.1, 1], roughness: 0.15, metalness: 0 });
  const meshes = [], nodes = [];
  const part = (name, w, h, d, at, look, tag, mirrored = false) => {
    meshes.push({ geometry: boxGeometry(w, h, d, seg), look });
    nodes.push({ name, mesh: meshes.length - 1, translation: at, ...(mirrored ? { scale: [-1, 1, 1] } : {}), tag });
  };
  // Shell: floor, ceiling, four walls.
  part('Floor', 7, 0.05, 5, [0, -0.025, 0], 1, 'Floor');
  part('Ceiling', 7, 0.05, 5, [0, 2.625, 0], 2, 'Ceiling');
  part('Wall south', 7, 2.6, 0.1, [0, 1.3, 2.55], 3, 'Walls');
  part('Wall north', 7, 2.6, 0.1, [0, 1.3, -2.55], 3, 'Walls');
  part('Wall east', 0.1, 2.6, 5, [3.55, 1.3, 0], 4, 'Walls');
  part('Wall west', 0.1, 2.6, 5, [-3.55, 1.3, 0], 4, 'Walls');
  // Racks: uprights, shelves and slats, 0.9 m wide, round the walls and an island.
  const racks = [];
  for (let i = 0; i < 7; i++) racks.push({ x: -3.0 + i * 1.0, z: -2.3, rot: 0 });
  for (let i = 0; i < 7; i++) racks.push({ x: -3.0 + i * 1.0, z: 2.3, rot: Math.PI });
  for (let i = 0; i < 4; i++) racks.push({ x: -3.3, z: -1.5 + i * 1.0, rot: Math.PI / 2 });
  for (let i = 0; i < 4; i++) racks.push({ x: 3.3, z: -1.5 + i * 1.0, rot: -Math.PI / 2 });
  for (let i = 0; i < 3; i++) racks.push({ x: -1 + i * 1.0, z: 0, rot: 0 });
  const shelvesAt = racks.map(() => []);
  let r = 0, board = 0;
  while (meshes.length < parts - 30) {
    const rack = racks[r % racks.length], ri = r % racks.length, k = Math.floor(r / racks.length);
    const look = 5 + Math.floor(rnd() * (looks - 6));
    const c = Math.cos(rack.rot), s = Math.sin(rack.rot);
    const at = (lx, y, lz) => [rack.x + lx * c + lz * s, y, rack.z - lx * s + lz * c];
    const kind = k % 4;
    const mirrored = ri % 5 === 2;
    if (kind === 0) part('Rack ' + ri + ' upright ' + k, rack.rot % Math.PI ? 0.3 : 0.04, 2.2, rack.rot % Math.PI ? 0.04 : 0.3, at(-0.45 + ((k / 4) % 10) * 0.1, 1.1, 0), look, 'Racks', mirrored);
    else if (kind === 1) { const y = 0.15 + ((k >> 2) % 12) * 0.18; part('Rack ' + ri + ' shelf ' + k, rack.rot % Math.PI ? 0.32 : 0.9, 0.02, rack.rot % Math.PI ? 0.9 : 0.32, at(0, y, 0), look, 'Racks', mirrored); shelvesAt[ri].push(y); }
    else if (kind === 2) part('Rack ' + ri + ' slat ' + k, rack.rot % Math.PI ? 0.02 : 0.88, 0.04, rack.rot % Math.PI ? 0.88 : 0.02, at(0, 0.2 + ((k >> 2) % 12) * 0.18, 0.15), look, 'Racks', mirrored);
    else part('Trim ' + board, 0.05, 0.05, 0.05, at(-0.45 + (k % 18) * 0.05, 2.25, 0.16), 5 + (k % 6), 'Trim');
    r++; board++;
  }
  // Light fittings and the cellar door's glass.
  while (meshes.length < parts) { const i = meshes.length; part('Glass pane ' + i, 0.3, 0.6, 0.01, [-3 + (i % 30) * 0.2, 1.2, 2.49], looks - 1, 'Glass'); }
  // One bottle mesh, many nodes (component instances).
  meshes.push({ geometry: bottleGeometry(24), look: bottleLook, sharedMaterial: true, name: 'Bottle' });
  const bottleMesh = meshes.length - 1;
  for (let i = 0; i < bottles; i++) {
    const ri = i % racks.length, rack = racks[ri];
    const ys = shelvesAt[ri].length ? shelvesAt[ri] : [0.5];
    const y = ys[Math.floor(i / racks.length) % ys.length] + 0.05;
    const lx = -0.4 + ((Math.floor(i / racks.length) * 7) % 9) * 0.1;
    const c = Math.cos(rack.rot), s = Math.sin(rack.rot);
    const q = [0, Math.sin(rack.rot / 2), 0, Math.cos(rack.rot / 2)];
    nodes.push({ name: 'Bottle ' + i, mesh: bottleMesh, translation: [rack.x + lx * c, y, rack.z - lx * s], rotation: q, tag: 'Bottles' });
  }
  return writeGlb({ looks: L, meshes, nodes });
}

// The same cellar as the materials branch's converter writes it: one material per look, each
// component definition's meshes written once, and every instance its own node tree over those
// shared meshes (instance node > mesh nodes, and nested instances for components inside
// components), with the definition and instance named in the node extras. 22 racks are
// instances of one rack definition (its boards shared by every rack); each rack holds nested
// bottle instances, about 300 in all, over one bottle mesh.
export function componentCellar({ boards = 120, looks = 35, racks = 22, bottlesPerRack = 14, seg = 2 } = {}) {
  const rnd = random(11);
  const L = [];
  for (let i = 0; i < looks; i++) {
    const h = (i * 0.137) % 1;
    L.push({ name: 'Look ' + i, color: [0.3 + 0.5 * ((h * 7) % 1), 0.3 + 0.4 * ((h * 3) % 1), 0.3 + 0.5 * ((h * 5) % 1), 1], roughness: 0.4 + 0.5 * ((i * 0.31) % 1), textured: i < 3, doubleSided: i % 4 === 1 });
  }
  const bottleLook = L.length;
  L.push({ name: 'Bottle glass', color: [0.08, 0.2, 0.1, 1], roughness: 0.15 });
  const meshes = [], nodes = [];
  const mesh = (geometry, look, name) => { meshes.push({ geometry, look, sharedMaterial: true, name }); return meshes.length - 1; };
  // Unique geometry (SketchUp groups): the room shell.
  const shell = [['Floor', 7, 0.05, 5, [0, -0.025, 0], 1], ['Wall north', 7, 2.6, 0.1, [0, 1.3, -2.55], 3], ['Wall east', 0.1, 2.6, 5, [3.55, 1.3, 0], 4], ['Wall west', 0.1, 2.6, 5, [-3.55, 1.3, 0], 4]];
  nodes.push({ name: 'Shell', tag: 'Walls', children: shell.map(([name, w, h, d, at, look]) => ({ name, mesh: mesh(boxGeometry(w, h, d, seg), look), translation: at })) });
  // The bottle definition and the rack definition (its boards, and bottle instances inside it).
  const bottleMesh = mesh(bottleGeometry(24), bottleLook, 'Bottle');
  const boardMeshes = [];
  for (let i = 0; i < boards; i++) {
    const kind = i % 3, look = 5 + Math.floor(rnd() * (looks - 6));
    const size = kind === 0 ? [0.04, 2.2, 0.3] : kind === 1 ? [0.9, 0.02, 0.32] : [0.88, 0.04, 0.02];
    const at = kind === 0 ? [-0.45 + (i % 10) * 0.1, 1.1, 0] : [0, 0.15 + (i % 12) * 0.18, kind === 2 ? 0.15 : 0];
    boardMeshes.push({ mesh: mesh(boxGeometry(...size, seg), look), at });
  }
  const rackPlaces = [];
  for (let i = 0; i < 8; i++) rackPlaces.push([-3.0 + i * 0.85, -2.3, 0]);
  for (let i = 0; i < 8; i++) rackPlaces.push([-3.0 + i * 0.85, 2.3, Math.PI]);
  for (let i = 0; i < 6; i++) rackPlaces.push([-1.5 + i * 0.6, 0, i % 2 ? Math.PI : 0]);
  let instance = 0;
  for (let r = 0; r < Math.min(racks, rackPlaces.length); r++) {
    const [x, z, rot] = rackPlaces[r];
    const children = boardMeshes.map((b, i) => ({ name: 'Board ' + i, mesh: b.mesh, translation: b.at }));
    for (let k = 0; k < bottlesPerRack; k++) children.push({
      name: 'Bottle', translation: [-0.4 + (k % 7) * 0.13, 0.2 + Math.floor(k / 7) * 0.36, 0.02],
      extras: { sketchupComponent: 'Bottle', sketchupDefinitionId: 'def-bottle', sketchupInstance: 'inst-' + (instance++) },
      tag: 'Bottles', children: [{ name: 'Bottle glass', mesh: bottleMesh }],
    });
    nodes.push({
      name: 'Rack ' + r, translation: [x, 0, z], rotation: [0, Math.sin(rot / 2), 0, Math.cos(rot / 2)], ...(r % 5 === 2 ? { scale: [-1, 1, 1] } : {}),
      extras: { sketchupComponent: 'Wine rack', sketchupDefinitionId: 'def-rack', sketchupInstance: 'inst-' + (instance++) }, tag: 'Racks', children,
    });
  }
  return writeGlb({ looks: L, meshes, nodes });
}

// ---------- command line ----------
if (typeof process !== 'undefined' && process.argv && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname, resolve, join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const components = process.argv.includes('--components');
  const named = process.argv.slice(2).filter(a => !a.startsWith('--'))[0];
  const out = resolve(named || join(tmpdir(), components ? 'tiksi-wine-cellar-components.glb' : 'tiksi-wine-cellar.glb'));
  const { glb, stats } = components ? componentCellar() : wineCellar();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, glb);
  console.log(out, (glb.length / 1e6).toFixed(1) + ' MB', JSON.stringify(stats));
}

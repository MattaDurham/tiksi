// 3D model view: generated from the plan, manually editable.
// Select walls/rooms, edit dimensions and materials, move walls with a gizmo,
// import lidar scans (PLY point clouds, OBJ, GLB/GLTF) as reference geometry.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
  ws, activeProperty, uid, touch, fmtLen, parseLen, fmtArea, polyArea,
  escapeHtml, putFile, getFile, deleteFile, itemById,
} from './store.js';
import { materialSelectHtml } from './materials.js';
import { buildPropertyGroup, modelBounds } from './geometry.js';

let el = null, wrapEl = null, inspEl = null, hintEl = null;
let renderer = null, scene = null, camera = null, controls = null, gizmo = null;
let modelGroup = null, scanRoot = null;
let raf = 0;
let prop = null;
let selection = null;      // {kind:'wall'|'room'|'scan', id}
let moveMode = false;
let xray = false;
const raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 0.08 };
const scanCache = {};      // scanId -> THREE.Object3D

function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

// ---------- scene setup ----------
function setupScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0c1013');
  scene.fog = new THREE.Fog('#0c1013', 60, 140);

  camera = new THREE.PerspectiveCamera(52, 1, 0.05, 500);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(dpr());
  wrapEl.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;

  const hemi = new THREE.HemisphereLight(0xdfeaf2, 0x2a2f36, 1.05);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(12, 18, 8);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xa8c0d8, 0.5);
  dir2.position.set(-10, 10, -12);
  scene.add(dir2);

  const grid = new THREE.GridHelper(60, 60, 0x2e3c48, 0x1a2229);
  grid.position.y = -0.001;
  scene.add(grid);

  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode('translate');
  gizmo.showY = false;
  gizmo.addEventListener('dragging-changed', e => {
    controls.enabled = !e.value;
    if (!e.value) commitGizmoMove();
  });
  scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
}

function frameModel() {
  const b = modelBounds(prop);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 6);
  camera.position.set(cx + span * 0.75, span * 0.72, cz + span * 0.95);
  controls.target.set(cx, 1, cz);
  controls.update();
}

function rebuildModel() {
  if (modelGroup) { scene.remove(modelGroup); disposeDeep(modelGroup); }
  modelGroup = buildPropertyGroup(prop);
  if (xray) applyXray(modelGroup);
  scene.add(modelGroup);
  reattachGizmo();
}

function disposeDeep(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { Array.isArray(o.material) ? o.material.forEach(m => m.dispose()) : o.material.dispose(); }
  });
}

function applyXray(group) {
  group.traverse(o => {
    if (o.isMesh && o.material) {
      o.material.transparent = true;
      o.material.opacity = 0.35;
      o.material.depthWrite = false;
    }
  });
}

// ---------- selection ----------
function findGroupFor(kind, id) {
  let found = null;
  modelGroup && modelGroup.traverse(o => {
    if (!found && o.userData && o.userData.kind === kind && o.userData.id === id && o.type === 'Group') found = o;
  });
  return found;
}

function setSelection(sel) {
  selection = sel;
  highlight();
  reattachGizmo();
  renderInspector();
}

function highlight() {
  if (!modelGroup) return;
  modelGroup.traverse(o => {
    if (o.isMesh && o.material && o.material.emissive) {
      const hit = selection && o.userData && o.userData.id === selection.id;
      o.material.emissive = new THREE.Color(hit ? '#7a4a12' : '#000000');
    }
  });
  if (scanRoot) scanRoot.traverse(o => {
    if (o.userData && o.userData.kind === 'scan' && o.userData.axes) {
      o.userData.axes.visible = !!(selection && selection.kind === 'scan' && selection.id === o.userData.id);
    }
  });
}

function reattachGizmo() {
  gizmo.detach();
  if (moveMode && selection && selection.kind === 'wall') {
    const g = findGroupFor('wall', selection.id);
    if (g) gizmo.attach(g);
  }
}

function commitGizmoMove() {
  const obj = gizmo.object;
  if (!obj || !selection || selection.kind !== 'wall') return;
  const dx = obj.position.x, dz = obj.position.z;
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
  const w = prop.walls.find(w => w.id === selection.id);
  if (!w) return;
  const r = v => Math.round(v * 200) / 200;
  w.ax = r(w.ax + dx); w.ay = r(w.ay + dz);
  w.bx = r(w.bx + dx); w.by = r(w.by + dz);
  obj.position.set(0, 0, 0);
  touch();
  rebuildModel();
  renderInspector();
}

function onClick(e) {
  if (gizmo.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const p = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(p, camera);
  const targets = [];
  if (modelGroup) targets.push(modelGroup);
  if (scanRoot) targets.push(scanRoot);
  const hits = raycaster.intersectObjects(targets, true);
  for (const h of hits) {
    let o = h.object;
    while (o && (!o.userData || !o.userData.kind)) o = o.parent;
    if (o && o.userData.kind) { setSelection({ kind: o.userData.kind, id: o.userData.id }); return; }
  }
  setSelection(null);
}

// ---------- scans ----------
async function importScanFile(file) {
  if (!file) return;
  const name = file.name;
  const ext = name.split('.').pop().toLowerCase();
  if (!['ply', 'obj', 'glb', 'gltf'].includes(ext)) {
    alert('Supported scan formats: PLY (point cloud), OBJ, GLB/GLTF.\nMost phone lidar apps (Polycam, Scaniverse, 3d Scanner App) export at least one of these.\nE57/LAS support is on the roadmap.');
    return;
  }
  const buffer = await file.arrayBuffer();
  const id = uid('scan');
  await putFile(id, buffer, { name, format: ext });
  const scan = { id, name, format: ext, pos: [0, 0, 0], rotY: 0, scale: 1, visible: true, pointSize: 0.012 };
  prop.scans.push(scan);
  touch();
  await addScanToScene(scan);
  setSelection({ kind: 'scan', id });
}

async function loadScanObject(scan) {
  if (scanCache[scan.id]) return scanCache[scan.id];
  const rec = await getFile(scan.id);
  if (!rec) return null;
  const buffer = rec.buffer;
  let obj = null;
  try {
    if (scan.format === 'ply') {
      const geo = new PLYLoader().parse(buffer);
      const hasColor = !!geo.getAttribute('color');
      if (geo.getIndex() && geo.getIndex().count > 0) {
        // Meshed PLY.
        geo.computeVertexNormals();
        obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: hasColor ? 0xffffff : 0x8fb0c4, vertexColors: hasColor, roughness: 0.95,
        }));
      } else {
        obj = new THREE.Points(geo, new THREE.PointsMaterial({
          size: scan.pointSize || 0.012, vertexColors: hasColor, color: hasColor ? 0xffffff : 0x5fb3c9, sizeAttenuation: true,
        }));
      }
    } else if (scan.format === 'obj') {
      const text = new TextDecoder().decode(buffer);
      obj = new OBJLoader().parse(text);
      obj.traverse(o => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0x9db4c4, roughness: 0.95 }); });
    } else {
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      obj = gltf.scene;
    }
  } catch (err) {
    console.error('scan parse failed', err);
    alert('Could not parse ' + scan.name + ': ' + err.message);
    return null;
  }
  const wrapper = new THREE.Group();
  wrapper.add(obj);
  const axes = new THREE.AxesHelper(0.8);
  axes.visible = false;
  wrapper.add(axes);
  wrapper.userData = { kind: 'scan', id: scan.id, axes };
  scanCache[scan.id] = wrapper;
  return wrapper;
}

async function addScanToScene(scan) {
  const obj = await loadScanObject(scan);
  if (!obj) return;
  applyScanTransform(scan, obj);
  scanRoot.add(obj);
}

function applyScanTransform(scan, obj) {
  obj = obj || scanCache[scan.id];
  if (!obj) return;
  obj.position.set(scan.pos[0], scan.pos[1], scan.pos[2]);
  obj.rotation.set(0, (scan.rotY || 0) * Math.PI / 180, 0);
  obj.scale.setScalar(scan.scale || 1);
  obj.visible = scan.visible !== false;
  obj.traverse(o => { if (o.isPoints) o.material.size = scan.pointSize || 0.012; });
}

async function loadAllScans() {
  for (const scan of prop.scans) await addScanToScene(scan);
}

function dropScanToFloor(scan) {
  const obj = scanCache[scan.id];
  if (!obj) return;
  const box = new THREE.Box3().setFromObject(obj);
  if (!isFinite(box.min.y)) return;
  scan.pos[1] = (scan.pos[1] || 0) - box.min.y;
  applyScanTransform(scan);
  touch();
  renderInspector();
}

// ---------- inspector ----------
function scopeAssignHtml(elementId) {
  let current = '';
  for (const pr of ws.data.projects) for (const it of pr.items) if ((it.elementIds || []).includes(elementId)) current = it.id;
  const groups = ws.data.projects.map(pr => {
    const opts = pr.items.map(it => `<option value="${it.id}" ${it.id === current ? 'selected' : ''}>${escapeHtml(it.name)}</option>`).join('');
    return opts ? `<optgroup label="${escapeHtml(pr.name)}">${opts}</optgroup>` : '';
  }).join('');
  return `<div class="field"><label>Scope item (digital twin link)</label>
    <select data-assign="${elementId}"><option value="">(not assigned)</option>${groups}</select></div>`;
}

function linkedProductsHtml(elementId) {
  const linked = [];
  for (const pr of ws.data.projects) for (const it of pr.items) {
    if ((it.elementIds || []).includes(elementId)) {
      for (const prod of ws.data.products) if ((prod.itemIds || []).includes(it.id)) linked.push(prod);
    }
  }
  if (!linked.length) return '';
  return `<div class="field"><label>Products via scope</label>` +
    linked.map(p => `<div class="stat-line"><span>${escapeHtml(p.name)}</span><b>${p.price ? '$' + Math.round(p.price).toLocaleString() : ''}</b></div>`).join('') + `</div>`;
}

function renderInspector() {
  if (!inspEl) return;
  if (!selection) {
    inspEl.innerHTML = `<h3>MODEL</h3>
      <div class="stat-line"><span>Walls</span><b>${prop.walls.length}</b></div>
      <div class="stat-line"><span>Rooms</span><b>${prop.rooms.length}</b></div>
      <div class="stat-line"><span>Scans</span><b>${prop.scans.length}</b></div>
      <div class="empty" style="margin-top:12px">
        Click a wall or floor to inspect and edit it.<br><br>
        The model regenerates from the plan; edits here write back to the same data.<br><br>
        Drag to orbit, right-drag to pan, scroll to zoom.</div>`;
    return;
  }
  if (selection.kind === 'wall') {
    const w = prop.walls.find(w => w.id === selection.id);
    if (!w) { selection = null; return renderInspector(); }
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    const h = w.height || prop.wallHeight;
    inspEl.innerHTML = `<h3>WALL</h3>
      <div class="stat-line"><span>Length</span><b>${fmtLen(L)}</b></div>
      <div class="stat-line"><span>Face area</span><b>${fmtArea(L * h)}</b></div>
      <div class="field"><label>Thickness</label><input type="text" data-th value="${escapeHtml(fmtLen(w.thickness))}"></div>
      <div class="field"><label>Height (blank = default)</label><input type="text" data-h value="${w.height ? escapeHtml(fmtLen(w.height)) : ''}" placeholder="${escapeHtml(fmtLen(prop.wallHeight))}"></div>
      <div class="field"><label>Material</label>${materialSelectHtml('wall', w.material, 'data-mat')}</div>
      ${scopeAssignHtml(w.id)}
      ${linkedProductsHtml(w.id)}
      <div class="empty" style="margin:8px 0">MOVE mode: drag the gizmo arrows to slide this wall in plan; release to commit.</div>
      <button class="btn danger" data-del>DELETE WALL</button>`;
    inspEl.querySelector('[data-th]').onchange = e => {
      const v = parseLen(e.target.value);
      if (!isNaN(v) && v > 0.02 && v < 1) { w.thickness = v; touch(); rebuildModel(); }
      renderInspector();
    };
    inspEl.querySelector('[data-h]').onchange = e => {
      if (!e.target.value.trim()) w.height = null;
      else { const v = parseLen(e.target.value); if (!isNaN(v) && v > 0.3) w.height = v; }
      touch(); rebuildModel(); renderInspector();
    };
    inspEl.querySelector('[data-mat]').onchange = e => { w.material = e.target.value || null; touch(); rebuildModel(); highlight(); };
    inspEl.querySelector('[data-del]').onclick = () => {
      prop.walls = prop.walls.filter(x => x.id !== w.id);
      prop.openings = prop.openings.filter(o => o.wallId !== w.id);
      setSelection(null);
      touch(); rebuildModel();
    };
    bindAssign(inspEl);
    return;
  }
  if (selection.kind === 'room') {
    const r = prop.rooms.find(r => r.id === selection.id);
    if (!r) { selection = null; return renderInspector(); }
    inspEl.innerHTML = `<h3>ROOM / FLOOR</h3>
      <div class="field"><label>Name</label><input type="text" data-name value="${escapeHtml(r.name || '')}"></div>
      <div class="stat-line"><span>Area</span><b>${fmtArea(polyArea(r.pts))}</b></div>
      <div class="field"><label>Floor material</label>${materialSelectHtml('floor', r.material, 'data-mat')}</div>
      ${scopeAssignHtml(r.id)}
      ${linkedProductsHtml(r.id)}`;
    inspEl.querySelector('[data-name]').onchange = e => { r.name = e.target.value; touch(); };
    inspEl.querySelector('[data-mat]').onchange = e => { r.material = e.target.value || null; touch(); rebuildModel(); highlight(); };
    bindAssign(inspEl);
    return;
  }
  if (selection.kind === 'scan') {
    const s = prop.scans.find(s => s.id === selection.id);
    if (!s) { selection = null; return renderInspector(); }
    inspEl.innerHTML = `<h3>SCAN</h3>
      <div class="stat-line"><span>File</span><b>${escapeHtml(s.name)}</b></div>
      <div class="field-row">
        <div class="field"><label>X</label><input type="number" step="0.1" data-px value="${s.pos[0]}"></div>
        <div class="field"><label>Y (up)</label><input type="number" step="0.1" data-py value="${s.pos[1]}"></div>
        <div class="field"><label>Z</label><input type="number" step="0.1" data-pz value="${s.pos[2]}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Rotate (deg)</label><input type="number" step="5" data-rot value="${s.rotY || 0}"></div>
        <div class="field"><label>Scale</label><input type="number" step="0.05" data-scale value="${s.scale || 1}"></div>
      </div>
      <div class="field"><label>Point size</label><input type="range" min="0.003" max="0.06" step="0.001" value="${s.pointSize || 0.012}" data-ps></div>
      <label class="tool-check"><input type="checkbox" ${s.visible !== false ? 'checked' : ''} data-vis> VISIBLE</label>
      <button class="btn" data-floor>DROP TO FLOOR</button>
      <button class="btn danger" data-del>DELETE SCAN</button>`;
    const upd = () => { applyScanTransform(s); touch(); };
    inspEl.querySelector('[data-px]').onchange = e => { s.pos[0] = parseFloat(e.target.value) || 0; upd(); };
    inspEl.querySelector('[data-py]').onchange = e => { s.pos[1] = parseFloat(e.target.value) || 0; upd(); };
    inspEl.querySelector('[data-pz]').onchange = e => { s.pos[2] = parseFloat(e.target.value) || 0; upd(); };
    inspEl.querySelector('[data-rot]').onchange = e => { s.rotY = parseFloat(e.target.value) || 0; upd(); };
    inspEl.querySelector('[data-scale]').onchange = e => { s.scale = parseFloat(e.target.value) || 1; upd(); };
    inspEl.querySelector('[data-ps]').oninput = e => { s.pointSize = parseFloat(e.target.value); upd(); };
    inspEl.querySelector('[data-vis]').onchange = e => { s.visible = e.target.checked; upd(); };
    inspEl.querySelector('[data-floor]').onclick = () => dropScanToFloor(s);
    inspEl.querySelector('[data-del]').onclick = async () => {
      prop.scans = prop.scans.filter(x => x.id !== s.id);
      const obj = scanCache[s.id];
      if (obj) { scanRoot.remove(obj); disposeDeep(obj); delete scanCache[s.id]; }
      await deleteFile(s.id);
      setSelection(null);
      touch();
    };
    return;
  }
}

function bindAssign(root) {
  root.querySelectorAll('[data-assign]').forEach(sel => {
    sel.onchange = () => {
      const elId = sel.dataset.assign;
      for (const pr of ws.data.projects) for (const it of pr.items) {
        it.elementIds = (it.elementIds || []).filter(x => x !== elId);
      }
      if (sel.value) {
        const found = itemById(sel.value);
        if (found) (found.item.elementIds = found.item.elementIds || []).push(elId);
      }
      touch();
    };
  });
}

// ---------- toolbar ----------
function renderToolCol() {
  const tc = el.querySelector('.tool-col');
  tc.innerHTML = `
    <div class="tool-head">MODEL</div>
    <button class="tool-btn" data-act="frame">FRAME VIEW</button>
    <button class="tool-btn" data-act="top">TOP VIEW</button>
    <button class="tool-btn ${moveMode ? 'active' : ''}" data-act="move">MOVE WALLS</button>
    <button class="tool-btn ${xray ? 'active' : ''}" data-act="xray">X-RAY</button>
    <div class="tool-sep"></div>
    <div class="tool-head">SCANS</div>
    <button class="tool-btn" data-act="scan">IMPORT SCAN</button>
    <input type="file" class="hidden-file" accept=".ply,.obj,.glb,.gltf">
    <div class="empty" style="padding:6px 8px; font-size:9.5px; color:var(--faint); font-family:var(--mono); line-height:1.5">
      PLY / OBJ / GLB from any phone lidar app (Polycam, Scaniverse).</div>
    <div class="tool-sep"></div>
    <button class="tool-btn" data-act="rebuild">REGENERATE</button>
  `;
  tc.querySelector('[data-act=frame]').onclick = frameModel;
  tc.querySelector('[data-act=top]').onclick = () => {
    const b = modelBounds(prop);
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 6);
    camera.position.set(cx, span * 1.4, cz + 0.001);
    controls.target.set(cx, 0, cz);
    controls.update();
  };
  tc.querySelector('[data-act=move]').onclick = () => { moveMode = !moveMode; renderToolCol(); reattachGizmo(); };
  tc.querySelector('[data-act=xray]').onclick = () => { xray = !xray; renderToolCol(); rebuildModel(); highlight(); };
  const file = tc.querySelector('input[type=file]');
  tc.querySelector('[data-act=scan]').onclick = () => file.click();
  file.onchange = () => { importScanFile(file.files[0]); file.value = ''; };
  tc.querySelector('[data-act=rebuild]').onclick = () => { rebuildModel(); highlight(); };
}

// ---------- mount ----------
export function mount(root) {
  prop = activeProperty();
  el = root;
  if (!prop) {
    root.innerHTML = `<div class="view-scroll"><div class="kicker">MODEL</div>
      <p class="muted">No property yet. Create one from the PROPERTY selector in the top bar.</p></div>`;
    return;
  }
  root.innerHTML = `
    <div class="editor-layout">
      <div class="tool-col"></div>
      <div class="canvas-wrap">
        <div class="canvas-hint">Generated from the plan. Click elements to edit; MOVE WALLS for the drag gizmo; X-RAY to align scans.</div>
      </div>
      <div class="inspector"></div>
    </div>`;
  wrapEl = root.querySelector('.canvas-wrap');
  inspEl = root.querySelector('.inspector');

  setupScene();
  rebuildModel();
  scanRoot = new THREE.Group();
  scene.add(scanRoot);
  loadAllScans();
  frameModel();
  renderToolCol();
  renderInspector();

  renderer.domElement.addEventListener('click', onClick);

  const resize = () => {
    const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);
  el._resize = resize;

  const loop = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}

export function unmount() {
  cancelAnimationFrame(raf);
  if (el && el._resize) window.removeEventListener('resize', el._resize);
  if (gizmo) gizmo.detach();
  if (modelGroup) disposeDeep(modelGroup);
  for (const id of Object.keys(scanCache)) { disposeDeep(scanCache[id]); delete scanCache[id]; }
  if (renderer) { renderer.dispose(); renderer.domElement.remove(); }
  renderer = null; scene = null; camera = null; controls = null; gizmo = null;
  modelGroup = null; scanRoot = null; el = null; inspEl = null;
  selection = null;
}

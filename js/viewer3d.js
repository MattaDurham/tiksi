// 3D model view: a rendering, not a debug scene.
// Physically based sun + sky with soft shadows, image-based lighting, ambient occlusion,
// bloom and SMAA through one persistent WebGL context; orbit / walk / top / section camera
// modes; selection and hover outlines; measure and photo-pin tools; notes pinned with a
// right-click; point clouds, meshes and Gaussian splats as reference scans; a still-image renderer.

import { environmentSun, dayOfYear, dateForDay, daysInYear, validTimeZone } from './solar.js';
import { setModelXray } from './model-xray.js';
import * as THREE from 'three';
import { modelTakeoff, createModelEstimate } from './model-takeoff.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import {
  ws, activeProperty, defaultEnv, uid, touch, fmtLen, parseLen, fmtArea, polyArea,
  escapeHtml, deleteFile, getFile, itemById, materialById, isoToday, projectLabel,
  ensureLevels, wallsOn, roomsOn, wallHeightOf, levelOfWall, levelOfRoom, levelHeight, topOfLevels,
} from './store.js';
import { placeScanBytes, seedProject, proposalSummary } from './scan2plan.js';
import { chooseScanPlacement } from './scanplace.js';
import { openNewPropertyDialog } from './newproperty.js';
import { materialSelectHtml } from './materials.js';
import { pendingTextureJobs, setTextureQuality } from './textures.js';
import { qualityProfile, stillDimensions } from './render-quality.js';
import { icon } from './icons.js';
import { buildPropertyGroup, buildGround, modelBounds, roomCentres, wallCapRects, disposeBuilt, wallInteriorMaterialId } from './geometry.js';
import { planWallMove, applyWallMove, normalOffset } from './wallmove.js';
import { addPhotoFromFile, photoUrl, photoById, revokePhotoUrls } from './photos-store.js';
import {
  loadScanObject, applyScanTransform, disposeScanObject,
  scanStats, dropScanToFloor, centerScanOnModel, releaseSplatRenderer, splatDrawables, splatBusy,
} from './scans.js';

// ---------- persistent GPU state (one context for the life of the page) ----------
let renderer = null, pmrem = null;

// ---------- per-mount state ----------
let el = null, wrapEl = null, inspEl = null, hud = {};
let scene = null, camera = null, controls = null, walk = null, gizmo = null, composer = null, passes = {};
let sky = null, envSky = null, sun = null, hemi = null, envRT = null, skyScene = null, panoTex = null, panoId = null;
let modelGroup = null, groundGroup = null, scanRoot = null, pinRoot = null, noteRoot = null, lightRoot = null, measureRoot = null;
let prop = null;
let selection = null;          // {kind:'wall'|'room'|'opening'|'scan'|'pin'|'note', id}
let selectionVersion = 0;      // late mount focus must not replace a newer user selection
let hoverTarget = null;
let mode = 'orbit';            // orbit | walk | top
let tool = 'select';           // select | move | measure | pin | note
let xray = false;
let section = { on: false, height: 1.2 };
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.2);
let framesLeft = 0, lastT = 0, tween = null, resizeObs = null;
let pinPhotoId = null;         // photo being placed by the PIN PHOTO tool
let pinBatch = false;          // placing unpinned photos one after another
let measureDraft = null;       // first measure point
const measures = [];           // {a, b, line, label}
const scanObjs = {};           // scanId -> Object3D
const scanState = {};          // scanId -> 'loading' | 'ready' | 'missing' | 'failed'
const pinObjs = {};            // photoId -> {group, sprite, line, dot, aspect}
const noteObjs = {};           // noteId -> {group, sprite, line, dot, aspect}
let movingNoteId = null;       // note being re-placed by the NOTE tool (null: the tool adds one)
let rightPress = null;         // a right-click (or Ctrl-click) in progress: opens the menu if it does not drag
let ctxMenu = null, noteEditor = null;
const walkKeys = {};
let walkLocked = false, dragLook = null;
let walkFloor = 0;             // elevation of the level the walk started on (eye height sits 1.6 m above)
// Levels switched off in the LEVELS section, per property, kept across remounts.
const hiddenLevelsByProp = {};
let pmremTimer = 0, envDirty = true, sunDirty = true;
let pressed = null;
let toastTimer = 0;
// Bumped on every mount; async loaders compare their captured token so work started by a
// previous mount never lands in (or doubles up inside) the next one.
let mountId = 0;
let pendingScanFocus = null;
export function focusScanOnMount(id) { pendingScanFocus=id; }
let exportingStill = false, exportRequest = false, exportDialog = null;
const raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 0.05 };
// three's default Line threshold is 1 m: far too fat a corridor for helper lines to pick through.
raycaster.params.Line = { threshold: 0.02 };
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();
const walkEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function dpr() { const q = qualityProfile(prop.env.quality); return Math.min((window.devicePixelRatio || 1) * q.scale, q.maxDpr); }
// World Y of the highest ceiling: the height the whole model spans (framing, shadows, the section range).
function modelTop() { return topOfLevels(prop); }
function lowestElevation() { return prop.levels.reduce((m, l) => Math.min(m, l.elevation), Infinity); }
function hiddenLevels() { return hiddenLevelsByProp[prop.id] || (hiddenLevelsByProp[prop.id] = new Set()); }
function requestRender(n) { framesLeft = Math.max(framesLeft, n || 2); }

// ---------- defaults for old data ----------
function ensureDefaults(p) {
  const defaults = defaultEnv();
  p.env = Object.assign({}, defaults, p.env || {});
  const date = new Date(p.env.date + 'T00:00:00Z');
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== p.env.date) p.env.date = defaults.date;
  if (!validTimeZone(p.env.timeZone)) p.env.timeZone = defaults.timeZone;
  if (!Number.isFinite(p.env.xrayOpacity)) p.env.xrayOpacity = defaults.xrayOpacity;
  p.env.xrayOpacity = Math.max(0, Math.min(1, p.env.xrayOpacity));
  p.photos = p.photos || [];
  p.notePins = p.notePins || [];
  p.scans = p.scans || [];
  p.rooms = p.rooms || []; p.walls = p.walls || []; p.openings = p.openings || [];
  ensureLevels(p);
  for (const s of p.scans) {
    s.pos = s.pos || [0, 0, 0];
    if (s.rotY == null) s.rotY = 0;
    if (s.scale == null) s.scale = 1;
    if (s.visible == null) s.visible = true;
    if (s.pointSize == null) s.pointSize = 0.012;
    s.pointColor = s.pointColor || 'rgb';
    s.budget = s.budget || 2000000;
    if (!s.kind) s.kind = (s.format === 'ply') ? 'points' : (['obj', 'glb', 'gltf'].includes(s.format) ? 'mesh' : 'points');
  }
}

// ---------- renderer ----------
function ensureRenderer() {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping || THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  // PCF with a wide sample radius (set on the sun): soft, alias-free shadow edges at grazing
  // sun angles. r185 has retired PCFSoftShadowMap in favour of this kernel.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.localClippingEnabled = true;
  renderer.domElement.className = 'v-canvas';
  pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  return renderer;
}

// ---------- scene ----------
function setupScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0c1013');
  camera = new THREE.PerspectiveCamera(50, 1, 0.05, 3000);
  camera.position.set(10, 8, 12);

  sky = makeSky(false);
  scene.add(sky);
  // A second sky without the sun disc bakes the environment map: the disc's radiance
  // overflows half-float render targets and turns the whole PMREM into NaN.
  envSky = makeSky(true);
  skyScene = new THREE.Scene();
  skyScene.add(envSky);

  sun = new THREE.DirectionalLight(0xfff4e6, 2);
  sun.castShadow = true;
  // normalBias must stay below the 16 mm casing depth, or the wall beside every casing samples
  // the map in front of the trim and a lit "stitch" line opens along the joint.
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.008;
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);

  hemi = new THREE.HemisphereLight(0xdfe6ee, 0x6b7a4a, 0.7);
  scene.add(hemi);

  lightRoot = new THREE.Group(); lightRoot.name = 'nightlights'; scene.add(lightRoot);
  scanRoot = new THREE.Group(); scanRoot.name = 'scans'; scene.add(scanRoot);
  pinRoot = new THREE.Group(); pinRoot.name = 'pins'; scene.add(pinRoot);
  noteRoot = new THREE.Group(); noteRoot.name = 'notes'; scene.add(noteRoot);
  measureRoot = new THREE.Group(); measureRoot.name = 'measures'; scene.add(measureRoot);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.3;
  controls.maxDistance = 400;
  controls.addEventListener('change', () => requestRender(2));

  walk = new PointerLockControls(camera, renderer.domElement);
  walk.disconnect();
  walk.addEventListener('lock', () => { walkLocked = true; setHint(''); });
  walk.addEventListener('unlock', () => { walkLocked = false; setHint(''); });
  walk.addEventListener('change', () => requestRender(2));

  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode('translate');
  gizmo.showY = false;
  gizmo.addEventListener('dragging-changed', e => {
    controls.enabled = !e.value && mode !== 'walk';
    if (!e.value) commitGizmoMove();
  });
  gizmo.addEventListener('change', () => requestRender(2));
  scene.add(gizmo.getHelper());
}

const SKY_SCALE = 0.3, ENV_SKY_SCALE = 0.35;
function makeSky(forEnv) {
  const s = new Sky();
  s.scale.setScalar(2000);
  // The environment bake has no sun disc (the DirectionalLight is the sun) and is scaled so
  // the sky's irradiance sits in a believable ratio to direct sunlight: about 4:1 key to fill
  // on a clear day, so shadows stay open and neutral instead of black and blue.
  if (forEnv) s.material.uniforms.showSunDisc.value = 0;
  s.material.uniforms.cloudCoverage.value = 0.35;
  s.material.uniforms.cloudDensity.value = 0.45;
  // Scale the sky into the same range as the sun-lit model and clamp it so bloom and the
  // PMREM never see infinities. Keep the visible sun below the bloom threshold too.
  let fs = s.material.fragmentShader;
  fs = fs.replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( min( texColor * ' + (forEnv ? ENV_SKY_SCALE : SKY_SCALE) + ', vec3( 2.0 ) ), 1.0 );');
  s.material.fragmentShader = fs;
  s.material.needsUpdate = true;
  return s;
}

function setupComposer() {
  const w = Math.max(1, wrapEl.clientWidth), h = Math.max(1, wrapEl.clientHeight);
  composer = new EffectComposer(renderer);
  passes.render = new RenderPass(scene, camera);
  passes.gtao = new GTAOPass(scene, camera, w, h);
  passes.gtao.output = GTAOPass.OUTPUT.Default;
  passes.gtao.blendIntensity = 0.85;
  passes.gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.2, thickness: 1, scale: 1.1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
  passes.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
  // Splats are drawn by Spark inside the render pass; they must not feed the AO normal buffer.
  // Nor may photo-pin and note cards: under the pass's override material a sprite is no
  // billboard but a flat quad in world space, which shades the floor and darkens the card.
  const gtaoRender = passes.gtao.render.bind(passes.gtao);
  passes.gtao.render = (...args) => {
    const hidden = hideSplats();
    for (const o of [pinRoot, noteRoot]) if (o && o.visible) { o.visible = false; hidden.push(o); }
    gtaoRender(...args);
    hidden.forEach(o => { o.visible = true; });
  };

  passes.outline = new OutlinePass(new THREE.Vector2(w, h), scene, camera);
  passes.outline.visibleEdgeColor.set('#e8973a');
  passes.outline.hiddenEdgeColor.set('#7a4a12');
  passes.outline.edgeStrength = 4.5; passes.outline.edgeThickness = 1.4; passes.outline.edgeGlow = 0.25;
  passes.hover = new OutlinePass(new THREE.Vector2(w, h), scene, camera);
  passes.hover.visibleEdgeColor.set('#f6d5a6');
  passes.hover.hiddenEdgeColor.set('#3a2a14');
  passes.hover.edgeStrength = 2.2; passes.hover.edgeThickness = 1; passes.hover.edgeGlow = 0;
  passes.hover.enabled = false;
  for (const p of [passes.outline, passes.hover]) {
    const orig = p.render.bind(p);
    p.render = (...args) => { const hidden = hideSplats(); orig(...args); hidden.forEach(o => { o.visible = true; }); };
    enableMaskClipping(p.prepareMaskMaterial);
  }

  passes.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.28, 0.4, 2.2);
  passes.smaa = new SMAAPass();
  passes.output = new OutputPass();
  for (const p of [passes.render, passes.gtao, passes.outline, passes.hover, passes.bloom, passes.smaa, passes.output]) composer.addPass(p);
}

function hideSplats() {
  const hidden = [];
  for (const o of splatDrawables()) if (o.visible) { o.visible = false; hidden.push(o); }
  return hidden;
}

// OutlinePass draws the selection mask with its own ShaderMaterial, which carries no clipping
// chunks, so in SECTION the outline of the cut-away part of a wall would float above the cut.
// Splice three's clipping includes into it; applySection() then hands it the plane.
function enableMaskClipping(m) {
  if (!m || m.userData.clipReady) return;
  m.vertexShader = m.vertexShader
    .replace('#include <batching_pars_vertex>', '#include <batching_pars_vertex>\n#include <clipping_planes_pars_vertex>')
    .replace('#include <project_vertex>', '#include <project_vertex>\n#include <clipping_planes_vertex>');
  m.fragmentShader = m.fragmentShader
    .replace('#include <packing>', '#include <packing>\n#include <clipping_planes_pars_fragment>')
    .replace('void main() {', 'void main() {\n#include <clipping_planes_fragment>');
  m.clipping = true;
  m.userData.clipReady = true;
  m.needsUpdate = true;
}
// Every pass material that re-renders scene geometry and must respect the section cut.
function passClipMaterials() {
  const list = [];
  if (passes.gtao) list.push(passes.gtao.normalMaterial);
  for (const p of [passes.outline, passes.hover]) if (p) list.push(p.depthMaterial, p.prepareMaskMaterial);
  return list.filter(Boolean);
}

function applyQuality() {
  const q = prop.env.quality || 'high';
  configureRenderQuality(q);
  resize();
}

function configureRenderQuality(name, forExport = false) {
  const q = qualityProfile(name);
  passes.gtao.enabled = q.ao;
  passes.gtao.updateGtaoMaterial({ samples: q.aoSamples });
  passes.bloom.enabled = q.bloom;
  // MSAA belongs on the composer's HDR buffers, not the unused default framebuffer.
  // Query this format: MAX_SAMPLES alone may overstate half-float support.
  const gl = renderer.getContext();
  const supported = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES);
  const samples = Math.max(0, ...Array.from(supported || []).filter(n => n <= (forExport ? 0 : q.samples)));
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    if (target.samples !== samples) { target.dispose(); target.samples = samples; }
  }
  const size = Math.min(q.shadow, renderer.capabilities.maxTextureSize);
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
}

// ---------- model ----------
function rebuildModel() {
  if (modelGroup) { scene.remove(modelGroup); disposeBuilt(modelGroup); }
  modelGroup = buildPropertyGroup(prop, { xray, xrayOpacity: prop.env.xrayOpacity, hiddenLevels: hiddenLevels() });
  modelGroup.visible = !prop.modelSourceId;
  scene.add(modelGroup);
  rebuildNightLights();
  applySection();
  fitShadow();
  reattachGizmo();
  updateOutlineTargets();
  requestRender(3);
}

function rebuildGround() {
  if (groundGroup) { scene.remove(groundGroup); disposeBuilt(groundGroup); }
  groundGroup = buildGround(prop, { showGrid: prop.env.showGrid, studio: prop.env.sky === 'studio' });
  groundGroup.visible = prop.env.showGround !== false;
  scene.add(groundGroup);
  requestRender(2);
}

// One fixture per room, hung just under that room's own ceiling (its level's top); rooms on a
// hidden level get none, so switching a storey off does not leave its lamps glowing in mid-air.
function rebuildNightLights() {
  while (lightRoot.children.length) { const c = lightRoot.children.pop(); disposeBuilt(c); }
  const hidden = hiddenLevels();
  const discGeo = new THREE.CircleGeometry(0.11, 24);
  discGeo.rotateX(Math.PI / 2);
  const discMat = new THREE.MeshStandardMaterial({ color: 0xfff1dc, emissive: new THREE.Color(0xffd9a8), emissiveIntensity: 5, roughness: 0.6 });
  discMat.userData.disposable = true;
  for (const r of roomCentres(prop)) {
    if (hidden.has(r.level)) continue;
    const light = new THREE.PointLight(0xffc48a, 14, 0, 2);
    light.position.set(r.x, r.top - 0.12, r.z);
    lightRoot.add(light);
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.set(r.x, r.top - 0.035, r.z);
    disc.userData = { kind: 'ceiling', id: r.id };
    lightRoot.add(disc);
  }
}

function fitShadow() {
  const b = modelBounds(prop);
  let H = modelTop();
  const bounds = new THREE.Box3(new THREE.Vector3(b.minX, lowestElevation(), b.minY), new THREE.Vector3(b.maxX, H, b.maxY));
  for (const scan of prop.scans) {
    if (scan.visible === false || scan.kind !== 'mesh' || !scanObjs[scan.id]) continue;
    bounds.union(new THREE.Box3().setFromObject(scanObjs[scan.id]));
  }
  H = bounds.max.y - bounds.min.y;
  const center = bounds.getCenter(new THREE.Vector3());
  // Hug the model's bounding sphere: every unit of slack here is wasted shadow texels.
  const R = Math.max(Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z, H) / 2 * 1.05, 4);
  sun.target.position.copy(center);
  const c = sun.shadow.camera;
  c.left = -R; c.right = R; c.top = R; c.bottom = -R;
  c.near = R * 0.5; c.far = R * 5.5;
  c.updateProjectionMatrix();
  sun.userData.radius = R;
  sunDirty = true;
}

// ---------- environment: sun, sky, IBL, night ----------
function currentSun() {
  try { return environmentSun(prop.env); }
  catch { return environmentSun({ ...prop.env, sunMode: 'manual' }); }
}
const smooth = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
function northVector() {
  const n = THREE.MathUtils.degToRad(prop.env.north || 0);
  return new THREE.Vector3(Math.sin(n), 0, -Math.cos(n));
}
function eastVector() {
  const n = THREE.MathUtils.degToRad(prop.env.north || 0);
  return new THREE.Vector3(Math.cos(n), 0, Math.sin(n));
}
function sunDirection(elDeg, azDeg) {
  const el = THREE.MathUtils.degToRad(elDeg), az = THREE.MathUtils.degToRad(azDeg);
  const N = northVector(), E = eastVector();
  return N.multiplyScalar(Math.cos(az) * Math.cos(el)).add(E.multiplyScalar(Math.sin(az) * Math.cos(el))).add(new THREE.Vector3(0, Math.sin(el), 0)).normalize();
}
// Civil twilight ends around -6 deg; the sky shader has gone dark by then.
function isNight() { return currentSun().elevation < -6; }
// True once the chosen panorama has actually been decoded; until then the dynamic sky stands in.
function panoReady() { return prop.env.sky === 'pano' && !!panoTex && panoId === prop.env.panoPhotoId; }

function applyEnvironment() {
  const env = prop.env;
  const { elevation: el, azimuth } = currentSun();
  // Continuous dusk: the sun fades out just below the horizon, night fades in through civil
  // twilight (-2 .. -6 deg), and everything keyed on "night" blends across that band.
  const sunUp = smooth(el, -1, 5);                            // direct sun present
  const nightMix = smooth(-el, 2, 6);                         // 0 by day, 1 after civil dusk
  const dusk = THREE.MathUtils.clamp(el / 18, 0, 1);          // 0 at horizon, 1 above 18 deg
  const dir = sunDirection(Math.max(el, -8), azimuth);
  const usePano = panoReady();

  // Sky (also the stand-in while a panorama is missing or still decoding).
  sky.visible = env.sky === 'dynamic' || (env.sky === 'pano' && !usePano);
  for (const s of [sky, envSky]) {
    const u = s.material.uniforms;
    u.sunPosition.value.copy(dir);
    u.turbidity.value = THREE.MathUtils.lerp(2.2 + (1 - dusk) * 6, 2, nightMix);
    u.rayleigh.value = THREE.MathUtils.lerp(0.9 + (1 - dusk) * 2.2, 0.6, nightMix);
    u.mieCoefficient.value = THREE.MathUtils.lerp(0.003 + (1 - dusk) * 0.02, 0.002, nightMix);
    u.mieDirectionalG.value = 0.82;
  }

  // Sun by day (warm and low near the horizon, white overhead); once it has set the same light
  // becomes a cool moon that brightens through twilight. Key stays about 4:1 against the fill.
  const R = sun.userData.radius || 10;
  if (sunUp > 0) {
    sun.color.setHex(0xfff1dc).lerp(new THREE.Color(0xffa860), 1 - dusk);
    sun.intensity = sunUp * (0.6 + 2.6 * Math.pow(Math.sin(THREE.MathUtils.degToRad(Math.max(el, 0.5))), 0.6));
    sun.position.copy(sun.target.position).addScaledVector(dir, R * 3);
  } else {
    const moon = sunDirection(38, azimuth + 160);
    sun.color.setHex(0x9fb4d6);
    sun.intensity = 0.28 * nightMix;
    sun.position.copy(sun.target.position).addScaledVector(moon, R * 3);
  }
  // Fill is mostly the neutral hemisphere (skylight plus warm ground bounce) with a smaller
  // share of the blue sky IBL, so neutral surfaces in shade read grey rather than blue.
  const dayHemi = new THREE.Color(0xe8e6e0).lerp(new THREE.Color(0xf0c8a0), (1 - dusk) * 0.5);
  hemi.color.copy(dayHemi).lerp(new THREE.Color(0x2a3b55), nightMix);
  hemi.groundColor.setHex(0x6b7a4a).lerp(new THREE.Color(0x0d1014), nightMix);
  hemi.intensity = THREE.MathUtils.lerp(0.65 + 0.1 * dusk, 0.2, nightMix);
  scene.environmentIntensity = env.sky === 'studio' ? 0.9 : THREE.MathUtils.lerp(0.45 + 0.1 * dusk, 0.3, nightMix);
  if (interiorFill && nightMix < 1) {
    // Inside there is no sky to bounce light around, so fake the bounce: warmer, stronger ambient.
    const k = 1 - nightMix;
    hemi.color.lerp(new THREE.Color(0xe9e2d6), k); hemi.groundColor.lerp(new THREE.Color(0x8c8478), k);
    hemi.intensity = THREE.MathUtils.lerp(hemi.intensity, 0.9, k); scene.environmentIntensity *= 1 + 0.3 * k;
  }
  // A camera would open up at dusk; lift the exposure as the sun drops, then settle for night.
  renderer.toneMappingExposure = (env.exposure || 1) * 0.85 * THREE.MathUtils.lerp(1 + 0.45 * (1 - dusk), 0.6, nightMix);

  // Distant neutral haze hides the ground edge without bleaching the model or blooming.
  const fogColor = env.sky === 'studio' ? new THREE.Color(0x171d23) : new THREE.Color(0x9cabb4).lerp(new THREE.Color(0x101923), nightMix);
  const b = modelBounds(prop);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 8);
  if (usePano) scene.fog = null;
  else scene.fog = new THREE.Fog(fogColor, Math.max(span * 12, 150), Math.max(span * 40, 600));

  // Night lights (and a gentle daytime level while walking through rooms).
  const lampMix = env.nightLights !== false ? nightMix : 0;
  const lightsOn = lampMix > 0 || interiorFill;
  lightRoot.visible = lightsOn;
  const lampI = interiorFill ? Math.max(5, 14 * lampMix) : 14 * lampMix;
  const discI = interiorFill ? Math.max(1.4, 5 * lampMix) : 5 * lampMix;
  lightRoot.traverse(o => { if (o.isPointLight) o.intensity = lampI; if (o.isMesh) o.material.emissiveIntensity = discI; });
  if (modelGroup && modelGroup.userData.glass) {
    const g = modelGroup.userData.glass;
    g.emissive.setHex(0xffcf9a);
    g.emissiveIntensity = 0.5 * lampMix;
  }
  // Background / IBL per sky mode.
  if (env.sky === 'studio') {
    scene.background = new THREE.Color(0x171d23);
    scheduleEnvMap(0);
  } else if (env.sky === 'pano') {
    if (usePano) scene.background = panoTex;
    else { scene.background = null; loadPano(env.panoPhotoId); }
    scheduleEnvMap(usePano ? 0 : 120);
  } else {
    scene.background = null;
    scheduleEnvMap(120);
  }
  envDirty = false;
  requestRender(3);
}

// PMREM from the sky is a few ms; throttle it while a slider drags.
function scheduleEnvMap(delay) {
  clearTimeout(pmremTimer);
  pmremTimer = setTimeout(regenEnvMap, delay);
}
function regenEnvMap() {
  if (!scene) return;
  const env = prop.env;
  let rt = null;
  if (env.sky === 'studio') {
    const room = new RoomEnvironment();
    rt = pmrem.fromScene(room, 0.04);
    room.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  } else if (panoReady()) {
    rt = pmrem.fromEquirectangular(panoTex);
  } else {
    // Dynamic sky, or a panorama that is missing / still decoding: there is always an IBL.
    rt = pmrem.fromScene(skyScene, 0, 0.1, 3000);
  }
  if (envRT) envRT.dispose();
  envRT = rt;
  scene.environment = rt.texture;
  // Shader variants depend on the environment map being present, so the first bake is the
  // earliest moment the warm-up compiles the programs the frames will actually use.
  if (!programsWarm) { programsWarm = true; warmPrograms(); }
  requestRender(3);
}
let programsWarm = false;

let panoNagged = false, panoPending = null, panoMissing = null;
async function loadPano(id) {
  if (!id) { if (!panoNagged) toast('Choose a panorama photo in the ENVIRONMENT panel (add a 2:1 image with PIN PHOTO > ADD PHOTO).'); panoNagged = true; return; }
  // applyEnvironment() calls this on every slider tick until the texture lands: load each id once.
  if (panoPending === id || panoMissing === id) return;
  panoPending = id;
  const token = mountId;
  const url = photoById(prop, id) ? await photoUrl(id) : null;
  if (token !== mountId || !scene) return;
  if (!url) {
    // The record or its bytes are gone (JSON-only import, cleared storage): say so and keep the sky.
    panoPending = null; panoMissing = id;
    toast('Panorama photo is missing; using the dynamic sky instead.', 'warn', 5000);
    return;
  }
  new THREE.TextureLoader().load(url, tex => {
    if (token !== mountId || !scene) { tex.dispose(); return; }
    if (panoTex) panoTex.dispose();
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    panoTex = tex; panoId = id; panoPending = null;
    if (prop.env.sky === 'pano') applyEnvironment();
  }, undefined, () => {
    if (token !== mountId) return;
    panoPending = null; panoMissing = id;
    toast('Panorama photo could not be decoded; using the dynamic sky instead.', 'warn', 5000);
  });
}

function updateSun() {
  sunDirty = false;
  sun.shadow.camera.updateProjectionMatrix();
}

// ---------- section cut ----------
let capMesh = null;
function rebuildCaps() {
  if (capMesh) { scene.remove(capMesh); capMesh.geometry.dispose(); capMesh = null; }
  if (!section.on || !modelGroup || !modelGroup.visible) return;
  const rects = wallCapRects(prop, section.height, { hiddenLevels: hiddenLevels() });
  if (!rects.length) return;
  const P = [], I = [];
  rects.forEach((r, i) => {
    for (const [x, z] of r) P.push(x, section.height - 0.0008, z);
    I.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  capMesh = new THREE.Mesh(geo, capMaterial());
  capMesh.renderOrder = 2;
  scene.add(capMesh);
}
let capMat = null;
function capMaterial() {
  // Architectural section fill: dark, matte, never clipped, faces up whichever way the quad winds.
  if (!capMat) { capMat = new THREE.MeshStandardMaterial({ color: 0x262c33, roughness: 0.95, side: THREE.DoubleSide }); capMat.userData.noClip = true; }
  return capMat;
}
function applySection() {
  clipPlane.constant = section.height;
  const planes = section.on ? [clipPlane] : null;
  rebuildCaps();
  const visit = o => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (m.userData && m.userData.noClip) continue;
      m.clippingPlanes = planes; m.clipShadows = true;
    }
  };
  if (modelGroup) modelGroup.traverse(visit);
  if (lightRoot) lightRoot.traverse(visit);
  if (scanRoot) scanRoot.traverse(o => { if (!(o.userData && o.userData.splatDraw)) visit(o); });
  // GTAO's normal/depth prepass and the outline masks re-render the geometry with their own
  // materials; without the plane they would shade and outline the part that was cut away.
  for (const m of passClipMaterials()) { m.clippingPlanes = planes; m.needsUpdate = true; }
  requestRender(2);
}
// Anything above the cut is not on screen and must not be picked, unless its material is
// exempt from clipping (section caps, pin cards).
function clippedAway(h) {
  if (!section.on || h.point.y <= section.height + 1e-4) return false;
  const m = h.object.material;
  return !(m && m.userData && m.userData.noClip);
}

// ---------- camera framing ----------
function boundsInfo() {
  const b = modelBounds(prop);
  const H = modelTop();
  const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 6);
  const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, H) / 2;
  return { b, H, cx, cz, span, radius };
}
function fitDistance(radius) {
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const aspect = Math.max(0.6, camera.aspect || 1);
  const hfov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
  return radius / Math.sin(Math.min(fov, hfov) / 2) * 1.08;
}
function presetView(name, immediate) {
  const { H, cx, cz, radius } = boundsInfo();
  const target = new THREE.Vector3(cx, H * 0.45, cz);
  let dir;
  // Elevations around 35 deg: high enough that sight lines clear the far walls and reach the
  // floors (a dollhouse read), low enough that facades and openings still show.
  if (name === 'front') dir = new THREE.Vector3(0.02, 0.26, 1);
  else if (name === 'iso') dir = new THREE.Vector3(-0.72, 0.62, 0.72);
  else if (name === 'top') dir = northVector().multiplyScalar(-0.002).add(new THREE.Vector3(0, 1, 0));
  else dir = new THREE.Vector3(0.66, 0.74, 0.8);
  dir.normalize();
  const dist = fitDistance(radius) * (name === 'top' ? 1.15 : 1);
  const pos = target.clone().addScaledVector(dir, dist);
  if (name === 'top') target.y = 0;
  flyTo(pos, target, immediate ? 0 : 650);
}
// Fly to look at any object from a pleasant three-quarter angle.
function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (obj.userData && obj.userData.bounds) box.copy(obj.userData.bounds).applyMatrix4(obj.matrixWorld);
  if (!isFinite(box.min.x)) return;
  const centre = new THREE.Vector3(), size = new THREE.Vector3();
  box.getCenter(centre); box.getSize(size);
  const radius = Math.max(size.length() / 2, 0.5);
  const dir = new THREE.Vector3(0.6, 0.45, 0.75).normalize();
  if (mode === 'walk') setMode('orbit');
  flyTo(centre.clone().addScaledVector(dir, fitDistance(radius)), centre, 700);
}
function flyTo(pos, target, ms) {
  if (!ms) {
    camera.position.copy(pos); controls.target.copy(target); controls.update();
    requestRender(3); return;
  }
  tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), start: performance.now(), t: 0, ms };
  requestRender(2);
}
function stepTween() {
  // Wall-clock based so a slow frame rate shortens the animation instead of stretching it.
  tween.t = (performance.now() - tween.start) / tween.ms;
  const k = tween.t >= 1 ? 1 : (1 - Math.cos(Math.PI * tween.t)) / 2;
  camera.position.lerpVectors(tween.p0, tween.p1, k);
  controls.target.lerpVectors(tween.t0, tween.t1, k);
  camera.lookAt(controls.target);
  if (tween.t >= 1) { tween = null; controls.update(); }
}

// ---------- modes ----------
function setMode(next) {
  if (mode === 'walk' && next !== 'walk') {
    if (walkLocked) walk.unlock();
    walk.disconnect();
    dragLook = null;
    for (const k of Object.keys(walkKeys)) delete walkKeys[k];
  }
  mode = next;
  controls.enabled = next !== 'walk';
  controls.enableRotate = next !== 'top';
  controls.maxPolarAngle = Math.PI * 0.495;
  if (next === 'walk') startWalk();
  else if (next === 'top') presetView('top');
  else if (next === 'orbit' && camera.position.y < 0.3) camera.position.y = 0.3;
  if (next !== 'walk') { controls.target.y = Math.max(controls.target.y, 0); controls.update(); }
  renderHud();
  requestRender(3);
}

function startWalk() {
  const { cx, cz } = boundsInfo();
  let sx = cx, sz = cz;
  const look = new THREE.Vector3(cx, 1.5, cz);
  // Start in the selected room, else the largest one: a third of the way along its long axis,
  // looking down the length of the room so the first view is the widest one.
  // Rooms on a hidden level are not walkable; the floor is the chosen room's level.
  const hidden = hiddenLevels();
  const rooms = (prop.rooms || []).filter(r => r.pts && r.pts.length > 2 && !hidden.has(levelOfRoom(prop, r).id));
  const selRoom = selection && selection.kind === 'room' && rooms.find(r => r.id === selection.id);
  const r = selRoom || rooms.slice().sort((a, b) => polyArea(b.pts) - polyArea(a.pts))[0];
  walkFloor = r ? levelOfRoom(prop, r).elevation : 0;
  look.y += walkFloor;
  if (r) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of r.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const longX = (maxX - minX) >= (maxY - minY);
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    if (longX) { sx = minX + (maxX - minX) * 0.3; sz = my; look.set(maxX, walkFloor + 1.45, my); }
    else { sx = mx; sz = minY + (maxY - minY) * 0.3; look.set(mx, walkFloor + 1.45, maxY); }
  }
  camera.position.set(sx, walkFloor + 1.6, sz);
  if (look.distanceTo(camera.position) < 0.5) look.set(sx, walkFloor + 1.5, sz - 5);
  camera.lookAt(look);
  walk.connect(renderer.domElement);
  toast('WALK: WASD / arrows move, Shift runs. Drag to look, or click the view to capture the mouse. Esc exits.', 'info', 5000);
}

function stepWalk(dt) {
  const run = walkKeys.ShiftLeft || walkKeys.ShiftRight;
  const speed = (run ? 3.6 : 1.7) * dt;
  let fwd = 0, side = 0;
  if (walkKeys.KeyW || walkKeys.ArrowUp) fwd += 1;
  if (walkKeys.KeyS || walkKeys.ArrowDown) fwd -= 1;
  if (walkKeys.KeyD || walkKeys.ArrowRight) side += 1;
  if (walkKeys.KeyA || walkKeys.ArrowLeft) side -= 1;
  if (!fwd && !side) return false;
  camera.getWorldDirection(_v); _v.y = 0; _v.normalize();
  _v2.crossVectors(_v, camera.up).normalize();
  const move = _v.multiplyScalar(fwd).add(_v2.multiplyScalar(side)).normalize().multiplyScalar(speed);
  // Soft collision: do not walk into a wall closer than 35 cm.
  if (modelGroup) {
    raycaster.set(camera.position, move.clone().normalize());
    raycaster.far = 0.35 + speed;
    const hits = raycaster.intersectObject(modelGroup, true).filter(h => !(h.object.userData && h.object.userData.noCollide) && isVisibleChain(h.object) && h.object.userData.kind === 'wall');
    raycaster.far = Infinity;
    if (hits.length) return true;
  }
  camera.position.add(move);
  camera.position.y = walkFloor + 1.6;
  return true;
}

// ---------- render loop ----------
function tick(time) {
  if (!scene) return;
  if (exportingStill) return;
  const dt = Math.min(0.05, (time - (lastT || time)) / 1000);
  lastT = time;
  let active = false;
  if (tween) { stepTween(); active = true; }
  else if (mode === 'walk') { if (stepWalk(dt)) active = true; }
  else if (controls.update(dt)) active = true;
  if (active || splatBusy()) requestRender(2);
  // Procedural textures attach to shared materials asynchronously (textures.js synthesises them in
  // idle slices). Redraw at a gentle cadence while that is happening, and a few frames once it is
  // done, so surfaces do not stay flat until the next interaction.
  if (pendingTextureJobs() > 0) {
    texturesPending = true;
    if (time - lastTextureRedraw > 400) { lastTextureRedraw = time; requestRender(1); }
  } else if (texturesPending) {
    texturesPending = false;
    // New maps mean new shader variants; compile the lit and unlit ones here rather than on
    // the first step into a room.
    warmPrograms();
    requestRender(3);
  }
  if (framesLeft > 0) {
    framesLeft--;
    // One bad frame must not kill the animation loop for the rest of the session.
    try { renderFrame(); }
    catch (e) { if (!renderFailed) { renderFailed = true; console.error('render failed', e); } }
  }
}
let renderFailed = false;
let texturesPending = false, lastTextureRedraw = 0;

// Inside the house there is no sky to bounce light around, so fake the bounce: more, warmer
// ambient and the room fixtures at a daytime level while the camera is within a room.
let interiorFill = false;
function updateInteriorFill() {
  // Inside = within a room's polygon and between that room's floor and ceiling (its level's band).
  let inside = false;
  const y = camera.position.y;
  for (const r of prop.rooms || []) {
    if (!r.pts || r.pts.length < 3) continue;
    const lvl = levelOfRoom(prop, r);
    if (y < lvl.elevation - 0.05 || y >= lvl.elevation + levelHeight(prop, lvl.id) - 0.05) continue;
    if (pointInPolygon(camera.position.x, camera.position.z, r.pts)) { inside = true; break; }
  }
  if (inside === interiorFill) return;
  interiorFill = inside;
  applyEnvironment();
}
function pointInPolygon(px, py, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function renderFrame() {
  if (sunDirty) updateSun();
  updateInteriorFill();
  // Each level's ceilings show only while the camera is below that level's top (or walking),
  // so orbiting above the house reads as a dollhouse and stepping inside closes the lid.
  const levels = modelGroup && modelGroup.userData.levels;
  if (levels) for (const l of levels) l.ceilings.visible = prop.env.showCeilings !== false && (mode === 'walk' || camera.position.y < l.top - 0.05);
  updatePins();
  updateNotes();
  updateMeasureLabels();
  updateCompass();
  composer.render();
}

function resize() {
  if (!wrapEl || !renderer || !composer || exportingStill) return;
  const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
  if (!w || !h) return;
  const pr = dpr();
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  for (const m of measures) m.line.material.resolution.set(w * pr, h * pr);
  requestRender(2);
}

// ---------- still render ----------
export function openStillDialog() {
  if (exportDialog || exportRequest) return;
  const dialog = document.createElement('dialog');
  exportDialog = dialog;
  dialog.className = 'v-export-dialog';
  dialog.innerHTML = `<form method="dialog">
    <h2>Export image</h2>
    <p>Save the current camera view as a PNG. Image size is independent of your window.</p>
    <label>Long edge <select data-export-size><option value="1920">1920 px</option><option value="3840" selected>3840 px (4K)</option><option value="5760">5760 px (6K)</option><option value="7680">7680 px (wide views)</option></select></label>
    <label>Render quality <select data-export-quality><option value="high">High</option><option value="ultra">Ultra (32 AO samples)</option></select></label>
    <label class="v-export-check"><input type="checkbox" data-export-annotations> Include measurements, photo pins and notes</label>
    <p class="v-export-size" data-export-dimensions></p>
    <p class="v-export-note">Surface detail follows ENVIRONMENT quality. Ultra uses sharper material textures. Up to 24 megapixels, subject to GPU limits.</p>
    <p role="status" data-export-status></p>
    <div class="v-export-actions"><button value="cancel" class="btn">CLOSE</button><button type="button" class="btn" data-export-save>SAVE PNG</button></div>
  </form>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => { dialog.remove(); if (exportDialog === dialog) exportDialog = null; });
  const size = dialog.querySelector('[data-export-size]');
  const status = dialog.querySelector('[data-export-status]');
  const save = dialog.querySelector('[data-export-save]');
  const dimensions = () => stillDimensions(wrapEl.clientWidth, wrapEl.clientHeight, Number(size.value), renderer.capabilities.maxTextureSize);
  const refresh = () => {
    try { const d = dimensions(); dialog.querySelector('[data-export-dimensions]').textContent = d.width + ' × ' + d.height + ' pixels'; status.textContent = ''; save.disabled = exportRequest; }
    catch (e) { status.textContent = e.message; save.disabled = true; }
  };
  size.onchange = refresh;
  save.onclick = async () => {
    save.disabled = true;
    status.textContent = 'Preparing textures and scans…';
    try {
      await renderStill({ ...dimensions(), quality: dialog.querySelector('[data-export-quality]').value, annotations: dialog.querySelector('[data-export-annotations]').checked, dialog, status });
      if (dialog.isConnected) { status.textContent = 'PNG saved.'; save.disabled = false; }
    } catch (e) { if (dialog.isConnected) { status.textContent = e.message; save.disabled = false; } }
  };
  refresh();
  dialog.showModal();
}

async function renderStill(options) {
  if (exportRequest) throw new Error('An image is already being rendered.');
  exportRequest = true;
  try { await renderStillPrepared(options); }
  finally { exportRequest = false; }
}

async function renderStillPrepared(options) {
  const token = mountId;
  const deadline = performance.now() + 60000;
  // Do not save a transient flat-tinted first frame. Photo decoding is counted too.
  while (pendingTextureJobs() || Object.values(scanState).some(s => s === 'loading') || splatBusy()) {
    if (token !== mountId || !options.dialog.open) throw new Error('Export cancelled.');
    if (performance.now() > deadline) throw new Error('Assets are still loading. Wait for the model to finish, then export again.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (token !== mountId || !options.dialog.open) throw new Error('Export cancelled.');
  const { width, height } = options;
  const c = composer, r = renderer;
  const savedPasses = [passes.outline, passes.hover].map(p => [p, p.enabled]);
  const roots = [pinRoot, noteRoot, measureRoot, gizmo.getHelper()].map(o => [o, o.visible]);
  const oldAspect = camera.aspect;
  exportingStill = true;
  options.status.textContent = 'Rendering ' + width + ' × ' + height + '…';
  // Let the status paint before GPU work.
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    if (token !== mountId || !options.dialog.open) throw new Error('Export cancelled.');
    // High-resolution stills use SMAA at output size; avoid multiplying their HDR memory by MSAA.
    configureRenderQuality(options.quality, true);
    for (const [p] of savedPasses) p.enabled = false;
    // Photo pins and notes hidden with their toggles stay out of the image too.
    for (const [o, visible] of roots) o.visible = options.annotations && visible && o !== gizmo.getHelper();
    r.setPixelRatio(1); c.setPixelRatio(1);
    r.setSize(width, height, false); c.setSize(width, height);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    for (const m of measures) m.line.material.resolution.set(width, height);
    renderFrame();
    // Snapshot synchronously before WebGL's non-preserved default framebuffer is cleared.
    const snapshot = document.createElement('canvas');
    snapshot.width = width; snapshot.height = height;
    snapshot.getContext('2d').drawImage(r.domElement, 0, 0);
    const blob = await new Promise(resolve => snapshot.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed. Choose a smaller size.');
    if (token !== mountId || !options.dialog.open) throw new Error('Export cancelled.');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = String(prop.name || 'property').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'property';
    a.href = url; a.download = 'tiksi-' + slug + '-' + width + 'x' + height + '-' + isoToday() + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } finally {
    exportingStill = false;
    // Navigation can dispose this mount while PNG encoding is running.
    if (token === mountId && composer === c) {
      for (const [p, enabled] of savedPasses) p.enabled = enabled;
      for (const [o, visible] of roots) o.visible = visible;
      camera.aspect = oldAspect; camera.updateProjectionMatrix();
      configureRenderQuality(prop.env.quality);
      resize();
      requestRender(2);
    }
  }
}

// ---------- picking ----------
function isVisibleChain(o) {
  for (let p = o; p; p = p.parent) if (p.visible === false) return false;
  return true;
}
function ndcFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
}
function pick(e, opts) {
  opts = opts || {};
  raycaster.setFromCamera(ndcFromEvent(e), camera);
  const targets = [];
  if (modelGroup) targets.push(modelGroup);
  if (opts.pins !== false && pinRoot) targets.push(pinRoot);
  if (opts.notes !== false && noteRoot) targets.push(noteRoot);
  if (opts.scans !== false && scanRoot) targets.push(scanRoot);
  if (opts.ground && groundGroup) targets.push(groundGroup);
  const hits = raycaster.intersectObjects(targets, true);
  for (const h of hits) {
    if (!isVisibleChain(h.object)) continue;
    const ud = h.object.userData || {};
    // A scan's invisible pick box and selection-box helper are proxies, never surfaces: the
    // points / mesh underneath are what a click, a measurement or a pin should land on.
    if (ud.pickBox || ud.helper) continue;
    if (clippedAway(h)) continue;
    let o = h.object;
    while (o && (!o.userData || !o.userData.kind)) o = o.parent;
    if (!o) continue;
    if (o.userData.kind === 'grid') continue;
    if (opts.surfaceOnly && (o.userData.kind === 'pin' || o.userData.kind === 'note')) continue;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { kind: o.userData.kind, id: o.userData.id, point: h.point, normal: n, object: o, wallId: o.userData.wallId };
  }
  return null;
}

function onPointerDown(e) {
  closeContextMenu();
  // A right-click (Ctrl-click on a Mac) that does not drag opens the menu on release; a drag pans.
  rightPress = (e.button === 2 || (e.button === 0 && e.ctrlKey)) && mode !== 'walk' ? { x: e.clientX, y: e.clientY } : null;
  if (e.button !== 0 || rightPress) { pressed = null; return; }
  pressed = { x: e.clientX, y: e.clientY };
  if (mode === 'walk' && !walkLocked) dragLook = { x: e.clientX, y: e.clientY };
}
function onPointerUp(e) {
  const rp = rightPress; rightPress = null;
  if (rp) { if (Math.hypot(e.clientX - rp.x, e.clientY - rp.y) <= 5) openContextMenu(e); return; }
  const p = pressed; pressed = null; dragLook = null;
  if (!p || e.button !== 0 || gizmo.dragging) return;
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;      // it was a drag, not a click
  if (mode === 'walk') {
    // A plain click in walk mode captures the mouse for free-look (a user gesture is required).
    if (!walkLocked) { try { walk.lock(); } catch (err) { /* drag-look keeps working */ } }
    return;
  }
  if (tool === 'measure') return addMeasurePoint(e);
  if (tool === 'pin') return placePin(e);
  if (tool === 'note') return placeNote(e);
  const hit = pick(e);
  if (!hit || hit.kind === 'ground') { setSelection(null); return; }
  if (hit.kind === 'pin') { setSelection({ kind: 'pin', id: hit.id }); openLightbox(hit.id); return; }
  if (hit.kind === 'note') { setSelection({ kind: 'note', id: hit.id }); return; }
  if (hit.kind === 'ceiling') { setSelection({ kind: 'room', id: hit.id }); return; }
  setSelection({ kind: hit.kind, id: hit.id });
}
let hoverPending = false;
function onPointerMove(e) {
  if (mode === 'walk' && dragLook) {
    const dx = e.clientX - dragLook.x, dy = e.clientY - dragLook.y;
    dragLook = { x: e.clientX, y: e.clientY };
    walkEuler.setFromQuaternion(camera.quaternion);
    walkEuler.y -= dx * 0.0035; walkEuler.x -= dy * 0.0035;
    walkEuler.x = THREE.MathUtils.clamp(walkEuler.x, -1.4, 1.4);
    camera.quaternion.setFromEuler(walkEuler);
    requestRender(2);
    return;
  }
  if (pressed || hoverPending || mode === 'walk') return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    if (!scene) return;
    const hit = pick(e, { scans: false, ground: false });
    const next = hit && ['wall', 'room', 'opening', 'ceiling'].includes(hit.kind) ? hit.object : null;
    if (tool === 'measure' || tool === 'pin' || tool === 'note') renderer.domElement.style.cursor = hit ? 'crosshair' : 'default';
    else renderer.domElement.style.cursor = (hit && hit.kind !== 'ground') ? 'pointer' : 'default';
    if (next !== hoverTarget) { hoverTarget = next; updateOutlineTargets(); requestRender(2); }
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
function selectedObject() {
  if (!selection) return null;
  if (selection.kind === 'scan') return scanObjs[selection.id] || null;
  if (selection.kind === 'pin') return pinObjs[selection.id] ? pinObjs[selection.id].sprite : null;
  if (selection.kind === 'note') return noteObjs[selection.id] ? noteObjs[selection.id].sprite : null;
  return findGroupFor(selection.kind, selection.id);
}
function updateOutlineTargets() {
  const sel = selectedObject();
  const selMeshes = [];
  if (sel && selection.kind !== 'scan') sel.traverse(o => { if (o.isMesh && !(o.userData && o.userData.glass)) selMeshes.push(o); });
  passes.outline.selectedObjects = selMeshes;
  const hov = hoverTarget && hoverTarget !== sel ? hoverTarget : null;
  const hovMeshes = [];
  if (hov) hov.traverse(o => { if (o.isMesh && !(o.userData && o.userData.glass)) hovMeshes.push(o); });
  passes.hover.selectedObjects = hovMeshes;
  passes.hover.enabled = hovMeshes.length > 0;
  for (const id of Object.keys(scanObjs)) {
    const box = scanObjs[id].userData.box;
    if (box) box.visible = !!(selection && selection.kind === 'scan' && selection.id === id);
  }
}
function setSelection(sel) {
  selectionVersion++;
  const was = selection;
  selection = sel;
  // A selected note card is drawn with an accent border.
  for (const s of [was, sel]) if (s && s.kind === 'note') redrawNoteCard(s.id);
  updateOutlineTargets();
  reattachGizmo();
  renderInspector();
  renderToolCol();
  requestRender(2);
}

// ---------- move walls gizmo ----------
// The wall group's local z is the wall normal. A wall joined to others slides along it only,
// and the walls, rooms and openings attached to it follow (wallmove.js, as in PLAN).
function wallMovePlan(w) {
  const levelId = levelOfWall(prop, w).id;
  const walls = wallsOn(prop, levelId);
  const ids = new Set(walls.map(x => x.id));
  return planWallMove(w, walls, roomsOn(prop, levelId), (prop.openings || []).filter(o => ids.has(o.wallId)));
}
function reattachGizmo() {
  gizmo.detach();
  if (tool === 'move' && selection && selection.kind === 'wall') {
    const g = findGroupFor('wall', selection.id);
    const w = prop.walls.find(w => w.id === selection.id);
    if (g && w) {
      const mv = wallMovePlan(w);
      gizmo.space = 'local';
      gizmo.showX = !(mv && mv.connected);
      gizmo.showZ = true;
      gizmo.attach(g);
      g.userData.origin = g.position.clone();
    }
  }
  requestRender(2);
}
function commitGizmoMove() {
  const obj = gizmo.object;
  if (!obj || !selection || selection.kind !== 'wall') return;
  const o = obj.userData.origin || new THREE.Vector3();
  const dx = obj.position.x - o.x, dz = obj.position.z - o.z;
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
  const w = prop.walls.find(w => w.id === selection.id);
  if (!w) return;
  const r = v => Math.round(v * 200) / 200;
  const mv = wallMovePlan(w);
  if (mv && mv.connected) applyWallMove(mv, r(normalOffset(mv, dx, dz)));
  else { w.ax = r(w.ax + dx); w.ay = r(w.ay + dz); w.bx = r(w.bx + dx); w.by = r(w.by + dz); }
  touch();
  rebuildModel();
  renderInspector();
}

// ---------- measure ----------
function addMeasurePoint(e) {
  const hit = pick(e, { ground: true, surfaceOnly: true, scans: true });
  if (!hit) return;
  if (!measureDraft) {
    measureDraft = hit.point.clone();
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 12), new THREE.MeshBasicMaterial({ color: 0xe8973a, depthTest: false }));
    dot.position.copy(measureDraft); dot.renderOrder = 999; dot.userData.draft = true;
    measureRoot.add(dot);
    setHint('MEASURE: click the second point. Esc cancels.');
    requestRender(2);
    return;
  }
  const a = measureDraft, b = hit.point.clone();
  measureDraft = null;
  measureRoot.children.filter(c => c.userData.draft).forEach(c => { measureRoot.remove(c); c.geometry.dispose(); c.material.dispose(); });
  const geo = new LineGeometry();
  geo.setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
  const mat = new LineMaterial({ color: 0xe8973a, linewidth: 3, depthTest: false, transparent: true });
  const w = wrapEl.clientWidth, h = wrapEl.clientHeight, pr = renderer.getPixelRatio();
  mat.resolution.set(w * pr, h * pr);
  const line = new Line2(geo, mat);
  line.renderOrder = 998;
  measureRoot.add(line);
  const ends = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 10), new THREE.MeshBasicMaterial({ color: 0xe8973a, depthTest: false }));
  const ends2 = ends.clone();
  ends.position.copy(a); ends2.position.copy(b); ends.renderOrder = ends2.renderOrder = 999;
  measureRoot.add(ends, ends2);
  const label = document.createElement('div');
  label.className = 'v-mlabel';
  label.textContent = fmtLen(a.distanceTo(b));
  wrapEl.appendChild(label);
  measures.push({ a, b, line, label, dots: [ends, ends2] });
  setHint('MEASURE: ' + fmtLen(a.distanceTo(b)) + '. Click two more points for another, CLEAR to remove all.');
  renderToolCol();
  requestRender(2);
}
function clearMeasures() {
  if (!measureRoot) return;
  for (const m of measures) {
    measureRoot.remove(m.line); m.line.geometry.dispose(); m.line.material.dispose();
    for (const d of m.dots) { measureRoot.remove(d); d.geometry.dispose(); d.material.dispose(); }
    m.label.remove();
  }
  measures.length = 0;
  measureDraft = null;
  measureRoot.children.slice().forEach(c => { measureRoot.remove(c); if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
  requestRender(2);
}
function updateMeasureLabels() {
  if (!measures.length) return;
  const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
  for (const m of measures) {
    _v.addVectors(m.a, m.b).multiplyScalar(0.5).project(camera);
    const vis = _v.z < 1;
    m.label.style.display = vis ? 'block' : 'none';
    if (vis) m.label.style.transform = `translate(${((_v.x + 1) / 2 * w).toFixed(0)}px, ${((1 - _v.y) / 2 * h).toFixed(0)}px) translate(-50%, -50%)`;
  }
}

// ---------- photo pins ----------
function pinCanvas(img, aspect) {
  const W = 320, H = Math.round(W / aspect);
  const c = document.createElement('canvas');
  const pad = 26, frame = 12;
  c.width = W + pad * 2; c.height = H + pad * 2;
  const ctx = c.getContext('2d');
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(pad, pad, W, H);
  ctx.shadowColor = 'transparent';
  if (img) ctx.drawImage(img, pad + frame, pad + frame, W - frame * 2, H - frame * 2);
  else { ctx.fillStyle = '#c9c4b8'; ctx.fillRect(pad + frame, pad + frame, W - frame * 2, H - frame * 2); }
  return c;
}
function buildPin(photo) {
  removePin(photo.id);
  if (!photo.pin) return;
  const aspect = (photo.w && photo.h) ? photo.w / photo.h : 4 / 3;
  const group = new THREE.Group();
  group.userData = { kind: 'pin', id: photo.id };
  const tex = new THREE.CanvasTexture(pinCanvas(null, aspect));
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, toneMapped: false }));
  sprite.userData = { kind: 'pin', id: photo.id };
  sprite.material.userData.noClip = true;
  group.add(sprite);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
  line.renderOrder = 990;
  // The leader is decoration: only the card and the anchor dot pick as the pin, otherwise the
  // line's pick corridor would steal clicks from the wall around every pinned photo.
  line.raycast = () => {};
  group.add(line);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.035, 20), new THREE.MeshBasicMaterial({ color: 0xe8973a, side: THREE.DoubleSide }));
  dot.userData = { kind: 'pin', id: photo.id };
  group.add(dot);
  pinRoot.add(group);
  const rec = { group, sprite, line, dot, aspect };
  pinObjs[photo.id] = rec;
  const img = new Image();
  img.onload = () => {
    if (!pinObjs[photo.id]) return;
    sprite.material.map.dispose();
    const t = new THREE.CanvasTexture(pinCanvas(img, aspect));
    t.colorSpace = THREE.SRGBColorSpace;
    sprite.material.map = t; sprite.material.needsUpdate = true;
    requestRender(2);
  };
  img.src = photo.thumb;
  positionPin(photo, rec);
}
function positionPin(photo, rec) {
  const p = photo.pin;
  const n = new THREE.Vector3(p.nx || 0, p.ny == null ? 1 : p.ny, p.nz || 0).normalize();
  rec.anchor = new THREE.Vector3(p.x, p.y, p.z);
  rec.normal = n;
  rec.dot.position.copy(rec.anchor).addScaledVector(n, 0.004);
  rec.dot.lookAt(rec.anchor.clone().add(n));
  rec.size = p.size || 0.6;
}
function removePin(id) {
  const rec = pinObjs[id];
  if (!rec) return;
  pinRoot.remove(rec.group);
  rec.sprite.material.map.dispose(); rec.sprite.material.dispose();
  rec.line.geometry.dispose(); rec.line.material.dispose();
  rec.dot.geometry.dispose(); rec.dot.material.dispose();
  delete pinObjs[id];
}
function updatePins() {
  for (const id of Object.keys(pinObjs)) {
    const r = pinObjs[id];
    if (!r.anchor) continue;
    const d = camera.position.distanceTo(r.anchor);
    // Keep the card legible: never smaller than ~4% of the view height, never absurdly large.
    const s = THREE.MathUtils.clamp(Math.max(r.size, d * 0.075), 0.25, 3.5);
    const lift = 0.12 + s * 0.55;
    r.sprite.scale.set(s * r.aspect * 1.16, s * 1.16, 1);
    r.sprite.position.copy(r.anchor).addScaledVector(r.normal, lift);
    if (Math.abs(r.normal.y) < 0.5) r.sprite.position.y += s * 0.15;
    const pos = r.line.geometry.getAttribute('position');
    pos.setXYZ(0, r.anchor.x, r.anchor.y, r.anchor.z);
    pos.setXYZ(1, r.sprite.position.x, r.sprite.position.y, r.sprite.position.z);
    pos.needsUpdate = true;
  }
}
function buildAllPins() {
  for (const id of Object.keys(pinObjs)) removePin(id);
  for (const ph of prop.photos) if (ph.pin) buildPin(ph);
}
// Unpinned photos in gallery order, after `afterId` and wrapping round.
function nextUnpinned(afterId) {
  const list = prop.photos;
  const i = list.findIndex(ph => ph.id === afterId);
  for (let k = 1; k <= list.length; k++) {
    const ph = list[(i + k + list.length) % list.length];
    if (ph && !ph.pin && ph.id !== afterId) return ph;
  }
  return null;
}
function pinHint() {
  const ph = pinPhotoId && photoById(prop, pinPhotoId);
  if (!ph) return 'PIN PHOTO: add or choose a photo in the inspector, then click a surface.';
  const left = prop.photos.filter(p => !p.pin).length;
  return 'PIN PHOTO: click where "' + ph.name + '" was taken' + (pinBatch && left > 1 ? ' (' + left + ' to place; the next one follows)' : '') + '. Esc stops.';
}
function startPinMode(photoId) {
  showMarkers('pins');
  tool = 'pin';
  const first = nextUnpinned(null);
  pinPhotoId = photoId || (first && first.id) || pinPhotoId || (prop.photos[0] && prop.photos[0].id) || null;
  const ph = pinPhotoId && photoById(prop, pinPhotoId);
  // Placing a new photo chains on to the next unpinned one; MOVE PIN re-places just the one.
  pinBatch = !!(ph && !ph.pin);
  gizmo.detach();
  renderToolCol(); renderInspector();
  setHint(pinHint());
}
// What a pin lands on says where the photo belongs: the room in front of the surface (on the
// level at that height) and, on a vertical surface, the wall it sits on. This holds for a
// click on the scan as much as on the model, so photos placed on a Polycam mesh link too.
function levelAtHeight(y) {
  const sorted = prop.levels.slice().sort((a, b) => a.elevation - b.elevation);
  let found = sorted[0];
  for (const l of sorted) if (y >= l.elevation - 0.1) found = l;
  return found;
}
function linkPinToPlan(ph, hit) {
  ph.elementIds = ph.elementIds || [];
  const add = id => { if (id && !ph.elementIds.includes(id)) ph.elementIds.push(id); };
  if (hit.kind === 'wall') add(hit.id);
  else if (hit.kind === 'opening') add(hit.wallId);
  else if (hit.kind === 'room') add(hit.id);
  const p = hit.point, n = hit.normal;
  const qx = p.x + n.x * 0.15, qz = p.z + n.z * 0.15;
  const lvl = levelAtHeight(p.y);
  if (!lvl) return;
  const room = hit.kind === 'room' ? prop.rooms.find(r => r.id === hit.id)
    : roomsOn(prop, lvl.id).find(r => r.pts && r.pts.length > 2 && pointInPolygon(qx, qz, r.pts));
  if (room) ph.roomId = room.id;
  if (hit.kind === 'wall' || hit.kind === 'opening' || Math.abs(n.y) > 0.5) return;
  let best = null, bestD = Infinity;
  for (const w of wallsOn(prop, lvl.id)) {
    const dx = w.bx - w.ax, dy = w.by - w.ay, L2 = dx * dx + dy * dy;
    if (L2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((p.x - w.ax) * dx + (p.z - w.ay) * dy) / L2));
    const d = Math.hypot(p.x - (w.ax + t * dx), p.z - (w.ay + t * dy));
    if (d < (w.thickness || 0.114) / 2 + 0.2 && d < bestD) { bestD = d; best = w; }
  }
  if (best) add(best.id);
}
function placePin(e) {
  if (!pinPhotoId) { toast('Choose a photo first (or ADD PHOTO).', 'warn'); return; }
  const hit = pick(e, { ground: true, surfaceOnly: true, scans: true });
  if (!hit) return;
  const ph = photoById(prop, pinPhotoId);
  if (!ph) { pinPhotoId = null; renderInspector(); return; }
  const size = (ph.pin && ph.pin.size) || 0.6;
  ph.pin = { x: hit.point.x, y: hit.point.y, z: hit.point.z, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, size };
  linkPinToPlan(ph, hit);
  touch();
  buildPin(ph);
  const where = ph.roomId ? ' in ' + ((prop.rooms.find(r => r.id === ph.roomId) || {}).name || 'the room') : '';
  const next = pinBatch ? nextUnpinned(ph.id) : null;
  if (next) {
    pinPhotoId = next.id;
    renderInspector();
    setHint(pinHint());
    toast('Pinned "' + ph.name + '"' + where + '. Next: "' + next.name + '".', 'ok');
    requestRender(2);
    return;
  }
  pinBatch = false;
  tool = 'select';
  setSelection({ kind: 'pin', id: ph.id });
  toast('Photo pinned' + where + '. Click it to open, MOVE PIN to re-place.', 'ok');
  setHint('');
}
function flyToPin(id) {
  showMarkers('pins');
  flyToMarker(pinObjs[id]);
}
function flyToMarker(r) {
  if (!r) return;
  const dir = r.normal.clone();
  if (Math.abs(dir.y) > 0.8) dir.add(new THREE.Vector3(0.4, 0, 0.6)).normalize();
  const pos = r.anchor.clone().addScaledVector(dir, 3.2).add(new THREE.Vector3(0, 0.9, 0));
  if (mode === 'walk') setMode('orbit');
  flyTo(pos, r.anchor.clone(), 700);
}

// ---------- notes ----------
// A note is text pinned to a point in the model: right-click a surface and ADD NOTE HERE, or
// use the NOTE tool. It draws like a photo pin (anchor dot, leader, a card that stays
// legible from any distance), as a sticky note carrying its text. Notes live on the property
// (`notePins`) and link to the room and wall they sit on, as pinned photos do.
const NOTE_FONT = '500 30px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const NOTE_W = 300, NOTE_LINE = 38, NOTE_INSET = 20, NOTE_PAD = 24, NOTE_MAX_LINES = 6;
function noteById(id) { return prop.notePins.find(n => n.id === id) || null; }
function noteLines(ctx, text, width) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width <= width) { line = next; continue; }
      if (line) lines.push(line);
      // A word wider than the card is cut where it overflows.
      while (word.length > 1 && ctx.measureText(word).width > width) {
        let k = word.length - 1;
        while (k > 1 && ctx.measureText(word.slice(0, k)).width > width) k--;
        lines.push(word.slice(0, k));
        word = word.slice(k);
      }
      line = word;
    }
    lines.push(line);
  }
  while (lines.length > 1 && !lines[lines.length - 1]) lines.pop();
  if (lines.length > NOTE_MAX_LINES) {
    lines.length = NOTE_MAX_LINES;
    let last = lines[NOTE_MAX_LINES - 1];
    while (last && ctx.measureText(last + '…').width > width) last = last.slice(0, -1);
    lines[NOTE_MAX_LINES - 1] = last + '…';
  }
  return lines;
}
function noteCanvas(note, selected) {
  const c = document.createElement('canvas');
  let ctx = c.getContext('2d');
  ctx.font = NOTE_FONT;
  const inner = NOTE_W - NOTE_INSET * 2;
  const empty = !String(note.text || '').trim();
  const lines = empty ? ['(empty note)'] : noteLines(ctx, note.text, inner);
  const H = NOTE_INSET * 2 + lines.length * NOTE_LINE;
  c.width = NOTE_W + NOTE_PAD * 2; c.height = H + NOTE_PAD * 2;
  ctx = c.getContext('2d');   // resizing reset the context state
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 7;
  ctx.fillStyle = '#ffd23c';
  ctx.beginPath();
  // A sticky note with its bottom right corner folded up.
  const x0 = NOTE_PAD, y0 = NOTE_PAD, x1 = NOTE_PAD + NOTE_W, y1 = NOTE_PAD + H, fold = 26;
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1 - fold); ctx.lineTo(x1 - fold, y1); ctx.lineTo(x0, y1); ctx.closePath();
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#d9a922';
  ctx.beginPath(); ctx.moveTo(x1, y1 - fold); ctx.lineTo(x1 - fold, y1 - fold); ctx.lineTo(x1 - fold, y1); ctx.closePath(); ctx.fill();
  if (selected) {
    ctx.strokeStyle = '#e8973a'; ctx.lineWidth = 7; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1 - fold); ctx.lineTo(x1 - fold, y1); ctx.lineTo(x0, y1); ctx.closePath(); ctx.stroke();
  }
  ctx.font = NOTE_FONT;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = empty ? 'rgba(42,36,16,0.45)' : '#2a2410';
  lines.forEach((line, i) => ctx.fillText(line, x0 + NOTE_INSET, y0 + NOTE_INSET + NOTE_LINE * (i + 0.5)));
  return c;
}
function buildNote(note) {
  removeNote(note.id);
  const canvas = noteCanvas(note, !!(selection && selection.kind === 'note' && selection.id === note.id));
  const group = new THREE.Group();
  group.userData = { kind: 'note', id: note.id };
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The output pass tone-maps the whole frame; a little extra brightness keeps the paper yellow.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(1.1, 1.1, 1.1), transparent: true, depthTest: true, toneMapped: false }));
  sprite.userData = { kind: 'note', id: note.id };
  sprite.material.userData.noClip = true;
  group.add(sprite);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xf5d66a, transparent: true, opacity: 0.85, depthTest: false }));
  line.renderOrder = 990;
  line.raycast = () => {};   // decoration only, as on photo pins
  group.add(line);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 20), new THREE.MeshBasicMaterial({ color: 0xf2c33d, side: THREE.DoubleSide }));
  dot.userData = { kind: 'note', id: note.id };
  group.add(dot);
  noteRoot.add(group);
  const rec = { group, sprite, line, dot, aspect: canvas.width / canvas.height };
  noteObjs[note.id] = rec;
  const n = new THREE.Vector3(note.nx || 0, note.ny == null ? 1 : note.ny, note.nz || 0).normalize();
  rec.anchor = new THREE.Vector3(note.x, note.y, note.z);
  rec.normal = n;
  rec.dot.position.copy(rec.anchor).addScaledVector(n, 0.004);
  rec.dot.lookAt(rec.anchor.clone().add(n));
  rec.size = note.size || 0.45;
  requestRender(2);
}
function redrawNoteCard(id) {
  const note = noteRoot && noteById(id), rec = noteObjs[id];
  if (!note || !rec) return;
  const canvas = noteCanvas(note, !!(selection && selection.kind === 'note' && selection.id === id));
  rec.sprite.material.map.dispose();
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  rec.sprite.material.map = t; rec.sprite.material.needsUpdate = true;
  rec.aspect = canvas.width / canvas.height;
  requestRender(2);
}
function removeNote(id) {
  const rec = noteObjs[id];
  if (!rec) return;
  noteRoot.remove(rec.group);
  rec.sprite.material.map.dispose(); rec.sprite.material.dispose();
  rec.line.geometry.dispose(); rec.line.material.dispose();
  rec.dot.geometry.dispose(); rec.dot.material.dispose();
  delete noteObjs[id];
}
function updateNotes() {
  for (const id of Object.keys(noteObjs)) {
    const r = noteObjs[id];
    // The card is sized by its width, so a long note grows downwards, not wider. Far off it
    // grows with the distance, which keeps its text about 12 px tall on screen.
    const d = camera.position.distanceTo(r.anchor);
    const w = THREE.MathUtils.clamp(Math.max(r.size, d * 0.1), 0.2, 3.2) * 1.5;
    const h = w / r.aspect;
    r.sprite.scale.set(w, h, 1);
    r.sprite.position.copy(r.anchor).addScaledVector(r.normal, 0.12 + h * 0.55);
    if (Math.abs(r.normal.y) < 0.5) r.sprite.position.y += h * 0.2;
    const pos = r.line.geometry.getAttribute('position');
    pos.setXYZ(0, r.anchor.x, r.anchor.y, r.anchor.z);
    pos.setXYZ(1, r.sprite.position.x, r.sprite.position.y, r.sprite.position.z);
    pos.needsUpdate = true;
  }
}
function buildAllNotes() {
  for (const id of Object.keys(noteObjs)) removeNote(id);
  for (const n of prop.notePins) buildNote(n);
}
function noteWhere(note) {
  const room = note.roomId && prop.rooms.find(r => r.id === note.roomId);
  return room ? (room.name || 'the room') : '';
}
// The NOTE tool: a click on a surface opens the note editor there (or moves the note being moved).
function startNoteMode(moveId) {
  showMarkers('notes');
  movingNoteId = moveId || null;
  setTool('note');
}
function noteHint() {
  const n = movingNoteId && noteById(movingNoteId);
  return n ? 'MOVE NOTE: click where the note belongs. Esc stops.' : 'NOTE: click a surface to pin a note there (or right-click anywhere). Esc stops.';
}
function placeNote(e) {
  const hit = pick(e, { ground: true, surfaceOnly: true, scans: true });
  if (!hit) { toast('Click a surface: a wall, floor, scan or the ground.', 'warn'); return; }
  const moving = movingNoteId && noteById(movingNoteId);
  if (moving) {
    Object.assign(moving, anchorOf(hit));
    moving.roomId = ''; moving.elementIds = [];
    linkPinToPlan(moving, hit);
    touch();
    buildNote(moving);
    movingNoteId = null;
    setTool('select');
    setSelection({ kind: 'note', id: moving.id });
    toast('Note moved' + (noteWhere(moving) ? ' to ' + noteWhere(moving) : '') + '.', 'ok');
    return;
  }
  openNoteEditor({ hit, at: { x: e.clientX, y: e.clientY } });
}
function anchorOf(hit) {
  return { x: hit.point.x, y: hit.point.y, z: hit.point.z, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z };
}
function addNote(hit, text) {
  const note = Object.assign({ id: uid('note'), text, roomId: '', elementIds: [], createdAt: new Date().toISOString() }, anchorOf(hit));
  // Where a note lands says where it belongs, as for a photo pin: the room and wall there.
  linkPinToPlan(note, hit);
  prop.notePins.push(note);
  showMarkers('notes');
  touch();
  buildNote(note);
  if (tool === 'note') setTool('select');
  setSelection({ kind: 'note', id: note.id });
  toast('Note pinned' + (noteWhere(note) ? ' in ' + noteWhere(note) : '') + '. Right-click it to edit, move or delete.', 'ok');
  return note;
}
function deleteNote(id) {
  const note = noteById(id);
  if (!note) return;
  prop.notePins = prop.notePins.filter(n => n.id !== id);
  removeNote(id);
  touch();
  if (selection && selection.kind === 'note' && selection.id === id) setSelection(null);
  else { renderInspector(); requestRender(2); }
  toast('Note deleted.', 'ok');
}
function flyToNote(id) {
  showMarkers('notes');
  flyToMarker(noteObjs[id]);
}

// The note editor floats where the note goes. Enter saves, Shift+Enter starts a new line.
function openNoteEditor(opts) {
  closeNoteEditor();
  closeContextMenu();
  const note = opts.note || null;
  const box = document.createElement('div');
  box.className = 'v-note-edit';
  box.innerHTML = `<label>${note ? 'EDIT NOTE' : 'NEW NOTE'}</label>
    <textarea rows="3" maxlength="2000" placeholder="Type the note. Enter saves; Shift+Enter adds a line."></textarea>
    <div class="v-note-actions"><button class="btn small" data-cancel>CANCEL</button><button class="btn small primary" data-save>${note ? 'SAVE' : 'PIN NOTE'}</button></div>`;
  wrapEl.appendChild(box);
  const rect = wrapEl.getBoundingClientRect();
  const x = THREE.MathUtils.clamp(opts.at.x - rect.left + 12, 8, Math.max(8, rect.width - box.offsetWidth - 8));
  const y = THREE.MathUtils.clamp(opts.at.y - rect.top + 12, 8, Math.max(8, rect.height - box.offsetHeight - 8));
  box.style.left = x + 'px'; box.style.top = y + 'px';
  const ta = box.querySelector('textarea');
  ta.value = note ? note.text || '' : '';
  noteEditor = box;
  const save = () => {
    const text = ta.value.trim();
    closeNoteEditor();
    if (note) {
      if (text === (note.text || '')) return;
      if (!text) { toast('A note needs text; DELETE NOTE removes it.', 'warn'); return; }
      note.text = text; note.updatedAt = new Date().toISOString();
      touch(); redrawNoteCard(note.id); renderInspector();
      return;
    }
    if (text) addNote(opts.hit, text);
  };
  ta.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeNoteEditor(); }
  };
  box.querySelector('[data-save]').onclick = save;
  box.querySelector('[data-cancel]').onclick = closeNoteEditor;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
function closeNoteEditor() {
  if (noteEditor) { noteEditor.remove(); noteEditor = null; }
}

// ---------- right-click menu ----------
function openContextMenu(e) {
  closeContextMenu();
  closeNoteEditor();
  const hit = pick(e, { ground: true, scans: true });
  const at = { x: e.clientX, y: e.clientY };
  const items = [];
  if (hit && hit.kind === 'note') {
    items.push(['edit', 'EDIT NOTE', () => openNoteEditor({ note: noteById(hit.id), at })]);
    items.push(['move', 'MOVE NOTE', () => { setSelection({ kind: 'note', id: hit.id }); startNoteMode(hit.id); }]);
    items.push(['delete', 'DELETE NOTE', () => deleteNote(hit.id)]);
  } else if (hit && hit.kind === 'pin') {
    items.push(['photo', 'OPEN PHOTO', () => { setSelection({ kind: 'pin', id: hit.id }); openLightbox(hit.id); }]);
  } else if (hit) {
    items.push(['add-note', 'ADD NOTE HERE', () => openNoteEditor({ hit, at })]);
  } else {
    items.push(['none', 'Right-click a surface to pin a note', null]);
  }
  const nNotes = prop.notePins.length, nPins = prop.photos.filter(ph => ph.pin).length;
  items.push(null);
  items.push(['toggle-notes', (markersShown('notes') ? 'HIDE NOTES' : 'SHOW NOTES') + ' (' + nNotes + ')', () => toggleMarkers('notes')]);
  items.push(['toggle-pins', (markersShown('pins') ? 'HIDE PHOTO PINS' : 'SHOW PHOTO PINS') + ' (' + nPins + ')', () => toggleMarkers('pins')]);
  const menu = document.createElement('div');
  menu.className = 'v-ctx';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map(it => !it ? '<div class="v-ctx-sep"></div>'
    : it[2] ? `<button role="menuitem" data-ctx="${it[0]}">${escapeHtml(it[1])}</button>`
    : `<div class="v-ctx-info">${escapeHtml(it[1])}</div>`).join('');
  wrapEl.appendChild(menu);
  const rect = wrapEl.getBoundingClientRect();
  menu.style.left = THREE.MathUtils.clamp(at.x - rect.left, 4, Math.max(4, rect.width - menu.offsetWidth - 4)) + 'px';
  menu.style.top = THREE.MathUtils.clamp(at.y - rect.top, 4, Math.max(4, rect.height - menu.offsetHeight - 4)) + 'px';
  for (const it of items) {
    if (!it || !it[2]) continue;
    menu.querySelector(`[data-ctx="${it[0]}"]`).onclick = () => { closeContextMenu(); it[2](); };
  }
  menu.addEventListener('contextmenu', ev => ev.preventDefault());
  ctxMenu = menu;
  // Any press elsewhere, a scroll or Esc closes it.
  setTimeout(() => { if (ctxMenu === menu) window.addEventListener('pointerdown', onOutsideMenu, true); }, 0);
  const first = menu.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}
function onOutsideMenu(e) { if (ctxMenu && !ctxMenu.contains(e.target)) closeContextMenu(); }
function closeContextMenu() {
  window.removeEventListener('pointerdown', onOutsideMenu, true);
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}

// ---------- photo pins and notes on and off ----------
// Both are kept per property in the environment, so a property opens the way it was left.
function markersShown(kind) { return prop.env[kind === 'notes' ? 'showNotes' : 'showPins'] !== false; }
function applyMarkerVisibility() {
  if (pinRoot) pinRoot.visible = markersShown('pins');
  if (noteRoot) noteRoot.visible = markersShown('notes');
  const sel = selection && (selection.kind === 'pin' || selection.kind === 'note') ? selectedObject() : null;
  if (sel && !isVisibleChain(sel)) setSelection(null);
  requestRender(2);
}
function toggleMarkers(kind, on) {
  const key = kind === 'notes' ? 'showNotes' : 'showPins';
  const next = on == null ? !markersShown(kind) : !!on;
  if (next === markersShown(kind)) return;
  prop.env[key] = next;
  applyMarkerVisibility();
  touch();
  renderHud();
  renderInspector();
}
// Placing, moving or locating a pin or note shows that kind first.
function showMarkers(kind) { toggleMarkers(kind, true); }

// ---------- lightbox ----------
async function openLightbox(photoId) {
  const ph = photoById(prop, photoId);
  if (!ph) return;
  const url = await photoUrl(photoId);
  const box = document.createElement('div');
  box.className = 'v-lightbox';
  box.innerHTML = `<img alt="" src="${escapeHtml(url || ph.thumb)}"><div class="v-lb-cap">${escapeHtml(ph.name || '')}${ph.notes ? ' - ' + escapeHtml(ph.notes) : ''}</div><button class="v-lb-close">CLOSE</button>`;
  const close = () => { box.remove(); window.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  box.onclick = close;
  window.addEventListener('keydown', onKey);
  document.body.appendChild(box);
}

// ---------- scans ----------
const hooks = {
  progress(label, frac) { showProgress(label, frac); },
  toast(msg, kind) { toast(msg, kind); },
  get renderer() { return renderer; },
  get scene() { return scene; },
  requestRender() { requestRender(3); },
};
const errMsg = e => String(e && e.message || e);
function scanSelected(id) { return selection && selection.kind === 'scan' && selection.id === id; }
function setScanState(id, state) {
  scanState[id] = state;
  // The inspector captured the object (or its absence) when it rendered: refresh it.
  if (scanSelected(id)) renderInspector();
}
// Load a scan record into the scene. Resolves null when the bytes are missing, the record was
// deleted while parsing, or the view was unmounted (the parsed object is disposed, not leaked).
async function addScanToScene(scan) {
  const token = mountId;
  setScanState(scan.id, 'loading');
  let obj = null;
  try { obj = await loadScanObject(scan, hooks); }
  catch (e) { if (token === mountId) setScanState(scan.id, 'failed'); throw e; }
  if (token !== mountId || !scene) { disposeScanObject(obj); return null; }
  if (!prop.scans.some(s => s.id === scan.id)) { disposeScanObject(obj); delete scanState[scan.id]; return null; }
  if (!obj) { setScanState(scan.id, 'missing'); return null; }
  if (scanObjs[scan.id]) { scanRoot.remove(scanObjs[scan.id]); disposeScanObject(scanObjs[scan.id]); }
  scanObjs[scan.id] = obj;
  applyScanTransform(scan, obj);
  scanRoot.add(obj);
  setModelXray(obj, xray ? prop.env.xrayOpacity : null);
  fitShadow();
  applyEnvironment();
  applySection();
  updateOutlineTargets();
  setScanState(scan.id, 'ready');
  requestRender(scan.kind === 'splat' ? 8 : 3);
  return obj;
}
async function loadAllScans() {
  const token = mountId;
  for (const scan of prop.scans.slice()) {
    try { await addScanToScene(scan); }
    catch (e) { console.error(e); if (token === mountId) toast('Could not load scan ' + scan.name + ': ' + errMsg(e), 'error'); }
    if (token !== mountId || !scene) return;
  }
  renderToolCol();
}
// Scan to plan on a mesh scan that is already here. Without a plan the proposal becomes the
// plan. A scan the plan already came from is proposed again over the floor it matches (after
// asking). Any other scan is fitted against the plan and the person says what it is: the
// next floor, a rescan of a floor, a separate building, or reference only. Then the scan
// moves onto its place and the model rebuilds.
let planning = false;
async function proposePlanFromScan(s) {
  if (planning) return;
  const again = !!s.planned && prop.walls.length > 0;
  if (again && !confirm('Propose the plan from "' + s.name + '" again? The floor it matches is rebuilt from the scan; other floors, the scan and photos stay, and scope links to the rebuilt walls are dropped.')) return;
  const token = mountId;
  planning = true;
  try {
    const rec = await getFile(s.id);
    if (!rec || !rec.buffer) throw new Error('the scan bytes are not in this browser');
    const choose = again ? () => 'replace' : fit => chooseScanPlacement(fit, s.name);
    const { result, applied, mode } = await placeScanBytes(prop, s, rec.buffer, hooks, choose);
    if (token !== mountId) return;
    if (mode === 'reference') { toast('Kept ' + s.name + ' as reference; the plan is unchanged.', 'info'); return; }
    for (const id of (applied && applied.superseded) || []) {
      const old = scanObjs[id];
      if (old) { scanRoot.remove(old); disposeScanObject(old); delete scanObjs[id]; }
      delete scanState[id];
    }
    if (applied) {
      const added = mode === 'level' || mode === 'beside';
      const label = prop.name + ': scope from ' + (added ? s.name : 'scan');
      const project = seedProject(prop, applied, label);
      if (project && (added || !ws.data.projects.some(p => p.propertyId === prop.id && /scope from scan/i.test(p.name)))) { ws.data.projects.push(project); touch(); }
    }
    const obj = scanObjs[s.id];
    if (obj) applyScanTransform(s, obj);
    rebuildModel(); rebuildGround(); buildAllPins();
    presetView('frame');
    renderToolCol(); renderInspector();
    toast('Proposed: ' + proposalSummary(result, applied) + '.', applied ? 'ok' : 'warn', 6000);
  } catch (e) {
    console.error(e);
    if (token === mountId) toast('Could not propose a plan: ' + errMsg(e), 'error', 6000);
  } finally {
    planning = false;
    if (token === mountId) showProgress(null);
  }
}

// ---------- HUD ----------
function toast(msg, kind, ms) {
  const t = hud.toast;
  if (!t) return;
  t.textContent = msg;
  t.className = 'v-toast show ' + (kind || 'info');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'v-toast'; }, ms || 3500);
}
function setHint(text) {
  if (!hud.hint) return;
  hud.hint.textContent = text || defaultHint();
}
function defaultHint() {
  if (mode === 'walk') return walkLocked ? 'WALK: WASD / arrows move, Shift runs, mouse looks. Esc releases the mouse.' : 'WALK: WASD / arrows move, Shift runs. Drag to look or click to capture the mouse. Esc exits.';
  if (tool === 'measure') return 'MEASURE: click two points on any surface.';
  if (tool === 'pin') return 'PIN PHOTO: choose a photo, then click a surface.';
  if (tool === 'note') return noteHint();
  if (tool === 'move') return 'MOVE WALLS: select a wall, drag the gizmo arrow to slide it; connected walls follow on release.';
  if (section.on) return 'SECTION: slide the cut height in the mode bar to look inside.';
  return 'Drag to orbit, right-drag to pan, scroll to zoom. Click elements to inspect; right-click to pin a note.';
}
function showProgress(label, frac) {
  const p = hud.progress;
  if (!p) return;
  if (label == null) { p.classList.remove('show'); return; }
  p.classList.add('show');
  p.querySelector('.v-prog-label').textContent = label;
  p.querySelector('.v-prog-fill').style.width = Math.round((frac == null ? 0.5 : frac) * 100) + '%';
}
function updateCompass() {
  if (!hud.compass) return;
  camera.getWorldDirection(_v);
  const N = northVector(), E = eastVector();
  const hv = Math.atan2(_v.dot(E), _v.dot(N));
  hud.compass.style.transform = 'rotate(' + (-hv * 180 / Math.PI).toFixed(1) + 'deg)';
}
function renderHud() {
  const bar = hud.modes;
  if (!bar) return;
  const H = modelTop(), lo = Math.min(0.3, lowestElevation() + 0.3);
  bar.innerHTML = `
    <button class="v-pill ${mode === 'orbit' ? 'active' : ''}" data-mode="orbit" title="Orbit (O)">ORBIT</button>
    <button class="v-pill ${mode === 'walk' ? 'active' : ''}" data-mode="walk" title="Walk through (W)">WALK</button>
    <button class="v-pill ${mode === 'top' ? 'active' : ''}" data-mode="top" title="Top, north up (T)">TOP</button>
    <span class="v-pill-sep"></span>
    <button class="v-pill ${section.on ? 'active' : ''}" data-section title="Section cut (C)">SECTION</button>
    ${section.on ? `<input type="range" class="v-section-range" min="${lo.toFixed(2)}" max="${(H + 0.3).toFixed(2)}" step="0.05" value="${section.height}" title="Cut height (world elevation)">
      <span class="v-section-val">${escapeHtml(fmtLen(section.height))}</span>` : ''}
    <span class="v-pill-sep"></span>
    <button class="v-pill ${xray ? 'active' : ''}" data-xray aria-pressed="${xray}" title="X-ray (X)">X-RAY</button>
    ${xray ? `<label class="v-xray-control">TRANSPARENCY<input type="range" class="v-xray-range" min="0" max="100" step="1" value="${Math.round((1 - prop.env.xrayOpacity) * 100)}" aria-label="X-ray transparency"><output>${Math.round((1 - prop.env.xrayOpacity) * 100)}%</output></label>` : ''}
    <span class="v-pill-sep"></span>
    <button class="v-pill" data-environment title="Sun and environment settings">SUN</button>
    <button class="v-pill ${markersShown('pins') ? 'active' : ''}" data-show="pins" aria-pressed="${markersShown('pins')}" title="${markersShown('pins') ? 'Hide' : 'Show'} photo pins (${prop.photos.filter(ph => ph.pin).length})">PHOTOS</button>
    <button class="v-pill ${markersShown('notes') ? 'active' : ''}" data-show="notes" aria-pressed="${markersShown('notes')}" title="${markersShown('notes') ? 'Hide' : 'Show'} notes (${prop.notePins.length}); right-click the model to pin one">NOTES</button>`;
  bar.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  bar.querySelectorAll('[data-show]').forEach(b => b.onclick = () => toggleMarkers(b.dataset.show));
  bar.querySelector('[data-section]').onclick = toggleSection;
  bar.querySelector('[data-xray]').onclick = toggleXray;
  bar.querySelector('[data-environment]').onclick = () => { hud.env.hidden = !hud.env.hidden; hud.env.classList.add('open'); renderEnvPanel(); };
  const xr = bar.querySelector('.v-xray-range');
  if (xr) {
    xr.oninput = () => {
      prop.env.xrayOpacity = 1 - Number(xr.value) / 100;
      bar.querySelector('.v-xray-control output').textContent = xr.value + '%';
      applyXray();
    };
    xr.onchange = () => touch();
  }
  const range = bar.querySelector('.v-section-range');
  if (range) range.oninput = () => {
    section.height = parseFloat(range.value);
    bar.querySelector('.v-section-val').textContent = fmtLen(section.height);
    applySection();
  };
  setHint('');
}
function toggleSection() {
  section.on = !section.on;
  if (section.on && (section.height > modelTop() || section.height < lowestElevation())) {
    // Default cut: waist height on the lowest level.
    const lo = lowestElevation();
    const H0 = levelHeight(prop, prop.levels.find(l => l.elevation === lo).id);
    section.height = lo + Math.min(1.2, H0 * 0.5);
  }
  applySection();
  renderHud();
}
// Show or hide one storey: the level group flips, its lamps and section caps follow, and a
// selection that just vanished is dropped (picking already skips invisible groups).
function toggleLevel(id) {
  const hidden = hiddenLevels();
  if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
  const levels = modelGroup && modelGroup.userData.levels;
  if (levels) for (const l of levels) l.group.visible = !hidden.has(l.id);
  rebuildNightLights();
  applySection();
  const sel = selectedObject();
  if (sel && !isVisibleChain(sel)) { setSelection(null); return; }
  updateOutlineTargets();
  renderToolCol();
  requestRender(3);
}
function applyXray() {
  const opacity = xray ? prop.env.xrayOpacity : null;
  setModelXray(modelGroup, opacity);
  for (const obj of Object.values(scanObjs)) setModelXray(obj, opacity);
  applySection();
  requestRender(3);
}
function toggleXray() { xray = !xray; applyXray(); renderHud(); renderToolCol(); }

// ---------- environment panel ----------
function sunLabel(el) { return el >= 0 ? 'SUN ' + Math.round(el) + '&deg;' : (el > -6 ? 'TWILIGHT' : 'NIGHT'); }
function renderEnvPanel(p = hud.env) {
  if (!p) return;
  const env = prop.env;
  const { elevation: el } = currentSun();
  const panos = prop.photos.filter(ph => ph.kind === 'pano');
  const minutes = Math.round(env.time * 60);
  const timeLabel = String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  const year = Number(env.date.slice(0, 4));
  p.innerHTML = `
    <button class="v-env-head" data-toggle><span>ENVIRONMENT</span><span class="v-env-sun">${sunLabel(el)} &middot; ${timeLabel}</span><span class="v-env-caret">${p.classList.contains('open') ? '&#9662;' : '&#9656;'}</span></button>
    <div class="v-env-body">
      <label class="v-row v-row-sel"><span>SUN PATH</span><select data-env="sunMode"><option value="manual" ${env.sunMode !== 'location' ? 'selected' : ''}>Manual lighting</option><option value="location" ${env.sunMode === 'location' ? 'selected' : ''}>Location + date</option></select></label>
      ${env.sunMode === 'location' ? `
        <label class="v-row v-row-sel"><span>LATITUDE</span><input type="number" min="-90" max="90" step="any" data-env="latitude" value="${env.latitude == null ? '' : finiteNum(env.latitude, 0)}" placeholder="Degrees, north +" required></label>
        <label class="v-row v-row-sel"><span>LONGITUDE</span><input type="number" min="-180" max="180" step="any" data-env="longitude" value="${env.longitude == null ? '' : finiteNum(env.longitude, 0)}" placeholder="Degrees, east +" required></label>
        <label class="v-row v-row-sel"><span>TIME ZONE</span><input data-env="timeZone" value="${escapeHtml(env.timeZone)}" placeholder="America/New_York" required></label>
        <label class="v-row v-row-sel"><span>DATE</span><input type="date" data-env="date" value="${escapeHtml(env.date)}" min="1900-01-01" max="2100-12-31" required></label>
        <label class="v-row"><span>DAY OF YEAR</span><input type="range" min="1" max="${daysInYear(year)}" step="1" value="${dayOfYear(env.date)}" data-env="dayOfYear"><em>${dayOfYear(env.date)}</em></label>
        <p class="v-env-help">Site coordinates; time zone adjusts for daylight saving. Set NORTH to match the model.</p>
      ` : ''}
      <p class="v-env-help" data-sun-status role="status"></p>
      <label class="v-row"><span>TIME</span><input type="range" min="0" max="24" step="0.1" value="${finiteNum(env.time, 14.5)}" data-env="time"><em data-time-readout>${timeLabel}</em></label>
      ${env.sunMode !== 'location' ? `<label class="v-row"><span>SUN AZIMUTH</span><input type="range" min="0" max="360" step="1" value="${finiteNum(env.azimuth, 200)}" data-env="azimuth"><em>${Math.round(finiteNum(env.azimuth, 200))}&deg;</em></label>` : ''}
      <label class="v-row"><span>NORTH</span><input type="range" min="0" max="360" step="1" value="${finiteNum(env.north, 0)}" data-env="north"><em>${Math.round(finiteNum(env.north, 0))}&deg;</em></label>
      <label class="v-row"><span>EXPOSURE</span><input type="range" min="0.3" max="2.2" step="0.05" value="${finiteNum(env.exposure, 1)}" data-env="exposure"><em>${finiteNum(env.exposure, 1).toFixed(2)}</em></label>
      <div class="v-row v-row-sel"><span>SKY</span>
        <select data-env="sky"><option value="dynamic" ${env.sky === 'dynamic' ? 'selected' : ''}>Dynamic sun</option><option value="studio" ${env.sky === 'studio' ? 'selected' : ''}>Studio</option><option value="pano" ${env.sky === 'pano' ? 'selected' : ''}>Panorama</option></select>
        ${env.sky === 'pano' ? `<select data-env="panoPhotoId"><option value="">(choose pano)</option>${panos.map(ph => `<option value="${escapeHtml(ph.id)}" ${ph.id === env.panoPhotoId ? 'selected' : ''}>${escapeHtml(ph.name)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="v-row v-row-sel"><span>QUALITY</span>
        <select data-env="quality"><option value="ultra" ${env.quality === 'ultra' ? 'selected' : ''}>Ultra (detail + 32-sample AO)</option><option value="high" ${env.quality === 'high' ? 'selected' : ''}>High (AO + bloom)</option><option value="medium" ${env.quality === 'medium' ? 'selected' : ''}>Medium</option><option value="low" ${env.quality === 'low' ? 'selected' : ''}>Low</option></select>
      </div>
      <div class="v-checks">
        <label><input type="checkbox" data-env="showCeilings" ${env.showCeilings !== false ? 'checked' : ''}> CEILINGS</label>
        <label><input type="checkbox" data-env="showGround" ${env.showGround !== false ? 'checked' : ''}> GROUND</label>
        <label><input type="checkbox" data-env="showGrid" ${env.showGrid ? 'checked' : ''}> GRID</label>
        <label><input type="checkbox" data-env="nightLights" ${env.nightLights !== false ? 'checked' : ''}> NIGHT LIGHTS</label>
      </div>
    </div>`;
  p.querySelector('[data-toggle]').onclick = () => { p.classList.toggle('open'); renderEnvPanel(p); };
  let touchTimer = 0;
  const commit = () => { clearTimeout(touchTimer); touchTimer = setTimeout(() => touch(), 400); };
  const updateSun = () => {
    const status = p.querySelector('[data-sun-status]');
    try {
      const sun = environmentSun(env);
      const minutes = Math.round(env.time * 60);
      const clock = String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
      p.querySelector('[data-time-readout]').textContent = clock;
      p.querySelector('.v-env-sun').innerHTML = sunLabel(sun.elevation) + ' &middot; ' + clock;
      status.textContent = env.sunMode === 'location' ? 'Sun azimuth ' + Math.round(sun.azimuth) + '° · elevation ' + Math.round(sun.elevation) + '°' : '';
    } catch (e) { status.textContent = e.message + ' Manual lighting shown.'; }
  };
  updateSun();
  p.querySelectorAll('input[type=range]').forEach(r => {
    r.oninput = () => {
      const key = r.dataset.env;
      if (key === 'dayOfYear') {
        env.date = dateForDay(year, Number(r.value));
        p.querySelector('[data-env=date]').value = env.date;
      } else env[key] = Number(r.value);
      const em = r.parentElement.querySelector('em');
      if (em) em.textContent = key === 'exposure' ? Number(r.value).toFixed(2) : Math.round(r.value) + (key === 'dayOfYear' ? '' : '°');
      updateSun(); applyEnvironment(); commit();
    };
  });
  p.querySelectorAll('input:not([type=range]):not([type=checkbox])').forEach(input => {
    input.onchange = () => {
      input.setCustomValidity('');
      if (input.dataset.env === 'timeZone' && !validTimeZone(input.value.trim())) input.setCustomValidity('Enter an IANA time zone, such as America/New_York.');
      if (!input.reportValidity()) return;
      env[input.dataset.env] = input.type === 'number' ? input.valueAsNumber : input.value.trim();
      applyEnvironment(); touch(); renderEnvPanel(p);
    };
  });
  p.querySelectorAll('select').forEach(s => {
    s.onchange = () => {
      env[s.dataset.env] = s.value || null;
      if (s.dataset.env === 'quality') { setTextureQuality(env.quality); rebuildModel(); applyQuality(); }
      if (s.dataset.env === 'sky') rebuildGround();
      if (s.dataset.env === 'panoPhotoId') panoMissing = null;   // a fresh choice gets a fresh try
      applyEnvironment();
      touch();
      renderEnvPanel(p);
    };
  });
  p.querySelectorAll('input[type=checkbox]').forEach(c => {
    c.onchange = () => {
      env[c.dataset.env] = c.checked;
      if (c.dataset.env === 'showGrid') rebuildGround();
      if (c.dataset.env === 'showGround') groundGroup.visible = c.checked;
      applyEnvironment();
      touch();
    };
  });
}

export function mountEnvironmentSettings(host) {
  host.className='v-env open file-env';
  renderEnvPanel(host);
}

// ---------- inspector ----------
// Numbers from saved data go into attributes: anything that is not a finite number becomes the fallback.
function finiteNum(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function scopeAssignHtml(elementId) {
  let current = '';
  for (const pr of ws.data.projects) for (const it of pr.items) if ((it.elementIds || []).includes(elementId)) current = it.id;
  const groups = ws.data.projects.map(pr => {
    const opts = pr.items.map(it => `<option value="${escapeHtml(it.id)}" ${it.id === current ? 'selected' : ''}>${escapeHtml(it.name)}</option>`).join('');
    return opts ? `<optgroup label="${escapeHtml(projectLabel(pr))}">${opts}</optgroup>` : '';
  }).join('');
  return `<div class="field"><label>Scope item (digital twin link)</label>
    <select data-assign="${escapeHtml(elementId)}"><option value="">(not assigned)</option>${groups}</select></div>`;
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
    linked.map(p => `<div class="stat-line"><span>${escapeHtml(p.name)}</span><b>${p.price ? '$' + Math.round(p.price).toLocaleString() : ''}</b></div><button class="btn small" data-research-product="${escapeHtml(p.id)}" data-research-element="${escapeHtml(elementId)}">RESEARCH PRODUCT</button>`).join('') + `</div>`;
}

function researchButtonHtml(elementId, role, label) {
  return `<button class="btn" data-research-role="${role}" data-research-element="${escapeHtml(elementId)}">${label}</button>`;
}
function bindResearchActions(root) {
  root.querySelectorAll('[data-research-role], [data-research-product]').forEach(button => {
    button.onclick = async () => {
      const elementId = button.dataset.researchElement;
      const role = button.dataset.researchRole;
      const wall = prop.walls.find(w => w.id === elementId);
      const room = prop.rooms.find(r => r.id === elementId);
      const opening = prop.openings.find(o => o.id === elementId);
      const elementKind = wall ? 'wall' : room ? 'room' : 'opening';
      let context;
      if (button.dataset.researchProduct) {
        const product = ws.data.products.find(p => p.id === button.dataset.researchProduct);
        if (!product) return;
        context = { kind: 'product', id: product.id, name: product.name, itemIds: product.itemIds || [], category: product.category || '', propertyId: prop.id, elementId, elementKind };
      } else if (role === 'fixture' && opening) {
        const name = opening.type === 'window' ? 'Window' : opening.width > 1.25 ? 'Cased opening' : 'Door';
        context = { kind: 'fixture', id: opening.id, name, category: opening.type, dimensions: opening.width + ' m wide × ' + opening.height + ' m high', propertyId: prop.id, elementId, elementKind };
      } else {
        const materialId = role === 'interior' ? wallInteriorMaterialId(wall, roomsOn(prop, levelOfWall(prop, wall).id)) : role === 'ceiling' ? room?.ceilingMaterial || 'mat-ceiling' : wall?.material || room?.material;
        const material = materialById(materialId);
        if (!material) { toast('Choose a material first.', 'warn'); return; }
        context = { kind: 'material', id: material.id, materialId: material.id, name: material.name, category: material.kind, finish: material.pattern, propertyId: prop.id, elementId, elementKind };
      }
      // Only the clicked element's description and local linking IDs enter the research view.
      try { const { openResearch } = await import('./research.js'); openResearch(context); }
      catch (e) { toast('Could not open research: ' + e.message, 'error'); }
    };
  });
}
function bindAssign(root) {
  root.querySelectorAll('[data-assign]').forEach(sel => {
    sel.onchange = () => {
      const elId = sel.dataset.assign;
      for (const pr of ws.data.projects) for (const it of pr.items) it.elementIds = (it.elementIds || []).filter(x => x !== elId);
      if (sel.value) {
        const found = itemById(sel.value);
        if (found) (found.item.elementIds = found.item.elementIds || []).push(elId);
      }
      touch();
    };
  });
}
function photoLinksHtml(elementId) {
  const linked = prop.photos.filter(ph => (ph.elementIds || []).includes(elementId) || ph.roomId === elementId);
  if (!linked.length) return '';
  return `<div class="field"><label>Photos</label><div class="v-thumbs small">${linked.map(ph =>
    `<button class="v-thumb" data-open-photo="${escapeHtml(ph.id)}" title="${escapeHtml(ph.name)}"><img src="${escapeHtml(ph.thumb)}" alt=""></button>`).join('')}</div></div>`;
}
function bindPhotoLinks(root) {
  root.querySelectorAll('[data-open-photo]').forEach(b => b.onclick = () => openLightbox(b.dataset.openPhoto));
}

function pinsListHtml() {
  const pinned = prop.photos.filter(ph => ph.pin);
  if (!pinned.length) return '';
  return `<h3 style="margin-top:14px">PHOTO PINS</h3>` + pinned.map(ph => `
    <div class="v-pin-row">
      <img src="${escapeHtml(ph.thumb)}" alt="">
      <span class="v-pin-name">${escapeHtml(ph.name)}</span>
      <button class="btn small" data-locate="${escapeHtml(ph.id)}" title="Fly to pin">LOCATE</button>
      <button class="btn small danger" data-unpin="${escapeHtml(ph.id)}" title="Remove pin">&times;</button>
    </div>`).join('');
}
function bindPinsList(root) {
  root.querySelectorAll('[data-locate]').forEach(b => b.onclick = () => { setSelection({ kind: 'pin', id: b.dataset.locate }); flyToPin(b.dataset.locate); });
  root.querySelectorAll('[data-unpin]').forEach(b => b.onclick = () => unpin(b.dataset.unpin));
}
function notesListHtml() {
  if (!prop.notePins.length) return '';
  const hidden = markersShown('notes') ? '' : ' <span class="muted">(hidden)</span>';
  return `<h3 style="margin-top:14px">NOTES${hidden}</h3>` + prop.notePins.map(n => `
    <div class="v-pin-row v-note-row">
      <i class="v-note-chip" aria-hidden="true"></i>
      <span class="v-pin-name" title="${escapeHtml(n.text)}">${escapeHtml(n.text || '(empty note)')}</span>
      <button class="btn small" data-locate-note="${escapeHtml(n.id)}" title="Fly to note">LOCATE</button>
      <button class="btn small danger" data-delete-note="${escapeHtml(n.id)}" title="Delete note">&times;</button>
    </div>`).join('');
}
function bindNotesList(root) {
  root.querySelectorAll('[data-locate-note]').forEach(b => b.onclick = () => { flyToNote(b.dataset.locateNote); setSelection({ kind: 'note', id: b.dataset.locateNote }); });
  root.querySelectorAll('[data-delete-note]').forEach(b => b.onclick = () => deleteNote(b.dataset.deleteNote));
}
function unpin(id) {
  const ph = photoById(prop, id);
  if (!ph) return;
  ph.pin = null;
  removePin(id);
  touch();
  if (selection && selection.kind === 'pin' && selection.id === id) setSelection(null);
  else { renderInspector(); requestRender(2); }
}

function renderPinPanel() {
  const total = prop.photos.length, placed = prop.photos.filter(ph => ph.pin).length;
  const cur = pinPhotoId && photoById(prop, pinPhotoId);
  inspEl.innerHTML = `<h3>PIN PHOTO</h3>
    ${cur ? `<div class="v-thumb big active"><img src="${escapeHtml(cur.thumb)}" alt=""></div>
      <div class="stat-line"><span>Placing</span><b>${escapeHtml(cur.name)}</b></div>` : ''}
    ${total ? `<div class="stat-line"><span>Pinned</span><b>${placed} of ${total}</b></div>` : ''}
    <div class="empty">Click the wall, floor or scan surface where the photo was taken. It links to the room and wall there${pinBatch ? ', then the next unpinned photo comes up' : ''}. Pick another photo below to place it instead.</div>
    <div class="v-thumbs">${prop.photos.map(ph => `<button class="v-thumb ${ph.id === pinPhotoId ? 'active' : ''}" data-pick="${escapeHtml(ph.id)}" title="${escapeHtml(ph.name)}"><img src="${escapeHtml(ph.thumb)}" alt="">${ph.pin ? '<i class="v-pinned">PINNED</i>' : ''}</button>`).join('')}</div>
    ${total ? '' : '<div class="empty" style="margin-top:8px">No photos on this property yet.</div>'}
    <button class="btn primary" data-add>ADD PHOTOS</button>
    <input type="file" class="hidden-file" accept="image/*" multiple>
    <button class="btn" data-cancel>${placed ? 'DONE' : 'CANCEL'}</button>`;
  inspEl.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    pinPhotoId = b.dataset.pick;
    const ph = photoById(prop, pinPhotoId);
    pinBatch = !!(ph && !ph.pin);
    renderPinPanel(); setHint(pinHint());
  });
  const file = inspEl.querySelector('input[type=file]');
  inspEl.querySelector('[data-add]').onclick = () => file.click();
  file.onchange = async () => {
    const files = Array.from(file.files || []);
    file.value = '';
    let first = null;
    for (const f of files) {
      try { const rec = await addPhotoFromFile(prop, f); first = first || rec; }
      catch (e) { toast('Could not add ' + f.name + ': ' + e.message, 'error'); }
    }
    // New photos are placed in the order they were chosen, starting with the first.
    if (first) { pinPhotoId = first.id; pinBatch = true; }
    if (tool === 'pin') { renderPinPanel(); setHint(pinHint()); }
    renderEnvPanel();
  };
  inspEl.querySelector('[data-cancel]').onclick = () => { tool = 'select'; pinBatch = false; renderToolCol(); renderInspector(); setHint(''); };
}

function renderInspector() {
  if (!inspEl) return;
  if (tool === 'pin') return renderPinPanel();
  if (!selection) {
    const hidden = hiddenLevels();
    const levelRows = prop.levels.map(l => {
      const nw = wallsOn(prop, l.id).length, nr = roomsOn(prop, l.id).length;
      return `<div class="stat-line" title="Elevation ${escapeHtml(fmtLen(l.elevation))}, height ${escapeHtml(fmtLen(levelHeight(prop, l.id)))}"><span>${escapeHtml(l.name)}${hidden.has(l.id) ? ' (hidden)' : ''}</span><b>${nw} wall${nw === 1 ? '' : 's'} &middot; ${nr} room${nr === 1 ? '' : 's'}</b></div>`;
    }).join('');
    inspEl.innerHTML = `<h3>MODEL</h3>
      ${levelRows}
      <div class="tool-sep"></div>
      <div class="stat-line"><span>Walls</span><b>${prop.walls.length}</b></div>
      <div class="stat-line"><span>Openings</span><b>${prop.openings.length}</b></div>
      <div class="stat-line"><span>Rooms</span><b>${prop.rooms.length}</b></div>
      <div class="stat-line"><span>Scans</span><b>${prop.scans.length}</b></div>
      <div class="stat-line"><span>Photos</span><b>${prop.photos.length}</b></div>
      <div class="stat-line"><span>Notes</span><b>${prop.notePins.length}</b></div>
      <div class="empty" style="margin-top:12px">
        Click a wall, door, window or floor to inspect and edit it. The model regenerates from the plan; edits here write back to the same data. Right-click anywhere on the model to pin a note.</div>
      ${pinsListHtml()}
      ${notesListHtml()}`;
    bindPinsList(inspEl);
    bindNotesList(inspEl);
    return;
  }
  if (selection.kind === 'wall') {
    const w = prop.walls.find(w => w.id === selection.id);
    if (!w) { selection = null; return renderInspector(); }
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    const lvl = levelOfWall(prop, w);
    const h = wallHeightOf(prop, w);
    const nOpen = prop.openings.filter(o => o.wallId === w.id).length;
    inspEl.innerHTML = `<h3>WALL</h3>
      <div class="stat-line"><span>Level</span><b>${escapeHtml(lvl.name)}</b></div>
      <div class="stat-line"><span>Length</span><b>${fmtLen(L)}</b></div>
      <div class="stat-line"><span>Face area</span><b>${fmtArea(L * h)}</b></div>
      <div class="stat-line"><span>Openings</span><b>${nOpen}</b></div>
      <div class="field"><label>Thickness</label><input type="text" data-th value="${escapeHtml(fmtLen(w.thickness))}"></div>
      <div class="field"><label>Height (blank = level default)</label><input type="text" data-h value="${w.height ? escapeHtml(fmtLen(w.height)) : ''}" placeholder="${escapeHtml(fmtLen(levelHeight(prop, lvl.id)))}"></div>
      <div class="field"><label>Material</label>${materialSelectHtml('wall', w.material, 'data-mat')}</div>
      <div class="field"><label>Interior face material</label>${materialSelectHtml('wall', w.materialIn, 'data-matin').replace('(none)', 'Automatic')}</div>
      ${researchButtonHtml(w.id, 'material', 'RESEARCH WALL MATERIAL')}
      ${researchButtonHtml(w.id, 'interior', 'RESEARCH INTERIOR FINISH')}
      ${scopeAssignHtml(w.id)}
      ${linkedProductsHtml(w.id)}
      ${photoLinksHtml(w.id)}
      <div class="empty" style="margin:8px 0">MOVE WALLS: drag the gizmo arrow to slide this wall; the walls, rooms and openings joined to it follow when you release.</div>
      <button class="btn" data-walk>WALK HERE</button>
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
    inspEl.querySelector('[data-mat]').onchange = e => { w.material = e.target.value || null; touch(); rebuildModel(); };
    // Room-facing faces only; blank = automatic (drywall on exterior walls, the wall material otherwise).
    inspEl.querySelector('[data-matin]').onchange = e => { w.materialIn = e.target.value || null; touch(); rebuildModel(); };
    inspEl.querySelector('[data-walk]').onclick = () => setMode('walk');
    inspEl.querySelector('[data-del]').onclick = () => {
      prop.walls = prop.walls.filter(x => x.id !== w.id);
      prop.openings = prop.openings.filter(o => o.wallId !== w.id);
      setSelection(null);
      touch(); rebuildModel();
    };
    bindAssign(inspEl); bindPhotoLinks(inspEl); bindResearchActions(inspEl);
    return;
  }
  if (selection.kind === 'opening') {
    const o = prop.openings.find(o => o.id === selection.id);
    if (!o) { selection = null; return renderInspector(); }
    inspEl.innerHTML = `<h3>${o.type === 'window' ? 'WINDOW' : (o.width > 1.25 ? 'CASED OPENING' : 'DOOR')}</h3>
      <div class="field"><label>Type</label><select data-type><option value="door" ${o.type === 'door' ? 'selected' : ''}>Door</option><option value="window" ${o.type === 'window' ? 'selected' : ''}>Window</option></select></div>
      <div class="field-row">
        <div class="field"><label>Width</label><input type="text" data-w value="${escapeHtml(fmtLen(o.width))}"></div>
        <div class="field"><label>Height</label><input type="text" data-hh value="${escapeHtml(fmtLen(o.height))}"></div>
      </div>
      ${o.type === 'window' ? `<div class="field"><label>Sill height</label><input type="text" data-s value="${escapeHtml(fmtLen(o.sill || 0))}"></div>` : ''}
      <div class="field"><label>Position along wall</label><input type="range" min="0.02" max="0.98" step="0.005" value="${finiteNum(o.t, 0.5)}" data-t></div>
      <div class="empty">Doors wider than 4 ft become cased openings. Interior doors stand ajar so you can see through rooms.</div>
      ${researchButtonHtml(o.id, 'fixture', o.type === 'window' ? 'RESEARCH WINDOW' : 'RESEARCH DOOR / OPENING')}
      ${linkedProductsHtml(o.id)}
      <button class="btn" data-wall>SELECT WALL</button>
      <button class="btn danger" data-del>DELETE OPENING</button>`;
    const num = (sel, fn, min) => { inspEl.querySelector(sel).onchange = e => { const v = parseLen(e.target.value); if (!isNaN(v) && v > (min || 0.05)) { fn(v); touch(); rebuildModel(); } renderInspector(); }; };
    num('[data-w]', v => o.width = v, 0.2);
    num('[data-hh]', v => o.height = v, 0.3);
    if (o.type === 'window') num('[data-s]', v => o.sill = v, -0.001);
    inspEl.querySelector('[data-type]').onchange = e => {
      o.type = e.target.value;
      if (o.type === 'window' && o.sill == null) o.sill = 0.762;
      touch(); rebuildModel(); renderInspector();
    };
    inspEl.querySelector('[data-t]').oninput = e => { o.t = parseFloat(e.target.value); rebuildModel(); };
    inspEl.querySelector('[data-t]').onchange = () => touch();
    inspEl.querySelector('[data-wall]').onclick = () => setSelection({ kind: 'wall', id: o.wallId });
    inspEl.querySelector('[data-del]').onclick = () => { prop.openings = prop.openings.filter(x => x.id !== o.id); setSelection(null); touch(); rebuildModel(); };
    bindResearchActions(inspEl);
    return;
  }
  if (selection.kind === 'room') {
    const r = prop.rooms.find(r => r.id === selection.id);
    if (!r) { selection = null; return renderInspector(); }
    inspEl.innerHTML = `<h3>ROOM / FLOOR</h3>
      <div class="field"><label>Name</label><input type="text" data-name value="${escapeHtml(r.name || '')}"></div>
      <div class="stat-line"><span>Level</span><b>${escapeHtml(levelOfRoom(prop, r).name)}</b></div>
      <div class="stat-line"><span>Area</span><b>${fmtArea(polyArea(r.pts))}</b></div>
      <div class="field"><label>Floor material</label>${materialSelectHtml('floor', r.material, 'data-mat')}</div>
      <div class="field"><label>Ceiling material</label>${materialSelectHtml('ceiling', r.ceilingMaterial, 'data-cmat')}</div>
      ${researchButtonHtml(r.id, 'material', 'RESEARCH FLOOR MATERIAL')}
      ${researchButtonHtml(r.id, 'ceiling', 'RESEARCH CEILING MATERIAL')}
      ${scopeAssignHtml(r.id)}
      ${linkedProductsHtml(r.id)}
      ${photoLinksHtml(r.id)}
      <button class="btn" data-walk>WALK INTO ROOM</button>`;
    inspEl.querySelector('[data-name]').onchange = e => { r.name = e.target.value; touch(); };
    inspEl.querySelector('[data-mat]').onchange = e => { r.material = e.target.value || null; touch(); rebuildModel(); };
    inspEl.querySelector('[data-cmat]').onchange = e => { r.ceilingMaterial = e.target.value || null; touch(); rebuildModel(); };
    inspEl.querySelector('[data-walk]').onclick = () => setMode('walk');
    bindAssign(inspEl); bindPhotoLinks(inspEl); bindResearchActions(inspEl);
    return;
  }
  if (selection.kind === 'pin') {
    const ph = photoById(prop, selection.id);
    if (!ph || !ph.pin) { selection = null; return renderInspector(); }
    inspEl.innerHTML = `<h3>PHOTO PIN</h3>
      <button class="v-thumb big" data-open><img src="${escapeHtml(ph.thumb)}" alt=""></button>
      <div class="stat-line"><span>${escapeHtml(ph.name)}</span><b>${finiteNum(ph.w, '?')} x ${finiteNum(ph.h, '?')}</b></div>
      <div class="field"><label>Notes</label><textarea data-notes>${escapeHtml(ph.notes || '')}</textarea></div>
      <div class="field"><label>Card size</label><input type="range" min="0.25" max="2.5" step="0.05" value="${finiteNum(ph.pin.size, 0.6)}" data-size></div>
      <button class="btn" data-open2>OPEN FULL SIZE</button>
      <button class="btn" data-locate>LOCATE</button>
      <button class="btn" data-move>MOVE PIN</button>
      <button class="btn danger" data-unpin>REMOVE PIN</button>`;
    inspEl.querySelector('[data-open]').onclick = () => openLightbox(ph.id);
    inspEl.querySelector('[data-open2]').onclick = () => openLightbox(ph.id);
    inspEl.querySelector('[data-notes]').onchange = e => { ph.notes = e.target.value; touch(); };
    inspEl.querySelector('[data-size]').oninput = e => { ph.pin.size = parseFloat(e.target.value); const r = pinObjs[ph.id]; if (r) r.size = ph.pin.size; requestRender(2); };
    inspEl.querySelector('[data-size]').onchange = () => touch();
    inspEl.querySelector('[data-locate]').onclick = () => flyToPin(ph.id);
    inspEl.querySelector('[data-move]').onclick = () => startPinMode(ph.id);
    inspEl.querySelector('[data-unpin]').onclick = () => unpin(ph.id);
    return;
  }
  if (selection.kind === 'note') {
    const n = noteById(selection.id);
    if (!n) { selection = null; return renderInspector(); }
    const where = noteWhere(n), added = new Date(n.createdAt);
    inspEl.innerHTML = `<h3>NOTE</h3>
      <div class="field"><label>Text</label><textarea data-text rows="5" maxlength="2000">${escapeHtml(n.text || '')}</textarea></div>
      ${where ? `<div class="stat-line"><span>Room</span><b>${escapeHtml(where)}</b></div>` : ''}
      ${Number.isFinite(added.getTime()) && added.getTime() > 0 ? `<div class="stat-line"><span>Added</span><b>${escapeHtml(added.toLocaleDateString())}</b></div>` : ''}
      <div class="field"><label>Card size</label><input type="range" min="0.2" max="2" step="0.05" value="${finiteNum(n.size, 0.45)}" data-size></div>
      <button class="btn" data-locate>LOCATE</button>
      <button class="btn" data-move>MOVE NOTE</button>
      <button class="btn danger" data-del>DELETE NOTE</button>`;
    const text = inspEl.querySelector('[data-text]');
    text.oninput = () => { n.text = text.value; redrawNoteCard(n.id); };
    text.onchange = () => { n.text = text.value.trim(); n.updatedAt = new Date().toISOString(); touch(); redrawNoteCard(n.id); };
    inspEl.querySelector('[data-size]').oninput = e => { n.size = parseFloat(e.target.value); const r = noteObjs[n.id]; if (r) r.size = n.size; requestRender(2); };
    inspEl.querySelector('[data-size]').onchange = () => touch();
    inspEl.querySelector('[data-locate]').onclick = () => flyToNote(n.id);
    inspEl.querySelector('[data-move]').onclick = () => startNoteMode(n.id);
    inspEl.querySelector('[data-del]').onclick = () => deleteNote(n.id);
    return;
  }
  if (selection.kind === 'scan') {
    const s = prop.scans.find(s => s.id === selection.id);
    if (!s) { selection = null; return renderInspector(); }
    const obj = scanObjs[s.id] || null;
    const state = obj ? 'ready' : (scanState[s.id] || 'loading');
    const st = obj ? scanStats(obj) : { label: { missing: 'missing from storage - re-import it', failed: 'could not be loaded', loading: 'loading' }[state] || 'loading' };
    const rot = s.rot || [0, s.rotY || 0, 0];
    const isPts = s.kind === 'points', isSplat = s.kind === 'splat';
    // Nothing to frame, drop or centre until the object exists; deleting mid-parse would race the loader.
    const dis = obj ? '' : 'disabled', disDel = state === 'loading' ? 'disabled' : '';
    const materialSlots = s.kind === 'mesh' && obj ? modelTakeoff(obj) : [];
    inspEl.innerHTML = `<h3>${s.kind === 'mesh' ? 'MODEL' : 'SCAN'}</h3>
      <div class="stat-line"><span>File</span><b title="${escapeHtml(s.name)}">${escapeHtml(s.name.length > 22 ? s.name.slice(0, 20) + '...' : s.name)}</b></div>
      <div class="stat-line"><span>Kind</span><b>${escapeHtml(s.kind || '?')} &middot; ${escapeHtml((s.format || '').toUpperCase())}</b></div>
      <div class="stat-line"><span>${isSplat ? 'Splats' : (isPts ? 'Points' : 'Triangles')}</span><b>${escapeHtml(st.label)}</b></div>
      ${state === 'missing' ? '<div class="empty" style="margin:6px 0">The file bytes are not in this browser\'s storage (they do not travel in a .json export). Import the file again, or delete this record.</div>' : ''}
      <div class="field-row">
        <div class="field"><label>X</label><input type="number" step="0.1" data-p="0" value="${finiteNum(s.pos[0], 0)}"></div>
        <div class="field"><label>Y (up)</label><input type="number" step="0.1" data-p="1" value="${finiteNum(s.pos[1], 0)}"></div>
        <div class="field"><label>Z</label><input type="number" step="0.1" data-p="2" value="${finiteNum(s.pos[2], 0)}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Rot X</label><input type="number" step="5" data-r="0" value="${finiteNum(rot[0], 0)}"></div>
        <div class="field"><label>Rot Y</label><input type="number" step="5" data-r="1" value="${finiteNum(rot[1], 0)}"></div>
        <div class="field"><label>Rot Z</label><input type="number" step="5" data-r="2" value="${finiteNum(rot[2], 0)}"></div>
      </div>
      <div class="field"><label>Scale</label><input type="number" step="0.05" data-scale value="${finiteNum(s.scale, 1) || 1}"></div>
      ${isPts ? `<div class="field"><label>Point size</label><input type="range" min="0.002" max="0.08" step="0.001" value="${finiteNum(s.pointSize, 0.012)}" data-ps></div>
      <div class="field"><label>Colour</label><select data-pc><option value="rgb" ${s.pointColor === 'rgb' ? 'selected' : ''}>Scan colours</option><option value="height" ${s.pointColor === 'height' ? 'selected' : ''}>Height ramp</option><option value="solid" ${s.pointColor === 'solid' ? 'selected' : ''}>Solid amber</option></select></div>` : ''}
      ${isSplat ? `<button class="btn" data-flip ${dis}>FLIP UP AXIS</button>` : ''}
      <label class="tool-check"><input type="checkbox" ${s.visible !== false ? 'checked' : ''} data-vis> VISIBLE</label>
      <button class="btn" data-frame ${dis}>FRAME SCAN</button>
      <button class="btn" data-floor ${dis}>DROP TO FLOOR</button>
      <button class="btn" data-center ${dis}>CENTER ON MODEL</button>
      ${s.kind === 'mesh' ? `<button class="btn" data-plan ${dis} title="Find the floor and ceiling, square the scan up, propose walls, rooms, doors and windows, and render the plan underlay from the scan">${icon('plan')}PROPOSE PLAN FROM SCAN</button>` : ''}
      ${s.source && s.source.url ? `<a class="btn" href="${escapeHtml(s.source.url)}" target="_blank" rel="noopener" style="display:flex; text-decoration:none; justify-content:center">${icon('link')}OPEN ON POLYCAM</a>` : ''}
      ${s.importWarnings?.length ? `<p class="empty">${s.importWarnings.map(escapeHtml).join('<br>')}</p>` : ''}
      ${s.kind === 'mesh' ? `<button class="btn" data-exchange ${dis}>EDIT / BRING BACK</button>
      <h3>MATERIALS</h3><p class="empty">Match exported surface names to known Tiksi materials. Names and colours do not establish a product identity.</p>
      ${materialSlots.map(slot=>`<div class="field"><label title="${escapeHtml(slot.name)}">${escapeHtml(slot.name)} · ${escapeHtml(fmtArea(slot.areaM2))}</label><select data-model-material="${slot.key}"><option value="">Original surface${s.materialIdentities?.[slot.key] ? ' · '+escapeHtml(materialById(s.materialIdentities[slot.key])?.name || ''):''}</option>${ws.data.materials.map(m=>`<option value="${escapeHtml(m.id)}" ${s.materialBindings?.[slot.key]===m.id?'selected':''}>${escapeHtml(m.name)}</option>`).join('')}</select></div>`).join('')}<button class="btn" data-estimate ${dis}>CREATE FINISH ESTIMATE</button><p class="empty">Measured triangle surface areas. Map only finish surfaces to include; review overlaps and waste in Scope before ordering.</p>` : ''}
      <button class="btn danger" data-del ${disDel} title="${disDel ? 'Wait for the scan to finish loading' : ''}">DELETE SCAN</button>`;
    const estimate = inspEl.querySelector('[data-estimate]');
    if(estimate) estimate.onclick = () => {try {const pr=createModelEstimate(prop,s,obj);toast('Created '+pr.name+'. Review quantities and prices in Scope / Budget.','ok');}catch(e){toast(e.message,'warn');}};
    const exchange = inspEl.querySelector('[data-exchange]');
    if(exchange) exchange.onclick = () => exchangeDialog(s.id);
    inspEl.querySelectorAll('[data-model-material]').forEach(input => input.onchange = async () => {
      s.materialBindings = s.materialBindings || {};
      if(input.value) s.materialBindings[input.dataset.modelMaterial]=input.value; else delete s.materialBindings[input.dataset.modelMaterial];
      touch(); try { await addScanToScene(s); } catch(e) {toast(e.message,'error');}
    });
    const upd = () => { applyScanTransform(s, obj); fitShadow(); applyEnvironment(); touch(); requestRender(3); };
    inspEl.querySelectorAll('[data-p]').forEach(i => i.onchange = () => { s.pos[+i.dataset.p] = parseFloat(i.value) || 0; upd(); });
    inspEl.querySelectorAll('[data-r]').forEach(i => i.onchange = () => {
      s.rot = s.rot || [0, s.rotY || 0, 0];
      s.rot[+i.dataset.r] = parseFloat(i.value) || 0;
      s.rotY = s.rot[1];
      upd();
    });
    inspEl.querySelector('[data-scale]').onchange = e => { s.scale = parseFloat(e.target.value) || 1; upd(); };
    const ps = inspEl.querySelector('[data-ps]');
    if (ps) ps.oninput = e => { s.pointSize = parseFloat(e.target.value); applyScanTransform(s, obj); requestRender(2); };
    if (ps) ps.onchange = () => touch();
    const pc = inspEl.querySelector('[data-pc]');
    if (pc) pc.onchange = e => { s.pointColor = e.target.value; upd(); };
    const flip = inspEl.querySelector('[data-flip]');
    if (flip) flip.onclick = () => { s.flip = !s.flip; upd(); };
    inspEl.querySelector('[data-vis]').onchange = e => { s.visible = e.target.checked; upd(); };
    inspEl.querySelector('[data-frame]').onclick = () => { if (obj) frameObject(obj); };
    inspEl.querySelector('[data-floor]').onclick = () => { if (obj) { dropScanToFloor(s, obj); upd(); renderInspector(); } };
    inspEl.querySelector('[data-center]').onclick = () => { if (obj) { centerScanOnModel(s, obj, modelBounds(prop)); upd(); renderInspector(); } };
    const planBtn = inspEl.querySelector('[data-plan]');
    if (planBtn) planBtn.onclick = () => proposePlanFromScan(s);
    inspEl.querySelector('[data-del]').onclick = async () => {
      if (scanState[s.id] === 'loading' && !obj) return;
      prop.scans = prop.scans.filter(x => x.id !== s.id);
      if([prop.designComparison?.beforeId,prop.designComparison?.afterId].includes(s.id))delete prop.designComparison;
      if(prop.modelSourceId === s.id) { delete prop.modelSourceId; rebuildModel(); }
      if (obj) { scanRoot.remove(obj); disposeScanObject(obj); delete scanObjs[s.id]; }
      delete scanState[s.id];
      fitShadow(); applyEnvironment();
      setSelection(null);
      touch();
      renderToolCol();
      try { await deleteFile(s.id); if(s.originalFileId && s.originalFileId !== s.id) await deleteFile(s.originalFileId); }
      catch (e) { console.error(e); toast('The scan record is gone but its bytes could not be removed from browser storage: ' + errMsg(e), 'warn'); }
    };
    return;
  }
}

function exchangeDialog(selected) { document.dispatchEvent(new CustomEvent('tiksi:files',{detail:{tab:'exchange',selected}})); }

// ---------- tool column ----------
function renderToolCol() {
  const tc = el && el.querySelector('.tool-col');
  if (!tc) return;
  // Same button anatomy as the plan editor: icon, label, key badge.
  const tb = (act, ic, label, key, active) =>
    `<button class="tool-btn ${active ? 'active' : ''}" data-act="${act}" title="${label}${key ? ' (' + key + ')' : ''}">` +
    `${icon(ic)}<span class="tb-text">${label}</span>${key ? `<kbd class="key">${key}</kbd>` : ''}</button>`;
  const scanBadge = s => scanObjs[s.id] ? (s.kind || '').toUpperCase().slice(0, 5) : ({ missing: 'GONE', failed: 'ERR' }[scanState[s.id]] || '...');
  const scanRows = prop.scans.map(s => `<button class="tool-btn v-scan-row ${scanSelected(s.id) ? 'active' : ''}" data-scan="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}${scanObjs[s.id] ? '' : ' (' + escapeHtml(scanState[s.id] || 'loading') + ')'}">${icon(s.kind === 'splat' ? 'splat' : s.kind === 'mesh' ? 'model' : 'scan')}<span class="tb-text">${escapeHtml(s.name.length > 14 ? s.name.slice(0, 12) + '..' : s.name)}</span><kbd class="key">${escapeHtml(scanBadge(s))}</kbd></button>`).join('');
  // One toggle per storey, lit while the level is shown; the key badge is its floor elevation.
  const hidden = hiddenLevels();
  const levelRows = prop.levels.map(l => `<button class="tool-btn ${hidden.has(l.id) ? '' : 'active'}" data-level="${escapeHtml(l.id)}" title="${hidden.has(l.id) ? 'Show' : 'Hide'} ${escapeHtml(l.name)} (floor at ${escapeHtml(fmtLen(l.elevation))})">${icon(hidden.has(l.id) ? 'eye-off' : 'layers')}<span class="tb-text">${escapeHtml(l.name.length > 14 ? l.name.slice(0, 12) + '..' : l.name)}</span><kbd class="key">${escapeHtml(fmtLen(l.elevation, { short: true }))}</kbd></button>`).join('');
  tc.innerHTML = `
    <div class="tool-head">VIEW</div>
    ${tb('frame', 'frame', 'FRAME', 'F')}
    ${tb('front', 'target', 'FRONT')}
    ${tb('iso', 'model', 'ISO')}
    <div class="tool-sep"></div>
    <div class="tool-head">TOOLS</div>
    ${tb('select', 'select', 'SELECT', 'V', tool === 'select')}
    ${tb('move', 'move', 'MOVE WALLS', 'M', tool === 'move')}
    ${tb('measure', 'measure', 'MEASURE', 'D', tool === 'measure')}
    ${measures.length ? tb('clearm', 'close', 'CLEAR MEASURES') : ''}
    ${tb('pin', 'pin', 'PIN PHOTO', 'P', tool === 'pin')}
    ${tb('note', 'note', 'NOTE', 'N', tool === 'note')}
    ${tb('sketchup', 'external', 'EDIT IN SKETCHUP')}
    <div class="tool-sep"></div>
    <div class="tool-head">LEVELS</div>
    ${levelRows}
    <div class="tool-sep"></div>
    <div class="tool-head">MODELS & SCANS</div>
    ${prop.designComparison ? tb('before', 'scan', 'BEFORE', '', prop.designComparison.view === 'before') + tb('after', 'model', 'AFTER', '', prop.designComparison.view === 'after') : ''}
    ${scanRows}
    <div class="empty" style="padding:6px 8px; font-size:9.5px; color:var(--faint); font-family:var(--mono); line-height:1.5">
      PLY / PCD / XYZ / LAS point clouds, OBJ / GLB meshes, .splat / .spz / .ply Gaussian splats.</div>
    <div class="tool-sep"></div>
<div class="empty">Import and exchange models in FILE.</div>`;
  const on = (act, fn) => { const b = tc.querySelector(`[data-act=${act}]`); if (b) b.onclick = fn; };
  on('frame', () => { if (mode !== 'orbit') setMode('orbit'); presetView('frame'); });
  on('front', () => { if (mode !== 'orbit') setMode('orbit'); presetView('front'); });
  on('iso', () => { if (mode !== 'orbit') setMode('orbit'); presetView('iso'); });
  on('top', () => setMode('top'));
  on('walk', () => setMode(mode === 'walk' ? 'orbit' : 'walk'));
  on('select', () => setTool('select'));
  on('move', () => setTool(tool === 'move' ? 'select' : 'move'));
  on('measure', () => setTool(tool === 'measure' ? 'select' : 'measure'));
  on('clearm', () => { clearMeasures(); renderToolCol(); });
  on('pin', () => { if (tool === 'pin') setTool('select'); else startPinMode(null); });
  on('note', () => { if (tool === 'note') setTool('select'); else startNoteMode(null); });
  on('sketchup', () => document.dispatchEvent(new CustomEvent('tiksi:edit-in-sketchup')));
  const su = tc.querySelector('[data-act=sketchup]');
  if (su) su.classList.add('tb-wrap');
  if (su) su.title = 'Open this project\'s SketchUp model (the .skp kept beside the project file) in SketchUp. Saves there come back here.';
  on('section', toggleSection);
  on('xray', toggleXray);
  on('render', openStillDialog);
  on('exchange', () => exchangeDialog());
  const compare = view => {
    const c=prop.designComparison; if(!c)return;
    c.view=view;
    const chosen=view==='before'?c.beforeId:c.afterId;
    for(const id of [c.beforeId,c.afterId]) {
      const scan=prop.scans.find(s=>s.id===id);if(scan){scan.visible=id===chosen;applyScanTransform(scan,scanObjs[id]);}
    }
    if(chosen==='design')delete prop.modelSourceId;else prop.modelSourceId=chosen;
    // Select the record immediately, including while its scene object is loading.
    // setScanState refreshes this inspector when the chosen object is ready.
    rebuildModel();setSelection(chosen==='design'?null:{kind:'scan',id:chosen});renderToolCol();touch();
  };
  on('before',()=>compare('before'));on('after',()=>compare('after'));
  tc.querySelectorAll('[data-scan]').forEach(b => b.onclick = () => setSelection({ kind: 'scan', id: b.dataset.scan }));
  tc.querySelectorAll('[data-level]').forEach(b => b.onclick = () => toggleLevel(b.dataset.level));
  on('rebuild', () => { rebuildModel(); rebuildGround(); buildAllPins(); buildAllNotes(); });
}
function setTool(next) {
  if (tool === 'measure' && next !== 'measure') { measureDraft = null; measureRoot.children.filter(c => c.userData.draft).forEach(c => { measureRoot.remove(c); c.geometry.dispose(); c.material.dispose(); }); }
  tool = next;
  if (next !== 'pin') pinBatch = false;
  if (next !== 'note') movingNoteId = null;
  reattachGizmo();
  renderToolCol();
  renderInspector();
  setHint('');
  requestRender(2);
}

// ---------- keyboard ----------
function onKeyDown(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (ctxMenu && e.code === 'Escape') { closeContextMenu(); e.preventDefault(); return; }
  if (mode === 'walk') {
    walkKeys[e.code] = true;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) { e.preventDefault(); requestRender(2); }
    if (e.code === 'Escape' && !walkLocked) setMode('orbit');
    return;
  }
  switch (e.code) {
    case 'KeyF': presetView('frame'); break;
    case 'KeyT': setMode('top'); break;
    case 'KeyO': setMode('orbit'); break;
    case 'KeyW': setMode('walk'); break;
    case 'KeyV': setTool('select'); break;
    case 'KeyM': setTool(tool === 'move' ? 'select' : 'move'); break;
    case 'KeyD': setTool(tool === 'measure' ? 'select' : 'measure'); break;
    case 'KeyP': if (tool === 'pin') setTool('select'); else startPinMode(null); break;
    case 'KeyN': if (tool === 'note') setTool('select'); else startNoteMode(null); break;
    case 'KeyC': toggleSection(); break;
    case 'KeyX': toggleXray(); break;
    case 'Escape':
      if (tool !== 'select') setTool('select');
      else setSelection(null);
      break;
    case 'Delete': case 'Backspace':
      if (selection && selection.kind === 'wall') inspEl.querySelector('[data-del]') && inspEl.querySelector('[data-del]').click();
      else if (selection && selection.kind === 'opening') inspEl.querySelector('[data-del]') && inspEl.querySelector('[data-del]').click();
      else if (selection && selection.kind === 'pin') unpin(selection.id);
      else if (selection && selection.kind === 'note') deleteNote(selection.id);
      break;
    default: return;
  }
  e.preventDefault();
}
function onKeyUp(e) { delete walkKeys[e.code]; }
function onPointerLeave() { if (hoverTarget) { hoverTarget = null; updateOutlineTargets(); requestRender(2); } }
function onContextMenu(e) { e.preventDefault(); }

// ---------- mount / unmount ----------
export function mount(root) {
  prop = activeProperty();
  el = root;
  if (!prop) {
    root.innerHTML = `<div class="view-scroll"><div class="kicker">MODEL</div>
      <p class="muted">No property yet. Create one from the PROPERTY selector in the top bar.</p></div>`;
    return;
  }
  ensureDefaults(prop);
  setTextureQuality(prop.env.quality);
  root.innerHTML = `
    <div class="editor-layout v-layout">
      <div class="tool-col"></div>
      <div class="canvas-wrap v-wrap">
        <div class="v-modes"></div>
        <div class="v-compass" title="North"><div class="v-rose"><span class="n">N</span><span class="e">E</span><span class="s">S</span><span class="w">W</span><i></i></div></div>
        <div class="v-env"></div>
        <div class="v-progress"><div class="v-prog-label"></div><div class="v-prog-bar"><div class="v-prog-fill"></div></div></div>
        <div class="v-toast"></div>
        <div class="v-hint"></div>
      </div>
      <div class="inspector"></div>
    </div>`;
  wrapEl = root.querySelector('.canvas-wrap');
  inspEl = root.querySelector('.inspector');
  hud = {
    modes: wrapEl.querySelector('.v-modes'), compass: wrapEl.querySelector('.v-rose'), env: wrapEl.querySelector('.v-env'),
    progress: wrapEl.querySelector('.v-progress'), toast: wrapEl.querySelector('.v-toast'), hint: wrapEl.querySelector('.v-hint'),
  };
  mode = 'orbit'; tool = 'select'; selection = null; hoverTarget = null; tween = null; measureDraft = null; pinPhotoId = null;
  movingNoteId = null; rightPress = null; ctxMenu = null; noteEditor = null;
  panoNagged = false; panoPending = null; panoMissing = null;
  for (const k of Object.keys(scanState)) delete scanState[k];
  mountId++;

  ensureRenderer();
  wrapEl.insertBefore(renderer.domElement, wrapEl.firstChild);
  setupScene();
  setupComposer();
  rebuildGround();
  rebuildModel();
  applyQuality();
  applyEnvironment();
  buildAllPins();
  buildAllNotes();
  applyMarkerVisibility();
  presetView('frame', true);
  renderHud();
  renderEnvPanel();
  hud.env.hidden=true;
  renderToolCol();
  renderInspector();
  setHint('');

  const c = renderer.domElement;
  c.addEventListener('pointerdown', onPointerDown);
  c.addEventListener('pointerup', onPointerUp);
  c.addEventListener('pointermove', onPointerMove);
  c.addEventListener('pointerleave', onPointerLeave);
  c.addEventListener('contextmenu', onContextMenu);
  c.addEventListener('wheel', closeContextMenu, { passive: true });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(wrapEl);
  resize();
  programsWarm = false;
  lastT = 0;
  renderer.setAnimationLoop(tick);
  requestRender(4);

  const focus=pendingScanFocus || prop.modelSourceId,token=mountId,focusVersion=selectionVersion;pendingScanFocus=null;
  loadAllScans().then(()=>{if(token===mountId && selectionVersion===focusVersion && focus && scanObjs[focus]){setSelection({kind:'scan',id:focus});frameObject(scanObjs[focus]);}});
  // Deep link from the PHOTOS view: #/model?pin=<photoId> enters PIN PHOTO for that photo.
  const m = /[?&]pin=([^&]+)/.exec(location.hash);
  if (m) {
    if (photoById(prop, decodeURIComponent(m[1]))) startPinMode(decodeURIComponent(m[1]));
    // Consume the query so a reload, Back or a bookmark returns to the plain model view
    // (replaceState does not fire hashchange, so the router is not re-entered).
    history.replaceState(null, '', '#/model');
  }
}

// three keys shader programs by light count, so the first time the room lights switch on
// (walking into a room, or dusk) every lit material would compile a second variant and the
// view would freeze mid-interaction. Compile both variants off the interaction path instead:
// after the first environment bake and again whenever procedural textures have landed.
function warmPrograms() {
  if (!scene || !camera || !lightRoot || !composer) return;
  const was = lightRoot.visible;
  // Scans stay out of it: Spark builds its splat shaders on its own schedule.
  const hadScans = scanRoot.parent === scene;
  if (hadScans) scene.remove(scanRoot);
  // Programs are keyed by the bound target too (tone mapping and output colour space are off
  // when drawing into the composer's buffers), so compile against the buffer the render pass uses.
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.writeBuffer);
  for (const lit of [true, false]) {
    lightRoot.visible = lit;
    try { renderer.compile(scene, camera); } catch (e) { console.error(e); }
  }
  renderer.setRenderTarget(prevTarget);
  lightRoot.visible = was;
  if (hadScans) scene.add(scanRoot);
}

export function unmount() {
  if (exportDialog) exportDialog.close();
  if (renderer) renderer.setAnimationLoop(null);
  mountId++;
  revokePhotoUrls();   // object URLs handed to the lightbox, pin picker and pano loader
  // mount() bails out before building anything when there is no property; there is nothing to tear down.
  if (!scene) { el = wrapEl = inspEl = null; hud = {}; return; }
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  if (renderer) {
    const c = renderer.domElement;
    c.removeEventListener('pointerdown', onPointerDown);
    c.removeEventListener('pointerup', onPointerUp);
    c.removeEventListener('pointermove', onPointerMove);
    c.removeEventListener('pointerleave', onPointerLeave);
    c.removeEventListener('contextmenu', onContextMenu);
    c.removeEventListener('wheel', closeContextMenu);
  }
  closeContextMenu();
  closeNoteEditor();
  if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
  clearTimeout(pmremTimer);
  if (mode === 'walk' && walk) { if (walkLocked) walk.unlock(); }
  if (walk) { walk.dispose(); walk = null; }
  if (gizmo) { gizmo.detach(); gizmo.dispose(); gizmo = null; }
  if (controls) { controls.dispose(); controls = null; }
  if (modelGroup) { section.on = false; applySection(); disposeBuilt(modelGroup); modelGroup = null; }
  if (capMesh) { capMesh.geometry.dispose(); capMesh = null; }
  interiorFill = false;
  if (groundGroup) { disposeBuilt(groundGroup); groundGroup = null; }
  if (lightRoot) { lightRoot.traverse(o => { if (o.geometry) o.geometry.dispose(); }); lightRoot = null; }
  clearMeasures();
  for (const id of Object.keys(pinObjs)) removePin(id);
  for (const id of Object.keys(noteObjs)) removeNote(id);
  for (const id of Object.keys(scanObjs)) { disposeScanObject(scanObjs[id]); delete scanObjs[id]; }
  for (const id of Object.keys(scanState)) delete scanState[id];
  releaseSplatRenderer();
  if (composer) {
    for (const p of Object.values(passes)) if (p.dispose) p.dispose();
    composer.dispose();
    composer = null; passes = {};
  }
  if (envRT) { envRT.dispose(); envRT = null; }
  if (panoTex) { panoTex.dispose(); panoTex = null; panoId = null; }
  if (sky) { sky.geometry.dispose(); sky.material.dispose(); sky = null; }
  if (envSky) { envSky.geometry.dispose(); envSky.material.dispose(); envSky = null; }
  if (sun && sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  if (renderer) {
    renderer.domElement.remove();
    renderer.setRenderTarget(null);
    renderer.clear();
  }
  scene = null; camera = null; skyScene = null; sun = null; hemi = null;
  scanRoot = null; pinRoot = null; noteRoot = null; measureRoot = null;
  el = null; wrapEl = null; inspEl = null; hud = {};
  selection = null; hoverTarget = null; tween = null; pressed = null; dragLook = null; rightPress = null; movingNoteId = null;
}

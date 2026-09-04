// 3D model view: a rendering, not a debug scene.
// Physically based sun + sky with soft shadows, image-based lighting, ambient occlusion,
// bloom and SMAA through one persistent WebGL context; orbit / walk / top / section camera
// modes; selection and hover outlines; measure and photo-pin tools; point clouds, meshes
// and Gaussian splats as reference scans; a still-image renderer.

import * as THREE from 'three';
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
  ws, activeProperty, uid, touch, fmtLen, parseLen, fmtArea, polyArea,
  escapeHtml, deleteFile, itemById, isoToday,
} from './store.js';
import { materialSelectHtml } from './materials.js';
import { pendingTextureJobs } from './textures.js';
import { icon } from './icons.js';
import { buildPropertyGroup, buildGround, modelBounds, roomCentres, wallCapRects, disposeBuilt } from './geometry.js';
import { addPhotoFromFile, photoUrl, photoById } from './photos-store.js';
import {
  SCAN_ACCEPT, importScanFile, loadScanObject, applyScanTransform, disposeScanObject,
  scanStats, dropScanToFloor, centerScanOnModel, releaseSplatRenderer, splatDrawables, splatBusy,
} from './scans.js';

// ---------- persistent GPU state (one context for the life of the page) ----------
let renderer = null, pmrem = null;
const MAX_DPR = { high: 2, medium: 1.5, low: 1 };
const SHADOW_SIZE = { high: 4096, medium: 2048, low: 1024 };

const ENV_DEFAULTS = {
  time: 14.5, azimuth: 200, north: 0, exposure: 1.0, quality: 'high',
  sky: 'dynamic', panoPhotoId: null,
  showCeilings: true, showGround: true, showGrid: false, nightLights: true,
};

// ---------- per-mount state ----------
let el = null, wrapEl = null, inspEl = null, hud = {};
let scene = null, camera = null, controls = null, walk = null, gizmo = null, composer = null, passes = {};
let sky = null, envSky = null, sun = null, hemi = null, envRT = null, skyScene = null, panoTex = null, panoId = null;
let modelGroup = null, groundGroup = null, scanRoot = null, pinRoot = null, lightRoot = null, measureRoot = null;
let prop = null;
let selection = null;          // {kind:'wall'|'room'|'opening'|'scan'|'pin', id}
let hoverTarget = null;
let mode = 'orbit';            // orbit | walk | top
let tool = 'select';           // select | move | measure | pin
let xray = false;
let section = { on: false, height: 1.2 };
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.2);
let framesLeft = 0, lastT = 0, tween = null, resizeObs = null;
let pinPhotoId = null;         // photo being placed by the PIN PHOTO tool
let measureDraft = null;       // first measure point
const measures = [];           // {a, b, line, label}
const scanObjs = {};           // scanId -> Object3D
const pinObjs = {};            // photoId -> {group, sprite, line, dot, aspect}
const walkKeys = {};
let walkLocked = false, dragLook = null;
let pmremTimer = 0, envDirty = true, sunDirty = true;
let pressed = null;
let toastTimer = 0;
const raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 0.05 };
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();
const walkEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function dpr() { return Math.min(window.devicePixelRatio || 1, MAX_DPR[prop.env.quality] || 2); }
function wallHeight() { return prop.wallHeight || 2.44; }
function requestRender(n) { framesLeft = Math.max(framesLeft, n || 2); }

// ---------- defaults for old data ----------
function ensureDefaults(p) {
  p.env = Object.assign({}, ENV_DEFAULTS, p.env || {});
  p.photos = p.photos || [];
  p.scans = p.scans || [];
  p.rooms = p.rooms || []; p.walls = p.walls || []; p.openings = p.openings || [];
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

  sun = new THREE.DirectionalLight(0xfff4e6, 3);
  sun.castShadow = true;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 2;
  scene.add(sun);
  scene.add(sun.target);

  hemi = new THREE.HemisphereLight(0xbfd4ea, 0x5a5648, 0.45);
  scene.add(hemi);

  lightRoot = new THREE.Group(); lightRoot.name = 'nightlights'; scene.add(lightRoot);
  scanRoot = new THREE.Group(); scanRoot.name = 'scans'; scene.add(scanRoot);
  pinRoot = new THREE.Group(); pinRoot.name = 'pins'; scene.add(pinRoot);
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

const SKY_SCALE = 0.3, ENV_SKY_SCALE = 0.16;
function makeSky(forEnv) {
  const s = new Sky();
  s.scale.setScalar(2000);
  // The environment bake has no sun disc (the DirectionalLight is the sun) and is scaled so
  // the sky's irradiance sits in a believable ratio to direct sunlight.
  if (forEnv) s.material.uniforms.showSunDisc.value = 0;
  s.material.uniforms.cloudCoverage.value = 0.35;
  s.material.uniforms.cloudDensity.value = 0.45;
  // Scale the sky into the same range as the sun-lit model and clamp it so bloom and the
  // PMREM never see infinities (the raw shader reaches 1e7 in the sun disc).
  let fs = s.material.fragmentShader;
  fs = fs.replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( min( texColor * ' + (forEnv ? ENV_SKY_SCALE : SKY_SCALE) + ', vec3( ' + (forEnv ? '2.0' : '40.0') + ' ) ), 1.0 );');
  s.material.fragmentShader = fs;
  s.material.needsUpdate = true;
  return s;
}

// CPU port of the Sky shader's atmosphere term, evaluated just above the horizon and averaged
// over the compass, so the fog that hides the ground's edge is the same colour as the sky
// meeting it. No GPU readback needed.
function skyHorizonColor() {
  const u = sky.material.uniforms;
  const sunDir = u.sunPosition.value.clone().normalize();
  const cosZen = THREE.MathUtils.clamp(sunDir.y, -1, 1);
  const sunE = 1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - Math.acos(cosZen)) / 1.5)));
  const sunfade = 1 - THREE.MathUtils.clamp(1 - Math.exp(u.sunPosition.value.y / 450000), 0, 1);
  const rayleighC = u.rayleigh.value - (1 - sunfade);
  const betaR = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5].map(x => x * rayleighC);
  const mieC = 0.2 * u.turbidity.value * 10e-18;
  const betaM = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14].map(x => 0.434 * mieC * x * u.mieCoefficient.value);
  const g = u.mieDirectionalG.value, g2 = g * g;
  const acc = [0, 0, 0];
  const dirs = [new THREE.Vector3(1, 0.03, 0), new THREE.Vector3(-1, 0.03, 0), new THREE.Vector3(0, 0.03, 1), new THREE.Vector3(0, 0.03, -1)];
  for (const d of dirs) {
    d.normalize();
    const zen = Math.acos(Math.max(0, d.y));
    const inv = 1 / (Math.cos(zen) + 0.15 * Math.pow(93.885 - zen * 180 / Math.PI, -1.253));
    const sR = 8.4e3 * inv, sM = 1.25e3 * inv;
    const cosT = d.dot(sunDir);
    const rPhase = 0.05968310365946075 * (1 + Math.pow(cosT * 0.5 + 0.5, 2));
    const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(1 - 2 * g * cosT + g2, 1.5));
    const k = THREE.MathUtils.clamp(Math.pow(1 - sunDir.y, 5), 0, 1);
    for (let i = 0; i < 3; i++) {
      const fex = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
      const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
      let lin = Math.pow(Math.max(0, sunE * ratio * (1 - fex)), 1.5);
      lin *= (1 - k) + k * Math.sqrt(Math.max(0, sunE * ratio * fex));
      const tex = (lin + 0.1 * fex) * 0.04 + [0, 0.0003, 0.00075][i];
      acc[i] += Math.min(tex * SKY_SCALE, 40) / dirs.length;
    }
  }
  return new THREE.Color(acc[0], acc[1], acc[2]);
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
  const gtaoRender = passes.gtao.render.bind(passes.gtao);
  passes.gtao.render = (...args) => { const hidden = hideSplats(); gtaoRender(...args); hidden.forEach(o => { o.visible = true; }); };

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

function applyQuality() {
  const q = prop.env.quality || 'high';
  passes.gtao.enabled = q === 'high';
  passes.bloom.enabled = q !== 'low';
  const size = SHADOW_SIZE[q] || 2048;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  resize();
}

// ---------- model ----------
function rebuildModel() {
  if (modelGroup) { scene.remove(modelGroup); disposeBuilt(modelGroup); }
  modelGroup = buildPropertyGroup(prop, { xray });
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

function rebuildNightLights() {
  while (lightRoot.children.length) { const c = lightRoot.children.pop(); disposeBuilt(c); }
  const H = wallHeight();
  const discGeo = new THREE.CircleGeometry(0.11, 24);
  discGeo.rotateX(Math.PI / 2);
  const discMat = new THREE.MeshStandardMaterial({ color: 0xfff1dc, emissive: new THREE.Color(0xffd9a8), emissiveIntensity: 5, roughness: 0.6 });
  discMat.userData.disposable = true;
  for (const r of roomCentres(prop)) {
    const light = new THREE.PointLight(0xffc48a, 14, 0, 2);
    light.position.set(r.x, H - 0.12, r.z);
    lightRoot.add(light);
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.set(r.x, H - 0.035, r.z);
    disc.userData = { kind: 'ceiling', id: r.id };
    lightRoot.add(disc);
  }
}

function fitShadow() {
  const b = modelBounds(prop);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
  const H = wallHeight();
  const R = Math.max(Math.hypot(b.maxX - b.minX, b.maxY - b.minY, H) / 2 * 1.15, 4);
  sun.target.position.set(cx, H / 2, cz);
  const c = sun.shadow.camera;
  c.left = -R; c.right = R; c.top = R; c.bottom = -R;
  c.near = R * 0.5; c.far = R * 5.5;
  c.updateProjectionMatrix();
  sun.userData.radius = R;
  sunDirty = true;
}

// ---------- environment: sun, sky, IBL, night ----------
function sunElevation(t) {
  if (t < 6 || t > 20) return -12 - Math.min(Math.abs(t - 6), Math.abs(t - 20)) * 4;
  return t < 12 ? 65 * Math.sin(Math.PI / 2 * (t - 6) / 6) : 65 * Math.sin(Math.PI / 2 * (20 - t) / 8);
}
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
function isNight() { return sunElevation(prop.env.time) < 0; }

function applyEnvironment() {
  const env = prop.env;
  const el = sunElevation(env.time);
  const night = el < 0;
  const dusk = THREE.MathUtils.clamp(el / 18, 0, 1);         // 0 at horizon, 1 above 18 deg
  const dir = sunDirection(Math.max(el, -8), env.azimuth);

  // Sky.
  sky.visible = env.sky === 'dynamic';
  for (const s of [sky, envSky]) {
    const u = s.material.uniforms;
    u.sunPosition.value.copy(dir);
    u.turbidity.value = night ? 2 : 2.2 + (1 - dusk) * 6;
    u.rayleigh.value = night ? 0.6 : 0.9 + (1 - dusk) * 2.2;
    u.mieCoefficient.value = night ? 0.002 : 0.003 + (1 - dusk) * 0.02;
    u.mieDirectionalG.value = 0.82;
  }

  // Sun (or moon): warm and low near the horizon, white overhead.
  const R = sun.userData.radius || 10;
  if (!night) {
    sun.color.setHex(0xfff1dc).lerp(new THREE.Color(0xffa860), 1 - dusk);
    sun.intensity = 0.9 + 3.0 * Math.pow(Math.sin(THREE.MathUtils.degToRad(el)), 0.6);
    sun.position.copy(sun.target.position).addScaledVector(dir, R * 3);
  } else {
    const moon = sunDirection(38, env.azimuth + 160);
    sun.color.setHex(0x9fb4d6);
    sun.intensity = 0.28;
    sun.position.copy(sun.target.position).addScaledVector(moon, R * 3);
  }
  hemi.color.setHex(night ? 0x2a3b55 : 0xc4d8ef).lerp(new THREE.Color(0xf0c8a0), night ? 0 : (1 - dusk) * 0.6);
  hemi.groundColor.setHex(night ? 0x0d1014 : 0x5a5446);
  hemi.intensity = night ? 0.2 : 0.18 + 0.1 * dusk;
  scene.environmentIntensity = env.sky === 'studio' ? 0.9 : (night ? 0.3 : 0.22 + 0.1 * dusk);
  if (interiorFill && !night) {
    hemi.color.setHex(0xe9e2d6); hemi.groundColor.setHex(0x8c8478);
    hemi.intensity = 0.7; scene.environmentIntensity *= 1.6;
  }
  // A camera would open up at dusk; lift the exposure as the sun drops toward the horizon.
  renderer.toneMappingExposure = (env.exposure || 1) * (night ? 0.6 : 1 + 0.45 * (1 - dusk));

  // Fog fades the ground into the horizon, in exactly the sky's horizon colour.
  const fogColor = env.sky === 'studio' ? new THREE.Color(0x171d23) : skyHorizonColor();
  const b = modelBounds(prop);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 8);
  if (env.sky === 'pano') scene.fog = null;
  else scene.fog = new THREE.Fog(fogColor, span * 4, Math.max(span * 9, 110));

  // Night lights (and a gentle daytime level while walking through rooms).
  const lightsOn = (night && env.nightLights !== false) || interiorFill;
  lightRoot.visible = lightsOn;
  lightRoot.traverse(o => { if (o.isPointLight) o.intensity = night ? 14 : 5; if (o.isMesh) o.material.emissiveIntensity = night ? 5 : 1.4; });
  if (modelGroup && modelGroup.userData.glass) {
    const g = modelGroup.userData.glass;
    g.emissive.setHex(0xffcf9a);
    g.emissiveIntensity = night && env.nightLights !== false ? 0.5 : 0;
  }
  // Background / IBL per sky mode.
  if (env.sky === 'studio') {
    scene.background = new THREE.Color(0x171d23);
    scheduleEnvMap(0);
  } else if (env.sky === 'pano') {
    if (panoTex && panoId === env.panoPhotoId) { scene.background = panoTex; }
    else { scene.background = new THREE.Color(0x0c1013); loadPano(env.panoPhotoId); }
    scheduleEnvMap(0);
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
  } else if (env.sky === 'pano') {
    if (!panoTex) return;
    rt = pmrem.fromEquirectangular(panoTex);
  } else {
    rt = pmrem.fromScene(skyScene, 0, 0.1, 3000);
  }
  if (envRT) envRT.dispose();
  envRT = rt;
  scene.environment = rt.texture;
  requestRender(3);
}

let panoNagged = false;
async function loadPano(id) {
  if (!id) { if (!panoNagged) toast('Choose a panorama photo in the ENVIRONMENT panel (add a 2:1 image with PIN PHOTO > ADD PHOTO).'); panoNagged = true; return; }
  const url = await photoUrl(id);
  if (!url || !scene) return;
  new THREE.TextureLoader().load(url, tex => {
    if (!scene) { tex.dispose(); return; }
    if (panoTex) panoTex.dispose();
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    panoTex = tex; panoId = id;
    if (prop.env.sky === 'pano') { scene.background = tex; regenEnvMap(); }
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
  if (!section.on || !modelGroup) return;
  const rects = wallCapRects(prop, section.height);
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
  requestRender(2);
}

// ---------- camera framing ----------
function boundsInfo() {
  const b = modelBounds(prop);
  const H = wallHeight();
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
  const rooms = (prop.rooms || []).filter(r => r.pts && r.pts.length > 2);
  const selRoom = selection && selection.kind === 'room' && rooms.find(r => r.id === selection.id);
  const r = selRoom || rooms.slice().sort((a, b) => polyArea(b.pts) - polyArea(a.pts))[0];
  if (r) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of r.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const longX = (maxX - minX) >= (maxY - minY);
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    if (longX) { sx = minX + (maxX - minX) * 0.3; sz = my; look.set(maxX, 1.45, my); }
    else { sx = mx; sz = minY + (maxY - minY) * 0.3; look.set(mx, 1.45, maxY); }
  }
  camera.position.set(sx, 1.6, sz);
  if (look.distanceTo(camera.position) < 0.5) look.set(sx, 1.5, sz - 5);
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
  camera.position.y = 1.6;
  return true;
}

// ---------- render loop ----------
function tick(time) {
  if (!scene) return;
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
  const H = wallHeight();
  let inside = camera.position.y < H - 0.05;
  if (inside) {
    inside = false;
    for (const r of prop.rooms || []) if (r.pts && r.pts.length > 2 && pointInPolygon(camera.position.x, camera.position.z, r.pts)) { inside = true; break; }
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
  const H = wallHeight();
  updateInteriorFill();
  const ceilings = modelGroup && modelGroup.userData.ceilings;
  if (ceilings) ceilings.visible = prop.env.showCeilings !== false && (mode === 'walk' || camera.position.y < H - 0.05);
  updatePins();
  updateMeasureLabels();
  updateCompass();
  composer.render();
}

function resize() {
  if (!wrapEl || !renderer || !composer) return;
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
function renderStill(scale) {
  const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
  const pr = renderer.getPixelRatio();
  toast('Rendering ' + (w * scale) + ' x ' + (h * scale) + ' ...', 'info', 1500);
  try {
    renderer.setPixelRatio(1); composer.setPixelRatio(1);
    renderer.setSize(w * scale, h * scale, false);
    composer.setSize(w * scale, h * scale);
    for (const m of measures) m.line.material.resolution.set(w * scale, h * scale);
    composer.render();
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    const slug = String(prop.name || 'property').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'property';
    a.href = url; a.download = 'tiksi-' + slug + '-' + isoToday() + '.png';
    a.click();
  } catch (e) {
    toast('Render failed: ' + e.message, 'error');
  } finally {
    renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
    renderer.setSize(w, h);
    composer.setSize(w, h);
    for (const m of measures) m.line.material.resolution.set(w * pr, h * pr);
    requestRender(2);
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
  if (opts.scans !== false && scanRoot) targets.push(scanRoot);
  if (opts.ground && groundGroup) targets.push(groundGroup);
  const hits = raycaster.intersectObjects(targets, true);
  for (const h of hits) {
    if (!isVisibleChain(h.object)) continue;
    if (h.object.userData && h.object.userData.pickBox && !opts.scans) continue;
    let o = h.object;
    while (o && (!o.userData || !o.userData.kind)) o = o.parent;
    if (!o) continue;
    if (o.userData.kind === 'grid') continue;
    if (opts.surfaceOnly && ['pin', 'scan'].includes(o.userData.kind)) continue;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { kind: o.userData.kind, id: o.userData.id, point: h.point, normal: n, object: o, wallId: o.userData.wallId };
  }
  return null;
}

function onPointerDown(e) {
  if (e.button !== 0) { pressed = null; return; }
  pressed = { x: e.clientX, y: e.clientY };
  if (mode === 'walk' && !walkLocked) dragLook = { x: e.clientX, y: e.clientY };
}
function onPointerUp(e) {
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
  const hit = pick(e);
  if (!hit || hit.kind === 'ground') { setSelection(null); return; }
  if (hit.kind === 'pin') { setSelection({ kind: 'pin', id: hit.id }); openLightbox(hit.id); return; }
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
    if (tool === 'measure' || tool === 'pin') renderer.domElement.style.cursor = hit ? 'crosshair' : 'default';
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
  selection = sel;
  updateOutlineTargets();
  reattachGizmo();
  renderInspector();
  renderToolCol();
  requestRender(2);
}

// ---------- move walls gizmo ----------
function reattachGizmo() {
  gizmo.detach();
  if (tool === 'move' && selection && selection.kind === 'wall') {
    const g = findGroupFor('wall', selection.id);
    if (g) { gizmo.attach(g); g.userData.origin = g.position.clone(); }
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
  w.ax = r(w.ax + dx); w.ay = r(w.ay + dz);
  w.bx = r(w.bx + dx); w.by = r(w.by + dz);
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
  line.userData = { kind: 'pin', id: photo.id };
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
function startPinMode(photoId) {
  tool = 'pin';
  pinPhotoId = photoId || pinPhotoId || (prop.photos[0] && prop.photos[0].id) || null;
  gizmo.detach();
  renderToolCol(); renderInspector();
  setHint(pinPhotoId ? 'PIN PHOTO: click any surface to place the photo there. Esc cancels.' : 'PIN PHOTO: add or choose a photo in the inspector, then click a surface.');
}
function placePin(e) {
  if (!pinPhotoId) { toast('Choose a photo first (or ADD PHOTO).', 'warn'); return; }
  const hit = pick(e, { ground: true, surfaceOnly: true, scans: true });
  if (!hit) return;
  const ph = photoById(prop, pinPhotoId);
  if (!ph) { pinPhotoId = null; renderInspector(); return; }
  const size = (ph.pin && ph.pin.size) || 0.6;
  ph.pin = { x: hit.point.x, y: hit.point.y, z: hit.point.z, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, size };
  if (hit.kind === 'room' || hit.kind === 'wall' || hit.kind === 'opening') {
    ph.elementIds = ph.elementIds || [];
    const elId = hit.kind === 'opening' ? hit.wallId : hit.id;
    if (elId && !ph.elementIds.includes(elId)) ph.elementIds.push(elId);
    if (hit.kind === 'room') ph.roomId = hit.id;
  }
  touch();
  buildPin(ph);
  tool = 'select';
  setSelection({ kind: 'pin', id: ph.id });
  toast('Photo pinned. Click it to open, MOVE PIN to re-place.', 'ok');
  setHint('');
}
function flyToPin(id) {
  const r = pinObjs[id];
  if (!r) return;
  const dir = r.normal.clone();
  if (Math.abs(dir.y) > 0.8) dir.add(new THREE.Vector3(0.4, 0, 0.6)).normalize();
  const pos = r.anchor.clone().addScaledVector(dir, 3.2).add(new THREE.Vector3(0, 0.9, 0));
  if (mode === 'walk') setMode('orbit');
  flyTo(pos, r.anchor.clone(), 700);
}

// ---------- lightbox ----------
async function openLightbox(photoId) {
  const ph = photoById(prop, photoId);
  if (!ph) return;
  const url = await photoUrl(photoId);
  const box = document.createElement('div');
  box.className = 'v-lightbox';
  box.innerHTML = `<img alt="" src="${url || ph.thumb}"><div class="v-lb-cap">${escapeHtml(ph.name || '')}${ph.notes ? ' - ' + escapeHtml(ph.notes) : ''}</div><button class="v-lb-close">CLOSE</button>`;
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
async function addScanToScene(scan) {
  const obj = await loadScanObject(scan, hooks);
  if (!obj || !scene) return null;
  if (scanObjs[scan.id]) { scanRoot.remove(scanObjs[scan.id]); disposeScanObject(scanObjs[scan.id]); }
  scanObjs[scan.id] = obj;
  applyScanTransform(scan, obj);
  scanRoot.add(obj);
  applySection();
  updateOutlineTargets();
  requestRender(scan.kind === 'splat' ? 8 : 3);
  return obj;
}
async function loadAllScans() {
  for (const scan of prop.scans) {
    try { await addScanToScene(scan); }
    catch (e) { console.error(e); toast('Could not load scan ' + scan.name + ': ' + e.message, 'error'); }
    if (!scene) return;
  }
  renderToolCol();
}
async function onImportScan(file) {
  if (!file) return;
  let scan = null;
  try { scan = await importScanFile(file, prop, hooks); }
  catch (e) { console.error(e); toast('Import failed: ' + e.message, 'error'); showProgress(null); return; }
  if (!scan || !scene) return;
  try {
    const obj = await addScanToScene(scan);
    if (obj) { centerScanOnModel(scan, obj, modelBounds(prop)); applyScanTransform(scan, obj); touch(); }
    setSelection({ kind: 'scan', id: scan.id });
    toast('Imported ' + scan.name + ' (' + scanStats(obj).label + ').', 'ok');
  } catch (e) {
    console.error(e); toast('Could not display ' + scan.name + ': ' + e.message, 'error');
  }
  showProgress(null);
  renderToolCol();
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
  if (tool === 'move') return 'MOVE WALLS: select a wall, drag the gizmo arrows to slide it; release to commit.';
  if (section.on) return 'SECTION: slide the cut height in the mode bar to look inside.';
  return 'Drag to orbit, right-drag to pan, scroll to zoom. Click elements to inspect; hover shows outlines.';
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
  const H = wallHeight();
  bar.innerHTML = `
    <button class="v-pill ${mode === 'orbit' ? 'active' : ''}" data-mode="orbit" title="Orbit (O)">ORBIT</button>
    <button class="v-pill ${mode === 'walk' ? 'active' : ''}" data-mode="walk" title="Walk through (W)">WALK</button>
    <button class="v-pill ${mode === 'top' ? 'active' : ''}" data-mode="top" title="Top, north up (T)">TOP</button>
    <span class="v-pill-sep"></span>
    <button class="v-pill ${section.on ? 'active' : ''}" data-section title="Section cut (C)">SECTION</button>
    ${section.on ? `<input type="range" class="v-section-range" min="0.3" max="${(H + 0.3).toFixed(2)}" step="0.05" value="${section.height}" title="Cut height">
      <span class="v-section-val">${escapeHtml(fmtLen(section.height))}</span>` : ''}
    <span class="v-pill-sep"></span>
    <button class="v-pill ${xray ? 'active' : ''}" data-xray title="X-ray (X)">X-RAY</button>`;
  bar.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  bar.querySelector('[data-section]').onclick = toggleSection;
  bar.querySelector('[data-xray]').onclick = toggleXray;
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
  if (section.on && section.height > wallHeight()) section.height = Math.min(1.2, wallHeight() * 0.5);
  applySection();
  renderHud();
}
function toggleXray() { xray = !xray; rebuildModel(); renderHud(); renderToolCol(); }

// ---------- environment panel ----------
function renderEnvPanel() {
  const p = hud.env;
  if (!p) return;
  const env = prop.env;
  const el = sunElevation(env.time);
  const panos = prop.photos.filter(ph => ph.kind === 'pano');
  const hh = Math.floor(env.time), mm = Math.round((env.time - hh) * 60);
  const timeLabel = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  p.innerHTML = `
    <button class="v-env-head" data-toggle><span>ENVIRONMENT</span><span class="v-env-sun">${el < 0 ? 'NIGHT' : 'SUN ' + Math.round(el) + '&deg;'} &middot; ${timeLabel}</span><span class="v-env-caret">${p.classList.contains('open') ? '&#9662;' : '&#9656;'}</span></button>
    <div class="v-env-body">
      <label class="v-row"><span>TIME</span><input type="range" min="0" max="24" step="0.1" value="${env.time}" data-env="time"><b class="v-arc"><i style="left:${(env.time / 24 * 100).toFixed(1)}%"></i></b></label>
      <label class="v-row"><span>SUN AZIMUTH</span><input type="range" min="0" max="360" step="1" value="${env.azimuth}" data-env="azimuth"><em>${Math.round(env.azimuth)}&deg;</em></label>
      <label class="v-row"><span>NORTH</span><input type="range" min="0" max="360" step="1" value="${env.north}" data-env="north"><em>${Math.round(env.north)}&deg;</em></label>
      <label class="v-row"><span>EXPOSURE</span><input type="range" min="0.3" max="2.2" step="0.05" value="${env.exposure}" data-env="exposure"><em>${Number(env.exposure).toFixed(2)}</em></label>
      <div class="v-row v-row-sel"><span>SKY</span>
        <select data-env="sky"><option value="dynamic" ${env.sky === 'dynamic' ? 'selected' : ''}>Dynamic sun</option><option value="studio" ${env.sky === 'studio' ? 'selected' : ''}>Studio</option><option value="pano" ${env.sky === 'pano' ? 'selected' : ''}>Panorama</option></select>
        ${env.sky === 'pano' ? `<select data-env="panoPhotoId"><option value="">(choose pano)</option>${panos.map(ph => `<option value="${ph.id}" ${ph.id === env.panoPhotoId ? 'selected' : ''}>${escapeHtml(ph.name)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="v-row v-row-sel"><span>QUALITY</span>
        <select data-env="quality"><option value="high" ${env.quality === 'high' ? 'selected' : ''}>High (AO + bloom)</option><option value="medium" ${env.quality === 'medium' ? 'selected' : ''}>Medium</option><option value="low" ${env.quality === 'low' ? 'selected' : ''}>Low</option></select>
      </div>
      <div class="v-checks">
        <label><input type="checkbox" data-env="showCeilings" ${env.showCeilings !== false ? 'checked' : ''}> CEILINGS</label>
        <label><input type="checkbox" data-env="showGround" ${env.showGround !== false ? 'checked' : ''}> GROUND</label>
        <label><input type="checkbox" data-env="showGrid" ${env.showGrid ? 'checked' : ''}> GRID</label>
        <label><input type="checkbox" data-env="nightLights" ${env.nightLights !== false ? 'checked' : ''}> NIGHT LIGHTS</label>
      </div>
    </div>`;
  p.querySelector('[data-toggle]').onclick = () => { p.classList.toggle('open'); renderEnvPanel(); };
  let touchTimer = 0;
  const commit = () => { clearTimeout(touchTimer); touchTimer = setTimeout(() => touch(), 400); };
  p.querySelectorAll('input[type=range]').forEach(r => {
    r.oninput = () => {
      env[r.dataset.env] = parseFloat(r.value);
      const em = r.parentElement.querySelector('em');
      if (em) em.textContent = r.dataset.env === 'exposure' ? Number(r.value).toFixed(2) : Math.round(r.value) + '°';
      if (r.dataset.env === 'time') {
        const arc = r.parentElement.querySelector('.v-arc i'); if (arc) arc.style.left = (env.time / 24 * 100).toFixed(1) + '%';
        const e2 = sunElevation(env.time); const h2 = Math.floor(env.time), m2 = Math.round((env.time - h2) * 60);
        p.querySelector('.v-env-sun').innerHTML = (e2 < 0 ? 'NIGHT' : 'SUN ' + Math.round(e2) + '&deg;') + ' &middot; ' + String(h2).padStart(2, '0') + ':' + String(m2).padStart(2, '0');
      }
      applyEnvironment();
      commit();
    };
  });
  p.querySelectorAll('select').forEach(s => {
    s.onchange = () => {
      env[s.dataset.env] = s.value || null;
      if (s.dataset.env === 'quality') applyQuality();
      if (s.dataset.env === 'sky') rebuildGround();
      applyEnvironment();
      touch();
      renderEnvPanel();
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
    `<button class="v-thumb" data-open-photo="${ph.id}" title="${escapeHtml(ph.name)}"><img src="${ph.thumb}" alt=""></button>`).join('')}</div></div>`;
}
function bindPhotoLinks(root) {
  root.querySelectorAll('[data-open-photo]').forEach(b => b.onclick = () => openLightbox(b.dataset.openPhoto));
}

function pinsListHtml() {
  const pinned = prop.photos.filter(ph => ph.pin);
  if (!pinned.length) return '';
  return `<h3 style="margin-top:14px">PHOTO PINS</h3>` + pinned.map(ph => `
    <div class="v-pin-row">
      <img src="${ph.thumb}" alt="">
      <span class="v-pin-name">${escapeHtml(ph.name)}</span>
      <button class="btn small" data-locate="${ph.id}" title="Fly to pin">LOCATE</button>
      <button class="btn small danger" data-unpin="${ph.id}" title="Remove pin">&times;</button>
    </div>`).join('');
}
function bindPinsList(root) {
  root.querySelectorAll('[data-locate]').forEach(b => b.onclick = () => { setSelection({ kind: 'pin', id: b.dataset.locate }); flyToPin(b.dataset.locate); });
  root.querySelectorAll('[data-unpin]').forEach(b => b.onclick = () => unpin(b.dataset.unpin));
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
  inspEl.innerHTML = `<h3>PIN PHOTO</h3>
    <div class="empty">Pick a photo, then click any wall, floor, ground or scan surface to pin it there.</div>
    <div class="v-thumbs">${prop.photos.map(ph => `<button class="v-thumb ${ph.id === pinPhotoId ? 'active' : ''}" data-pick="${ph.id}" title="${escapeHtml(ph.name)}"><img src="${ph.thumb}" alt="">${ph.pin ? '<i class="v-pinned">PINNED</i>' : ''}</button>`).join('')}</div>
    ${prop.photos.length ? '' : '<div class="empty" style="margin-top:8px">No photos on this property yet.</div>'}
    <button class="btn primary" data-add>ADD PHOTO</button>
    <input type="file" class="hidden-file" accept="image/*" multiple>
    <button class="btn" data-cancel>CANCEL</button>`;
  inspEl.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { pinPhotoId = b.dataset.pick; renderPinPanel(); setHint('PIN PHOTO: click any surface to place the photo there.'); });
  const file = inspEl.querySelector('input[type=file]');
  inspEl.querySelector('[data-add]').onclick = () => file.click();
  file.onchange = async () => {
    const files = Array.from(file.files || []);
    file.value = '';
    for (const f of files) {
      try { const rec = await addPhotoFromFile(prop, f); pinPhotoId = rec.id; }
      catch (e) { toast('Could not add ' + f.name + ': ' + e.message, 'error'); }
    }
    if (tool === 'pin') renderPinPanel();
    renderEnvPanel();
  };
  inspEl.querySelector('[data-cancel]').onclick = () => { tool = 'select'; renderToolCol(); renderInspector(); setHint(''); };
}

function renderInspector() {
  if (!inspEl) return;
  if (tool === 'pin') return renderPinPanel();
  if (!selection) {
    inspEl.innerHTML = `<h3>MODEL</h3>
      <div class="stat-line"><span>Walls</span><b>${prop.walls.length}</b></div>
      <div class="stat-line"><span>Openings</span><b>${prop.openings.length}</b></div>
      <div class="stat-line"><span>Rooms</span><b>${prop.rooms.length}</b></div>
      <div class="stat-line"><span>Scans</span><b>${prop.scans.length}</b></div>
      <div class="stat-line"><span>Photos</span><b>${prop.photos.length}</b></div>
      <div class="empty" style="margin-top:12px">
        Click a wall, door, window or floor to inspect and edit it. The model regenerates from the plan; edits here write back to the same data.</div>
      ${pinsListHtml()}`;
    bindPinsList(inspEl);
    return;
  }
  if (selection.kind === 'wall') {
    const w = prop.walls.find(w => w.id === selection.id);
    if (!w) { selection = null; return renderInspector(); }
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    const h = w.height || prop.wallHeight;
    const nOpen = prop.openings.filter(o => o.wallId === w.id).length;
    inspEl.innerHTML = `<h3>WALL</h3>
      <div class="stat-line"><span>Length</span><b>${fmtLen(L)}</b></div>
      <div class="stat-line"><span>Face area</span><b>${fmtArea(L * h)}</b></div>
      <div class="stat-line"><span>Openings</span><b>${nOpen}</b></div>
      <div class="field"><label>Thickness</label><input type="text" data-th value="${escapeHtml(fmtLen(w.thickness))}"></div>
      <div class="field"><label>Height (blank = default)</label><input type="text" data-h value="${w.height ? escapeHtml(fmtLen(w.height)) : ''}" placeholder="${escapeHtml(fmtLen(prop.wallHeight))}"></div>
      <div class="field"><label>Material</label>${materialSelectHtml('wall', w.material, 'data-mat')}</div>
      ${scopeAssignHtml(w.id)}
      ${linkedProductsHtml(w.id)}
      ${photoLinksHtml(w.id)}
      <div class="empty" style="margin:8px 0">MOVE WALLS: drag the gizmo arrows to slide this wall in plan; release to commit.</div>
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
    inspEl.querySelector('[data-walk]').onclick = () => setMode('walk');
    inspEl.querySelector('[data-del]').onclick = () => {
      prop.walls = prop.walls.filter(x => x.id !== w.id);
      prop.openings = prop.openings.filter(o => o.wallId !== w.id);
      setSelection(null);
      touch(); rebuildModel();
    };
    bindAssign(inspEl); bindPhotoLinks(inspEl);
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
      <div class="field"><label>Position along wall</label><input type="range" min="0.02" max="0.98" step="0.005" value="${o.t}" data-t></div>
      <div class="empty">Doors wider than 4 ft become cased openings. Interior doors stand ajar so you can see through rooms.</div>
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
    return;
  }
  if (selection.kind === 'room') {
    const r = prop.rooms.find(r => r.id === selection.id);
    if (!r) { selection = null; return renderInspector(); }
    inspEl.innerHTML = `<h3>ROOM / FLOOR</h3>
      <div class="field"><label>Name</label><input type="text" data-name value="${escapeHtml(r.name || '')}"></div>
      <div class="stat-line"><span>Area</span><b>${fmtArea(polyArea(r.pts))}</b></div>
      <div class="field"><label>Floor material</label>${materialSelectHtml('floor', r.material, 'data-mat')}</div>
      <div class="field"><label>Ceiling material</label>${materialSelectHtml('ceiling', r.ceilingMaterial, 'data-cmat')}</div>
      ${scopeAssignHtml(r.id)}
      ${linkedProductsHtml(r.id)}
      ${photoLinksHtml(r.id)}
      <button class="btn" data-walk>WALK INTO ROOM</button>`;
    inspEl.querySelector('[data-name]').onchange = e => { r.name = e.target.value; touch(); };
    inspEl.querySelector('[data-mat]').onchange = e => { r.material = e.target.value || null; touch(); rebuildModel(); };
    inspEl.querySelector('[data-cmat]').onchange = e => { r.ceilingMaterial = e.target.value || null; touch(); rebuildModel(); };
    inspEl.querySelector('[data-walk]').onclick = () => setMode('walk');
    bindAssign(inspEl); bindPhotoLinks(inspEl);
    return;
  }
  if (selection.kind === 'pin') {
    const ph = photoById(prop, selection.id);
    if (!ph || !ph.pin) { selection = null; return renderInspector(); }
    inspEl.innerHTML = `<h3>PHOTO PIN</h3>
      <button class="v-thumb big" data-open><img src="${ph.thumb}" alt=""></button>
      <div class="stat-line"><span>${escapeHtml(ph.name)}</span><b>${ph.w || '?'} x ${ph.h || '?'}</b></div>
      <div class="field"><label>Notes</label><textarea data-notes>${escapeHtml(ph.notes || '')}</textarea></div>
      <div class="field"><label>Card size</label><input type="range" min="0.25" max="2.5" step="0.05" value="${ph.pin.size || 0.6}" data-size></div>
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
  if (selection.kind === 'scan') {
    const s = prop.scans.find(s => s.id === selection.id);
    if (!s) { selection = null; return renderInspector(); }
    const obj = scanObjs[s.id];
    const st = obj ? scanStats(obj) : { label: 'loading' };
    const rot = s.rot || [0, s.rotY || 0, 0];
    const isPts = s.kind === 'points', isSplat = s.kind === 'splat';
    inspEl.innerHTML = `<h3>SCAN</h3>
      <div class="stat-line"><span>File</span><b title="${escapeHtml(s.name)}">${escapeHtml(s.name.length > 22 ? s.name.slice(0, 20) + '...' : s.name)}</b></div>
      <div class="stat-line"><span>Kind</span><b>${escapeHtml(s.kind || '?')} &middot; ${escapeHtml((s.format || '').toUpperCase())}</b></div>
      <div class="stat-line"><span>${isSplat ? 'Splats' : (isPts ? 'Points' : 'Triangles')}</span><b>${escapeHtml(st.label)}</b></div>
      <div class="field-row">
        <div class="field"><label>X</label><input type="number" step="0.1" data-p="0" value="${s.pos[0]}"></div>
        <div class="field"><label>Y (up)</label><input type="number" step="0.1" data-p="1" value="${s.pos[1]}"></div>
        <div class="field"><label>Z</label><input type="number" step="0.1" data-p="2" value="${s.pos[2]}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Rot X</label><input type="number" step="5" data-r="0" value="${rot[0]}"></div>
        <div class="field"><label>Rot Y</label><input type="number" step="5" data-r="1" value="${rot[1]}"></div>
        <div class="field"><label>Rot Z</label><input type="number" step="5" data-r="2" value="${rot[2]}"></div>
      </div>
      <div class="field"><label>Scale</label><input type="number" step="0.05" data-scale value="${s.scale || 1}"></div>
      ${isPts ? `<div class="field"><label>Point size</label><input type="range" min="0.002" max="0.08" step="0.001" value="${s.pointSize || 0.012}" data-ps></div>
      <div class="field"><label>Colour</label><select data-pc><option value="rgb" ${s.pointColor === 'rgb' ? 'selected' : ''}>Scan colours</option><option value="height" ${s.pointColor === 'height' ? 'selected' : ''}>Height ramp</option><option value="solid" ${s.pointColor === 'solid' ? 'selected' : ''}>Solid amber</option></select></div>` : ''}
      ${isSplat ? `<button class="btn" data-flip>FLIP UP AXIS</button>` : ''}
      <label class="tool-check"><input type="checkbox" ${s.visible !== false ? 'checked' : ''} data-vis> VISIBLE</label>
      <button class="btn" data-frame>FRAME SCAN</button>
      <button class="btn" data-floor>DROP TO FLOOR</button>
      <button class="btn" data-center>CENTER ON MODEL</button>
      <button class="btn danger" data-del>DELETE SCAN</button>`;
    const upd = () => { applyScanTransform(s, obj); touch(); requestRender(3); };
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
    inspEl.querySelector('[data-del]').onclick = async () => {
      prop.scans = prop.scans.filter(x => x.id !== s.id);
      if (obj) { scanRoot.remove(obj); disposeScanObject(obj); delete scanObjs[s.id]; }
      await deleteFile(s.id);
      setSelection(null);
      touch();
      renderToolCol();
    };
    return;
  }
}

// ---------- tool column ----------
function renderToolCol() {
  const tc = el && el.querySelector('.tool-col');
  if (!tc) return;
  // Same button anatomy as the plan editor: icon, label, key badge.
  const tb = (act, ic, label, key, active) =>
    `<button class="tool-btn ${active ? 'active' : ''}" data-act="${act}" title="${label}${key ? ' (' + key + ')' : ''}">` +
    `${icon(ic)}<span class="tb-text">${label}</span>${key ? `<kbd class="key">${key}</kbd>` : ''}</button>`;
  const scanRows = prop.scans.map(s => `<button class="tool-btn v-scan-row ${selection && selection.kind === 'scan' && selection.id === s.id ? 'active' : ''}" data-scan="${s.id}" title="${escapeHtml(s.name)}">${icon(s.kind === 'splat' ? 'splat' : s.kind === 'mesh' ? 'model' : 'scan')}<span class="tb-text">${escapeHtml(s.name.length > 14 ? s.name.slice(0, 12) + '..' : s.name)}</span><kbd class="key">${escapeHtml((s.kind || '').toUpperCase().slice(0, 5))}</kbd></button>`).join('');
  tc.innerHTML = `
    <div class="tool-head">VIEW</div>
    ${tb('frame', 'frame', 'FRAME', 'F')}
    ${tb('front', 'target', 'FRONT')}
    ${tb('iso', 'model', 'ISO')}
    ${tb('top', 'top', 'TOP', 'T')}
    ${tb('walk', 'walk', 'WALK', 'W', mode === 'walk')}
    <div class="tool-sep"></div>
    <div class="tool-head">TOOLS</div>
    ${tb('select', 'select', 'SELECT', 'V', tool === 'select')}
    ${tb('move', 'move', 'MOVE WALLS', 'M', tool === 'move')}
    ${tb('measure', 'measure', 'MEASURE', 'D', tool === 'measure')}
    ${measures.length ? tb('clearm', 'close', 'CLEAR MEASURES') : ''}
    ${tb('pin', 'pin', 'PIN PHOTO', 'P', tool === 'pin')}
    ${tb('section', 'section', 'SECTION', 'C', section.on)}
    ${tb('xray', 'xray', 'X-RAY', 'X', xray)}
    <div class="tool-sep"></div>
    <div class="tool-head">RENDER</div>
    ${tb('render2', 'camera', 'STILL 2x')}
    ${tb('render3', 'camera', 'STILL 3x')}
    <div class="tool-sep"></div>
    <div class="tool-head">SCANS</div>
    ${tb('scan', 'scan', 'IMPORT SCAN')}
    <input type="file" class="hidden-file" accept="${SCAN_ACCEPT}">
    ${scanRows}
    <div class="empty" style="padding:6px 8px; font-size:9.5px; color:var(--faint); font-family:var(--mono); line-height:1.5">
      PLY / PCD / XYZ / LAS point clouds, OBJ / GLB meshes, .splat / .spz / .ply Gaussian splats.</div>
    <div class="tool-sep"></div>
    ${tb('rebuild', 'refresh', 'REGENERATE')}`;
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
  on('section', toggleSection);
  on('xray', toggleXray);
  on('render2', () => renderStill(2));
  on('render3', () => renderStill(3));
  const file = tc.querySelector('input[type=file]');
  on('scan', () => file.click());
  file.onchange = () => { onImportScan(file.files[0]); file.value = ''; };
  tc.querySelectorAll('[data-scan]').forEach(b => b.onclick = () => setSelection({ kind: 'scan', id: b.dataset.scan }));
  on('rebuild', () => { rebuildModel(); rebuildGround(); buildAllPins(); });
}
function setTool(next) {
  if (tool === 'measure' && next !== 'measure') { measureDraft = null; measureRoot.children.filter(c => c.userData.draft).forEach(c => { measureRoot.remove(c); c.geometry.dispose(); c.material.dispose(); }); }
  tool = next;
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
      break;
    default: return;
  }
  e.preventDefault();
}
function onKeyUp(e) { delete walkKeys[e.code]; }

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
  mode = 'orbit'; tool = 'select'; selection = null; hoverTarget = null; tween = null; measureDraft = null; pinPhotoId = null; panoNagged = false;

  ensureRenderer();
  wrapEl.insertBefore(renderer.domElement, wrapEl.firstChild);
  setupScene();
  setupComposer();
  rebuildGround();
  rebuildModel();
  applyQuality();
  applyEnvironment();
  buildAllPins();
  presetView('frame', true);
  renderHud();
  renderEnvPanel();
  renderToolCol();
  renderInspector();
  setHint('');

  const c = renderer.domElement;
  c.addEventListener('pointerdown', onPointerDown);
  c.addEventListener('pointerup', onPointerUp);
  c.addEventListener('pointermove', onPointerMove);
  c.addEventListener('pointerleave', () => { if (hoverTarget) { hoverTarget = null; updateOutlineTargets(); requestRender(2); } });
  c.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(wrapEl);
  resize();
  lastT = 0;
  renderer.setAnimationLoop(tick);
  requestRender(4);

  loadAllScans();
  // Deep link from the PHOTOS view: #/model?pin=<photoId> enters PIN PHOTO for that photo.
  const m = /[?&]pin=([^&]+)/.exec(location.hash);
  if (m && photoById(prop, decodeURIComponent(m[1]))) startPinMode(decodeURIComponent(m[1]));
}

export function unmount() {
  if (renderer) renderer.setAnimationLoop(null);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
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
  for (const id of Object.keys(scanObjs)) { disposeScanObject(scanObjs[id]); delete scanObjs[id]; }
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
  scanRoot = null; pinRoot = null; measureRoot = null;
  el = null; wrapEl = null; inspEl = null; hud = {};
  selection = null; hoverTarget = null; tween = null; pressed = null; dragLook = null;
}

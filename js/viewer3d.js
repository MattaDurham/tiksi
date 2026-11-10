// 3D model view: a rendering, not a debug scene.
// Physically based sun + sky with soft shadows, image-based lighting, ambient occlusion,
// bloom and SMAA through one persistent WebGL context; orbit / walk / top / section camera
// modes; selection and hover outlines; measure and photo-pin tools; notes pinned with a
// right-click; point clouds, meshes and Gaussian splats as reference scans; a still-image renderer.

import { environmentSun, dayOfYear, dateForDay, daysInYear, validTimeZone } from './solar.js';
import { setModelXray } from './model-xray.js';
import * as THREE from 'three';
import { modelPanelHtml, bindModelPanel, partComponentName } from './model-panel.js';
import { beginGeometryEdit, restoreGeometryEdit } from './edit-history.js';
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
  ws, activeProperty, defaultEnv, uid, touch, units, fmtLen, parseLen, fmtArea, polyArea, countsAsFloor,
  escapeHtml, deleteFile, getFile, itemById, materialById, isoToday, projectLabel, propertyProjects,
  ensureLevels, wallsOn, roomsOn, wallHeightOf, levelOfWall, levelOfRoom, levelHeight, topOfLevels,
} from './store.js';
import { placeScanBytes, seedProject, proposalSummary } from './scan2plan.js';
import { chooseScanPlacement } from './scanplace.js';
import { proposeFixtures, openFixtureReview, fixtureInspectorHtml, bindFixtureInspector, addFixtureHtml, addFixture } from './fixtures-ui.js';
import { openNewPropertyDialog } from './newproperty.js';
import { materialSelectHtml } from './materials.js';
import { pendingTextureJobs, setTextureQuality, setTextureLimits, beginTextureBuild, setTextureUse } from './textures.js';
import { qualityProfile, stillDimensions, effectiveQuality, deviceQualityChoice, chooseDeviceQuality, deviceLimits, touchDevice, QUALITY_NAMES } from './render-quality.js';
import { icon } from './icons.js';
import { buildPropertyGroup, buildGround, modelBounds, roomCentres, wallCapPolygons, disposeBuilt, wallInteriorMaterialId } from './geometry.js';
import { SECTION_KINDS, SECTION_LABELS, MAX_SECTIONS, TURN_SNAP_DEG, moveSnapStep, snapTo, quatRotate, planeNormal, planeOf, flipped, rangeAlong, movedTo, makeSection, normalizeSections, levelHeightOf } from './section-planes.js';
import { planWallMove, applyWallMove, normalOffset } from './wallmove.js';
import { addPhotoFromFile, photoUrl, photoById, revokePhotoUrls, photoBytes, ensureCameraFacts } from './photos-store.js';
import { normalizeView, defaultHfov, hfovOf, viewFrame, viewForPin, FOV_MIN, FOV_MAX, FOUND_SOURCES } from './photo-match.js';
import { wallAnchor, sheetPlacement, viewForSheet, PRINT_SIZES, DEFAULT_PRINT } from './pins.js';
import { addDocumentFromFile, documentCanvas, setDocumentPage, isPdfDocument } from './documents.js';
import { poseFromView, viewFromPose, lookAtPose, solvePose, lensFromHfov, hfovOfLens, project as projectPose, poseFromMatrix } from './camera-solve.js';
import { takenAtMs } from './photo-exif.js';
import { KF, keyframeRow, keyframeModelPose, keyframeLens, nearestKeyframe, sharpKeyframes, segmentsOf, decodePng16, depthPoints, alignSession } from './polycam-cameras.js';
import { addPosition, removePosition, picturesOf, positionLabel, renderingName, renderSize, ROLE_LABELS } from './positions.js';
import {
  loadScanObject, applyScanTransform, disposeScanObject, redoSplatAfterContextLoss,
  scanStats, dropScanToFloor, centerScanOnModel, releaseSplatRenderer, splatDrawables, splatBusy,
} from './scans.js';
import { attachSketchupNavigation } from './sketchup-nav.js';
import { indexForPicking, buildPickIndexes, pendingPickBuilds } from './pick-index.js';
import { ModelBatches } from './model-batch.js';
import { CANON, UNTAGGED, UNTAGGED_LABEL, tagById, tagIdOf, tagCounts, assignTag, addTag, renameTag, setTagColor, setTagShown, deleteTag, keysOnTag, planKey, forgetScanTags, tagShown } from './tags.js';
import { addSavedView, updateSavedView, renameSavedView, deleteSavedView, moveSavedView, applySavedTags } from './saved-views.js';
import { onScreen, setOnScreen, onScreenChange, setMenuProvider } from './tiksi-menu.js';
import { detectModelTags, applyModelTagVisibility, applyPlanTagVisibility, partKeyForObject, partByKey, partName, planKeyOf } from './tags-scene.js';

// ---------- persistent GPU state (one context for the life of the page) ----------
let renderer = null, pmrem = null;

// ---------- per-mount state ----------
let el = null, wrapEl = null, inspEl = null, hud = {};
let scene = null, camera = null, controls = null, nav = null, walk = null, gizmo = null, composer = null, passes = {};
let sky = null, envSky = null, sun = null, hemi = null, envRT = null, skyScene = null, panoTex = null, panoId = null;
let modelGroup = null, groundGroup = null, scanRoot = null, pinRoot = null, noteRoot = null, lightRoot = null, measureRoot = null;
let cameraRoot = null, positionRoot = null;   // photo cameras and numbered photo positions
let prop = null;
let selection = null;          // {kind:'wall'|'room'|'opening'|'scan'|'pin'|'note', id}
let selectionVersion = 0;      // late mount focus must not replace a newer user selection
let tagPicks = [];             // tag keys (tags.js) of the selected objects; Shift-click adds more
let hoverTarget = null;
let mode = 'orbit';            // orbit | walk | top
let tool = 'select';           // select | move | measure | pin | note
let xray = false;
// Section cuts (section-planes.js), per property and kept across remounts:
// { on, planes: [{ id, kind, q, pos }], active: id of the plane whose handles show }.
const sectionsByProp = {};
let section = { on: false, planes: [], active: null };
let sectionSnap = true, sectionSheets = true;   // snapping, and the floating sheets with their handles
let clipPlanes = [];           // THREE.Plane per cut, in step with section.planes while the cut is on
let sheetRoot = null, secMove = null, secTurn = null, secDragAt = -Infinity;
let framesLeft = 0, lastT = 0, tween = null, resizeObs = null;
// Imported models drawn grouped by look (model-batch.js); built lazily as models arrive.
let batches = null;
// While the camera moves the frame skips ambient occlusion (and SMAA where MSAA already smooths
// edges); the full frame follows once it has been still this long.
const SETTLE_MS = 150;
let lastMotion = -Infinity, lastFrameFast = false, aoWanted = true;
const frameCounts = { fastFrames: 0, fullFrames: 0, shadowRefreshes: 0 };
function markMotion() { lastMotion = performance.now(); }
const moving = () => performance.now() - lastMotion < SETTLE_MS;
// The sun's shadow map is drawn only when something it depends on changed (the sun, the
// model, what is shown, the section); camera moves never need it, since it covers the model.
function invalidateShadows() { if (renderer) renderer.shadowMap.needsUpdate = true; }
let pinPhotoId = null;         // photo being placed by the PIN PHOTO tool
let pinBatch = false;          // placing unpinned photos one after another
let match = null;              // MATCH PHOTO: {id, aspect, hfov, el} while a photo is laid over the view
let matchOpacity = 0.5, matchBeside = false;   // how the photo is shown; kept between matches
let matchResume = null;        // a match in progress when a disk save remounts the view
const ORBIT_POLAR = Math.PI * 0.495, MATCH_POLAR = Math.PI - 0.01, BASE_FOV = 50;
let measureDraft = null;       // first measure point
const measures = [];           // {a, b, line, label}
const scanObjs = {};           // scanId -> Object3D
const scanState = {};          // scanId -> 'loading' | 'ready' | 'missing' | 'failed' | 'hidden' (not loaded: it has not been shown yet)
const pinObjs = {};            // photoId -> {group, sprite, line, dot, aspect}
const noteObjs = {};           // noteId -> {group, sprite, aspect, place}
const cameraObjs = {};         // photoId -> camera pyramid group
const positionObjs = {};       // positionId -> numbered marker group
let polycamFolder = null;      // the Polycam export folder chosen this session: { name, files: Map stem -> {camera, image, depth, confidence} }
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

// The phone layout fills the screen; 1.5x stays sharp at arm's length and keeps orbiting smooth
// and the battery cooler than a phone's native 3x.
const PHONE_MAX_DPR = 1.5;
// The quality this device draws at (render-quality.js). A computer with a mouse or trackpad uses
// the setting saved with the property, as it always has, whatever its window width or layout. A
// touch device (phone or tablet) keeps its own choice in this browser's storage (Medium until it
// makes one), in either layout: it is never saved with the property, so the Mac's setting and
// the phone's stay apart.
function browserStorage() { try { return window.localStorage; } catch (e) { return null; } }
const ownQuality = () => touchDevice(window);
let unsavedDeviceQuality = null;   // the choice for this visit when the browser refuses storage
function quality() {
  return effectiveQuality({ touch: ownQuality(), shared: prop && prop.env && prop.env.quality, choice: deviceQualityChoice(browserStorage()) || unsavedDeviceQuality });
}
function memoryLimits() { return deviceLimits({ touch: ownQuality(), quality: quality() }); }
// Texture sizes and how many generated textures are kept follow the device too.
function applyTextureLimits() {
  const l = memoryLimits();
  setTextureQuality(l.textureQuality);
  setTextureLimits({ bytes: l.textureBytes, sets: l.textureSets });
}
let appliedQuality = null;   // what the drawing settings were last set from
function dpr() { const q = qualityProfile(quality()); return Math.min((window.devicePixelRatio || 1) * q.scale, fieldLayout() ? Math.min(q.maxDpr, PHONE_MAX_DPR) : q.maxDpr); }
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
  try { renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false }); }
  catch (e) { renderer = null; throw Object.assign(new Error('This browser could not start 3D graphics.'), { cause: e, graphics: true }); }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping || THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  // PCF with a wide sample radius (set on the sun): soft, alias-free shadow edges at grazing
  // sun angles. r185 has retired PCFSoftShadowMap in favour of this kernel.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.localClippingEnabled = true;
  renderer.domElement.className = 'v-canvas';
  pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  // three's own listeners (added by the constructor, so they run first) keep the context
  // restorable and start a fresh GL state; these do what three cannot (see graphicsRestored).
  renderer.domElement.addEventListener('webglcontextlost', graphicsLost);
  renderer.domElement.addEventListener('webglcontextrestored', graphicsRestored);
  return renderer;
}

// ---------- messages over the view ----------
// A panel over the canvas for the moments there is no picture to trust: the graphics context
// is gone, or a frame would not draw. Styled inline: it must show whatever else failed.
const NOTICE_STYLE = 'position:absolute;inset:0;z-index:7;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;background:rgba(9,12,15,0.92);color:var(--ink,#e9eef3);font:14px/1.45 var(--sans,sans-serif);';
// A failed frame is cleared by the next good one, and a good one comes from moving the view: so
// that message is a strip along the bottom which lets every touch and click through to the
// view, except on its own button.
const BANNER_STYLE = 'position:absolute;left:0;right:0;bottom:0;z-index:7;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px 14px;padding:12px 16px calc(12px + env(safe-area-inset-bottom, 0px));text-align:center;pointer-events:none;background:rgba(9,12,15,0.92);border-top:1px solid var(--red,#e05252);color:var(--ink,#e9eef3);font:13px/1.4 var(--sans,sans-serif);';
const notices = {};   // kind -> element
function noticeHtml(message, reload) {
  return `<p style="margin:0;max-width:34em">${escapeHtml(message)}</p>${reload ? '<button type="button" class="btn" data-reload style="width:auto;padding:10px 18px;pointer-events:auto">RELOAD</button>' : ''}`;
}
function showNotice(kind, message, reload = false, banner = false) {
  if (!wrapEl) return;
  let box = notices[kind];
  if (!box || box.parentElement !== wrapEl) {
    box = document.createElement('div');
    box.className = 'v-notice'; box.dataset.notice = kind; box.setAttribute('role', 'alert'); box.style.cssText = banner ? BANNER_STYLE : NOTICE_STYLE;
    wrapEl.appendChild(box);
    notices[kind] = box;
  }
  box.innerHTML = noticeHtml(message, reload);
  const button = box.querySelector('[data-reload]');
  if (button) button.onclick = () => location.reload();
}
function hideNotice(kind) { const box = notices[kind]; if (box) { box.remove(); delete notices[kind]; } }

// ---------- losing the graphics context ----------
// A phone takes graphics memory back from a page that is in the background or when memory is
// short; a desktop can do the same after a very large still. three re-uploads geometry and
// ordinary textures from their source data once the context returns, and makes every render
// target again, empty. So what was drawn into a target is gone until it is drawn again: the
// sun's shadow map and the sky lighting. Nothing would ask for a frame either, so the view
// stayed blank until a touch. While the context is away the view says so; a reload is offered
// if it has not come back after CONTEXT_WAIT_MS on screen.
const CONTEXT_WAIT_MS = 4000;
let contextLost = false, contextTimer = 0;
function contextNotice(waited) {
  showNotice('graphics', waited
    ? 'The 3D view lost its graphics memory and has not got it back. Reload to open the model again.'
    : 'The 3D view lost its graphics memory. Waiting for it to come back…', waited);
}
// The wait only counts while the page is on screen: a phone gives the context back when the
// page returns to the front, and that must not be met by a reload prompt.
function armContextTimer() {
  clearTimeout(contextTimer);
  if (!contextLost || document.visibilityState === 'hidden') return;
  contextTimer = setTimeout(() => { if (contextLost) contextNotice(true); }, CONTEXT_WAIT_MS);
}
document.addEventListener('visibilitychange', armContextTimer);
function graphicsLost() {
  contextLost = true;
  clearTimeout(pmremTimer);
  contextNotice(false);
  armContextTimer();
}
function graphicsRestored() {
  contextLost = false;
  clearTimeout(contextTimer);
  hideNotice('graphics');
  // The generator's own buffers and shader belonged to the old context.
  if (pmrem) pmrem.dispose();
  pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  if (!scene || !composer) return;   // MODEL is not open: the next mount builds everything
  renderFailed = false;
  hideNotice('draw');
  if (envRT) { envRT.dispose(); envRT = null; }
  scene.environment = null;
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  // Buffers for smoothing, shading, outlines and glow at this device's quality and size.
  applyQuality();
  // Sky lighting first, then the shader warm-up it triggers, then the shadows and a frame.
  programsWarm = false;
  regenEnvMap();
  invalidateShadows();
  // Splats keep their unpacked data on the graphics card: have it made again (scans.js).
  let splats = false;
  for (const obj of Object.values(scanObjs)) splats = redoSplatAfterContextLoss(obj) || splats;
  requestRender(splats ? 8 : 4);
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
  cameraRoot = new THREE.Group(); cameraRoot.name = 'photo cameras'; scene.add(cameraRoot);
  positionRoot = new THREE.Group(); positionRoot.name = 'photo positions'; scene.add(positionRoot);
  measureRoot = new THREE.Group(); measureRoot.name = 'measures'; scene.add(measureRoot);
  sheetRoot = new THREE.Group(); sheetRoot.name = 'section planes'; scene.add(sheetRoot);
  batches = new ModelBatches();
  scene.add(batches.root);
  invalidateShadows();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.05;   // close enough to read a pinned sheet; the wheel aims at the surface under the cursor
  controls.maxDistance = 400;
  controls.addEventListener('change', () => { markMotion(); requestRender(2); });
  nav = attachSketchupNavigation(controls, {
    pickPoint: e => { if (!scene || !modelGroup) return null; const hit = pick(e, { pins: false, notes: false, ground: true }); return hit ? hit.point : null; },
    canOrbit: () => mode !== 'top',
    onChange: () => { markMotion(); requestRender(2); },
  });

  walk = new PointerLockControls(camera, renderer.domElement);
  walk.disconnect();
  walk.addEventListener('lock', () => { walkLocked = true; setHint(''); });
  walk.addEventListener('unlock', () => { walkLocked = false; setHint(''); });
  walk.addEventListener('change', () => { markMotion(); requestRender(2); });

  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode('translate');
  gizmo.showY = false;
  gizmo.addEventListener('dragging-changed', e => {
    controls.enabled = !e.value && mode !== 'walk';
    if (!e.value) commitGizmoMove();
  });
  gizmo.addEventListener('change', () => { if (gizmo.dragging) invalidateShadows(); requestRender(2); });
  scene.add(gizmo.getHelper());

  // A section plane has two sets of handles at once: an arrow that slides it along its own
  // normal, reaching out past two rings that turn it. While one drags, the other is switched
  // off, so a press where the arrow crosses a ring slides the plane and does not turn it too.
  secMove = new TransformControls(camera, renderer.domElement);
  secMove.setMode('translate'); secMove.setSpace('local'); secMove.showX = false; secMove.showY = false; secMove.setSize(1.5);
  secTurn = new TransformControls(camera, renderer.domElement);
  secTurn.setMode('rotate'); secTurn.setSpace('local'); secTurn.showZ = false; secTurn.setSize(0.8);
  for (const [g, other] of [[secMove, secTurn], [secTurn, secMove]]) {
    g.addEventListener('dragging-changed', e => {
      secDragAt = performance.now();
      other.enabled = !e.value;
      controls.enabled = !e.value && mode !== 'walk';
      if (!e.value) renderSectionBar();
    });
    g.addEventListener('objectChange', sectionDragged);
    g.addEventListener('change', () => requestRender(2));
    scene.add(g.getHelper());
  }
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
    for (const o of [pinRoot, noteRoot, ...sectionOverlays()]) if (o && o.visible) { o.visible = false; hidden.push(o); }
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
    p.render = (...args) => {
      const hidden = hideSplats();
      // The floating section sheets are not surfaces: they must not hide an outline behind them.
      for (const o of sectionOverlays()) if (o && o.visible) { o.visible = false; hidden.push(o); }
      const restore = batches ? batches.beginOutline(p) : () => {};
      try { orig(...args); } finally { restore(); hidden.forEach(o => { o.visible = true; }); }
    };
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
// The sheets and handles of the section planes: drawn over the model, never part of it.
function sectionOverlays() { return [sheetRoot, secMove && secMove.getHelper(), secTurn && secTurn.getHelper()]; }
// Every pass material that re-renders scene geometry and must respect the section cut.
function passClipMaterials() {
  const list = [];
  if (passes.gtao) list.push(passes.gtao.normalMaterial);
  for (const p of [passes.outline, passes.hover]) if (p) list.push(p.depthMaterial, p.prepareMaskMaterial);
  return list.filter(Boolean);
}

function applyQuality() {
  const q = quality();
  appliedQuality = q;
  configureRenderQuality(q);
  resize();
}

function configureRenderQuality(name, forExport = false) {
  const q = qualityProfile(name);
  aoWanted = q.ao;
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
    invalidateShadows();
  }
}

// ---------- model ----------
// The colour maps on the surfaces in the scene now (walls and floors, the ground, imported
// models): the texture store never frees a set that is on one of them (textures.js).
function texturesOnScreen() {
  const out = new Set();
  const visit = o => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && m.map) out.add(m.map.source);
  };
  for (const root of [modelGroup, groundGroup, scanRoot]) if (root) root.traverse(visit);
  return out;
}

function rebuildModel() {
  beginTextureBuild();   // the sets asked for from here on are this model's
  if (modelGroup) { scene.remove(modelGroup); disposeBuilt(modelGroup); }
  modelGroup = buildPropertyGroup(prop, { xray, xrayOpacity: prop.env.xrayOpacity, hiddenLevels: hiddenLevels() });
  modelGroup.visible = !prop.modelSourceId;
  scene.add(modelGroup);
  invalidateShadows();
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
  invalidateShadows();
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
  // Every room keeps its glowing fixture. How many of them also cast light is a device limit
  // (render-quality.js deviceLimits): every light is worked out for every pixel of every lit
  // surface. A computer lights every room, as it always has. A touch device lights a few: the
  // room the camera is in and the ones nearest it, moved as the camera moves (placeRoomLights).
  // Their number does not change while the camera moves, so no shader is rebuilt for it.
  lampRooms = roomCentres(prop).filter(r => !hidden.has(r.level));
  lampLights = [];
  const limit = memoryLimits().roomLights;
  const count = limit ? Math.min(lampRooms.length, limit) : lampRooms.length;
  for (let i = 0; i < count; i++) {
    const light = new THREE.PointLight(0xffc48a, 14, 0, 2);
    lampLights.push(light);
    lightRoot.add(light);
  }
  for (const r of lampRooms) {
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.set(r.x, r.top - 0.035, r.z);
    disc.userData = { kind: 'ceiling', id: r.id };
    lightRoot.add(disc);
  }
  lampKey = null;
  placeRoomLights();
}
// Put the lights over the rooms that get one: all of them where there is a light per room, else
// the room the camera stands in first, then the nearest. Called before every drawn frame; it
// does nothing unless the rooms chosen have changed.
let lampRooms = [], lampLights = [], lampKey = null;
function placeRoomLights() {
  let chosen = lampRooms;
  if (lampLights.length < lampRooms.length) {
    const c = camera.position;
    const inside = r => { const room = (prop.rooms || []).find(x => x.id === r.id); return !!room && c.y >= r.y - 0.05 && c.y < r.top - 0.05 && pointInPolygon(c.x, c.z, room.pts); };
    const far = r => (inside(r) ? 0 : 1e6) + (r.x - c.x) ** 2 + (r.top - c.y) ** 2 + (r.z - c.z) ** 2;
    chosen = lampRooms.map(r => [far(r), r]).sort((a, b) => a[0] - b[0]).slice(0, lampLights.length).map(x => x[1]);
    chosen.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);   // a steady order: a room keeps its light
  }
  const key = chosen.map(r => r.id).join('|');
  if (key === lampKey) return;
  lampKey = key;
  chosen.forEach((r, i) => lampLights[i].position.set(r.x, r.top - 0.12, r.z));
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
  invalidateShadows();
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
  const sunWas = sun.position.clone();
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
  // The shadow map depends on where the sun is, not on its colour or the exposure.
  if (!sun.position.equals(sunWas)) invalidateShadows();
  requestRender(3);
}

// PMREM from the sky is a few ms; throttle it while a slider drags.
function scheduleEnvMap(delay) {
  clearTimeout(pmremTimer);
  pmremTimer = setTimeout(regenEnvMap, delay);
}
function regenEnvMap() {
  if (!scene || contextLost) return;   // a restored context bakes it again (graphicsRestored)
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
  invalidateShadows();
  sun.shadow.camera.updateProjectionMatrix();
}

// ---------- section cuts ----------
// Each cut is a plane (section-planes.js) that clips the model, fills the walls it passes
// through, and floats in the view as a transparent sheet with handles to move and turn it.
const activeSection = () => section.planes.find(s => s.id === section.active) || null;
const turnSnap = () => TURN_SNAP_DEG * Math.PI / 180;
// The box the cuts range over: the traced model and every imported model that is showing.
let sectionBoxCache = null;
function sectionBox() {
  if (sectionBoxCache) return sectionBoxCache;
  const b = modelBounds(prop);
  const box = new THREE.Box3(new THREE.Vector3(b.minX, lowestElevation(), b.minY), new THREE.Vector3(b.maxX, modelTop(), b.maxY));
  for (const scan of prop.scans) {
    if (scan.visible === false || !scanObjs[scan.id]) continue;
    const sb = new THREE.Box3().setFromObject(scanObjs[scan.id]);
    if (Number.isFinite(sb.min.x) && Number.isFinite(sb.max.x)) box.union(sb);
  }
  return (sectionBoxCache = box);
}
// How far a plane can slide: from just outside one face of the model to just outside the other.
function sectionRange(s) {
  const box = sectionBox();
  const [lo, hi] = rangeAlong(planeNormal(s.q), { min: box.min.toArray(), max: box.max.toArray() });
  return { lo, hi, min: lo - 0.3, max: hi + 0.3 };
}
// What the bar shows for a plane: a flat cut reads as its elevation, any other as its distance
// in from the face of the model it starts at; plus the way it faces and how far it leans.
function sectionReadout(s) {
  const { n, d } = planeOf(s);
  const flat = Math.abs(n[1]) > 0.9999;
  const deg = v => { const r = Math.round(v * 10) / 10; return (Object.is(r, -0) ? 0 : r) + '°'; };
  return {
    d, flat,
    label: fmtLen(flat ? s.pos[1] : d - sectionRange(s).lo),
    angle: flat ? (n[1] > 0 ? 'FLAT' : 'FLAT, FROM BELOW') : 'TURN ' + deg((Math.atan2(n[0], n[2]) * 180 / Math.PI + 360) % 360) + ' · TILT ' + deg(Math.asin(Math.max(-1, Math.min(1, n[1]))) * 180 / Math.PI),
  };
}

let capMeshes = [];            // the dark fill of each cut, in step with section.planes
function disposeCap(i) {
  const m = capMeshes[i];
  if (!m) return;
  scene.remove(m); m.geometry.dispose(); m.material.dispose();
  capMeshes[i] = null;
}
function rebuildCap(i) {
  disposeCap(i);
  if (!section.on || !modelGroup || !modelGroup.visible) return;
  const { n, d } = planeOf(section.planes[i]);
  const polys = wallCapPolygons(prop, n, d, { hiddenLevels: hiddenLevels() });
  if (!polys.length) return;
  const P = [], I = [];
  for (const poly of polys) {
    const base = P.length / 3;
    // A hair inside the part that is kept, so the fill never fights the cut edge for depth.
    for (const p of poly) P.push(p[0] - n[0] * 0.0008, p[1] - n[1] * 0.0008, p[2] - n[2] * 0.0008);
    for (let k = 1; k + 1 < poly.length; k++) I.push(base, base + k, base + k + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  // Architectural section fill: dark, matte, lit from either side. Its own plane never clips
  // it, but every other cut does, so two cuts that cross leave no fill hanging in the gap.
  const mat = new THREE.MeshStandardMaterial({ color: 0x262c33, roughness: 0.95, side: THREE.DoubleSide });
  mat.userData.noClip = true;
  mat.clippingPlanes = clipPlanes.filter((_, j) => j !== i);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  scene.add(mesh);
  capMeshes[i] = mesh;
}

// The floating sheet of each plane: a tinted rectangle with a border, sized to the model as
// the plane sees it. The group sits at the plane's own point and turns with it, so the
// handles attach to the group; the rectangle inside is shifted to cover the model.
const SHEET_COLOR = 0xe8973a;
let sheetGeo = null, sheetEdgeGeo = null;
function sheetGeometries() {
  if (!sheetGeo) {
    sheetGeo = new THREE.PlaneGeometry(1, 1);
    sheetEdgeGeo = new THREE.BufferGeometry().setFromPoints([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => new THREE.Vector3(x, y, 0)));
  }
}
function rebuildSheets() {
  for (const g of [secMove, secTurn]) if (g) g.detach();
  if (!sheetRoot) return;
  for (const g of [...sheetRoot.children]) {
    sheetRoot.remove(g);
    g.traverse(o => { if (o.material) o.material.dispose(); });
  }
  if (!section.on) return;
  sheetGeometries();
  section.planes.forEach((s, i) => {
    const g = new THREE.Group();
    g.userData.sectionId = s.id;
    const fill = new THREE.Mesh(sheetGeo, new THREE.MeshBasicMaterial({ color: SHEET_COLOR, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    const edge = new THREE.LineLoop(sheetEdgeGeo, new THREE.LineBasicMaterial({ color: SHEET_COLOR, transparent: true, opacity: 0.9, fog: false }));
    for (const o of [fill, edge]) { o.material.userData.noClip = true; o.renderOrder = 6; g.add(o); }
    sheetRoot.add(g);
    placeCutSheet(i);
  });
  syncSectionHandles();
}
function placeCutSheet(i) {
  const s = section.planes[i], g = sheetRoot && sheetRoot.children[i];
  if (!s || !g) return;
  g.position.fromArray(s.pos); g.quaternion.fromArray(s.q);
  const box = sectionBox(), ux = quatRotate(s.q, [1, 0, 0]), uy = quatRotate(s.q, [0, 1, 0]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < 8; k++) {
    const c = [(k & 1 ? box.max.x : box.min.x) - s.pos[0], (k & 2 ? box.max.y : box.min.y) - s.pos[1], (k & 4 ? box.max.z : box.min.z) - s.pos[2]];
    const x = c[0] * ux[0] + c[1] * ux[1] + c[2] * ux[2], y = c[0] * uy[0] + c[1] * uy[1] + c[2] * uy[2];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const M = 0.4, on = s.id === section.active;
  for (const o of g.children) {
    o.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
    o.scale.set(x1 - x0 + 2 * M, y1 - y0 + 2 * M, 1);
    o.material.opacity = o.isMesh ? (on ? 0.14 : 0.06) : (on ? 0.95 : 0.4);
  }
}
// The handles sit on the active plane; none in a walk, on the phone layout, or with the sheets hidden.
function syncSectionHandles() {
  if (!secMove || !sheetRoot) return;
  const i = section.on ? section.planes.findIndex(s => s.id === section.active) : -1;
  const g = i >= 0 ? sheetRoot.children[i] : null;
  const show = !!g && sectionSheets && mode !== 'walk' && !fieldLayout();
  sheetRoot.visible = sectionSheets;
  for (const h of [secMove, secTurn]) {
    if (!show) h.detach();
    else if (h.object !== g) h.attach(g);
  }
  secMove.setTranslationSnap(sectionSnap ? moveSnapStep(units()) : null);
  secTurn.setRotationSnap(sectionSnap ? turnSnap() : null);
  requestRender(2);
}
// A handle moved the active plane's sheet: the plane follows it.
function sectionDragged() {
  const s = activeSection(), g = secMove && (secMove.object || secTurn.object);
  if (!s || !g) return;
  s.pos = g.position.toArray(); s.q = g.quaternion.toArray();
  sectionMoved(section.planes.indexOf(s));
  updateSectionReadout();
}
// One plane moved or turned: the same planes keep clipping, only their numbers change.
function sectionMoved(i) {
  const s = section.planes[i], p = clipPlanes[i];
  if (!s || !p) return applySection();
  const { n, d } = planeOf(s);
  p.normal.set(-n[0], -n[1], -n[2]); p.constant = d;
  rebuildCap(i);
  placeCutSheet(i);
  invalidateShadows();
  requestRender(2);
}
function applySection() {
  sectionBoxCache = null;
  // three keeps the side where normal . p + constant >= 0: the opposite of the cut-away side.
  clipPlanes = section.on ? section.planes.map(s => { const { n, d } = planeOf(s); return new THREE.Plane(new THREE.Vector3(-n[0], -n[1], -n[2]), d); }) : [];
  const planes = clipPlanes.length ? clipPlanes : null;
  for (let i = Math.max(capMeshes.length, section.planes.length) - 1; i >= 0; i--) disposeCap(i);
  capMeshes = [];
  if (planes) section.planes.forEach((_, i) => rebuildCap(i));
  rebuildSheets();
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
  // materials; without the planes they would shade and outline the part that was cut away.
  for (const m of passClipMaterials()) { m.clippingPlanes = planes; m.needsUpdate = true; }
  invalidateShadows();
  requestRender(2);
}
// Anything on the cut-away side of a plane is not on screen and must not be picked, unless
// its material is exempt from clipping (section caps, pin cards).
function clippedAway(h) {
  if (!clipPlanes.some(p => p.distanceToPoint(h.point) < -1e-4)) return false;
  const m = h.object.material;
  return !(m && m.userData && m.userData.noClip);
}

// Waist height on the lowest level: where a new flat cut starts.
function defaultCutHeight() {
  const lo = lowestElevation();
  const H0 = levelHeight(prop, prop.levels.find(l => l.elevation === lo).id);
  return lo + Math.min(1.2, H0 * 0.5);
}
function newSection(kind) {
  const c = sectionBox().getCenter(new THREE.Vector3());
  const s = makeSection(kind, c.toArray(), camera.getWorldDirection(_v).toArray(), sectionSnap);
  if (kind === 'level') s.pos[1] = defaultCutHeight();
  if (sectionSnap) s.pos = movedTo(s, snapTo(planeOf(s).d, moveSnapStep(units())));
  return s;
}
function addSection(kind) {
  if (!SECTION_KINDS.includes(kind)) return;
  if (section.planes.length >= MAX_SECTIONS) { toast('A view holds up to ' + MAX_SECTIONS + ' section cuts. Remove one first.', 'warn'); return; }
  const s = newSection(kind);
  section.planes.push(s); section.active = s.id; section.on = true;
  applySection(); renderHud();
}
function removeSection(id) {
  const i = section.planes.findIndex(s => s.id === id);
  if (i < 0) return;
  section.planes.splice(i, 1);
  if (section.active === id) section.active = section.planes.length ? section.planes[Math.min(i, section.planes.length - 1)].id : null;
  if (!section.planes.length) section.on = false;
  applySection(); renderHud();
}
function selectSection(id) {
  if (!section.planes.some(s => s.id === id)) return;
  section.active = id;
  section.planes.forEach((_, i) => placeCutSheet(i));
  syncSectionHandles(); renderSectionBar();
}
function flipSection() {
  const s = activeSection();
  if (!s) return;
  s.q = flipped(s.q);
  sectionMoved(section.planes.indexOf(s));
  renderSectionBar();
}
// Slide the active plane to distance `d` along its own normal (a flat cut: to that elevation).
function slideSection(d) {
  const s = activeSection();
  if (!s || !Number.isFinite(d)) return;
  s.pos = movedTo(s, d);
  sectionMoved(section.planes.indexOf(s));
}
// The phone layout keeps one plane: choosing a direction swaps the active plane for a fresh one.
function setSectionKind(kind) {
  if (!SECTION_KINDS.includes(kind)) return;
  const i = section.planes.findIndex(s => s.id === section.active);
  const s = newSection(kind);
  if (i >= 0) section.planes[i] = s; else section.planes.push(s);
  section.active = s.id; section.on = true;
  applySection(); renderHud();
}
function setSectionSnap(on) { sectionSnap = !!on; syncSectionHandles(); renderSectionBar(); }
function setSectionSheets(on) { sectionSheets = !!on; syncSectionHandles(); renderSectionBar(); }

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
  // A portrait phone is about 0.46 wide to 1 tall; fit to it so the model is not cut off.
  const aspect = Math.max(0.35, camera.aspect || 1);
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
  if (match && next !== 'orbit') endMatch();
  if (mode === 'walk' && next !== 'walk') {
    if (walkLocked) walk.unlock();
    walk.disconnect();
    dragLook = null;
    for (const k of Object.keys(walkKeys)) delete walkKeys[k];
  }
  mode = next;
  controls.enabled = next !== 'walk';
  controls.enableRotate = next !== 'top';
  nav.refresh();
  // A photo can look up at a ceiling; ordinary orbiting stays above the horizon.
  controls.maxPolarAngle = match ? MATCH_POLAR : ORBIT_POLAR;
  if (next === 'walk') startWalk();
  else if (next === 'top') presetView('top');
  else if (next === 'orbit' && camera.position.y < 0.3) camera.position.y = 0.3;
  if (next !== 'walk') { controls.target.y = Math.max(controls.target.y, 0); controls.update(); }
  syncSectionHandles();
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
  // Start in the largest measured room, never in an unscanned area.
  const r = selRoom || rooms.filter(countsAsFloor).sort((a, b) => polyArea(b.pts) - polyArea(a.pts))[0];
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
  toast(fieldLayout() ? 'WALK: drag to look around, hold the arrows to move.' : 'WALK: WASD / arrows move, Shift runs. Drag to look, or click the view to capture the mouse. Esc exits.', 'info', 5000);
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
  if (active || dragLook) markMotion();
  if (active || splatBusy()) requestRender(2);
  // The camera has come to rest after fast frames: draw the full-quality one.
  if (lastFrameFast && !moving()) requestRender(1);
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
    invalidateShadows();
    requestRender(3);
  }
  // Nothing can be drawn into a lost context; what is waiting is drawn when it returns.
  if (contextLost) return;
  if (framesLeft > 0) {
    framesLeft--;
    // One bad frame must not kill the animation loop for the rest of the session. It must not
    // leave a stale picture looking current either: say so until a frame draws again.
    try {
      renderFrame();
      if (renderFailed) { renderFailed = false; hideNotice('draw'); }
    } catch (e) {
      if (!renderFailed) {
        renderFailed = true;
        console.error('render failed', e);
        showNotice('draw', 'MODEL could not draw this view (' + errMsg(e) + '). Move the view to try again, or reload.', true, true);
      }
    }
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

// `still`: a frame that must be complete whatever the camera is doing (image export).
function renderFrame(still = false) {
  if (sunDirty) updateSun();
  updateInteriorFill();
  // Each level's ceilings show only while the camera is below that level's top (or walking),
  // so orbiting above the house reads as a dollhouse and stepping inside closes the lid.
  const levels = modelGroup && modelGroup.userData.levels;
  if (levels) for (const l of levels) {
    const shown = prop.env.showCeilings !== false && (mode === 'walk' || camera.position.y < l.top - 0.05);
    if (l.ceilings.visible !== shown) { l.ceilings.visible = shown; invalidateShadows(); }
  }
  if (lampLights.length < lampRooms.length) placeRoomLights();
  updatePins();
  updateNotes();
  updateMatchMarkers();
  updateMeasureLabels();
  updateCompass();
  // Fast frames while the camera moves: the passes are switched, never resized or reallocated.
  const fast = !still && moving();
  passes.gtao.enabled = aoWanted && !fast;
  passes.smaa.enabled = !(fast && composer.renderTarget1.samples > 0);
  lastFrameFast = fast;
  frameCounts[fast ? 'fastFrames' : 'fullFrames']++;
  if (batches.beginFrame(scanObjs)) invalidateShadows();
  if (renderer.shadowMap.needsUpdate) frameCounts.shadowRefreshes++;
  try { composer.render(); }
  finally { batches.endFrame(); }
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
  if (match) applyMatchFrame();
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
  const live = () => token === mountId && options.dialog.open;
  const blob = await renderStillBlob({ ...options, live, status: t => { options.status.textContent = t; } });
  if (!live()) throw new Error('Export cancelled.');
  const { width, height } = options;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const slug = String(prop.name || 'property').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'property';
  a.href = url; a.download = 'tiksi-' + slug + '-' + width + 'x' + height + '-' + isoToday() + '.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// A PNG of the model at width x height: the current view, or `view` (a stored camera with its
// lens and roll, for numbered photo positions). `live()` says whether to carry on.
// Nothing can be drawn into a lost graphics context, and what a snapshot of it holds is blank:
// stop with a plain reason so no empty picture is saved or downloaded.
function graphicsGone() { return contextLost || !renderer || renderer.getContext().isContextLost(); }
const GRAPHICS_GONE = 'The 3D view has lost its graphics memory, so no image was made. Wait for the view to come back, then render again.';
async function renderStillBlob(options) {
  const token = mountId;
  const live = options.live || (() => token === mountId);
  if (graphicsGone()) throw new Error(GRAPHICS_GONE);
  const deadline = performance.now() + 60000;
  // Do not save a transient flat-tinted first frame. Photo decoding is counted too.
  while (pendingTextureJobs() || Object.values(scanState).some(s => s === 'loading') || splatBusy()) {
    if (!live()) throw new Error('Export cancelled.');
    if (performance.now() > deadline) throw new Error('Assets are still loading. Wait for the model to finish, then export again.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!live()) throw new Error('Export cancelled.');
  const { width, height } = options;
  const c = composer, r = renderer;
  const savedPasses = [passes.outline, passes.hover].map(p => [p, p.enabled]);
  const handles = new Set([gizmo.getHelper(), ...sectionOverlays()]);   // never in the image
  const roots = [pinRoot, noteRoot, cameraRoot, positionRoot, measureRoot, ...handles].map(o => [o, o && o.visible]);
  const oldAspect = camera.aspect, oldFov = camera.fov;
  const oldPos = camera.position.clone(), oldQuat = camera.quaternion.clone();
  const matchEl = match && match.el;
  exportingStill = true;
  if (options.status) options.status('Rendering ' + width + ' × ' + height + '…');
  // Let the status paint before GPU work.
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    if (!live()) throw new Error('Export cancelled.');
    if (graphicsGone()) throw new Error(GRAPHICS_GONE);
    // High-resolution stills use SMAA at output size; avoid multiplying their HDR memory by MSAA.
    configureRenderQuality(options.quality, true);
    for (const [p] of savedPasses) p.enabled = false;
    // Photo pins and notes hidden with their toggles stay out of the image too.
    for (const [o, visible] of roots) if (o) o.visible = options.annotations && visible && !handles.has(o);
    if (matchEl) matchEl.style.visibility = 'hidden';
    r.setPixelRatio(1); c.setPixelRatio(1);
    r.setSize(width, height, false); c.setSize(width, height);
    camera.aspect = width / height;
    if (options.view) {
      const v = options.view;
      camera.position.set(...v.position);
      camera.up.set(0, 1, 0);
      camera.lookAt(new THREE.Vector3(...v.target));
      if (v.roll) camera.rotateZ(v.roll * Math.PI / 180);
      camera.fov = 2 * Math.atan(Math.tan(v.fov * Math.PI / 360) / camera.aspect) * 180 / Math.PI;
      camera.updateMatrixWorld();
    }
    camera.updateProjectionMatrix();
    for (const m of measures) m.line.material.resolution.set(width, height);
    invalidateShadows();
    renderFrame(true);
    // A large still is itself a way to lose the context: what was just drawn is then gone.
    if (graphicsGone()) throw new Error(GRAPHICS_GONE);
    // Snapshot synchronously before WebGL's non-preserved default framebuffer is cleared.
    const snapshot = document.createElement('canvas');
    snapshot.width = width; snapshot.height = height;
    snapshot.getContext('2d').drawImage(r.domElement, 0, 0);
    const blob = await new Promise(resolve => snapshot.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed. Choose a smaller size.');
    return blob;
  } finally {
    exportingStill = false;
    // Navigation can dispose this mount while PNG encoding is running.
    if (token === mountId && composer === c) {
      for (const [p, enabled] of savedPasses) p.enabled = enabled;
      for (const [o, visible] of roots) if (o) o.visible = visible;
      if (matchEl) matchEl.style.visibility = '';
      camera.position.copy(oldPos); camera.quaternion.copy(oldQuat);
      camera.aspect = oldAspect; camera.fov = oldFov; camera.updateProjectionMatrix();
      if (controls) controls.update();
      configureRenderQuality(quality());
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
  // Objects added since the last drawn frame (a note just pinned, a moved pin) have no world
  // position until the renderer updates it; on a slow GPU the next click can come first.
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndcFromEvent(e), camera);
  const targets = [];
  // `markersOnly`: photo pins, notes, photo cameras and positions, and nothing else. The plan
  // model and the scans are not tested at all.
  if (modelGroup && !opts.markersOnly) targets.push(modelGroup);
  if (opts.pins !== false && pinRoot) targets.push(pinRoot);
  if (opts.notes !== false && noteRoot) targets.push(noteRoot);
  if (opts.pins !== false && cameraRoot) targets.push(cameraRoot);
  if (opts.pins !== false && positionRoot) targets.push(positionRoot);
  if (opts.scans !== false && scanRoot && !opts.markersOnly) targets.push(scanRoot);
  if (opts.ground && groundGroup && !opts.markersOnly) targets.push(groundGroup);
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
    if (opts.surfaceOnly && ['pin', 'note', 'camera', 'position'].includes(o.userData.kind)) continue;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    const part = o.userData.kind === 'scan' ? partKeyForObject(o, h.object) : null;
    return { kind: o.userData.kind, id: o.userData.id, point: h.point, normal: n, object: o, wallId: o.userData.wallId, part, mesh: h.object };
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
  // A press on a section handle moved or turned a plane; it is not a click on the model.
  if (!p || e.button !== 0 || gizmo.dragging || secMove.dragging || secTurn.dragging || performance.now() - secDragAt < 80) return;
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;      // it was a drag, not a click
  if (mode === 'walk') {
    // A plain click in walk mode captures the mouse for free-look (a user gesture is required).
    if (!walkLocked && e.pointerType !== 'touch') { try { walk.lock(); } catch (err) { /* drag-look keeps working */ } }
    return;
  }
  if (tool === 'measure') return addMeasurePoint(e);
  if (tool === 'pin') return placePin(e);
  if (tool === 'note') return placeNote(e);
  if (match && match.points && match.points.mode === 'model') return addMatchModelPoint(e);
  const hit = pick(e);
  if (!hit || hit.kind === 'ground') { setSelection(null); return; }
  // The phone layout has no inspector: a tap opens a photo pin and otherwise clears the selection.
  if (fieldLayout() && hit.kind !== 'pin') { setSelection(null); return; }
  if (hit.kind === 'pin') { setSelection({ kind: 'pin', id: hit.id }); const ph = photoById(prop, hit.id); if (ph && ph.kind === 'document') flyToSheet(hit.id); else openLightbox(hit.id); return; }
  if (hit.kind === 'camera') { startMatch(hit.id); return; }
  if (hit.kind === 'position') { setSelection({ kind: 'position', id: hit.id }); return; }
  if (hit.kind === 'note') { setSelection({ kind: 'note', id: hit.id }); return; }
  const key = hit.kind === 'scan' ? hit.part : planKeyOf(hit.mesh);
  const sel = hit.kind === 'ceiling' ? { kind: 'room', id: hit.id } : { kind: hit.kind, id: hit.id };
  if (key) sel.tagKey = key;
  if (e.shiftKey && key && tagPicks.length) {
    // Shift-click adds an object to (or takes it out of) the selection, to move them to a tag at once.
    const next = tagPicks.includes(key) ? tagPicks.filter(k => k !== key) : tagPicks.concat(key);
    if (next.length) { setSelection(sel, next); return; }
  }
  setSelection(sel);
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
// The scene object a tag key names: a plan element's group, or one mesh of a model.
function objectForKey(key) {
  const m = /^node:([^#]+)#/.exec(key);
  if (m) { const w = scanObjs[m[1]]; const part = w && partByKey(w, key); return part ? part.object : null; }
  const k = /^(wall|room|ceiling|opening|fixture):(.+)$/.exec(key);
  if (!k || !modelGroup) return null;
  if (k[1] !== 'ceiling') return findGroupFor(k[1], k[2]);
  let found = null;
  modelGroup.traverse(o => { if (!found && o.userData && o.userData.kind === 'ceiling' && o.userData.id === k[2]) found = o; });
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
  for (const key of tagPicks) {
    const o = objectForKey(key);
    if (o && o !== sel) o.traverse(m => { if (m.isMesh && !(m.userData && m.userData.glass)) selMeshes.push(m); });
  }
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
function setSelection(sel, picks) {
  selectionVersion++;
  const was = selection;
  selection = sel;
  tagPicks = picks || (sel && sel.tagKey ? [sel.tagKey] : sel && ['wall', 'opening', 'fixture', 'room'].includes(sel.kind) ? [planKey(sel.kind, sel.id)] : []);
  // A selected note card is drawn with an accent border.
  for (const s of [was, sel]) if (s && s.kind === 'note') redrawNoteCard(s.id);
  // A selected numbered position is drawn in the accent colour.
  for (const s of [was, sel]) if (s && s.kind === 'position') { const pos = (prop.photoPositions || []).find(x => x.id === s.id); if (pos) buildPositionMarker(pos); }
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
  beginGeometryEdit(prop, 'move wall');
  if (mv && mv.connected) applyWallMove(mv, r(normalOffset(mv, dx, dz)));
  else { w.ax = r(w.ax + dx); w.ay = r(w.ay + dz); w.bx = r(w.bx + dx); w.by = r(w.by + dz); }
  touch();
  rebuildModel();
  renderInspector();
}

function restoreHistory(direction) {
  if (!prop || !restoreGeometryEdit(prop, direction)) return;
  setSelection(null); rebuildModel(); renderInspector();
}
export function undo() { restoreHistory('undo'); }
export function redo() { restoreHistory('redo'); }

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
// A pinned photo or document lies flat on the surface it was pinned to, like a print put up by
// hand (pins.js has the maths). A pin on a wall face keeps its place on that wall, so it moves
// with the wall. Photos whose camera has been found also show that camera as a small pyramid
// pointing at what the photo shows; clicking it opens the photo over the model.
const PRINT_BORDER = 0.035;   // white border, as a share of the print's long side
function printCanvas(img, aspect, isDoc) {
  const long = 1024;
  const W = aspect >= 1 ? long : Math.round(long * aspect), H = aspect >= 1 ? Math.round(long / aspect) : long;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  const b = isDoc ? 0 : Math.round(long * PRINT_BORDER);
  if (img) ctx.drawImage(img, b, b, W - 2 * b, H - 2 * b);
  else { ctx.fillStyle = '#c9c4b8'; ctx.fillRect(b, b, W - 2 * b, H - 2 * b); }
  ctx.strokeStyle = isDoc ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)'; ctx.lineWidth = isDoc ? 3 : 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);
  return c;
}
function sheetTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1;
  return t;
}
// A flat sheet mesh: a unit plane scaled and turned onto `place` (pins.js sheetPlacement).
function sheetMesh(canvas, kind, id) {
  const mat = new THREE.MeshBasicMaterial({ map: sheetTexture(canvas), color: new THREE.Color(1.08, 1.08, 1.08), toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  mat.userData.noClip = true;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.userData = { kind, id };
  return mesh;
}
function placeSheet(mesh, place) {
  const r = place.right, u = place.up, n = place.normal;
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(r.x, r.y, r.z), new THREE.Vector3(u.x, u.y, u.z), new THREE.Vector3(n.x, n.y, n.z));
  mesh.quaternion.setFromRotationMatrix(m);
  mesh.position.set(place.centre.x, place.centre.y, place.centre.z);
  mesh.scale.set(place.w, place.h, 1);
}
function buildPin(photo) {
  removePin(photo.id);
  if (!photo.pin) return;
  const place = sheetPlacement(photo, prop.walls);
  if (!place) return;
  const isDoc = photo.kind === 'document';
  const aspect = photoAspect(photo);
  const group = new THREE.Group();
  group.userData = { kind: 'pin', id: photo.id };
  const sheet = sheetMesh(printCanvas(null, aspect, isDoc), 'pin', photo.id);
  placeSheet(sheet, place);
  group.add(sheet);
  pinRoot.add(group);
  const rec = { group, sprite: sheet, aspect, place,
    anchor: new THREE.Vector3(place.centre.x, place.centre.y, place.centre.z), normal: new THREE.Vector3(place.normal.x, place.normal.y, place.normal.z) };
  pinObjs[photo.id] = rec;
  const token = mountId;
  const swap = canvas => {
    if (pinObjs[photo.id] !== rec || token !== mountId || !canvas) return;
    sheet.material.map.dispose();
    sheet.material.map = sheetTexture(printCanvas(canvas, aspect, isDoc)); sheet.material.needsUpdate = true;
    requestRender(2);
  };
  // The thumbnail first, then a sharper image: the page for a document, the full photo otherwise.
  const thumb = new Image();
  thumb.onload = () => swap(thumb);
  if (photo.thumb) thumb.src = photo.thumb;
  if (isDoc) documentCanvas(photo, 2048).then(swap).catch(e => console.warn('document page', e));
  else photoUrl(photo.id).then(url => { if (!url) return; const img = new Image(); img.onload = () => swap(img); img.src = url; }).catch(() => {});
  buildCameraGlyph(photo);
}
function removePin(id) {
  const rec = pinObjs[id];
  if (rec) {
    pinRoot.remove(rec.group);
    rec.sprite.material.map.dispose(); rec.sprite.material.dispose(); rec.sprite.geometry.dispose();
    delete pinObjs[id];
  }
  removeCameraGlyph(id);
}
function updatePins() { /* flat sheets sit still; nothing to do per frame */ }
function buildAllPins() {
  for (const id of Object.keys(pinObjs)) removePin(id);
  for (const id of Object.keys(cameraObjs)) removeCameraGlyph(id);
  for (const ph of prop.photos) { if (ph.pin) buildPin(ph); else buildCameraGlyph(ph); }
  buildAllPositions();
}

// A camera pyramid: apex at the camera, base a frame of the photo's shape `depth` metres ahead.
function frustumLines(pose, hfov, aspect, depth, color, opacity) {
  const t = Math.tan(hfov * Math.PI / 360) * depth, s = t / aspect;
  const R = pose.R, C = new THREE.Vector3(...pose.C);
  const at = (x, y, z) => new THREE.Vector3(R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z).add(C);
  const corners = [[-t, s], [t, s], [t, -s], [-t, -s]].map(([x, y]) => at(x, y, -depth));
  const pts = [];
  for (const c of corners) pts.push(C, c);
  for (let i = 0; i < 4; i++) pts.push(corners[i], corners[(i + 1) % 4]);
  pts.push(corners[0].clone().lerp(corners[1], 0.35), at(0, s * 1.35, -depth), at(0, s * 1.35, -depth), corners[0].clone().lerp(corners[1], 0.65));   // a small roof marks the top
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true }));
  lines.raycast = () => {};
  // A pick-able, nearly invisible face across the base so a click on the pyramid opens the photo.
  const face = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  return { lines, face, corners };
}
function buildCameraGlyph(photo) {
  removeCameraGlyph(photo.id);
  const v = photo.kind === 'photo' && photo.view;
  if (!v || !FOUND_SOURCES.includes(v.from) || !cameraRoot) return;
  const pose = poseFromView(v);
  if (!pose) return;
  const weak = v.fit && v.fit.rmsPx > 12;
  const { lines, face } = frustumLines(pose, v.fov, photoAspect(photo), 0.32, weak ? 0x9aa3ad : 0xe8973a, weak ? 0.55 : 0.95);
  face.userData = { kind: 'camera', id: photo.id };
  const group = new THREE.Group();
  group.userData = { kind: 'camera', id: photo.id };
  group.add(lines, face);
  cameraRoot.add(group);
  cameraObjs[photo.id] = group;
}
function removeCameraGlyph(id) {
  const g = cameraObjs[id];
  if (!g) return;
  cameraRoot && cameraRoot.remove(g);
  g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  delete cameraObjs[id];
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
  if (!ph) return 'PIN: add or choose a photo or document in the inspector, then click the surface to hang it on.';
  const left = prop.photos.filter(p => !p.pin).length;
  return 'PIN: click the wall or surface to hang "' + ph.name + '" on' + (pinBatch && left > 1 ? ' (' + left + ' to place; the next one follows)' : '') + '. Esc stops.';
}
function startPinMode(photoId) {
  endMatch();
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
  // Prints keep their chosen size when moved; older pins (card sizes) start at 11 x 14 in.
  const keep = ph.pin && ph.pin.size && (ph.kind === 'document' || PRINT_SIZES.some(x => Math.abs(x.long - ph.pin.size) < 1e-3));
  ph.pin = surfacePin(hit, keep ? ph.pin.size : (ph.kind === 'document' ? 1 : DEFAULT_PRINT));
  ph.roomId = ''; ph.elementIds = (ph.elementIds || []).filter(id => !prop.walls.some(w => w.id === id) && !prop.rooms.some(r => r.id === id));
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
// Where a click lands, as a pin: the point and normal, its place on a wall face when it is on one
// (so it follows the wall), and on a floor or ceiling the turn that keeps its top away from you.
function surfacePin(hit, size) {
  const pin = { x: hit.point.x, y: hit.point.y, z: hit.point.z, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, size };
  const n = hit.normal;
  if (Math.abs(n.y) < 0.5) {
    const ids = [hit.kind === 'wall' ? hit.id : null, hit.wallId, ...prop.walls.map(w => w.id)].filter(Boolean);
    for (const id of ids) {
      const w = prop.walls.find(x => x.id === id);
      const a = w && wallAnchor(w, { x: hit.point.x, y: hit.point.y, z: hit.point.z }, { x: n.x, y: n.y, z: n.z });
      if (a) { pin.wall = a; break; }
    }
  } else {
    const f = new THREE.Vector3(); camera.getWorldDirection(f);
    pin.turn = Math.round(Math.atan2(-f.x, -f.z) * 180 / Math.PI / 90) * 90 % 360;
  }
  return pin;
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

// ---------- photo mode (match photo) ----------
// Stand where a photo was taken and lay the photo over the render, so several photos from
// different angles line up with the same walls. The camera takes the photo's own lens (read from
// the file), starts from the best camera known (a saved or fitted one, else the scan frame taken
// nearest in time), and can be fitted exactly by clicking four or more matching points in the
// photo and the model. A crooked photo (roll) is turned upright on screen. photo-match.js has the
// record, camera-solve.js the maths.
function cameraHfov() { return hfovOf(camera.fov, camera.aspect || 1); }
function currentView(fov, from) {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const target = mode === 'walk' || camera.position.distanceTo(controls.target) < 0.3
    ? camera.position.clone().addScaledVector(dir, 2) : controls.target;
  return normalizeView({ position: camera.position.toArray(), target: target.toArray(), fov, from });
}
function photoAspect(ph) { return ph.w > 0 && ph.h > 0 ? ph.w / ph.h : 4 / 3; }
function cameraFound(ph) { return !!(ph && ph.view && FOUND_SOURCES.includes(ph.view.from)); }
const SOURCE_LABELS = { saved: 'lined up by eye', points: 'fitted to points', keyframe: 'from a scan frame', auto: 'placed automatically', position: 'from a numbered position', pin: 'not found yet', exif: 'lens only' };
function cameraLabel(ph) {
  const v = ph.view;
  if (!v || !FOUND_SOURCES.includes(v.from)) return ph.lens ? 'not found yet · lens ' + Math.round(ph.lens.hfov) + '°' : 'not found yet';
  return SOURCE_LABELS[v.from] + (v.fit ? ' · ' + v.fit.rmsPx.toFixed(1) + ' px' : '');
}
// The lens of a photo in its own pixels: from the file, else from a horizontal field of view.
function photoLens(ph, hfov) {
  if (ph.lens && Math.abs(ph.lens.w - ph.w) < 2 && Math.abs(ph.lens.h - ph.h) < 2) return ph.lens;
  return lensFromHfov(hfov || (ph.lens && ph.lens.hfov) || defaultHfov(photoAspect(ph)), ph.w || 4032, ph.h || 3024);
}
// The scan frame taken closest in time to a photo, as a view with the photo's lens.
function nearestFrameView(ph, hfov) {
  const ms = takenAtMs(ph.takenAt);
  for (const set of prop.cameraSets || []) {
    const near = nearestKeyframe(set, ms);
    if (!near) continue;
    const pose = keyframeModelPose(set, near.row);
    if (pose) return { view: viewFromPose(pose, hfov), gapMs: near.gapMs, set };
  }
  return null;
}
// `resume` (a remount's {hfov, position, target}) puts the camera straight back where it was;
// `opts.view` starts from a given camera (a numbered position).
async function startMatch(id, resume, opts = {}) {
  const ph = photoById(prop, id);
  if (!ph || !wrapEl) return;
  if (ph.kind === 'pano') { toast('A 360 panorama has no single viewpoint to match. Use it as the sky instead.', 'warn'); return; }
  if (ph.kind === 'document') { flyToSheet(id); return; }
  const token = mountId;
  try { if (await ensureCameraFacts(ph)) touch(); } catch (e) { /* no original bytes: the lens stays assumed */ }
  if (token !== mountId) return;
  endMatch();
  if (tool !== 'select') setTool('select');
  if (mode !== 'orbit') setMode('orbit');
  const aspect = photoAspect(ph);
  const lensHfov = ph.lens ? ph.lens.hfov : defaultHfov(aspect);
  let view = (resume && normalizeView({ ...resume, fov: resume.hfov })) || normalizeView(opts.view) || (cameraFound(ph) && normalizeView(ph.view)) || null;
  let start = view ? '' : 'pin';
  if (!view) { const near = nearestFrameView(ph, lensHfov); if (near) { view = near.view; start = 'frame ' + Math.round(near.gapMs / 60000); } }
  if (!view) view = normalizeView(ph.view && { ...ph.view, fov: lensHfov }) || (ph.pin && viewForPin(ph.pin, lensHfov)) || currentView(lensHfov);
  const box = document.createElement('div');
  box.className = 'v-match';
  box.innerHTML = '<div class="v-match-frame"><img alt=""><div class="v-match-dots"></div></div><div class="v-match-pip"><img alt=""><span></span></div><div class="v-match-model-dots"></div>';
  box.querySelector('.v-match-pip span').textContent = ph.name || '';
  for (const img of box.querySelectorAll('img')) img.src = ph.thumb || '';
  wrapEl.appendChild(box);
  match = { id, aspect, hfov: resume ? resume.hfov : view.fov, roll: resume ? (resume.roll || 0) : (view.roll || 0), el: box, start, points: null, positionId: opts.positionId || null };
  photoUrl(id).then(url => { if (url && match && match.id === id && token === mountId) for (const img of box.querySelectorAll('img')) img.src = url; });
  box.querySelector('.v-match-frame').addEventListener('click', onMatchPhotoClick);
  controls.maxPolarAngle = MATCH_POLAR;
  applyMarkerVisibility();
  applyMatchFrame();
  flyTo(new THREE.Vector3(...view.position), new THREE.Vector3(...view.target), resume ? 0 : 700);
  renderInspector();
  setHint('PHOTO MODE: orbit, pan and zoom until the model lines up with the photo, or FIT WITH POINTS, then SAVE. Esc ends.');
}
function applyMatchFrame() {
  if (!match || !wrapEl || !camera) return;
  const W = wrapEl.clientWidth, H = wrapEl.clientHeight;
  if (!W || !H) return;
  const f = viewFrame(W, H, match.aspect, match.hfov);
  camera.fov = f.vfov; camera.updateProjectionMatrix();
  const frame = match.el.querySelector('.v-match-frame'), pip = match.el.querySelector('.v-match-pip');
  Object.assign(frame.style, { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' });
  const img = frame.querySelector('img');
  img.style.opacity = matchBeside ? 0 : matchOpacity;
  // A crooked photo is turned upright, so its edges line up with the level render.
  img.style.transform = match.roll ? `rotate(${-match.roll}deg)` : '';
  match.el.classList.toggle('beside', matchBeside);
  const picking = !!(match.points && match.points.mode === 'photo');
  frame.style.pointerEvents = picking ? 'auto' : 'none';
  frame.style.cursor = picking ? 'crosshair' : '';
  // Side by side: the photo in a card beside the frame it should match, at its own aspect.
  const pw = Math.min(W * 0.42, H * 0.5 * match.aspect);
  Object.assign(pip.style, { width: pw + 'px', height: pw / match.aspect + 'px' });
  drawMatchPhotoDots();
  requestRender(2);
}
// Screen offset in the frame (from its centre, y down) <-> photo pixel, through the roll.
function framePixel(dx, dy, rect, ph) {
  const a = (match.roll || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const px = dx * c - dy * s, py = dx * s + dy * c;
  return [(px / rect.width + 0.5) * ph.w, (py / rect.height + 0.5) * ph.h];
}
function pixelFrame(u, v, rect, ph) {
  const px = (u / ph.w - 0.5) * rect.width, py = (v / ph.h - 0.5) * rect.height;
  const a = -(match.roll || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [px * c - py * s + rect.width / 2, px * s + py * c + rect.height / 2];
}
function onMatchPhotoClick(e) {
  if (!match || !match.points || match.points.mode !== 'photo') return;
  const ph = photoById(prop, match.id);
  const frame = match.el.querySelector('.v-match-frame'), rect = frame.getBoundingClientRect();
  const [u, v] = framePixel(e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2, rect, ph);
  if (u < 0 || v < 0 || u > ph.w || v > ph.h) return;
  match.points.pending = [u, v];
  match.points.mode = 'model';
  applyMatchFrame(); renderMatchPanel();
  setHint('PHOTO MODE: now click the same spot in the model.');
}
function addMatchModelPoint(e) {
  const hit = pick(e, { surfaceOnly: true, scans: true, ground: true, pins: false, notes: false });
  if (!hit) { toast('Click a surface of the model or the scan.', 'warn'); return; }
  const pts = match.points;
  pts.pairs.push({ img: pts.pending.map(x => Math.round(x * 10) / 10), world: hit.point.toArray().map(x => Math.round(x * 1e4) / 1e4) });
  pts.pending = null; pts.mode = 'photo';
  if (pts.pairs.length >= 4) solveMatchPoints();
  applyMatchFrame(); renderMatchPanel();
  setHint(pts.pairs.length >= 4 ? 'PHOTO MODE: fitted to ' + pts.pairs.length + ' points. Add more to check it, or SAVE.' : 'PHOTO MODE: pair ' + pts.pairs.length + ' of 4 placed. Click the next spot in the photo.');
}
function solveMatchPoints() {
  const ph = photoById(prop, match.id), pts = match.points;
  const lens = photoLens(ph, match.hfov);
  const init = lookAtPose(camera.position.toArray(), (controls.target).toArray(), match.roll || 0);
  const fit = solvePose(pts.pairs, lens, init, { solveFocal: !ph.lens && pts.pairs.length >= 6 });
  if (!fit) { pts.fit = null; toast('Those points do not fit one camera. Check each pair, or line the view up roughly by eye first.', 'warn'); return; }
  const v = viewFromPose(fit.pose, hfovOfLens({ ...fit.lens, w: lens.w }), Math.max(1, camera.position.distanceTo(controls.target)));
  pts.fit = { rmsPx: Math.round(fit.rmsPx * 10) / 10, n: pts.pairs.length, errors: fit.errors };
  match.hfov = v.fov; match.roll = v.roll || 0;
  flyTo(new THREE.Vector3(...v.position), new THREE.Vector3(...v.target), 0);
}
function drawMatchPhotoDots() {
  if (!match) return;
  const box = match.el.querySelector('.v-match-dots'), ph = photoById(prop, match.id);
  if (!box || !ph) return;
  const pts = match.points;
  if (!pts) { box.innerHTML = ''; return; }
  const frame = match.el.querySelector('.v-match-frame');
  const rect = { width: frame.clientWidth, height: frame.clientHeight };
  const list = pts.pairs.map((p, i) => [p.img, i + 1, pts.fit && pts.fit.errors ? pts.fit.errors[i] : null]);
  if (pts.pending) list.push([pts.pending, pts.pairs.length + 1, null]);
  box.innerHTML = list.map(([[u, v], n, err]) => { const [x, y] = pixelFrame(u, v, rect, ph);
    return `<i class="v-match-dot photo" style="left:${x}px;top:${y}px" title="${err != null ? err.toFixed(1) + ' px off' : ''}">${n}</i>`; }).join('');
}
function updateMatchMarkers() {
  if (!match || !match.points) return;
  const box = match.el.querySelector('.v-match-model-dots');
  const W = wrapEl.clientWidth, H = wrapEl.clientHeight;
  box.innerHTML = match.points.pairs.map((p, i) => {
    const q = new THREE.Vector3(...p.world).project(camera);
    if (q.z > 1) return '';
    return `<i class="v-match-dot model" style="left:${((q.x + 1) / 2 * W).toFixed(0)}px;top:${((1 - q.y) / 2 * H).toFixed(0)}px">${i + 1}</i>`;
  }).join('');
}
function endMatch() {
  if (!match) return;
  match.el.remove();
  match = null;
  if (camera) { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); }
  if (controls) { controls.maxPolarAngle = mode === 'walk' ? controls.maxPolarAngle : ORBIT_POLAR; controls.update(); }
  applyMarkerVisibility();
  setHint('');
  renderInspector();
}
function saveMatchView() {
  const ph = match && photoById(prop, match.id);
  if (!ph) return endMatch();
  const pts = match.points;
  const fitted = pts && pts.fit && pts.pairs.length >= 4;
  const v = currentView(match.hfov, fitted ? 'points' : 'saved');
  if (match.roll) v.roll = match.roll;
  if (fitted) { v.fit = { rmsPx: pts.fit.rmsPx, n: pts.pairs.length }; v.pairs = pts.pairs; }
  ph.view = normalizeView(v);
  touch();
  buildCameraGlyph(ph);
  toast('Camera saved for "' + ph.name + '"' + (fitted ? ' (' + pts.fit.rmsPx + ' px average error over ' + pts.pairs.length + ' points)' : '') + '.', 'ok');
  renderInspector();
}
function viewLabel(ph) { return cameraLabel(ph); }
function renderMatchPanel() {
  const ph = photoById(prop, match.id);
  if (!ph) { endMatch(); return; }
  const pct = Math.round(matchOpacity * 100);
  const pts = match.points;
  const near = (prop.cameraSets || []).some(s => Object.keys(s.sessions || {}).length) && ph.takenAt ? nearestFrameView(ph, match.hfov) : null;
  const pos = ph.positionId && (prop.photoPositions || []).find(x => x.id === ph.positionId);
  const pairsHtml = pts ? `<div class="field"><label>Point pairs <b>${pts.pairs.length}${pts.pending ? ' + 1' : ''}</b></label>
      <div class="empty" style="margin:2px 0 6px">${pts.mode === 'photo' ? 'Click a sharp corner in the photo' : 'Now click the same spot in the model'}. Four pairs fit the camera; spread them out and use six or more to check it.</div>
      ${pts.fit ? `<div class="stat-line"><span>Average error</span><b>${pts.fit.rmsPx} px</b></div>` : ''}
      <div class="seg fill"><button class="seg-btn" data-pt-undo ${pts.pairs.length || pts.pending ? '' : 'disabled'}>UNDO POINT</button><button class="seg-btn" data-pt-clear ${pts.pairs.length ? '' : 'disabled'}>CLEAR</button></div></div>` : '';
  inspEl.innerHTML = `<h3>PHOTO MODE</h3>
    <div class="v-thumb big active"><img src="${escapeHtml(ph.thumb)}" alt=""></div>
    <div class="stat-line"><span>${escapeHtml(ph.name)}</span><b>${escapeHtml(cameraLabel(ph))}</b></div>
    ${ph.takenAt ? `<div class="stat-line"><span>Taken</span><b>${escapeHtml(ph.takenAt.replace('T', ' ').slice(0, 16))}</b></div>` : ''}
    ${ph.lens ? `<div class="stat-line"><span>Lens (from the photo file)</span><b>${ph.lens.f35 ? ph.lens.f35 + ' mm equiv. · ' : ''}${Math.round(ph.lens.hfov)}&deg;</b></div>` : ''}
    ${match.start && match.start.startsWith('frame') ? `<div class="empty" style="margin:4px 0">Started at the scan frame taken ${match.start.slice(6)} min from this photo.</div>` : ''}
    <div class="empty" style="margin:6px 0 12px">The photo sits in the frame its lens covers. Orbit, pan and zoom until walls, openings and fixtures line up, or fit the camera to points. Where they cannot line up, the model differs from the site.</div>
    <div class="field"><label>Show the photo</label><div class="seg fill">
      <button class="seg-btn ${matchBeside ? '' : 'active'}" data-match-layout="over">OVER</button>
      <button class="seg-btn ${matchBeside ? 'active' : ''}" data-match-layout="beside">SIDE BY SIDE</button></div></div>
    <div class="field" ${matchBeside ? 'hidden' : ''}><label>Photo opacity <b data-match-opv>${pct}%</b></label>
      <input type="range" min="0" max="1" step="0.05" value="${matchOpacity}" data-match-op></div>
    <div class="field"><label>Lens (horizontal field of view) <b data-match-fovv>${Math.round(match.hfov)}&deg;</b></label>
      <input type="range" min="${FOV_MIN}" max="${FOV_MAX}" step="1" value="${Math.round(match.hfov)}" data-match-fov ${ph.lens ? 'title="Set from the photo file"' : ''}></div>
    ${pairsHtml}
    <button class="btn ${pts ? '' : 'primary'}" data-match-points>${pts ? 'STOP PLACING POINTS' : 'FIT WITH POINTS'}</button>
    ${near ? '<button class="btn" data-match-frame>START AT NEAREST SCAN FRAME</button>' : ''}
    <button class="btn" data-match-auto title="Match the photo against the scan frames on this Mac">PLACE AUTOMATICALLY</button>
    <button class="btn primary" data-match-save>SAVE CAMERA FOR THIS PHOTO</button>
    ${cameraFound(ph) ? '<button class="btn" data-match-back>BACK TO SAVED CAMERA</button>' : ''}
    ${pos ? `<div class="stat-line"><span>Numbered position</span><b>${escapeHtml(positionLabel(pos))}</b></div>` : '<button class="btn" data-match-pos title="Keep this camera as a numbered position for before, rendering and after pictures">MAKE NUMBERED POSITION</button>'}
    <button class="btn" data-match-open>OPEN FULL SIZE</button>
    <button class="btn" data-match-done>DONE</button>`;
  inspEl.querySelectorAll('[data-match-layout]').forEach(b => b.onclick = () => { matchBeside = b.dataset.matchLayout === 'beside'; applyMatchFrame(); renderMatchPanel(); });
  const op = inspEl.querySelector('[data-match-op]');
  op.oninput = () => { matchOpacity = parseFloat(op.value); inspEl.querySelector('[data-match-opv]').textContent = Math.round(matchOpacity * 100) + '%'; applyMatchFrame(); };
  const fov = inspEl.querySelector('[data-match-fov]');
  fov.oninput = () => { match.hfov = parseFloat(fov.value); inspEl.querySelector('[data-match-fovv]').innerHTML = Math.round(match.hfov) + '&deg;'; applyMatchFrame(); };
  inspEl.querySelector('[data-match-points]').onclick = () => {
    match.points = match.points ? null : { pairs: ph.view && ph.view.from === 'points' && ph.view.pairs ? ph.view.pairs.map(p => ({ img: p.img.slice(), world: p.world.slice() })) : [], pending: null, mode: 'photo', fit: null };
    if (match.points && match.points.pairs.length >= 4) solveMatchPoints();
    if (match.points && matchOpacity < 0.35) matchOpacity = 0.6;
    if (match.points) matchBeside = false;
    applyMatchFrame(); renderMatchPanel(); updateMatchMarkers();
    if (!match.points) match.el.querySelector('.v-match-model-dots').innerHTML = '';
    setHint(match.points ? 'PHOTO MODE: click a sharp corner in the photo, then the same spot in the model.' : 'PHOTO MODE: orbit, pan and zoom until the model lines up with the photo, then SAVE.');
  };
  const undo = inspEl.querySelector('[data-pt-undo]'), clear = inspEl.querySelector('[data-pt-clear]');
  if (undo) undo.onclick = () => { if (pts.pending) { pts.pending = null; pts.mode = 'photo'; } else { pts.pairs.pop(); pts.fit = null; if (pts.pairs.length >= 4) solveMatchPoints(); } applyMatchFrame(); renderMatchPanel(); };
  if (clear) clear.onclick = () => { pts.pairs = []; pts.pending = null; pts.mode = 'photo'; pts.fit = null; applyMatchFrame(); renderMatchPanel(); };
  const nf = inspEl.querySelector('[data-match-frame]');
  if (nf) nf.onclick = () => { const n = nearestFrameView(ph, match.hfov); if (!n) return; match.roll = n.view.roll || 0; applyMatchFrame(); flyTo(new THREE.Vector3(...n.view.position), new THREE.Vector3(...n.view.target), 500); };
  inspEl.querySelector('[data-match-auto]').onclick = () => openAutoPlacement([ph.id]);
  inspEl.querySelector('[data-match-save]').onclick = saveMatchView;
  const back = inspEl.querySelector('[data-match-back]');
  if (back) back.onclick = () => {
    const v = normalizeView(ph.view);
    if (!v) return;
    match.hfov = v.fov; match.roll = v.roll || 0; applyMatchFrame();
    flyTo(new THREE.Vector3(...v.position), new THREE.Vector3(...v.target), 500);
    renderMatchPanel();
  };
  const mp = inspEl.querySelector('[data-match-pos]');
  if (mp) mp.onclick = () => { if (!cameraFound(ph)) saveMatchView(); makePositionFrom(ph.id); };
  inspEl.querySelector('[data-match-open]').onclick = () => openLightbox(ph.id);
  inspEl.querySelector('[data-match-done]').onclick = endMatch;
}

// ---------- pinned sheets: reading and opening ----------
function flyToSheet(id) {
  const r = pinObjs[id];
  if (!r) return;
  showMarkers('pins');
  const v = viewForSheet(r.place, BASE_FOV, camera.aspect || 1.6, 0.85);
  if (mode === 'walk') setMode('orbit');
  flyTo(new THREE.Vector3(...v.position), new THREE.Vector3(...v.target), 700);
}
async function openPinned(ph) {
  if (ph.kind !== 'document' || !isPdfDocument(ph)) return openLightbox(ph.id);
  const buf = await photoBytes(ph.id);
  if (!buf) { toast('The PDF file is missing from this browser.', 'error'); return; }
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
  const w = window.open(url, '_blank', 'noopener');
  if (!w) toast('The browser blocked the new tab. Allow pop-ups for Tiksi to open PDFs.', 'warn');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

// ---------- numbered photo positions ----------
// A camera fixed in the model and numbered like a section mark on a drawing. Each one collects
// the before photo, renderings of the current design from exactly that camera (RENDER ALL
// POSITIONS), and the after photo (positions.js).
function positionCanvas(pos, selected) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.beginPath(); ctx.arc(64, 64, 54, 0, Math.PI * 2);
  ctx.fillStyle = selected ? '#e8973a' : '#1f6fd1'; ctx.fill();
  ctx.lineWidth = 8; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.font = '700 ' + (pos.number > 99 ? 44 : 60) + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(pos.number), 64, 68);
  return c;
}
function buildPositionMarker(pos) {
  removePositionMarker(pos.id);
  const pose = poseFromView(pos.view);
  if (!pose || !positionRoot) return;
  const selected = !!(selection && selection.kind === 'position' && selection.id === pos.id);
  const before = picturesOf(prop, pos.id).before[0];
  const { lines, face } = frustumLines(pose, pos.view.fov, before ? photoAspect(before) : 4 / 3, 0.45, selected ? 0xe8973a : 0x1f6fd1, 0.95);
  face.userData = { kind: 'position', id: pos.id };
  const tex = sheetTexture(positionCanvas(pos, selected));
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, toneMapped: false }));
  tag.scale.set(0.045, 0.045, 1); tag.renderOrder = 995;
  tag.position.set(...pose.C);
  tag.userData = { kind: 'position', id: pos.id };
  const group = new THREE.Group();
  group.userData = { kind: 'position', id: pos.id };
  group.add(lines, face, tag);
  positionRoot.add(group);
  positionObjs[pos.id] = group;
  requestRender(2);
}
function removePositionMarker(id) {
  const g = positionObjs[id];
  if (!g) return;
  positionRoot && positionRoot.remove(g);
  g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  delete positionObjs[id];
}
function buildAllPositions() {
  for (const id of Object.keys(positionObjs)) removePositionMarker(id);
  for (const pos of prop.photoPositions || []) buildPositionMarker(pos);
}
function makePositionFrom(photoId) {
  const ph = photoById(prop, photoId);
  if (!ph || !cameraFound(ph)) { toast('Find the camera first: PHOTO MODE, then line it up or FIT WITH POINTS and SAVE.', 'warn'); return; }
  if (ph.positionId) { setSelection({ kind: 'position', id: ph.positionId }); return; }
  const room = ph.roomId && prop.rooms.find(r => r.id === ph.roomId);
  const pos = addPosition(prop, { id: uid('pos'), view: { ...ph.view, from: 'position' }, name: room ? room.name || '' : '', roomId: ph.roomId || '', fromPhoto: ph });
  touch();
  buildPositionMarker(pos);
  if (match) endMatch();
  setSelection({ kind: 'position', id: pos.id });
  toast('Numbered position ' + pos.number + ' made from "' + ph.name + '". RENDER ALL POSITIONS makes the design from here.', 'ok');
}
function viewFromPosition(id) {
  const pos = (prop.photoPositions || []).find(x => x.id === id);
  if (!pos) return;
  const pics = picturesOf(prop, id);
  const show = pics.after[pics.after.length - 1] || pics.before[0];
  if (show) { startMatch(show.id, null, { view: pos.view, positionId: id }); return; }
  if (mode === 'walk') setMode('orbit');
  flyTo(new THREE.Vector3(...pos.view.position), new THREE.Vector3(...pos.view.target), 700);
}
let renderingPositions = false;
// Render the current design at each position, from exactly its camera, and file the stills on it.
async function renderPositions(ids) {
  if (renderingPositions) return;
  const list = (prop.photoPositions || []).filter(p => !ids || ids.includes(p.id));
  if (!list.length) { toast('No numbered positions yet. Make one from a photo whose camera is found.', 'warn'); return; }
  renderingPositions = true;
  const token = mountId, made = [];
  try {
    for (const [i, pos] of list.entries()) {
      if (token !== mountId) return;
      setHint('Rendering position ' + pos.number + ' (' + (i + 1) + ' of ' + list.length + ')…');
      const { width, height } = renderSize(prop, pos, 2400);
      const blob = await renderStillBlob({ width, height, quality: quality(), annotations: false, view: pos.view });
      if (token !== mountId) return;
      const now = new Date();
      const file = new File([blob], renderingName(pos, now) + '.png', { type: 'image/png' });
      const rec = await addPhotoFromFile(prop, file, { source: 'rendering', positionId: pos.id, role: 'rendering', renderedAt: now.toISOString(), view: { ...pos.view, from: 'position' } });
      rec.roomId = pos.roomId || '';
      made.push(rec);
    }
    touch();
    toast('Rendered ' + made.length + ' position' + (made.length === 1 ? '' : 's') + '. The renderings are in PHOTOS and on each position.', 'ok');
  } catch (e) {
    // What was rendered before the stop is kept; say which positions still have no rendering.
    if (made.length) touch();
    const left = list.slice(made.length).map(p => p.number);
    toast('Rendering stopped: ' + e.message + (made.length ? ' Rendered: ' + made.length + '.' : '') + ' Not rendered: position' + (left.length === 1 ? ' ' : 's ') + left.join(', ') + '.', 'error', 12000);
  } finally {
    renderingPositions = false;
    if (token === mountId) { setHint(''); renderInspector(); }
  }
}
function positionsListHtml() {
  const list = prop.photoPositions || [];
  if (!list.length) return '';
  return `<h3 style="margin-top:14px">PHOTO POSITIONS</h3>` + list.map(pos => {
    const pics = picturesOf(prop, pos.id), thumb = (pics.after[0] || pics.rendering[pics.rendering.length - 1] || pics.before[0] || {}).thumb || '';
    return `<div class="v-pin-row">
      ${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : '<i class="v-pos-chip"></i>'}
      <span class="v-pin-name"><b class="v-pos-num">${pos.number}</b> ${escapeHtml(pos.name || '')} <span class="muted">${pics.before.length}/${pics.rendering.length}/${pics.after.length}</span></span>
      <button class="btn small" data-pos-open="${escapeHtml(pos.id)}" title="Show this position's pictures">OPEN</button>
      <button class="btn small" data-pos-view="${escapeHtml(pos.id)}" title="Stand at this position">VIEW</button>
    </div>`; }).join('') + `<div class="empty" style="margin:4px 0 6px">Counts are before / renderings / after.</div>
    <button class="btn" data-pos-render-all>RENDER ALL POSITIONS</button>`;
}
function bindPositionsList(root) {
  root.querySelectorAll('[data-pos-open]').forEach(b => b.onclick = () => setSelection({ kind: 'position', id: b.dataset.posOpen }));
  root.querySelectorAll('[data-pos-view]').forEach(b => b.onclick = () => viewFromPosition(b.dataset.posView));
  const all = root.querySelector('[data-pos-render-all]');
  if (all) all.onclick = () => renderPositions(null);
}

// ---------- scan cameras (Polycam raw export) ----------
// IMPORT POLYCAM CAMERAS reads every keyframe's camera from a Polycam "raw data" export folder
// (cameras/*.json). Each tracking session is then lined up with the model once, from the
// keyframes' depth maps (LINE UP WITH THE MODEL), after which photos start at the scan frame taken
// nearest in time, sharp frames can be added as ready-placed photos, and the automatic
// placement helper on this Mac can match photos against them.
function pickFolder() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.webkitdirectory = true; input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files || []));
    input.click();
  });
}
function polycamIndex(files) {
  const map = new Map();
  let root = '';
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name, parts = rel.split('/');
    const dir = parts[parts.length - 2], stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
    if (!['cameras', 'images', 'depth', 'confidence', 'corrected_cameras', 'corrected_images'].includes(dir)) continue;
    root = root || parts.slice(0, -2).join('/');
    const rec = map.get(stem) || {}; map.set(stem, rec);
    const key = { cameras: 'camera', corrected_cameras: 'corrected', images: 'image', corrected_images: 'correctedImage', depth: 'depth', confidence: 'confidence' }[dir];
    if (key) rec[key] = f;
  }
  return { name: root || 'Polycam export', files: map };
}
async function importPolycamCameras() {
  const files = await pickFolder();
  if (!files.length) return;
  const idx = polycamIndex(files);
  const stems = [...idx.files.keys()].filter(k => idx.files.get(k).camera || idx.files.get(k).corrected).sort();
  if (!stems.length) { toast('No cameras/ folder in that folder. Choose the folder of a Polycam raw data export (it holds cameras, images and depth).', 'warn'); return; }
  setHint('Reading ' + stems.length + ' scan cameras…');
  const rows = [];
  for (let i = 0; i < stems.length; i += 200) {
    const part = await Promise.all(stems.slice(i, i + 200).map(async stem => {
      const f = idx.files.get(stem);
      // Polycam's own globally corrected cameras, when it wrote them, are better than the raw ones.
      try { return keyframeRow(JSON.parse(await (f.corrected || f.camera).text()), stem); } catch (e) { return null; }
    }));
    rows.push(...part.filter(Boolean));
  }
  setHint('');
  if (!rows.length) { toast('None of those camera files could be read.', 'error'); return; }
  const set = { id: uid('cams'), name: idx.name.split('/').pop() || 'Polycam cameras', source: 'polycam', importedAt: new Date().toISOString(), folder: idx.name, exportPath: '', sessions: {}, keyframes: rows };
  prop.cameraSets = prop.cameraSets || [];
  prop.cameraSets.push(set);
  polycamFolder = idx;
  touch(); renderInspector();
  const segs = segmentsOf(set);
  toast('Read ' + rows.length + ' scan cameras in ' + segs.length + ' tracking session' + (segs.length === 1 ? '' : 's') + '. Next: LINE UP WITH THE MODEL.', 'ok');
}
async function ensureFolderFor(set) {
  if (polycamFolder && polycamFolder.name === set.folder) return polycamFolder;
  toast('Choose the Polycam export folder "' + set.folder + '" again: the browser does not keep folder access between visits.', 'info');
  const files = await pickFolder();
  if (!files.length) return null;
  const idx = polycamIndex(files);
  if (!idx.files.size) { toast('That folder is not a Polycam raw data export.', 'warn'); return null; }
  polycamFolder = idx;
  return idx;
}
// Points on the model's surfaces, in model coordinates: from the scans when any are loaded (their
// vertices are dense), else area-weighted samples of the plan's walls and floors.
function sampleModelPoints(limit = 160000) {
  const out = [], v = new THREE.Vector3();
  const take = (obj, every) => {
    const pos = obj.geometry && obj.geometry.getAttribute('position');
    if (!pos) return;
    obj.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i += every) { v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld); out.push([v.x, v.y, v.z]); }
  };
  const scans = [];
  if (scanRoot) scanRoot.traverse(o => { if ((o.isMesh || o.isPoints) && !o.userData.pickBox && !o.userData.helper && o.geometry) scans.push(o); });
  const total = scans.reduce((n, o) => n + (o.geometry.getAttribute('position')?.count || 0), 0);
  if (total > 5000) { for (const o of scans) take(o, Math.max(1, Math.ceil(total / limit))); return { points: out, from: 'scan' }; }
  const tris = [];
  if (modelGroup) modelGroup.traverse(o => { if (o.isMesh && o.visible !== false && o.geometry) tris.push(o); });
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  const all = [];
  for (const o of tris) {
    o.updateWorldMatrix(true, false);
    const g = o.geometry, pos = g.getAttribute('position'), index = g.index;
    const n = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < n; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3, i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1, i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld); b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld); c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      const ar = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
      if (ar > 1e-6) { all.push([a.toArray(), b.toArray(), c.toArray(), ar]); area += ar; }
    }
  }
  const density = Math.min(400, limit / (area || 1));
  for (const [p0, p1, p2, ar] of all) {
    const k = Math.max(0, Math.round(ar * density));
    for (let i = 0; i < k; i++) {
      let r1 = Math.random(), r2 = Math.random();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      out.push([0, 1, 2].map(j => p0[j] + r1 * (p1[j] - p0[j]) + r2 * (p2[j] - p0[j])));
    }
  }
  return { points: out, from: 'plan' };
}
// The first scan's placement in the model (row-major), as a starting guess: a Polycam mesh export
// shares its frame with the keyframe cameras of its first session.
function scanPlacementMatrix() {
  for (const s of prop.scans) {
    const o = scanObjs[s.id];
    if (!o) continue;
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements;
    return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], 0, 0, 0, 1];
  }
  return null;
}
// What the scan sessions are lined up against, and the first guess at their placement. The
// result is saved and places the photo cameras, so it is computed from every scan of the
// property, hidden ones too, exactly as when opening MODEL loaded them all: the scans that are
// not loaded yet are loaded first (and stay hidden).
async function lineUpModel() {
  const token = mountId;
  if (prop.scans.some(s => !scanObjs[s.id] && (!scanState[s.id] || scanState[s.id] === 'hidden' || scanState[s.id] === 'loading'))) {
    setHint('Loading the scans to line up against…');
    await loadScans(true);
    if (token !== mountId) return null;
    setHint('');
  }
  return { ...sampleModelPoints(), init: scanPlacementMatrix() };
}
// For the browser checks: what a line-up would be computed against right now.
export async function lineUpSource() {
  if (!scene || !prop) return null;
  const model = await lineUpModel();
  return model && { from: model.from, points: model.points.length, placed: !!model.init };
}
async function lineUpSessions(setId) {
  const set = (prop.cameraSets || []).find(s => s.id === setId);
  if (!set) return;
  const folder = await ensureFolderFor(set);
  if (!folder) return;
  const token = mountId;
  const model = await lineUpModel();
  if (token !== mountId || !model) return;
  if (model.points.length < 500) { toast('The model has too little surface to line the scan up against. Load the scan or draw the plan first.', 'warn'); return; }
  const report = [];
  const inits = [model.init].filter(Boolean);
  // Larger sessions first: once one is lined up, its placement is a starting guess for the rest.
  const segs = segmentsOf(set).sort((a, b) => set.keyframes.filter(r => r[KF.seg] === b).length - set.keyframes.filter(r => r[KF.seg] === a).length);
  for (const seg of segs) {
    const rows = set.keyframes.filter(r => r[KF.seg] === seg && folder.files.get(r[KF.stem]) && folder.files.get(r[KF.stem]).depth);
    if (rows.length < 3) { report.push('session ' + seg + ': no depth maps'); continue; }
    setHint('Lining up scan session ' + seg + ' (' + rows.length + ' frames)…');
    await new Promise(r => setTimeout(r, 30));
    const pick = Array.from({ length: Math.min(36, rows.length) }, (_, i) => rows[Math.floor(i * rows.length / Math.min(36, rows.length))]);
    const pts = [];
    for (const row of pick) {
      const f = folder.files.get(row[KF.stem]);
      try {
        const depth = await decodePng16(new Uint8Array(await f.depth.arrayBuffer()));
        const conf = f.confidence ? await decodePng16(new Uint8Array(await f.confidence.arrayBuffer())) : null;
        pts.push(...depthPoints(row, depth, conf, 6));
      } catch (e) { /* a damaged depth map is skipped */ }
    }
    if (token !== mountId) return;
    const r = alignSession(pts, model.points, inits.length ? inits : null);
    if (r && r.inliers >= 0.6) inits.push(r.matrix);
    if (!r || r.inliers < 0.35) { report.push('session ' + seg + ': could not line up' + (r ? ' (' + Math.round(r.inliers * 100) + '% of points on the model)' : '')); continue; }
    set.sessions[String(seg)] = { matrix: r.matrix, method: r.method, inliers: r.inliers, fitM: r.fitM };
    report.push('session ' + seg + ': ' + Math.round(r.inliers * 100) + '% of points within 5 cm, ' + (r.fitM * 100).toFixed(1) + ' cm average');
  }
  setHint('');
  touch(); renderInspector();
  toast('Scan sessions lined up against the ' + model.from + ': ' + report.join('; ') + '.', report.some(x => x.includes('could not')) ? 'warn' : 'ok', 12000);
}
async function addSharpFrames(setId, max = 40) {
  const set = (prop.cameraSets || []).find(s => s.id === setId);
  if (!set) return;
  const folder = await ensureFolderFor(set);
  if (!folder) return;
  const lined = { ...set, keyframes: set.keyframes.filter(r => set.sessions[String(r[KF.seg])] && folder.files.get(r[KF.stem]) && folder.files.get(r[KF.stem]).image) };
  if (!lined.keyframes.length) { toast('Line the scan sessions up with the model first.', 'warn'); return; }
  const every = Math.max(1, Math.ceil(lined.keyframes.length / max));
  const rows = sharpKeyframes(lined, every).slice(0, max);
  const have = new Set(prop.photos.filter(p => p.source === 'polycam-keyframe').map(p => p.name));
  let added = 0;
  for (const row of rows) {
    const name = 'Scan frame ' + row[KF.stem];
    if (have.has(name)) continue;
    const f = folder.files.get(row[KF.stem]);
    const pose = keyframeModelPose(set, row), lens = keyframeLens(row);
    const hfov = hfovOfLens(lens);
    try {
      const rec = await addPhotoFromFile(prop, new File([f.image], name + '.jpg', { type: 'image/jpeg' }),
        { source: 'polycam-keyframe', view: { ...viewFromPose(pose, hfov), from: 'keyframe', fit: { rmsPx: 0, n: 0 } } });
      rec.lens = { ...lens, hfov, vfov: 2 * Math.atan(lens.h / (2 * lens.fy)) * 180 / Math.PI, source: 'polycam' };
      if (row[KF.t]) rec.takenAt = new Date(row[KF.t]).toISOString();
      buildCameraGlyph(rec);
      added++;
    } catch (e) { console.warn('scan frame', e); }
  }
  touch(); renderInspector();
  toast('Added ' + added + ' sharp scan frames as photos, each with its camera. They show as orange pyramids in the model.', 'ok');
}
function camerasPanelHtml() {
  const sets = prop.cameraSets || [];
  const rows = sets.map(set => {
    const segs = segmentsOf(set), lined = segs.filter(s => set.sessions[String(s)]);
    return `<div class="v-cams" data-set="${escapeHtml(set.id)}">
      <div class="stat-line"><span>${escapeHtml(set.name)}</span><b>${set.keyframes.length} frames</b></div>
      <div class="stat-line"><span>Sessions lined up</span><b>${lined.length} of ${segs.length}</b></div>
      ${segs.map(s => { const x = set.sessions[String(s)]; return `<div class="stat-line small"><span>Session ${s}</span><b>${x ? Math.round(x.inliers * 100) + '% · ' + (x.fitM * 100).toFixed(1) + ' cm' : 'not yet'}</b></div>`; }).join('')}
      <div class="field"><label>Folder on this Mac (for automatic placement)</label><input type="text" data-cams-path placeholder="/Users/…/Source media/keyframes" value="${escapeHtml(set.exportPath || '')}"></div>
      <button class="btn" data-cams-align>LINE UP WITH THE MODEL</button>
      <button class="btn" data-cams-frames ${lined.length ? '' : 'disabled'}>ADD SHARP FRAMES AS PHOTOS</button>
      <button class="btn danger small" data-cams-del>REMOVE THESE CAMERAS</button>
    </div>`;
  }).join('');
  const unplaced = prop.photos.filter(p => p.kind === 'photo' && p.source !== 'rendering' && p.source !== 'polycam-keyframe' && !cameraFound(p)).length;
  return `<h3 style="margin-top:14px">SCAN CAMERAS</h3>
    <div class="empty" style="margin-bottom:6px">A Polycam raw data export records the camera of every scan frame. Lined up with the model, it places photos taken during the scan.</div>
    ${rows}
    <button class="btn" data-cams-import>IMPORT POLYCAM CAMERAS</button>
    ${sets.length ? `<button class="btn" data-auto-all ${unplaced ? '' : 'disabled'}>PLACE ${unplaced} PHOTO${unplaced === 1 ? '' : 'S'} AUTOMATICALLY</button>` : ''}`;
}
function bindCamerasPanel(root) {
  const imp = root.querySelector('[data-cams-import]');
  if (imp) imp.onclick = () => importPolycamCameras();
  root.querySelectorAll('[data-set]').forEach(box => {
    const id = box.dataset.set, set = prop.cameraSets.find(s => s.id === id);
    box.querySelector('[data-cams-align]').onclick = () => lineUpSessions(id);
    box.querySelector('[data-cams-frames]').onclick = () => addSharpFrames(id);
    box.querySelector('[data-cams-path]').onchange = e => { set.exportPath = e.target.value.trim(); touch(); };
    box.querySelector('[data-cams-del]').onclick = () => { prop.cameraSets = prop.cameraSets.filter(s => s.id !== id); touch(); renderInspector(); };
  });
  const all = root.querySelector('[data-auto-all]');
  if (all) all.onclick = () => openAutoPlacement(prop.photos.filter(p => p.kind === 'photo' && p.source !== 'rendering' && p.source !== 'polycam-keyframe' && !cameraFound(p)).map(p => p.id));
}

// ---------- automatic placement (local helper) ----------
// Sends photos to the photo placement helper on this Mac (server/photo_placement.py), which
// matches them against the scan frames and solves each camera. Results are applied at once and
// can be checked in PHOTO MODE or undone.
let autoUndo = [];
async function placementApi(path, options = {}) {
  const cap = await fetch('/api/photo-placement/capabilities', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!cap) throw new Error('Automatic placement runs in the Tiksi app on this Mac (the local server). It is not available here.');
  if (!cap.available) throw new Error((cap.reason || 'The placement helper is not installed.') + (cap.install ? ' Install it with: ' + cap.install : ''));
  const headers = { 'Content-Type': 'application/json', ...(cap.token ? { 'X-Tiksi-Token': cap.token } : {}) };
  const res = await fetch('/api/photo-placement' + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('the helper answered ' + res.status));
  return body;
}
async function photoForHelper(ph) {
  const buf = await photoBytes(ph.id);
  if (!buf) throw new Error('its original file is missing');
  const bmp = await createImageBitmap(new Blob([buf], { type: ph.mime || 'image/jpeg' }), { imageOrientation: 'from-image' });
  const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const lens = photoLens(ph), k = c.width / (ph.w || c.width);
  return { id: ph.id, name: ph.name, jpeg: btoa(bin), w: c.width, h: c.height, fx: lens.fx * k, fy: lens.fy * k, cx: lens.cx * k, cy: lens.cy * k, takenAt: ph.takenAt || null };
}
async function openAutoPlacement(ids) {
  const set = (prop.cameraSets || []).find(s => Object.keys(s.sessions || {}).length);
  if (!set) { toast('Import the Polycam cameras and LINE UP WITH THE MODEL first (SCAN CAMERAS, with nothing selected).', 'warn'); if (match) endMatch(); setSelection(null); return; }
  if (!set.exportPath) { toast('Fill in the Polycam folder on this Mac under SCAN CAMERAS, so the helper can read the scan frames.', 'warn'); if (match) endMatch(); setSelection(null); return; }
  const photos = ids.map(id => photoById(prop, id)).filter(p => p && p.kind === 'photo').slice(0, 50);
  if (!photos.length) return;
  const token = mountId;
  try {
    setHint('Preparing ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' for automatic placement…');
    const payload = [];
    for (const ph of photos) { try { await ensureCameraFacts(ph); payload.push(await photoForHelper(ph)); } catch (e) { toast('Skipped "' + ph.name + '": ' + e.message, 'warn'); } }
    const sessions = Object.fromEntries(Object.entries(set.sessions).map(([k, v]) => [k, v.matrix]));
    const job = await placementApi('/jobs', { method: 'POST', body: JSON.stringify({ exportDir: set.exportPath, sessions, photos: payload, options: { stride: 4 } }) });
    let state = job;
    while (!['done', 'failed', 'cancelled'].includes(state.status)) {
      await new Promise(r => setTimeout(r, 2000));
      if (token !== mountId) return;
      state = await placementApi('/jobs/' + encodeURIComponent(job.id));
      const p = state.progress || {};
      setHint('Automatic placement: ' + (p.stage || state.status) + (p.total ? ' (' + (p.done || 0) + ' of ' + p.total + ')' : '') + '…');
    }
    setHint('');
    if (state.status !== 'done') throw new Error(state.error || 'the helper stopped');
    autoUndo = [];
    let ok = 0;
    const failed = [];
    for (const r of state.results || []) {
      const ph = photoById(prop, r.id);
      if (!ph) continue;
      if (!r.ok) { failed.push(ph.name + ' (' + (r.reason || 'no match') + ')'); continue; }
      const pose = poseFromMatrix(r.pose);
      if (!pose) { failed.push(ph.name); continue; }
      autoUndo.push({ id: ph.id, view: ph.view ? JSON.parse(JSON.stringify(ph.view)) : null });
      ph.view = normalizeView({ ...viewFromPose(pose, hfovOfLens({ fx: r.fx, w: r.w })), from: 'auto', fit: { rmsPx: r.rmsPx, n: r.inliers } });
      buildCameraGlyph(ph);
      ok++;
    }
    touch(); renderInspector();
    toast('Placed ' + ok + ' of ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' automatically. Check each in PHOTO MODE.' + (failed.length ? ' Not placed: ' + failed.join('; ') + '.' : ''), ok ? 'ok' : 'warn', 15000);
  } catch (e) {
    setHint('');
    toast('Automatic placement: ' + e.message, 'error', 12000);
  }
}
function undoAutoPlacement() {
  for (const u of autoUndo) { const ph = photoById(prop, u.id); if (!ph) continue; if (u.view) ph.view = u.view; else delete ph.view; buildCameraGlyph(ph); }
  autoUndo = [];
  touch(); renderInspector();
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
// A note is a sticky note stuck flat on its surface, `size` metres wide (0.3 m unless set).
function notePlacement(note, aspect) {
  const width = note.size > 0 ? note.size : 0.3;
  const long = aspect >= 1 ? width : width / aspect;
  return sheetPlacement({ kind: 'note', w: aspect, h: 1, pin: { x: note.x, y: note.y, z: note.z, nx: note.nx, ny: note.ny, nz: note.nz, size: long, turn: note.turn, wall: note.wall } }, prop.walls);
}
function buildNote(note) {
  removeNote(note.id);
  const canvas = noteCanvas(note, !!(selection && selection.kind === 'note' && selection.id === note.id));
  const aspect = canvas.width / canvas.height;
  const place = notePlacement(note, aspect);
  if (!place) return;
  const group = new THREE.Group();
  group.userData = { kind: 'note', id: note.id };
  const sheet = sheetMesh(canvas, 'note', note.id);
  sheet.material.transparent = true;   // the folded corner and the shadow are see-through
  placeSheet(sheet, place);
  group.add(sheet);
  noteRoot.add(group);
  noteObjs[note.id] = { group, sprite: sheet, aspect, place,
    anchor: new THREE.Vector3(place.centre.x, place.centre.y, place.centre.z), normal: new THREE.Vector3(place.normal.x, place.normal.y, place.normal.z) };
  requestRender(2);
}
function redrawNoteCard(id) {
  const note = noteRoot && noteById(id), rec = noteObjs[id];
  if (!note || !rec) return;
  buildNote(note);
}
function removeNote(id) {
  const rec = noteObjs[id];
  if (!rec) return;
  noteRoot.remove(rec.group);
  rec.sprite.material.map.dispose(); rec.sprite.material.dispose(); rec.sprite.geometry.dispose();
  delete noteObjs[id];
}
function updateNotes() { /* flat notes sit still */ }
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
    delete moving.wall; delete moving.turn;
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
  const pin = surfacePin(hit, 0);
  const out = { x: pin.x, y: pin.y, z: pin.z, nx: pin.nx, ny: pin.ny, nz: pin.nz, wall: pin.wall, turn: pin.turn };
  if (!out.wall) delete out.wall;
  if (out.turn === undefined) delete out.turn;
  return out;
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
  popupMenu(at, items);
}
// A small menu at a screen point: items are [id, label, run] (no run: a line of text), or null for a rule.
function popupMenu(at, items) {
  closeContextMenu();
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
  // The photo being matched must not be covered by its own pin card (or its neighbours').
  if (pinRoot) pinRoot.visible = markersShown('pins') && !match;
  if (cameraRoot) cameraRoot.visible = markersShown('pins') && !match;
  if (positionRoot) positionRoot.visible = markersShown('pins') && !match;
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
  // The longest side a texture inside an imported model may have on this device.
  get textureLimit() { return memoryLimits().importedTextureSize; },
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
  // Still wanted? Asked once the bytes are here, before the costly parse: a visit that has ended
  // (another property, a remount after a save) stops there.
  try { obj = await loadScanObject(scan, hooks, () => token === mountId && !!scene); }
  catch (e) { if (token === mountId) setScanState(scan.id, 'failed'); throw e; }
  if (token !== mountId || !scene) { disposeScanObject(obj); return null; }
  if (!prop.scans.some(s => s.id === scan.id)) { disposeScanObject(obj); delete scanState[scan.id]; return null; }
  if (!obj) { setScanState(scan.id, 'missing'); return null; }
  if (scanObjs[scan.id]) { scanRoot.remove(scanObjs[scan.id]); disposeScanObject(scanObjs[scan.id]); }
  scanObjs[scan.id] = obj;
  applyScanTransform(scan, obj);
  // A model's parts get their tags the first time it loads (tags-scene.js); they are stored.
  const tagged = detectModelTags(prop, scan, obj);
  applyModelTagVisibility(prop, scan, obj);
  scanRoot.add(obj);
  // Large meshes and point clouds are tested through a tree of boxes (pick-index.js), built in
  // a background helper. A computer asks for it now, ahead of the first click; a touch device
  // only if a tool or a pinch ever needs it (a plain tap there tests markers only), so it
  // costs no memory until then.
  if (indexForPicking(obj) && !ownQuality()) buildPickIndexes(obj);
  setModelXray(obj, xray ? prop.env.xrayOpacity : null);
  fitShadow();
  applyEnvironment();
  applySection();
  updateOutlineTargets();
  setScanState(scan.id, 'ready');
  // New tags and counts show in the lists straight away.
  if (tagged) { touch(); renderToolCol(); if (!selection) renderInspector(); }
  requestRender(scan.kind === 'splat' ? 8 : 3);
  return obj;
}
// A scan is loaded the first time it is shown, never just because the page opened: a hidden
// scan (the other side of a before/after pair, say) costs no download, parse or memory until
// someone switches it on. One at a time, in list order. Call this after anything that can show
// a scan; scans already loaded, loading, missing or failed are left alone.
//
// `every` loads hidden scans too (they stay hidden): for work whose saved result is computed
// from every scan of the property, so that hiding one cannot change the answer.
//
// The queue belongs to one visit (mount resets it): a load left behind by the visit before, a
// download or parse that may never finish, must not hold up this one.
let scanQueue = Promise.resolve();
function loadShownScans() { return loadScans(false); }
function loadScans(every) {
  const token = mountId;
  for (const scan of prop.scans) if (scan.visible === false && !scanObjs[scan.id] && !scanState[scan.id]) scanState[scan.id] = 'hidden';
  const wanted = prop.scans.filter(scan => (every || scan.visible !== false) && !scanObjs[scan.id] && (!scanState[scan.id] || scanState[scan.id] === 'hidden'));
  // Marked now, so a second call before the queue reaches them does not queue them twice.
  for (const scan of wanted) setScanState(scan.id, 'loading');
  if (wanted.length) renderToolCol();
  scanQueue = scanQueue.then(async () => {
    for (const scan of wanted) {
      if (token !== mountId || !scene) return;
      // Deleted, or hidden again, while it waited its turn.
      if (!prop.scans.some(s => s.id === scan.id)) { delete scanState[scan.id]; continue; }
      if (!every && scan.visible === false) { setScanState(scan.id, 'hidden'); continue; }
      try { await addScanToScene(scan); }
      catch (e) { console.error(e); if (token === mountId) toast('Could not load scan ' + scan.name + ': ' + errMsg(e), 'error'); }
    }
    if (token === mountId && scene && wanted.length) renderToolCol();
  }).catch(e => console.error(e));
  return scanQueue;
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
    // The rooms are drawn; what stands in them is the next, optional step (never a modal
    // in the way of the plan the person is about to check).
    toast('Proposed: ' + proposalSummary(result, applied) + '.' + (applied && obj ? ' Next, optional: PROPOSE FIXTURES FROM SCAN in this scan\'s inspector.' : ''), applied && !result.review?.required ? 'ok' : 'warn', 8000);
  } catch (e) {
    console.error(e);
    if (token === mountId) toast('Could not propose a plan: ' + errMsg(e), 'error', 6000);
  } finally {
    planning = false;
    if (token === mountId) showProgress(null);
  }
}

// Counter runs, cabinets, appliances and furniture read from a mesh scan already in the
// scene, reviewed one by one before any is added.
let readingFixtures = false;
async function proposeFixturesFromScan(s) {
  const obj = scanObjs[s.id];
  if (readingFixtures || !obj) return;
  const token = mountId;
  readingFixtures = true;
  try {
    const proposals = await proposeFixtures(prop, s, hooks, obj);
    if (token !== mountId) return;
    showProgress(null);
    const added = await openFixtureReview(prop, proposals, { scanName: s.name });
    if (token !== mountId) return;
    rebuildModel(); renderInspector();
    if (added.length) toast('Added ' + added.length + ' fixture' + (added.length === 1 ? '' : 's') + ' from ' + s.name + '. Click one to edit it.', 'ok', 5000);
  } catch (e) {
    console.error(e);
    if (token === mountId) toast('Could not read fixtures: ' + errMsg(e), 'error', 6000);
  } finally {
    readingFixtures = false;
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
  if (tool === 'pin') return 'PIN: choose a photo or document, then click the surface to hang it on.';
  if (tool === 'note') return noteHint();
  if (tool === 'move') return 'MOVE WALLS: select a wall, drag the gizmo arrow to slide it; connected walls follow on release.';
  if (section.on) return fieldLayout() || !sectionSheets ? 'SECTION: slide the cut to look inside.' : 'SECTION: drag the arrow to slide the cut, a ring to turn it. SNAP holds it to ' + TURN_SNAP_DEG + '° turns and ' + (units() === 'metric' ? '5 cm' : '1"') + ' steps.';
  return 'Drag or middle-drag to orbit, hold Shift to pan, scroll or pinch to zoom. Click elements to inspect; right-click to pin a note.';
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
  bar.innerHTML = `
    <button class="v-pill ${mode === 'orbit' ? 'active' : ''}" data-mode="orbit" title="Orbit (O)">ORBIT</button>
    <button class="v-pill ${mode === 'walk' ? 'active' : ''}" data-mode="walk" title="Walk through (W)">WALK</button>
    <button class="v-pill ${mode === 'top' ? 'active' : ''}" data-mode="top" title="Top, north up (T)">TOP</button>
    <span class="v-pill-sep"></span>
    <button class="v-pill ${section.on ? 'active' : ''}" data-section title="Section cuts (C)">SECTION</button>
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
  renderSectionBar();
  setHint('');
}
// The strip of section controls, over the bottom of the view whenever the cut is on (the mode
// bar may be off the screen): the planes, the four ways to add one, and the active plane's
// position, direction, snapping and removal.
function sliderSpan(s) {
  const r = sectionRange(s), step = sectionSnap ? moveSnapStep(units()) : 0.01;
  // A range input steps from its minimum: start on a whole step so snapped stops are whole too.
  return { min: Math.floor(r.min / step) * step, max: Math.ceil(r.max / step) * step, step };
}
function renderSectionBar() {
  const bar = hud.sections;
  if (!bar) return;
  bar.hidden = !section.on;
  if (!section.on) { bar.innerHTML = ''; return; }
  const short = { level: 'UP/DOWN', side: 'SIDE', front: 'FRONT', custom: 'CUSTOM' };
  const s = activeSection();
  const chips = section.planes.map((x, i) => `<button class="v-pill ${x.id === section.active ? 'active' : ''}" data-cut="${escapeHtml(x.id)}" aria-pressed="${x.id === section.active}" title="Section cut ${i + 1}: show its handles">${i + 1} ${short[x.kind]}</button>`).join('');
  const adds = SECTION_KINDS.map(k => `<button class="v-pill" data-cut-add="${k}" title="${escapeHtml({ level: 'Add a flat cut that slides up and down', side: 'Add an upright cut that slides side to side', front: 'Add an upright cut that slides front to back', custom: 'Add an upright cut facing you; turn it to any angle with the rings' }[k])}">+ ${SECTION_LABELS[k]}</button>`).join('');
  let row = '';
  if (s) {
    const sp = sliderSpan(s), r = sectionReadout(s);
    row = `<div class="v-sec-row">
      <input type="range" class="v-section-range" min="${sp.min}" max="${sp.max}" step="${sp.step}" value="${r.d}" aria-label="Position of the cut" title="${r.flat ? 'Cut height (world elevation)' : 'Position of the cut, measured in from the face of the model'}">
      <span class="v-section-val">${escapeHtml(r.label)}</span>
      <span class="v-section-ang">${escapeHtml(r.angle)}</span>
      <span class="v-pill-sep"></span>
      <button class="v-pill" data-cut-flip title="Cut away the other side">FLIP</button>
      <button class="v-pill ${sectionSnap ? 'active' : ''}" data-cut-snap aria-pressed="${sectionSnap}" title="Snap: turns in ${TURN_SNAP_DEG}° steps, slides in ${units() === 'metric' ? '5 cm' : '1 inch'} steps">SNAP</button>
      <button class="v-pill ${sectionSheets ? 'active' : ''}" data-cut-sheets aria-pressed="${sectionSheets}" title="Show the floating planes and their handles">PLANES</button>
      <button class="v-pill" data-cut-remove title="Remove this cut">REMOVE</button>
    </div>`;
  }
  bar.innerHTML = `<div class="v-sec-row">${chips}<span class="v-pill-sep"></span>${adds}</div>${row}`;
  bar.querySelectorAll('[data-cut]').forEach(b => b.onclick = () => selectSection(b.dataset.cut));
  bar.querySelectorAll('[data-cut-add]').forEach(b => b.onclick = () => addSection(b.dataset.cutAdd));
  const on = (sel, fn) => { const b = bar.querySelector(sel); if (b) b.onclick = fn; };
  on('[data-cut-flip]', flipSection);
  on('[data-cut-snap]', () => setSectionSnap(!sectionSnap));
  on('[data-cut-sheets]', () => setSectionSheets(!sectionSheets));
  on('[data-cut-remove]', () => removeSection(section.active));
  const range = bar.querySelector('.v-section-range');
  if (range) range.oninput = () => { slideSection(parseFloat(range.value)); updateSectionReadout(true); };
}
// While a plane is dragged or slid only its numbers change; the bar is not rebuilt under the pointer.
function updateSectionReadout(fromSlider) {
  const bar = hud.sections, s = activeSection();
  if (!bar || !s) return;
  const r = sectionReadout(s);
  const val = bar.querySelector('.v-section-val'), ang = bar.querySelector('.v-section-ang'), range = bar.querySelector('.v-section-range');
  if (val) val.textContent = r.label;
  if (ang) ang.textContent = r.angle;
  if (range && !fromSlider) {
    const sp = sliderSpan(s);
    range.min = sp.min; range.max = sp.max; range.value = r.d;
  }
}
function toggleSection() {
  section.on = !section.on;
  if (section.on && !section.planes.length) {
    // The first cut: flat, at waist height on the lowest level.
    const s = newSection('level');
    section.planes.push(s); section.active = s.id;
  }
  if (section.on && !activeSection()) section.active = section.planes[0].id;
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
  invalidateShadows();
  applySection();
  requestRender(3);
}
function toggleXray() { xray = !xray; applyXray(); renderHud(); renderToolCol(); }
// TAGS: hiding a tag hides every object on it, in the plan model and in imported models.
function applyTagVisibility() {
  if (modelGroup) applyPlanTagVisibility(prop, modelGroup);
  for (const s of prop.scans) if (scanObjs[s.id]) applyModelTagVisibility(prop, s, scanObjs[s.id]);
  invalidateShadows();
  fitShadow(); applyEnvironment(); updateOutlineTargets();
  requestRender(3);
}
function tagsChanged() { applyTagVisibility(); renderToolCol(); renderInspector(); touch(); }
function toggleTag(id) {
  if (id && !tagById(prop, id)) return;
  setTagShown(prop, id, !tagShown(prop, id));
  tagsChanged();
}
function moveToTag(keys, tagId) {
  if (!keys.length) return;
  if (tagId === '__new') {
    const name = prompt('Name of the new tag');
    if (!name || !name.trim()) { renderInspector(); return; }
    tagId = addTag(prop, name).id;
  }
  assignTag(prop, keys, tagId);
  tagsChanged();
  toast(keys.length + (keys.length === 1 ? ' object' : ' objects') + ' moved to ' + (tagId ? tagById(prop, tagId).name : UNTAGGED_LABEL) + '.', 'ok');
}

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
      <div class="v-row v-row-sel"><span>${ownQuality() ? 'QUALITY ON THIS DEVICE' : 'QUALITY'}</span>
        <select data-env="quality"><option value="ultra" ${quality() === 'ultra' ? 'selected' : ''}>Ultra (detail + 32-sample AO)</option><option value="high" ${quality() === 'high' ? 'selected' : ''}>High (AO + bloom)</option><option value="medium" ${quality() === 'medium' ? 'selected' : ''}>Medium</option><option value="low" ${quality() === 'low' ? 'selected' : ''}>Low</option></select>
      </div>
      ${ownQuality() ? '<p class="v-env-help">Kept on this device only. Computers keep the quality saved with the property.</p>' : ''}
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
      // A touch device's quality is its own: kept in this browser, never saved with the property.
      const onPhone = s.dataset.env === 'quality' && ownQuality();
      if (onPhone) setDeviceQuality(s.value);
      else env[s.dataset.env] = s.value || null;
      if (s.dataset.env === 'quality') { applyTextureLimits(); rebuildModel(); applyQuality(); }
      if (s.dataset.env === 'sky') rebuildGround();
      if (s.dataset.env === 'panoPhotoId') panoMissing = null;   // a fresh choice gets a fresh try
      applyEnvironment();
      if (!onPhone) touch();
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

function setDeviceQuality(name) {
  if (!QUALITY_NAMES.includes(name)) return;
  unsavedDeviceQuality = chooseDeviceQuality(browserStorage(), name) ? null : name;
}

export function mountEnvironmentSettings(host) {
  // MODEL with no property yet has nothing to set (and FILE must still open to add one).
  if (!prop || !scene) { host.innerHTML = '<p class="muted">Add a property to set its model environment.</p>'; return; }
  host.className='v-env open file-env';
  renderEnvPanel(host);
}

// ---------- inspector ----------
// Numbers from saved data go into attributes: anything that is not a finite number becomes the fallback.
function finiteNum(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function scopeAssignHtml(elementId) {
  let current = '';
  for (const pr of propertyProjects()) for (const it of pr.items) if ((it.elementIds || []).includes(elementId)) current = it.id;
  const groups = propertyProjects().map(pr => {
    const opts = pr.items.map(it => `<option value="${escapeHtml(it.id)}" ${it.id === current ? 'selected' : ''}>${escapeHtml(it.name)}</option>`).join('');
    return opts ? `<optgroup label="${escapeHtml(projectLabel(pr))}">${opts}</optgroup>` : '';
  }).join('');
  return `<div class="field"><label>Scope item (digital twin link)</label>
    <select data-assign="${escapeHtml(elementId)}"><option value="">(not assigned)</option>${groups}</select></div>`;
}
function linkedProductsHtml(elementId) {
  const linked = [];
  for (const pr of propertyProjects()) for (const it of pr.items) {
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
  return `<h3 style="margin-top:14px">PINNED PHOTOS AND DOCUMENTS</h3>` + pinned.map(ph => `
    <div class="v-pin-row">
      <img src="${escapeHtml(ph.thumb)}" alt="">
      <span class="v-pin-name">${escapeHtml(ph.name)}</span>
      <button class="btn small" data-locate="${escapeHtml(ph.id)}" title="Fly to pin">LOCATE</button>
      ${ph.kind === 'pano' || ph.kind === 'document' ? '' : `<button class="btn small" data-match="${escapeHtml(ph.id)}" title="Stand where the photo was taken, with the photo over the model">PHOTO</button>`}
      <button class="btn small danger" data-unpin="${escapeHtml(ph.id)}" title="Remove pin">&times;</button>
    </div>`).join('');
}
function bindPinsList(root) {
  root.querySelectorAll('[data-locate]').forEach(b => b.onclick = () => { setSelection({ kind: 'pin', id: b.dataset.locate }); flyToPin(b.dataset.locate); });
  root.querySelectorAll('[data-unpin]').forEach(b => b.onclick = () => unpin(b.dataset.unpin));
  root.querySelectorAll('[data-match]').forEach(b => b.onclick = () => startMatch(b.dataset.match));
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
  inspEl.innerHTML = `<h3>PIN A PHOTO OR DOCUMENT</h3>
    ${cur ? `<div class="v-thumb big active"><img src="${escapeHtml(cur.thumb)}" alt=""></div>
      <div class="stat-line"><span>Placing</span><b>${escapeHtml(cur.name)}</b></div>` : ''}
    ${total ? `<div class="stat-line"><span>Pinned</span><b>${placed} of ${total}</b></div>` : ''}
    <div class="empty">Click the wall, floor or scan surface to hang it on. It lies flat there like a print you put up, links to the room and wall, and moves with the wall${pinBatch ? '; then the next unpinned one comes up' : ''}. Where a photo was taken from is set separately, in PHOTO MODE. Pick another below to place it instead.</div>
    <div class="v-thumbs">${prop.photos.map(ph => `<button class="v-thumb ${ph.id === pinPhotoId ? 'active' : ''}" data-pick="${escapeHtml(ph.id)}" title="${escapeHtml(ph.name)}"><img src="${escapeHtml(ph.thumb)}" alt="">${ph.pin ? '<i class="v-pinned">PINNED</i>' : ''}</button>`).join('')}</div>
    ${total ? '' : '<div class="empty" style="margin-top:8px">No photos on this property yet.</div>'}
    <button class="btn primary" data-add>ADD PHOTOS</button>
    <input type="file" class="hidden-file" accept="image/*" multiple data-photo-file>
    <button class="btn" data-add-doc title="Shop drawings, spec sheets, schedules: PDFs or images of sheets">ADD DOCUMENTS</button>
    <input type="file" class="hidden-file" accept="application/pdf,.pdf,image/*" multiple data-doc-file>
    <button class="btn" data-cancel>${placed ? 'DONE' : 'CANCEL'}</button>`;
  inspEl.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    pinPhotoId = b.dataset.pick;
    const ph = photoById(prop, pinPhotoId);
    pinBatch = !!(ph && !ph.pin);
    renderPinPanel(); setHint(pinHint());
  });
  const file = inspEl.querySelector('[data-photo-file]'), docFile = inspEl.querySelector('[data-doc-file]');
  inspEl.querySelector('[data-add]').onclick = () => file.click();
  inspEl.querySelector('[data-add-doc]').onclick = () => docFile.click();
  docFile.onchange = async () => {
    const files = Array.from(docFile.files || []);
    docFile.value = '';
    let first = null;
    for (const f of files) {
      try { setHint('Reading ' + f.name + '…'); const rec = await addDocumentFromFile(prop, f); first = first || rec; }
      catch (e) { toast('Could not add ' + f.name + ': ' + e.message, 'error'); }
    }
    if (first) { pinPhotoId = first.id; pinBatch = true; }
    if (tool === 'pin') { renderPinPanel(); setHint(pinHint()); }
  };
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
  renderInspectorBody();
  if (!inspEl || tool === 'pin' || match) return;
  const sec = document.createElement('div');
  sec.className = 'v-tags';
  if (!selection) { sec.innerHTML = tagManagerHtml(); bindTagManager(sec); inspEl.prepend(sec); }
  else if (tagPicks.length || selection.kind === 'scan') {
    sec.innerHTML = tagPickHtml(); bindTagPick(sec);
    const h = inspEl.querySelector('h3');
    if (h) h.after(sec); else inspEl.prepend(sec);
  }
}
function tagOptions(current, { mixed = false, extra = '' } = {}) {
  return (mixed ? '<option value="__mixed" selected>(several tags)</option>' : '') + extra +
    `<option value="" ${!mixed && !current ? 'selected' : ''}>${UNTAGGED_LABEL}</option>` +
    prop.tags.map(t => `<option value="${escapeHtml(t.id)}" ${!mixed && current === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('') +
    '<option value="__new">New tag...</option>';
}
// The selected objects' tag: one select moves them all.
function tagPickHtml() {
  const s = selection.kind === 'scan' ? prop.scans.find(x => x.id === selection.id) : null;
  const ids = tagPicks.map(k => tagIdOf(prop, k) || UNTAGGED);
  const mixed = new Set(ids).size > 1;
  const one = tagPicks.length === 1 ? tagPicks[0] : null;
  const part = one && s && scanObjs[s.id] ? partByKey(scanObjs[s.id], one) : null;
  const comp = part ? partComponentName(scanObjs[s.id], part.object) : '';
  const what = tagPicks.length > 1 ? tagPicks.length + ' objects selected' : part ? 'Part: ' + partName(part) + (comp && comp !== partName(part) ? ' (component ' + comp + ')' : '') : '';
  return `${what ? `<div class="stat-line"><span>${escapeHtml(what)}</span><b></b></div>` : ''}
    ${tagPicks.length ? `<div class="field"><label>Tag${tagPicks.length > 1 ? ' (moves all ' + tagPicks.length + ')' : ''}</label><select data-tag-pick title="Shift-click more objects to move several at once">${tagOptions(ids[0], { mixed })}</select></div>` : ''}
    ${s && scanObjs[s.id] ? `<button class="btn" data-tag-detect title="Give every part of this model its automatic tag again: the file's own tags, then part names, then shape. Parts you moved to a tag yourself are moved back.">DETECT TAGS AGAIN</button>` : ''}
    ${s && scanObjs[s.id] ? `<div class="field"><label>Tag every part of this model</label><select data-tag-model>${tagOptions('', { extra: '<option value="__keep" selected>(choose a tag)</option>' }).replace(`<option value="" selected>`, '<option value="">')}</select></div>` : ''}
    <div class="empty" style="margin:0 0 8px">Shift-click adds objects to the selection.</div>`;
}
function bindTagPick(root) {
  const pick = root.querySelector('[data-tag-pick]');
  if (pick) pick.onchange = () => { if (pick.value !== '__mixed') moveToTag(tagPicks.slice(), pick.value); };
  const again = root.querySelector('[data-tag-detect]');
  if (again) again.onclick = () => {
    const s = prop.scans.find(x => x.id === selection.id), obj = s && scanObjs[s.id];
    if (!obj) return;
    const n = detectModelTags(prop, s, obj, { again: true });
    tagsChanged();
    toast(n + (n === 1 ? ' part' : ' parts') + ' of ' + s.name + ' tagged again.', 'ok');
  };
  const all = root.querySelector('[data-tag-model]');
  if (all) all.onchange = () => {
    if (all.value === '__keep') return;
    const keys = Object.keys(prop.tagOf).filter(k => k.startsWith('node:' + selection.id + '#'));
    moveToTag(keys, all.value);
  };
}
// TAGS, with nothing selected: rename, recolour, show or hide, add and delete tags.
function tagManagerHtml() {
  const counts = tagCounts(prop);
  const row = t => `<div class="v-tag-row" data-tag-row="${escapeHtml(t.id)}">
      <button class="v-tag-eye ${t.visible !== false ? 'on' : ''}" data-tag-eye="${escapeHtml(t.id)}" aria-pressed="${t.visible !== false}" title="${t.visible !== false ? 'Hide' : 'Show'} ${escapeHtml(t.name)}">${icon(t.visible !== false ? 'eye' : 'eye-off')}</button>
      <input type="color" data-tag-color="${escapeHtml(t.id)}" value="${escapeHtml(t.color)}" title="Colour">
      <input type="text" data-tag-name="${escapeHtml(t.id)}" value="${escapeHtml(t.name)}" aria-label="Tag name" maxlength="80">
      <span class="v-tag-n" title="Objects on this tag">${counts.get(t.id) || 0}</span>
      <button class="v-tag-del" data-tag-del="${escapeHtml(t.id)}" title="Delete ${escapeHtml(t.name)}; its objects move to Untagged">${icon('close')}</button>
    </div>`;
  const un = prop.tagUntaggedVisible !== false;
  return `<h3>TAGS</h3>
    ${prop.tags.map(row).join('')}
    <div class="v-tag-row" data-tag-row="">
      <button class="v-tag-eye ${un ? 'on' : ''}" data-tag-eye="" aria-pressed="${un}" title="${un ? 'Hide' : 'Show'} objects with no tag">${icon(un ? 'eye' : 'eye-off')}</button>
      <span class="v-tag-swatch"></span><span class="v-tag-label">${UNTAGGED_LABEL}</span>
      <span class="v-tag-n">${counts.get(UNTAGGED) || 0}</span><span></span>
    </div>
    <div class="v-tag-add"><input type="text" data-tag-new placeholder="New tag name" maxlength="80"><button class="btn" data-tag-add>ADD TAG</button></div>
    <div class="empty" style="margin:0 0 10px">Every wall, floor, ceiling, opening, fixture and part of an imported model sits on a tag. Click an object to see or change its tag; Shift-click to move several at once.</div>
    <div class="tool-sep"></div>`;
}
function bindTagManager(root) {
  root.querySelectorAll('[data-tag-eye]').forEach(b => b.onclick = () => toggleTag(b.dataset.tagEye));
  root.querySelectorAll('[data-tag-color]').forEach(i => i.onchange = () => { if (setTagColor(prop, i.dataset.tagColor, i.value)) { renderToolCol(); touch(); } });
  root.querySelectorAll('[data-tag-name]').forEach(i => i.onchange = () => { renameTag(prop, i.dataset.tagName, i.value); renderToolCol(); renderInspector(); touch(); });
  root.querySelectorAll('[data-tag-del]').forEach(b => b.onclick = () => {
    const t = tagById(prop, b.dataset.tagDel); if (!t) return;
    const n = keysOnTag(prop, t.id).length;
    if (n && !confirm('Delete the tag "' + t.name + '"? Its ' + n + (n === 1 ? ' object moves' : ' objects move') + ' to Untagged.')) return;
    deleteTag(prop, t.id);
    tagsChanged();
  });
  const add = () => { const i = root.querySelector('[data-tag-new]'); if (!i.value.trim()) return; addTag(prop, i.value); tagsChanged(); };
  root.querySelector('[data-tag-add]').onclick = add;
  root.querySelector('[data-tag-new]').onkeydown = e => { if (e.key === 'Enter') add(); };
}
function renderInspectorBody() {
  if (!inspEl) return;
  if (tool === 'pin') return renderPinPanel();
  if (match) return renderMatchPanel();
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
      <div class="stat-line"><span>Fixtures</span><b>${(prop.fixtures || []).length}</b></div>
      <div class="stat-line"><span>Scans</span><b>${prop.scans.length}</b></div>
      <div class="stat-line"><span>Photos</span><b>${prop.photos.length}</b></div>
      <div class="stat-line"><span>Notes</span><b>${prop.notePins.length}</b></div>
      <div class="empty" style="margin-top:12px">
        Click a wall, door, window or floor to inspect and edit it. The model regenerates from the plan; edits here write back to the same data. Right-click anywhere on the model to pin a note.</div>
      ${addFixtureHtml()}
      ${pinsListHtml()}
      ${positionsListHtml()}
      ${notesListHtml()}
      ${camerasPanelHtml()}
      ${autoUndo.length ? `<button class="btn" data-auto-undo>UNDO AUTOMATIC PLACEMENT (${autoUndo.length})</button>` : ''}`;
    bindPinsList(inspEl);
    bindPositionsList(inspEl);
    bindNotesList(inspEl);
    bindCamerasPanel(inspEl);
    const au = inspEl.querySelector('[data-auto-undo]');
    if (au) au.onclick = undoAutoPlacement;
    inspEl.querySelector('[data-fx-add]').onclick = () => {
      const [kind, subtype] = inspEl.querySelector('[data-fx-kind]').value.split(':');
      const t = controls.target, lvl = levelAtHeight(t.y);
      // A new piece is seen: its tag is shown if it was hidden.
      const onTag = prop.tagDefaults[kind === 'furniture' ? 'furniture' : 'fixture'];
      if (onTag && !tagShown(prop, onTag)) { setTagShown(prop, onTag, true); renderToolCol(); }
      const f = addFixture(prop, kind, subtype, { level: lvl.id, x: Math.round(t.x * 100) / 100, y: Math.round(t.z * 100) / 100 });
      rebuildModel();
      setSelection({ kind: 'fixture', id: f.id });
    };
    return;
  }
  if (selection.kind === 'fixture') {
    const f = (prop.fixtures || []).find(x => x.id === selection.id);
    if (!f) { selection = null; tagPicks = []; return renderInspectorBody(); }
    inspEl.innerHTML = fixtureInspectorHtml(prop, f);
    bindFixtureInspector(inspEl, prop, f, { changed: () => { rebuildModel(); renderInspector(); }, deleted: () => { setSelection(null); rebuildModel(); } });
    return;
  }
  if (selection.kind === 'wall') {
    const w = prop.walls.find(w => w.id === selection.id);
    if (!w) { selection = null; tagPicks = []; return renderInspectorBody(); }
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
      const v = parseLen(e.target.value, 'feet');
      if (!isNaN(v) && v > 0.02 && v < 1) { beginGeometryEdit(prop, 'change wall thickness'); w.thickness = v; touch(); rebuildModel(); }
      renderInspector();
    };
    inspEl.querySelector('[data-h]').onchange = e => {
      beginGeometryEdit(prop, 'change wall height');
      if (!e.target.value.trim()) w.height = null;
      else { const v = parseLen(e.target.value, 'feet'); if (!isNaN(v) && v > 0.3) w.height = v; }
      touch(); rebuildModel(); renderInspector();
    };
    inspEl.querySelector('[data-mat]').onchange = e => { beginGeometryEdit(prop, 'change wall material'); w.material = e.target.value || null; touch(); rebuildModel(); };
    // Room-facing faces only; blank = automatic (drywall on exterior walls, the wall material otherwise).
    inspEl.querySelector('[data-matin]').onchange = e => { beginGeometryEdit(prop, 'change interior finish'); w.materialIn = e.target.value || null; touch(); rebuildModel(); };
    inspEl.querySelector('[data-walk]').onclick = () => setMode('walk');
    inspEl.querySelector('[data-del]').onclick = () => {
      beginGeometryEdit(prop, 'delete wall');
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
    if (!o) { selection = null; tagPicks = []; return renderInspectorBody(); }
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
    const num = (sel, fn, min) => { inspEl.querySelector(sel).onchange = e => { const v = parseLen(e.target.value, 'feet'); if (!isNaN(v) && v > (min || 0.05)) { beginGeometryEdit(prop, 'edit opening'); fn(v); touch(); rebuildModel(); } renderInspector(); }; };
    num('[data-w]', v => o.width = v, 0.2);
    num('[data-hh]', v => o.height = v, 0.3);
    if (o.type === 'window') num('[data-s]', v => o.sill = v, -0.001);
    inspEl.querySelector('[data-type]').onchange = e => {
      beginGeometryEdit(prop, 'change opening type');
      o.type = e.target.value;
      if (o.type === 'window' && o.sill == null) o.sill = 0.762;
      touch(); rebuildModel(); renderInspector();
    };
    let slidingOpening = false;
    inspEl.querySelector('[data-t]').oninput = e => { if (!slidingOpening) { beginGeometryEdit(prop, 'move opening'); slidingOpening = true; } o.t = parseFloat(e.target.value); rebuildModel(); };
    inspEl.querySelector('[data-t]').onchange = () => { slidingOpening = false; touch(); };
    inspEl.querySelector('[data-wall]').onclick = () => setSelection({ kind: 'wall', id: o.wallId });
    inspEl.querySelector('[data-del]').onclick = () => { beginGeometryEdit(prop, 'delete opening'); prop.openings = prop.openings.filter(x => x.id !== o.id); setSelection(null); touch(); rebuildModel(); };
    bindResearchActions(inspEl);
    return;
  }
  if (selection.kind === 'room') {
    const r = prop.rooms.find(r => r.id === selection.id);
    if (!r) { selection = null; tagPicks = []; return renderInspectorBody(); }
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
    inspEl.querySelector('[data-name]').onchange = e => { beginGeometryEdit(prop, 'rename room'); r.name = e.target.value; touch(); };
    inspEl.querySelector('[data-mat]').onchange = e => { beginGeometryEdit(prop, 'change floor material'); r.material = e.target.value || null; touch(); rebuildModel(); };
    inspEl.querySelector('[data-cmat]').onchange = e => { beginGeometryEdit(prop, 'change ceiling material'); r.ceilingMaterial = e.target.value || null; touch(); rebuildModel(); };
    inspEl.querySelector('[data-walk]').onclick = () => setMode('walk');
    bindAssign(inspEl); bindPhotoLinks(inspEl); bindResearchActions(inspEl);
    return;
  }
  if (selection.kind === 'pin') {
    const ph = photoById(prop, selection.id);
    if (!ph || !ph.pin) { selection = null; tagPicks = []; return renderInspectorBody(); }
    const isDoc = ph.kind === 'document';
    const size = ph.pin.size;
    const printOpts = PRINT_SIZES.map(x => `<option value="${x.long}" ${Math.abs(x.long - (size || DEFAULT_PRINT)) < 1e-3 ? 'selected' : ''}>${escapeHtml(x.label)}</option>`).join('');
    const scaleOpts = [[0.5, 'Half size'], [1, 'True size'], [2, 'Twice true size'], [4, 'Four times true size']].map(([k, l]) => `<option value="${k}" ${Math.abs(k - (size || 1)) < 1e-3 ? 'selected' : ''}>${l}</option>`).join('');
    const sheet = pinObjs[ph.id] && pinObjs[ph.id].place;
    const pos = ph.positionId && (prop.photoPositions || []).find(x => x.id === ph.positionId);
    inspEl.innerHTML = `<h3>${isDoc ? 'PINNED DOCUMENT' : 'PINNED PHOTO'}</h3>
      <button class="v-thumb big" data-open><img src="${escapeHtml(ph.thumb)}" alt=""></button>
      <div class="stat-line"><span>${escapeHtml(ph.name)}</span><b>${isDoc ? (ph.pageCount > 1 ? 'page ' + ph.page + ' of ' + ph.pageCount : '') : finiteNum(ph.w, '?') + ' x ' + finiteNum(ph.h, '?')}</b></div>
      ${sheet ? `<div class="stat-line"><span>On the ${sheet.onWall ? 'wall' : 'surface'}</span><b>${escapeHtml(fmtLen(sheet.w))} x ${escapeHtml(fmtLen(sheet.h))}</b></div>` : ''}
      ${isDoc ? `<div class="field"><label>Size</label><select data-scale>${scaleOpts}</select></div>
        ${ph.pageCount > 1 ? `<div class="seg fill"><button class="seg-btn" data-page="-1" ${ph.page <= 1 ? 'disabled' : ''}>PREVIOUS PAGE</button><button class="seg-btn" data-page="1" ${ph.page >= ph.pageCount ? 'disabled' : ''}>NEXT PAGE</button></div>` : ''}`
        : `<div class="field"><label>Print size</label><select data-print>${printOpts}</select></div>`}
      <div class="field"><label>Notes</label><textarea data-notes>${escapeHtml(ph.notes || '')}</textarea></div>
      ${isDoc || ph.kind === 'pano' ? '' : `<div class="stat-line"><span>Camera</span><b>${escapeHtml(cameraLabel(ph))}</b></div>
        ${pos ? `<div class="stat-line"><span>Numbered position</span><b>${escapeHtml(positionLabel(pos))}</b></div>` : ''}`}
      ${isDoc ? `<button class="btn primary" data-read>READ IT</button><button class="btn" data-open2>OPEN ${isPdfDocument(ph) ? 'THE PDF' : 'FULL SIZE'}</button>`
        : `<button class="btn" data-open2>OPEN FULL SIZE</button>
      ${ph.kind === 'pano' ? '' : `<button class="btn primary" data-match title="Stand where the photo was taken and see the photo over the model">PHOTO MODE</button>
      ${pos ? '' : `<button class="btn" data-makepos title="Keep this camera as a numbered position for before, rendering and after pictures"${cameraFound(ph) ? '' : ' disabled'}>MAKE NUMBERED POSITION</button>`}`}`}
      <button class="btn" data-turn>TURN A QUARTER</button>
      <button class="btn" data-locate>LOCATE</button>
      <button class="btn" data-move>MOVE PIN</button>
      <button class="btn danger" data-unpin>REMOVE PIN</button>`;
    inspEl.querySelector('[data-open]').onclick = () => openPinned(ph);
    inspEl.querySelector('[data-open2]').onclick = () => openPinned(ph);
    inspEl.querySelector('[data-notes]').onchange = e => { ph.notes = e.target.value; touch(); };
    const sel = inspEl.querySelector('[data-print]') || inspEl.querySelector('[data-scale]');
    sel.onchange = () => { ph.pin.size = parseFloat(sel.value); touch(); buildPin(ph); renderInspector(); };
    inspEl.querySelectorAll('[data-page]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await setDocumentPage(ph, (ph.page || 1) + Number(b.dataset.page)); buildPin(ph); renderInspector(); }
      catch (e) { toast('Could not show that page: ' + e.message, 'error'); }
    });
    inspEl.querySelector('[data-turn]').onclick = () => {
      const floor = Math.abs(ph.pin.ny) > 0.5;
      ph.pin.turn = floor ? ((ph.pin.turn || 0) + 90) % 360 : ((ph.pin.turn || 0) + 1) % 4;
      touch(); buildPin(ph); requestRender(2);
    };
    const rd = inspEl.querySelector('[data-read]');
    if (rd) rd.onclick = () => flyToSheet(ph.id);
    inspEl.querySelector('[data-locate]').onclick = () => flyToPin(ph.id);
    inspEl.querySelector('[data-move]').onclick = () => startPinMode(ph.id);
    const mb = inspEl.querySelector('[data-match]'), mp = inspEl.querySelector('[data-makepos]');
    if (mb) mb.onclick = () => startMatch(ph.id);
    if (mp) mp.onclick = () => makePositionFrom(ph.id);
    inspEl.querySelector('[data-unpin]').onclick = () => unpin(ph.id);
    return;
  }
  if (selection.kind === 'position') {
    const pos = (prop.photoPositions || []).find(x => x.id === selection.id);
    if (!pos) { selection = null; tagPicks = []; return renderInspectorBody(); }
    const pics = picturesOf(prop, pos.id);
    const strip = role => pics[role].length ? `<div class="field"><label>${ROLE_LABELS[role]} (${pics[role].length})</label><div class="v-thumbs small">${pics[role].map(ph =>
      `<button class="v-thumb" data-open-photo="${escapeHtml(ph.id)}" title="${escapeHtml(ph.name)}"><img src="${escapeHtml(ph.thumb)}" alt=""></button>`).join('')}</div></div>` : '';
    const room = pos.roomId && prop.rooms.find(r => r.id === pos.roomId);
    inspEl.innerHTML = `<h3>PHOTO POSITION ${pos.number}</h3>
      <div class="field"><label>Name</label><input type="text" data-name value="${escapeHtml(pos.name || '')}" placeholder="e.g. Kitchen from the door"></div>
      ${room ? `<div class="stat-line"><span>Room</span><b>${escapeHtml(room.name || '')}</b></div>` : ''}
      <div class="stat-line"><span>Lens</span><b>${Math.round(pos.view.fov)}&deg; across</b></div>
      ${strip('before')}${strip('rendering')}${strip('after')}
      ${pics.before.length + pics.rendering.length + pics.after.length ? '' : '<div class="empty">No pictures yet.</div>'}
      <button class="btn primary" data-view>VIEW FROM HERE</button>
      <button class="btn" data-render>RENDER THIS POSITION</button>
      <button class="btn" data-after>ADD AFTER PHOTO</button>
      <input type="file" class="hidden-file" accept="image/*" data-after-file>
      <button class="btn danger" data-del>REMOVE POSITION</button>`;
    inspEl.querySelector('[data-name]').onchange = e => { pos.name = e.target.value.trim(); touch(); buildPositionMarker(pos); };
    inspEl.querySelector('[data-view]').onclick = () => viewFromPosition(pos.id);
    inspEl.querySelector('[data-render]').onclick = () => renderPositions([pos.id]);
    const af = inspEl.querySelector('[data-after-file]');
    inspEl.querySelector('[data-after]').onclick = () => af.click();
    af.onchange = async () => {
      const f = af.files && af.files[0]; af.value = '';
      if (!f) return;
      try {
        const rec = await addPhotoFromFile(prop, f, { positionId: pos.id, role: 'after', view: { ...pos.view, from: 'position' } });
        buildCameraGlyph(rec); renderInspector();
        toast('After photo added to position ' + pos.number + '. Use PHOTO MODE on it to check it lines up.', 'ok');
      } catch (e) { toast('Could not add ' + f.name + ': ' + e.message, 'error'); }
    };
    inspEl.querySelector('[data-del]').onclick = () => {
      removePosition(prop, pos.id); removePositionMarker(pos.id); touch(); setSelection(null);
      toast('Position ' + pos.number + ' removed; its pictures stay in the photo library. Its number is not given out again.', 'ok');
    };
    bindPhotoLinks(inspEl);
    return;
  }
  if (selection.kind === 'note') {
    const n = noteById(selection.id);
    if (!n) { selection = null; tagPicks = []; return renderInspectorBody(); }
    const where = noteWhere(n), added = new Date(n.createdAt);
    inspEl.innerHTML = `<h3>NOTE</h3>
      <div class="field"><label>Text</label><textarea data-text rows="5" maxlength="2000">${escapeHtml(n.text || '')}</textarea></div>
      ${where ? `<div class="stat-line"><span>Room</span><b>${escapeHtml(where)}</b></div>` : ''}
      ${Number.isFinite(added.getTime()) && added.getTime() > 0 ? `<div class="stat-line"><span>Added</span><b>${escapeHtml(added.toLocaleDateString())}</b></div>` : ''}
      <div class="field"><label>Width <b data-sizev>${escapeHtml(fmtLen(n.size > 0 ? n.size : 0.3))}</b></label><input type="range" min="0.1" max="1.2" step="0.02" value="${n.size > 0 ? n.size : 0.3}" data-size></div>
      <button class="btn" data-locate>LOCATE</button>
      <button class="btn" data-move>MOVE NOTE</button>
      <button class="btn danger" data-del>DELETE NOTE</button>`;
    const text = inspEl.querySelector('[data-text]');
    text.oninput = () => { n.text = text.value; redrawNoteCard(n.id); };
    text.onchange = () => { n.text = text.value.trim(); n.updatedAt = new Date().toISOString(); touch(); redrawNoteCard(n.id); };
    inspEl.querySelector('[data-size]').oninput = e => { n.size = parseFloat(e.target.value); inspEl.querySelector('[data-sizev]').textContent = fmtLen(n.size); buildNote(n); };
    inspEl.querySelector('[data-size]').onchange = () => touch();
    inspEl.querySelector('[data-locate]').onclick = () => flyToNote(n.id);
    inspEl.querySelector('[data-move]').onclick = () => startNoteMode(n.id);
    inspEl.querySelector('[data-del]').onclick = () => deleteNote(n.id);
    return;
  }
  if (selection.kind === 'scan') {
    const s = prop.scans.find(s => s.id === selection.id);
    if (!s) { selection = null; tagPicks = []; return renderInspectorBody(); }
    const obj = scanObjs[s.id] || null;
    const state = obj ? 'ready' : (scanState[s.id] || 'loading');
    const st = obj ? scanStats(obj) : { label: { missing: 'missing from storage - re-import it', failed: 'could not be loaded', loading: 'loading', hidden: 'not loaded while hidden' }[state] || 'loading' };
    const rot = s.rot || [0, s.rotY || 0, 0];
    const isPts = s.kind === 'points', isSplat = s.kind === 'splat';
    // Nothing to frame, drop or centre until the object exists; deleting mid-parse would race the loader.
    const dis = obj ? '' : 'disabled', disDel = state === 'loading' ? 'disabled' : '';
    const panelCtx = { prop, scan: s, obj, picks: tagPicks, models: prop.scans.map(x => ({ scan: x, root: scanObjs[x.id] && scanObjs[x.id].userData.inner })).filter(x => x.root),
      reload: () => addScanToScene(s), rerender: renderInspector, select: keys => setSelection({ kind: 'scan', id: s.id, tagKey: keys[0] }, keys), toast };
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
      ${s.kind === 'mesh' ? `<button class="btn" data-plan ${dis} title="Find the floor and ceiling, square the scan up, propose walls, rooms, doors and windows, and render the plan underlay from the scan">${icon('plan')}PROPOSE PLAN FROM SCAN</button>
      <button class="btn" data-fixtures ${dis} title="Read counter runs, wall cabinets, tall appliances and furniture from the scan, for review">${icon('scan')}PROPOSE FIXTURES FROM SCAN</button>` : ''}
      ${s.source && s.source.url ? `<a class="btn" href="${escapeHtml(s.source.url)}" target="_blank" rel="noopener" style="display:flex; text-decoration:none; justify-content:center">${icon('link')}OPEN ON POLYCAM</a>` : ''}
      ${s.importWarnings?.length ? `<p class="empty">${s.importWarnings.map(escapeHtml).join('<br>')}</p>` : ''}
      ${s.kind === 'mesh' ? `<button class="btn" data-exchange ${dis}>EDIT / BRING BACK</button>
      ${modelPanelHtml(panelCtx)}` : ''}
      <button class="btn danger" data-del ${disDel} title="${disDel ? 'Wait for the scan to finish loading' : ''}">DELETE SCAN</button>`;
    bindModelPanel(inspEl, panelCtx);
    const exchange = inspEl.querySelector('[data-exchange]');
    if(exchange) exchange.onclick = () => exchangeDialog(s.id);
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
    inspEl.querySelector('[data-vis]').onchange = e => { s.visible = e.target.checked; upd(); loadShownScans(); renderToolCol(); };
    inspEl.querySelector('[data-frame]').onclick = () => { if (obj) frameObject(obj); };
    inspEl.querySelector('[data-floor]').onclick = () => { if (obj) { dropScanToFloor(s, obj); upd(); renderInspector(); } };
    inspEl.querySelector('[data-center]').onclick = () => { if (obj) { centerScanOnModel(s, obj, modelBounds(prop)); upd(); renderInspector(); } };
    const planBtn = inspEl.querySelector('[data-plan]');
    if (planBtn) planBtn.onclick = () => proposePlanFromScan(s);
    const fxBtn = inspEl.querySelector('[data-fixtures]');
    if (fxBtn) fxBtn.onclick = () => proposeFixturesFromScan(s);
    inspEl.querySelector('[data-del]').onclick = async () => {
      if (scanState[s.id] === 'loading' && !obj) return;
      prop.scans = prop.scans.filter(x => x.id !== s.id);
      if([prop.designComparison?.beforeId,prop.designComparison?.afterId].includes(s.id))delete prop.designComparison;
      if(prop.modelSourceId === s.id) { delete prop.modelSourceId; rebuildModel(); }
      if (obj) { scanRoot.remove(obj); disposeScanObject(obj); delete scanObjs[s.id]; }
      delete scanState[s.id];
      forgetScanTags(prop, s.id);
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

// ---------- saved views (tabs over the model, as SketchUp's scene tabs) ----------
let activeViewId = null;       // the saved view last gone to, drawn as the current tab
let offScreen = null, offMenu = null;
function viewState() {
  return {
    camera: { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov },
    mode: mode === 'top' ? 'top' : 'orbit', xray,
    // `height` is the first flat cut, for a version of the app that knows only one cut height.
    section: { on: section.on, height: levelHeightOf(section.planes) ?? 1.2, planes: section.planes.map(s => ({ id: s.id, kind: s.kind, q: [...s.q], pos: [...s.pos] })), active: section.active },
    hiddenLevels: [...hiddenLevels()],
  };
}
function addView() {
  const v = addSavedView(prop, '', viewState());
  activeViewId = v.id;
  touch(); renderViews();
  toast('Saved the view "' + v.name + '" with its camera and tags. Double-click its tab to rename it.', 'ok');
  return v;
}
function goToView(id) {
  const v = (prop.savedViews || []).find(x => x.id === id);
  if (!v) return;
  activeViewId = id;
  if (match) endMatch();
  if (v.mode === 'top' && mode !== 'top') setMode('top');
  else if (v.mode !== 'top' && mode !== 'orbit') setMode('orbit');
  const tagsMoved = applySavedTags(prop, v) > 0;
  section.on = v.section.on;
  if (v.section.planes) { section.planes = normalizeSections(v.section.planes); section.active = v.section.active; }
  else if (v.section.on) {
    // A view saved when the cut could only move up and down: one flat cut at its height.
    const s = newSection('level');
    s.pos[1] = v.section.height;
    section.planes = [s]; section.active = s.id;
  }
  if (section.on && !activeSection()) { if (section.planes.length) section.active = section.planes[0].id; else section.on = false; }
  if (xray !== v.xray) { xray = v.xray; applyXray(); }
  const hidden = hiddenLevels();
  hidden.clear(); for (const lid of v.hiddenLevels) if (prop.levels.some(l => l.id === lid)) hidden.add(lid);
  const levels = modelGroup && modelGroup.userData.levels;
  if (levels) for (const l of levels) l.group.visible = !hidden.has(l.id);
  rebuildNightLights();
  applyTagVisibility();
  applySection();
  if (camera.fov !== v.camera.fov) { camera.fov = v.camera.fov; camera.updateProjectionMatrix(); }
  flyTo(new THREE.Vector3(...v.camera.position), new THREE.Vector3(...v.camera.target), 650);
  const sel = selectedObject();
  if (sel && !isVisibleChain(sel)) setSelection(null);
  renderHud(); renderToolCol(); renderInspector(); renderViews();
  if (tagsMoved) touch();
}
function stepView(by) {
  const list = prop.savedViews || [];
  if (!list.length) return;
  const i = list.findIndex(v => v.id === activeViewId);
  goToView(list[i < 0 ? (by > 0 ? 0 : list.length - 1) : (i + by + list.length) % list.length].id);
}
function renameView(id) {
  const v = (prop.savedViews || []).find(x => x.id === id);
  if (!v) return;
  const name = prompt('Name of this view', v.name);
  if (name && renameSavedView(prop, id, name)) { touch(); renderViews(); }
}
function renderViews() {
  const strip = hud.views;
  if (!strip) return;
  const list = prop.savedViews || [];
  strip.innerHTML = list.map(v => `<button class="v-view-tab ${v.id === activeViewId ? 'active' : ''}" role="tab" aria-selected="${v.id === activeViewId}" data-view-tab="${escapeHtml(v.id)}" title="${escapeHtml(v.name)}: click to go there (Page Up / Page Down step through views). Double-click to rename; right-click to update, move or delete.">${escapeHtml(v.name)}</button>`).join('') +
    `<button class="v-view-add" data-view-add title="Save this camera, with the tags shown now, as a view" aria-label="Add a saved view">${icon('plus')}${list.length ? '' : '<span>SAVE VIEW</span>'}</button>`;
  strip.querySelector('[data-view-add]').onclick = addView;
  strip.querySelectorAll('[data-view-tab]').forEach(b => {
    const id = b.dataset.viewTab;
    b.onclick = () => goToView(id);
    b.ondblclick = () => renameView(id);
    b.oncontextmenu = e => {
      e.preventDefault();
      const i = list.findIndex(v => v.id === id);
      popupMenu({ x: e.clientX, y: e.clientY }, [
        ['view-update', 'UPDATE TO THIS CAMERA AND TAGS', () => { updateSavedView(prop, id, viewState()); activeViewId = id; touch(); renderViews(); toast('View updated.', 'ok'); }],
        ['view-rename', 'RENAME', () => renameView(id)],
        i > 0 ? ['view-left', 'MOVE LEFT', () => { moveSavedView(prop, id, -1); touch(); renderViews(); }] : null,
        i < list.length - 1 ? ['view-right', 'MOVE RIGHT', () => { moveSavedView(prop, id, 1); touch(); renderViews(); }] : null,
        null,
        ['view-delete', 'DELETE VIEW', () => { if (!confirm('Delete the saved view "' + list[i].name + '"?')) return; deleteSavedView(prop, id); if (activeViewId === id) activeViewId = null; touch(); renderViews(); }],
      ].filter((it, k, all) => it !== null || (k > 0 && all[k - 1] !== null)));
    };
  });
}

// ---------- what is on the screen, and the Tiksi menu ----------
// The tool column's groups, the view bar, the compass and the view tabs show only when the
// Tiksi menu has them ON SCREEN; everything is in the menu either way.
function applyScreen() {
  if (!hud.modes) return;
  hud.modes.hidden = !onScreen('model.modes', false);
  if (hud.compassBox) hud.compassBox.hidden = !onScreen('model.compass', true);
  if (hud.views) hud.views.hidden = !onScreen('model.views', true);
  wrapEl && wrapEl.classList.toggle('v-views-on', !hud.views.hidden);
}
function menuGroups() {
  if (!prop || !scene) return [];
  const g = (title, id, on, label, items) => ({ title, screen: { id, on: onScreen(id, on), label }, items });
  const counts = tagCounts(prop);
  return [
    g('Saved views', 'model.views', true, 'Tabs over the model', [
      ...(prop.savedViews || []).map(v => ({ label: v.name, active: v.id === activeViewId, run: () => goToView(v.id) })),
      { label: 'Save this view', key: '+', run: addView },
    ]),
    g('View', 'model.view', false, 'FRAME, FRONT and ISO in the left column', [
      { label: 'Frame the model', key: 'F', run: () => { if (mode !== 'orbit') setMode('orbit'); presetView('frame'); } },
      { label: 'Front', run: () => { if (mode !== 'orbit') setMode('orbit'); presetView('front'); } },
      { label: 'Iso', run: () => { if (mode !== 'orbit') setMode('orbit'); presetView('iso'); } },
      { label: 'Orbit', key: 'O', active: mode === 'orbit', run: () => setMode('orbit') },
      { label: 'Walk through', key: 'W', active: mode === 'walk', run: () => setMode('walk') },
      { label: 'Top, north up', key: 'T', active: mode === 'top', run: () => setMode('top') },
    ]),
    g('Display', 'model.modes', false, 'The ORBIT to NOTES bar over the model', [
      { label: 'Section cut', key: 'C', active: section.on, run: toggleSection },
      ...SECTION_KINDS.map(k => ({ label: 'Add a section cut: ' + SECTION_LABELS[k].toLowerCase(), run: () => addSection(k) })),
      { label: 'Snap section cuts', active: sectionSnap, keep: true, run: () => setSectionSnap(!sectionSnap) },
      { label: 'X-ray', key: 'X', active: xray, run: toggleXray },
      { label: 'Sun and environment', run: () => { hud.env.hidden = false; hud.env.classList.add('open'); renderEnvPanel(); } },
      { label: 'Photo pins', active: markersShown('pins'), run: () => toggleMarkers('pins') },
      { label: 'Notes', active: markersShown('notes'), run: () => toggleMarkers('notes') },
      { label: 'Render a still image', run: openStillDialog },
    ]),
    g('Tools', 'model.tools', false, 'The tools in the left column', [
      { label: 'Select', key: 'V', active: tool === 'select', run: () => setTool('select') },
      { label: 'Move walls', key: 'M', active: tool === 'move', run: () => setTool(tool === 'move' ? 'select' : 'move') },
      { label: 'Measure', key: 'D', active: tool === 'measure', run: () => setTool(tool === 'measure' ? 'select' : 'measure') },
      ...(measures.length ? [{ label: 'Clear measures', run: () => { clearMeasures(); renderToolCol(); } }] : []),
      { label: 'Pin a photo', key: 'P', active: tool === 'pin', run: () => { if (tool === 'pin') setTool('select'); else startPinMode(null); } },
      { label: 'Note', key: 'N', active: tool === 'note', run: () => { if (tool === 'note') setTool('select'); else startNoteMode(null); } },
      { label: 'Edit in SketchUp', run: () => document.dispatchEvent(new CustomEvent('tiksi:edit-in-sketchup')) },
    ]),
    g('Tags', 'model.tags', false, 'Tag switches in the left column', [
      ...prop.tags.map(t => ({ label: (t.visible !== false ? 'Hide ' : 'Show ') + t.name + ' (' + (counts.get(t.id) || 0) + ')', active: t.visible !== false, keep: true, run: () => toggleTag(t.id) })),
      { label: 'Rename, recolour, add or delete tags', run: () => setSelection(null) },
    ]),
    g('Levels', 'model.levels', false, 'Level switches in the left column',
      prop.levels.map(l => ({ label: (hiddenLevels().has(l.id) ? 'Show ' : 'Hide ') + l.name, active: !hiddenLevels().has(l.id), keep: true, run: () => toggleLevel(l.id) }))),
    g('Models and scans', 'model.models', false, 'The list of imported models in the left column', [
      ...prop.scans.map(sc => ({ label: sc.name, active: scanSelected(sc.id), run: () => setSelection({ kind: 'scan', id: sc.id }) })),
      { label: 'Import and exchange models (FILE)', run: () => exchangeDialog() },
    ]),
    g('Compass', 'model.compass', true, 'The compass over the model', []),
  ];
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
  const scanBadge = s => scanObjs[s.id] ? (s.kind || '').toUpperCase().slice(0, 5) : ({ missing: 'GONE', failed: 'ERR', hidden: 'OFF' }[scanState[s.id]] || '...');
  const scanRows = prop.scans.map(s => `<button class="tool-btn v-scan-row ${scanSelected(s.id) ? 'active' : ''}" data-scan="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}${scanObjs[s.id] ? '' : ' (' + escapeHtml(scanState[s.id] || 'loading') + ')'}">${icon(s.kind === 'splat' ? 'splat' : s.kind === 'mesh' ? 'model' : 'scan')}<span class="tb-text">${escapeHtml(s.name.length > 14 ? s.name.slice(0, 12) + '..' : s.name)}</span><kbd class="key">${escapeHtml(scanBadge(s))}</kbd></button>`).join('');
  // One toggle per storey, lit while the level is shown; the key badge is its floor elevation.
  const hidden = hiddenLevels();
  // One toggle per tag, lit while the tag is shown; the badge counts its objects.
  const counts = tagCounts(prop);
  const keyOf = { [CANON.scan.id]: ' (G)', [CANON.furniture.id]: ' (K)' };
  const tagRow = (id, name, color, shown) => `<button class="tool-btn v-tag-btn ${shown ? 'active' : ''}" data-tag="${escapeHtml(id)}" aria-pressed="${shown}" title="${shown ? 'Hide' : 'Show'} ${escapeHtml(name)}${keyOf[id] || ''}">${icon(shown ? 'eye' : 'eye-off')}<span class="v-tag-dot" style="background:${escapeHtml(color)}"></span><span class="tb-text">${escapeHtml(name.length > 13 ? name.slice(0, 11) + '..' : name)}</span><kbd class="key">${counts.get(id) || 0}</kbd></button>`;
  const tagRows = prop.tags.map(t => tagRow(t.id, t.name, t.color, t.visible !== false)).join('') +
    ((counts.get(UNTAGGED) || prop.tagUntaggedVisible === false) ? tagRow(UNTAGGED, UNTAGGED_LABEL, 'transparent', prop.tagUntaggedVisible !== false) : '');
  const levelRows = prop.levels.map(l => `<button class="tool-btn ${hidden.has(l.id) ? '' : 'active'}" data-level="${escapeHtml(l.id)}" title="${hidden.has(l.id) ? 'Show' : 'Hide'} ${escapeHtml(l.name)} (floor at ${escapeHtml(fmtLen(l.elevation))})">${icon(hidden.has(l.id) ? 'eye-off' : 'layers')}<span class="tb-text">${escapeHtml(l.name.length > 14 ? l.name.slice(0, 12) + '..' : l.name)}</span><kbd class="key">${escapeHtml(fmtLen(l.elevation, { short: true }))}</kbd></button>`).join('');
  // Each group is on the screen only when the Tiksi menu says so; otherwise it lives in the menu.
  const groups = [
    onScreen('model.view', false) && `<div class="tool-head">VIEW</div>
    ${tb('frame', 'frame', 'FRAME', 'F')}
    ${tb('front', 'target', 'FRONT')}
    ${tb('iso', 'model', 'ISO')}`,
    onScreen('model.tools', false) && `<div class="tool-head">TOOLS</div>
    ${tb('select', 'select', 'SELECT', 'V', tool === 'select')}
    ${tb('move', 'move', 'MOVE WALLS', 'M', tool === 'move')}
    ${tb('measure', 'measure', 'MEASURE', 'D', tool === 'measure')}
    ${measures.length ? tb('clearm', 'close', 'CLEAR MEASURES') : ''}
    ${tb('pin', 'pin', 'PIN', 'P', tool === 'pin')}
    ${tb('note', 'note', 'NOTE', 'N', tool === 'note')}
    ${tb('sketchup', 'external', 'EDIT IN SKETCHUP')}`,
    onScreen('model.tags', false) && `<div class="tool-head" title="Show or hide each tag. With nothing selected, the panel on the right renames, recolours, adds and deletes tags.">TAGS</div>
    ${tagRows}`,
    onScreen('model.levels', false) && `<div class="tool-head">LEVELS</div>
    ${levelRows}`,
    onScreen('model.models', false) && `<div class="tool-head">MODELS & SCANS</div>
    ${prop.designComparison ? tb('before', 'scan', 'BEFORE', '', prop.designComparison.view === 'before') + tb('after', 'model', 'AFTER', '', prop.designComparison.view === 'after') : ''}
    ${scanRows}
    <div class="empty" style="padding:6px 8px; font-size:9.5px; color:var(--faint); font-family:var(--mono); line-height:1.5">
      PLY / PCD / XYZ / LAS point clouds, OBJ / GLB meshes, .splat / .spz / .ply Gaussian splats.</div>
    <div class="tool-sep"></div>
<div class="empty">Import and exchange models in FILE.</div>`,
  ].filter(Boolean);
  tc.innerHTML = groups.join('<div class="tool-sep"></div>');
  tc.closest('.v-layout')?.classList.toggle('v-no-tools', !groups.length);
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
    loadShownScans();   // the side now shown, if this is the first time
    if(chosen==='design')delete prop.modelSourceId;else prop.modelSourceId=chosen;
    // Select the record immediately, including while its scene object is loading.
    // setScanState refreshes this inspector when the chosen object is ready.
    rebuildModel();setSelection(chosen==='design'?null:{kind:'scan',id:chosen});renderToolCol();touch();
  };
  on('before',()=>compare('before'));on('after',()=>compare('after'));
  tc.querySelectorAll('[data-scan]').forEach(b => b.onclick = () => setSelection({ kind: 'scan', id: b.dataset.scan }));
  tc.querySelectorAll('[data-level]').forEach(b => b.onclick = () => toggleLevel(b.dataset.level));
  tc.querySelectorAll('[data-tag]').forEach(b => b.onclick = () => toggleTag(b.dataset.tag));
  on('rebuild', () => { rebuildModel(); rebuildGround(); buildAllPins(); buildAllNotes(); });
}
function setTool(next) {
  if (next !== 'select') endMatch();
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
    case 'PageDown': case 'PageUp': stepView(e.code === 'PageDown' ? 1 : -1); break;
    case 'KeyG': toggleTag(CANON.scan.id); break;
    case 'KeyK': toggleTag(CANON.furniture.id); break;
    case 'Escape':
      if (match) endMatch();
      else if (tool !== 'select') setTool('select');
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
// A MODEL page that cannot open says so in its own place, with a way to try again, instead of
// leaving the layout empty. The other pages keep working.
export function mount(root) {
  try { openModel(root); }
  catch (e) {
    console.error('MODEL could not open', e);
    try { unmount(); } catch (err) { console.error(err); }
    // Whatever the failed open left half-built must not be torn down twice or drawn.
    if (renderer) { renderer.setAnimationLoop(null); renderer.domElement.remove(); }
    scene = null; camera = null; composer = null; passes = {}; controls = null; modelGroup = null; groundGroup = null; batches = null;
    el = null; wrapEl = null; inspEl = null; hud = {};
    const why = e && e.graphics
      ? 'This browser could not start 3D graphics, so MODEL cannot be shown. Close other tabs or apps that use 3D, then reload. The other pages still work.'
      : 'MODEL could not open (' + errMsg(e) + '). Reload to try again. The other pages still work.';
    root.innerHTML = `<div class="view-scroll v-open-failed" role="alert"><div class="kicker">MODEL</div>${noticeHtml(why, true).replace('<p style="margin:0;', '<p class="muted" style="margin:0 0 14px;')}</div>`;
    root.querySelector('[data-reload]').onclick = () => location.reload();
  }
}
function openModel(root) {
  const resumed = matchResume && performance.now() - matchResume.at < 1500 ? matchResume : null;
  matchResume = null;
  prop = activeProperty();
  el = root;
  if (!prop) {
    root.innerHTML = `<div class="view-scroll"><div class="kicker">MODEL</div>
      <p class="muted">No property yet. Create one from the PROPERTY selector in the top bar.</p></div>`;
    return;
  }
  ensureDefaults(prop);
  section = sectionsByProp[prop.id] || (sectionsByProp[prop.id] = { on: false, planes: [], active: null });
  applyTextureLimits();
  setTextureUse(texturesOnScreen);
  root.innerHTML = `
    <div class="editor-layout v-layout">
      <div class="tool-col"></div>
      <div class="canvas-wrap v-wrap">
        <div class="v-views" role="tablist" aria-label="Saved views"></div>
        <div class="v-modes"></div>
        <div class="v-sections" role="group" aria-label="Section cuts" hidden></div>
        <div class="v-compass" title="North"><div class="v-rose"><span class="n">N</span><span class="e">E</span><span class="s">S</span><span class="w">W</span><i></i></div></div>
        <div class="v-env"></div>
        <div class="v-progress"><div class="v-prog-label"></div><div class="v-prog-bar"><div class="v-prog-fill"></div></div></div>
        <div class="v-toast"></div>
        <div class="v-hint"></div>
      </div>
      <div class="inspector" data-side-pane="model"></div>
    </div>`;
  wrapEl = root.querySelector('.canvas-wrap');
  inspEl = root.querySelector('.inspector');
  hud = {
    modes: wrapEl.querySelector('.v-modes'), sections: wrapEl.querySelector('.v-sections'), compass: wrapEl.querySelector('.v-rose'), env: wrapEl.querySelector('.v-env'),
    progress: wrapEl.querySelector('.v-progress'), toast: wrapEl.querySelector('.v-toast'), hint: wrapEl.querySelector('.v-hint'),
    views: wrapEl.querySelector('.v-views'), compassBox: wrapEl.querySelector('.v-compass'),
  };
  activeViewId = null;
  mode = 'orbit'; tool = 'select'; selection = null; hoverTarget = null; tween = null; measureDraft = null; pinPhotoId = null; match = null;
  movingNoteId = null; rightPress = null; ctxMenu = null; noteEditor = null;
  panoNagged = false; panoPending = null; panoMissing = null;
  for (const k of Object.keys(scanState)) delete scanState[k];
  for (const k of Object.keys(notices)) delete notices[k];
  appliedQuality = null; renderFailed = false;
  scanQueue = Promise.resolve();   // this visit's own queue (see loadScans)
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
  renderViews();
  applyScreen();
  offScreen = onScreenChange(() => { applyScreen(); renderToolCol(); });
  offMenu = setMenuProvider(menuGroups);
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
  // The context went while MODEL was closed and is not back yet.
  if (contextLost) { contextNotice(false); armContextTimer(); }
  programsWarm = false;
  lastT = 0;
  renderer.setAnimationLoop(tick);
  requestRender(4);

  const focus=pendingScanFocus || prop.modelSourceId,token=mountId,focusVersion=selectionVersion;pendingScanFocus=null;
  loadShownScans().then(()=>{if(token===mountId && selectionVersion===focusVersion && !match && focus && scanObjs[focus]){setSelection({kind:'scan',id:focus});frameObject(scanObjs[focus]);}});
  // Deep link from the PHOTOS view: #/model?pin=<photoId> enters PIN PHOTO for that photo.
  const m = /[?&]pin=([^&]+)/.exec(location.hash);
  if (m) {
    if (photoById(prop, decodeURIComponent(m[1]))) startPinMode(decodeURIComponent(m[1]));
    // Consume the query so a reload, Back or a bookmark returns to the plain model view
    // (replaceState does not fire hashchange, so the router is not re-entered).
    history.replaceState(null, '', '#/model');
  }
  // Only straight after a remount (checked on entry): leaving MODEL and coming back starts plain.
  if (resumed && photoById(prop, resumed.id)) startMatch(resumed.id, resumed);
  // #/model?match=<photoId> (PHOTOS > MATCH IN 3D) opens MATCH PHOTO for that photo.
  const mm = /[?&]match=([^&]+)/.exec(location.hash);
  if (mm) {
    if (photoById(prop, decodeURIComponent(mm[1]))) startMatch(decodeURIComponent(mm[1]));
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

// Diagnostics for the browser checks: draw one full-quality frame now and return the renderer's
// counts for the whole frame (every pass) and how the imported models are grouped. `grouped`
// switches grouped drawing off or on first, so a check can compare the two.
export function drawStats({ grouped } = {}) {
  if (!scene || !composer || !batches) return null;
  if (grouped !== undefined) batches.setEnabled(grouped);
  const info = renderer.info, auto = info.autoReset;
  info.autoReset = false; info.reset();
  try { renderFrame(true); } finally { info.autoReset = auto; }
  return { calls: info.render.calls, triangles: Math.round(info.render.triangles), groups: batches.stats(),
    camera: { projection: camera.projectionMatrix.toArray(), inverse: camera.matrixWorldInverse.toArray() } };
}
// Whether the last frame was a fast one (camera moving), whether a shadow refresh is pending, and
// how many fast frames, full frames and shadow refreshes this view has drawn.
export function frameState() {
  return scene && renderer ? { fast: lastFrameFast, shadowRefreshPending: renderer.shadowMap.needsUpdate, ...frameCounts } : null;
}
// Whether MODEL has settled: a full frame drawn, every model loaded, every procedural texture
// in and the shader programs warmed after it, nothing left to draw. The browser checks wait
// for this before they tap: on a software GL the warm-up blocks the page for a long time, and
// a tap that lands in it is answered only when it ends.
// MODEL that is not showing a model (no property yet, or another page) has nothing to settle.
export function viewerIdle() { const s = viewerIdleState(); return !s.mounted || Object.values(s).every(Boolean); }
// The same, part by part, so a check that gave up waiting can say what was still going on.
export function viewerIdleState() {
  return {
    mounted: !!(scene && renderer), programsWarm, texturesIn: !texturesPending && !(scene && pendingTextureJobs() > 0),
    modelsLoaded: !Object.values(scanState).some(s => s === 'loading') && !(scene && splatBusy()),
    firstFrame: frameCounts.fullFrames > 0, nothingToDraw: framesLeft <= 0, shadowsFresh: !(renderer && renderer.shadowMap.needsUpdate),
    graphics: !contextLost, pickIndex: pendingPickBuilds() === 0,
  };
}
// For the browser checks: the quality this device draws at and what was set from it, and where
// each scan record stands ('hidden' is a scan that has not been loaded because it is not shown).
export function qualityState() {
  if (!scene || !composer || !sun || !prop) return null;
  return {
    quality: quality(), touch: ownQuality(), phoneLayout: fieldLayout(), shared: prop.env.quality, shadowMap: sun.shadow.mapSize.x, smoothingSamples: composer.renderTarget1.samples,
    shading: aoWanted, glow: passes.bloom.enabled, pixelRatio: renderer.getPixelRatio(), limits: memoryLimits(),
    roomLights: lampLights.length, litRooms: lampKey ? lampKey.split('|').filter(Boolean) : [],
  };
}
export function scanStates() {
  if (!scene || !prop) return null;
  return Object.fromEntries(prop.scans.map(s => [s.id, { state: scanObjs[s.id] ? 'ready' : (scanState[s.id] || 'loading'), label: scanObjs[s.id] ? scanStats(scanObjs[s.id]).label : '' }]));
}
// Whether MODEL currently draws this part of a loaded model (tag key from tags.js); null when the
// key names no loaded part. Grouped parts answer for their proxy, others for their own mesh.
export function partDrawn(key) {
  const m = /^node:([^#]+)#/.exec(key || '');
  const w = m && scanObjs[m[1]], part = w && partByKey(w, key);
  if (!part) return null;
  const grouped = batches && batches.drawsPart(part.object);
  return grouped !== null && grouped !== undefined ? grouped : isVisibleChain(part.object);
}

// The camera the 3D view last showed, per property, so DOCUMENTS can place a 3D view from it.
let lastView = null;
export function lastCameraView(propId) { return lastView && lastView.propId === propId ? lastView : null; }
function rememberView() {
  if (!camera || !prop) return;
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const t = controls && controls.target && controls.enabled !== false ? controls.target.clone() : camera.position.clone().addScaledVector(dir, 5);
  if (t.distanceTo(camera.position) < 1e-3) t.copy(camera.position).addScaledVector(dir, 5);
  lastView = { propId: prop.id, position: camera.position.toArray(), target: t.toArray(), fov: camera.fov };
}

export function unmount() {
  try { rememberView(); } catch (e) { console.error(e); }
  if (offScreen) { offScreen(); offScreen = null; }
  if (offMenu) { offMenu(); offMenu = null; }
  if (exportDialog) exportDialog.close();
  if (renderer) renderer.setAnimationLoop(null);
  mountId++;
  revokePhotoUrls();   // object URLs handed to the lightbox, pin picker and pano loader
  // mount() bails out before building anything when there is no property; there is nothing to tear down.
  for (const k of Object.keys(notices)) hideNotice(k);
  appliedQuality = null;
  setTextureUse(null);
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
  // Every disk save remounts the view (a saved view among them): the match carries on after it.
  matchResume = match && camera && controls ? { at: performance.now(), id: match.id, hfov: match.hfov, roll: match.roll, position: camera.position.toArray(), target: (tween ? tween.t1 : controls.target).toArray() } : null;
  if (tween && matchResume) matchResume.position = tween.p1.toArray();
  if (match) { match.el.remove(); match = null; }
  if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
  clearTimeout(pmremTimer);
  if (mode === 'walk' && walk) { if (walkLocked) walk.unlock(); }
  if (walk) { walk.dispose(); walk = null; }
  if (gizmo) { gizmo.detach(); gizmo.dispose(); gizmo = null; }
  // Materials are shared between mounts, so the planes come off them here; the cuts
  // themselves stay with the property and are put back by the next mount.
  if (scene) { const on = section.on; section.on = false; applySection(); section.on = on; }
  for (const g of [secMove, secTurn]) if (g) { g.detach(); g.dispose(); }
  secMove = null; secTurn = null; sheetRoot = null; sectionBoxCache = null; clipPlanes = []; capMeshes = [];
  // The navigation's listeners sit on the canvas and the window, which outlive this visit.
  if (nav) { nav.dispose(); nav = null; }
  if (controls) { controls.dispose(); controls = null; }
  if (modelGroup) { disposeBuilt(modelGroup); modelGroup = null; }
  interiorFill = false;
  if (groundGroup) { disposeBuilt(groundGroup); groundGroup = null; }
  if (lightRoot) { lightRoot.traverse(o => { if (o.geometry) o.geometry.dispose(); }); lightRoot = null; }
  clearMeasures();
  for (const id of Object.keys(pinObjs)) removePin(id);
  for (const id of Object.keys(cameraObjs)) removeCameraGlyph(id);
  for (const id of Object.keys(positionObjs)) removePositionMarker(id);
  for (const id of Object.keys(noteObjs)) removeNote(id);
  if (batches) { batches.dispose(); batches = null; }
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
  scanRoot = null; pinRoot = null; noteRoot = null; measureRoot = null; cameraRoot = null; positionRoot = null;
  el = null; wrapEl = null; inspEl = null; hud = {};
  selection = null; hoverTarget = null; tween = null; pressed = null; dragLook = null; rightPress = null; movingNoteId = null;
}

// ---------- phone layout (field.js) ----------
// The phone layout hides the tool column, inspector and HUD; its side panel reads the view's
// state and drives it through these calls.
const fieldLayout = () => document.documentElement.classList.contains('phone');
export function fieldState() {
  if (!scene || !prop) return null;
  const hidden = hiddenLevels();
  const counts = tagCounts(prop);
  return {
    mode,
    cameras: [{ id: 'frame', label: 'Overview' }, { id: 'front', label: 'Front' }, { id: 'iso', label: 'Corner' }],
    views: (prop.savedViews || []).map(v => ({ id: v.id, label: v.name, on: v.id === activeViewId })),
    positions: (prop.photoPositions || []).map(p => ({ id: p.id, label: positionLabel(p) })),
    show: [
      { id: 'section', label: 'Section cut', on: section.on },
      { id: 'xray', label: 'X-ray', on: xray },
      { id: 'pins', label: 'Photos', on: markersShown('pins'), count: prop.photos.filter(ph => ph.pin).length },
      { id: 'notes', label: 'Notes', on: markersShown('notes'), count: prop.notePins.length },
    ],
    section: (() => {
      const s = section.on && activeSection();
      if (!s) return null;
      const sp = sliderSpan(s), r = sectionReadout(s);
      return { min: sp.min, max: sp.max, step: sp.step, value: r.d, label: r.label, kinds: SECTION_KINDS.map(k => ({ id: k, label: SECTION_LABELS[k][0] + SECTION_LABELS[k].slice(1).toLowerCase(), on: s.kind === k })) };
    })(),
    levels: prop.levels.map(l => ({ id: l.id, label: l.name, on: !hidden.has(l.id) })),
    // The quality this device draws at (a touch device's own choice; otherwise the property's).
    quality: QUALITY_NAMES.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), on: quality() === id })),
    // One switch per tag that holds something; Untagged only when objects sit on no tag.
    tags: [...prop.tags.map(t => ({ id: t.id, label: t.name, color: t.color, on: t.visible !== false })),
      { id: UNTAGGED, label: UNTAGGED_LABEL, on: tagShown(prop, UNTAGGED) }].filter(t => (counts.get(t.id) || 0) > 0),
  };
}
export function fieldAction(kind, id, value) {
  if (!scene || !prop) return;
  if (kind === 'mode') setMode(id);
  else if (kind === 'camera') { if (mode !== 'orbit') setMode('orbit'); presetView(id); }
  else if (kind === 'position') {
    const pos = (prop.photoPositions || []).find(x => x.id === id);
    if (!pos) return;
    if (mode !== 'orbit') setMode('orbit');
    flyTo(new THREE.Vector3(...pos.view.position), new THREE.Vector3(...pos.view.target), 700);
  }
  else if (kind === 'view') goToView(id);
  else if (kind === 'save-view') addView();
  else if (kind === 'tag') toggleTag(id || UNTAGGED);
  else if (kind === 'level') toggleLevel(id);
  else if (kind === 'quality') {
    if (!QUALITY_NAMES.includes(id) || id === quality()) return;
    if (ownQuality()) setDeviceQuality(id); else { prop.env.quality = id; touch(); }
    applyTextureLimits(); rebuildModel(); applyQuality(); applyEnvironment();
  }
  else if (kind === 'section-height') { slideSection(Number(value)); updateSectionReadout(); }
  else if (kind === 'section-kind') setSectionKind(id);
  else if (kind === 'show') {
    if (id === 'section') toggleSection();
    else if (id === 'xray') toggleXray();
    else if (id === 'pins' || id === 'notes') toggleMarkers(id);
  }
}
// The section cuts as plain data: every plane's cut-away direction and where it sits.
export function sectionState() {
  return {
    on: section.on, snap: sectionSnap, sheets: sectionSheets, active: section.active,
    planes: section.planes.map(s => { const { n, d } = planeOf(s); return { id: s.id, kind: s.kind, normal: n, d, pos: [...s.pos] }; }),
  };
}
// Hold-to-move for walking on a touch screen: dir is forward | back | left | right.
const WALK_CODES = { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD' };
export function fieldWalk(dir, down) {
  const code = WALK_CODES[dir];
  if (!code || !scene) return;
  if (down && mode === 'walk') walkKeys[code] = true; else delete walkKeys[code];
  requestRender(2);
}

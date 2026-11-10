// Section planes in MODEL: a synthetic two-room plan, isolated browser storage and an ephemeral
// HTTP port. Drags the real handles with the mouse: the arrow slides a plane, a ring turns it,
// and SNAP holds both to regular steps.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'tools/fixtures/section-planes');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0])));
  if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(path)] || 'application/octet-stream'); res.end(await readFile(path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, 'localhost', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem('tiksi.onScreen.v1', '{"all":true}'));   // MODEL's tools on the screen (tiksi-menu.js)
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.locator('[data-prop-name]').waitFor();
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const THREE = await import('three');
    const add = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function(...objects) {
      if (this.isScene && objects.some(o => o.name === 'property')) window.testScene = this;
      return add.apply(this, objects);
    };
    store.ws.data = store.emptyWorkspace();
    store.ws.data.settings.units = 'metric';
    const p = store.propertyTemplate('Synthetic section study'), L = p.levels[0].id;
    p.env.quality = 'medium';
    p.walls = [[0,0,8,0],[8,0,8,6],[8,6,0,6],[0,6,0,0],[4,0,4,6]].map(([ax,ay,bx,by], i) => ({id:'wall-'+i,level:L,ax,ay,bx,by,thickness:0.15,material:'mat-drywall'}));
    p.rooms.push({id:'room-a',level:L,name:'A',pts:[[0,0],[4,0],[4,6],[0,6]],material:'mat-oak'}, {id:'room-b',level:L,name:'B',pts:[[4,0],[8,0],[8,6],[4,6]],material:'mat-oak'});
    store.ws.data.properties.push(p); store.ws.data.settings.activePropertyId = p.id;
  });
  await page.locator('#rail a[data-view=model]').click();
  await page.waitForFunction(() => window.testScene?.getObjectByName('property'));
  await page.waitForTimeout(900);   // the opening camera flight

  const state = () => page.evaluate(async () => (await import('/js/viewer3d.js')).sectionState());
  const scene = () => page.evaluate(() => {
    const s = window.testScene, sheets = s.getObjectByName('section planes');
    let wall = null;
    s.getObjectByName('property').traverse(o => { if (!wall && o.isMesh && o.material && !Array.isArray(o.material) && !(o.material.userData && o.material.userData.noClip)) wall = o; });
    return {
      sheets: sheets.children.length, sheetsShown: sheets.visible,
      fillOpacity: sheets.children.map(g => g.children.find(o => o.isMesh).material.opacity),
      clip: wall.material.clippingPlanes ? wall.material.clippingPlanes.length : 0,
      handles: s.children.filter(o => o.isTransformControlsRoot && o.controls.object && o.controls.object.userData.sectionId).length,
    };
  });
  // Screen points on the active plane's handles: the middle of the arrow's shaft, and two
  // points a little apart on a ring ('x' leans the plane, 'y' swings it), on the side nearest the camera.
  const handle = which => page.evaluate(async which => {
    const THREE = await import('three');
    const roots = window.testScene.children.filter(o => o.isTransformControlsRoot && o.controls.object && o.controls.object.userData.sectionId);
    const tc = roots.map(r => r.controls).find(c => c.mode === (which === 'move' ? 'translate' : 'rotate'));
    const obj = tc.object, cam = tc.camera, rect = tc.domElement.getBoundingClientRect();
    cam.updateMatrixWorld();
    const pos = obj.position.clone();
    const scale = pos.distanceTo(cam.position) * Math.min(1.9 * Math.tan(Math.PI * cam.fov / 360) / cam.zoom, 7) * tc.size / 4;
    const axis = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(obj.quaternion);
    const px = v => { const p = v.clone().project(cam); return [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height]; };
    // The arrow reaches out past the rings: press it beyond them.
    if (which === 'move') return { from: px(pos.clone().addScaledVector(axis(0, 0, 1), 0.45 * scale)), to: px(pos.clone().addScaledVector(axis(0, 0, 1), 0.45 * scale + 1.03)) };
    // The ring about local x crosses the plane's own y axis; the ring about local y its x axis.
    // A ring turns with a drag across the line of sight and the ring's axis.
    const u = which === 'x' ? axis(0, 1, 0) : axis(1, 0, 0), about = which === 'x' ? axis(1, 0, 0) : axis(0, 1, 0);
    const at = k => pos.clone().addScaledVector(u, k * 0.5 * scale);
    const start = at(1).distanceTo(cam.position) < at(-1).distanceTo(cam.position) ? at(1) : at(-1);
    const across = cam.position.clone().sub(pos).normalize().cross(about).normalize();
    return { from: px(start), to: px(start.clone().addScaledVector(across, 0.2 * scale)) };
  }, which);
  const drag = async (which) => {
    const h = await handle(which);
    await page.mouse.move(h.from[0], h.from[1]);
    await page.mouse.move(h.from[0] + 1, h.from[1]);   // the handle lights up under the pointer
    if (process.env.DEBUG_CUTS) console.log(which, h, await page.evaluate(() => window.testScene.children.filter(o => o.isTransformControlsRoot).map(r => [r.controls.mode, r.controls.axis, r.controls.enabled])));
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(h.from[0] + (h.to[0] - h.from[0]) * i / 8, h.from[1] + (h.to[1] - h.from[1]) * i / 8);
    await page.mouse.up();
    await page.waitForTimeout(120);
  };
  const turnOf = n => (Math.atan2(n[0], n[2]) * 180 / Math.PI + 360) % 360;
  const offStep = (v, step) => Math.abs(v / step - Math.round(v / step)) * step;
  const bar = page.locator('.v-sections');

  // SECTION: one flat cut that slides up and down, as before, now with a floating plane.
  assert.equal(await bar.isVisible(), false);
  await page.locator('[data-section]').click();
  let st = await state(), sc = await scene();
  assert.equal(st.on, true); assert.equal(st.planes.length, 1); assert.equal(st.planes[0].kind, 'level');
  assert.ok(Math.abs(st.planes[0].normal[1] - 1) < 1e-9 && Math.abs(st.planes[0].d - 1.2) < 1e-9, 'the first cut takes the top off at waist height');
  assert.deepEqual([sc.sheets, sc.sheetsShown, sc.clip, sc.handles], [1, true, 1, 2], 'one transparent plane, clipping, with its move and turn handles');
  assert.ok(sc.fillOpacity[0] > 0 && sc.fillOpacity[0] < 0.3, 'the floating plane is see-through');
  assert.match(await bar.innerText(), /1 UP\/DOWN[\s\S]*\+ UP AND DOWN[\s\S]*\+ SIDE TO SIDE[\s\S]*\+ FRONT TO BACK[\s\S]*\+ CUSTOM/);
  assert.match(await bar.locator('.v-section-val').innerText(), /1\.2 m/);

  // SIDE TO SIDE: a second, upright cut; both clip at once.
  await page.locator('[data-cut-add=side]').click();
  st = await state(); sc = await scene();
  assert.equal(st.planes.length, 2); assert.equal(st.active, st.planes[1].id);
  assert.ok(Math.abs(st.planes[1].normal[0] - 1) < 1e-9 && Math.abs(st.planes[1].d - 4) < 1e-9, 'the side cut starts through the middle, cutting away one side');
  assert.deepEqual([sc.sheets, sc.clip, sc.handles], [2, 2, 2]);
  assert.match(await bar.locator('.v-section-ang').innerText(), /TURN 90° · TILT 0°/);
  await page.screenshot({ path: resolve(output, 'side-cut.png') });

  // The arrow slides the plane along its own direction, in 5 cm steps while SNAP is on.
  await drag('move');
  st = await state();
  const slid = st.planes[1].d;
  assert.ok(Math.abs(slid - 4) > 0.3, 'the arrow moved the cut: ' + slid);
  assert.ok(offStep(slid, 0.05) < 1e-6, 'snapped to 5 cm: ' + slid);
  assert.ok(Math.abs(st.planes[1].normal[0] - 1) < 1e-9, 'sliding does not turn the plane');
  assert.equal((await scene()).handles, 2, 'the handles stay on the plane after a drag');

  // A ring turns it, in 15 degree steps while SNAP is on.
  await drag('y');
  st = await state();
  const turned = turnOf(st.planes[1].normal);
  assert.ok(Math.abs(turned - 90) > 14, 'the ring turned the cut: ' + turned);
  assert.ok(offStep(turned, 15) < 1e-4, 'snapped to 15 degrees: ' + turned);
  assert.ok(Math.abs(st.planes[1].normal[1]) < 1e-9, 'swinging keeps the cut upright');
  assert.match(await bar.locator('.v-section-ang').innerText(), new RegExp('TURN ' + Math.round(turned) + '°'));
  await page.screenshot({ path: resolve(output, 'turned-cut.png') });

  // SNAP off: the same handles move freely.
  await page.locator('[data-cut-snap]').click();
  assert.equal((await state()).snap, false);
  await drag('y'); await drag('move');
  st = await state();
  assert.ok(offStep(turnOf(st.planes[1].normal), 15) > 0.05, 'free turn: ' + turnOf(st.planes[1].normal));
  assert.ok(offStep(st.planes[1].d, 0.05) > 1e-4, 'free slide: ' + st.planes[1].d);
  // Leaning it with the other ring takes the cut off upright.
  await drag('x');
  st = await state();
  assert.ok(Math.abs(st.planes[1].normal[1]) > 0.05, 'the second ring leans the cut: ' + st.planes[1].normal);
  await page.locator('[data-cut-snap]').click();

  // FLIP cuts away the other side of the same plane; the slider slides it.
  const before = (await state()).planes[1];
  await page.locator('[data-cut-flip]').click();
  st = await state();
  assert.ok(st.planes[1].normal.every((c, i) => Math.abs(c + before.normal[i]) < 1e-9) && Math.abs(st.planes[1].d + before.d) < 1e-9);
  await page.locator('[data-cut="' + st.planes[0].id + '"]').click();
  assert.equal((await state()).active, st.planes[0].id);
  await bar.locator('.v-section-range').evaluate(el => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  st = await state();
  assert.ok(Math.abs(st.planes[0].d - 2) < 1e-9 && Math.abs(st.planes[0].pos[1] - 2) < 1e-9, 'the slider moves the flat cut to 2 m');
  assert.match(await bar.locator('.v-section-val').innerText(), /^2 m$/);

  // CUSTOM: an upright cut facing the camera, on a 15 degree compass angle while SNAP is on.
  await page.locator('[data-cut-add=custom]').click();
  st = await state();
  const custom = st.planes[2];
  assert.equal(custom.kind, 'custom'); assert.equal(st.active, custom.id);
  assert.ok(Math.abs(custom.normal[1]) < 1e-9 && offStep(turnOf(custom.normal), 15) < 1e-4);
  const toCamera = await page.evaluate(() => { const c = window.testScene.children.find(o => o.isTransformControlsRoot).controls.camera; const d = c.getWorldDirection(c.position.clone()); return [-d.x, -d.z]; });
  assert.ok(custom.normal[0] * toCamera[0] + custom.normal[2] * toCamera[1] > 0, 'it cuts away the side nearest the camera');
  assert.equal((await scene()).clip, 3);

  // A saved view keeps every plane and brings them back.
  const want = (await state()).planes.map(p => ({ kind: p.kind, normal: p.normal.map(c => Math.round(c * 1e6) / 1e6), d: Math.round(p.d * 1e6) / 1e6 }));
  await page.locator('.v-views [data-view-add], .v-views .v-view-add').first().click();
  await page.locator('[data-cut-remove]').click();
  await page.locator('[data-cut-remove]').click();
  assert.equal((await state()).planes.length, 1);
  await page.locator('.v-views [role=tab]').first().click();
  await page.waitForTimeout(900);
  st = await state();
  assert.deepEqual(st.planes.map(p => ({ kind: p.kind, normal: p.normal.map(c => Math.round(c * 1e6) / 1e6), d: Math.round(p.d * 1e6) / 1e6 })), want);
  assert.equal((await scene()).clip, 3);

  // PLANES hides the floating planes and handles; the cut itself stays.
  await page.locator('[data-cut-sheets]').click();
  sc = await scene();
  assert.deepEqual([sc.sheetsShown, sc.handles, sc.clip], [false, 0, 3]);
  await page.locator('[data-cut-sheets]').click();
  assert.deepEqual([(await scene()).sheetsShown, (await scene()).handles], [true, 2]);

  // The cuts stay with the property when the view is left and opened again.
  await page.locator('#rail a[data-view=plan]').click();
  await page.locator('#rail a[data-view=model]').click();
  await page.waitForFunction(() => window.testScene?.getObjectByName('section planes')?.children.length === 3);
  assert.equal((await scene()).clip, 3);

  // The phone panel's direction choice swaps the active plane for a fresh one of that kind.
  const phone = await page.evaluate(async () => {
    const v = await import('/js/viewer3d.js');
    v.fieldAction('section-kind', 'front');
    const s = v.fieldState().section;
    v.fieldAction('section-height', null, s.min + 1);
    return { kinds: s.kinds.filter(k => k.on).map(k => k.id), labels: s.kinds.map(k => k.label), min: s.min, state: v.sectionState() };
  });
  assert.deepEqual(phone.kinds, ['front']);
  assert.deepEqual(phone.labels, ['Up and down', 'Side to side', 'Front to back', 'Custom']);
  assert.equal(phone.state.planes.length, 3);
  const front = phone.state.planes.find(p => p.id === phone.state.active);
  assert.ok(Math.abs(front.normal[2] - 1) < 1e-9 && Math.abs(front.d - (phone.min + 1)) < 1e-9, 'a front-to-back cut, slid by the phone slider');

  // Removing the last plane turns the section off.
  for (let i = 0; i < 3; i++) await page.locator('[data-cut-remove]').click();
  st = await state(); sc = await scene();
  assert.equal(st.on, false); assert.equal(st.planes.length, 0);
  assert.deepEqual([sc.sheets, sc.clip, sc.handles], [0, 0, 0]);
  assert.equal(await bar.isVisible(), false);
  assert.equal(await page.locator('[data-section]').getAttribute('class'), 'v-pill ');

  assert.deepEqual(errors, []);
  console.log('ok   section planes: flat, side-to-side and custom cuts clip together; the arrow slides and the rings turn a plane; SNAP holds 5 cm and 15 degrees and frees them when off; flip, slider, saved view, hidden planes, remount and removal');
} finally { await browser.close(); server.close(); }

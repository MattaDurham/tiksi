// Planar mirrors in a real WebGL renderer. The targets face the mirror and are invisible
// directly: their reflected image must land where independently reflected world points
// project, including a moved camera, transformed model, grouping and section clipping.
// Every scene and byte used here is synthetic; no owner stores or project files are read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harness = `<!doctype html><html><head><script type="importmap">{"imports":{"three":"/vendor/three.module.min.js","three/addons/":"/vendor/addons/"}}</script></head><body></body></html>`;
const server = createServer(async (req, res) => {
  const requestPath = decodeURIComponent(req.url.split('?')[0]);
  if (requestPath === '/mirror-test.html') { res.setHeader('Content-Type', 'text/html'); res.end(harness); return; }
  const path = resolve(root, '.' + (requestPath === '/' ? '/index.html' : requestPath));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(path);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' })[extname(path)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /WebGL|shader|GL_/.test(m.text())) errors.push(m.text()); });
  await page.goto(url + '/mirror-test.html');
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { ModelMirrors } = await import('/js/model-mirrors.js');
    const { ModelBatches } = await import('/js/model-batch.js');
    const width = 640, height = 480;
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;
    document.body.append(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202020);
    const camera = new THREE.PerspectiveCamera(48, width / height, 0.05, 100);
    const wrapper = new THREE.Group(), inner = new THREE.Group(); wrapper.add(inner); scene.add(wrapper);
    Object.assign(wrapper.userData, { scanId: 'synthetic-mirror', scanKind: 'mesh', inner });
    const material = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 1, roughness: 0.05, side: THREE.DoubleSide });
    material.userData.tiksiMirror = { type: 'planar' };
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.2), material);
    surface.name = 'Test reflector'; inner.add(surface);
    // Ordinary metallic planes have the same PBR values but no explicit mirror declaration.
    const ordinaryMaterial = material.clone(); ordinaryMaterial.userData = {};
    const ordinary = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), ordinaryMaterial);
    ordinary.position.set(2.7, 0, 0); inner.add(ordinary);
    // Stress coplanar source/overlay drawing: any source fragments leaking through the
    // reflection are bright white, while the reflected scene contains no white surfaces.
    material.emissive.setHex(0xffffff);
    const target = (color, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ color }));
      mesh.position.set(x, y, z); mesh.rotation.y = Math.PI; inner.add(mesh); return mesh;
    };
    const red = target(0xff0000, 0.7, 0.35, 1.5), green = target(0x00ff00, -0.6, -0.45, 2.5);
    // Enough equal-look objects for the actual batching path to replace source drawables.
    const fillerMaterial = new THREE.MeshBasicMaterial({ color: 0x202020 });
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), fillerMaterial);
      m.position.set(-2 + i * 0.1, -2.5, 1); inner.add(m);
    }
    const models = { synthetic: wrapper };
    let mirrors = new ModelMirrors(); scene.add(mirrors.root);
    const batches = new ModelBatches(); scene.add(batches.root);
    const geometry = surface.geometry, parent = surface.parent, children = [...inner.children];
    const sourcePositions = Array.from(geometry.attributes.position.array);
    const sourceFlags = [];
    const image = () => {
      const gl = renderer.getContext(), bytes = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      const locate = channel => {
        let count = 0, x = 0, y = 0;
        for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
          const i = (py * width + px) * 4, c = bytes[i + channel];
          if (c > 100 && c > bytes[i + (channel === 0 ? 1 : 0)] * 2.5 && c > bytes[i + 2] * 2.5) { count++; x += px; y += height - 1 - py; }
        }
        return { count, x: count ? x / count : null, y: count ? y / count : null };
      };
      let whiteInsideMirror = 0;
      for (let y = 80; y < 400; y++) for (let x = 150; x < 490; x++) {
        const i = (y * width + x) * 4;
        if (bytes[i] > 200 && bytes[i + 1] > 200 && bytes[i + 2] > 200) whiteInsideMirror++;
      }
      return { red: locate(0), green: locate(1), whiteInsideMirror, center: [...bytes.slice((240 * width + 320) * 4, (240 * width + 320) * 4 + 4)] };
    };
    const expected = mesh => {
      const point = mesh.getWorldPosition(new THREE.Vector3());
      const planePoint = surface.getWorldPosition(new THREE.Vector3());
      const normal = new THREE.Vector3(0, 0, 1).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(surface.matrixWorld));
      point.addScaledVector(normal, -2 * new THREE.Vector3().subVectors(point, planePoint).dot(normal));
      point.project(camera);
      return { x: (point.x + 1) * width / 2 - 0.5, y: (1 - point.y) * height / 2 - 0.5 };
    };
    const pose = x => {
      wrapper.updateMatrixWorld(true);
      camera.position.copy(new THREE.Vector3(x, 0, 5).applyMatrix4(wrapper.matrixWorld));
      camera.up.copy(new THREE.Vector3(0, 1, 0).transformDirection(wrapper.matrixWorld));
      camera.lookAt(new THREE.Vector3().applyMatrix4(wrapper.matrixWorld));
      camera.updateMatrixWorld(true);
    };
    const draw = ({ enabled = true, grouped = true } = {}) => {
      scene.updateMatrixWorld(true);
      mirrors.update(models, camera, { enabled, textureSize: 512 });
      batches.setEnabled(grouped);
      batches.beginFrame(models);
      const before = { color: material.colorWrite, depth: material.depthWrite, visible: material.visible };
      try { mirrors.render(renderer, scene, camera); mirrors.draw(() => renderer.render(scene, camera)); }
      finally { batches.endFrame(); }
      sourceFlags.push({ before, after: { color: material.colorWrite, depth: material.depthWrite, visible: material.visible }, ordinary: { color: ordinaryMaterial.colorWrite, depth: ordinaryMaterial.depthWrite, visible: ordinaryMaterial.visible } });
      return { ...image(), expected: { red: expected(red), green: expected(green) }, proxies: batches.stats().proxies, mirrors: mirrors.stats() };
    };
    pose(0);
    const first = draw(), plain = draw({ grouped: false });
    pose(1.1);
    const moved = draw();
    wrapper.position.set(1.3, 0.4, -0.6); wrapper.rotation.set(0, 0.55, 0.14); wrapper.scale.set(1.1, 0.9, 1.2);
    pose(-0.7);
    const transformed = draw();
    inner.visible = false;
    const hidden = draw(); inner.visible = true;
    const disabled = draw({ enabled: false });
    // A global section clipping plane removes the red half of the reflected room, while
    // retaining the green half. The same world plane clips the original model and reflection.
    wrapper.position.set(0, 0, 0); wrapper.rotation.set(0, 0, 0); wrapper.scale.set(1, 1, 1); pose(0);
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)];
    const clipped = draw(); renderer.clippingPlanes = [];
    const afterClip = draw();
    const intact = surface.geometry === geometry && surface.material === material && surface.parent === parent &&
      children.every((child, i) => inner.children[i] === child) && inner.children.length === children.length &&
      sourcePositions.every((v, i) => geometry.attributes.position.array[i] === v) && ordinary.material === ordinaryMaterial;
    const beforeDispose = renderer.info.memory.textures;
    mirrors.dispose(); scene.remove(mirrors.root);
    const afterDispose = renderer.info.memory.textures;
    mirrors = new ModelMirrors(); scene.add(mirrors.root);
    const recreated = draw();
    mirrors.dispose(); batches.dispose(); renderer.dispose();
    return { first, plain, moved, transformed, hidden, disabled, clipped, afterClip, recreated, intact, beforeDispose, afterDispose, sourceFlags };
  });
  const matches = (shot, label) => {
    for (const name of ['red', 'green']) {
      assert.ok(shot[name].count > 40, label + ': ' + name + ' target appears only in the mirror: ' + JSON.stringify({ shot, errors }));
      const err = Math.hypot(shot[name].x - shot.expected[name].x, shot[name].y - shot.expected[name].y);
      assert.ok(err < 3, label + ': ' + name + ' reflection matches its geometrically reflected position (error ' + err.toFixed(2) + ' px)');
    }
  };
  for (const name of ['first', 'plain', 'moved', 'transformed', 'afterClip', 'recreated']) matches(result[name], name);
  assert.ok(result.first.proxies > 0, 'the grouped check actually uses drawing proxies');
  assert.equal(result.first.whiteInsideMirror, 0, 'the bright original mirror surface does not leak coplanar ghost fragments into its reflection');
  assert.equal(result.plain.whiteInsideMirror, 0, 'the unbatched mirror also draws only its reflection');
  assert.ok(Math.abs(result.first.red.x - result.moved.red.x) > 10, 'moving the camera changes the reflected target position');
  for (const name of ['hidden', 'disabled']) {
    assert.equal(result[name].red.count, 0, name + ': no red reflection remains');
    assert.equal(result[name].green.count, 0, name + ': no green reflection remains');
  }
  assert.equal(result.clipped.red.count, 0, 'section clipping removes the red reflected target');
  assert.ok(result.clipped.green.count > 40, 'section clipping preserves the green reflected target');
  assert.ok(result.intact, 'source geometry, materials, hierarchy, ordinary metallic surface and export/picking identities stay intact');
  for (const flags of result.sourceFlags) {
    assert.deepEqual(flags.before, { color: true, depth: true, visible: true }, 'source draw flags are original before each frame');
    assert.deepEqual(flags.after, flags.before, 'source draw flags are restored after reflection and the main render');
    assert.deepEqual(flags.ordinary, flags.before, 'ordinary shiny material retains all draw flags');
  }
  assert.ok(result.beforeDispose > result.afterDispose, 'disposing the mirror frees its allocated reflection texture');

  // The real viewer must retain the explicit material declaration through GLB parsing,
  // material sharing, its composer and a saved/reloaded project, not just the helper scene.
  await page.goto(url + '/#/plan');
  await page.locator('#btn-file').waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const { writeGlb } = await import('/tools/synthetic-model.mjs');
    const plane = { positions: [-1.8, -1.6, 0, 1.8, -1.6, 0, 1.8, 1.6, 0, -1.8, 1.6, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3] };
    const little = { ...plane, positions: plane.positions.map((v, i) => i % 3 === 2 ? v : v * 0.1) };
    const { glb } = writeGlb({
      looks: [{ name: 'Declared surface', color: [0.6, 0.6, 0.6, 1], metalness: 1, roughness: 0.05, doubleSided: true }, { name: 'Red target', color: [1, 0, 0, 1], unlit: true }],
      meshes: [{ geometry: plane, look: 0 }, { geometry: little, look: 1 }],
      nodes: [{ name: 'Planar mirror', mesh: 0, translation: [0, 2, 0], tag: 'Reflectors' }, { name: 'Target facing mirror', mesh: 1, translation: [0.7, 2.35, 1.5], rotation: [0, 1, 0, 0], tag: 'Targets' }],
    });
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength), n = dv.getUint32(12, true);
    const doc = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + n)));
    doc.materials[0].extras = { tiksiMirror: { type: 'planar' } };
    const json = new TextEncoder().encode(JSON.stringify(doc)), padded = (json.length + 3) & ~3;
    const rewritten = new Uint8Array(20 + padded + glb.length - 20 - n), out = new DataView(rewritten.buffer);
    rewritten.set(glb.subarray(0, 20)); out.setUint32(8, rewritten.length, true); out.setUint32(12, padded, true);
    rewritten.fill(32, 20, 20 + padded); rewritten.set(json, 20); rewritten.set(glb.subarray(20 + n), 20 + padded);
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Synthetic mirror room'); p.id = 'prop-reflection';
    p.env.quality = 'high'; p.env.showGrid = false; p.env.showCeilings = true;
    p.scans.push({ id: 'scan-reflection', name: 'Reflection fixture.glb', format: 'glb', kind: 'mesh', pos: [0, 0, 0], rot: [0, 0, 0], rotY: 0, scale: 1, visible: true });
    await s.putFile('scan-reflection', rewritten.buffer, { format: 'glb' });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch(); s.save();
  });
  await page.locator('#rail a[data-view="model"]').click({ noWaitAfter: true });
  const ready = async () => {
    await page.locator('canvas.v-canvas').waitFor();
    await page.waitForFunction(async () => {
      const v = await import('/js/viewer3d.js'), s = await import('/js/store.js');
      return v.viewerIdle() && Object.keys(s.activeProperty().tagOf || {}).some(k => k.startsWith('node:scan-reflection'));
    }, null, { timeout: 90_000 });
  };
  const viewerRed = () => page.evaluate(async () => {
    const v = await import('/js/viewer3d.js');
    v.frameBrightness({ view: { position: [0, 2, 5], target: [0, 2, 0] } });
    v.drawStats();
    const source = document.querySelector('canvas.v-canvas'), c = document.createElement('canvas');
    c.width = source.width; c.height = source.height;
    const ctx = c.getContext('2d'); ctx.drawImage(source, 0, 0);
    const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < bytes.length; i += 4) if (bytes[i] > 100 && bytes[i] > bytes[i + 1] * 2.5 && bytes[i] > bytes[i + 2] * 2.5) red++;
    return red;
  });
  await ready();
  const actualRed = await viewerRed();
  const actualMirrors = await page.evaluate(async () => (await import('/js/viewer3d.js')).mirrorStats());
  assert.ok(actualRed > 40, 'actual viewer/composer draws the reflected target from explicit GLB metadata: ' + JSON.stringify({ red: actualRed, mirrors: actualMirrors, errors }));
  const canvasBox = await page.locator('canvas.v-canvas').boundingBox();
  await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.locator('.inspector .op-name').waitFor();
  assert.equal(await page.locator('.inspector .op-name').innerText(), 'Planar mirror', 'picking the reflected surface selects the original model part');
  assert.ok(await viewerRed() > 40, 'selection outlines and high-quality shading retain the reflected target');
  await page.keyboard.press('Escape');
  const mirrorTag = await page.evaluate(async () => (await import('/js/store.js')).activeProperty().tags.find(t => t.name === 'Reflectors').id);
  await page.locator('#side [data-act=tag-list]').click();
  await page.locator(`.v-tags [data-tag-eye="${mirrorTag}"]`).click();
  assert.equal(await viewerRed(), 0, 'hiding the mirror tag removes the actual viewer reflection');
  await page.locator(`.v-tags [data-tag-eye="${mirrorTag}"]`).click();
  await page.evaluate(async () => (await import('/js/store.js')).save());
  await page.reload();
  await ready();
  assert.ok(await viewerRed() > 40, 'the saved project reloads with its planar reflection intact');
  assert.deepEqual(errors, [], 'no browser exceptions');
  console.log('Planar mirrors: reflected-camera positions, model transforms, grouping, visibility, clipping, identity and disposal passed.');
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}

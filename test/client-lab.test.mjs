// The client page in the lab: walking by tap (walk-hops.js) and the copy SEND TO THE LAB makes
// (lab-publish.js): what goes in, what is left out, and the send settings. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
    return next(spec, ctx);
  },
});
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
store.ws.data = store.emptyWorkspace();
const W = await import('../js/walk-hops.js');
const L = await import('../js/lab-publish.js');
const { hints } = await import('../js/texture-synth.js');

// Two rooms side by side along x, a wall between them at x = 4 with a door in its middle, a
// window in the outer wall.
function house() {
  return {
    id: 'p1', name: '12 Test Lane', levels: [{ id: 'L1', name: 'Main', elevation: 0 }],
    walls: [
      { id: 'w-mid', ax: 4, ay: 0, bx: 4, by: 4, thickness: 0.12, level: 'L1' },
      { id: 'w-out', ax: 0, ay: 0, bx: 8, by: 0, thickness: 0.15, level: 'L1', baseboardPosEvidence: { status: 'estimate', sources: ['keyframes/1.jpg'] }, product: { productId: 'prod-x', brand: 'Brandname' } },
    ],
    openings: [
      { id: 'o-door', wallId: 'w-mid', type: 'door', t: 0.5, width: 0.8, height: 2.03 },
      { id: 'o-win', wallId: 'w-out', type: 'window', t: 0.25, width: 1, height: 1.2, sill: 0.8 },
    ],
    rooms: [{ id: 'r-a', name: 'Den', pts: [[0, 0], [4, 0], [4, 4], [0, 4]], material: 'mat-oak' }],
    fixtures: [],
    trims: [
      { id: 't-base', wallId: 'w-mid', style: 'baseboard', side: 1, f0: 0, f1: 1, y: 0 },
      { id: 't-rail', wallId: 'w-mid', style: 'chair-rail', side: 1, f0: 0, f1: 1, y: 0.84, projectId: 'pj-entry' },
      { id: 't-other', wallId: 'w-mid', style: 'chair-rail', side: -1, f0: 0, f1: 1, y: 0.84, projectId: 'pj-kitchen' },
    ],
    scans: [
      { id: 's-capture', name: 'polycam capture.glb', kind: 'mesh', layer: 'scan', format: 'glb' },
      { id: 's-furn', name: 'furnishings.glb', kind: 'mesh', layer: 'furnishings', format: 'glb', componentProducts: { a: { productId: 'prod-sofa' } } },
      { id: 's-stair', name: 'stair.glb', kind: 'mesh', format: 'glb', projectId: 'pj-trim' },
      { id: 's-off', name: 'old.glb', kind: 'mesh', format: 'glb', visible: false },
    ],
    tags: [{ id: 'tag-furniture', name: 'Furniture and fixtures' }, { id: 'tag-decor', name: 'Decor and soft goods' }, { id: 'tag-walls', name: 'Walls' }, { id: 'tag-scan', name: 'Scan capture' }],
    photos: [{ id: 'ph-site', name: 'IMG_1.jpeg', pin: { x: 1 } }, { id: 'ph-oak', name: 'oak.jpg', mime: 'image/jpeg' }],
    notePins: [{ id: 'n1', text: 'Client wants it cheaper', x: 0, y: 0, z: 0 }],
    savedViews: [{ id: 'v1', name: 'Entry', camera: { position: [1, 1.6, 1], target: [3, 1.4, 3], fov: 50 }, mode: 'orbit', tags: { 'tag-walls': false }, section: { on: true, height: 1 }, xray: true, hiddenLevels: [], hidden: ['wall:w-out'] }],
    hidden: { 'wall:w-out': true }, notes: 'private notes', onePager: { pitch: 'secret' },
    env: { quality: 'high', showPins: true, showNotes: true, sky: 'pano', panoPhotoId: 'ph-site' },
  };
}
function workspace() {
  return {
    version: 2, properties: [house()],
    materials: [{ id: 'mat-oak', custom: true, name: 'Red oak strip floor, wide plank (Bruce D04, $5.99/sf)', pattern: 'photo', photoId: 'ph-oak', color: '#946e45', product: { productId: 'prod-oak' }, colorName: 'Natural' },
      { id: 'mat-unused', custom: true, name: 'Unused', pattern: 'flat', color: '#fff' }],
    products: [{ id: 'prod-oak', name: 'Bruce D04', price: 5.99 }],
    projects: [
      { id: 'pj-trim', propertyId: 'p1', name: 'Wall trim: wainscoting and rails (design v1)', parentId: '', items: [{ id: 'i1', name: 'Rails', cost: 900 }], notes: 'margin 30%' },
      { id: 'pj-entry', propertyId: 'p1', name: 'Entry', parentId: 'pj-trim', items: [] },
      { id: 'pj-kitchen', propertyId: 'p1', name: 'Kitchen', parentId: '', items: [] },
    ],
  };
}

test('doorways are doors and openings, not windows, with an arrow on each side pointing through', () => {
  const d = W.doorways(house());
  assert.deepEqual(d.map(x => x.id), ['o-door']);
  assert.deepEqual([d[0].x, d[0].z], [4, 2]);
  const [a, b] = W.doorwayArrows(d[0]);
  // The wall runs along +z, so its left normal is -x: side 1 is west, side -1 is east.
  assert.ok(a.x < 4 && b.x > 4);
  assert.ok(a.dx > 0 && a.to.x > 4, 'the west arrow points east, into the other room');
  assert.ok(b.dx < 0 && b.to.x < 4);
});

test('a person sees the arrow on their own side of each nearby doorway', () => {
  const near = W.arrowsNear(house(), 1, 2, 0);
  assert.equal(near.length, 1);
  assert.ok(near[0].x < 4, 'the arrow in this room, not the one behind the wall');
  assert.equal(W.arrowsNear(house(), 1, 2, 3).length, 0, 'another floor sees none');
  assert.equal(W.arrowsNear(house(), -20, 2, 0).length, 0, 'out of range');
});

test('a tap walks to the point, or stops short of a wall in the way', () => {
  assert.deepEqual(W.walkTarget({ x: 0, z: 0 }, { x: 3, z: 4 }), { x: 3, z: 4, dist: 5 });
  const short = W.walkTarget({ x: 0, z: 0 }, { x: 5, z: 0 }, 2);
  assert.ok(Math.abs(short.x - (2 - W.STOP_SHORT)) < 1e-9);
  assert.equal(W.walkTarget({ x: 0, z: 0 }, { x: 0.1, z: 0 }), null, 'too close to bother');
  assert.equal(W.walkTarget({ x: 0, z: 0 }, { x: 3, z: 0 }, 0.4), null, 'a wall right there');
  assert.ok(W.glideMs(0.2) >= 380 && W.glideMs(100) <= 2600);
});

test('the copy keeps the house and the chosen projects, and leaves the rest out', () => {
  const data = workspace();
  const { copy, send } = L.clientCopy(data, 'p1', { projects: [{ id: 'pj-trim', label: 'Wall trim' }], furnitureTags: ['tag-furniture', 'tag-decor', 'tag-gone'] });
  const p = copy.property;
  assert.equal(copy.format, 'tiksi-client');
  assert.deepEqual(p.trims.map(t => t.id), ['t-base', 't-rail'], 'the kitchen project was not sent, so its trim is not in the copy');
  assert.deepEqual(p.scans.map(s => s.id), ['s-furn', 's-stair'], 'no scan capture and no model switched off');
  assert.deepEqual(copy.states, [{ id: 'pj-trim', label: 'Wall trim' }]);
  assert.deepEqual(copy.projects.map(x => [x.id, x.parentId, x.name, x.items.length]), [['pj-trim', '', '', 0], ['pj-entry', 'pj-trim', '', 0]]);
  assert.deepEqual(copy.furnitureTags, ['tag-furniture', 'tag-decor']);
  assert.deepEqual(send.map(f => f.id).sort(), ['ph-oak', 's-furn', 's-stair']);
  assert.deepEqual(p.photos.map(x => x.id), ['ph-oak'], 'only the texture picture');
  assert.equal(p.name, '');
  assert.deepEqual(p.notePins, []);
  assert.equal(p.env.showPins, false); assert.equal(p.env.sky, 'dynamic'); assert.equal(p.env.panoPhotoId, null);
  assert.deepEqual(p.hidden, { 'wall:w-out': true }, 'what MODEL hid stays hidden');
  assert.deepEqual(p.savedViews[0], { id: 'v1', name: 'Entry', camera: { position: [1, 1.6, 1], target: [3, 1.4, 3], fov: 50 }, mode: 'orbit', tags: {}, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] });
  assert.equal(p.tags.find(t => t.id === 'tag-scan').visible, false);
  assert.deepEqual(copy.materials.map(m => m.id), ['mat-oak']);
  const text = JSON.stringify(copy);
  for (const secret of ['Brandname', 'prod-', 'Bruce', '5.99', 'margin', 'private notes', 'Client wants', 'secret', 'keyframes', 'Evidence', 'IMG_1', 'Natural', 'polycam', '12 Test Lane'])
    assert.ok(!text.includes(secret), 'the copy must not carry ' + secret);
});

test('a material keeps the words that set its texture, not its product name', () => {
  const data = workspace();
  const { copy } = L.clientCopy(data, 'p1', { projects: [], furnitureTags: [] });
  const m = copy.materials[0];
  assert.deepEqual(hints(m), hints(data.materials[0]), 'the texture looks the same');
  assert.equal(m.name, 'wide');
});

test('send settings: the page name, short project names and furniture tags', () => {
  const data = workspace();
  const prop = data.properties[0];
  prop.trims[1].projectId = 'pj-entry';
  const s = L.labSettings(prop, data.projects);
  assert.equal(s.slug, '12-test-lane');
  assert.deepEqual(s.projects.map(p => [p.id, p.label, p.on]), [['pj-trim', 'Wall trim', true], ['pj-kitchen', 'Kitchen', true]]);
  assert.deepEqual(s.furnitureTags, ['tag-furniture', 'tag-decor']);
  prop.lab = { slug: 'test-lane', projects: [{ id: 'pj-kitchen', label: 'New kitchen' }], furnitureTags: ['tag-walls'] };
  const again = L.labSettings(prop, data.projects);
  assert.equal(again.slug, 'test-lane');
  assert.deepEqual(again.projects.map(p => [p.id, p.label, p.on]), [['pj-trim', 'Wall trim', false], ['pj-kitchen', 'New kitchen', true]]);
  assert.deepEqual(again.furnitureTags, ['tag-walls']);
  assert.equal(L.slugify('Café & Bar, 2nd fl.'), 'cafe-and-bar-2nd-fl');
  assert.equal(L.shortName('Wall trim: wainscoting (v1)'), 'Wall trim');
});

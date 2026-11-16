// The client page of a property in the lab on thedurham.nyc (client.html). It is Tiksi's own
// frame with MODEL alone, in client mode (viewer3d.js setClientMode): the same top bar, left
// pane and saved-view tabs on a computer, the same three-line button and side panel on a phone
// (field.js), with little plugged in: the saved views, orbit or walk, Existing or one of the
// projects sent, and furniture on or off. Nothing can be selected, changed or saved. More of
// Tiksi is meant to be switched on here later, the same way.
//
// `data` is the copy SEND TO THE LAB made (lab-publish.js): property.json and files/<id>.<ext>
// (models, texture pictures), views/ (a small picture of each saved view, per project) and
// renderings/ (the renderings sent with a view). `app` is the folder of the code (js/, css/,
// vendor/). The saved views show as a strip of small pictures under the model
// (client-strip.js): a click goes to the view and opens its projects and renderings.
//
// SEND TO THE LAB also opens this page in a small frame on the Mac to take the saved views'
// pictures (startPictures, lab-pictures.js): the same page, handed the copy instead of
// fetching it, so a picture shows exactly what a client sees.

import { ws, replaceWorkspace, useDiskPersistence, setFileBackend, useMemoryFiles } from './store.js';
import { ensureBuiltinMaterials } from './materials.js';
import { setHidden, setTagShown, planKey } from './tags.js';
import { PIECE_KINDS, EXISTING, stateShows } from './project-pieces.js';
import { initTiksiMenu } from './tiksi-menu.js';
import { initField, fieldRouted } from './field.js';
import * as viewer3d from './viewer3d.js';
import { mountStrip } from './client-strip.js';
import { picturesDiffer } from './view-renderings.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// `copy` and `read(id)` stand in for `data` when the copy is handed over (startPictures);
// `strip: false` leaves the strip of view pictures off.
export async function startClient({ app, data, wait, copy: given = null, read = null, strip = true }) {
  for (const css of ['console.css', 'viewer.css', 'field.css', 'client.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = app + 'css/' + css;
    document.head.append(link);
    await new Promise(r => { link.onload = link.onerror = r; });
  }
  document.documentElement.classList.add('tiksi-client');
  let copy = given;
  if (!copy) {
    const res = await fetch(data + 'property.json');
    if (!res.ok) throw new Error('The sent copy could not be read (' + res.status + ')');
    copy = await res.json();
  }
  if (copy.format !== 'tiksi-client' || !copy.property) throw new Error('Not a Tiksi client copy');

  // Files come from the copy's folder; nothing is kept in this browser.
  useDiskPersistence({ changed() {} });
  useMemoryFiles();
  const files = copy.files || {};
  setFileBackend({
    changed() {},
    async read(id) {
      const f = files[id];
      if (!f) return null;
      if (read) {
        const got = await read(id);
        if (!got || !got.buffer) throw new Error('A model file is missing from the copy');
        return { id, buffer: got.buffer, format: f.format, mime: f.mime, name: '', owned: true };
      }
      const r = await fetch(data + f.path);
      if (!r.ok) throw new Error('A model file is missing from the sent copy');
      return { id, buffer: await r.arrayBuffer(), format: f.format, mime: f.mime, name: '', owned: true };
    },
  });
  replaceWorkspace({
    version: copy.schema, settings: { units: 'imperial', inchPrecision: 16, mmPrecision: 1, activePropertyId: copy.property.id },
    properties: [copy.property], materials: copy.materials || [], products: [], projects: copy.projects || [],
  });
  ensureBuiltinMaterials();
  const prop = ws.data.properties[0];
  // What MODEL had hidden when it was sent stays hidden whatever the client picks.
  const keepHidden = new Set(Object.keys(prop.hidden || {}));

  const state = { show: EXISTING, furniture: true };
  const furnitureTags = copy.furnitureTags || [];
  const apply = () => applyShown(prop, state, furnitureTags, keepHidden);
  const states = [{ id: EXISTING, label: 'Existing' }, ...(copy.states || [])];
  let pictures = null;   // the strip of view pictures, once the model's frame is on the page
  const setShow = id => { if (!states.some(s => s.id === id)) return; state.show = id; apply(); if (pictures) pictures.refresh(); };
  viewer3d.setClientMode(true, {
    states,
    hasFurniture: furnitureTags.length > 0,
    show: () => state.show, setShow,
    furniture: () => state.furniture, setFurniture: on => { state.furniture = !!on; apply(); },
    viewsChanged: (view, shown) => { if (pictures) pictures.refresh({ view, shown }); },
  });

  // Tiksi's frame: the tabs and left pane on a computer, the phone layout on a phone.
  initTiksiMenu({ client: true });
  initField();
  viewer3d.mount(document.getElementById('view'));
  fieldRouted('model');
  // A version picked in the strip goes through the viewer, so the left pane marks it too.
  if (strip) pictures = mountStrip({ copy, data, states, show: () => state.show, setShow: id => viewer3d.fieldAction('client-show', id), goTo: id => viewer3d.fieldAction('view', id) });
  apply();
  const first = (prop.savedViews || [])[0];
  if (first) viewer3d.fieldAction('view', first.id);
  // The page shows once the model has its first frame; the models keep arriving after that.
  const until = performance.now() + 20000;
  while (performance.now() < until) {
    const s = viewer3d.viewerIdleState();
    if (s.mounted && s.firstFrame) break;
    await sleep(80);
  }
  if (wait) wait.remove();
  return { prop, state, setShow };
}

// ---------- the saved views' pictures, taken on the Mac (lab-pictures.js) ----------
// Tiksi's frame as client.html has it, for a page that starts without one.
const FRAME = `<div id="app">
  <header id="topbar"><div class="brand" title="tiksi"><span class="brand-mark">TIKSI</span></div>
    <nav id="rail" aria-label="Pages"><a href="#/model" data-view="model" class="active">MODEL</a></nav></header>
  <aside id="side" aria-label="Views" hidden></aside>
  <main id="view"></main>
</div>`;

// Wait until the model has everything that shows loaded and drawn; after `ms` (five minutes: a
// large house loads a second time here) carry on anyway. Taking a picture waits another minute
// for models and textures itself, and says so if they never come.
async function settled(beat, ms = 300000) {
  const until = performance.now() + ms;
  await sleep(150);
  let said = performance.now();
  while (performance.now() < until) {
    if (viewer3d.viewerIdle()) return;
    if (performance.now() - said > 2000) { said = performance.now(); beat(); }
    await sleep(100);
  }
}

// Open `copy` as the client page and take a picture of every saved view under Existing and
// under each project. `read(id)` gives a file of the copy; `progress(text, fraction)` hears how
// far it is. Resolves to { size, count, views: { view id: { state id: ArrayBuffer (JPEG) } } }.
// A project that shows a view the same as Existing does has no picture of it.
export async function startPictures({ copy, read, size, progress = () => {} }) {
  if (!document.getElementById('app')) document.body.insertAdjacentHTML('afterbegin', FRAME);
  progress('Opening the client page to take the pictures of the views…', 0);
  const client = await startClient({ app: new URL('../', import.meta.url).href, copy, read, strip: false });
  const views = copy.property.savedViews || [];
  const stateIds = [EXISTING, ...(copy.states || []).map(s => s.id)];
  const total = views.length * stateIds.length, out = {}, existing = new Map();
  let done = 0, count = 0;
  for (const stateId of stateIds) {
    client.setShow(stateId);
    await settled(() => progress('Loading the models the client page shows…', done / total));
    for (const v of views) {
      progress('Taking the picture of the view "' + v.name + '" (' + (done + 1) + ' of ' + total + ')…', done / total);
      const canvas = await viewer3d.viewPicture(v.id, size.width, size.height);
      done++;
      const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      if (stateId === EXISTING) existing.set(v.id, px);
      else if (!picturesDiffer(existing.get(v.id), px)) continue;
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (!blob) throw new Error('a picture could not be saved');
      (out[v.id] = out[v.id] || {})[stateId] = await blob.arrayBuffer();
      count++;
    }
  }
  progress('The pictures of the views are taken.', 1);
  return { size, count, views: out };
}
export function endPictures() { try { viewer3d.unmount(); } catch (e) { console.warn(e); } }

// What the client sees: the pieces of the chosen state (project-pieces.js) and the furniture
// tags on or off. The copy carries only the projects that were sent.
function applyShown(prop, state, furnitureTags, keepHidden) {
  const shows = stateShows(ws.data.projects, state.show);
  const hide = [], show = [];
  for (const [kind, key] of Object.entries(PIECE_KINDS)) {
    for (const rec of prop[key] || []) {
      if (kind === 'scan') { rec.visible = shows(rec); continue; }
      const keys = kind === 'room' ? [planKey('room', rec.id), planKey('ceiling', rec.id)] : [planKey(kind, rec.id)];
      (shows(rec) ? show : hide).push(...keys);
    }
  }
  setHidden(prop, hide, true);
  setHidden(prop, show.filter(k => !keepHidden.has(k)), false);
  for (const id of furnitureTags) setTagShown(prop, id, state.furniture);
  viewer3d.fieldAction('refresh-shown');
}

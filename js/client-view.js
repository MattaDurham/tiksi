// The client page of a property in the lab on thedurham.nyc (client.html). It is Tiksi's own
// frame with MODEL alone, in client mode (viewer3d.js setClientMode): the same top bar, left
// pane and saved-view tabs on a computer, the same three-line button and side panel on a phone
// (field.js), with little plugged in: the saved views, orbit or walk, Existing or one of the
// projects sent, and furniture on or off. Nothing can be selected, changed or saved. More of
// Tiksi is meant to be switched on here later, the same way.
//
// `data` is the copy SEND TO THE LAB made (lab-publish.js): property.json and files/<id>.<ext>
// (models, texture pictures). `app` is the folder of the code (js/, css/, vendor/).

import { ws, replaceWorkspace, useDiskPersistence, setFileBackend, useMemoryFiles } from './store.js';
import { ensureBuiltinMaterials } from './materials.js';
import { setHidden, setTagShown, planKey } from './tags.js';
import { PIECE_KINDS, EXISTING, stateShows } from './project-pieces.js';
import { initTiksiMenu } from './tiksi-menu.js';
import { initField, fieldRouted } from './field.js';
import * as viewer3d from './viewer3d.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function startClient({ app, data, wait }) {
  for (const css of ['console.css', 'viewer.css', 'field.css', 'client.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = app + 'css/' + css;
    document.head.append(link);
    await new Promise(r => { link.onload = link.onerror = r; });
  }
  document.documentElement.classList.add('tiksi-client');
  const res = await fetch(data + 'property.json');
  if (!res.ok) throw new Error('The sent copy could not be read (' + res.status + ')');
  const copy = await res.json();
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
  viewer3d.setClientMode(true, {
    states: [{ id: EXISTING, label: 'Existing' }, ...(copy.states || [])],
    hasFurniture: furnitureTags.length > 0,
    show: () => state.show, setShow: id => { state.show = id; apply(); },
    furniture: () => state.furniture, setFurniture: on => { state.furniture = !!on; apply(); },
  });

  // Tiksi's frame: the tabs and left pane on a computer, the phone layout on a phone.
  initTiksiMenu({ client: true });
  initField();
  viewer3d.mount(document.getElementById('view'));
  fieldRouted('model');
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
  return { prop, state };
}

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

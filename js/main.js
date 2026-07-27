// App shell: routing, topbar, property management, persistence wiring.

import { ws, load, save, touch, onChange, uid, activeProperty, replaceWorkspace, exportWorkspace, escapeHtml } from './store.js';
import { ensureBuiltinMaterials } from './materials.js';
import { demoWorkspace } from './demo.js';
import * as plan2d from './plan2d.js';
import * as viewer3d from './viewer3d.js';
import * as projects from './projects.js';
import * as products from './products.js';
import * as budget from './budget.js';
import * as schedule from './schedule.js';
import * as cutsheets from './cutsheets.js';

const VIEWS = {
  plan: plan2d,
  model: viewer3d,
  projects,
  products,
  budget,
  schedule,
  sheets: cutsheets,
};

let currentView = null;
let currentName = '';

function boot() {
  const had = load();
  if (!had || ws.data.properties.length === 0 && ws.data.projects.length === 0) {
    replaceWorkspace(demoWorkspace());
  }
  ensureBuiltinMaterials();
  save();

  bindTopbar();
  refreshTopbar();
  onChange(refreshTopbar);

  window.addEventListener('hashchange', route);
  route();
}

function route() {
  const name = (location.hash.replace(/^#\//, '') || 'plan');
  const view = VIEWS[name] || VIEWS.plan;
  if (currentView && currentView.unmount) currentView.unmount();
  currentName = VIEWS[name] ? name : 'plan';
  currentView = view;
  document.querySelectorAll('#rail a[data-view]').forEach(a =>
    a.classList.toggle('active', a.dataset.view === currentName));
  const root = document.getElementById('view');
  root.innerHTML = '';
  view.mount(root);
}

function remountView() {
  if (currentView && currentView.unmount) currentView.unmount();
  const root = document.getElementById('view');
  root.innerHTML = '';
  currentView.mount(root);
}

// ---------- topbar ----------
function bindTopbar() {
  const sel = document.getElementById('property-select');
  sel.onchange = () => {
    ws.data.settings.activePropertyId = sel.value;
    touch();
    remountView();
  };

  document.getElementById('property-new').onclick = () => {
    const name = prompt('New property name (street address or nickname):');
    if (!name) return;
    const p = {
      id: uid('prop'), name, notes: '', wallHeight: 2.44,
      plan: null, walls: [], openings: [], rooms: [], scans: [],
    };
    ws.data.properties.push(p);
    ws.data.settings.activePropertyId = p.id;
    touch();
    remountView();
  };

  document.querySelectorAll('#units-seg .seg-btn').forEach(b => b.onclick = () => {
    ws.data.settings.units = b.dataset.units;
    touch();
    remountView();
  });

  document.getElementById('btn-export').onclick = exportWorkspace;

  const importFile = document.getElementById('import-file');
  document.getElementById('btn-import').onclick = () => importFile.click();
  importFile.onchange = async () => {
    const file = importFile.files[0];
    importFile.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.properties)) throw new Error('not a tiksi workspace file');
      if (!confirm('Replace the current workspace with "' + file.name + '"? Export first if you want a backup.')) return;
      replaceWorkspace(data);
      ensureBuiltinMaterials();
      remountView();
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  };

  document.getElementById('btn-demo').onclick = () => {
    if (!confirm('Load the demo workspace? This replaces everything currently here (export first for a backup).')) return;
    replaceWorkspace(demoWorkspace());
    ensureBuiltinMaterials();
    remountView();
  };
}

function refreshTopbar() {
  const sel = document.getElementById('property-select');
  const d = ws.data;
  const active = activeProperty();
  sel.innerHTML = d.properties.map(p =>
    `<option value="${p.id}" ${active && p.id === active.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    || '<option value="">(no property)</option>';
  document.querySelectorAll('#units-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.units === d.settings.units));
}

boot();

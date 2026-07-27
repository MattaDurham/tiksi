// Built-in material library. Users can add custom materials; ids are stable strings
// so demo data and user models can reference them.

import { ws, uid, touch } from './store.js';

export const BUILTIN_MATERIALS = [
  { id: 'mat-drywall',  name: 'Drywall, painted',   color: '#d8d4cc', kind: 'wall'  },
  { id: 'mat-plaster',  name: 'Plaster',            color: '#cfc8bb', kind: 'wall'  },
  { id: 'mat-brick',    name: 'Brick',              color: '#9c5a44', kind: 'wall'  },
  { id: 'mat-cmu',      name: 'Concrete block',     color: '#8f9296', kind: 'wall'  },
  { id: 'mat-cedar',    name: 'Cedar siding',       color: '#a97b50', kind: 'wall'  },
  { id: 'mat-fiber',    name: 'Fiber cement siding',color: '#b9bfc3', kind: 'wall'  },
  { id: 'mat-tile-w',   name: 'Wall tile',          color: '#b8cdd2', kind: 'wall'  },
  { id: 'mat-oak',      name: 'White oak flooring', color: '#c9a06a', kind: 'floor' },
  { id: 'mat-walnut',   name: 'Walnut flooring',    color: '#6e4a33', kind: 'floor' },
  { id: 'mat-tile-f',   name: 'Porcelain tile',     color: '#a8adb0', kind: 'floor' },
  { id: 'mat-concrete', name: 'Concrete slab',      color: '#97999b', kind: 'floor' },
  { id: 'mat-carpet',   name: 'Carpet',             color: '#7d8894', kind: 'floor' },
  { id: 'mat-lvp',      name: 'Luxury vinyl plank', color: '#b39067', kind: 'floor' },
];

export function ensureBuiltinMaterials() {
  const have = new Set(ws.data.materials.map(m => m.id));
  for (const m of BUILTIN_MATERIALS) if (!have.has(m.id)) ws.data.materials.push(Object.assign({}, m));
}

export function materialsFor(kind) {
  return ws.data.materials.filter(m => !kind || m.kind === kind || m.kind === 'any');
}

export function addCustomMaterial(name, color, kind) {
  const m = { id: uid('mat'), name, color, kind: kind || 'any', custom: true };
  ws.data.materials.push(m);
  touch();
  return m;
}

export function materialSelectHtml(kind, selectedId, attrs) {
  const opts = materialsFor(kind).map(m =>
    `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${m.name}</option>`
  ).join('');
  return `<select ${attrs || ''}><option value="">(none)</option>${opts}</select>`;
}

// PRODUCTS: what the work is made of. PRODUCTS is the register of real products with their store
// pages, prices and specification documents (ESTIMATE prices boards from it); MATERIALS is each
// surface's finish, how it renders and the product behind it; TRIM CATALOG is every moulding,
// board and panel wall trim is drawn with (trim-catalog-view.js); FIND A PRODUCT researches real
// products and suppliers and saves the chosen ones to PRODUCTS.
// FLOAT opens the same parts in a window of their own over the other pages (products-float.js),
// to drag trim from the catalog into the model; opening the PRODUCTS tab puts it back.
// Addresses: #/products (?select=<id>), #/materials (?select=<id>), #/trim-catalog (?select=<id>),
// #/research.

import { hub } from './hub.js';
import { openProductsFloat, closeProductsFloat } from './products-float.js';

export const PARTS = [
  { id: 'products', label: 'PRODUCTS', icon: 'products', load: () => import('./products.js'), addr: '#/products' },
  { id: 'materials', label: 'MATERIALS', icon: 'materials', load: () => import('./materialsview.js'), addr: '#/materials' },
  { id: 'trim', label: 'TRIM CATALOG', icon: 'ruler', load: () => import('./trim-catalog-view.js'), addr: '#/trim-catalog' },
  { id: 'find', label: 'FIND A PRODUCT', icon: 'search', load: () => import('./research.js'), addr: '#/research' },
];
export const partOf = hash => /^#\/materials/.test(hash) ? 'materials' : /^#\/trim-catalog/.test(hash) ? 'trim' : /^#\/research/.test(hash) ? 'find' : 'products';

const view = hub({
  label: 'Products', parts: PARTS, partOf,
  actions: [{ id: 'float', label: 'FLOAT', icon: 'external', title: 'Open PRODUCTS in a window of its own over MODEL, to drag trim from the catalog onto the model and its panel.', run: part => openProductsFloat(part, { fromTab: true }) }],
});
export const { unmount, undo, redo, sharedChange } = view;
// One PRODUCTS at a time: the tab takes it back from the floating window.
export function mount(root) { closeProductsFloat(); view.mount(root); }

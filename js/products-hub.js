// PRODUCTS: what the work is made of. PRODUCTS is the register of real products with their store
// pages, prices and specification documents (ESTIMATE prices boards from it); MATERIALS is each
// surface's finish, how it renders and the product behind it; FIND A PRODUCT researches real
// products and suppliers and saves the chosen ones to PRODUCTS.
// Addresses: #/products (?select=<id>), #/materials (?select=<id>), #/research.

import { hub } from './hub.js';

const view = hub({
  label: 'Products',
  parts: [
    { id: 'products', label: 'PRODUCTS', icon: 'products', load: () => import('./products.js'), addr: '#/products' },
    { id: 'materials', label: 'MATERIALS', icon: 'materials', load: () => import('./materialsview.js'), addr: '#/materials' },
    { id: 'find', label: 'FIND A PRODUCT', icon: 'search', load: () => import('./research.js'), addr: '#/research' },
  ],
  partOf: hash => /^#\/materials/.test(hash) ? 'materials' : /^#\/research/.test(hash) ? 'find' : 'products',
});
export const { mount, unmount, undo, redo, sharedChange } = view;

// tiksi - show records of a page in the model beside it (MODEL BESIDE, model-beside.js).
// Pages call showInModel with the ids of rooms, walls, openings, fixtures or imported models;
// while the model is beside the page they are selected and outlined there. No imports, so a
// page and its unit tests can use it without loading the 3D viewer.

let handler = null;
const opened = new Set();   // pages waiting to show their selection when the model opens beside them

// model-beside.js plugs the open model in, and takes it out again with the returned call.
export function setModelFocus(fn) {
  handler = fn;
  for (const f of [...opened]) { try { f(); } catch (e) { console.error(e); } }
  return () => { if (handler === fn) handler = null; };
}

// Call fn each time a model opens beside the page; returns the call that stops it.
export function whenModelBeside(fn) { opened.add(fn); return () => opened.delete(fn); }

// Whether a model is beside the page now.
export function modelBeside() { return !!handler; }

// Select these ids in the model beside the page. `frame`: true moves the camera only when they
// are out of the picture, 'always' always. Returns how many the model found (0 with no model).
export function showInModel(ids, opts = {}) {
  if (!handler) return 0;
  try { return handler(ids || [], opts) || 0; }
  catch (e) { console.error('the model beside the page could not show them', e); return 0; }
}

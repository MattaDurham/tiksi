// Dragging a trim catalog entry (trim-catalog.js) out of PRODUCTS, usually from its floating
// window (products-float.js), onto something that takes it: a moulding dropdown or the trim
// panel in MODEL (trim-panel.js), or trim or a wall face in the model itself (viewer3d.js).
// The entry travels as its catalog id under a type of Tiksi's own, so nothing else on the page
// (link drops, file drops) mistakes it for theirs.

export const TRIM_TYPE = 'application/x-tiksi-trim';

export function startTrimDrag(e, id, label) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(TRIM_TYPE, id);
  e.dataTransfer.setData('text/plain', label || id);
  e.dataTransfer.effectAllowed = 'copy';
  document.documentElement.classList.add('dragging-trim');
}
export function endTrimDrag() { document.documentElement.classList.remove('dragging-trim'); }

// While dragging the id cannot be read yet, only the kinds of thing being carried.
export function carriesTrim(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(TRIM_TYPE);
}
export function droppedTrim(e) {
  return carriesTrim(e) ? e.dataTransfer.getData(TRIM_TYPE) : '';
}

// Make an element take dropped trim: it lights up while an entry is over it, and on the drop
// calls take(id). Returns nothing; the handlers are the element's own and go with it.
export function takesTrim(node, take) {
  if (!node) return;
  let depth = 0;
  const off = () => { depth = 0; node.classList.remove('drop-on'); };
  node.addEventListener('dragenter', e => { if (!carriesTrim(e)) return; e.preventDefault(); depth++; node.classList.add('drop-on'); });
  node.addEventListener('dragover', e => { if (!carriesTrim(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; });
  node.addEventListener('dragleave', e => { if (!carriesTrim(e)) return; if (--depth <= 0) off(); });
  node.addEventListener('drop', e => {
    const id = droppedTrim(e);
    if (!id) return;
    e.preventDefault(); e.stopPropagation(); off(); endTrimDrag();
    take(id, e);
  });
}

// Renderings of saved views: which pictures show with which saved view. Pure: no DOM, no three.js.
//
// A picture made from a saved view carries the view's id (photo.savedViewId): RENDER THIS VIEW in
// MODEL sets it, and the SAVED VIEW choice in PHOTOS sets or clears it by hand. A rendering made
// somewhere else (SketchUp, a render engine) and dropped in the project's renders folder goes
// with the view its file is named for: the view's name first, then anything ("Kitchen.png",
// "Kitchen - walnut option.jpg"). savedViewId '' says "on no view", so a name is not matched.
//
// The client page in the lab shows a view's renderings under its thumbnail (client-strip.js);
// SEND TO THE LAB lists them per view, each with a switch (lab-publish-dialog.js).

// A picture in the RENDERINGS group of PHOTOS: one Tiksi rendered, or one in a renders folder.
export const isRendering = p => !!p && p.kind !== 'document' && p.kind !== 'pano' && (p.source === 'rendering' || !!(p.file && p.file.group === 'rendering'));

// A name as its words: lowercase letters and digits joined by dashes.
export function nameSlug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const baseName = p => String((p.file && p.file.path) || p.name || '').split('/').pop().replace(/\.[a-z0-9]{2,5}$/i, '');

// The saved view a picture shows with: { view, by: 'tag' | 'name' }, or null.
export function viewOfPicture(prop, p) {
  if (!p || p.kind === 'document' || p.kind === 'pano') return null;
  const views = prop.savedViews || [];
  if (typeof p.savedViewId === 'string') {
    const view = p.savedViewId && views.find(v => v.id === p.savedViewId);
    if (view) return { view, by: 'tag' };
    if (p.savedViewId === '') return null;   // taken off every view by hand
  }
  // By its file's name: only a rendering, and not one made at a numbered position.
  if (!isRendering(p) || p.positionId) return null;
  const slug = nameSlug(baseName(p));
  let best = null, bestLen = 0;
  for (const v of views) {
    const s = nameSlug(v.name);
    if (s && s.length > bestLen && (slug === s || slug.startsWith(s + '-'))) { best = v; bestLen = s.length; }
  }
  return best ? { view: best, by: 'name' } : null;
}

const when = p => Date.parse(p.renderedAt || p.takenAt || p.createdAt) || 0;

// Every saved view's pictures, oldest first: Map(view id -> [{ picture, by }]). `pictures` is
// every picture of the property: its photo records and the folder's pictures with no record.
export function picturesByView(prop, pictures) {
  const out = new Map((prop.savedViews || []).map(v => [v.id, []]));
  for (const p of pictures || []) {
    const hit = viewOfPicture(prop, p);
    if (hit) out.get(hit.view.id).push({ picture: p, by: hit.by });
  }
  for (const list of out.values()) list.sort((a, b) => when(a.picture) - when(b.picture));
  return out;
}

// Renderings that show with no saved view, newest first.
export function looseRenderings(prop, pictures) {
  return (pictures || []).filter(p => isRendering(p) && !viewOfPicture(prop, p)).sort((a, b) => when(b) - when(a));
}

// Put a picture's record on a saved view, or on none ('').
export function tagPicture(rec, viewId) {
  rec.savedViewId = typeof viewId === 'string' ? viewId : '';
  return rec;
}

// The day a picture was made, 'YYYY-MM-DD', or ''.
export function pictureDay(p) {
  const t = when(p);
  return t ? new Date(t).toISOString().slice(0, 10) : '';
}

// File name for a rendering of a saved view: "Kitchen · rendering 2026-11-16 1432".
export function viewRenderingName(view, date) {
  const d = date instanceof Date ? date : new Date(date);
  const stamp = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ').replace(':', '') : '';
  const name = String(view.name || 'View').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'View';
  return name + ' · rendering ' + stamp;
}

// Whether two pictures of the same size (RGBA bytes) show different things: more than `share`
// of their pixels differ by more than `level` in some colour. The model draws the same picture
// twice to the last bit (measured: no pixel differs), so the measure can be fine enough to see
// white trim on a white wall (about 20 levels) and still pass over a few dozen pixels glimpsed
// through a doorway: 0.05% of a 480 x 300 picture is 72 pixels.
export function picturesDiffer(a, b, { level = 6, share = 0.0005 } = {}) {
  if (!a || !b || a.length !== b.length) return true;
  const pixels = a.length / 4;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > level || Math.abs(a[i + 1] - b[i + 1]) > level || Math.abs(a[i + 2] - b[i + 2]) > level) n++;
  }
  return n > pixels * share;
}

// Trim sections: the cross-section shapes Tiksi sweeps along a wall to draw a moulding.
// Pure data, shared by the 3D builder (geometry.js) and the trim layout (trims.js).
//
// A section is a list of [a, d] points in metres:
//   a  along the trim's width, in the plane of the wall: up from the bottom edge for a run
//      along the wall (baseboard, chair rail), inward from the outer edge for a frame
//      (picture-frame boxes), down from the ceiling for crown;
//   d  out from the wall face.
// The outline starts on the wall at a = 0, goes round the visible profile and ends on the
// wall at a = W; the back edge along the wall closes it. The shapes are drawn from the
// manufacturers' profile pictures as fractions of the product's width and thickness, so
// any product of the same pattern scales them; each catalog entry (trim-catalog.js) says
// which pattern it is and whether its profile picture was seen.

// [a / W, d / T] outlines, each from the wall at the bottom (or outer edge) round to the wall at the top.
const SHAPES = {
  // Square-edge board (S4S), edges eased 1/16 in.
  flat: [[0, 0], [0, 1], [1, 1], [1, 0]],
  eased: [[0, 0], [0, .92], [.03, 1], [.97, 1], [1, .92], [1, 0]],
  // Colonial (WM 623 family): flat face, then a cove, an ogee and a rounded top edge.
  'colonial-base': [[0, 0], [0, 1], [.6, 1], [.64, .94], [.69, .8], [.75, .71], [.81, .74], [.87, .82], [.92, .8], [.96, .66], [.99, .48], [1, .36], [1, 0]],
  // Ranch / clamshell: a face that thins toward a rounded top.
  'ranch-base': [[0, 0], [0, 1], [.55, .98], [.75, .9], [.88, .78], [.96, .6], [1, .4], [1, 0]],
  // Craftsman: a flat board with a square cap proud of its face along the top.
  'craftsman-base': [[0, 0], [0, .72], [.86, .72], [.86, 1], [.99, 1], [1, .9], [1, 0]],
  // Modern stepped: flat face with one square step down at the top.
  'stepped-base': [[0, 0], [0, 1], [.84, 1], [.84, .62], [1, .62], [1, 0]],
  // Rounded-top modern (bullnose top edge).
  'bullnose-base': [[0, 0], [0, 1], [.9, 1], [.95, .93], [.985, .78], [1, .55], [1, 0]],
  // Base shoe: taller than deep, a quarter ellipse.
  shoe: [[0, 0], [0, 1], [.25, .97], [.5, .87], [.72, .69], [.88, .45], [.97, .2], [1, 0]],
  'quarter-round': [[0, 0], [0, 1], [.2, .98], [.4, .92], [.6, .8], [.8, .6], [.92, .4], [.98, .2], [1, 0]],
  // Base cap: sits on top of a flat board, a small ogee rolling back to the wall.
  'base-cap': [[0, 0], [0, 1], [.3, 1], [.45, .9], [.6, .7], [.72, .62], [.85, .55], [.95, .42], [1, .25], [1, 0]],
  // Colonial chair rail (WM 297 family): beads and an ogee, fullest a third of the way down.
  'chair-colonial': [[0, 0], [0, .3], [.08, .45], [.16, .5], [.22, .7], [.3, .9], [.4, 1], [.52, 1], [.58, .9], [.62, .8], [.7, .72], [.8, .68], [.88, .56], [.95, .4], [1, .25], [1, 0]],
  // Modern chair rail: a flat face with both long edges rounded.
  'chair-flat': [[0, 0], [0, .62], [.06, .88], [.14, 1], [.86, 1], [.94, .88], [1, .62], [1, 0]],
  // Picture rail: a hook lip along the top for picture hooks, a cove beneath.
  'picture-rail': [[0, 0], [0, .35], [.15, .45], [.35, .7], [.55, .92], [.72, 1], [.82, 1], [.86, .55], [.92, .5], [1, .5], [1, 0]],
  // Wainscot cap / ledge: a rabbeted cap with a flat top and a rounded nose.
  'wainscot-cap': [[0, 0], [0, .55], [.3, .55], [.32, 1], [.8, 1], [.93, .93], [1, .75], [1, 0]],
  // Panel mouldings, measured inward from the box's outer edge.
  'panel-ogee': [[0, 0], [0, .3], [.08, .48], [.22, .52], [.32, .42], [.5, .62], [.68, .9], [.82, 1], [.92, .92], [1, .55], [1, 0]],
  'panel-bead': [[0, 0], [0, .45], [.1, .8], [.22, 1], [.36, .9], [.44, .6], [.6, .55], [.8, .5], [.95, .4], [1, .2], [1, 0]],
  'panel-step': [[0, 0], [0, 1], [.55, 1], [.55, .55], [1, .55], [1, 0]],
  // Beadboard / V-groove planks: chamfered long edges make the groove between planks.
  'v-plank': [[0, 0], [0, .75], [.035, 1], [.965, 1], [1, .75], [1, 0]],
  'bead-plank': [[0, 0], [0, .55], [.04, .9], [.08, 1], [.12, .9], [.16, 1], [.97, 1], [1, .8], [1, 0]],
  // Fluted / reeded panel strip: one rounded reed per strip width.
  reed: [[0, 0], [0, .3], [.08, .62], [.2, .86], [.35, .98], [.5, 1], [.65, .98], [.8, .86], [.92, .62], [1, .3], [1, 0]],
  // Raised panel's bevelled field, inward from the opening's edge.
  'raised-bevel': [[0, 0], [0, .12], [1, .6], [1, 0]],
};
// Crown: [drop / D, projection / P] from the wall contact round to the ceiling contact; the
// corner where wall meets ceiling (0, 0) closes it.
const CROWN = {
  'crown-colonial': [[1, 0], [1, .08], [.9, .12], [.8, .18], [.74, .32], [.64, .46], [.5, .52], [.36, .6], [.24, .76], [.14, .88], [.08, 1], [0, 1]],
  // A concave quarter circle bowing toward the corner, centred at the room-side corner (1, 1).
  'crown-cove': [[1, 0], ...Array.from({ length: 9 }, (_, i) => { const t = i / 8 * Math.PI / 2; return [1 - .9 * Math.sin(t), 1 - .9 * Math.cos(t)]; }), [0, 1]],
  'crown-stepped': [[1, 0], [1, .16], [.74, .16], [.74, .46], [.46, .46], [.46, .76], [.16, .76], [.16, 1], [0, 1]],
};

export const PROFILE_NAMES = {
  flat: 'Square edge (S4S)', eased: 'Eased edge', 'colonial-base': 'Colonial', 'ranch-base': 'Ranch', 'craftsman-base': 'Craftsman',
  'stepped-base': 'Modern stepped', 'bullnose-base': 'Rounded top', shoe: 'Base shoe', 'quarter-round': 'Quarter round', 'base-cap': 'Base cap',
  'chair-colonial': 'Colonial', 'chair-flat': 'Modern flat', 'picture-rail': 'Picture rail', 'wainscot-cap': 'Rabbeted cap',
  'panel-ogee': 'Ogee panel', 'panel-bead': 'Bead panel', 'panel-step': 'Stepped panel', 'v-plank': 'V-groove', 'bead-plank': 'Beaded',
  reed: 'Fluted', 'raised-bevel': 'Raised bevel', 'crown-colonial': 'Colonial crown', 'crown-cove': 'Cove crown', 'crown-stepped': 'Stepped crown',
};

export function isCrownProfile(name) { return !!CROWN[name]; }

// The section of `profile` for a product `W` wide and `T` thick (metres), as [a, d] points.
// For crown, W is the drop down the wall and T the projection along the ceiling.
export function sectionOf(profile, W, T) {
  if (CROWN[profile]) return CROWN[profile].map(([u, v]) => [u * W, v * T]);
  const shape = SHAPES[profile] || SHAPES.flat;
  return shape.map(([u, v]) => [u * W, v * T]);
}

// The outline as an SVG path in a w x h box (the catalog cards' little end view). Crown is
// drawn with the ceiling along the top and the wall on the left, like a real end view.
export function profilePath(profile, w = 40, h = 40) {
  const crown = !!CROWN[profile];
  const pts = crown ? CROWN[profile] : (SHAPES[profile] || SHAPES.flat);
  const xy = crown ? pts.map(([u, v]) => [v, u]) : pts.map(([u, v]) => [v, 1 - u]);
  const all = crown ? [[0, 0], ...xy] : [[0, 1], ...xy, [0, 0]];
  return 'M' + all.map(([x, y]) => (2 + x * (w - 4)).toFixed(1) + ' ' + (2 + y * (h - 4)).toFixed(1)).join(' L') + ' Z';
}

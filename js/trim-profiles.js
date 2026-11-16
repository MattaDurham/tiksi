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
  'crown-craftsman': [[1, 0], [1, .13], [.9, .19], [.77, .22], [.63, .26], [.49, .34],
    [.37, .44], [.25, .58], [.14, .76], [.06, .93], [0, 1]],
  'crown-foster': [[1, 0], [1, .14], [.94, .17], [.91, .15], [.85, .19], [.81, .17],
    [.72, .2], [.69, .2], [.63, .23], [.59, .22], [.52, .27], [.48, .26], [.41, .32], [.38, .31],
    [.31, .4], [.28, .4], [.23, .5], [.2, .5], [.15, .64], [.13, .63], [.09, .78], [.06, .82], [0, 1]],
  'crown-traditional': [[1, 0], [1, .14], [.93, .14], [.9, .23], [.84, .25], [.8, .2],
    [.75, .2], [.66, .23], [.54, .31], [.42, .45], [.32, .62], [.26, .77], [.23, .91],
    [.17, .95], [.1, .92], [.1, 1], [0, 1]],
  'crown-attica': [[1, 0], [1, .17], [.94, .17], [.94, .3], [.87, .34], [.84, .46],
    [.61, .46], [.58, .48], [.54, .56], [.5, .51], [.41, .53], [.33, .61], [.23, .75],
    [.19, .88], [.14, .9], [.09, .87], [.09, 1], [0, 1]],
  'crown-nestor': [[1, 0], [1, .17], [.96, .2], [.91, .19], [.91, .34], [.86, .42],
    [.56, .42], [.53, .47], [.5, .56], [.45, .52], [.34, .59], [.24, .72], [.18, .85],
    [.12, .85], [.12, 1], [0, 1]],
  'crown-fascia': [[1, 0], [1, .5], [5 / 14, .5], [5 / 14, 1], [0, 1]],
};

export const PROFILE_NAMES = {
  flat: 'Square edge (S4S)', eased: 'Eased edge', 'colonial-base': 'Colonial', 'ranch-base': 'Ranch', 'craftsman-base': 'Craftsman',
  'stepped-base': 'Modern stepped', 'bullnose-base': 'Rounded top', shoe: 'Base shoe', 'quarter-round': 'Quarter round', 'base-cap': 'Base cap',
  'chair-colonial': 'Colonial', 'chair-flat': 'Modern flat', 'picture-rail': 'Picture rail', 'wainscot-cap': 'Rabbeted cap',
  'panel-ogee': 'Ogee panel', 'panel-bead': 'Bead panel', 'panel-step': 'Stepped panel', 'v-plank': 'V-groove', 'bead-plank': 'Beaded',
  reed: 'Fluted', 'raised-bevel': 'Raised bevel', 'crown-colonial': 'Colonial crown', 'crown-cove': 'Cove crown', 'crown-stepped': 'Stepped crown',
  'crown-traditional': 'Traditional crown', 'crown-attica': 'Attica crown', 'crown-nestor': 'Nestor crown', 'crown-fascia': 'Square fascia and cap',
  'crown-craftsman': 'Timeless Craftsman crown', 'crown-foster': 'Foster cove crown',
};

export function isCrownProfile(name) { return !!CROWN[name]; }

// The section of `profile` for a product `W` wide and `T` thick (metres), as [a, d] points.
// For crown, W is the drop down the wall and T the projection along the ceiling.
export function sectionOf(profile, W, T) {
  if (CROWN[profile]) return [...CROWN[profile], [0, 0]].map(([u, v]) => [u * W, v * T]);
  const shape = SHAPES[profile] || SHAPES.flat;
  return shape.map(([u, v]) => [u * W, v * T]);
}

// Simplified relief traced from the manufacturer product views. Coordinates in each
// motif run along the moulding and down the flat frieze, as shares of one repeat.
const KEY = [[.05, .1], [.05, .9], [.45, .9], [.45, .13], [.16, .13], [.16, .67], [.34, .67],
  [.34, .26], [.26, .26], [.26, .53], [.24, .53], [.24, .25], [.37, .25], [.37, .78], [.13, .78], [.13, .1]];
const LEAF = [[.49, .94], [.33, .79], [.25, .67], [.22, .52], [.32, .6], [.27, .45], [.28, .3],
  [.37, .43], [.35, .25], [.39, .12], [.46, .31], [.45, .17], [.5, .04], [.55, .17], [.54, .31],
  [.61, .12], [.65, .25], [.63, .43], [.72, .3], [.73, .45], [.68, .6], [.78, .52], [.75, .67],
  [.67, .79], [.51, .94]];
const RELIEF = {
  'crown-nestor': { pitch: .62, top: .58, bottom: .84, rear: .42, front: .445, contours: [KEY, KEY.map(([x, y]) => [x + .5, 1 - y])] },
  'crown-attica': { pitch: 1.1, top: .62, bottom: .83, rear: .46, front: .51,
    contours: [LEAF, [[.04, .28], [.17, .28], [.17, .39], [.04, .39]], [[.83, .28], [.96, .28], [.96, .39], [.83, .39]],
      [[.04, .70], [.17, .70], [.17, .80], [.04, .80]], [[.83, .70], [.96, .70], [.96, .80], [.83, .80]]] },
};

export function crownRelief(profile, W, T, start, end) {
  const spec = RELIEF[profile];
  if (!spec) return null;
  const repeat = spec.pitch * W, count = Math.min(400, Math.floor((end - start) / repeat));
  const left = (start + end - count * repeat) / 2;
  const contours = [];
  for (let i = 0; i < count; i++) for (const contour of spec.contours) {
    contours.push(contour.map(([x, y]) => [left + (i + x) * repeat, (spec.top + y * (spec.bottom - spec.top)) * W]));
  }
  return { rear: (spec.rear - .002) * T, front: spec.front * T, contours };
}

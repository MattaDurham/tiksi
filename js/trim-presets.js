// Style choices pair a design direction with a catalog specification. Picture-frame
// recipes describe the arrangement inside a stretch, in shares from left to right.
export const CROWN_PRESETS = [
  ['Craftsman', 'hd-10026983'],
  ['Traditional', 'ekena-mld04x03x05tr'],
  ['Victorian', 'ekena-mld05x05x07at'],
  ['Art Deco', 'hd-mld04x04x06er'],
  ['Mid-century modern', 'hd-10000683'],
  ['Farmhouse', 'farmhouse-hd-10005558'],
  ['Colonial', 'hd-10000477'],
  ['Greek Revival', 'ekena-mld05x04x07ns'],
  ['Arts and Crafts', 'hd-mld06x06x09fo'],
];

export const WAINSCOT_PRESETS = [
  ['Picture frame', 'hd-pml00x00cl'],
  ['Raised panel', 'hd-wpkusq021p040'],
  ['Flat panel', 'flat-hd-10005558'],
  ['Board and batten', 'hd-424600'],
  ['Beadboard', 'hd-8203035'],
  ['Shaker', 'shaker-pine-1x4-1x6'],
  ['Full-height paneling', 'full-hd-10005558'],
];

export const FRAME_PRESETS = {
  '01': { label: 'Wide center, split sides', columns: [1, 5, 1], split: [0, 2] },
  '02': { label: 'Wide center, tall sides', columns: [1, 5, 1] },
  '03': { label: 'Wide center, split all', columns: [1, 5, 1], split: [0, 1, 2] },
  '04': { label: 'Low center, split sides', columns: [1, 5, 1], split: [0, 2], low: 1 },
  '05': { label: 'Six even panels', columns: [1, 1, 1, 1, 1, 1] },
  '06': { label: 'Wide center, paired sides', columns: [1, 1, 4, 1, 1] },
  '07': { label: 'Divider, aligned rows', columns: [1, 5, 1], lower: [1, 5, 1] },
  '08': { label: 'Divider, five below', columns: [1, 5, 1], lower: [1, 1.5, 1.5, 1.5, 1] },
  '09': { label: 'Two rows, paired sides', columns: [1, 1, 4, 1, 1], split: [0, 1, 2, 3, 4] },
  '10': { label: 'Three double frames', columns: [1, 2, 1], nested: true },
};

export function framePreset(id) {
  return typeof id === 'string' && Object.hasOwn(FRAME_PRESETS, id) ? FRAME_PRESETS[id] : null;
}

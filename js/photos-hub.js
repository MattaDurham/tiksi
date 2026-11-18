// PHOTOS: the site's evidence. PHOTOS is every picture, panorama, scan frame, rendering and saved
// document of the property; VIDEOS reads tape measurements from walk-through videos and applies
// them to the model (measure.js). A video dropped anywhere opens in VIDEOS.
// Addresses: #/photos (photos.js reads ?select=<id>), #/measure (VIDEOS).

import { hub } from './hub.js';

const view = hub({
  label: 'Photos',
  parts: [
    { id: 'photos', label: 'PHOTOS', icon: 'photos', load: () => import('./photos.js'), addr: '#/photos' },
    { id: 'videos', label: 'VIDEOS', icon: 'measure', load: () => import('./measure.js'), addr: '#/measure' },
  ],
  partOf: hash => /^#\/measure/.test(hash) ? 'videos' : 'photos',
});
export const { mount, unmount, undo, redo, sharedChange } = view;

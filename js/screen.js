// The one "small screen" query. The phone layout switches on it (js/field.js), and the page
// rules for small screens use the same words in their @media (css/console.css, css/photos.css):
// test/screen.test.mjs keeps them equal. Whether the screen is touched by a finger is a
// separate question, answered by touchDevice() in js/render-quality.js.
export const SMALL = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';

export function smallScreen(win = globalThis) {
  try { return !!(win && typeof win.matchMedia === 'function' && win.matchMedia(SMALL).matches); } catch (e) { return false; }
}

// Work that is in this page and not yet in the store, where nothing would show it as unsaved:
// a file being read, decoded or converted on its way in, and a file chooser or the camera
// that was opened and has not answered yet. A page holding such work is "in use": it is not
// reloaded for new code under it (js/disk-workspace.js), because the photo just taken or the
// scan half converted would be gone.

// `handingMs`: how long after a file was handed to the page it counts as on its way in, for
// the code that takes files in without saying so through `working`. The functions that add
// originals do say so, and count for exactly as long as they run.
// `answerMs`: how long after the person came back to the page a chooser with no answer still
// counts as open: a phone can take some seconds to hand over the photo, and an older browser
// never says that the chooser was closed without one.
export const workLimits = { handingMs: 20000, answerMs: 60000 };

let count = 0, chooser = null, returnedAt = 0, handedAt = 0;

// Count this work until it ends, however it ends. Returns what it was given.
export function working(work) {
  count++;
  let over = false;
  const done = () => { if (!over) { over = true; count--; } };
  Promise.resolve(work).then(done, done);
  return work;
}

export function workInProgress() {
  if (count > 0) return true;
  const now = Date.now();
  if (now - handedAt < workLimits.handingMs) return true;
  if (chooser) {
    if (!returnedAt || now - returnedAt < workLimits.answerMs) return true;
    chooser = null;
  }
  return false;
}

const fileInput = target => target instanceof HTMLInputElement && target.type === 'file';
if (typeof document !== 'undefined') {
  // A chooser or the camera opens with a click on its input (a press on its label and a
  // script's `click()` both arrive as one), for an input that is in the page.
  document.addEventListener('click', e => { if (fileInput(e.target)) { chooser = e.target; returnedAt = 0; } }, true);
  document.addEventListener('change', e => { if (fileInput(e.target)) { chooser = null; handedAt = Date.now(); } }, true);
  document.addEventListener('cancel', e => { if (fileInput(e.target)) chooser = null; }, true);
  for (const kind of ['drop', 'paste']) document.addEventListener(kind, e => {
    const files = (e.dataTransfer || e.clipboardData)?.files;
    if (files && files.length) handedAt = Date.now();
  }, true);
  const back = () => { if (chooser && !returnedAt && document.visibilityState === 'visible') returnedAt = Date.now(); };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
}

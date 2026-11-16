// The saved views' own pictures for a client copy (SEND TO THE LAB, lab-publish.js).
//
// The client page shows each saved view as a small picture, and under it one per project that
// changes what the view shows. Those pictures are made here, on the Mac, by the client page's
// own code: a small frame in the send window opens the copy exactly as a client's browser
// would (client-pictures.html, client-view.js startPictures), goes to each saved view under
// Existing and under each project, and takes a picture. So a picture always shows what a click
// on it gives, and a client's phone only has to load small JPEGs.
//
// The frame is a page of its own (its own copy of Tiksi's code, nothing of the open workspace),
// handed the copy and a way to read its files. It has to be on the screen: a browser draws no
// frames for a page that is hidden, so the pictures wait while the window is in the background.

export const PICTURE_SIZE = { width: 480, height: 300 };
// How long the frame may go without saying anything before the pictures are given up.
const STALL_MS = 240000;

// Make the pictures. `copy` is the client copy; `read(id)` gives a file of it ({ buffer, format,
// mime } or null); `host` is where the frame goes (the send window). Resolves to
// { size: { width, height }, count, views: { view id: { state id: ArrayBuffer (a JPEG) } } }.
// A project whose picture of a view is the same as Existing's has none for that view.
export async function viewPictures({ copy, read, progress = () => {}, host = document.body, size = PICTURE_SIZE, stallMs = STALL_MS }) {
  const box = document.createElement('div');
  box.className = 'lab-pictures';
  box.innerHTML = '<p>Taking the pictures of the saved views, as the client page shows them. Keep this window in front.</p>';
  const frame = document.createElement('iframe');
  frame.title = 'The client page, taking the pictures of the saved views';
  frame.setAttribute('tabindex', '-1');
  box.append(frame);
  host.append(box);
  box.scrollIntoView({ block: 'nearest' });
  let last = performance.now(), watch = 0;
  try {
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = () => reject(new Error('the picture page did not load'));
      frame.src = new URL('./client-pictures.html', import.meta.url).href;
    });
    const run = frame.contentWindow && frame.contentWindow.tiksiPictures;
    if (typeof run !== 'function') throw new Error('the picture page did not start');
    const stalled = new Promise((_, reject) => {
      watch = setInterval(() => { if (performance.now() - last > stallMs) reject(new Error('the model did not finish loading in the picture page')); }, 2000);
    });
    // The frame gets its own copy of the copy: nothing it does changes what is sent.
    const job = run({ copy: JSON.parse(JSON.stringify(copy)), read, size, progress: (text, f) => { last = performance.now(); progress(text, f); } });
    const out = await Promise.race([job, stalled]);
    if (!out || !out.views) throw new Error('the picture page gave no pictures');
    return out;
  } finally {
    clearInterval(watch);
    try { frame.contentWindow && frame.contentWindow.tiksiPicturesEnd && frame.contentWindow.tiksiPicturesEnd(); } catch (e) { /* the frame is going anyway */ }
    box.remove();
  }
}

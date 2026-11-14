// What "open on this Mac" did (POST /api/workspace/open/<id> answers action 'opened' or
// 'shown'): opened the document, or, for an app, script, shortcut, web page or a file with no
// extension, only showed it in Finder. A module of its own so PRODUCTS and DOCUMENTS share it
// without one loading the other.
export function openedWords(r, asked) {
  const what = (r && r.path && r.path !== '.' ? r.path : r && r.folder) || asked || 'the project folder';
  if (r && r.action === 'opened-in-browser') return 'Opened ' + what + ' in your browser.';
  if (r && r.action === 'downloaded') return 'Downloaded ' + what + ' to this device.';
  return r && r.action === 'shown' ? 'Showed ' + what + ' in Finder (not a document, so it was not opened).' : 'Opened ' + what + ' on this Mac.';
}

// Printing a prepared sheet (the budget report, a cut sheet, PLAN's opening schedule).
//
// A PRINT button fills #print-root and prints; on paper the app is then hidden and only the
// sheet shows (css/console.css). Any other print (Cmd+P, File > Print) must print the page as
// it is, never a sheet an earlier PRINT left behind. So a sheet counts only for the print its
// own button started: printSheet() marks it, and one page-wide beforeprint listener empties
// #print-root for every print that was not marked. The mark lasts until the next key or
// pointer press on the page (Cmd+P is such a key), so a browser that fires beforeprint again
// while its print dialog is open (Safari, on a paper-size change) still prints the sheet.

let marked = false;

function root() { return document.getElementById('print-root'); }

// Fill #print-root with `html` and print it. `ready(root)` may return a promise the print waits
// for, such as an image being decoded.
export async function printSheet(html, ready) {
  const el = root();
  if (!el) return;
  el.innerHTML = html;
  if (ready) { try { await ready(el); } catch (e) { /* print what there is */ } }
  marked = true;
  window.print();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeprint', () => {
    const el = root();
    if (!marked && el && el.firstChild) el.replaceChildren();
  });
  const unmark = () => { marked = false; };
  window.addEventListener('keydown', unmark, true);
  window.addEventListener('pointerdown', unmark, true);
}

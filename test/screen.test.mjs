// The phone layout and the page rules for small screens answer "is this a small screen" with
// the same words: js/screen.js SMALL. A phone held sideways once got the phone bar over desktop
// columns because the layout and the page rules used different tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('the phone layout and the small-screen page rules use one query', async () => {
  const { SMALL, smallScreen } = await import('../js/screen.js');
  assert.equal(SMALL, '(max-width: 760px), (max-height: 500px) and (pointer: coarse)');
  assert.match(await read('js/field.js'), /import \{ SMALL \} from '\.\/screen\.js';/, 'field.js switches the layout on SMALL');
  for (const [file, blocks] of [['css/console.css', 3], ['css/photos.css', 1]]) {
    const css = await read(file);
    const uses = css.split('@media ' + SMALL + ' {').length - 1;
    assert.ok(uses >= blocks, file + ' writes its small-screen rules with SMALL (' + uses + ' blocks)');
  }
  // The shared stylesheet's main block for small screens is the one that drops the page tabs' underline.
  const consoleCss = await read('css/console.css');
  const main = consoleCss.indexOf('#rail a::before { display: none; }');
  assert.ok(main > consoleCss.lastIndexOf('@media ' + SMALL + ' {', main) && consoleCss.lastIndexOf('@media ' + SMALL + ' {', main) > consoleCss.lastIndexOf('@media (max-width: 760px) {', main),
    'the rules that hide the rail on a small screen sit under SMALL, not under width alone');
  assert.equal(smallScreen({ matchMedia: q => ({ matches: q === SMALL }) }), true);
  assert.equal(smallScreen({}), false, 'no matchMedia (Node): not a small screen');
});

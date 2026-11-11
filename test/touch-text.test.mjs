// On a touch device the pages' small text is raised to 12 points by a copy of each small rule
// (js/touch-text.js). A computer's rules are never changed, and a more specific rule keeps winning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raisedRule, raisedRules, ruleFontSize, splitSelectors, TEXT_SCOPE } from '../js/touch-text.js';

test('a rule under 12 points gets a raised copy for touch pages only, at its own specificity', () => {
  assert.equal(raisedRule('.btn.small', '10px'), TEXT_SCOPE + ' .btn.small { font-size: 12px; }');
  assert.match(TEXT_SCOPE, /^:where\(html\.touch:not\(\[data-view=plan\]\):not\(\[data-view=model\]\) #view\)$/, 'touch only, not PLAN or MODEL, and wrapped in :where() so it adds no specificity');
  assert.equal(raisedRule('.x', '12px'), '', '12 points and up are left alone');
  assert.equal(raisedRule('.x', '0.8em'), '', 'only sizes written in px are raised');
  assert.equal(raisedRule('.x', ''), '');
  assert.equal(raisedRule('#view .a, .b', '9.5px'), ':where(html.touch:not([data-view=plan]):not([data-view=model])) #view .a, ' + TEXT_SCOPE + ' .b { font-size: 12px; }', 'a selector that names the page keeps it');
  assert.equal(raisedRule('html.phone .fd-title, body > .y', '11px'), '', 'whole-document rules are not page text');
  assert.equal(raisedRule('.gantt-svg text, .chart svg .t', '9px'), '', 'SVG drawing rules are left to the drawing');
});

test('selectors split at their own commas only', () => {
  assert.deepEqual(splitSelectors(':is(.a, .b) span, .c[data-x="1,2"]'), [':is(.a, .b) span', '.c[data-x="1,2"]']);
});

test('the size inside a font shorthand counts', () => {
  assert.equal(ruleFontSize({ fontSize: '', getPropertyValue: () => '10px var(--mono)' }), '10px');
  assert.equal(ruleFontSize({ fontSize: '', getPropertyValue: () => '600 9.5px/1.4 var(--mono)' }), '9.5px');
  assert.equal(ruleFontSize({ fontSize: '13px', getPropertyValue: () => '' }), '13px');
});

test('media conditions are kept and print rules left out', () => {
  const style = fontSize => ({ fontSize, getPropertyValue: () => '' });
  const rules = [
    { selectorText: '.a', style: style('10px') },
    { media: { mediaText: '(max-width: 760px)' }, conditionText: '(max-width: 760px)', cssRules: [{ selectorText: '.b', style: style('11px') }, { selectorText: '.c', style: style('14px') }] },
    { media: { mediaText: 'print' }, conditionText: 'print', cssRules: [{ selectorText: '.d', style: style('9px') }] },
  ];
  assert.deepEqual(raisedRules(rules), [
    TEXT_SCOPE + ' .a { font-size: 12px; }',
    '@media (max-width: 760px) { ' + TEXT_SCOPE + ' .b { font-size: 12px; } }',
  ]);
});

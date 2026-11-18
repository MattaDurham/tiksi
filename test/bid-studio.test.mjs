import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleWorkspace } from './fixtures/bid-studio.mjs';
import { estimate } from '../js/bid-estimate.js';
import { facts, crewSchedule, shareHtml, readResponse } from '../js/bid-issue.js';
import { readProfile } from '../js/bid-profile.js';
import { makeCuts } from '../js/bid-stock.js';

test('parent package buys every cut exactly once and rolls up child labor', () => {
  const w = sampleWorkspace(),
    p = w.properties[0],
    d = p.bidStudio.draft;
  const run = (id) => estimate(p, w.projects, { ...d, project: id });
  const all = run('finish'),
    gallery = run('gallery'),
    reading = run('reading');
  assert.equal(all.rooms.length, 2);
  assert.equal(all.total, 4657.08);
  assert.equal(
    all.rooms.reduce((sum, room) => sum + room.cuts.length, 0),
    116,
  );
  assert.equal(all.hours, gallery.hours + reading.hours);
  assert.equal(all.scopeCost, 130);
  assert.equal(reading.scopeCost, 0);
  for (const room of all.rooms) {
    assert.deepEqual(
      room.boards.flatMap((b) => b.cuts.map((c) => c.mark)).sort(),
      room.cuts.map((c) => c.mark).sort(),
    );
    for (const b of room.boards) assert.ok(b.used + 2 * all.rules.endTrim <= b.length + 1e-8);
  }
  assert.ok(all.rooms[0].cuts.some((c) => c.endA === 'scarf'));
  assert.ok(all.rooms[0].cuts.some((c) => c.endA === 'inside corner' || c.endB === 'inside corner'));
  assert.equal(
    all.orders.reduce((n, r) => n + r.spare, 0),
    new Set(all.orders.map((r) => r.product)).size,
  );
  assert.ok(all.supplies.every((s) => Number.isInteger(s.packs)));
});
test('a single frame member cannot be replaced by shorter spliced stock', () => {
  const piece = { kind: 'frame', len: 3, endA: 'miter 45', endB: 'miter 45' };
  const stock = { product: { W: 0.035, T: 0.015 }, bases: [2] };
  assert.deepEqual(makeCuts(piece, stock, { endTrim: 0.01 }), []);
  assert.equal(makeCuts({ ...piece, kind: 'run' }, stock, { endTrim: 0.01 }).length, 2);
});
test('issue preserves original quote and escapes guest text after design revision', () => {
  const w = sampleWorkspace(),
    p = w.properties[0],
    d = { ...p.bidStudio.draft, title: '<Example & Co>' };
  const f = facts(p, w.projects, estimate(p, w.projects, d), d);
  const issue = { id: 'issue-alpha', date: '2027-02-05', number: 1, facts: f };
  p.trims = p.trims.filter((t) => t.style === 'baseboard');
  assert.ok(estimate(p, w.projects, d).total < f.total);
  const html = shareHtml(issue);
  assert.ok(html.includes('&lt;Example &amp; Co&gt;'));
  assert.ok(!html.includes('<Example & Co>'));
  assert.ok(html.includes(f.rooms[0].cuts.at(-1).mark));
  const response = {
    format: 'tiksi-bid-response/1',
    issue: issue.id,
    name: 'Firm A',
    kind: 'bid',
    labor: 300,
    materials: 40,
    other: 5,
    excluded: 10,
  };
  assert.equal(readResponse(response, issue).excluded, 10);
  assert.throws(() => readResponse({ ...response, issue: 'other' }, issue));
  assert.throws(() => readResponse({ ...response, materials: -3 }, issue));
  assert.equal(readResponse({ ...response, kind: 'approval' }, issue).kind, 'approval');
});
test('crew shares partial days and skips a weekend', () => {
  const days = crewSchedule(
    [
      { name: 'One', hours: 12 },
      { name: 'Two', hours: 8 },
    ],
    '2027-02-05',
    16,
  );
  assert.equal(days[0].to, '2027-02-05');
  assert.equal(days[1].from, '2027-02-05');
  assert.equal(days[1].to, '2027-02-08');
});
test('a private book is property-bound and flat supplies round to purchased packages', () => {
  const w = sampleWorkspace(),
    p = w.properties[0];
  const book = {
    format: 'tiksi-bid-profile/1',
    name: 'Synthetic supplier',
    propertyId: p.id,
    settings: {},
    prices: {},
    stock: {},
    nailing: {},
    tasks: [],
    rooms: [],
    supplement: [],
    supplies: [
      { id: 'delivery', product: 'Fixed delivery', per: 'rooms', per_package: 0, min: 1, price: 40 },
    ],
  };
  assert.throws(() => readProfile(book, 'other'));
  assert.throws(() => readProfile({ ...book, settings: { crew: 0 } }, p.id));
  const e = estimate(p, w.projects, { profile: readProfile(book, p.id) });
  assert.equal(e.consumables, 40);
  assert.ok(Number.isFinite(e.total));
});

test('an unresolved drawing product marks its own package as partially priced', () => {
  const w = sampleWorkspace();
  const p = w.properties[0];
  p.trims.find((t) => t.projectId === 'gallery').product = 'unavailable-synthetic-id';
  const whole = estimate(p, w.projects, { project: 'finish' });
  assert.equal(whole.incomplete, true);
  assert.ok(whole.warnings.length > 0);
  assert.equal(estimate(p, w.projects, { project: 'reading' }).incomplete, false);
});

import { workday, laborReview } from './workday.js';
import { rateRange } from './estimate-program.js';
import {
  activeProperty,
  propertyProjects,
  touch,
  uid,
  isoToday,
  readLength,
  fmtLen,
  onChange,
} from './store.js';
import { catalogFor, catalogItem } from './trim-catalog.js';
import { trimProduct } from './trims.js';
import { estimate, projectTree } from './bid-estimate.js';
import {
  facts,
  productionBasis,
  esc,
  money,
  lens,
  boardDiagram,
  shareHtml,
  readResponse,
} from './bid-issue.js';
import { readProfile, INPUTS, checkNumber } from './bid-profile.js';
import { sameJson, mergeShared } from './workspace-merge.js';
import { icon } from './icons.js';

let root,
  tab = 'estimate',
  roomKey = '',
  issueId = '',
  notice = '',
  lastProp = '',
  openRates = false;
let stopWatching,
  pendingRender = 0;
let alternateSource = '',
  alternateProduct = '';
const histories = new Map();
const tabs = {
  estimate: 'Estimate',
  shop: 'Cut sheets',
  alternates: 'Alternates',
  documents: 'Documents',
  bids: 'Bid comparison',
};
const btn = (action, label, primary = false) =>
  '<button class="btn' + (primary ? ' primary' : '') + '" data-act="' + action + '">' + label + '</button>';
const num = (n, d = 1) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const get = () => activeProperty()?.bidStudio || {};
const draft = () => get().draft || {};
function history(id) {
  if (!histories.has(id)) histories.set(id, { undo: [], redo: [] });
  return histories.get(id);
}
function saveDraft(p, next, label) {
  const before = p.bidStudio?.draft || {};
  if (sameJson(before, next)) return;
  const h = history(p.id);
  h.undo.push({ before, after: next, label });
  if (h.undo.length > 20) h.undo.shift();
  h.redo = [];
  p.bidStudio = { ...p.bidStudio, draft: next };
  touch();
}
function restore(p, key) {
  const h = history(p.id),
    entry = h[key].at(-1);
  if (!entry) return;
  const back = key === 'undo',
    result = mergeShared(back ? entry.after : entry.before, back ? entry.before : entry.after, draft());
  if (result.conflicts.length) throw new Error('A newer edit changed this input. Review the current value.');
  h[key].pop();
  h[back ? 'redo' : 'undo'].push(entry);
  p.bidStudio = { ...get(), draft: result.value };
  touch();
}
function download(name, text, type) {
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([text], { type }));
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const input = (key, label, value, attrs = '') =>
  '<label>' +
  esc(label) +
  '<input data-field="' +
  esc(key) +
  '" value="' +
  esc(value) +
  '" ' +
  attrs +
  '></label>';
const choice = (value, label, current) =>
  '<option value="' +
  esc(value) +
  '"' +
  (value === current ? ' selected' : '') +
  '>' +
  esc(label) +
  '</option>';
const costParts = (e) => [
  ['Stock', e.material],
  ['Supplies', e.consumables],
  ['Labor', e.labor],
  ['Scope & allowance', e.scopeCost + e.rules.allowance],
  ['Fees & tax', Object.values(e.adjustments).reduce((a, b) => a + b, 0)],
];
function roomTable(e) {
  return (
    '<div class="bs-table-scroll"><table><thead><tr><th>Room</th><th>Pieces</th><th>Hours</th><th>Stock</th></tr></thead><tbody>' +
    e.rooms
      .map(
        (r) =>
          '<tr><td><button class="bs-text" data-room="' +
          esc(r.key) +
          '">' +
          esc(r.name) +
          ' ↗</button></td><td>' +
          r.cuts.length +
          '</td><td>' +
          num(r.hours) +
          '</td><td>' +
          money(r.material) +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table></div>'
  );
}
function scopeTable(e) {
  if (!e.scope.length) return '';
  const binding = get().program,
    covered = new Set(binding?.covered || []);
  return (
    '<details class="bs-card"><summary>Additional project scope <small>' +
    e.scope.filter((x) => x.selected).length +
    ' included</small></summary><p>Include separately priced work. Mark purchasing rows already covered by the drawing to reconcile the program budget.</p>' +
    e.scope
      .map(
        (s) =>
          '<div class="bs-scope-line"><label class="bs-scope"><input type="checkbox" data-scope="' +
          esc(s.id) +
          '" ' +
          (s.selected ? 'checked ' : '') +
          (covered.has(s.id) ? 'disabled' : '') +
          '><span>' +
          esc(s.name) +
          '<small>' +
          esc(s.project + ' · ' + s.qty + ' ' + s.unit) +
          '</small></span><b>' +
          money(s.likely) +
          '</b></label>' +
          (binding
            ? '<label><input type="checkbox" data-covered="' +
              esc(s.id) +
              '" ' +
              (covered.has(s.id) ? 'checked ' : '') +
              (s.selected ? 'disabled' : '') +
              '> Already in the drawing estimate</label>'
            : '') +
          (s.selected
            ? input(
                'scopeHours:' + s.id,
                'Installation hours per ' + (s.unit || 'unit'),
                s.installHours,
                'type="number" min="0" step=".01"',
              )
            : '') +
          '</div>',
      )
      .join('') +
    '</details>'
  );
}
function stockInputs(e) {
  const fields = Object.values(e.products).flatMap((product) => {
    const book = e.rules.stock[product.id];
    const priceField = (key, label, price) => input(key, label, price, 'type="number" step=".01" min="0"');
    if (!book)
      return [
        priceField(
          'price:' + product.id,
          product.short + ' · ' + product.priceUnit,
          e.rules.prices[product.id] ?? product.price,
        ),
      ];
    const rows = (book.lengths || []).map((l) => {
      const key = product.id + '@' + l.in;
      const used = e.orders.find(
        (o) => o.product === product.id && o.how === 'stock' && Math.abs(o.length - l.in * 0.0254) < 1e-8,
      );
      return priceField(
        'offer:' + key,
        product.short + ' · ' + fmtLen(l.in * 0.0254),
        e.rules.offerPrices[key] ?? used?.price ?? l.price,
      );
    });
    if (book.sold !== 'lengths') {
      const key = product.id + '@foot';
      rows.push(
        priceField(
          'offer:' + key,
          product.short + ' · $ / linear foot',
          e.rules.offerPrices[key] ?? book.per_ft,
        ),
      );
    }
    return rows;
  });
  return fields.length
    ? '<h3>Supplier stock prices</h3><div class="bs-fields">' + fields.join('') + '</div>'
    : '';
}
function options(e, d) {
  const f = (id, label, unit, min, max, integer) =>
    input(
      'rule:' + id,
      label + ' · ' + unit,
      e.rules[id],
      'type="number" min="' + min + '" max="' + max + '" step="' + (integer ? '1' : 'any') + '"',
    );
  const lengths = [
    ['cap', 'Preferred board limit'],
    ['stretch', 'Maximum board length'],
    ['endTrim', 'Trim at each stock end'],
    ['gap', 'Space between cuts'],
  ];
  return (
    '<details class="bs-card" data-rates ' +
    (openRates ? 'open' : '') +
    '><summary>Estimate inputs <small>' +
    esc(e.bookName) +
    '</small></summary><div class="bs-fields">' +
    INPUTS.map((a) => f(...a)).join('') +
    lengths.map(([id, label]) => input('length:' + id, label, fmtLen(e.rules[id]))).join('') +
    input('start', 'Crew start', d.start || '', 'type="date"') +
    input('closed', 'Days off · YYYY-MM-DD, separated by commas', (d.closed || []).join(', ')) +
    input('lowRate', 'Low labor scenario · $ / h', d.lowRate ?? e.rules.rate, 'type="number" min="0"') +
    input('highRate', 'High labor scenario · $ / h', d.highRate ?? e.rules.rate, 'type="number" min="0"') +
    '<label><input type="checkbox" data-coats ' +
    (d.twoCoats ? 'checked' : '') +
    '>Split the paint task into two coats on separate days</label>' +
    '</div><h3>Labor production</h3><div class="bs-fields">' +
    e.tasks
      .map((t) =>
        input(
          'production:' + t.id,
          t.label + ' · h / ' + t.per,
          d.production?.[t.id] ?? t.hours,
          'type="number" min="0" step="any" title="' + esc(t.basis || '') + '"',
        ),
      )
      .join('') +
    '</div>' +
    stockInputs(e) +
    (e.supplies.length
      ? '<h3>Consumables per package</h3><div class="bs-fields">' +
        e.supplies
          .map((s) => input('supply:' + s.id, s.product, s.price, 'type="number" step=".01" min="0"'))
          .join('') +
        '</div>'
      : '') +
    '<div class="bs-fields">' +
    input('title', 'Package title', d.title || 'Bid package', 'maxlength="140"') +
    '<label>Terms, assumptions and exclusions<textarea data-field="terms" maxlength="5000">' +
    esc(d.terms || '') +
    '</textarea></label></div>' +
    '<div class="bs-actions">' +
    btn('profile', 'Import rate book…') +
    (d.profile ? btn('default-book', 'Use planning allowances') : '') +
    '</div></details>'
  );
}
function gallery(e) {
  const refs = get().references || {};
  const rooms = e.rooms.filter((r) => refs[r.key]?.length);
  if (!rooms.length || rooms.length !== e.rooms.length) return '';
  return (
    '<div class="bs-gallery">' +
    rooms
      .map(
        (r) =>
          '<button data-room="' +
          esc(r.key) +
          '"><img alt="" src="' +
          esc(refs[r.key][0].image) +
          '"><span>' +
          esc(r.name) +
          '</span><small>' +
          r.cuts.length +
          ' pieces · ' +
          num(r.hours) +
          ' h · '+money(r.material)+' stock</small></button>',
      )
      .join('') +
    '</div>'
  );
}
function estimateView(e, d, f) {
  const parts = costParts(e);
  const selectedDate = new URLSearchParams(location.hash.split('?')[1]).get('day');
  return (
    workday(f, selectedDate, get().references) +
    ('<div class="bs-grid"><section class="bs-card bs-cost"><div class="bs-section"><h2>Price build-up</h2><small>USD</small></div><div class="bs-bar">' +
      parts
        .map(
          ([k, n], i) =>
            '<span class="bs-t' +
            i +
            '" style="width:' +
            (e.total > 0 ? Math.max(0, (n / e.total) * 100) : 0) +
            '%" title="' +
            esc(k + ' · ' + money(n)) +
            '"></span>',
        )
        .join('') +
      '</div>' +
      parts
        .map(
          ([k, n], i) =>
            '<div class="bs-cost-row"><span><i class="bs-t' +
            i +
            '"></i>' +
            esc(k) +
            '</span><b>' +
            money(n) +
            '</b></div>',
        )
        .join('') +
      '<div class="bs-total"><span>Package price</span><b>' +
      money(e.total) +
      '</b></div></section>' +
      '<section class="bs-card"><div class="bs-section"><h2>Room takeoff</h2><small>Drawn sections</small></div>' +
      (e.rooms.length
        ? gallery(e) || roomTable(e)
        : '<p>Draw wall trim in MODEL to plan boards here. Existing project items can be added under Additional project scope.</p><a href="#/model">Open model ↗</a>') +
      '<div class="bs-foot">' +
      esc(
        f.finish ? 'Crew finish ' + f.finish : 'Set a crew start in Estimate inputs to calculate the finish.',
      ) +
      '</div></section></div>' +
      '<section class="bs-card"><h2>Estimate basis</h2><p>' +
      esc(d.basis || e.bookName) +
      '</p>' +
      '<p>' +
      esc(
        e.rules.crew +
          (e.rules.crew === 1 ? ' person × ' : ' people × ') +
          e.rules.hoursDay +
          ' hours per weekday · ' +
          money(e.rules.rate) +
          ' per person-hour · ' +
          e.rules.contingency +
          '% contingency',
      ) +
      '</p>' +
      (d.lowRate != null || d.highRate != null
        ? '<h3>Hourly-rate sensitivity</h3><div class="bs-range">' +
          rateRange(e, d)
            .map(
              (row, i) =>
                '<div><small>' +
                ['Low', 'Working', 'High'][i] +
                ' · ' +
                money(row.rate) +
                '/h</small><strong>' +
                money(row.total) +
                '</strong></div>',
            )
            .join('') +
          '</div>'
        : '') +
      productionBasis(f) +
      (d.project && !get().program ? btn('connect', 'Use this package in Budget and Schedule') : '') +
      (get().program ? '<a href="#/schedule">View crew assignments ↗</a>' : '') +
      '</section>' +
      laborReview(e, d) +
      options(e, d) +
      scopeTable(e) +
      (e.warnings.length
        ? '<details class="bs-card"><summary>Open field checks <small>' +
          e.warnings.length +
          '</small></summary>' +
          e.warnings.map((s) => '<p>' + esc(s) + '</p>').join('') +
          '</details>'
        : ''))
  );
}
function shopView(e, f) {
  const ix = Math.max(
      0,
      e.rooms.findIndex((r) => r.key === roomKey),
    ),
    r = f.rooms[ix];
  if (!r)
    return '<section class="bs-card"><h2>No cut pieces yet</h2><p>Add a trim section to a wall in MODEL.</p><a href="#/model">Open model ↗</a></section>';
  const scale = Math.max(...r.boards.map((b) => b.length), 0.01);
  return (
    '<div class="bs-links"><a href="#/sheets?section=products">Product and scope sheets</a><a href="#/documents?package=cut">Print shop cut sheets</a></div><section class="bs-card"><div class="bs-section"><label>Room <select data-room-picker>' +
    e.rooms.map((x, i) => choice(x.key, x.name, e.rooms[ix].key)).join('') +
    '</select></label>' +
    btn('csv', 'Download cut list') +
    '</div><h2>' +
    esc(r.name) +
    '</h2><p>' +
    r.cuts.length +
    ' pieces · ' +
    r.boards.length +
    ' stock lengths · ' +
    num(r.hours) +
    ' labor hours</p>' +
    (get().references?.[e.rooms[ix].key] || [])
      .map(
        (ref) =>
          '<figure class="bs-room-reference"><img src="' +
          esc(ref.image) +
          '" alt="' +
          esc(ref.label) +
          '"><figcaption>' +
          esc(ref.label) +
          '</figcaption></figure>',
      )
      .join('') +
    (e.rooms[ix].parts[0]?.wallId
      ? '<a href="#/model?select=' +
        encodeURIComponent(e.rooms[ix].parts[0].wallId) +
        '">Locate wall in MODEL ↗</a>'
      : '') +
    r.boards
      .map(
        (b) =>
          '<details class="bs-stick"><summary><span>' +
          esc(b.mark + ' · ' + b.name) +
          '</span><b>' +
          esc(lens(b.length)) +
          '</b></summary><p>' +
          b.cuts.map((c) => esc(c.mark + ' / ' + lens(c.length))).join(' · ') +
          '</p></details>' +
          boardDiagram(b, scale),
      )
      .join('') +
    '<h3>Installer marks</h3><div class="bs-table-scroll"><table><thead><tr><th>Mark</th><th>Wall / part</th><th>Long point</th><th>Left / right end</th></tr></thead><tbody>' +
    r.cuts
      .map(
        (c) =>
          '<tr><td>' +
          esc(c.mark) +
          '</td><td>' +
          esc(c.wall + ' · ' + c.part) +
          '</td><td>' +
          esc(lens(c.len)) +
          '</td><td>' +
          esc(c.left + ' / ' + c.right) +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table></div></section>'
  );
}
function alternatesView(prop, projects, base, draftState) {
  const scope = projectTree(projects, draftState.project);
  const specified = (prop.trims || []).filter((t) => !scope || scope.has(t.projectId)).map(trimProduct);
  for (const piece of draftState.profile?.supplement || []) {
    if (!scope || scope.has(piece.project)) specified.push(catalogItem(piece.product));
  }
  const products = [
    ...new Map(specified.filter((p) => p && catalogFor(p.style).length > 1).map((p) => [p.id, p])).values(),
  ];
  const source = products.find((p) => p.id === alternateSource) || products[0];
  if (!source)
    return '<section class="bs-card"><h2>Material alternates</h2><p>The selected scope has no trim with catalog alternatives.</p></section>';
  const options = catalogFor(source.style).filter((p) => p.id !== source.id);
  const target = options.find((p) => p.id === alternateProduct) || options[0];
  const trims = prop.trims.map((t) => (trimProduct(t)?.id === source.id ? { ...t, product: target.id } : t));
  const profile = draftState.profile;
  const trial = profile
    ? {
        ...draftState,
        profile: {
          ...profile,
          supplement: profile.supplement.map((p) =>
            p.product === source.id ? { ...p, product: target.id } : p,
          ),
        },
      }
    : draftState;
  const candidate = estimate({ ...prop, trims }, projects, trial);
  const metrics = [
    ['Stock with spares', base.material, candidate.material, money],
    ['Consumables', base.consumables, candidate.consumables, money],
    ['Labor hours', base.hours, candidate.hours, (n) => num(n) + ' h'],
    ['Crew days', base.days, candidate.days, (n) => num(n)],
    [
      base.incomplete || candidate.incomplete ? 'Priced subtotal' : 'Package total',
      base.total,
      candidate.total,
      money,
    ],
  ];
  const menu = (key, items, selected) =>
    '<select data-' +
    key +
    '>' +
    items.map((p) => choice(p.id, p.short + ' · ' + p.sku, selected)).join('') +
    '</select>';
  return (
    '<section class="bs-card"><h2>Material alternates</h2><p>Compare two purchasable products in the selected scope. Each column uses its own profile dimensions, cut plan and available stock. The drawing keeps its specified product.</p>' +
    '<div class="bs-fields"><label>Specified product' +
    menu('source', products, source.id) +
    '</label><label>Price an alternate' +
    menu('alternate', options, target.id) +
    '</label></div>' +
    '<div class="bs-table-scroll"><table><thead><tr><th>Measure</th><th>As drawn</th><th>Alternate</th><th>Change</th></tr></thead><tbody>' +
    metrics
      .map(
        ([label, a, b, format]) =>
          '<tr><td>' +
          label +
          '</td><td>' +
          format(a) +
          '</td><td>' +
          format(b) +
          '</td><td>' +
          (base.incomplete || candidate.incomplete ? 'Open pricing' : (b > a ? '+' : '') + format(b - a)) +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table></div>' +
    (candidate.warnings.length
      ? '<h3>Field checks for the alternate</h3>' +
        candidate.warnings.map((w) => '<p>' + esc(w) + '</p>').join('')
      : '') +
    '</section>'
  );
}
function bidHours(issue, bids) {
  const priced = bids.filter((b) => b.hours);
  if (!priced.length) return '';
  const tasks = issue.facts.rooms.flatMap((r) => r.labor.map((t) => ({ room: r.name, ...t })));
  return (
    '<details class="bs-card"><summary>Contractor hours by task</summary><div class="bs-table-scroll"><table><thead><tr><th>Room / task</th><th>Estimated</th>' +
    priced.map((b) => '<th>' + esc(b.name) + '</th>').join('') +
    '</tr></thead><tbody>' +
    tasks
      .map(
        (t, i) =>
          '<tr><td>' +
          esc(t.room + ' · ' + t.name) +
          '</td><td>' +
          num(t.hours) +
          ' h</td>' +
          priced.map((b) => '<td>' + (b.hours[i] == null ? '—' : num(b.hours[i]) + ' h') + '</td>').join('') +
          '</tr>',
      )
      .join('') +
    '</tbody></table></div></details>'
  );
}
function changeBridge(before, after) {
  const components = [
    ['Stock', 'material'],
    ['Supplies', 'consumables'],
    ['Labor', 'labor'],
    ['Additional scope', 'scopeCost'],
    ['Allowance', 'allowance'],
  ];
  const lines = components.map(([name, key]) => [name, after[key] - before[key]]);
  for (const key of Object.keys(after.adjustments))
    lines.push([key, after.adjustments[key] - (before.adjustments[key] || 0)]);
  return (
    '<details><summary>What changed since issue</summary>' +
    (lines
      .filter(([, delta]) => Math.abs(delta) >= 0.005)
      .map(([name, delta]) => '<p>' + esc(name) + ' · ' + (delta > 0 ? '+' : '') + money(delta) + '</p>')
      .join('') ||
      '<p>The price build-up is unchanged. Compare the issued documents with the current package for the revision.</p>') +
    '</details>'
  );
}
function planningScenarios(prop, projects, draft, e) {
  const cases = [['Working plan', draft, e]];
  if (e.hours > 0 && e.rules.crew < 100) {
    const faster = { ...draft, rules: { ...draft.rules, crew: e.rules.crew + 1 } };
    cases.push(['Add one crew member', faster, estimate(prop, projects, faster)]);
  }
  if (draft.profile?.supplement?.some((p) => p.style === 'stair')) {
    const omit = {
      ...draft,
      profile: { ...draft.profile, supplement: draft.profile.supplement.filter((p) => p.style !== 'stair') },
    };
    cases.push(['Leave the external stair trim in place', omit, estimate(prop, projects, omit)]);
  }
  return (
    '<section class="bs-card"><h2>Planning scenarios</h2><div class="bs-table-scroll"><table><thead><tr><th>Scope and crew</th><th>People</th><th>Person-hours</th><th>Estimated price</th><th>Finish</th></tr></thead><tbody>' +
    cases
      .map(
        ([name, state, model]) =>
          '<tr><td>' +
          esc(name) +
          '</td><td>' +
          model.rules.crew +
          '</td><td>' +
          num(model.hours) +
          '</td><td>' +
          money(model.total) +
          '</td><td>' +
          esc(facts(prop, projects, model, state).finish || 'Set start date') +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table></div></section>'
  );
}
function bidsView(f, s) {
  const issues = s.issues || [],
    issue = issues.find((i) => i.id === issueId) || issues.at(-1);
  if (!issue)
    return (
      '<section class="bs-card"><h2>Issue the first bid package</h2><p>Freeze the estimate, purchase list and cut plan together. Contractors can return a priced bid and clients can return an approval for that exact issue.</p>' +
      btn('issue', 'Issue package', true) +
      '</section>'
    );
  const changed = !sameJson(issue.facts, f),
    diff = f.total - issue.facts.total;
  const responses = (s.responses || []).filter((r) => r.issue === issue.id);
  const bids = responses
    .filter((r) => r.kind === 'bid')
    .map((r) => ({
      ...r,
      base: r.labor + r.materials + r.other,
      level: r.labor + r.materials + r.other + r.excluded,
    }))
    .sort((a, b) => a.level - b.level);
  return (
    '<section class="bs-card"><div class="bs-section"><label>Issued package <select data-issue>' +
    issues.map((i) => choice(i.id, 'Issue ' + i.number + ' · ' + i.date, issue.id)).join('') +
    '</select></label>' +
    btn('issue', 'Issue current estimate') +
    '</div><h2>' +
    esc(issue.facts.title) +
    '</h2><div class="bs-issue"><strong>' +
    money(issue.facts.total) +
    '</strong><span>' +
    esc(
      changed
        ? 'Working estimate has changed · ' + (diff >= 0 ? '+' : '') + money(diff)
        : 'Matches the current estimate',
    ) +
    '</span></div>' +
    (changed ? changeBridge(issue.facts, f) : '') +
    '<div class="bs-actions">' +
    btn('export', 'Download guest package', true) +
    btn('response', 'Import guest response…') +
    '</div><p>The HTML package works offline. Return files are attached to the issue they reference.</p></section>' +
    '<section class="bs-card"><h2>Bid leveling</h2>' +
    (bids.length
      ? '<div class="bs-table-scroll"><table><thead><tr><th>Contractor</th><th>Offered</th><th>Exclusions allowance</th><th>Comparable total</th><th>vs. issue</th></tr></thead><tbody>' +
        bids
          .map(
            (b) =>
              '<tr><td>' +
              esc(b.name) +
              '<small>' +
              esc(b.note) +
              '</small></td><td>' +
              money(b.base) +
              '</td><td>' +
              money(b.excluded) +
              '</td><td>' +
              money(b.level) +
              '</td><td>' +
              money(b.level - issue.facts.total) +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>'
      : '<p>Returned contractor bids appear here with exclusions and a comparable total.</p>') +
    '<h3>Client responses</h3>' +
    (responses
      .filter((r) => r.kind === 'approval')
      .map(
        (r) => '<p>' + esc(r.name + ' · ' + r.date + ' · ' + (r.note || 'Approved issued package')) + '</p>',
      )
      .join('') || '<p>Awaiting approval of this issue.</p>') +
    '</section>' +
    bidHours(issue, bids)
  );
}

export function mount(el) {
  if (!document.querySelector('link[data-bid-style]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('../css/bid-studio.css', import.meta.url).href;
    css.dataset.bidStyle = '';
    document.head.append(css);
  }
  root = el;
  lastProp = ''; // Re-read the route after a property switch or back navigation.
  stopWatching = onChange(() => {
    if (!pendingRender) pendingRender = requestAnimationFrame(render);
  });
  render();
}
export function unmount() {
  stopWatching?.();
  cancelAnimationFrame(pendingRender);
  pendingRender = 0;
  if (root) {
    root.onclick = null;
    root.onchange = null;
  }
  root = null;
}
function render() {
  cancelAnimationFrame(pendingRender);
  pendingRender = 0;
  if (!root) return;
  const prop = activeProperty();
  if (!prop) {
    root.innerHTML =
      '<div class="view-scroll"><h2>Bid Studio</h2><p>Choose NEW PROPERTY under FILE to prepare an estimate.</p></div>';
    return;
  }
  if (lastProp !== prop.id) {
    lastProp = prop.id;
    roomKey = '';
    issueId = '';
    const q = new URLSearchParams(location.hash.split('?')[1]);
    tab = location.hash.startsWith('#/sheets')
      ? 'shop'
      : q.has('package')
        ? 'documents'
        : Object.hasOwn(tabs, q.get('section'))
          ? q.get('section')
          : 'estimate';
    if (q.has('room')) roomKey = q.get('room');
    notice = '';
    openRates = false;
    alternateSource = '';
    alternateProduct = '';
  }
  const projects = propertyProjects(),
    s = get(),
    d = draft(),
    e = estimate(prop, projects, d),
    f = facts(prop, projects, e, d);
  const prev = root.querySelector('.bs-studio')?.scrollTop || 0;
  root.innerHTML =
    '<div class="view-scroll bs-studio"><div class="bs-wrap"><header class="bs-head"><div><small>' +
    esc(prop.name) +
    '</small><h1>' +
    esc(tab === 'shop' ? 'Shop cut sheets' : d.title || 'Estimate & bids') +
    '</h1><div class="bs-links"><a href="#/budget?section=program">Program budget</a><a href="#/schedule">Crew Gantt</a><a href="#/documents">Document library</a></div></div><label>Package scope<select data-project>' +
    choice('', 'Whole property', d.project || '') +
    projects.map((p) => choice(p.id, (p.parentId ? '↳ ' : '') + p.name, d.project)).join('') +
    '</select></label></header>' +
    '<div class="bs-summary"><div><small>' +
    (e.incomplete ? 'Priced subtotal · open items' : 'Working estimate') +
    '</small><strong>' +
    money(e.total) +
    '</strong></div><div><small>Labor</small><b>' +
    num(e.hours) +
    ' h</b></div><div><small>Crew schedule</small><b>' +
    num(f.days) +
    ' days</b><small>' +
    esc(f.finish ? 'Finish ' + f.finish : '') +
    '</small></div><div><small>Cut pieces</small><b>' +
    e.rooms.reduce((n, r) => n + r.cuts.length, 0) +
    '</b></div></div>' +
    '<nav class="bs-tabs" aria-label="Bid workspace">' +
    Object.entries(tabs)
      .map(
        ([k, n]) =>
          '<button data-tab="' +
          k +
          '" aria-current="' +
          (tab === k ? 'page' : 'false') +
          '">' +
          n +
          '</button>',
      )
      .join('') +
    '<div class="bs-history"><button data-act="undo" aria-label="Undo estimate input" ' +
    (history(prop.id).undo.length ? '' : 'disabled') +
    '>' +
    icon('undo') +
    '</button><button data-act="redo" aria-label="Redo estimate input" ' +
    (history(prop.id).redo.length ? '' : 'disabled') +
    '>' +
    icon('redo') +
    '</button></div></nav>' +
    '<p class="bs-feedback" role="status">' +
    esc(notice) +
    '</p>' +
    (tab === 'estimate'
      ? estimateView(e, d, f)
      : tab === 'shop'
        ? shopView(e, f)
        : tab === 'alternates'
          ? alternatesView(prop, projects, e, d)
          : bidsView(f, s) + planningScenarios(prop, projects, d, e)) +
    '</div></div>';
  root.querySelector('.bs-studio').scrollTop = prev;
  const sample = root.querySelector('[data-sample]');
  if (sample) {
    const output = sample.querySelector('output');
    sample.oninput = () => output.replaceChildren();
    sample.onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(sample),
        id = data.get('task'),
        units = Number(data.get('units')),
        minutes = Number(data.get('minutes'));
      const hours = minutes / (60 * units);
      if (!(units > 0 && minutes > 0 && Number.isFinite(hours) && hours <= 10000)) return;
      const task = e.tasks.find((t) => t.id === id);
      const observation = minutes + ' person-minutes for ' + units + ' ' + (task.unit || task.per);
      const next = {
        ...d,
        production: { ...d.production, [id]: hours },
        observations: { ...d.observations, [id]: observation },
      };
      const model = estimate(prop, projects, next),
        after = facts(prop, projects, model, next);
      output.textContent =
        num(e.hours) +
        ' → ' +
        num(model.hours) +
        ' person-hours · ' +
        money(e.total) +
        ' → ' +
        money(model.total) +
        (after.finish ? ' · Finish ' + after.finish : '') +
        ' ';
      const apply = document.createElement('button');
      apply.className = 'btn';
      apply.type = 'button';
      apply.textContent = 'Use this pace';
      apply.onclick = () => {
        if (current(prop.id).bidStudio?.draft !== d && !sameJson(d, draft())) {
          render();
          return;
        }
        saveDraft(prop, next, 'measured pace');
        notice = 'Working estimate updated from the timed sample.';
        render();
      };
      output.append(apply);
    };
  }
  const rates = root.querySelector('[data-rates]');
  if (rates)
    rates.ontoggle = () => {
      if (rates.isConnected) openRates = rates.open;
    };
  root.onchange = (ev) => {
    if (ev.target.closest('[data-sample]')) return;
    if (ev.target.matches('[data-workday]')) {
      location.hash = '#/budget?section=estimate&day=' + ev.target.value;
      return;
    }
    handle(() => change(ev.target, prop.id));
  };
  root.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.closest('[data-sample]')) return;
    handle(async () => {
      if (b.dataset.tab) {
        const route =
          b.dataset.tab === 'shop'
            ? '#/sheets?section=shop'
            : b.dataset.tab === 'documents'
              ? '#/documents?package=report'
              : '#/budget?section=' + b.dataset.tab;
        if (location.hash !== route) location.hash = route;
        tab = b.dataset.tab;
        notice = '';
      } else if (b.dataset.room) {
        tab = 'shop';
        roomKey = b.dataset.room;
        location.hash = '#/sheets?section=shop&room=' + encodeURIComponent(roomKey);
      } else if (b.dataset.act) await action(b.dataset.act, prop.id);
    });
  };
}
async function handle(fn) {
  try {
    await fn();
  } catch (error) {
    notice = error.message || String(error);
  }
  render();
}
function current(id) {
  const p = activeProperty();
  if (p?.id !== id) throw new Error('The active property changed.');
  return p;
}
function change(t, id) {
  const p = current(id),
    old = draft(),
    next = { ...old };
  if (t.matches('[data-source]')) {
    alternateSource = t.value;
    alternateProduct = '';
    return;
  }
  if (t.matches('[data-alternate]')) {
    alternateProduct = t.value;
    return;
  }
  if (t.matches('[data-room-picker]')) {
    roomKey = t.value;
    return;
  }
  if (t.matches('[data-issue]')) {
    issueId = t.value;
    return;
  }
  if (t.matches('[data-covered]') && p.bidStudio?.program) {
    const bind = p.bidStudio.program,
      ids = new Set(bind.covered || []);
    if (t.checked) ids.add(t.dataset.covered);
    else ids.delete(t.dataset.covered);
    p.bidStudio = { ...p.bidStudio, program: { ...bind, covered: [...ids] } };
    touch();
    return;
  }
  if (t.matches('[data-coats]')) next.twoCoats = t.checked;
  else if (t.matches('[data-project]')) next.project = t.value;
  else if (t.matches('[data-scope]')) {
    const set = new Set(old.included || []);
    if (t.checked) set.add(t.dataset.scope);
    else set.delete(t.dataset.scope);
    next.included = [...set];
  } else if (t.dataset.field) {
    const [kind, k] = t.dataset.field.split(':');
    if (['terms', 'title', 'start'].includes(kind)) next[kind] = t.value;
    else if (kind === 'closed') {
      const dates = t.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        dates.length > 366 ||
        dates.some(
          (v) =>
            !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
            !Number.isFinite(Date.parse(v)) ||
            new Date(v).toISOString().slice(0, 10) !== v,
        )
      )
        throw new Error('Use valid dates in YYYY-MM-DD format, separated by commas.');
      next.closed = [...new Set(dates)].sort();
    } else if (kind === 'lowRate' || kind === 'highRate') next[kind] = checkNumber(Number(t.value), 0, 10000);
    else if (kind === 'length') {
      const v = readLength(t.value, 'inches').value;
      checkNumber(v, k === 'gap' || k === 'endTrim' ? 0 : 0.1, 30);
      const rules = { ...estimate(p, propertyProjects(), old).rules, [k]: v };
      if (rules.cap > rules.stretch || rules.endTrim * 2 + 0.06 >= rules.cap)
        throw new Error('Maximum stock must accommodate the preferred length and both end trims.');
      next.rules = { ...old.rules, [k]: v };
    } else {
      const spec = INPUTS.find((a) => a[0] === k);
      const v = checkNumber(
        t.value.trim() ? Number(t.value) : NaN,
        spec?.[3] ?? 0,
        spec?.[4] ?? 1e8,
        spec?.[5],
      );
      const group = {
        rule: 'rules',
        price: 'prices',
        offer: 'offerPrices',
        supply: 'supplyPrices',
        production: 'production',
        scopeHours: 'scopeHours',
      }[kind];
      next[group] = { ...old[group], [k]: v };
    }
  } else return;
  saveDraft(p, next, 'estimate input');
  notice = '';
}
async function fileText() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  const file = await new Promise((resolve) => {
    input.onchange = () => resolve(input.files[0]);
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return null;
  if (file.size > 8 * 1024 * 1024) throw new Error('Choose a JSON file under 8 MB.');
  return JSON.parse(await file.text());
}
async function action(act, id) {
  let p = current(id);
  const d = draft(),
    s = get(),
    projects = propertyProjects(),
    e = estimate(p, projects, d),
    f = facts(p, projects, e, d);
  const issues = s.issues || [],
    issued = issues.find((i) => i.id === issueId) || issues.at(-1);
  if (act === 'connect' && d.project) {
    const project = projects.find((row) => row.id === d.project);
    project.selected = true;
    p.bidStudio = {
      ...s,
      program: { project: project.id, covered: [] },
      draft: { ...d, start: d.start || isoToday() },
    };
    touch();
    notice =
      'Linked to the project program. Other scope items remain in the program until included in this estimate.';
  }
  if (act === 'undo' || act === 'redo') {
    restore(p, act);
    notice = act === 'undo' ? 'Input restored.' : 'Input reapplied.';
  }
  if (act === 'issue') {
    const issue = { id: uid('bid'), number: issues.length + 1, date: isoToday(), facts: f };
    p.bidStudio = { ...s, issues: [...issues, issue] };
    touch();
    issueId = issue.id;
    notice = 'Saved issue ' + issue.number + '.';
  }
  if (act === 'export' && issued)
    download('Bid package - issue ' + issued.number + '.html', shareHtml(issued), 'text/html');
  if (act === 'profile' || act === 'response') {
    const raw = await fileText();
    if (!raw) return;
    p = current(id);
    if (act === 'profile') {
      const profile = readProfile(raw, id);
      saveDraft(p, { ...draft(), profile }, 'rate book');
      notice = 'Rate book applied.';
    } else {
      const issue = (get().issues || []).find((i) => i.id === raw.issue);
      if (!issue) throw new Error('This response belongs to a different package.');
      const value = readResponse(raw, issue),
        responses = get().responses || [];
      if (
        responses.some(
          (r) =>
            r.issue === issue.id &&
            Object.entries(value).every(([k, v]) => sameJson(v, r[k])) &&
            sameJson(value.hours ?? null, r.hours ?? null),
        )
      )
        throw new Error('This response is already recorded.');
      p.bidStudio = {
        ...get(),
        responses: [...responses, { ...value, id: uid('response'), issue: issue.id, date: isoToday() }],
      };
      touch();
      issueId = issue.id;
      notice = 'Response filed with issue ' + issue.number + '.';
    }
  }
  if (act === 'default-book') {
    const next = { ...d };
    delete next.profile;
    saveDraft(p, next, 'rate book');
    notice = 'Planning allowances restored.';
  }
  if (act === 'csv') {
    const cell = (v) =>
      '"' +
      String(v ?? '')
        .replace(/^[=+@-]/, "'$&")
        .replaceAll('"', '""') +
      '"';
    const rows = [
      ['Room', 'Mark', 'Wall', 'Product', 'Long point', 'Left end', 'Right end'],
      ...f.rooms.flatMap((r) =>
        r.cuts.map((c) => [r.name, c.mark, c.wall, c.name, lens(c.len), c.left, c.right]),
      ),
    ];
    download('Cut list.csv', rows.map((r) => r.map(cell).join(',')).join('\r\n'), 'text/csv');
  }
}

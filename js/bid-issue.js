import { cents } from './bid-stock.js';
import { fmtFeetInches } from './store.js';
const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const endLabel = (s) =>
  ({
    'inside corner': 'cope',
    'outside corner': 'outside miter 45°',
    scarf: 'scarf 45°',
    joint: 'butt joint',
  })[s] || s;
export const lens = (n) => fmtFeetInches(n, { den: 16 });
export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export { money };
// Rooms share the crew. A partial day left in one room carries into the next.
export function crewSchedule(rooms, start, capacity) {
  let elapsed = 0;
  return rooms.map((r) => {
    const first = Math.floor(elapsed / capacity + 1e-9) + 1;
    elapsed += r.hours;
    const last = Math.max(first, Math.ceil(elapsed / capacity - 1e-9));
    return {
      room: r.name,
      hours: r.hours,
      first,
      last,
      from: start ? lastWeekday(start, first) : '',
      to: start ? lastWeekday(start, last) : '',
    };
  });
}
export function facts(prop, projects, e, state) {
  const label = (id) => e.products[id]?.short || id;
  const finish = state.start && e.days ? lastWeekday(state.start, e.days) : '';
  return {
    property: prop.name,
    project: projects.find((p) => p.id === state.project)?.name || 'Property package',
    schedule: crewSchedule(e.rooms, state.start, e.rules.crew * e.rules.hoursDay),
    terms: state.terms || '',
    start: state.start || '',
    finish,
    days: e.days,
    crew: e.rules.crew,
    hoursDay: e.rules.hoursDay,
    title: state.title || 'Bid package',
    rate: e.rules.rate,
    hours: e.hours,
    total: e.total,
    material: e.material,
    labor: e.labor,
    consumables: e.consumables,
    scopeCost: e.scopeCost,
    allowance: e.rules.allowance,
    adjustments: e.adjustments,
    incomplete: e.incomplete,
    warnings: e.warnings,
    book: e.bookName,
    scope: e.scope.filter((s) => s.selected),
    supplies: e.supplies.map((s) => ({ name: s.product, packs: s.packs, price: s.price, total: s.total })),
    order: e.orders.map((o) => ({
      name: label(o.product),
      sku: o.sku || e.products[o.product].sku,
      brand: e.products[o.product].brand,
      model: e.products[o.product].model,
      url: e.products[o.product].url,
      length: o.length,
      qty: o.qty,
      spare: o.spare,
      how: o.how,
      bundle: o.bundle,
      price: o.price,
      total: cents((o.qty + o.spare) * o.price),
    })),
    rooms: e.rooms.map((r) => ({
      name: r.name,
      hours: r.hours,
      material: r.material,
      labor: r.labor.map((t) => ({
        name: t.label,
        qty: t.qty,
        per: t.per,
        rate: t.hours,
        hours: t.extended,
      })),
      cuts: r.cuts.map((c) => ({
        mark: c.mark,
        name: label(c.product),
        wall: c.wallName || c.wallId,
        part: c.side && typeof c.side === 'string' ? c.side : c.kind,
        len: c.length,
        left: endLabel(c.leftIsA === false ? c.endB : c.endA),
        right: endLabel(c.leftIsA === false ? c.endA : c.endB),
      })),
      boards: r.boards.map((b) => ({
        mark: b.mark,
        name: label(b.product),
        length: b.length,
        price: b.price,
        cuts: b.cuts.map((c) => ({ mark: c.mark, use: c.use, length: c.length })),
        gap: e.rules.gap,
        endTrim: e.rules.endTrim,
      })),
    })),
  };
}
function lastWeekday(start, days) {
  const d = new Date(start + 'T12:00:00Z');
  if (!Number.isFinite(+d) || !Number.isSafeInteger(days) || days < 1 || days > 50000) return '';
  const advance = () => d.setUTCDate(d.getUTCDate() + 1);
  while ([0, 6].includes(d.getUTCDay())) advance();
  d.setUTCDate(d.getUTCDate() + Math.floor((days - 1) / 5) * 7);
  for (let i = 0; i < (days - 1) % 5; i++) {
    advance();
    while ([0, 6].includes(d.getUTCDay())) advance();
  }
  return d.toISOString().slice(0, 10);
}

export const DOCS = {
  report: 'Package overview',
  buy: 'Purchase order',
  cut: 'Shop cut list',
  bid: 'Installer bid form',
  scope: 'Scope of work',
  schedule: 'Crew schedule',
  agreement: 'Draft agreement',
};
const table = (heads, rows) =>
  '<table><thead><tr>' +
  heads.map((x) => '<th>' + esc(x) + '</th>').join('') +
  '</tr></thead><tbody>' +
  rows.map((row) => '<tr>' + row.map((x) => '<td>' + esc(x) + '</td>').join('') + '</tr>').join('') +
  '</tbody></table>';
function orderTable(f) {
  const rows = f.order.map((o) => [
    o.name + ' · ' + o.sku,
    lens(o.length),
    o.qty,
    o.spare,
    o.bundle,
    money(o.price),
    money(o.total),
  ]);
  const sources = Array.from(
    new Map(f.order.filter((o) => /^https?:\/\//i.test(o.url)).map((o) => [o.url, o])).values(),
  );
  return (
    table(['Product / item', 'Stock', 'Needed', 'Spare', 'Units per pack', 'Each', 'Extension'], rows) +
    (sources.length
      ? '<h3>Product references</h3><ul>' +
        sources
          .map(
            (o) =>
              '<li><a rel="noreferrer" href="' +
              esc(o.url) +
              '">' +
              esc([o.brand, o.model, o.name].filter(Boolean).join(' · ')) +
              '</a></li>',
          )
          .join('') +
        '</ul>'
      : '')
  );
}
export function boardDiagram(b, scale = b.length) {
  let at = b.endTrim;
  return (
    '<div class="bd-board" style="width:' +
    Math.min(100, (100 * b.length) / scale) +
    '%" role="img" aria-label="' +
    esc(b.mark + ' · ' + lens(b.length) + ' · ' + b.cuts.map((c) => c.mark).join(', ')) +
    '">' +
    b.cuts
      .map((c, i) => {
        const left = at;
        at += c.use + b.gap;
        return (
          '<span style="left:' +
          (left / b.length) * 100 +
          '%;width:' +
          (c.length / b.length) * 100 +
          '%" title="' +
          esc(c.mark + ' · ' + lens(c.length)) +
          '">' +
          (i + 1) +
          '</span>'
        );
      })
      .join('') +
    '</div>'
  );
}
function roomCuts(r) {
  const scale = Math.max(1, ...r.boards.map((b) => b.length));
  return (
    '<h3>' +
    esc(r.name) +
    '</h3>' +
    r.boards
      .map(
        (b) =>
          '<div class="bd-stick"><b>' +
          esc(b.mark + ' · ' + b.name + ' · ' + lens(b.length)) +
          '</b>' +
          boardDiagram(b, scale) +
          '<small>' +
          b.cuts.map((c) => esc(c.mark + ' ' + lens(c.length))).join(' · ') +
          '</small></div>',
      )
      .join('') +
    table(
      ['Mark', 'Wall / piece', 'Product', 'Long point', 'Left end', 'Right end'],
      r.cuts.map((c) => [c.mark, c.wall + ' · ' + c.part, c.name, lens(c.len), c.left, c.right]),
    )
  );
}
function scopeBody(f) {
  return (
    table(
      ['Room', 'Trim pieces', 'Estimated hours'],
      f.rooms.map((r) => [r.name, r.cuts.length, r.hours.toFixed(1)]),
    ) +
    (f.scope.length
      ? table(
          ['Additional scope', 'Project', 'Quantity', 'Amount'],
          f.scope.map((s) => [s.name, s.project, s.qty + ' ' + s.unit, money(s.likely)]),
        )
      : '')
  );
}
function overview(f) {
  return (
    table(
      ['Cost build-up', 'Amount'],
      [
        ['Stock with spares', money(f.material)],
        ['Supplies', money(f.consumables)],
        ['Labor · ' + f.hours.toFixed(1) + ' h × ' + money(f.rate), money(f.labor)],
        ['Additional project scope', money(f.scopeCost)],
        ['Allowance', money(f.allowance)],
        ...Object.entries(f.adjustments).map(([k, v]) => [k, money(v)]),
        [f.incomplete ? 'Priced subtotal · open items' : 'Package total', money(f.total)],
      ],
    ) +
    '<p>' +
    esc(
      f.days +
        ' working days · ' +
        f.crew +
        ' crew × ' +
        f.hoursDay +
        ' h/day' +
        (f.start ? ' · ' + f.start + ' to ' + f.finish : ''),
    ) +
    '</p>'
  );
}

export function documentBody(f, kind) {
  let body;
  if (kind === 'buy')
    body =
      orderTable(f) +
      table(
        ['Consumable', 'Packages', 'Price', 'Amount'],
        f.supplies.map((s) => [s.name, s.packs, money(s.price), money(s.total)]),
      );
  else if (kind === 'cut') body = f.rooms.map(roomCuts).join('');
  else if (kind === 'bid')
    body =
      '<p>Bidder ____________________ &nbsp; Date __________</p>' +
      f.rooms
        .map(
          (r) =>
            '<h3>' +
            esc(r.name) +
            '</h3>' +
            table(
              ['Task', 'Quantity', 'Hours/unit', 'Estimated hours', 'Bid hours'],
              r.labor.map((t) => [t.name, t.qty.toFixed(2), t.rate, t.hours.toFixed(2), '________']),
            ),
        )
        .join('') +
      '<p>Labor $________ · Materials $________ · Other $________</p><p>Exclusions and qualifications ________________________________________</p>';
  else if (kind === 'schedule')
    body = table(
      ['Room sequence', 'Crew hours', 'First workday', 'Last workday'],
      (f.schedule || []).map((s) => [
        s.room,
        s.hours.toFixed(1),
        s.from || 'Day ' + s.first,
        s.to || 'Day ' + s.last,
      ]),
    );
  else if (kind === 'scope') body = scopeBody(f);
  else if (kind === 'agreement')
    body =
      '<p>Owner ____________________ &nbsp; Contractor ____________________</p>' +
      scopeBody(f) +
      overview(f) +
      '<h3>Payment terms and exclusions</h3><p>' +
      esc(f.terms || 'Terms to be agreed.').replaceAll('\n', '<br>') +
      '</p><p>Owner ____________________ Date ________</p><p>Contractor ____________________ Date ________</p>';
  else body = overview(f) + scopeBody(f);
  const warnings = f.warnings.length
    ? '<h3>Open checks</h3><ul>' + f.warnings.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul>'
    : '';
  return (
    '<article class="bd-paper"><small>' +
    esc(f.property + ' / ' + f.project) +
    '</small><h2>' +
    esc(DOCS[kind] || DOCS.report) +
    '</h2>' +
    body +
    warnings +
    '</article>'
  );
}

export function readResponse(raw, issue) {
  if (raw?.format !== 'tiksi-bid-response/1' || raw.issue !== issue.id)
    throw new Error('Choose a response to this issue.');
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = str(raw.name, 140),
    note = str(raw.note, 4000);
  if (!name) throw new Error('The response needs a name.');
  if (raw.kind === 'approval') return { kind: 'approval', name, note };
  const amount = (k) => {
    const n = raw[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e9)
      throw new Error('Invalid ' + k + ' amount.');
    return cents(n);
  };
  if (raw.kind !== 'bid') throw new Error('Unrecognized response type.');
  const tasks = issue.facts.rooms.flatMap((r) => r.labor);
  const hours = raw.hours;
  if (
    hours != null &&
    (!Array.isArray(hours) ||
      hours.length !== tasks.length ||
      hours.some((h) => h !== null && (typeof h !== 'number' || !Number.isFinite(h) || h < 0 || h > 100000)))
  ) {
    throw new Error('Bid hours must correspond to the tasks in this issue.');
  }
  return {
    kind: 'bid',
    name,
    note,
    ...(hours?.some((h) => h !== null) ? { hours } : {}),
    labor: amount('labor'),
    materials: amount('materials'),
    other: amount('other'),
    excluded: amount('excluded'),
  };
}

export function shareHtml(issue) {
  const f = issue.facts;
  const hoursForm = f.rooms
    .map(
      (r) =>
        '<h3>' +
        esc(r.name) +
        '</h3>' +
        r.labor
          .map(
            (t) =>
              '<label>' +
              esc(t.name) +
              ' · estimated ' +
              t.hours.toFixed(1) +
              ' h <input data-bid-hours type="number" min="0" max="100000" step=".01" placeholder="Your hours"></label>',
          )
          .join(''),
    )
    .join('');
  const sections = Object.entries(DOCS)
    .map(
      ([k, name]) =>
        '<section id="' +
        k +
        '"><details' +
        (k === 'report' ? ' open' : '') +
        '><summary>' +
        esc(name) +
        '</summary>' +
        documentBody(f, k) +
        '</details></section>',
    )
    .join('');
  // The exported file contains a frozen package. Recipient fields leave their browser only when they save and return a response.
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    esc(f.title) +
    '</title><style>' +
    'body{margin:auto;max-width:960px;padding:4vw;color:#202b28;background:#f6f5f0;font:16px/1.5 system-ui}header{border-bottom:3px solid #397968}h1{font:normal 3rem Georgia;margin:.2em 0}details,form{background:white;border:1px solid #cbd1cd;padding:1em;margin:1em 0;overflow:auto}summary{cursor:pointer;font-weight:bold}table{border-collapse:collapse;width:100%;font-size:.88rem}td,th{text-align:left;padding:.45em;border-bottom:1px solid #ddd}label{display:block;margin:.5em 0}input,textarea,select,button{font:inherit;padding:.4em;max-width:100%}.bd-stick{break-inside:avoid}.bd-board{height:1.2em;background:#dfdacd;position:relative}.bd-board span{position:absolute;background:#518f7a;color:white;text-align:center;font-size:.75em;height:100%;overflow:hidden}.bd-board span:nth-child(even){background:#355d54}@media print{button,form,summary{display:none}details{border:0}h3,tr{break-inside:avoid}}' +
    '</style><header><small>' +
    esc(issue.date + ' · Issue ' + issue.number) +
    '</small><h1>' +
    esc(f.title) +
    '</h1><p>' +
    esc(f.property + ' · ' + f.project) +
    '</p></header>' +
    sections +
    '<button onclick="document.querySelectorAll(\'details\').forEach(d=>d.open=true);window.print()">Print package</button>' +
    '<form id="response"><h2>Return a response</h2><label>Response <select name="kind"><option value="bid">Contractor bid</option><option value="approval">Client approval of this issue</option></select></label><label>Name <input required name="name" maxlength="140"></label><fieldset><legend>Bid amounts</legend>' +
    ['labor', 'materials', 'other', 'excluded']
      .map(
        (k) =>
          '<label>' +
          esc(k === 'excluded' ? 'Allowance for exclusions, for comparison only' : k) +
          ' <input type="number" min="0" max="1000000000" step=".01" value="0" required name="' +
          k +
          '"></label>',
      )
      .join('') +
    '<details><summary>Enter hours by room and task</summary>' +
    hoursForm +
    '</details></fieldset><label>Exclusions or approval notes <textarea maxlength="4000" name="note"></textarea></label><p>Save the response file and return it to the person who issued this package.</p><button>Save response</button></form><script>' +
    'const form=document.getElementById("response");form.elements.kind.onchange=()=>{const field=form.querySelector("fieldset");field.hidden=field.disabled=form.elements.kind.value==="approval"};form.onsubmit=e=>{e.preventDefault();const d=Object.fromEntries(new FormData(form));for(const k of ["labor","materials","other","excluded"])d[k]=Number(d[k]);if(d.kind==="bid")d.hours=Array.from(form.querySelectorAll("[data-bid-hours]"),el=>el.value===""?null:Number(el.value));d.format="tiksi-bid-response/1";d.issue=' +
    JSON.stringify(issue.id).replaceAll('<', '\\u003c') +
    ';const url=URL.createObjectURL(new Blob([JSON.stringify(d)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="bid-response.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};</script></html>'
  );
}

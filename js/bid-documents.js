// The bid package: the documents a job needs, written from its estimate (estimate.js) so every
// one of them says the same thing as ESTIMATE. Pure: each builder returns the HTML of one
// document (letter pages, class "bd-doc"), which DOCUMENTS shows and prints. Printed from the
// browser they are text PDFs (Save as PDF), searchable and small.
//
//   proposal   for the client: the work, the price, options, schedule, terms, a place to sign
//   scope      scope of work: room by room, what is included and what is not
//   contract   a contract filled from the proposal, scope, price, schedule and payment terms
//   bidform    for a carpenter to price: tasks and quantities, blank hours and price columns
//   buylist    what to order: mouldings by store length with item numbers, then supplies
//   cutlist    room by room: every piece with its length and ends, the wall drawings and the
//              boards each wall is cut from
//
// Settings the documents keep on the top-level project (project.terms) and the business that
// sends them (settings.business) are read here and edited in DOCUMENTS.

import { reportModel, slug, money2, hrs, pct } from './estimate-report.js';
import { elevationSvg, cutsHtml } from './trim-drawings.js';
import { trimStyle } from './trims.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IN = 0.0254;
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

export const DOCS = [
  { id: 'proposal', title: 'Proposal', who: 'For the client', what: 'The work, the price, options, schedule and terms, with a place to accept.' },
  { id: 'scope', title: 'Scope of work', who: 'For the client and the trades', what: 'Room by room: what is included, what is not, and what is assumed.' },
  { id: 'contract', title: 'Contract', who: 'For the client to sign', what: 'Filled from the proposal, scope, price, schedule and payment terms. Have it reviewed before first use.' },
  { id: 'bidform', title: 'Installer bid form', who: 'For a carpenter to price', what: 'Every task with its quantity, and blank columns for their hours and price.' },
  { id: 'buylist', title: 'Buy list', who: 'For ordering', what: 'Mouldings by store length with item numbers, then supplies.' },
  { id: 'cutlist', title: 'Cut list and cut diagrams', who: 'For the shop and the site', what: 'Room by room: every piece, its length and ends; each wall drawn with the boards cut for it.' },
];

export const TERMS_DEFAULTS = Object.freeze({
  deposit: 0.25, progress: 0.5, final: 0.25,
  validDays: 30, warrantyMonths: 12, startDate: '',
  includes: 'Protection of floors and furniture in the work areas, daily cleanup, removal of debris, and touch-up of the trim installed.',
  excludes: 'Wall repair or painting beyond the trim, moving furniture, electrical and plumbing work, permits unless listed, and conditions hidden behind finished surfaces.',
  assumptions: 'Walls are within normal tolerances; lengths are checked on site before ordering. Material prices are as seen on the dates listed and are confirmed at ordering.',
  changes: 'Any change to the work is agreed in writing, with its price and its effect on the schedule, before the changed work starts.',
});
export function termsOf(root) { return { ...TERMS_DEFAULTS, ...((root && root.terms) || {}) }; }

// Working days from a start date (Mon-Fri), the date of the last working day.
export function workingFinish(startIso, days) {
  if (!startIso || !(days > 0)) return '';
  const [y, m, d] = startIso.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  while (t.getDay() === 0 || t.getDay() === 6) t.setDate(t.getDate() + 1);
  let left = Math.ceil(days) - 1;
  while (left > 0) { t.setDate(t.getDate() + 1); if (t.getDay() !== 0 && t.getDay() !== 6) left--; }
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
const longDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); };

function head(M, title, sub) {
  const b = M.business || {};
  return `<header class="bd-head"><div class="bd-from"><b>${esc(b.name || 'Your business name')}</b>${[b.address, b.phone, b.email, b.license ? 'License ' + b.license : ''].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div>
    <div class="bd-what"><span class="bd-kind">${esc(title)}</span><b>${esc(M.est.root.name)}</b><span>${esc(M.propertyName || '')}${M.address ? ', ' + esc(M.address) : ''}</span><span>${esc(longDate(M.date))}${sub ? ' · ' + esc(sub) : ''}</span></div></header>`;
}
const foot = (M, title) => `<footer class="bd-foot"><span>${esc(M.est.root.name)} · ${esc(title)}</span><span>${esc(M.date)}</span></footer>`;
const page = (M, title, body, cls = '') => `<section class="bd-page ${cls}">${body}${foot(M, title)}</section>`;
const doc = (id, pages) => `<div class="bd-doc" data-doc="${id}">${pages.join('')}</div>`;

// What each room or subproject includes, in words, from its drawn trim and scope items.
function scopeLines(M) {
  const { est, t } = M;
  const out = [];
  for (const part of est.parts.values()) {
    const p = part.project;
    const lines = [];
    if (t) {
      const secs = (est.trim.sections || []).filter(s => s.projectId === p.id);
      const kinds = new Map();
      for (const s of secs) {
        const st = trimStyle(s), c = M.product(s.product);
        const k = (st ? st.label : s.style || 'Trim') + (c && c.short ? ': ' + c.short : '');
        kinds.set(k, (kinds.get(k) || 0) + 1);
      }
      for (const [k, n] of kinds) lines.push(`${k}${n > 1 ? `, on ${n} walls` : ''}`);
    }
    for (const it of p.items || []) if (!est.covered.some(c => c.item === it)) lines.push(`${it.name || 'Item'}${it.qty != null && it.unit && it.unit !== 'ls' ? ` (${fmtQ(it.qty)} ${it.unit})` : ''}`);
    if (lines.length) out.push({ part, name: p.id === est.root.id ? (est.parts.size > 1 ? 'Throughout' : p.name) : p.name, lines });
  }
  return out;
}
const fmtQ = q => Math.abs(q - Math.round(q)) < 1e-9 ? String(Math.round(q)) : (Math.round(q * 10) / 10).toString();

// ---------- proposal ----------
function proposal(M) {
  const { est } = M, T = M.terms;
  const start = T.startDate || M.startDate || '';
  const finish = workingFinish(start, est.days);
  const price = Math.round(est.total.likely);
  const scope = scopeLines(M).map(s => `<div class="bd-room"><h3>${esc(s.name)}</h3><ul>${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`).join('');
  const opts = (M.t && M.t.scenarios || []).filter(x => !x.is_design);
  const design = (M.t && M.t.scenarios || []).find(x => x.is_design);
  const optRows = design ? opts.map(x => { const d = Math.round(x.total - design.total); return `<tr><td><b>${esc(x.name)}</b><div class="sm">${esc(x.what || '')}</div></td><td class="r">${d >= 0 ? 'add ' : 'deduct '}${M.money(Math.abs(d))}</td></tr>`; }).join('') : '';
  const pay = payments(M, price);
  return doc('proposal', [page(M, 'Proposal', `${head(M, 'Proposal', 'valid ' + T.validDays + ' days')}
    <p class="bd-lede">${esc(M.clientName ? 'For ' + M.clientName + '. ' : '')}We propose to do the work below for <b>${M.money(price)}</b>${est.days ? `, in about ${plural(est.days, 'working day')}${start ? ` starting ${esc(longDate(start))}` : ''}` : ''}.</p>
    <h2>The work</h2>${scope || '<p>Nothing is in the scope yet.</p>'}
    <h2>Price</h2><table class="bd-t"><tbody>
      ${[...est.parts.values()].filter(p => p.total.likely).map(p => `<tr><td>${esc(p.project.id === est.root.id && est.parts.size > 1 ? 'General' : p.project.name)}</td><td class="r">${M.money(p.total.likely)}</td></tr>`).join('')}
      <tr class="tot"><td>Total${M.est.settings.taxRate ? ', with sales tax on materials' : ''}</td><td class="r">${M.money(price)}</td></tr></tbody></table>
    ${optRows ? `<h2>Options</h2><p class="sm">Each changes one thing from the work above; ask and the price is adjusted by the amount shown.</p><table class="bd-t"><tbody>${optRows}</tbody></table>` : ''}
    <h2>Schedule</h2><p>${est.days ? `About ${plural(est.days, 'working day')} on site${start ? `, from ${esc(longDate(start))}${finish ? ` to about ${esc(longDate(finish))}` : ''}` : ', starting on a date we agree'}.` : 'To be agreed.'}</p>
    <h2>Payment</h2>${pay}
    <h2>Included</h2><p>${esc(T.includes)}</p><h2>Not included</h2><p>${esc(T.excludes)}</p><h2>Assumptions</h2><p>${esc(T.assumptions)}</p>
    <h2>Acceptance</h2><p>Signing below accepts this proposal at ${M.money(price)}. This proposal is valid for ${T.validDays} days from ${esc(longDate(M.date))}.</p>
    ${sigs(M)}`)]);
}
function payments(M, price) {
  const T = M.terms;
  const rows = [['Deposit, on signing', T.deposit], ['When the work is half done', T.progress], ['On completion', T.final]].filter(r => r[1] > 0);
  const sum = rows.reduce((a, r) => a + r[1], 0);
  return `<table class="bd-t"><tbody>${rows.map(([l, f]) => `<tr><td>${esc(l)} (${pct(f)})</td><td class="r">${M.money(Math.round(price * f))}</td></tr>`).join('')}</tbody></table>${Math.abs(sum - 1) > 0.001 ? `<p class="sm bd-warn">The payments add up to ${pct(sum)} of the price, not 100%.</p>` : ''}`;
}
const sigs = M => `<div class="bd-sigs"><div><span class="ln"></span><span>Client signature</span></div><div><span class="ln"></span><span>Date</span></div>
  <div><span class="ln"></span><span>${esc((M.business || {}).name || 'Contractor')}</span></div><div><span class="ln"></span><span>Date</span></div></div>`;

// ---------- scope of work ----------
function scope(M) {
  const { est, t } = M, T = M.terms;
  const rooms = scopeLines(M).map(s => {
    const room = t && M.rooms.find(r => s.part.rooms.includes(r.name));
    const facts = room ? `<p class="sm">${plural(room.walls, 'wall')}, ${Math.round(room.trimLf || 0)} feet of trim, ${plural(room.pieces, 'piece')}.</p>` : '';
    return `<div class="bd-room"><h3>${esc(s.name)}</h3>${facts}<ul>${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  }).join('');
  const products = t ? (t.buy || []).map(b => { const c = M.product(b.product); return `<tr><td><b>${esc(c.short || b.product)}</b><div class="sm">${esc([c.brand, c.model].filter(Boolean).join(' '))}</div></td><td>${esc([c.size, c.material, c.finish].filter(Boolean).join(', '))}</td><td>${esc(c.store || '')}</td></tr>`; }).join('') : '';
  const paint = t && (t.supplies || []).find(x => /paint/i.test(x.category) || /paint/i.test(x.product));
  return doc('scope', [page(M, 'Scope of work', `${head(M, 'Scope of work')}
    <p class="bd-lede">This describes the work priced in the proposal of ${esc(longDate(M.date))}. Where the drawings and this text differ, ask before building.</p>
    <h2>Rooms</h2>${rooms || '<p>Nothing is in the scope yet.</p>'}
    ${products ? `<h2>Materials</h2><table class="bd-t"><thead><tr><th>Moulding</th><th>Size and material</th><th>Source</th></tr></thead><tbody>${products}</tbody></table>
      ${paint ? `<p class="sm">Finish: ${esc(paint.product)}${M.paint ? ', ' + esc(M.paint) : ''}.</p>` : ''}` : ''}
    ${t ? `<h2>Workmanship</h2><ul><li>Inside corners coped; outside corners mitered and glued; runs longer than a board joined with glued 45° scarfs over a stud.</li>
      <li>Nailed into framing at the spacing in the cut list notes; holes filled, joints caulked, sanded and painted.</li>
      <li>Every length is checked on site before cutting; the cut list gives long-point lengths from the drawing.</li></ul>` : ''}
    <h2>Included</h2><p>${esc(T.includes)}</p><h2>Not included</h2><p>${esc(T.excludes)}</p><h2>Assumptions</h2><p>${esc(T.assumptions)}</p>
    <h2>Changes</h2><p>${esc(T.changes)}</p>`)]);
}

// ---------- contract ----------
function contract(M) {
  const { est } = M, T = M.terms, b = M.business || {};
  const price = Math.round(est.total.likely);
  const start = T.startDate || M.startDate || '';
  const finish = workingFinish(start, est.days);
  const blank = (v, w = 'a') => v ? esc(v) : `<span class="bd-blank ${w}"></span>`;
  return doc('contract', [page(M, 'Contract', `${head(M, 'Contract')}
    <p class="bd-note">A template filled from the estimate. Have it reviewed for the place the work is done before first use: home improvement contracts often must carry set wording (in New York, for example, a notice of the right to cancel within three business days and where deposits are held).</p>
    <h2>1. The parties</h2><p>This contract is between ${blank(M.clientName)} (the owner) and ${blank(b.name)}${b.address ? ', ' + esc(b.address) : ''}${b.license ? ', license ' + esc(b.license) : ''} (the contractor), for work at ${blank([M.propertyName, M.address].filter(Boolean).join(', '))}.</p>
    <h2>2. The work</h2><p>The contractor will do the work described in the Scope of Work dated ${esc(longDate(M.date))} and the proposal of the same date, which are part of this contract, with the materials named there or equal ones the owner approves.</p>
    <h2>3. Price</h2><p>The owner will pay <b>${M.money(price)}</b> for the work, plus or minus agreed changes.</p>
    <h2>4. Payments</h2>${payments(M, price)}
    <h2>5. Schedule</h2><p>Work starts on ${blank(start ? longDate(start) : '')} and is substantially complete by ${blank(finish ? longDate(finish) : '')}, about ${plural(est.days || 0, 'working day')} on site, allowing for delays the contractor does not control.</p>
    <h2>6. Changes</h2><p>${esc(T.changes)}</p>
    <h2>7. Site and cleanup</h2><p>${esc(T.includes)}</p>
    <h2>8. Not included</h2><p>${esc(T.excludes)}</p>
    <h2>9. Warranty</h2><p>The contractor warrants the workmanship for ${plural(T.warrantyMonths, 'month')} from completion and passes on the manufacturers' warranties for materials.</p>
    <h2>10. Insurance and permits</h2><p>The contractor carries liability and workers' compensation insurance and shows proof on request, and obtains any permit the work needs unless the scope says otherwise.</p>
    <h2>11. Ending the contract</h2><p>Either party may end this contract in writing if the other fails to do what it requires and does not put it right within 10 days of written notice; the owner then pays for work done and materials bought for the job.</p>
    <h2>12. Right to cancel</h2><p class="bd-blank-p">${blank('', 'p')}</p>
    ${sigs(M)}`)]);
}

// ---------- installer bid form ----------
function bidform(M) {
  const { est, t } = M, T = M.terms;
  const ours = M.showOurHours;
  const rows = [];
  if (t) for (const r of M.rooms) {
    rows.push(`<tr class="g"><td colspan="${ours ? 5 : 4}">${esc(r.name)} · ${plural(r.walls, 'wall')}, ${Math.round(r.trimLf || 0)} LF</td></tr>`);
    for (const l of r.labor || []) { const tk = M.task(l.task); rows.push(`<tr><td>${esc(l.label)}</td><td class="r">${fmtQ(l.qty)} ${esc(l.qty === 1 ? tk.unit_one || l.unit : l.unit)}</td>${ours ? `<td class="r">${hrs(l.hours)}</td>` : ''}<td class="bx"></td><td class="bx"></td></tr>`); }
  }
  for (const part of est.parts.values()) for (const it of part.project.items || []) {
    if (est.covered.some(c => c.item === it)) continue;
    rows.push(`<tr><td>${esc(it.name || 'Item')} <span class="sm">(${esc(part.project.name)})</span></td><td class="r">${fmtQ(it.qty ?? 1)} ${esc(it.unit || '')}</td>${ours ? '<td></td>' : ''}<td class="bx"></td><td class="bx"></td></tr>`);
  }
  return doc('bidform', [page(M, 'Installer bid form', `${head(M, 'Installer bid form', 'please return by ' + (M.bidDue ? longDate(M.bidDue) : '____'))}
    <p class="bd-lede">Please price the labor for the work below. Quantities are taken from the drawings; check them on site. Materials are ${esc(M.materialsBy || 'supplied by us')}. Fill in your hours and your price for each line, or a lump sum at the bottom.</p>
    <div class="bd-fields"><div><span class="ln"></span><span>Company</span></div><div><span class="ln"></span><span>Contact and phone</span></div><div><span class="ln"></span><span>License and insurance</span></div><div><span class="ln"></span><span>Earliest start</span></div></div>
    <table class="bd-t bd-bid"><thead><tr><th>Task</th><th class="r">Quantity</th>${ours ? '<th class="r">Our hours</th>' : ''}<th class="r">Your hours</th><th class="r">Your price</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="4">Nothing to price yet.</td></tr>'}
      <tr class="tot"><td colspan="${ours ? 3 : 2}">Total</td><td class="bx"></td><td class="bx"></td></tr></tbody></table>
    <h2>Terms</h2><ul><li>Price includes protection, cleanup and removal of your debris each day.</li><li>${esc(T.changes)}</li><li>Payment: weekly against work done, or as agreed in writing.</li><li>Lengths in the cut list are long point from the drawing; confirm before cutting.</li></ul>
    ${sigs({ ...M, business: { name: 'Bidder' } })}`)]);
}

// ---------- buy list ----------
function buylist(M) {
  const { t } = M;
  if (!t) return doc('buylist', [page(M, 'Buy list', `${head(M, 'Buy list')}<p>No drawn trim in this project: nothing to order from the drawing.</p>`)]);
  const rows = [];
  for (const b of t.buy || []) {
    const c = M.product(b.product);
    rows.push(`<tr class="g"><td colspan="5"><b>${esc(c.short || b.product)}</b> · ${esc([c.brand, c.model].filter(Boolean).join(' '))} · ${esc(c.store || '')} · ${esc(b.soldText || '')}</td></tr>`);
    for (const l of b.lines || []) {
      const sale = (t.sale || {})[b.product] || {};
      const item = (sale.lengths || []).find(x => Math.abs(x.in - l.lenIn) < 0.01);
      rows.push(`<tr><td>${b.kit ? 'kit' : esc(M.lenIn(l.lenIn))}${l.how === 'foot' ? ' (cut at the store)' : ''}<div class="sm">${esc(item && item.item || (l.how === 'foot' ? sale.foot_item || '' : c.sku || ''))}</div></td><td class="r">${l.rooms}${l.spare ? ' + ' + l.spare + ' spare' : ''}</td><td class="r"><b>${l.order}</b></td><td class="r">${money2(l.price)}</td><td class="r">${money2(l.ext)}</td></tr>`);
    }
  }
  const sup = (t.supplies || []).map(x => `<tr><td>${esc(x.product)}<div class="sm">${esc(x.store || '')} ${esc(x.item_no || '')}</div></td><td>${esc(x.package || '')}</td><td class="r"><b>${x.packages}</b></td><td class="r">${money2(x.price)}</td><td class="r">${money2(x.ext)}</td></tr>`).join('');
  return doc('buylist', [page(M, 'Buy list', `${head(M, 'Buy list', 'confirm prices before ordering')}
    <h2>Mouldings</h2><table class="bd-t"><thead><tr><th>Length and item</th><th class="r">For the rooms</th><th class="r">Order</th><th class="r">Each</th><th class="r">Extended</th></tr></thead><tbody>${rows.join('')}
      <tr class="tot"><td colspan="4">Mouldings</td><td class="r">${money2(t.totals.moulding)}</td></tr></tbody></table>
    <h2>Supplies</h2><table class="bd-t"><thead><tr><th>Supply</th><th>Package</th><th class="r">Buy</th><th class="r">Each</th><th class="r">Extended</th></tr></thead><tbody>${sup}
      <tr class="tot"><td colspan="4">Supplies</td><td class="r">${money2(t.totals.supplies)}</td></tr></tbody></table>`)]);
}

// ---------- cut list ----------
function cutlist(M) {
  const { t } = M;
  if (!t) return doc('cutlist', [page(M, 'Cut list', `${head(M, 'Cut list')}<p>No drawn trim in this project.</p>`)]);
  const pages = [];
  for (const r of M.rooms) {
    const walls = (t.walls || []).filter(w => w.room === r.name);
    const gs = (t.groups || []).filter(g => g.room === r.name);
    const rows = [];
    for (const w of walls) {
      const mine = gs.filter(g => g.wall === w.id);
      if (!mine.length) continue;
      rows.push(`<tr class="g"><td colspan="7">${esc(w.name)}</td></tr>`);
      for (const g of mine) {
        const boards = [...new Set((t.pieces || []).filter(p => p.mark === g.mark).map(p => p.stick).filter(Boolean))].join(', ');
        const nm = g.name.includes(' · ') ? g.name.split(' · ').slice(1).join(' · ') : g.name;
        rows.push(`<tr><td><b>${esc(nm)}</b><div class="sm">${esc(M.product(g.product).short || g.product)} · ${esc(g.mark)}</div></td><td class="nw">${esc(g.size || '')}</td><td class="r">${g.qty}</td><td class="r"><b>${esc(M.lenIn(g.lin))}</b></td><td>${esc(g.endL)} / ${esc(g.endR)}</td><td class="sm">${esc(boards)}</td><td class="c">☐</td></tr>`);
      }
    }
    pages.push(page(M, 'Cut list · ' + r.name, `${head(M, 'Cut list', r.name)}
      <p class="sm">${plural(r.pieces, 'piece')} cut from ${plural(Object.values(r.sticks || {}).reduce((a, b) => a + b, 0), 'store piece')} bought for this room. Lengths are long point. Ends, left / right as you face the wall: cope = inside corner; miter 45° = outside or frame corner; square butt = joint on one wall line; scarf 45° = splice in a long run.${r.check ? ' ' + plural(r.check, 'end') + ' marked check on site meet another wall where the drawing does not say whether the trim turns or stops.' : ''}</p>
      <table class="bd-t bd-cut"><thead><tr><th>Piece</th><th>Wood</th><th class="r">Qty</th><th class="r">Length</th><th>Ends</th><th>Store piece</th><th class="c">Cut</th></tr></thead><tbody>${rows.join('')}</tbody></table>`, 'cut'));
    const wallBlocks = walls.map(w => {
      const boards = (t.boards || []).filter(b => b.wall === w.id);
      let el = '', cuts = '';
      try { el = elevationSvg(w, t, { maxW: 520, maxH: 190 }); } catch { el = ''; }
      try { cuts = cutsHtml(boards, w.id, t, { fs: 1.9 }); } catch { cuts = ''; }
      return `<div class="bd-wall"><h3>${esc(w.name)} <span class="sm">${esc(M.len(w.h1 - w.h0))} wide</span></h3><div class="bd-elev">${el}</div><div class="bd-cuts">${cuts || '<p class="sm">Cut from boards drawn under another wall of the room.</p>'}</div></div>`;
    }).join('');
    pages.push(page(M, 'Walls · ' + r.name, `${head(M, 'Walls and boards', r.name)}${wallBlocks}`, 'walls'));
  }
  return doc('cutlist', pages);
}

const BUILDERS = { proposal, scope, contract, bidform, buylist, cutlist };
// ctx: as reportModel's, plus business, terms, clientName, address, startDate, showOurHours, bidDue, materialsBy, paint
export function documentHtml(id, ctx) {
  const M = reportModel(ctx);
  M.terms = ctx.terms || termsOf(ctx.est.root);
  const b = BUILDERS[id];
  return b ? b(M) : '';
}
export { slug };

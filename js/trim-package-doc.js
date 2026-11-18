// The printed wall trim package, written in the browser from a live estimate: a summary, options
// at a glance, the buy list, each room (pictures, every wall drawn with its pieces beside the boards
// cut for it, then the room's cut list), the installer bid form with hours and its terms, the price
// build-up, and appendices for supplies, tools, labor rates and option prices. Ported from the
// trim package template's page assembly (package.py), which printed the books Matt approved.
//
// Pure: trimPackageHtml(est, ctx) -> { html, css }. `est` is estimateTrim's result
// (trim-estimate.js). `html` is the book inside <div class="tpkg">, one <section class="page"> per
// section (each starts a new sheet). `css` holds the @page rules (letter size, the running header
// and footer, page numbers, each section's own header text): put it in a <style> beside the html
// only where the book is printed (#print-root), since @page rules reach the whole document.
// css/trim-package.css styles the book on screen (white letter sheets) and on paper.
//
// ctx: { title, propertyName, date (ISO), design, status, paint, alternates: [], notExact: [],
//   pictures: { roomName: [url] }, business: { name, address, phone, email, license }, pricesSeen }
// The hourly rate, contingency and spare boards are the estimate's own settings.

import { ftin, money, soldText, cutWord, ROLE_WORD, ROLE_ORDER } from './trim-estimate.js';
import { elevationSvg, cutsHtml } from './trim-drawings.js';
import { OPTIONS } from './estimate-data.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]);
const money0 = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const hrs = v => Number(v).toFixed(1);
const f0 = v => Number(v).toFixed(0);
const comma0 = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct0 = v => (v * 100).toFixed(0);
// Python's '{:.4g}' and '{:.3g}' for the small numbers the rates are.
const gfmt = (v, p) => String(Number(Number(v).toPrecision(p)));
const sum = (a, f = x => x) => a.reduce((n, x) => n + f(x), 0);
const cssStr = t => '"' + String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
const kv = rows => '<dl class="kv">' + rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + '</dl>';
const nz = (v, f = x => Number(x).toFixed(1)) => v ? f(v) : '–';
const SHORTN = { base: 'Base', chair: 'Chair rail', cap: 'Cap', panel: 'Panel', batten: 'Batten', shaker: 'Shaker kit', raised: 'Panel kit', '1x4': '1x4', '1x6': '1x6' };
const CATS = [['fasteners', 'Fasteners'], ['adhesives', 'Glue and adhesive'], ['caulk and filler', 'Caulk and filler'], ['abrasives', 'Sandpaper and abrasives'],
  ['primer and paint', 'Primer and paint'], ['protection', 'Protection and site prep'], ['blades', 'Blades and small consumables']];
// Print sizes, points: as the template's PDF constants.
const PT_PER_IN = 72, PDF_FS = 1.9;

export function trimPackageHtml(est, ctx = {}) {
  const RATE = est.labor.rate, CONT = est.settings.contingency, SPARE = est.settings.sparePerMoulding;
  const T = est.totals, ROOMS = est.rooms, CAT = est.catalog, KIT = new Set(est.kits || []);
  const roleOf = pid => (est.roleOf || {})[pid];
  const WALL = Object.fromEntries(est.walls.map(w => [w.id, w]));
  const roomWalls = name => est.walls.filter(w => w.room === name).sort((a, b) => a.k - b.k);
  const today = ctx.date || '';
  const seenOf = c => (c && c.seen) || ctx.pricesSeen || '';
  const taskOf = id => (est.labor.taskById || {})[id] || {};
  const pages = [], pageCss = [];
  const page = (title, sub, body, cls = '') => {
    const name = `tp${pages.length + 1}`;
    pageCss.push(`@page ${name} { @top-right { content: ${cssStr(sub)}; } }`);
    pages.push(`<section class="page ${cls}" style="page: ${name}">` + (title ? `<h1>${esc(title)}</h1>` : '') + body + '</section>');
  };
  const nPieces = T.pieces, nOrder = T.order;
  const buy = est.buy;
  const supplies = (est.supplies || []).map(s => ({ ...s, category: s.category === 'site prep' ? 'protection' : s.category }));

  // 1 Summary
  const B = ctx.business || {};
  const from = B.name ? `<div class="from"><b>${esc(B.name)}</b>${[B.address, B.phone, B.email, B.license ? 'License ' + B.license : ''].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div>` : '';
  let rows = ROOMS.map(w => `<tr><td>${esc(w.name)}</td><td class="r">${w.walls}</td><td class="r">${f0(w.trimLf)}</td><td class="r">${w.pieces}</td>`
    + `<td class="r">${sum(Object.values(w.sticks))}</td><td class="r">${money0(w.mat)}</td><td class="r">${money0(w.supplies)}</td>`
    + `<td class="r">${hrs(w.hours)}</td><td class="r">${money0(w.laborCost)}</td><td class="r"><b>${money0(w.total)}</b></td></tr>`).join('');
  const foot = `<tr><td>Whole house</td><td class="r">${sum(ROOMS, w => w.walls)}</td><td class="r">${f0(est.house.trim_lf || 0)}</td><td class="r">${nPieces}</td>`
    + `<td class="r">${nOrder - SPARE * buy.length} + ${SPARE * buy.length} spare</td><td class="r">${money0(T.moulding)}</td><td class="r">${money0(T.supplies)}</td>`
    + `<td class="r">${hrs(T.hours)}</td><td class="r">${money0(T.labor)}</td><td class="r">${money0(T.subtotal)}</td></tr>`;
  page('Wall trim package', '1 · Summary', `${from}
<p class="lede">Every piece of the proposed wall trim at ${esc(ctx.title || ctx.propertyName || '')}, room by room: what to buy, a picture of each room, every wall drawn with its pieces beside the cuts that make them, the cut lists, an installer bid form with hours, and the full price with everything it takes to put up. From the trim as drawn in Tiksi on ${esc(today)}.</p>
<div class="figs"><div><b>${nPieces}</b><span>pieces to cut</span></div><div><b>${nOrder}</b><span>store pieces to order</span></div><div><b>${hrs(T.hours)}</b><span>carpenter hours at ${money0(RATE)}/hr</span></div><div><b>${money0(T.total)}</b><span>all in, with ${pct0(CONT)}% contingency, before tax</span></div></div>
<table><thead><tr><th>Room</th><th class="r">Walls</th><th class="r">Trim LF</th><th class="r">Pieces</th><th class="r">Store pieces</th><th class="r">Moulding</th><th class="r">Supplies</th><th class="r">Hours</th><th class="r">Labor</th><th class="r">Before contingency</th></tr></thead>
<tbody>${rows}</tbody><tfoot>${foot}</tfoot></table>
<p class="note">Each room is cut from its own store pieces, so its cut list stands alone and a room can be done on its own. That costs ${sum(buy, b => b.rooms) - sum(buy, b => b.whole)} more store pieces than cutting the whole house together (${sum(buy, b => b.whole)}); the order adds ${SPARE} spare of each moulding. Supplies (nails, glue, adhesive, caulk, filler, sandpaper, primer, paint, protection) are listed in Appendix A and shared out by trim length. Labor is the bid form's hours at ${money0(RATE)}/hr. The ${pct0(CONT)}% contingency (${money0(T.contingency)}) is added to the house total only.</p>
<h2>In this package</h2>
<ol class="toc"><li>Summary</li><li>Options at a glance: the same rooms priced other ways</li><li>Buy list: moulding by room</li><li>Rooms: picture, every wall drawn with its pieces and its cuts, then the room's cut list</li><li>Installer bid form, with hours</li><li>Price build-up</li><li>Appendices: A materials and supplies, B tools assumed, C labor rates, D option prices</li></ol>
<div class="stamp"><b>Status</b><span>${esc(ctx.status || '')}</span></div>`);

  // 2 Options at a glance
  const scen = est.scenarios || [];
  if (scen.length) {
    const groups = new Map();
    for (const sc of scen) { if (!groups.has(sc.axis)) groups.set(sc.axis, []); groups.get(sc.axis).push(sc); }
    const base = (scen.find(sc => sc.is_design) || {}).total ?? T.total;
    rows = '';
    for (const [axis, lst] of groups) {
      rows += `<tr class="g"><td colspan="7">${esc(axis)}</td></tr>`;
      for (const sc of lst) {
        const d = sc.total - base;
        rows += `<tr${sc.is_design ? ' class="dz"' : ''}><td><b>${esc(sc.name)}</b><div class="sm">${esc(sc.what || '')}</div></td><td class="r">${money0(sc.mould)}</td><td class="r">${money0(sc.sup)}</td>`
          + `<td class="r">${hrs(sc.hours)}</td><td class="r">${money0(sc.labor)}</td><td class="r"><b>${money0(sc.total)}</b></td><td class="r">${Math.abs(d) < .5 ? '–' : (d > 0 ? '+' : '−') + money0(Math.abs(d))}</td></tr>`;
      }
    }
    const kitNote = KIT.size ? ' ' + [...KIT].map(k => CAT[k].short).join(', ') + ' (sold by the kit) stay as drawn in every row; the rows change the other mouldings.' : '';
    page('Options at a glance', '2 · Options', `<p class="lede">The same ${f0(est.house.trim_lf || 0)} feet of trim in the same rooms, priced other ways. Each row changes one thing from today's design; the rest stays as drawn. Totals include supplies, labor at ${money0(RATE)}/hr and ${pct0(CONT)}% contingency, before tax.</p>
<table class="opt"><thead><tr><th>Option</th><th class="r">Moulding</th><th class="r">Supplies</th><th class="r">Hours</th><th class="r">Labor</th><th class="r">Total</th><th class="r">vs today</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note">${esc(est.optionsNote || '')}${esc(kitNote)} Products, per-foot prices and sources for every row are in Appendix D.</p>`);
  }

  // 3 Buy list
  const lineItem = (pid, l) => {
    const s = est.sale[pid] || {};
    const it = l.how === 'foot' ? s.foot_item || '' : ((s.lengths || []).find(x => Math.abs(x.in - l.lenIn) < .01) || {}).item || '';
    return it && !String(CAT[pid].sku || '').includes(it) ? `<div class="sm">${esc(it)}</div>` : '';
  };
  rows = '';
  for (const b of buy) {
    const c = CAT[b.pid];
    b.lines.forEach((l, k) => {
      const per = ROOMS.map(r => `<td class="r">${b.kit ? nz(r.sticks[b.pid], String) : nz((r.byLen[b.pid] || {})[l.key] || 0, String)}</td>`).join('');
      const sku = String(c.sku || ''), store = String(c.store || '');
      const name = k === 0 ? `<b>${esc(c.short)}</b><div class="sm">${esc(c.brand || '')} ${esc(c.model || '')} · ${esc(c.size || '')} · ${esc(c.material || '')} · `
        + `${esc(sku.includes(store) ? sku : store + ' ' + sku)} · ${esc(b.soldText)}</div>` : '';
      const each = money(l.price) + (l.how === 'foot' ? `<div class="sm">${money(est.sale[b.pid].per_ft)}/ft</div>` : '');
      rows += `<tr${k ? ' class="cont"' : ''}><td>${name}</td>`
        + `<td class="nw">${esc(ftin({ inches: l.lenIn }))}${b.kit ? ' kit' : l.how === 'foot' ? ' cut at the store' : ''}${lineItem(b.pid, l)}</td>${per}<td class="r">${l.spare || '–'}</td><td class="r"><b>${l.order}</b></td><td class="r">${each}</td><td class="r">${money(l.ext)}</td></tr>`;
    });
  }
  const heads = ROOMS.map(r => `<th class="r">${esc(r.code)}</th>`).join('');
  const key = ROOMS.map(r => `${esc(r.code)} ${esc(r.name)}`).join(' · ');
  const links = buy.map(b => `<li>${esc(CAT[b.pid].short)}: <span class="url">${esc(CAT[b.pid].url || '')}</span> (price seen ${esc(seenOf(CAT[b.pid]))})</li>`).join('');
  const K = est.constants;
  page('Buy list', '3 · Buy list', `<p class="note">Store pieces for each room, cut from that room's own pieces (the cutting is drawn on the room pages). ${key}.</p>
<table><thead><tr><th>Moulding</th><th>Piece</th>${heads}<th class="r">Spare</th><th class="r">Order</th><th class="r">Each</th><th class="r">Extended</th></tr></thead>
<tbody>${rows}</tbody><tfoot><tr><td colspan="${ROOMS.length + 5}">Moulding before tax and delivery</td><td class="r">${money(T.moulding)}</td></tr></tfoot></table>
<p class="note">Each board is planned with ${esc(ftin({ inches: K.trim }))} trimmed off each end, at least ${esc(ftin({ inches: K.minGap }))} between cuts (spare length spread up to ${esc(ftin({ inches: K.maxGap }))}), and beside every angled end as much room again as the wedge its cut takes. Boards run up to ${esc(ftin({ inches: K.capIn }))}, or ${esc(ftin({ inches: K.stretchIn }))} when that buys less. Yield, store length used by pieces: ${buy.map(b => `${SHORTN[roleOf(b.pid)] || ''} ${(b.yield * 100).toFixed(0)}%`).join(', ')}. Supplies are in Appendix A.</p>
<h2>Where the prices come from</h2><ul class="sm">${links}</ul>`);

  // 4 Rooms: pictures, walls with their boards, then the cut list
  for (const r of ROOMS) {
    const ws = roomWalls(r.name);
    const pics = ((ctx.pictures || {})[r.name] || []).map(u => `<img src="${esc(u)}" alt="${esc(r.name)}">`).join('');
    const stats = `<div class="rstats"><span><b>${ws.length}</b> walls</span><span><b>${r.pieces}</b> pieces to cut</span>`
      + `<span><b>${sum(Object.values(r.sticks))}</b> store pieces</span><span><b>${money(r.mat)}</b> moulding</span>`
      + `<span><b>${hrs(r.hours)}</b> labor hours</span></div>`;
    const legend = '<p class="legend">Each wall as seen from inside the room, with piece marks (frames: top and bottom / sides). Under it, the boards cut for '
      + 'that wall, all drawn to one scale: the length to buy over each stack of like boards, each cut\'s long-point length under it.'
      + '<i></i>this wall<i class="oth"></i>another wall of the room<i class="wd"></i>wood an angled cut takes (inside the long point; '
      + 'the plan leaves as much again beside it) and the ends trimmed off<i class="off"></i>left over.</p>';
    const wrows = ws.map(wl => {
      const sticks = est.boards.filter(b => b.room === r.name && b.wall === wl.id);
      const cuts = cutsHtml(sticks, wl.id, est, { fs: PDF_FS }) || '<span class="none">Cut from boards drawn under another wall of the room.</span>';
      const n = est.pieces.filter(p => p.wall === wl.id).length;
      const el = elevationSvg(wl, est, { maxW: 5.4 * PT_PER_IN, maxH: 1.9 * PT_PER_IN });
      return `<div class="wrow"><h3>${esc(wl.name)}<span>${esc(ftin(wl.h1 - wl.h0))} wide · ${n} pieces · ${sticks.length} store pieces</span></h3>`
        + `<div class="el">${el}</div><div class="cuts">${cuts}</div></div>`;
    }).join('');
    page(r.name, `4 · ${r.name}`, (pics ? `<div class="pics">${pics}</div>` : '') + stats + legend + wrows, 'room');
    cutListPage(r);
  }
  function cutListPage(r) {
    const gs = est.groups.filter(g => g.room === r.name);
    if (!gs.length) return;
    const by = new Map();
    for (const g of gs) { const w = WALL[g.wall]; const k = JSON.stringify([w.k, w.name]); if (!by.has(k)) by.set(k, []); by.get(k).push(g); }
    const keys = [...by.keys()].sort((a, b) => { const A = JSON.parse(a), Bk = JSON.parse(b); return A[0] - Bk[0] || (A[1] < Bk[1] ? -1 : A[1] > Bk[1] ? 1 : 0); });
    const out = [];
    const stickKey = s => { const parts = s.split(' '), last = parts[parts.length - 1]; return [parts.slice(0, -1).join(' '), /^\d+$/.test(last) ? +last : 0]; };
    for (const k of keys) {
      out.push(`<tr class="g"><td colspan="7">${esc(JSON.parse(k)[1])}</td></tr>`);
      for (const g of by.get(k)) {
        const st = [...new Set(est.pieces.filter(p => p.mark === g.mark).map(p => p.stick).filter(Boolean))]
          .sort((a, b) => { const A = stickKey(a), Bk = stickKey(b); return A[0] < Bk[0] ? -1 : A[0] > Bk[0] ? 1 : A[1] - Bk[1]; });
        let nm = g.name.includes(' · ') ? g.name.split(' · ').slice(1).join(' · ') : g.name;
        if (g.lin < 3) nm += ' (short: fit on site)';
        out.push(`<tr><td><b>${esc(nm)}</b><div class="sm">${esc(CAT[g.product].short)} · ${esc(g.mark)}</div></td><td class="nw">${esc(g.size)}</td><td class="r">${g.qty}</td>`
          + `<td class="r"><b>${esc(ftin({ inches: g.lin }))}</b></td><td>${esc(g.endL)} / ${esc(g.endR)}</td><td class="sm">${esc(st.join(', '))}</td><td class="c">☐</td></tr>`);
      }
    }
    const head = '<table class="cl"><thead><tr><th>Piece</th><th>Wood size</th><th class="r">Qty</th><th class="r">Length</th><th>Ends (left / right)</th><th>Store piece</th><th class="c">Cut</th></tr></thead><tbody>';
    const note = `<p class="note">${sum(gs, g => g.qty)} pieces, cut from ${sum(Object.values(r.sticks))} store pieces bought for this room. Lengths are long point (the longest edge). Ends, left / right as you face the wall: cope = inside corner (the piece it meets runs square into the corner), miter 45° = outside corner or frame corner, square butt = joint with the next run on the same wall line, scarf 45° = splice in a run longer than one store piece.${r.check ? ' ' + r.check + ' ends marked check on site meet another wall where the drawing does not say whether the trim turns or stops.' : ''}</p>
`;
    page(`Cut list · ${r.name}`, `4 · ${r.name} · cut list`, note + head + out.join('') + '</tbody></table>', 'cut');
  }

  // 5 Bid form with hours, then its terms
  rows = '';
  for (const w of ROOMS) {
    rows += `<tr class="g"><td colspan="4">${esc(w.name)} · ${w.copes} copes, ${w.outside} outside miters, ${w.scarfs} scarf joints</td><td class="r">${hrs(w.hours)}</td></tr>`;
    for (const l of w.labor) {
      const t = taskOf(l.task);
      const unit = Math.round(l.qty * 10) / 10 !== 1 ? (t.unit || l.unit) : String(t.unit_one || l.unit).split(' of ')[0];
      const qs = (t.unit || l.unit) === 'LF' ? `${Number(l.qty).toFixed(1)} ${unit}` : `${f0(l.qty)} ${unit}`;
      rows += `<tr><td>${esc(t.label || l.label)}</td><td class="r">${esc(qs)}</td><td class="r">${gfmt(t.hours ?? l.rate, 4)}</td><td class="r">${hrs(l.hours)}</td><td></td></tr>`;
    }
  }
  page('Installer bid form', '5 · Bid form', `<p class="lede">For a finish carpenter to price. The hours are this package's estimate from published production rates (Appendix C); change any line, and the total below follows the hours. Material is bought by the owner from the buy list unless you say otherwise.</p>
<table class="bid"><thead><tr><th>Work</th><th class="r">Quantity</th><th class="r">Hours each</th><th class="r">Hours</th><th class="r">Room</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="3">Total hours</td><td class="r">${hrs(T.hours)}</td><td></td></tr>
<tr><td colspan="3">Hourly rate</td><td class="r">${money(RATE)}</td><td></td></tr>
<tr><td colspan="3">Labor total</td><td class="r">${money(T.labor)}</td><td></td></tr></tfoot></table>`, 'bidp');
  const alts = (ctx.alternates || []).map(a => `<tr><td>${esc(a)}</td><td class="r">${/deduct/.test(a) ? '−' : '+'}$ ______</td></tr>`).join('');
  page('Installer bid form, terms', '5 · Bid form, terms', `<h2>Included? (answer each)</h2>
<table class="yn"><tbody>
<tr><td>Owner supplies all moulding from the buy list</td><td>☐ Yes</td><td>☐ No, I supply it at $ ______</td></tr>
<tr><td>Supplies in Appendix A (nails, glue, adhesive, caulk, filler, sandpaper, primer)</td><td>☐ Mine</td><td>☐ Owner's</td></tr>
<tr><td>Tools in Appendix B are mine</td><td>☐ Yes</td><td>☐ No, differences: ______</td></tr>
<tr><td>Fill nail holes, caulk joints and edges</td><td>☐ Yes</td><td>☐ No</td></tr>
<tr><td>Spot-prime cut ends and fills</td><td>☐ Yes</td><td>☐ No</td></tr>
<tr><td>Paint trim two coats (${esc(ctx.paint || 'trim paint')})</td><td>☐ Yes</td><td>☐ No</td></tr>
<tr><td>Remove existing base and haul away</td><td>☐ Yes</td><td>☐ No</td></tr>
<tr><td>Protect floors, move and replace furniture, clean up daily</td><td>☐ Yes</td><td>☐ No</td></tr>
</tbody></table>
<h2>Your price</h2>
<table><tbody><tr><td>Hours (yours, if different from ${hrs(T.hours)})</td><td class="r">______ hrs</td></tr>
<tr><td>Rate</td><td class="r">$ ______ /hr</td></tr><tr><td>Supplies, if yours</td><td class="r">$ ______</td></tr><tr><td><b>Total</b></td><td class="r"><b>$ ________</b></td></tr></tbody></table>
<h2>Alternates</h2><table><tbody>${alts}</tbody></table>
<div class="two"><div>${kv([['Start', '______'], ['Days on site', '______'], ['Price good until', '______ (at least 30 days)']])}</div>
<div>${kv([['Deposit', '______ %'], ['Due when panels are up', '______ %'], ['Due at walk-through', '______ %']])}</div></div>
<div class="sign"><span>Installer</span><span>Date</span><span>${B.name ? esc(B.name) : 'Owner'}</span><span>Date</span></div>`);

  // 6 Price build-up
  const supByCat = {};
  for (const s of supplies) supByCat[s.category] = (supByCat[s.category] || 0) + s.ext;
  rows = '';
  for (const b of buy) {
    const c = CAT[b.pid];
    rows += `<tr><td>${esc(c.short)}</td><td class="r">${b.netLf.toFixed(1)} LF</td><td class="r">${b.lines.map(l => `${l.order} × ${money(l.price)}`).join(' + ')}</td>`
      + `<td class="r">${money(b.ext)}</td><td class="sm">${esc(c.store || '')} page, ${esc(seenOf(c))}</td></tr>`;
  }
  for (const [cid, label] of CATS) {
    if (!supByCat[cid]) continue;
    rows += `<tr><td>${esc(label)}</td><td class="r">${supplies.filter(s => s.category === cid).length} items</td><td></td><td class="r">${money(supByCat[cid])}</td><td class="sm">Appendix A</td></tr>`;
  }
  rows += `<tr><td>Labor</td><td class="r">${hrs(T.hours)} hrs</td><td class="r">× ${money(RATE)}</td><td class="r">${money(T.labor)}</td><td class="sm">bid form; rates Appendix C</td></tr>`;
  const checks = est.pieces.filter(p => p.endA === 'check on site' || p.endB === 'check on site');
  const chkMarks = [...new Map(checks.map(p => [p.mark, p])).values()].sort((a, b) => a.mark < b.mark ? -1 : a.mark > b.mark ? 1 : 0);
  const chk = chkMarks.map(p => `<li>${esc(p.mark)} · ${esc(WALL[p.wall].name)}</li>`).join('');
  const extra = (ctx.notExact || []).map(x => `<li>${esc(x)}</li>`).join('');
  page('Price build-up', '6 · Price build-up', `
<table><thead><tr><th>Line</th><th class="r">Quantity</th><th class="r">Order</th><th class="r">Amount</th><th>Source</th></tr></thead>
<tbody>${rows}</tbody><tfoot>
<tr><td colspan="3">Subtotal</td><td class="r">${money(T.subtotal)}</td><td></td></tr>
<tr><td colspan="3">Contingency, ${pct0(CONT)}% (assumed)</td><td class="r">${money(T.contingency)}</td><td></td></tr>
<tr><td colspan="3">Total before sales tax and delivery</td><td class="r">${money(T.total)}</td><td></td></tr></tfoot></table>
<div class="stamp"><b>How sure</b><span>Moulding: store prices and quantities from the drawing. Supplies: store prices and published coverage. Labor: published production rates, not a bid. A screening estimate (about Class 3) until a carpenter prices the bid form.</span></div>
<h2>What is not exact</h2>
<ul><li>Lengths come from the drawing, not a tape. Measure each wall before cutting.</li>
<li>Run ends that meet another wall are read from the plan: an inside corner is shown coped, an outside corner mitered. ${new Set(checks.map(p => p.mark)).size} marks have an end the plan cannot settle; they are marked check on site:</li></ul>
<ul class="sm cols">${chk || '<li>none</li>'}</ul>
<ul><li>${est.groups.filter(g => g.lin < 3).length} piece marks are under 3" long, slivers between a corner and a casing: fit on site.</li>
<li>Splices: runs longer than one store piece are split into equal parts joined with a 45° scarf; place each joint over a stud.</li>${extra}</ul>`);

  // Appendices
  if (supplies.length) {
    const H = est.house;
    rows = '';
    for (const [cid, label] of CATS) {
      const lst = supplies.filter(s => s.category === cid);
      if (!lst.length) continue;
      rows += `<tr class="g"><td colspan="5">${esc(label)}</td><td class="r">${money(sum(lst, x => x.ext))}</td></tr>`;
      for (const s of lst) rows += `<tr><td><b>${esc(s.product)}</b><div class="sm">${esc(s.store)} ${esc(s.item_no || '')} · ${esc(s.package)}</div></td>`
        + `<td class="sm">${esc(s.basis)}</td><td class="r">${comma0(s.need)} ${esc(s.unit)}</td><td class="r">${s.packages}</td><td class="r">${money(s.price)}</td><td class="r">${money(s.ext)}</td></tr>`;
    }
    page('Appendix A · Materials and supplies', 'A · Supplies', `<p class="note">Everything besides the moulding, counted from this job: ${f0(H.trim_lf || 0)} LF of trim, ${f0(H.frame_corners || 0)} frame corners, ${f0(H.copes || 0)} copes, ${f0(H.caulk_lf || 0)} LF of caulked edges, ${f0(H.face_sf || 0)} sf of trim face to paint. Prices seen ${esc(est.suppliesSeen || '')}; confirm before ordering.</p>
<table class="sup"><thead><tr><th>Item</th><th>How much it covers</th><th class="r">Needed</th><th class="r">Buy</th><th class="r">Each</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="5">Supplies before tax</td><td class="r">${money(T.supplies)}</td></tr></tfoot></table>`, 'apx');
  }
  if ((est.tools || []).length) {
    rows = est.tools.map(t => `<tr><td><b>${esc(t.tool)}</b><div class="sm">${esc(t.product)} · about ${money0(t.price)}${t.rentable ? ' · rentable' : ''}</div></td>`
      + `<td class="sm">${esc(t.uses || '')}</td><td class="sm">${esc(t.if_switched)}</td></tr>`).join('');
    page('Appendix B · Tools assumed', 'B · Tools', `<p class="note">The hours and supplies assume this kit (cordless). A different tool changes the supplies or the hours as the right column says. The prices show what a switch costs; the package does not price tools, which are the carpenter's.</p>
<table class="tools"><thead><tr><th>Tool</th><th>Used for, and the supplies it takes</th><th>If switched</th></tr></thead><tbody>${rows}</tbody></table>`, 'apx');
  }
  if ((est.labor.tasks || []).length) {
    rows = est.labor.tasks.map(t => `<tr><td><b>${esc(t.label)}</b></td><td class="r">${gfmt(t.hours, 3)} hr / ${esc(t.unit_one)}</td><td class="sm">${esc(t.basis)}</td><td class="sm">${esc(t.source)}</td></tr>`).join('');
    page('Appendix C · Labor rates', 'C · Labor', `<p class="note">${esc(est.labor.note || '')}</p>
<table class="lab"><thead><tr><th>Task</th><th class="r">Hours</th><th>What it covers</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note">${esc(est.labor.rateNote || '')}</p>`, 'apx');
  }
  const optp = est.optionProducts || [];
  if (optp.length) {
    rows = '';
    for (const role of ROLE_ORDER) {
      const lst = optp.filter(x => x.role === role);
      if (!lst.length) continue;
      rows += `<tr class="g"><td colspan="5">${esc(SHORTN[role] || role)}</td></tr>`;
      for (const x of lst) rows += `<tr><td>${esc(x.option)}</td><td><b>${esc(x.product)}</b><div class="sm">${esc(x.store)} ${esc(x.item_no || '')} · ${esc(x.size || '')}</div></td>`
        + `<td class="r">${x.per_lf != null ? money(x.per_lf) : '–'}</td><td class="sm">${esc(x.seen || '')}</td><td class="sm url">${esc(x.url || x.notes || '')}</td></tr>`;
    }
    page('Appendix D · Option prices', 'D · Options', `<p class="note">The products behind each row of Options at a glance, priced per linear foot (price ÷ piece length). ${esc(est.optionsLaborNote || OPTIONS.labor_note || '')}</p>
<table class="optp"><thead><tr><th>Option</th><th>Product</th><th class="r">Per LF</th><th>Seen</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`, 'apx');
  }

  const top = `${String(ctx.title || ctx.propertyName || '').toUpperCase()} / WALL TRIM / ${String(ctx.design || '').toUpperCase()}`;
  const css = `@page { size: 8.5in 11in; margin: 0.78in 0.55in 0.72in;
  @top-left { content: ${cssStr(top)}; font: 600 7.5pt "Helvetica Neue", Arial, sans-serif; letter-spacing: .06em; color: #646b78; vertical-align: bottom; padding-bottom: 6pt; border-bottom: .75pt solid #d5d9e0; }
  @top-right { font: 600 7.5pt "Helvetica Neue", Arial, sans-serif; letter-spacing: .06em; color: #646b78; vertical-align: bottom; padding-bottom: 6pt; border-bottom: .75pt solid #d5d9e0; }
  @bottom-left { content: ${cssStr('Lengths in feet and inches to the nearest 1/16 in. Prices from the store pages; confirm before ordering.')}; font: 7pt "Helvetica Neue", Arial, sans-serif; color: #646b78; vertical-align: top; padding-top: 5pt; border-top: .75pt solid #d5d9e0; }
  @bottom-right { content: ${cssStr('Tiksi · ' + today + ' · page ')} counter(page) " of " counter(pages); font: 7pt "Helvetica Neue", Arial, sans-serif; color: #646b78; vertical-align: top; padding-top: 5pt; border-top: .75pt solid #d5d9e0; } }
${pageCss.join('\n')}`;
  return { html: `<div class="tpkg">${pages.join('')}</div>`, css, pages: pages.length };
}

export { ROLE_WORD, cutWord, soldText };

// The one-pager laid out: one Letter page (8.5 x 11 in, 816 x 1056 CSS pixels) as XHTML, with
// its own stylesheet. The same markup is shown in the editor's preview and rasterised for the
// PDF (one-pager-render.js puts it in an SVG foreignObject), so what you see is what you send.
// Pure markup only: pictures arrive as data: URLs and the plan as SVG text in `assets`, so Node
// tests can lay a page out without a browser.

import { fmtMoney, fmtArea, fmtDate, polyArea } from './store.js';
import { onePagerFacts, latestVersion, workDates } from './one-pager.js';

export const PAGE_W = 816, PAGE_H = 1056;
export const HERO_W = 720, HERO_H = 300;   // the picture's box, CSS pixels (2.4:1)
const MAX_PRODUCTS = 6, MAX_ROOMS = 8;

// XML text: the page is parsed as XHTML inside the SVG, so every entity must be numeric.
export const xml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = s => xml(s).split('\n').map(l => l.trim()).filter(Boolean).join('<br/>');

export const PAGE_CSS = `
.op-page { position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; overflow: hidden; box-sizing: border-box; padding: 44px 48px 36px;
  background: #ffffff; color: #15181c; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; font-size: 12.5px; line-height: 1.45;
  display: flex; flex-direction: column; gap: 16px; }
.op-page * { box-sizing: border-box; margin: 0; padding: 0; }
.op-rule { height: 3px; background: #e8973a; margin: 0 0 14px; }
.op-head { flex: none; }
.op-kicker { display: flex; justify-content: space-between; gap: 16px; font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: #6b7480; margin-bottom: 10px; }
.op-kicker span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.op-head h1 { font-size: 34px; line-height: 1.08; font-weight: 700; letter-spacing: -0.01em; color: #0f1216; max-height: 76px; overflow: hidden; }
.op-tagline { margin-top: 7px; font-size: 14px; color: #4a535e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.op-hero { flex: none; width: ${HERO_W}px; height: ${HERO_H}px; overflow: hidden; border-radius: 4px; background: #f3f0ea; position: relative; }
.op-hero img { display: block; width: 100%; height: 100%; object-fit: cover; }
.op-hero svg { display: block; width: 100%; height: 100%; }
.op-hero.plan { padding: 14px; background: #f6f4ef; }
.op-cover { width: 100%; height: 100%; display: flex; align-items: flex-end; padding: 22px 26px; background: linear-gradient(135deg, #f7f2ea, #ece4d6); }
.op-cover b { font-size: 22px; letter-spacing: 0.22em; text-transform: uppercase; color: #a46a24; font-weight: 700; }
.op-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 236px; gap: 28px; overflow: hidden; }
.op-main { min-width: 0; overflow: hidden; }
.op-summary { font-size: 13.5px; line-height: 1.55; color: #1e232a; max-height: 190px; overflow: hidden; }
.op-h { font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: #a46a24; margin: 18px 0 7px; padding-bottom: 4px; border-bottom: 1px solid #e6e1d8; }
.op-list { list-style: none; }
.op-list li { position: relative; padding-left: 14px; margin: 0 0 4px; line-height: 1.4; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.op-list li::before { content: ''; position: absolute; left: 0; top: 7px; width: 6px; height: 6px; border-radius: 50%; background: #e8973a; }
.op-products li span { color: #6b7480; }
.op-side { min-width: 0; overflow: hidden; display: flex; flex-direction: column; gap: 12px; }
.op-stat { padding: 10px 12px 9px; background: #f7f5f0; border-left: 3px solid #e8973a; }
.op-stat .op-label { display: block; font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase; color: #6b7480; margin-bottom: 3px; }
.op-stat b { display: block; font-size: 17px; line-height: 1.2; font-weight: 700; color: #0f1216; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.op-stat small { display: block; font-size: 10.5px; color: #4a535e; margin-top: 2px; line-height: 1.35; max-height: 44px; overflow: hidden; }
.op-plan { flex: 1; min-height: 0; border: 1px solid #e6e1d8; border-radius: 4px; background: #fbfaf7; padding: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.op-plan svg { width: 100%; height: 100%; }
.op-foot { flex: none; display: flex; justify-content: space-between; gap: 18px; padding-top: 10px; border-top: 1px solid #e6e1d8; font-size: 10px; color: #6b7480; letter-spacing: 0.02em; }
.op-foot span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.op-foot b { color: #15181c; font-weight: 600; }
`;

// Where the page's numbers come from. `assets`: { hero: { href } | { plan: true } | null, planSvg: '' | '<svg…>' }.
// `opts.version`: the label printed in the corner ('Version 2 · Nov 6, 2026' or 'Draft').
export function onePagerHtml(prop, data, assets = {}, opts = {}) {
  const o = prop.onePager || {};
  const f = onePagerFacts(prop, data);
  const show = Object.assign({ budget: true, schedule: true, rooms: true, plan: true, products: true }, o.show || {});
  const headline = o.headline || f.name;
  const hero = assets.hero || null;
  const planSvg = assets.planSvg || '';
  const heroHtml = hero && hero.href ? `<figure class="op-hero"><img src="${xml(hero.href)}" alt=""/></figure>`
    : hero && hero.plan && planSvg ? `<figure class="op-hero plan">${planSvg}</figure>`
    : `<figure class="op-hero"><div class="op-cover"><b>${xml(o.tagline ? 'Renovation proposal' : 'Proposal')}</b></div></figure>`;
  const stats = [];
  if (show.budget && f.budget.priced) stats.push(stat('Likely cost', fmtMoney(f.budget.likely), f.budget.low !== f.budget.high ? fmtMoney(f.budget.low) + ' to ' + fmtMoney(f.budget.high) : plural(f.program.length, 'project') + ' priced'));
  else if (show.budget && f.program.length) stats.push(stat('Scope', plural(f.program.length, 'project'), f.scopeItems ? plural(f.scopeItems, 'scope item') + ', not priced yet' : 'not priced yet'));
  if (show.schedule && f.days > 0) stats.push(stat('Schedule', 'About ' + plural(f.days, 'calendar day'), f.start ? workDates(f, false) : ''));
  if (show.rooms && f.rooms.length) stats.push(stat('Modeled portion', plural(f.rooms.length, 'floor region') + (f.floorArea > 0 ? ' · ' + fmtArea(f.floorArea) : ''), f.rooms.slice(0, MAX_ROOMS).map(r => r.name || 'Room').join(', ') + (f.rooms.length > MAX_ROOMS ? ', …' : '') + (f.floorArea > 0 ? '. Area calculated from model geometry; not verified whole-property area' : '')));
  if (!stats.length) stats.push(stat('Status', 'In design', 'Scope and budget to follow'));
  const planInSide = show.plan && planSvg && !(hero && hero.plan);
  const highlights = (o.highlights || []).filter(Boolean);
  const products = f.products.slice(0, MAX_PRODUCTS);
  const kickerLeft = o.client ? 'Prepared for ' + o.client : (f.address || 'Renovation proposal');
  const kickerRight = [opts.version || 'Draft', fmtDate(opts.date || today())].filter(Boolean).join(' · ');
  return `<div xmlns="http://www.w3.org/1999/xhtml" class="op-page">
  <div class="op-rule"></div>
  <header class="op-head">
    <div class="op-kicker"><span>${xml(kickerLeft)}</span><span>${xml(kickerRight)}</span></div>
    <h1>${xml(headline)}</h1>
    ${o.tagline ? `<p class="op-tagline">${xml(o.tagline)}</p>` : ''}
  </header>
  ${heroHtml}
  <section class="op-body">
    <div class="op-main">
      ${o.summary ? `<p class="op-summary">${lines(o.summary)}</p>` : ''}
      ${highlights.length ? `<h2 class="op-h">Highlights</h2><ul class="op-list">${highlights.map(h => `<li>${xml(h)}</li>`).join('')}</ul>` : ''}
      ${show.products && products.length ? `<h2 class="op-h">Products recorded for review</h2><ul class="op-list op-products">${products.map(p => `<li>${xml(p.name)}${p.brand || p.model ? ` <span>${xml([p.brand, p.model].filter(Boolean).join(' '))}</span>` : ''}</li>`).join('')}${f.products.length > MAX_PRODUCTS ? `<li><span>and ${f.products.length - MAX_PRODUCTS} more</span></li>` : ''}</ul>` : ''}
    </div>
    <aside class="op-side">
      ${stats.join('')}
      ${planInSide ? `<div class="op-plan">${planSvg}</div>` : ''}
    </aside>
  </section>
  <footer class="op-foot">
    <span>${o.preparedBy ? 'Prepared by <b>' + xml(o.preparedBy) + '</b>' : '<b>' + xml(f.name) + '</b>'}</span>
    <span>${xml(o.contact || '')}</span>
    <span>${xml(f.address && o.client ? f.address : '')}</span>
  </footer>
</div>`;
}

function stat(label, value, sub) {
  return `<div class="op-stat"><span class="op-label">${xml(label)}</span><b>${xml(value)}</b>${sub ? `<small>${xml(sub)}</small>` : ''}</div>`;
}
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// What the laid-out page cuts off, in words, from the page as the browser drew it (`el` is the
// .op-page element). The page has fixed room: a long headline, summary, highlight or product
// list is clipped, so the editor shows this list before anything is saved. Browser only.
export function pageCuts(el) {
  if (!el) return [];
  // One-line text ends in an ellipsis, which scrollWidth does not report: measure a copy of
  // the text at its natural width beside it instead.
  const wider = n => {
    const c = n.cloneNode(true);
    c.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:auto;max-width:none;overflow:visible;white-space:nowrap;padding:0';
    n.parentNode.appendChild(c);
    const natural = c.getBoundingClientRect().width;
    c.remove();
    const box = n.getBoundingClientRect(), cs = getComputedStyle(n);
    const k = n.offsetWidth ? box.width / n.offsetWidth : 1;   // the preview is scaled down
    return natural > box.width - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) * k + 1;
  };
  const over = (n, axis) => !!n && (axis === 'x' ? wider(n) : n.scrollHeight > n.clientHeight + 1);
  const cuts = [];
  if (over(el.querySelector('.op-head h1'), 'y')) cuts.push('the headline is longer than two lines');
  if (over(el.querySelector('.op-tagline'), 'x')) cuts.push('the tagline is longer than one line');
  if (over(el.querySelector('.op-summary'), 'y')) cuts.push('the summary is longer than its space');
  const lists = [...el.querySelectorAll('.op-list')];
  for (const ul of lists) {
    const long = [...ul.querySelectorAll('li')].filter(li => over(li, 'x')).length;
    const what = ul.classList.contains('op-products') ? 'product' : 'highlight';
    if (long) cuts.push(long + ' ' + what + (long === 1 ? ' is' : 's are') + ' longer than one line');
  }
  const main = el.querySelector('.op-main');
  if (main) {
    const bottom = main.getBoundingClientRect().bottom + 1;
    const below = [...main.querySelectorAll('li')].filter(li => li.getBoundingClientRect().bottom > bottom).length;
    if (below || over(main, 'y')) cuts.push((below ? below + ' list line' + (below === 1 ? '' : 's') : 'the text') + ' ran off the bottom of the page');
  }
  const side = el.querySelector('.op-side');
  if (over(side, 'y') || [...el.querySelectorAll('.op-stat b')].some(b => over(b, 'x'))) cuts.push('a figure beside the text is cut');
  return cuts;
}

// The label printed in the page's corner for the version being made, or for the preview.
export function versionLabel(prop, next = false) {
  const v = latestVersion(prop);
  if (next) return 'Version ' + ((v ? v.n : 0) + 1);
  return v ? 'Version ' + v.n : 'Draft';
}

// The page inside an SVG, for an <img> to decode and a canvas to draw: the way the PDF is made.
export function pageSvg(xhtml) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}"><foreignObject x="0" y="0" width="${PAGE_W}" height="${PAGE_H}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${PAGE_CSS}</style>${xhtml}</div></foreignObject></svg>`;
}

export { polyArea };

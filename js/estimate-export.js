// The estimate as one file to share: a deep dive (contents on the left, the reading column in the
// middle, a detail column on the right where anything clicked opens with its full context),
// written from the same sections and details as ESTIMATE (estimate-report.js). Nothing in it is
// worked out in the file: every detail is written in when it is saved, so it opens anywhere, on
// any device, with no Tiksi and no network, and it can be published as a page as it is.

import { ws, activeProperty, fmtMoney, fmtLen, isoToday } from './store.js';
import { projectEstimate } from './estimate.js';
import { reportModel, reportSections, detailFor, searchIndex } from './estimate-report.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Every detail the page can reach: the keys in the sections, then the keys inside those details.
export function collectDetails(M, sectionsHtml) {
  const keys = new Set(), out = {};
  const scan = html => { for (const m of String(html).matchAll(/data-d="([^"]+)"/g)) keys.add(m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")); };
  scan(sectionsHtml);
  const queue = [...keys];
  while (queue.length) {
    const k = queue.shift();
    if (out[k] !== undefined) continue;
    const d = detailFor(k, M);
    out[k] = d ? { eyebrow: d.eyebrow || '', title: d.title || '', sub: d.sub || '', html: d.html || '', go: d.go || '' } : null;
    if (d) { const before = keys.size; scan(d.html); if (keys.size > before) for (const x of keys) if (out[x] === undefined && !queue.includes(x)) queue.push(x); }
  }
  return out;
}

export async function estimateDeepDiveHtml(root, opts = {}) {
  const prop = activeProperty();
  const est = projectEstimate(root);
  const M = reportModel({ est, prop, len: m => fmtLen(m), money: v => fmtMoney(v), date: isoToday(), propertyName: prop ? prop.name : '', live: false });
  const sections = reportSections(M);
  const body = sections.map(s => `<section class="sec" id="${s.id}">${s.html}</section>`).join('');
  const details = collectDetails(M, body);
  const index = searchIndex(M).filter(x => details[x.key]);
  let toc = '', grp = '';
  for (const s of sections) {
    if (s.group !== grp) { if (grp) toc += '</div>'; grp = s.group; toc += `<div class="grp"><div class="gl">${esc(grp)}</div>`; }
    toc += `<a href="#${s.id}" data-go="${s.id}">${esc(s.nav)}</a>`;
    if (s.subs && s.subs.length) toc += `<div class="subs">${s.subs.map(x => `<a href="#${x.id}" data-go="${x.id}">${esc(x.nav)}</a>`).join('')}</div>`;
  }
  toc += grp ? '</div>' : '';
  let drawingsCss = opts.drawingsCss;
  if (drawingsCss == null) { try { drawingsCss = await (await fetch(new URL('../css/trim-drawings.css', import.meta.url))).text(); } catch { drawingsCss = ''; } }
  const title = (root.name || 'Project') + ' estimate';
  const json = s => JSON.stringify(s).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(`${root.name}: ${fmtMoney(est.total.likely)} likely, written by Tiksi on ${M.date}.`)}">
<style>${SHELL_CSS}\n${drawingsCss}</style></head><body>
<div id="topbar"><button type="button" id="tb-nav" aria-label="Contents">☰</button><b>${esc(root.name || 'Estimate')}</b><button type="button" id="tb-det" aria-label="Details">▤</button></div>
<div id="app"><nav id="nav" aria-label="Contents"><div class="brand"><b>${esc(root.name || 'Estimate')}</b><span>Estimate · ${esc(M.date)}</span></div>
<div class="find"><input id="find" type="search" placeholder="Find anything (⌘K)" autocomplete="off" aria-label="Find on this page"><div class="find-res" id="find-res" hidden></div></div>
<div id="toc">${toc}</div><div class="navfoot">Written by Tiksi from the drawing and the project's scope on ${esc(M.date)}. Every number is worked out from the trim sections as drawn; prices are as seen on the dates given.</div></nav>
<main id="main"><div class="mainin">${body}</div></main>
<aside id="det" aria-label="Detail column" aria-live="polite"><div class="dbar"><button type="button" id="d-back" aria-label="Back" disabled>‹</button><button type="button" id="d-fwd" aria-label="Forward" disabled>›</button><span class="crumb">Details</span><button type="button" id="d-close" aria-label="Close">×</button></div><div id="dbody"></div></aside></div>
<div id="scrim"></div>
<script>window.DETAILS=${json(details)};window.FIND=${json(index.map(x => [x.key, x.kind, x.title, x.text]))};</script>
<script>${SHELL_JS}</script></body></html>`;
}

export async function saveEstimateDeepDive(root) {
  const html = await estimateDeepDiveHtml(root);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = `${root.name || 'Project'} - Estimate.html`.replace(/[\\/:*?"<>|]+/g, ' ');
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return html.length;
}

// The deep dive's own look: ink on paper, colour kept for data; light and dark.
const SHELL_CSS = `
:root{--bg:#f3f4f6;--surface:#fff;--sunken:#eceef2;--ink:#14171f;--ink2:#3d4352;--muted:#5d6474;--faint:#868c9b;--line:#dcdfe6;--line2:#e9ebf0;--accent:#1f5fbf;--accent-ink:#174a96;--wash:rgba(31,95,191,.09);--hl:rgba(237,161,0,.2);--ok:#1d7638;--warn:#b05208;--bad:#b3261e;
--panel:#fff;--panel-2:#f6f7f9;--panel-3:#eceef2;--dim:#5d6474;--sel:#1f5fbf;--navw:248px;--detw:420px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f1217;--surface:#171b22;--sunken:#1f242c;--ink:#eceff4;--ink2:#c4cad5;--muted:#9aa2b1;--faint:#737b8a;--line:#2b3039;--line2:#22272f;--accent:#7aa7f0;--accent-ink:#a5c4f6;--wash:rgba(122,167,240,.12);--ok:#62c47f;--warn:#f2a457;--bad:#f17d71;--panel:#171b22;--panel-2:#1f242c;--panel-3:#262c35;--dim:#9aa2b1;--sel:#7aa7f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 inherit}
#app{display:grid;grid-template-columns:var(--navw) minmax(0,1fr) var(--detw);min-height:100vh}
#nav{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line);padding:18px 12px 40px;display:flex;flex-direction:column;gap:14px}
.brand{display:flex;flex-direction:column;padding:0 6px}.brand b{font-size:18px;line-height:1.2}.brand span{font:500 11px ui-monospace,Menlo,monospace;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.find{position:relative}.find input{width:100%;font:14px inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.find-res{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:30;background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.12);max-height:60vh;overflow:auto;padding:4px}
.find-res button{display:block;width:100%;text-align:left;background:none;border:0;border-radius:6px;padding:6px 8px;cursor:pointer;color:var(--ink)}.find-res button:hover,.find-res button.on{background:var(--wash)}
.find-res .k{display:block;font:500 10.5px ui-monospace,Menlo,monospace;color:var(--muted);text-transform:uppercase}.find-res .none{padding:8px;color:var(--muted)}
#toc{display:flex;flex-direction:column;gap:12px}.grp{display:flex;flex-direction:column;gap:1px}.gl{font:600 10.5px ui-monospace,Menlo,monospace;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;padding:0 8px 3px}
#toc a{display:block;text-decoration:none;color:var(--ink2);font-size:13.5px;padding:5px 8px;border-radius:6px}#toc a:hover{background:var(--sunken)}#toc a.here{background:var(--surface);font-weight:600;box-shadow:inset 2px 0 0 var(--ink)}
#toc .subs{display:flex;flex-direction:column;margin:1px 0 4px 10px;border-left:1px solid var(--line)}#toc .subs a{font-size:12.5px;color:var(--muted);padding:3px 8px}
.navfoot{margin-top:auto;font-size:11.5px;color:var(--faint);padding:0 8px}
#main{min-width:0;padding:30px clamp(16px,3vw,44px) 140px}.mainin{max-width:1000px;margin:0 auto}
.sec{padding-top:48px;display:flex;flex-direction:column;gap:14px;scroll-margin-top:8px}.sec+.sec{border-top:1px solid var(--line);margin-top:48px}.sec:first-child{padding-top:0}
.sec-head{display:flex;flex-direction:column;gap:6px}.eyebrow{font:500 12px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
h1{font-size:clamp(30px,4.4vw,44px);line-height:1.08;margin:0}h2{font-size:26px;line-height:1.15;margin:0}h3,.sub{font-size:16px;margin:10px 0 0}p{margin:0}.lede{font-size:16.5px;max-width:72ch}
.note,.small{font-size:13px}.muted{color:var(--muted)}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.figs>div{padding:12px 14px;border-right:1px solid var(--line2);border-bottom:1px solid var(--line2);display:flex;flex-direction:column;gap:2px}.figs b{font-size:23px;font-variant-numeric:tabular-nums}.figs span{font-size:12.5px;color:var(--muted)}
.tbl{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;vertical-align:top;padding:8px 11px;border-bottom:1px solid var(--line2)}th{font:600 11px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:var(--sunken);white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr.grp td{background:var(--sunken);font-size:12.5px}tr.total-row td{font-weight:700;border-top:1px solid var(--line)}tr.covered td{color:var(--muted)}
.callout{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:8px;padding:10px 14px}.callout.bad{border-left-color:var(--bad)}
.pill{display:inline-block;font:600 11px inherit;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.pill.warn{color:var(--warn)}
.rows{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}.rows>*{padding:10px 14px;border-top:1px solid var(--line2);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 14px}
.rows>*:first-child{border-top:0}.rows .t{font-weight:600}.rows .m{font:12.5px ui-monospace,Menlo,monospace;color:var(--muted)}.rows .d{grid-column:1/-1;font-size:13.5px;color:var(--ink2)}
details.est-room{background:var(--surface);border:1px solid var(--line);border-radius:10px;margin-top:10px}details.est-room>summary{cursor:pointer;padding:10px 14px;display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}
.est-room-body{padding:0 14px 14px;display:flex;flex-direction:column;gap:18px}.est-wall h3{font-size:15px}.est-elev svg{display:block;width:auto;max-width:100%;height:auto;max-height:340px;margin:0 auto}.est-cuts svg{max-width:100%;height:auto}.est-tools{margin:0;padding-left:18px;font-size:13.5px}
.est-signoff{font-weight:600}
[data-d]{cursor:pointer}a.dl{color:var(--accent-ink);text-decoration:underline dotted;text-underline-offset:3px;cursor:pointer}tr[data-d]:hover td,.rows>[data-d]:hover{background:var(--wash)}
.d-on{outline:2px solid #eda100;outline-offset:1px}tr.d-on td{background:var(--hl)!important}.flash{animation:fl 1.6s ease-out}@keyframes fl{0%,30%{background:var(--hl)}100%{background:transparent}}
#det{position:sticky;top:0;height:100vh;overflow:hidden;border-left:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column}
.dbar{display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:1px solid var(--line)}.dbar button{width:30px;height:30px;background:none;border:1px solid transparent;border-radius:7px;cursor:pointer;color:var(--ink2);font-size:18px}
.dbar button:disabled{opacity:.3}.crumb{flex:1;font:500 11.5px ui-monospace,Menlo,monospace;color:var(--muted);text-transform:uppercase;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dbody{flex:1;overflow:auto;padding:18px 20px 60px;display:flex;flex-direction:column;gap:12px}.d-eyebrow{font:500 11.5px ui-monospace,Menlo,monospace;color:var(--muted);text-transform:uppercase}
.d-title{font-size:21px;font-weight:700;line-height:1.2}.d-sub{color:var(--ink2);font-size:14px}#dbody ul{margin:0;padding-left:18px;font-size:14px;display:flex;flex-direction:column;gap:4px}
.d-sec{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:1px solid var(--line2)}.d-sec h4{margin:0;font:600 12px ui-monospace,Menlo,monospace;text-transform:uppercase;color:var(--muted)}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 14px;font-size:13.5px;margin:0}.kv dt{color:var(--muted);font-size:12.5px}.kv dd{margin:0}.d-src{font:11px ui-monospace,Menlo,monospace;color:var(--faint)}
.d-go{align-self:flex-start;font-size:12.5px;background:var(--sunken);border:1px solid var(--line);border-radius:7px;padding:4px 10px;cursor:pointer;color:var(--ink2)}
#topbar,#scrim{display:none}
@media (max-width:1099px){#app{grid-template-columns:minmax(0,1fr)}#topbar{display:flex;position:sticky;top:0;z-index:40;align-items:center;gap:8px;padding:8px 16px;background:var(--bg);border-bottom:1px solid var(--line)}#topbar b{flex:1}
#topbar button{width:34px;height:34px;border:1px solid var(--line);background:var(--surface);border-radius:8px;color:var(--ink)}
#nav,#det{position:fixed;z-index:50;top:0;bottom:0;height:auto;transition:transform .2s}#nav{left:0;width:min(300px,86vw);transform:translateX(-102%);background:var(--bg)}#det{right:0;width:min(460px,100vw);transform:translateX(102%)}
body.nav-open #nav,body.det-open #det{transform:none}body.nav-open #scrim,body.det-open #scrim{display:block;position:fixed;inset:0;z-index:45;background:rgba(10,12,16,.35)}}
@media print{#nav,#det,#topbar{display:none}#app{display:block}#main{padding:0}}`;

const SHELL_JS = `(function(){var D=window.DETAILS||{},F=window.FIND||[],hist=[],pos=-1,cur=null;
function $(s){return document.querySelector(s)}
function paint(){var k=hist[pos],d=D[k],b=$('#dbody');
 $('.crumb').textContent=(k?k.split(':')[0]:'Details')+(hist.length>1?'  ·  '+(pos+1)+' of '+hist.length:'');
 b.innerHTML=d?'<div class="d-eyebrow">'+(d.eyebrow||'')+'</div><div class="d-title">'+(d.title||'')+'</div>'+(d.sub?'<div class="d-sub">'+d.sub+'</div>':'')+(d.html||'')+(d.go?'<button type="button" class="d-go" data-go="'+d.go+'">Show where this is on the page</button>':''):'<p>No detail for this.</p>';
 b.scrollTop=0;$('#d-back').disabled=pos<=0;$('#d-fwd').disabled=pos>=hist.length-1;
 document.querySelectorAll('.d-on,.td-on').forEach(function(n){n.classList.remove('d-on','td-on')});
 document.querySelectorAll('#main [data-d]').forEach(function(n){if(n.getAttribute('data-d')===k)n.classList.add(n instanceof SVGElement?'td-on':'d-on')})}
function open(k){if(!(k in D))return;if(hist[pos]!==k){hist=hist.slice(0,pos+1);hist.push(k);pos=hist.length-1}paint();if(innerWidth<1100){document.body.classList.add('det-open');document.body.classList.remove('nav-open')}}
function goTo(id){var t=document.getElementById(id);if(!t)return;var r=t.closest('details');if(r)r.open=true;t.scrollIntoView({block:'start',behavior:'smooth'});t.classList.remove('flash');void t.offsetWidth;t.classList.add('flash');document.body.classList.remove('nav-open','det-open')}
function empty(){$('#dbody').innerHTML='<div class="d-eyebrow">Detail column</div><div class="d-title">Click anything to see it here</div><p>Pieces on the wall drawings, boards in the cut diagrams, rows of the buy list, labor tasks, supplies, scope items and the lines of the price build-up open here with their numbers and where they come from.</p>'}
document.addEventListener('click',function(e){var g=e.target.closest('[data-go]');if(g){e.preventDefault();goTo(g.getAttribute('data-go'));return}
 var a=e.target.closest('[data-d]');if(a){e.preventDefault();open(a.getAttribute('data-d'))}});
$('#d-back').onclick=function(){if(pos>0){pos--;paint()}};$('#d-fwd').onclick=function(){if(pos<hist.length-1){pos++;paint()}};
$('#d-close').onclick=function(){hist=[];pos=-1;empty();document.body.classList.remove('det-open')};
$('#tb-nav').onclick=function(){document.body.classList.toggle('nav-open')};$('#tb-det').onclick=function(){document.body.classList.toggle('det-open')};
$('#scrim').onclick=function(){document.body.classList.remove('nav-open','det-open')};
var box=$('#find'),res=$('#find-res'),hits=[],on=0;
function show(){var w=box.value.toLowerCase().split(/\\s+/).filter(Boolean);if(!w.length){res.hidden=true;return}
 hits=F.filter(function(x){return w.every(function(q){return x[3].indexOf(q)>=0})}).slice(0,30);on=0;
 res.innerHTML=hits.length?hits.map(function(h,i){return '<button type="button" data-i="'+i+'" class="'+(i===on?'on':'')+'"><span class="k">'+h[1]+'</span>'+h[2].replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})+'</button>'}).join(''):'<div class="none">Nothing found.</div>';res.hidden=false}
box.oninput=show;res.onmousedown=function(e){var b=e.target.closest('[data-i]');if(b){e.preventDefault();res.hidden=true;open(hits[+b.getAttribute('data-i')][0])}};
box.onkeydown=function(e){if(e.key==='Enter'&&hits[on]){e.preventDefault();res.hidden=true;open(hits[on][0])}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();on=(on+(e.key==='ArrowDown'?1:-1)+hits.length)%Math.max(1,hits.length);res.querySelectorAll('[data-i]').forEach(function(b,i){b.classList.toggle('on',i===on)})}else if(e.key==='Escape'){box.value='';res.hidden=true}};
box.onblur=function(){setTimeout(function(){res.hidden=true},150)};
document.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();box.focus()}});
var links=[].slice.call(document.querySelectorAll('#toc a[data-go]'));function spy(){var c=null;document.querySelectorAll('.sec,details.est-room').forEach(function(s){if(s.getBoundingClientRect().top<120)c=s.id});links.forEach(function(a){a.classList.toggle('here',a.getAttribute('data-go')===c)})}
addEventListener('scroll',function(){requestAnimationFrame(spy)},{passive:true});spy();empty();})();`;

export { ws };

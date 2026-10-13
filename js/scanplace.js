// "What is this scan?" When a scan joins a property that already has a plan, the person
// adding it says how it relates: the next floor, a rescan that replaces a floor, another
// structure beside the building, or reference geometry only. The fit from scanmerge.js
// orders the choices and explains its suggestion; nothing changes until one is picked.

import { escapeHtml } from './store.js';
import { icon } from './icons.js';

const CHOICES = {
  level: { label: 'NEXT FLOOR', ic: 'layers', text: 'Stack it on top as a new level, lined up with the floor below.' },
  replace: { label: 'REPLACE THAT FLOOR', ic: 'refresh', text: 'Rebuild the matching floor from this scan. Other floors stay.' },
  beside: { label: 'SEPARATE BUILDING', ic: 'plus', text: 'Place it beside what is here (a garage, a studio), on the same ground.' },
  reference: { label: 'JUST KEEP THE SCAN', ic: 'scan', text: 'Leave the plan alone; the scan stays as reference geometry.' },
};

// Resolves to 'level' | 'replace' | 'beside' | 'reference', or null when dismissed.
export function chooseScanPlacement(fit, scanName) {
  return new Promise(resolve => {
    const order = [fit.suggestion].concat(['level', 'replace', 'beside'].filter(k => k !== fit.suggestion), ['reference']);
    const el = document.createElement('div');
    el.className = 'modal-backdrop sp-backdrop';
    el.innerHTML = `
      <div class="modal sp" role="dialog" aria-modal="true" aria-labelledby="sp-title">
        <div class="modal-head"><h2 id="sp-title">${icon('scan')}ADD ${escapeHtml(String(scanName || 'SCAN').toUpperCase())}</h2></div>
        <div class="modal-body">
          <p class="np-hint">This property already has a plan. How does the new scan relate to it?</p>
          <div class="sp-why"><span class="np-kicker">SUGGESTED</span><span>${escapeHtml(fit.reason)}</span></div>
          <div class="sp-list">${order.map((k, i) => `
            <button class="sp-choice ${i === 0 ? 'suggested' : ''}" data-mode="${k}">
              ${icon(CHOICES[k].ic)}<span><b>${CHOICES[k].label}</b><small>${CHOICES[k].text}</small></span>
            </button>`).join('')}</div>
        </div>
      </div>`;
    const done = mode => { window.removeEventListener('keydown', onKey, true); el.remove(); resolve(mode); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    window.addEventListener('keydown', onKey, true);
    el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => done(b.dataset.mode));
    document.body.appendChild(el);
    el.querySelector('.sp-choice').focus();
  });
}

// On a touch device no reading text on the pages is under 12 points (finding small-targets).
// The page rules set many small sizes for a mouse and a computer's screen. Instead of a second
// hand-kept copy of each, raiseSmallText() adds, once at start, a raised copy of every rule that
// sets a size under 12 points:
//   - only on a touch device (html.touch, from touchDevice() in render-quality.js), so a computer's
//     sizes never change;
//   - only inside the page (#view), and not on PLAN or MODEL, which keep their own drawing sizes;
//   - at the original rule's own specificity (the touch test is wrapped in :where()), so a more
//     specific rule that sets a larger size still wins;
//   - inside the same @media condition as the original; print rules are left alone.
// Text drawn in SVG, and sizes written in a page's own markup, are raised where they are drawn.
export const MIN_TEXT_PX = 12;
export const TEXT_SCOPE = ':where(html.touch:not([data-view=plan]):not([data-view=model]) #view)';

// The selectors of a rule, split at its top-level commas (not those inside :is(...) and the like).
export function splitSelectors(text) {
  const out = []; let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// The raised copy of one style rule, or '' when it needs none: a size under 12 points written in
// px, on something inside the page. Rules for the whole document (html, body, :root) and for SVG
// drawings are not page text.
export function raisedRule(selectorText, fontSize) {
  const m = /^([\d.]+)px$/.exec(String(fontSize || '').trim());
  if (!m || Number(m[1]) >= MIN_TEXT_PX) return '';
  const sels = splitSelectors(selectorText)
    .filter(s => !/^(html|body|:root)\b/.test(s) && !/(^|[\s>+~(])(svg|text|tspan)\b/.test(s));
  if (!sels.length) return '';
  return sels.map(s => /^#view\b/.test(s) ? TEXT_SCOPE.replace(' #view)', ')') + ' ' + s : TEXT_SCOPE + ' ' + s).join(', ') + ' { font-size: ' + MIN_TEXT_PX + 'px; }';
}

// The size a rule sets: font-size, or the size inside the font shorthand (which a browser keeps
// whole, without a font-size of its own, when the shorthand holds a var(), as in
// "font: 10px var(--mono)").
export function ruleFontSize(style) {
  if (style.fontSize) return style.fontSize;
  const m = /(?:^|\s)([\d.]+px)(?=\/|\s|$)/.exec(style.getPropertyValue ? style.getPropertyValue('font') : '');
  return m ? m[1] : '';
}

// Raised copies of every rule in these rule lists, with each @media condition kept.
export function raisedRules(rules) {
  const out = [];
  for (const r of rules || []) {
    if (r.selectorText !== undefined && r.style) { const t = raisedRule(r.selectorText, ruleFontSize(r.style)); if (t) out.push(t); }
    else if (r.media && r.cssRules) {
      const cond = r.conditionText || r.media.mediaText || '';
      if (/\bprint\b/.test(cond)) continue;
      const inner = raisedRules(r.cssRules);
      if (inner.length) out.push('@media ' + cond + ' { ' + inner.join('\n') + ' }');
    } else if (r.cssRules && !r.media) out.push(...raisedRules(r.cssRules));
  }
  return out;
}

// Once at start: one stylesheet of raised copies, after the page's own stylesheets.
export function raiseSmallText(doc = document) {
  if (doc.getElementById('touch-text')) return;
  const out = [];
  for (const sheet of doc.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    out.push(...raisedRules(rules));
  }
  const style = doc.createElement('style');
  style.id = 'touch-text';
  style.textContent = out.join('\n');
  doc.head.appendChild(style);
}

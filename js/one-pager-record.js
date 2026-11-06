// The one-pager record on a property (see one-pager.js for what it means). No imports, so
// store.js can repair it while loading a file and one-pager.js can read it.
//
// prop.onePager = { headline, tagline, summary, highlights: [text], client, preparedBy, contact,
//   hero: '' (automatic) | 'model' | 'plan' | <photo id>, show: { budget, schedule, rooms, plan, products },
//   customized, draftedAt, updatedAt, basedOn, versions: [{ n, date, documentId }] }

export const SHOW_KEYS = ['budget', 'schedule', 'rooms', 'plan', 'products'];
export const MAX_HIGHLIGHTS = 6;
export const MAX_TEXT = { headline: 90, tagline: 140, summary: 1100, highlight: 110, client: 80, preparedBy: 80, contact: 120 };
const ID_RE = /^[\w.:-]{1,80}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const cleanLine = (v, max) => String(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const str = v => typeof v === 'string' ? v : '';

export function emptyOnePager() {
  return {
    headline: '', tagline: '', summary: '', highlights: [], client: '', preparedBy: '', contact: '',
    hero: '', show: Object.fromEntries(SHOW_KEYS.map(k => [k, true])),
    customized: false, draftedAt: '', updatedAt: '', basedOn: '', versions: [],
  };
}

// The record on a property, repaired: unknown fields drop, bad values take safe ones.
export function normalizeOnePager(p) {
  const o = p.onePager && typeof p.onePager === 'object' && !Array.isArray(p.onePager) ? p.onePager : {};
  const out = emptyOnePager();
  out.headline = cleanLine(o.headline, MAX_TEXT.headline);
  out.tagline = cleanLine(o.tagline, MAX_TEXT.tagline);
  out.summary = str(o.summary).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT.summary);
  out.highlights = (Array.isArray(o.highlights) ? o.highlights : []).map(h => cleanLine(h, MAX_TEXT.highlight)).filter(Boolean).slice(0, MAX_HIGHLIGHTS);
  out.client = cleanLine(o.client, MAX_TEXT.client);
  out.preparedBy = cleanLine(o.preparedBy, MAX_TEXT.preparedBy);
  out.contact = cleanLine(o.contact, MAX_TEXT.contact);
  const hero = str(o.hero);
  out.hero = hero === 'model' || hero === 'plan' || ID_RE.test(hero) ? hero : '';
  if (o.show && typeof o.show === 'object' && !Array.isArray(o.show)) for (const k of SHOW_KEYS) if (typeof o.show[k] === 'boolean') out.show[k] = o.show[k];
  out.customized = o.customized === true;
  out.draftedAt = str(o.draftedAt);
  out.updatedAt = str(o.updatedAt);
  out.basedOn = str(o.basedOn);
  const seen = new Set();
  for (const v of Array.isArray(o.versions) ? o.versions.slice(0, 500) : []) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const n = Number(v.n);
    if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;
    seen.add(n);
    out.versions.push({ n, date: ISO_DATE_RE.test(str(v.date)) ? v.date : '', documentId: ID_RE.test(str(v.documentId)) ? v.documentId : '' });
  }
  out.versions.sort((a, b) => a.n - b.n);
  p.onePager = out;
  return out;
}

export function latestVersion(prop) {
  const list = prop && prop.onePager && Array.isArray(prop.onePager.versions) ? prop.onePager.versions : [];
  return list.length ? list[list.length - 1] : null;
}

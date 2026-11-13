// Appearance, measured geometry and product identity are independent claims.
// A source is a photo/document/measurement reference, never a confidence score alone.
import { trimProduct, sectionOf } from './trims.js';

export const EVIDENCE_STATES = ['observed', 'inferred', 'unknown'];
export const EVIDENCE_COLORS = { observed: '#35bca5', inferred: '#edae39', unknown: '#a889d8', stale: '#ed6570' };
export const IDENTITY_STATES = ['unknown', 'observed', 'proposed'];
export function evidenceSignature(record) {
  const fields = ['ax','ay','bx','by','thickness','height','pts','width','sill','t','wallId','level','x','y','rot','w','d','h','y0','depth','subtype','offsets','scale','rotation','position','componentTransforms','hiddenParts','profile','sourceVersion','assetRevision','pos','rot','rotY','bytes','convertedAgainAt','leaves','plain','glass','side','seat','counterT','toeKick','toeDepth','overhang','partOffsets'];
  // Append newly supported geometry only when present, preserving legacy signatures for
  // records that do not use it while invalidating reviewed details when they change.
  const detailFields = ['detail','ceilingHeight','baseboardPos','baseboardNeg','floorContinuity','doorState','materialEndA','materialEndB'];
  // Trim's product sets its drawn profile. Names and notes do not change that geometry.
  if (record?.wallId && record?.style && ('f0' in record || 'f1' in record)) detailFields.push('style','product','f0','f1','cols','rows','widths','heights','gap','inset','spacing','material');
  return JSON.stringify([...fields.map(k => [k, record?.[k] ?? null]), ...detailFields.filter(k => record?.[k] !== undefined).map(k => [k, record[k]])]);
}
export function evidenceState(record, aspect = 'geometry') {
  const e = record?.evidence?.[aspect];
  if (!e || !EVIDENCE_STATES.includes(e.status)) return 'unknown';
  if (e.signature && e.signature !== evidenceSignature(record)) return 'stale';
  if (record.evidenceContext && e.contextSignature && e.contextSignature !== JSON.stringify(record.evidenceContext)) return 'stale';
  if (e.status === 'observed' && !e.source?.trim()) return 'unknown';
  return e.status;
}
export function setEvidence(record, aspect, status, source, note = '') {
  if (!EVIDENCE_STATES.includes(status)) throw new Error('Unknown evidence status.');
  if (status === 'observed' && !String(source || '').trim()) throw new Error('Observed claims need a photo, document or measurement reference.');
  record.evidence = { ...record.evidence, [aspect]: { status, source: String(source || '').trim(), note: String(note || '').trim(), signature: evidenceSignature(record), ...(record.evidenceContext ? { contextSignature: JSON.stringify(record.evidenceContext) } : {}), reviewedAt: new Date().toISOString() } };
}
export function productEvidence(p) {
  return { ...(p.identityStatus ? { identityStatus: IDENTITY_STATES.includes(p.identityStatus) && (p.identityStatus !== 'observed' || typeof p.evidence?.identity?.source === 'string' && p.evidence.identity.source.trim()) ? p.identityStatus : 'unknown' } : {}),
    ...(p.evidence && typeof p.evidence === 'object' ? { evidence: structuredClone(p.evidence) } : {}),
    ...(p.proposedProduct && typeof p.proposedProduct === 'object' ? { proposedProduct: structuredClone(p.proposedProduct) } : {}) };
}

// Reference closure follows links, rather than assuming a product belongs only to a scope.
export function referencedProductIds(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids;
  if (typeof value.productId === 'string') ids.add(value.productId);
  for (const child of Object.values(value)) if (child && typeof child === 'object') referencedProductIds(child, ids);
  return ids;
}

// Generated geometry depends on its host as well as the element's own dimensions.
export function elementEvidenceRecord(prop, kind, record) {
  if (!record) return null;
  const wall = kind === 'opening' || kind === 'trim' ? prop.walls?.find(w => w.id === record.wallId) : null;
  const level = prop.levels?.find(l => l.id === (record.level || wall?.level));
  const product = kind === 'trim' ? trimProduct(record) : null;
  return { ...record, evidenceContext: {
    level: level ? [level.id, level.elevation, level.height] : null,
    host: wall ? [wall.ax,wall.ay,wall.bx,wall.by,wall.thickness,wall.height] : null,
    openings: kind === 'wall' || kind === 'trim' ? (prop.openings || []).filter(o=>o.wallId===(kind === 'wall' ? record.id : record.wallId)).map(evidenceSignature) : null,
    ...(kind === 'trim' ? { trim: {
      // Adjacent walls determine mitres; catalog evidence and the actual profile determine
      // what the selected product represents, including a fallback for an unknown catalog ID.
      walls: (prop.walls || []).filter(w => w.level === wall?.level).map(w => [w.id,w.ax,w.ay,w.bx,w.by,w.thickness]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))),
      product: product ? structuredClone(product) : null,
      section: product ? sectionOf(product.profile, product.W, product.T) : null,
    } } : {}),
  } };
}

// Inspector edits follow the same precedence as rendering: explicit observed details
// override the older flat profile record. Both interfaces remain usable after import.
const own = (record, key) => record && Object.prototype.hasOwnProperty.call(record, key);
const detailFor = opening => opening.detail?.[opening.type === 'window' ? 'window' : 'door'];
const detailKey = (opening, key) => opening.type !== 'window' && key === 'panels' ? 'style' : key;

export function openingProfileValue(opening, key) {
  const detail = detailFor(opening), dk = detailKey(opening, key);
  if (own(detail, dk)) {
    if (key === 'panels') return detail[dk] === 'six-panel' ? 'six' : detail[dk] === 'slab' ? 'flat' : opening.profile?.[key];
    return detail[dk];
  }
  if (own(opening.profile, key)) return opening.profile[key];
  if (opening.type === 'window' && /^(upper|lower)(Columns|Rows)$/.test(key)) {
    return openingProfileValue(opening, key.endsWith('Columns') ? 'columns' : 'rows');
  }
  return undefined;
}

export function setOpeningProfileValue(opening, key, value) {
  const clear = value === '' || value === undefined;
  opening.profile ||= {};
  if (clear) delete opening.profile[key]; else opening.profile[key] = value;
  const detail = detailFor(opening), dk = detailKey(opening, key);
  if (detail && typeof detail === 'object') {
    if (clear) delete detail[dk];
    else detail[dk] = key === 'panels' ? value === 'six' ? 'six-panel' : 'slab' : value;
  }
}

export function openingGridFields(opening) {
  return openingProfileValue(opening, 'type') === 'double-hung'
    ? ['upperColumns', 'upperRows', 'lowerColumns', 'lowerRows'] : ['columns', 'rows'];
}

// An explicit measured slab remains authoritative after an inspector or tape edit. Call
// on a trial copy before validating, then on the live record only after resize succeeds.
export function setExplicitSlabWidth(opening, value) {
  if (opening.detail?.door && typeof opening.detail.door === 'object') opening.detail.door.leafWidth = value;
  if (own(opening.profile, 'leafWidth')) opening.profile.leafWidth = value;
}

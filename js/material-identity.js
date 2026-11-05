// What a library material is in the real world, apart from how it renders (materials.js).
// SketchUp keeps a material's colour and texture; Tiksi also says what the thing is:
//
//   category    what it is made of: one of CATEGORIES (wood, plaster, paint, metal, glass, ...)
//   type        the specific thing in words: "White oak, rift sawn", "Lime plaster", "Brushed nickel"
//   product     null, or the product it is: { brand (maker), name, model (product number), url,
//               productId (a PRODUCTS record, ws.data.products) }
//   colorName / colorCode / colorBrand   the colour as its own thing: "White Dove", "OC-17",
//               "Benjamin Moore". The hex `color` stays the swatch every view draws.
//   coverage    null, or how far one unit goes: { areaM2 (per unit, per coat), unit ('gal', 'L',
//               'qt', 'box', 'bag', 'unit'), coats }. With a measured area it gives an estimated
//               amount to buy (coverageEstimate); a PRODUCTS record may carry the same field.
//
// `pattern` stays the render texture. A record with no pattern takes its category's; a record
// with no category is given one from its name, then its pattern. Pure functions, no DOM.

export const CATEGORIES = ['wood', 'plaster', 'paint', 'metal', 'glass', 'stone', 'tile', 'brick', 'concrete', 'fabric', 'plastic', 'ceramic', 'laminate', 'vinyl', 'other'];

export const CATEGORY_LABELS = {
  wood: 'Wood', plaster: 'Plaster', paint: 'Paint', metal: 'Metal', glass: 'Glass', stone: 'Stone', tile: 'Tile',
  brick: 'Brick', concrete: 'Concrete', fabric: 'Fabric', plastic: 'Plastic', ceramic: 'Ceramic', laminate: 'Laminate',
  vinyl: 'Vinyl', other: 'Other',
};

// The render texture a category gets when the record does not name one.
const CATEGORY_PATTERN = {
  wood: 'wood', plaster: 'plaster', paint: 'drywall', metal: 'metal', glass: 'glass', stone: 'stone', tile: 'tile',
  brick: 'brick', concrete: 'concrete', fabric: 'carpet', plastic: 'flat', ceramic: 'tile', laminate: 'wood', vinyl: 'wood', other: 'flat',
};
export function patternForCategory(category) { return CATEGORY_PATTERN[category] || 'flat'; }

// The category a render texture suggests, when the name says nothing.
const PATTERN_CATEGORY = {
  flat: 'paint', drywall: 'paint', plaster: 'plaster', brick: 'brick', cmu: 'concrete', stone: 'stone', wood: 'wood',
  tile: 'tile', concrete: 'concrete', carpet: 'fabric', siding: 'wood', board: 'wood', marble: 'stone', metal: 'metal',
  glass: 'glass', photo: 'other',
};

// Words in a name, most specific first: "Luxury vinyl plank" is vinyl before it is a plank,
// "Painted plaster" is plaster with a paint colour, "Slate tile" is stone.
const CATEGORY_WORDS = [
  ['vinyl', ['vinyl', 'lvp', 'lvt']],
  ['laminate', ['laminate', 'formica', 'hpl']],
  ['glass', ['glass', 'glazing', 'mirror', 'bottle']],
  ['metal', ['stainless', 'steel', 'metal', 'aluminum', 'aluminium', 'copper', 'brass', 'bronze', 'iron', 'zinc', 'chrome', 'nickel', 'pewter', 'galvanized']],
  ['brick', ['brick']],
  ['wood', ['butcher block']],
  ['concrete', ['concrete', 'cement', 'cmu', 'cinder', 'screed', 'concrete block']],
  ['stone', ['marble', 'granite', 'quartz', 'quartzite', 'soapstone', 'limestone', 'slate', 'travertine', 'sandstone', 'bluestone', 'fieldstone', 'ashlar', 'stone', 'terrazzo', 'onyx']],
  ['tile', ['tile', 'subway', 'mosaic', 'zellige', 'penny', 'hex', 'porcelain', 'terracotta']],
  ['ceramic', ['ceramic', 'vitreous', 'fireclay', 'china', 'stoneware']],
  ['plaster', ['plaster', 'stucco', 'venetian', 'tadelakt', 'limewash', 'lime wash', 'skim coat']],
  ['wood', ['oak', 'walnut', 'maple', 'hickory', 'pine', 'plank', 'wood', 'hardwood', 'bamboo', 'cork', 'ash', 'cherry', 'teak', 'fir', 'cedar', 'barn', 'mahogany', 'birch', 'beech', 'plywood', 'veneer', 'timber', 'lumber', 'shiplap', 'clapboard', 'batten', 'wainscot', 'beadboard', 'parquet']],
  ['fabric', ['carpet', 'rug', 'wool', 'berber', 'fabric', 'linen', 'cotton', 'velvet', 'upholstery', 'textile', 'leather', 'sisal', 'jute']],
  ['plastic', ['plastic', 'acrylic', 'pvc', 'polycarbonate', 'resin', 'nylon', 'polyethylene']],
  ['paint', ['paint', 'painted', 'drywall', 'gypsum', 'sheetrock', 'primer', 'eggshell', 'semi-gloss', 'enamel']],
];
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_RES = CATEGORY_WORDS.map(([category, words]) => [category, words.map(w => new RegExp('(^|[^a-z])' + escapeRe(w) + '(s|es)?($|[^a-z])'))]);

export function inferCategory(name, pattern) {
  const s = String(name || '').toLowerCase();
  for (const [category, res] of WORD_RES) if (res.some(re => re.test(s))) return category;
  return PATTERN_CATEGORY[pattern] || 'other';
}

// Suggestions for the type field, per category (the editor's list; any words are allowed).
export const TYPE_SUGGESTIONS = {
  wood: ['White oak, rift sawn', 'White oak, plain sawn', 'Red oak', 'Walnut', 'Maple', 'Hickory', 'Heart pine', 'Douglas fir', 'Western red cedar', 'Teak', 'Ash', 'Cherry', 'Bamboo', 'Birch plywood', 'Reclaimed barn wood'],
  plaster: ['Lime plaster', 'Venetian plaster', 'Gypsum plaster', 'Clay plaster', 'Tadelakt', 'Cement stucco'],
  paint: ['Latex paint, flat', 'Latex paint, eggshell', 'Latex paint, satin', 'Alkyd enamel, semi-gloss', 'Limewash', 'Mineral paint'],
  metal: ['Brushed nickel', 'Polished chrome', 'Stainless steel, brushed', 'Unlacquered brass', 'Oil-rubbed bronze', 'Matte black steel', 'Copper', 'Anodized aluminum', 'Zinc', 'Wrought iron'],
  glass: ['Clear float glass', 'Low-iron glass', 'Tempered glass', 'Frosted glass', 'Fluted glass', 'Green bottle glass'],
  stone: ['Carrara marble', 'Calacatta marble', 'Granite', 'Soapstone', 'Limestone', 'Slate', 'Travertine', 'Quartzite', 'Engineered quartz', 'Bluestone'],
  tile: ['Porcelain tile', 'Ceramic subway tile', 'Zellige', 'Encaustic cement tile', 'Glass mosaic', 'Terracotta tile'],
  brick: ['Red clay brick', 'Reclaimed brick', 'Thin brick veneer', 'Glazed brick'],
  concrete: ['Poured concrete', 'Polished concrete', 'Concrete block (CMU)', 'Fiber cement'],
  fabric: ['Wool carpet', 'Nylon carpet', 'Linen', 'Cotton canvas', 'Leather', 'Sisal'],
  plastic: ['Acrylic', 'PVC', 'Polycarbonate', 'Solid surface'],
  ceramic: ['Vitreous china', 'Fireclay', 'Stoneware'],
  laminate: ['High-pressure laminate', 'Laminate flooring'],
  vinyl: ['Luxury vinyl plank', 'Luxury vinyl tile', 'Sheet vinyl'],
  other: [],
};

const ID_OK = /^[\w.:-]{1,80}$/;
const text = (v, n) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '';
export function safeUrl(v) {
  const s = text(v, 2000);
  if (!s) return '';
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; }
}

// A product field in shape, or null when it names nothing.
export function normalizeProduct(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = { brand: text(p.brand, 120), name: text(p.name, 200), model: text(p.model, 120), url: safeUrl(p.url),
    productId: typeof p.productId === 'string' && ID_OK.test(p.productId) ? p.productId : null };
  return out.brand || out.name || out.model || out.url || out.productId ? out : null;
}

export const COVERAGE_UNITS = ['gal', 'L', 'qt', 'box', 'bag', 'unit'];
export function normalizeCoverage(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const areaM2 = +c.areaM2, coats = Math.round(+c.coats || 1);
  if (!(areaM2 > 0 && areaM2 < 1e5)) return null;
  return { areaM2: Math.round(areaM2 * 1e4) / 1e4, unit: COVERAGE_UNITS.includes(c.unit) ? c.unit : 'unit', coats: Math.min(10, Math.max(1, coats)) };
}
// An estimate from area only: area x coats / coverage per unit. No waste, primer, porosity or
// texture allowance is added, and the caller labels it as an estimate.
export function coverageEstimate(areaM2, coverage) {
  const c = normalizeCoverage(coverage);
  if (!c || !(areaM2 > 0)) return null;
  return { amount: areaM2 * c.coats / c.areaM2, unit: c.unit, coats: c.coats, areaM2PerUnit: c.areaM2 };
}
// The coverage that applies to a material: its own, else its linked product's.
export function coverageFor(m, products) {
  const own = normalizeCoverage(m && m.coverage);
  if (own) return own;
  const id = m && m.product && m.product.productId;
  const rec = id && Array.isArray(products) ? products.find(r => r.id === id) : null;
  return rec ? normalizeCoverage(rec.coverage) : null;
}

// Fill and clean the real-world fields of a library record in place. `pattern` must already be
// valid (normalizeMaterial does that first, from the category when it has one).
export function normalizeIdentity(m) {
  if (!m || typeof m !== 'object') return m;
  if (!CATEGORIES.includes(m.category)) m.category = inferCategory(m.name, m.pattern);
  m.type = text(m.type, 160);
  m.product = normalizeProduct(m.product);
  m.colorName = text(m.colorName, 120);
  m.colorCode = text(m.colorCode, 60);
  m.colorBrand = text(m.colorBrand, 120);
  m.coverage = normalizeCoverage(m.coverage);
  return m;
}

// ---------- words for lists ----------
// "Wood · White oak, rift sawn"
export function identityLine(m) {
  if (!m) return '';
  const label = CATEGORY_LABELS[m.category] || '';
  return [label, m.type && m.type.toLowerCase() !== label.toLowerCase() ? m.type : ''].filter(Boolean).join(' · ');
}
// "Benjamin Moore White Dove OC-17"
export function colourLine(m) {
  return m ? [m.colorBrand, m.colorName, m.colorCode].filter(Boolean).join(' ') : '';
}
// "Kohler Purist faucet K-14406-4-BN": the record it links to wins over typed words.
export function productLine(m, products) {
  const p = m && m.product;
  if (!p) return '';
  const rec = p.productId && Array.isArray(products) ? products.find(r => r.id === p.productId) : null;
  const brand = (rec && rec.brand) || p.brand, model = (rec && rec.model) || p.model, name = (rec && rec.name) || p.name;
  const named = name && brand && name.toLowerCase().startsWith(brand.toLowerCase()) ? name : [brand, name].filter(Boolean).join(' ');
  return [named, model && !(named || '').includes(model) ? model : ''].filter(Boolean).join(' ');
}
// Everything a search box should find a material by.
export function identityWords(m, products) {
  return [CATEGORY_LABELS[m.category] || '', m.type, colourLine(m), productLine(m, products)].join(' ');
}

// ---------- products list links ----------
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const PRODUCT_CATEGORY = { wood: 'flooring', vinyl: 'flooring', laminate: 'flooring', tile: 'tile', stone: 'tile', ceramic: 'plumbing', paint: 'paint', plaster: 'paint', metal: 'hardware', glass: 'windows-doors', brick: 'other', concrete: 'other', fabric: 'flooring', plastic: 'other', other: 'other' };

// The PRODUCTS record a material's product is: by link, else by maker and product number.
export function productRecordFor(data, m) {
  const p = m && m.product;
  if (!p || !data || !Array.isArray(data.products)) return null;
  if (p.productId) { const r = data.products.find(x => x.id === p.productId); if (r) return r; }
  if (!p.brand || !p.model) return null;
  return data.products.find(r => same(r.brand, p.brand) && same(r.model, p.model)) || null;
}

// Link a material to a PRODUCTS record: an existing one by id, or the record its maker and product
// number name (found or made). The record lists the material (materialIds), which is how product
// pricing, takeoffs and project files already follow materials. Returns { record, created } or null.
export function linkMaterialProduct(data, m, { productId, propertyId } = {}, newId) {
  let record = productId ? data.products.find(r => r.id === productId) || null : productRecordFor(data, m), created = false;
  if (!record && !productId) {
    const p = m.product;
    if (!p || !p.brand || !p.model) return null;
    record = { id: newId('prod'), name: p.name || [p.brand, p.model].join(' '), brand: p.brand, model: p.model,
      category: PRODUCT_CATEGORY[m.category] || 'other', url: p.url || '', manufacturerUrl: '', price: 0, unit: 'ea', imageUrl: '',
      specs: [identityLine(m), colourLine(m)].filter(Boolean).join('\n'), notes: 'Added from the material "' + m.name + '".', itemIds: [], materialIds: [] };
    if (propertyId) record.propertyIds = [propertyId];
    data.products.push(record);
    created = true;
  }
  if (!record) return null;
  unlinkMaterialProduct(data, m, { keepFields: true });
  record.materialIds = Array.isArray(record.materialIds) ? record.materialIds : [];
  if (!record.materialIds.includes(m.id)) record.materialIds.push(m.id);
  const typed = m.product || {};
  m.product = normalizeProduct({ brand: record.brand || typed.brand, name: record.name || typed.name, model: record.model || typed.model,
    url: record.manufacturerUrl || record.url || typed.url, productId: record.id });
  return { record, created };
}

// Take a material off its PRODUCTS record. The typed maker and number stay unless asked otherwise.
export function unlinkMaterialProduct(data, m, { keepFields = true } = {}) {
  const id = m && m.product && m.product.productId;
  if (id) {
    const r = data.products.find(x => x.id === id);
    if (r && Array.isArray(r.materialIds)) r.materialIds = r.materialIds.filter(x => x !== m.id);
  }
  if (!m || !m.product) return;
  if (keepFields) { m.product.productId = null; m.product = normalizeProduct(m.product); }
  else m.product = null;
}

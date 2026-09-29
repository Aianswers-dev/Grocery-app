// Size and unit-price helpers shared by the Worker (store plug-ins) and the app.
//
// Every amount is normalised to a base unit per dimension:
//   volume -> millilitres, mass -> grams, count -> items.

const UNIT_TABLE = {
  ml: ['volume', 1], millilitre: ['volume', 1], millilitres: ['volume', 1], milliliter: ['volume', 1],
  cl: ['volume', 10],
  l: ['volume', 1000], lt: ['volume', 1000], ltr: ['volume', 1000], litre: ['volume', 1000],
  litres: ['volume', 1000], liter: ['volume', 1000], liters: ['volume', 1000],
  g: ['mass', 1], gm: ['mass', 1], gr: ['mass', 1], gram: ['mass', 1], grams: ['mass', 1], grm: ['mass', 1],
  kg: ['mass', 1000], kgs: ['mass', 1000], kilo: ['mass', 1000], kilos: ['mass', 1000],
  kilogram: ['mass', 1000], kilograms: ['mass', 1000],
  pk: ['count', 1], pack: ['count', 1], packs: ['count', 1], pce: ['count', 1], pcs: ['count', 1],
  pieces: ['count', 1], piece: ['count', 1], ea: ['count', 1], each: ['count', 1], ct: ['count', 1],
  count: ['count', 1], rolls: ['count', 1], roll: ['count', 1],
  tablets: ['count', 1], capsules: ['count', 1], sachets: ['count', 1], bags: ['count', 1],
  cans: ['count', 1], bottles: ['count', 1],
};

const UNIT_WORDS = Object.keys(UNIT_TABLE).sort((a, b) => b.length - a.length).join('|');
const NUM = '(\\d+(?:\\.\\d+)?)';
// "24 x 375ml", "10x375ml", "6 x 1.25L"
const MULTI_RE = new RegExp(`(?:^|[^\\w.])(\\d+)\\s*[x×]\\s*${NUM}\\s*(${UNIT_WORDS})\\b`, 'i');
// The number must not be glued to a word ("a2 Light Milk" is not 2 litres).
const AMOUNT_RE = new RegExp(`(?:^|[^\\w.])${NUM}\\s*(${UNIT_WORDS})\\b`, 'gi');
// "x12" / "12x" style counts with no unit after
const COUNT_X_RE = /(?:^|\s)(?:x\s*(\d+)|(\d+)\s*x)(?=\s|$)/i;

export const BASE_LABEL = { volume: 'L', mass: 'kg', count: 'each' };
const BASE_FACTOR = { volume: 1000, mass: 1000, count: 1 };

function clean(text) {
  return String(text || '')
    .replace(/(\d),(\d{3})/g, '$1$2') // 1,500 g -> 1500 g
    .replace(/ /g, ' ');
}

/** Look up a unit word. Returns [dimension, factor] or null. */
export function unitInfo(word) {
  return UNIT_TABLE[String(word || '').toLowerCase()] || null;
}

/**
 * Parse every size mention in a string.
 * @returns {{volume?:number, mass?:number, count?:number, multi?:boolean, approx:boolean, perKg:boolean}}
 */
export function parseSizeText(text) {
  const s = clean(text);
  const out = { approx: /approx|approximately|~|per piece|each approx/i.test(s), perKg: /\bper\s*kg\b|\/\s*kg\b/i.test(s) };
  if (!s) return out;

  const multi = s.match(MULTI_RE);
  if (multi) {
    const n = Number(multi[1]);
    const [dim, f] = unitInfo(multi[3]);
    if (dim !== 'count') {
      out[dim] = round(n * Number(multi[2]) * f);
      out.count = n;
      out.multi = true;
    }
  }
  for (const m of s.matchAll(AMOUNT_RE)) {
    const [dim, f] = unitInfo(m[2]);
    const v = round(Number(m[1]) * f);
    if (out[dim] == null) out[dim] = v;
  }
  if (out.count == null) {
    if (/\bdozen\b/i.test(s)) out.count = 12;
    else {
      const cx = s.match(COUNT_X_RE);
      if (cx) out.count = Number(cx[1] || cx[2]);
    }
  }
  if (out.perKg && out.mass == null) out.mass = 1000;
  return out;
}

/**
 * Work out a product's pack size from its size text and name.
 * `impliedBase` (optional) is { dim, amount } derived from price / unit price,
 * used to decide whether "375ml" + "30 Pack" means 375ml or 30 x 375ml.
 * @returns {{dim:'volume'|'mass'|'count'|null, amount:number|null, count:number|null, approx:boolean, perPiece:boolean, dims:object}}
 */
export function productSize({ size, name, impliedBase } = {}) {
  const a = parseSizeText(size);
  const b = parseSizeText(name);
  const dims = {};
  for (const dim of ['volume', 'mass', 'count']) {
    if (a[dim] != null) dims[dim] = a[dim];
    else if (b[dim] != null) dims[dim] = b[dim];
  }
  // Separate "N Pack" count and a per-unit measure (e.g. Coles "Cans 375ml" + "30 Pack").
  const measureDim = dims.volume != null ? 'volume' : dims.mass != null ? 'mass' : null;
  if (measureDim && dims.count > 1 && !a.multi && !b.multi) {
    const single = dims[measureDim];
    const total = single * dims.count;
    if (impliedBase && impliedBase.dim === measureDim && impliedBase.amount > 0) {
      if (Math.abs(impliedBase.amount - total) / total < 0.15) dims[measureDim] = total;
    } else if (a.count != null && a[measureDim] == null && b[measureDim] != null) {
      // Count came from the size field, measure only from the name: treat as multipack.
      dims[measureDim] = total;
    }
  }
  // Sold by the piece with no weight given (Woolworths "Cavendish Bananas each").
  const perPiece = /^\s*(?:1\s*)?(?:each|ea)\s*$/i.test(size || '');
  if (perPiece && dims.count == null) dims.count = 1;
  const dim = measureDim || (dims.count != null ? 'count' : null);
  return {
    dim,
    amount: dim ? dims[dim] : null,
    count: dims.count ?? null,
    approx: a.approx || b.approx,
    perPiece,
    dims,
  };
}

/**
 * Normalise a store-supplied unit price, e.g. ($3.00, 100, 'g') -> { unitPrice: 30, unitMeasure: 'kg' }.
 */
export function normaliseUnitPrice(price, quantity, unit) {
  const info = unitInfo(unit);
  if (!(price > 0) || !info) return { unitPrice: null, unitMeasure: null };
  const [dim, f] = info;
  const qtyBase = (Number(quantity) || 1) * f;
  return { unitPrice: round((price / qtyBase) * BASE_FACTOR[dim], 4), unitMeasure: BASE_LABEL[dim] };
}

/** Parse strings like "$1.65/ 1L", "$2.38 per 100 g", "1KG", "100G". */
export function parseUnitString(text) {
  const s = clean(text);
  const price = s.match(/\$\s*(\d+(?:\.\d+)?)/);
  const measure = s.match(new RegExp(`(?:per|\\/)?\\s*${NUM}?\\s*(${UNIT_WORDS})\\b`, 'i'));
  if (!price || !measure) return { unitPrice: null, unitMeasure: null };
  return normaliseUnitPrice(Number(price[1]), measure[1] || 1, measure[2]);
}

/** Split a measure like "100G" / "1L" / "1EA" into [quantity, unit]. */
export function splitMeasure(text) {
  const m = clean(text).match(new RegExp(`^\\s*${NUM}?\\s*(${UNIT_WORDS})\\s*$`, 'i'));
  return m ? [Number(m[1] || 1), m[2]] : [null, null];
}

/** Amount in base units that the price buys, implied by the unit price. */
export function impliedAmount(price, unitPrice, unitMeasure) {
  if (!(price > 0) || !(unitPrice > 0)) return null;
  const dim = unitMeasure === 'L' ? 'volume' : unitMeasure === 'kg' ? 'mass' : unitMeasure === 'each' ? 'count' : null;
  if (!dim) return null;
  return { dim, amount: round((price / unitPrice) * BASE_FACTOR[dim]) };
}

/** Human-readable size, e.g. formatAmount('volume', 2000) -> "2L". */
export function formatAmount(dim, amount) {
  if (amount == null) return '';
  if (dim === 'volume') return amount >= 1000 ? `${trim(amount / 1000)}L` : `${trim(amount)}ml`;
  if (dim === 'mass') return amount >= 1000 ? `${trim(amount / 1000)}kg` : `${trim(amount)}g`;
  return `${trim(amount)} pack`;
}

export function formatUnitPrice(unitPrice, unitMeasure) {
  if (!(unitPrice > 0) || !unitMeasure) return '';
  return `$${unitPrice.toFixed(2)}/${unitMeasure}`;
}

function trim(n) {
  return String(Math.round(n * 100) / 100);
}

function round(n, dp = 3) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

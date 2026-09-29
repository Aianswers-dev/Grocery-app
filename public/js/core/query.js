// Turns what the user types ("2 x milk 2L", "6 bananas", "eggs dozen") into a structured item.
import { parseSizeText, formatAmount } from './units.js';

const SIZE_TOKEN = /(\d+(?:\.\d+)?\s*[x×]\s*)?\d+(?:\.\d+)?\s*(ml|millilitres?|cl|l|lt|ltr|litres?|liters?|g|gm|grams?|kg|kgs|kilos?|kilograms?|pk|packs?|pcs|pieces?|ea|each|ct|count|rolls?|tablets|capsules|sachets|bags|cans|bottles)\b/gi;

/**
 * @returns {{text:string, label:string, name:string, qty:number, size:{dim:string, amount:number, count:number|null, label:string}|null, key:string}}
 *   label is the text without the quantity ("milk 2L" for "2 x milk 2L").
 */
export function parseItem(input) {
  let text = String(input || '').trim().replace(/\s+/g, ' ');
  let rest = text;
  let qty = 1;

  // "2 x milk", "2x milk", "milk x2", "milk x 2"
  let m = rest.match(/^(\d{1,3})\s*[x×*]\s+(.+)$/i) || rest.match(/^(\d{1,3})[x×*](\D.*)$/i);
  if (m) {
    qty = Number(m[1]);
    rest = m[2];
  } else if ((m = rest.match(/^(.+?)\s+[x×*]\s*(\d{1,3})$/i))) {
    qty = Number(m[2]);
    rest = m[1];
  } else if ((m = rest.match(/^(\d{1,2})\s+([a-z].*)$/i)) && !startsWithUnit(m[2])) {
    // "6 bananas" (but not "2 L milk")
    qty = Number(m[1]);
    rest = m[2];
  }

  const sizeParts = rest.match(SIZE_TOKEN) || [];
  const dozen = /\bdozen\b/i.test(rest);
  let name = rest.replace(SIZE_TOKEN, ' ').replace(/\bdozen\b/gi, ' ');
  // A bare trailing number is a count: "eggs 12", "coke 24"
  let bareCount = null;
  const bare = name.match(/^(.*\D)\s+(\d{1,3})\s*$/);
  if (bare && !sizeParts.length && !dozen) {
    bareCount = Number(bare[2]);
    name = bare[1];
  }
  name = name.replace(/\s+/g, ' ').trim();

  let size = null;
  const parsed = parseSizeText(sizeParts.join(' ') + (dozen ? ' dozen' : ''));
  if (bareCount) parsed.count = bareCount;
  const dim = parsed.volume != null ? 'volume' : parsed.mass != null ? 'mass' : parsed.count != null ? 'count' : null;
  if (dim) {
    size = { dim, amount: parsed[dim], count: parsed.count ?? null, label: sizeLabel(dim, parsed) };
  }
  qty = Math.max(1, Math.min(qty, 99));
  return { text, label: rest.trim(), name: name || text, qty, size, key: itemKey(name || text, size) };
}

function startsWithUnit(s) {
  return /^(ml|l|lt|ltr|litres?|g|kg|pk|packs?)\b/i.test(s);
}

function sizeLabel(dim, parsed) {
  if (dim === 'count') return `${parsed.count} pack`;
  const base = formatAmount(dim, parsed[dim]);
  return parsed.count > 1 && parsed.multi ? `${parsed.count} x ${formatAmount(dim, parsed[dim] / parsed.count)}` : base;
}

/** Stable key for remembering choices: same words + same size = same item. */
export function itemKey(name, size) {
  const words = String(name).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  return size ? `${words}|${size.dim}:${size.amount}` : words;
}

/** The text sent to the store's search box. */
export function searchText(item) {
  return item.name;
}

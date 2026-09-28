// Picks the cheapest *sensible* product at each store for one list item.
//
// 1. Score every product for relevance to the item name: are all the words there, is the
//    item word the product's head noun ("Milk Chocolate" is not milk), are there flavour or
//    variant words the user didn't ask for, plus the store's own ranking and category.
//    Words that most results share (e.g. "chocolate biscuit" for Tim Tams) are context,
//    not penalised.
// 2. Keep the "sensible" candidates: those close to the best score.
// 3. Decide a target size: the size typed by the user, or (if none) the size most stores
//    sell, so totals stay comparable across stores.
// 4. Among candidates within ±25% of the target (or an exact multiple, e.g. 2 x 2L for 4L,
//    or loose produce by the piece) pick the lowest unit price.
import { productSize, impliedAmount, formatAmount } from './units.js';

export const SIZE_TOLERANCE = 0.25;
const SENSIBLE_RATIO = 0.8;
const MAX_PACKS = 12;
// Outside the ±25% window, a different size is still shown (flagged) if within these bounds;
// anything further off is only offered as a suggestion.
const CLOSEST_MIN = 0.5;
const CLOSEST_MAX = 2;

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'on', 'x', 'to', 'from', 'by', 'or', 'in', 'with']);
const PACKAGING = new Set([
  'loose', 'bottle', 'bottles', 'pack', 'packs', 'pk', 'each', 'ea', 'bag', 'bags', 'punnet', 'tray', 'carton',
  'can', 'cans', 'multipack', 'jar', 'tub', 'box', 'value', 'bulk', 'approx', 'per', 'piece', 'prepacked',
  'packet', 'pouch', 'roll', 'rolls', 'tin', 'sachet', 'sachets', 'kg', 'g', 'l', 'ml', 'mini', 'canned',
  'tinned', 'bottled', 'family', 'twin', 'large', 'medium', 'small', 'size', 'ply',
]);
const NEUTRAL = new Set([
  'fresh', 'australian', 'aussie', 'whole', 'regular', 'original', 'classic', 'standard', 'pure', 'natural',
  'coles', 'woolworths', 'aldi', 'home', 'brand', 'essentials', 'homebrand', 'select', 'farmhouse', 'daily',
  'cavendish', 'white', 'plain', 'dairy', 'soft', 'drink', 'premium', 'simply', 'everyday', 'quality',
]);
const NEUTRAL_PHRASES = [
  'full cream', 'no added hormones', 'no added hormone', 'free range', 'cage free', 'barn laid', 'cage eggs',
  'grass fed', 'rspca approved', 'made in australia', 'australian made', 'best buy', 'odd bunch',
];
const MILD = new Set([
  'lite', 'light', 'skim', 'low', 'fat', 'reduced', 'extra', 'lean', 'unsalted', 'salted', 'organic', 'long',
  'life', 'uht', 'jumbo', 'thin', 'thick', 'sliced', 'diced', 'shredded', 'grated', 'lactose', 'free',
  'sugar', 'zero', 'diet', 'max', 'gluten', 'brown', 'wholemeal', 'multigrain', 'grain', 'red', 'green', 'fillet',
  'fillets', 'caged', 'fresher', 'tasty', 'mild', 'vintage', 'block', 'baked',
]);
const VARIANT = new Set([
  'chocolate', 'choc', 'strawberry', 'vanilla', 'caramel', 'coffee', 'mocha', 'flavoured', 'flavored', 'iced',
  'honey', 'mango', 'berry', 'berries', 'banana', 'lemon', 'lime', 'mint', 'cookies', 'cookie', 'soy', 'oat',
  'almond', 'coconut', 'macadamia', 'protein', 'kids', 'baby', 'toddler', 'powder', 'powdered', 'condensed',
  'evaporated', 'flavour', 'flavor', 'smoothie', 'shake', 'bread', 'cake', 'muffin', 'muffins', 'chips', 'lolly',
  'lollies', 'biscuit', 'biscuits', 'bar', 'bars', 'yoghurt', 'yogurt', 'custard', 'dessert', 'pudding', 'mix',
  'sauce', 'syrup', 'juice', 'snack', 'snacks', 'cereal', 'spread', 'spreadable', 'frother', 'toy', 'cream',
  'peanut', 'nut', 'nuts', 'cashew', 'hazelnut', 'sausage', 'sausages', 'pork', 'chicken', 'lamb', 'beef',
  'turkey', 'veal', 'fish', 'tuna', 'salmon', 'prawn', 'ham', 'bacon', 'frozen', 'dried', 'marinated',
  'crumbed', 'seasoned', 'garlic', 'herb', 'chilli', 'meal', 'replacement', 'noodle', 'noodles', 'soup',
  'microwave', 'instant', 'cup', 'dip', 'dips', 'guacamole', 'smashed', 'cottage', 'ricotta', 'feta', 'parmesan',
  'mozzarella', 'haloumi', 'halloumi', 'brie', 'camembert', 'blue', 'goat', 'spf', 'brush', 'shampoo', 'soap',
  'wipes', 'candle', 'scented', 'fragrance', 'pet', 'dog', 'cat',
]);
const SYNONYMS = {
  coke: ['coca cola'],
  yoghurt: ['yogurt'],
  yogurt: ['yoghurt'],
  choc: ['chocolate'],
  chocolate: ['choc'],
  lite: ['light'],
  light: ['lite'],
  bbq: ['barbecue'],
  tp: ['toilet tissue', 'toilet paper'],
  mince: ['minced'],
  loo: ['toilet'],
  bread: ['loaf'],
  loaf: ['bread'],
};

function splitWords(text) {
  let s = String(text || '').toLowerCase().replace(/&/g, ' and ').replace(/[’']/g, '');
  s = s.replace(/(\d),(\d{3})/g, '$1$2').replace(/[^a-z0-9.]+/g, ' ');
  return s.split(/\s+/).filter((t) => t && !/^[\d.]+[a-z]{0,3}$/.test(t));
}

export function tokenize(text) {
  return splitWords(text)
    .filter((t) => !STOP.has(t))
    .map(singular);
}

function singular(t) {
  if (t.length <= 3 || t.endsWith('ss')) return t;
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (t.endsWith('oes')) return t.slice(0, -2);
  if (t.endsWith('ches') || t.endsWith('shes')) return t.slice(0, -2);
  if (t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function sameWord(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.startsWith(s) && l.length - s.length <= 2;
}

function stripPhrases(text) {
  let s = ` ${String(text || '').toLowerCase()} `;
  for (const p of NEUTRAL_PHRASES) s = s.split(` ${p} `).join(' ');
  return s;
}

/** Name without the brand prefix, split into the head part and any "in …" description. */
function nameParts(product) {
  let nameText = product.name || '';
  if (product.brand && nameText.toLowerCase().startsWith(product.brand.toLowerCase())) {
    nameText = nameText.slice(product.brand.length);
  }
  const stripped = stripPhrases(nameText);
  return { all: tokenize(stripped), head: tokenize(stripped.split(/\sin\s/)[0]) };
}

function queryMatches(qTokens, tokens) {
  return qTokens.map((q) => {
    const at = findToken(tokens, q);
    if (at >= 0) return { at, span: 1 };
    for (const syn of SYNONYMS[q] || []) {
      const synTokens = tokenize(syn);
      const p = findPhrase(tokens, synTokens);
      if (p >= 0) return { at: p, span: synTokens.length };
    }
    return null;
  });
}

/**
 * Words shared by most of the products that contain every query word. These describe the
 * item itself (e.g. "chocolate biscuit" for Tim Tams) so they shouldn't count against a match.
 */
export function contextTokens(queryName, products) {
  const qTokens = tokenize(queryName);
  const pool = [];
  for (const p of products) {
    const { all } = nameParts(p);
    const hits = queryMatches(qTokens, [...tokenize(p.brand), ...all]);
    if (hits.every(Boolean)) pool.push(new Set(all.filter((t) => !qTokens.includes(t))));
  }
  const ctx = new Set();
  if (pool.length < 5) return ctx;
  const df = new Map();
  for (const set of pool) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  for (const [t, n] of df) if (n / pool.length >= 0.6) ctx.add(t);
  return ctx;
}

/** Relevance of one product for a query name. Returns { score, coverage }. */
export function relevance(queryName, product, context = new Set()) {
  const qTokens = tokenize(queryName);
  if (!qTokens.length) return { score: 0, coverage: 0 };
  const brandTokens = tokenize(product.brand);
  const parts = nameParts(product);
  // Use the head part ("Baked Beans" of "Baked Beans in Tomato Sauce") when it holds the match.
  let nameTokens = parts.head;
  let hits = queryMatches(qTokens, nameTokens);
  if (hits.filter(Boolean).length < queryMatches(qTokens, parts.all).filter(Boolean).length) {
    nameTokens = parts.all;
    hits = queryMatches(qTokens, nameTokens);
  }

  let matched = 0;
  let lastIdx = -1;
  const used = new Set();
  hits.forEach((h, i) => {
    if (h) {
      matched++;
      for (let k = h.at; k < h.at + h.span; k++) used.add(k);
      lastIdx = Math.max(lastIdx, h.at + h.span - 1);
    } else {
      const q = qTokens[i];
      const inBrand = brandTokens.some((b) => sameWord(b, q)) || (SYNONYMS[q] || []).some((syn) => findPhrase(brandTokens, tokenize(syn)) >= 0);
      if (inBrand) matched++;
    }
  });
  const coverage = matched / qTokens.length;
  if (!matched) return { score: 0, coverage: 0 };

  const qSet = new Set(qTokens);
  const ignorable = (t) => qSet.has(t) || context.has(t) || PACKAGING.has(t) || NEUTRAL.has(t);
  // Words after the last matched word mean the query word is only a modifier
  // ("Milk Chocolate Block" is not milk). A match on the brand alone ("Avocado" brand
  // "Zinc SPF Brush") puts the whole name in the tail.
  let tail = 0;
  let tailVariant = 0;
  for (let i = lastIdx + 1; i < nameTokens.length; i++) {
    const t = nameTokens[i];
    if (ignorable(t) || MILD.has(t)) continue;
    if (VARIANT.has(t)) tailVariant++;
    else tail++;
  }
  let variant = 0;
  let mild = 0;
  let extra = 0;
  nameTokens.forEach((t, i) => {
    if (used.has(i) || i > lastIdx || ignorable(t)) return;
    if (VARIANT.has(t)) variant++;
    else if (MILD.has(t)) mild++;
    else extra++;
  });
  // "Macaroni & Cheese", "Pork and Beef Mince": the item is only half of a combination.
  const combo = !/\b(and|&)\b/i.test(queryName) && isCombo(product.name, qTokens) ? 0.4 : 0;
  const penalty =
    Math.min(0.6 * tailVariant + 0.25 * tail, 0.9) + 0.5 * variant + 0.08 * mild + 0.1 * Math.min(extra, 4) + combo;
  const score = coverage * coverage * Math.max(0.05, 1 - penalty);
  return { score, coverage };
}

function isCombo(name, qTokens) {
  const words = splitWords(String(name || '').replace(/[&+]/g, ' and ')).map(singular);
  return words.some((w, i) => {
    if (w !== 'and') return false;
    const near = [words[i - 1], words[i + 1], words[i + 2]].filter(Boolean);
    return qTokens.some((q) => near.some((n) => sameWord(n, q)));
  });
}

function findToken(tokens, q) {
  let found = -1;
  tokens.forEach((t, i) => {
    if (sameWord(t, q)) found = i; // keep the last occurrence (closest to the head noun)
  });
  return found;
}

function findPhrase(tokens, phrase) {
  outer: for (let i = tokens.length - phrase.length; i >= 0; i--) {
    for (let j = 0; j < phrase.length; j++) if (!sameWord(tokens[i + j], phrase[j])) continue outer;
    return i;
  }
  return -1;
}

/** Annotate raw store products with size + relevance. */
export function scoreProducts(queryName, products, context = new Set()) {
  const list = (products || []).filter((p) => p && p.price > 0);
  const n = list.length || 1;
  const scored = list.map((p, rank) => {
    const r = relevance(queryName, p, context);
    const size = productSize({ size: p.size, name: p.name, impliedBase: impliedAmount(p.price, p.unitPrice, p.unitMeasure) });
    return { product: p, size, coverage: r.coverage, text: r.score, score: r.score + 0.1 * (1 - rank / n) };
  });
  // Category consensus among the good matches.
  const best = Math.max(0, ...scored.map((s) => s.text));
  const weights = {};
  for (const s of scored) {
    const c = s.product.category;
    if (c && best > 0 && s.text >= best * 0.8) weights[c] = (weights[c] || 0) + s.text;
  }
  const top = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
  if (top && scored.filter((s) => s.product.category === top[0] && s.text >= best * 0.8).length >= 2) {
    for (const s of scored) {
      if (!s.product.category || s.text <= 0) continue;
      s.score += s.product.category === top[0] ? 0.08 : -0.04;
    }
  }
  return scored;
}

/** The sensible subset: best word coverage, score close to the best. */
export function sensible(scored) {
  const avail = scored.filter((s) => s.product.available !== false && s.text > 0);
  if (!avail.length) return [];
  const maxCov = Math.max(...avail.map((s) => s.coverage));
  const pool = avail.filter((s) => s.coverage === maxCov);
  const best = Math.max(...pool.map((s) => s.score));
  return pool.filter((s) => s.score >= best * SENSIBLE_RATIO);
}

/** How many packs of this size meet the target, or null if it doesn't fit. */
export function fitPacks(size, target) {
  if (!target) return { packs: 1, ratio: 1 };
  const amount = size?.dims?.[target.dim];
  if (!(amount > 0)) return null;
  const ratio = amount / target.amount;
  if (ratio >= 1 - SIZE_TOLERANCE && ratio <= 1 + SIZE_TOLERANCE) return { packs: 1, ratio };
  if (ratio < 1 - SIZE_TOLERANCE) {
    const n = Math.round(1 / ratio);
    const slack = size.approx ? 0.2 : 0.05;
    if (n >= 2 && n <= MAX_PACKS && Math.abs(n * ratio - 1) <= slack) return { packs: n, ratio: n * ratio };
  }
  return null;
}

/** Price per base unit (ml, g or item) — what "cheapest" means. */
function unitCost(s, dim) {
  const amount = dim ? s.size.dims[dim] : s.size.amount;
  if (amount > 0) return s.product.price / amount;
  if (s.product.unitPrice > 0) return s.product.unitMeasure === 'each' ? s.product.unitPrice : s.product.unitPrice / 1000;
  return s.product.price;
}

/** Choose a target size when the user didn't give one: the size most stores offer among their best matches. */
export function inferTarget(candidatesByStore) {
  const stores = Object.values(candidatesByStore).map((list) => list.slice(0, 8));
  let best = null;
  for (const dim of ['volume', 'mass', 'count']) {
    for (const list of stores) {
      for (const c of list) {
        const a = c.size.dims[dim];
        if (!(a > 0)) continue;
        let coverage = 0;
        let weight = 0;
        for (const other of stores) {
          const fits = other.filter((o) => {
            const b = o.size.dims[dim];
            return b > 0 && Math.abs(b / a - 1) <= SIZE_TOLERANCE;
          });
          if (fits.length) {
            coverage++;
            weight += Math.max(...fits.map((f) => f.score));
          }
        }
        if (!best || coverage > best.coverage || (coverage === best.coverage && weight > best.weight + 1e-9)) {
          best = { coverage, weight, dim, amount: a };
        }
      }
    }
  }
  return best ? { dim: best.dim, amount: best.amount, inferred: true, label: sizeLabel(best.dim, best.amount) } : null;
}

function sizeLabel(dim, amount) {
  return dim === 'count' ? `${amount} pack` : formatAmount(dim, amount);
}

/**
 * Products sold "each" with no weight (Woolworths loose fruit): estimate the piece weight
 * from other stores' "approx. 170g" pieces so they can be compared by weight.
 */
function estimatePieces(allScored) {
  const pieces = allScored
    .filter((s) => s.text > 0 && s.size.approx && s.size.dims.mass > 0 && s.size.dims.mass <= 1000)
    .map((s) => s.size.dims.mass)
    .sort((a, b) => a - b);
  if (!pieces.length) return;
  const pieceMass = pieces[Math.floor(pieces.length / 2)];
  for (const s of allScored) {
    if (s.size.perPiece && !(s.size.dims.mass > 0)) {
      s.size = { ...s.size, approx: true, estimated: true, dims: { ...s.size.dims, mass: pieceMass } };
    }
  }
}

/**
 * Match one item at every store.
 * @param item      parsed item ({ name, qty, size })
 * @param results   { [storeId]: Product[] }
 * @param memory    { [storeId]: { id, name } | { none: true } } remembered choices
 * @returns {{ target, picks: {[store]: Pick|null}, suggestions: {[store]: Pick}, options: {[store]: Option[]} }}
 */
export function matchItem(item, results, memory = {}) {
  const stores = Object.keys(results || {}).filter((s) => Array.isArray(results[s]));
  const context = contextTokens(item.name, stores.flatMap((s) => results[s]));
  const scoredByStore = {};
  const candidatesByStore = {};
  for (const store of stores) scoredByStore[store] = scoreProducts(item.name, results[store], context);
  estimatePieces(Object.values(scoredByStore).flat());
  for (const store of stores) candidatesByStore[store] = sensible(scoredByStore[store]);

  const target = item.size
    ? { dim: item.size.dim, amount: item.size.amount, inferred: false, label: item.size.label || sizeLabel(item.size.dim, item.size.amount) }
    : inferTarget(candidatesByStore);

  const qty = item.qty || 1;
  const makePick = (s, fit, dim, extra = {}) => {
    const cost = round2(s.product.price * fit.packs * qty);
    return {
      product: s.product,
      packs: fit.packs,
      cost,
      // What it would cost at the size asked for; used to compare stores fairly when a
      // store only has a different pack size. Equal to cost for picks within the size window.
      compareCost: extra.ratio ? round2(cost / extra.ratio) : cost,
      unitCost: unitCost(s, dim),
      estimated: !!s.size.estimated,
      score: s.score,
      ...extra,
    };
  };
  const cheapest = (list, dim) => list.sort((a, b) => cmp(unitCost(a.s, dim), unitCost(b.s, dim)) || b.s.score - a.s.score)[0];

  const picks = {};
  const suggestions = {};
  const pending = [];
  for (const store of stores) {
    const mem = memory[store];
    if (mem?.none) {
      picks[store] = null;
      continue;
    }
    if (mem?.id) {
      const s = scoredByStore[store].find((x) => String(x.product.id) === String(mem.id));
      if (s) {
        picks[store] = makePick(s, fitPacks(s.size, target) || { packs: 1 }, target?.dim, { chosen: true });
        continue;
      }
    }
    const fits = candidatesByStore[store].map((s) => ({ s, fit: fitPacks(s.size, target) })).filter((x) => x.fit);
    if (fits.length) {
      const best = cheapest(fits, target?.dim);
      picks[store] = makePick(best.s, best.fit, target?.dim, mem?.id ? { lostChoice: mem } : {});
    } else {
      pending.push(store);
    }
  }

  // Second pass: stores with nothing in the size window.
  for (const store of pending) {
    const cands = candidatesByStore[store];
    const mem = memory[store];
    const lost = mem?.id ? { lostChoice: mem } : {};
    picks[store] = null;
    if (!cands.length) continue;
    // e.g. "12 eggs" but this store only lists grams: borrow the size other stores matched.
    const alt = altTarget(target, picks);
    if (alt) {
      const fits = cands.map((s) => ({ s, fit: fitPacks(s.size, alt) })).filter((x) => x.fit);
      if (fits.length) {
        const best = cheapest(fits, alt.dim);
        picks[store] = makePick(best.s, best.fit, alt.dim, lost);
        continue;
      }
    }
    const sized = cands.filter((s) => s.size.dims[target.dim] > 0);
    if (sized.length) {
      const dist = (s) => Math.abs(Math.log(s.size.dims[target.dim] / target.amount));
      sized.sort((a, b) => cmp(dist(a), dist(b)) || cmp(a.product.price, b.product.price));
      const s = sized[0];
      const ratio = s.size.dims[target.dim] / target.amount;
      const pick = makePick(s, { packs: 1 }, target.dim, { sizeNote: ratio > 1 ? 'bigger size' : 'smaller size', ratio, ...lost });
      if (ratio >= CLOSEST_MIN && ratio <= CLOSEST_MAX) picks[store] = pick;
      else suggestions[store] = pick;
    } else if (cands.every((s) => s.size.dim == null)) {
      // The store gives no sizes at all: the cheapest sensible match is the best we can do.
      const s = [...cands].sort((a, b) => cmp(a.product.price, b.product.price))[0];
      picks[store] = makePick(s, { packs: 1 }, null, { sizeNote: 'size unknown', ...lost });
    } else {
      suggestions[store] = makePick(cands[0], { packs: 1 }, null, { sizeNote: 'different size', ...lost });
    }
  }

  // Ordered options for the product picker.
  const options = {};
  for (const store of stores) {
    const sens = new Set(candidatesByStore[store]);
    options[store] = scoredByStore[store]
      .filter((s) => s.text > 0)
      .map((s) => {
        const fit = fitPacks(s.size, target);
        const packs = fit ? fit.packs : 1;
        return {
          product: s.product,
          sensible: sens.has(s),
          fits: !!fit,
          packs,
          cost: round2(s.product.price * packs * qty),
          unitCost: unitCost(s, fit ? target?.dim : null),
          score: s.score,
        };
      })
      .sort(
        (a, b) =>
          Number(b.sensible && b.fits) - Number(a.sensible && a.fits) ||
          Number(b.sensible) - Number(a.sensible) ||
          (a.sensible && a.fits ? cmp(a.unitCost, b.unitCost) : 0) ||
          b.score - a.score,
      );
  }
  return { target, picks, suggestions, options };
}

function altTarget(target, picks) {
  if (!target) return null;
  const others = Object.values(picks).filter(Boolean);
  for (const dim of ['mass', 'volume', 'count']) {
    if (dim === target.dim) continue;
    const vals = others
      .map((p) => (productSize({ size: p.product.size, name: p.product.name }).dims[dim] || 0) * p.packs)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    if (vals.length) return { dim, amount: vals[Math.floor(vals.length / 2)] };
  }
  return null;
}

function cmp(a, b) {
  const d = a - b;
  return Math.abs(d) < 1e-9 ? 0 : d;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

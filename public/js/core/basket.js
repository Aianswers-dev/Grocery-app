// Basket totals per store, the best split across stores, and the savings it gives.
import { round2 } from './match.js';

// A pick's cost is what you pay; compareCost (when present) is that price scaled to the
// size asked for, so a smaller pack doesn't "win" just by being smaller.
const cmpCost = (pick) => pick.compareCost ?? pick.cost;
// Prices are in whole cents, so anything closer than half a cent is a tie.
const EPS = 0.004;

/** Tie-break order: the preferred store first, then display order. */
function ranker(stores, prefer) {
  return (s) => (s === prefer ? -1 : stores.indexOf(s));
}

/**
 * @param rows    [{ picks: { [storeId]: { cost, compareCost? } | null } }]  one per list item
 * @param stores  storeIds to consider (in display order)
 * @param prefer  storeId that wins when prices are equal
 */
export function summarise(rows, stores, { prefer = null } = {}) {
  const rank = ranker(stores, prefer);
  const perStore = {};
  for (const s of stores) perStore[s] = { total: 0, found: 0, missing: 0 };

  const split = { total: 0, byStore: {}, found: 0, missing: 0, assignment: [] };
  for (const s of stores) split.byStore[s] = { total: 0, items: [] };

  rows.forEach((row, i) => {
    let bestStore = null;
    let bestCmp = Infinity;
    for (const s of stores) {
      const pick = row.picks?.[s];
      if (pick && pick.cost >= 0) {
        perStore[s].total += pick.cost;
        perStore[s].found++;
        const c = cmpCost(pick);
        if (c < bestCmp - EPS || (Math.abs(c - bestCmp) <= EPS && rank(s) < rank(bestStore))) {
          bestCmp = c;
          bestStore = s;
        }
      } else {
        perStore[s].missing++;
      }
    }
    split.assignment[i] = bestStore;
    if (bestStore) {
      const cost = row.picks[bestStore].cost;
      split.total += cost;
      split.found++;
      split.byStore[bestStore].total += cost;
      split.byStore[bestStore].items.push(i);
    } else {
      split.missing++;
    }
  });

  for (const s of stores) {
    perStore[s].total = round2(perStore[s].total);
    split.byStore[s].total = round2(split.byStore[s].total);
  }
  split.total = round2(split.total);

  // Cheapest single store: most items found, then lowest total, then the preferred store.
  const ranked = stores
    .filter((s) => perStore[s].found > 0)
    .sort((a, b) => {
      const d = perStore[a].total - perStore[b].total;
      return perStore[b].found - perStore[a].found || (Math.abs(d) > EPS ? d : rank(a) - rank(b));
    });
  const cheapestStore = ranked[0] || null;

  // Savings vs that store, over the items it actually has (like-for-like).
  let savings = 0;
  if (cheapestStore) {
    rows.forEach((row, i) => {
      const own = row.picks?.[cheapestStore];
      const best = split.assignment[i] && row.picks[split.assignment[i]];
      if (own && best) savings += cmpCost(own) - cmpCost(best);
    });
  }

  return {
    perStore,
    split,
    cheapestStore,
    savings: round2(Math.max(0, savings)),
    bestPair: bestCombo(rows, stores, 2, { prefer }),
    storesUsed: stores.filter((s) => split.byStore[s].items.length > 0),
  };
}

/** Best combination of exactly `size` stores (fewest missing items, then cheapest, then the preferred store). */
export function bestCombo(rows, stores, size, { prefer = null } = {}) {
  if (stores.length <= size) return null;
  const rank = ranker(stores, prefer);
  let best = null;
  for (const combo of combinations(stores, size)) {
    let total = 0;
    let missing = 0;
    for (const row of rows) {
      const options = combo.filter((s) => row.picks?.[s]?.cost >= 0);
      if (!options.length) {
        missing++;
        continue;
      }
      const pickStore = options.reduce((a, b) => {
        const d = cmpCost(row.picks[b]) - cmpCost(row.picks[a]);
        return d < -EPS || (Math.abs(d) <= EPS && rank(b) < rank(a)) ? b : a;
      });
      total += row.picks[pickStore].cost;
    }
    const hasPref = prefer != null && combo.includes(prefer);
    if (
      !best ||
      missing < best.missing ||
      (missing === best.missing && total < best.total - EPS) ||
      (missing === best.missing && Math.abs(total - best.total) <= EPS && hasPref && !best.hasPref)
    ) {
      best = { stores: combo, total: round2(total), missing, hasPref };
    }
  }
  if (best) delete best.hasPref;
  return best;
}

function* combinations(list, k, start = 0, acc = []) {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = start; i < list.length; i++) {
    acc.push(list[i]);
    yield* combinations(list, k, i + 1, acc);
    acc.pop();
  }
}

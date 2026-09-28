// Basket totals per store, the best split across stores, and the savings it gives.
import { round2 } from './match.js';

/**
 * @param rows    [{ picks: { [storeId]: { cost } | null } }]  one per list item
 * @param stores  storeIds to consider (in display order)
 */
export function summarise(rows, stores) {
  const perStore = {};
  for (const s of stores) perStore[s] = { total: 0, found: 0, missing: 0 };

  const split = { total: 0, byStore: {}, found: 0, missing: 0, assignment: [] };
  for (const s of stores) split.byStore[s] = { total: 0, items: [] };

  rows.forEach((row, i) => {
    let bestStore = null;
    let bestCost = Infinity;
    for (const s of stores) {
      const pick = row.picks?.[s];
      if (pick && pick.cost >= 0) {
        perStore[s].total += pick.cost;
        perStore[s].found++;
        if (pick.cost < bestCost - 1e-9) {
          bestCost = pick.cost;
          bestStore = s;
        }
      } else {
        perStore[s].missing++;
      }
    }
    split.assignment[i] = bestStore;
    if (bestStore) {
      split.total += bestCost;
      split.found++;
      split.byStore[bestStore].total += bestCost;
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

  // Cheapest single store: most items found, then lowest total.
  const ranked = stores
    .filter((s) => perStore[s].found > 0)
    .sort((a, b) => perStore[b].found - perStore[a].found || perStore[a].total - perStore[b].total);
  const cheapestStore = ranked[0] || null;

  // Savings vs that store, over the items it actually has (like-for-like).
  let savings = 0;
  if (cheapestStore) {
    rows.forEach((row, i) => {
      const own = row.picks?.[cheapestStore];
      const best = split.assignment[i] && row.picks[split.assignment[i]];
      if (own && best) savings += own.cost - best.cost;
    });
  }

  return {
    perStore,
    split,
    cheapestStore,
    savings: round2(Math.max(0, savings)),
    bestPair: bestCombo(rows, stores, 2),
    storesUsed: stores.filter((s) => split.byStore[s].items.length > 0),
  };
}

/** Best combination of exactly `size` stores (fewest missing items, then cheapest). */
export function bestCombo(rows, stores, size) {
  if (stores.length <= size) return null;
  let best = null;
  for (const combo of combinations(stores, size)) {
    let total = 0;
    let missing = 0;
    for (const row of rows) {
      const costs = combo.map((s) => row.picks?.[s]?.cost).filter((c) => c >= 0);
      if (costs.length) total += Math.min(...costs);
      else missing++;
    }
    if (!best || missing < best.missing || (missing === best.missing && total < best.total - 1e-9)) {
      best = { stores: combo, total: round2(total), missing };
    }
  }
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

// Matching tests against real search results saved from Woolworths, Coles and ALDI
// (test/fixtures/live, captured with the store plug-ins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseItem } from '../public/js/core/query.js';
import { matchItem, relevance } from '../public/js/core/match.js';

const STORES = ['woolworths', 'coles', 'aldi'];

function load(name) {
  const fx = JSON.parse(readFileSync(new URL(`./fixtures/live/${name}.json`, import.meta.url)));
  return Object.fromEntries(STORES.map((s) => [s, fx[s]]));
}

function run(text, fixture, memory) {
  const item = parseItem(text);
  return matchItem(item, load(fixture || item.name.replace(/\s+/g, '-')), memory);
}

function names(m) {
  return Object.fromEntries(STORES.map((s) => [s, m.picks[s]?.product.name || null]));
}

test('milk 2L picks plain 2L milk everywhere', () => {
  const m = run('milk 2L');
  for (const s of STORES) {
    const p = m.picks[s];
    assert.ok(p, `${s} has a pick`);
    assert.match(p.product.name, /milk/i);
    assert.doesNotMatch(p.product.name, /choc|coffee|oat|soy|almond|protein|flavoured/i);
    assert.match(p.product.size, /2\s*L/i);
    assert.equal(p.packs, 1);
  }
});

test('quantity multiplies the cost', () => {
  const one = run('milk 2L');
  const two = run('2 x milk 2L');
  for (const s of STORES) assert.equal(two.picks[s].cost, Math.round(one.picks[s].cost * 200) / 100);
});

test('no size given: a common size is chosen so stores are comparable', () => {
  const m = run('milk');
  assert.equal(m.target.inferred, true);
  assert.equal(m.target.dim, 'volume');
  const sizes = STORES.map((s) => m.picks[s].product.size.replace(/\s/g, '').toUpperCase());
  assert.equal(new Set(sizes).size, 1, `same size everywhere: ${sizes}`);
});

test('butter is not peanut butter', () => {
  const m = run('butter');
  for (const s of STORES) assert.doesNotMatch(m.picks[s].product.name, /peanut|spread/i, s);
});

test('beef mince is not sausage mince or pork & beef', () => {
  const m = run('beef mince 500g');
  for (const s of STORES) assert.doesNotMatch(m.picks[s].product.name, /sausage|pork/i, s);
});

test('bananas 1kg buys loose bananas by the piece', () => {
  const m = run('bananas 1kg', 'bananas');
  for (const s of STORES) {
    const p = m.picks[s];
    assert.doesNotMatch(p.product.name, /frozen|chips|bread|muffin/i, s);
    assert.ok(p.packs >= 5 && p.packs <= 7, `${s} buys ~6 pieces, got ${p.packs}`);
  }
  // Woolworths sells bananas "each" with no weight: the weight is estimated from other stores
  assert.equal(m.picks.woolworths.estimated, true);
});

test('avocado is fruit, not dip or a sunscreen brush from the brand "Avocado"', () => {
  const m = run('avocado');
  for (const s of STORES) assert.doesNotMatch(m.picks[s].product.name, /dip|brush|smashed|guacamole/i, s);
});

test('cheese picks everyday cheese, not cottage cheese or mac & cheese', () => {
  const m = run('cheese');
  for (const s of STORES) assert.doesNotMatch(m.picks[s].product.name, /cottage|macaroni|cream cheese/i, s);
});

test('bread matches a "White Sandwich Loaf"', () => {
  const m = run('bread');
  for (const s of STORES) assert.doesNotMatch(m.picks[s].product.name, /garlic|wrap|roll|bun/i, s);
  assert.ok(m.picks.coles.product.price <= 3, 'Coles picks a cheap everyday loaf');
});

test('rice without a size is not microwave rice', () => {
  const m = run('rice');
  for (const s of STORES) assert.doesNotMatch(m.picks[s].product.name, /microwave|cup/i, s);
});

test('Tim Tams: shared words like "chocolate biscuits" are not penalised', () => {
  const m = run('tim tams');
  for (const s of STORES) assert.match(m.picks[s].product.name, /tim tam/i, s);
  assert.doesNotMatch(m.picks.woolworths.product.name, /gluten free/i);
});

test('coke 30 pack: a store without one gets a flagged closest size', () => {
  const m = run('coke 30 pack', 'coke');
  assert.match(m.picks.woolworths.product.size, /30/);
  assert.match(m.picks.coles.product.size, /30/);
  const aldi = m.picks.aldi || m.suggestions.aldi;
  assert.ok(aldi, 'ALDI shows something');
  assert.ok(aldi.sizeNote, 'and flags the size difference');
});

test('eggs 12 borrows the weight for stores that only list grams', () => {
  const m = run('eggs 12', 'eggs');
  for (const s of STORES) {
    assert.ok(m.picks[s], `${s} has eggs`);
    assert.match(m.picks[s].product.name, /egg/i);
    assert.doesNotMatch(m.picks[s].product.name, /noodle|rice|pasta|kinder/i);
  }
});

test('a remembered choice wins over the automatic pick', () => {
  const auto = run('milk 2L');
  const other = auto.options.coles.find((o) => o.product.id !== auto.picks.coles.product.id);
  const m = run('milk 2L', 'milk', { coles: { id: other.product.id, name: other.product.name } });
  assert.equal(m.picks.coles.product.id, other.product.id);
  assert.equal(m.picks.coles.chosen, true);
  assert.equal(m.picks.woolworths.product.id, auto.picks.woolworths.product.id);
});

test('"not at this store" removes the store for the item', () => {
  const m = run('milk 2L', 'milk', { aldi: { none: true } });
  assert.equal(m.picks.aldi, null);
});

test('a remembered product missing from results falls back and says so', () => {
  const m = run('milk 2L', 'milk', { coles: { id: 'does-not-exist', name: 'Old Milk' } });
  assert.ok(m.picks.coles);
  assert.equal(m.picks.coles.lostChoice.name, 'Old Milk');
});

test('options list sensible, right-sized products first, cheapest first', () => {
  const m = run('milk 2L');
  const top = m.options.aldi.slice(0, 3);
  assert.ok(top.every((o) => o.sensible && o.fits));
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].unitCost <= top[i].unitCost + 1e-9);
});

test('relevance: the query word must be the head noun', () => {
  const plain = relevance('milk', { name: 'Farmdale Full Cream Milk 2L', brand: 'Farmdale' }).score;
  const choc = relevance('milk', { name: 'Choceur Milk Chocolate Block 200g', brand: 'Choceur' }).score;
  const flavoured = relevance('milk', { name: 'Oak Chocolate Milk 600ml', brand: 'Oak' }).score;
  assert.ok(plain > flavoured && flavoured > choc, `${plain} > ${flavoured} > ${choc}`);
});

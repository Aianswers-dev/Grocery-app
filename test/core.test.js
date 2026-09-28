import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSizeText, productSize, normaliseUnitPrice, parseUnitString, splitMeasure } from '../public/js/core/units.js';
import { parseItem, itemKey } from '../public/js/core/query.js';
import { summarise, bestCombo } from '../public/js/core/basket.js';

test('parseSizeText handles common pack formats', () => {
  assert.equal(parseSizeText('2L').volume, 2000);
  assert.equal(parseSizeText('600mL').volume, 600);
  assert.equal(parseSizeText('1,500 g').mass, 1500);
  assert.equal(parseSizeText('0.6 L').volume, 600);
  const multi = parseSizeText('30 x 375mL');
  assert.equal(multi.volume, 11250);
  assert.equal(multi.count, 30);
  assert.equal(parseSizeText('12 Pack').count, 12);
  assert.equal(parseSizeText('eggs dozen').count, 12);
  const loose = parseSizeText('approx. 0.18 kg per piece');
  assert.equal(loose.mass, 180);
  assert.equal(loose.approx, true);
  // "a2 Light Milk" is not 2 litres
  assert.equal(parseSizeText('a2 Light Milk').volume, undefined);
});

test('productSize combines size field and name', () => {
  // Coles eggs: count in the name, weight in the size field
  const eggs = productSize({ size: '700g', name: 'Coles Free Range Eggs 12 Pack' });
  assert.equal(eggs.dim, 'mass');
  assert.equal(eggs.dims.mass, 700);
  assert.equal(eggs.dims.count, 12);
  // Coles cans: per-can volume in the name, count in the size field
  const cans = productSize({ size: '30 Pack', name: 'Coca-Cola Classic Multipack Cans 375ml', impliedBase: { dim: 'volume', amount: 11268 } });
  assert.equal(cans.dims.volume, 11250);
  assert.equal(cans.dims.count, 30);
  // Woolworths loose fruit
  const banana = productSize({ size: 'each', name: 'Cavendish Bananas each' });
  assert.equal(banana.perPiece, true);
  assert.equal(banana.dims.count, 1);
});

test('unit prices normalise to per L / per kg / each', () => {
  assert.deepEqual(normaliseUnitPrice(3, 100, 'g'), { unitPrice: 30, unitMeasure: 'kg' });
  assert.deepEqual(normaliseUnitPrice(1.65, 1, 'l'), { unitPrice: 1.65, unitMeasure: 'L' });
  assert.deepEqual(parseUnitString('$2.38 per 100 g'), { unitPrice: 23.8, unitMeasure: 'kg' });
  assert.deepEqual(parseUnitString('$1.65/ 1L'), { unitPrice: 1.65, unitMeasure: 'L' });
  assert.deepEqual(parseUnitString('$0.86 / 1EA'), { unitPrice: 0.86, unitMeasure: 'each' });
  assert.deepEqual(splitMeasure('100G'), [100, 'G']);
});

test('parseItem reads quantity, name and size', () => {
  const a = parseItem('milk 2L');
  assert.equal(a.name, 'milk');
  assert.equal(a.qty, 1);
  assert.equal(a.size.dim, 'volume');
  assert.equal(a.size.amount, 2000);

  const b = parseItem('2 x milk 2L');
  assert.equal(b.qty, 2);
  assert.equal(b.name, 'milk');

  const c = parseItem('6 bananas');
  assert.equal(c.qty, 6);
  assert.equal(c.name, 'bananas');
  assert.equal(c.size, null);

  const d = parseItem('eggs 12');
  assert.equal(d.name, 'eggs');
  assert.equal(d.size.dim, 'count');
  assert.equal(d.size.amount, 12);

  const e = parseItem('coke 24x375ml');
  assert.equal(e.name, 'coke');
  assert.equal(e.size.amount, 9000);
  assert.equal(e.size.count, 24);

  assert.equal(parseItem('milk x3').qty, 3);
  assert.equal(parseItem('beef mince 1kg').size.amount, 1000);
  assert.equal(parseItem('eggs dozen').size.amount, 12);
});

test('itemKey ignores word order, case and quantity', () => {
  assert.equal(parseItem('Milk 2L').key, parseItem('2 x milk 2l').key);
  assert.equal(itemKey('Beef Mince', null), itemKey('mince beef', null));
  assert.notEqual(parseItem('milk 2L').key, parseItem('milk 3L').key);
});

test('summarise computes store totals, best split and savings', () => {
  const rows = [
    { picks: { w: { cost: 3.4 }, c: { cost: 3.4 }, a: { cost: 3.39 } } },
    { picks: { w: { cost: 7 }, c: { cost: 6 }, a: null } },
    { picks: { w: { cost: 2.8 }, c: { cost: 2.5 }, a: { cost: 2.39 } } },
  ];
  const s = summarise(rows, ['w', 'c', 'a']);
  assert.equal(s.perStore.w.total, 13.2);
  assert.equal(s.perStore.c.total, 11.9);
  assert.equal(s.perStore.a.total, 5.78);
  assert.equal(s.perStore.a.missing, 1);
  assert.equal(s.split.total, 11.78);
  assert.deepEqual(s.split.assignment, ['a', 'c', 'a']);
  // Cheapest complete store is Coles; the split saves 0.01 + 0.11 vs Coles.
  assert.equal(s.cheapestStore, 'c');
  assert.equal(s.savings, 0.12);
  assert.deepEqual(s.bestPair.stores, ['c', 'a']);
  assert.equal(s.bestPair.total, 11.78);
});

test('bestCombo prefers covering every item', () => {
  const rows = [{ picks: { x: { cost: 1 }, y: null, z: { cost: 5 } } }, { picks: { x: null, y: { cost: 1 }, z: { cost: 5 } } }];
  const pair = bestCombo(rows, ['x', 'y', 'z'], 2);
  assert.deepEqual(pair.stores, ['x', 'y']);
  assert.equal(pair.missing, 0);
  assert.equal(pair.total, 2);
});

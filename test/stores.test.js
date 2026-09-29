// Store plug-in parsing tests against real (trimmed) API responses in test/fixtures,
// plus end-to-end Worker tests with fetch() stubbed out.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normaliseColesProduct } from '../src/stores/coles.js';
import { normaliseAldiProduct } from '../src/stores/aldi.js';
import { normaliseWoolworthsProduct, extractWoolworthsProducts } from '../src/stores/woolworths.js';
import { STORES, describeStores } from '../src/stores/index.js';
import worker from '../src/worker.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function checkProduct(p) {
  assert.ok(p.id, 'id');
  assert.ok(p.name, 'name');
  assert.ok(p.price > 0, `price for ${p.name}`);
  assert.equal(typeof p.available, 'boolean');
}

test('every plug-in follows the contract', () => {
  const ids = new Set();
  for (const s of STORES) {
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(s.id), 'unique id');
    ids.add(s.id);
    assert.ok(s.name && s.color);
    assert.equal(typeof s.search, 'function');
  }
  assert.deepEqual(describeStores().map((s) => s.id), ['woolworths', 'coles', 'aldi']);
});

test('Coles products normalise', () => {
  const raw = fixture('coles-raw.json');
  const all = raw.results.filter((r) => r._type === 'PRODUCT').map(normaliseColesProduct);
  // Out-of-stock items come back without a price; the plug-in drops them.
  assert.ok(all.some((p) => p.price == null));
  const products = all.filter((p) => p.price != null);
  products.forEach(checkProduct);
  const milk = products.find((p) => p.id === '8150288');
  assert.equal(milk.name, 'Coles Full Cream Milk');
  assert.equal(milk.size, '3L');
  assert.equal(milk.price, 4.95);
  assert.equal(milk.unitPrice, 1.65);
  assert.equal(milk.unitMeasure, 'L');
  assert.equal(milk.category, 'Milk');
  assert.equal(milk.url, 'https://www.coles.com.au/product/coles-full-cream-milk-3l-8150288');
  assert.match(milk.image, /^https:\/\/cdn\.productimages\.coles\.com\.au\/productimages\/8\/8150288\.jpg$/);
  assert.ok(products.some((p) => p.promo === 'Special'), 'specials are flagged');
});

test('ALDI products normalise, including loose produce priced per piece', () => {
  const raw = fixture('aldi-raw.json');
  const products = raw.data.map(normaliseAldiProduct);
  products.forEach(checkProduct);
  const light = products.find((p) => /Light Milk 2L/.test(p.name));
  assert.equal(light.name, 'Farmdale Light Milk 2L');
  assert.equal(light.price, 3.39);
  assert.equal(light.unitPrice, 1.7);
  assert.equal(light.unitMeasure, 'L');
  assert.equal(light.url, 'https://www.aldi.com.au/product/farmdale-light-milk-2l-000000000000398691');
  const banana = products.find((p) => /Bananas/.test(p.name));
  assert.equal(banana.price, 0.81, 'price per piece, not per kg');
  assert.equal(banana.unitPrice, 4.49);
  assert.equal(banana.unitMeasure, 'kg');
});

test('Woolworths products normalise', () => {
  const raw = fixture('woolworths-raw.json');
  const products = extractWoolworthsProducts(raw).map(normaliseWoolworthsProduct).filter((p) => p.price != null);
  products.forEach(checkProduct);
  const milk = products.find((p) => p.id === '888137');
  assert.equal(milk.name, 'Woolworths Full Cream Milk 2L');
  assert.equal(milk.size, '2L');
  assert.equal(milk.price, 3.4);
  assert.equal(milk.unitPrice, 1.7);
  assert.equal(milk.unitMeasure, 'L');
  assert.equal(milk.category, 'Full Cream Milk');
  assert.equal(milk.url, 'https://www.woolworths.com.au/shop/productdetails/888137/woolworths-full-cream-milk');
  const banana = products.find((p) => p.id === '133211');
  assert.equal(banana.size, 'each');
  assert.equal(banana.unitMeasure, 'each');
  assert.ok(products.some((p) => p.wasPrice && p.promo), 'specials carry the was-price');
});

// ---- Worker, with the network stubbed ----

const realFetch = globalThis.fetch;
const env = { APP_PASSCODE: 'secret-123', ASSETS: { fetch: async () => new Response('<html>app</html>') } };
let calls;

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === 'https://www.coles.com.au/') {
      return new Response('<script id="__NEXT_DATA__">{"BFF_API_SUBSCRIPTION_KEY":"0123456789abcdef0123456789abcdef"}</script>', {
        headers: { 'set-cookie': 'visitor=abc; Path=/' },
      });
    }
    if (u.startsWith('https://www.coles.com.au/api/bff/products/search')) {
      return new Response(JSON.stringify(fixture('coles-raw.json')), { headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://asl.api.aldi.com.au/')) {
      return new Response('<HTML><TITLE>Access Denied</TITLE></HTML>', { status: 403 });
    }
    return new Response('not stubbed', { status: 500 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (path, headers = {}, e = env) => worker.fetch(new Request(`https://app.test${path}`, { headers }), e, { waitUntil() {} });

test('worker: store list is public, everything else needs the passcode', async () => {
  const stores = await (await call('/api/stores')).json();
  assert.deepEqual(stores.stores.map((s) => s.id), ['woolworths', 'coles', 'aldi']);
  assert.equal((await call('/api/search?store=coles&q=milk')).status, 401);
  assert.equal((await call('/api/search?store=coles&q=milk', { 'x-passcode': 'nope' })).status, 401);
  assert.equal((await call('/api/auth', { 'x-passcode': 'secret-123' })).status, 200);
});

test('worker: refuses to run without APP_PASSCODE set', async () => {
  const res = await call('/api/auth', { 'x-passcode': 'x' }, { ASSETS: env.ASSETS });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'passcode-not-set');
});

test('worker: searches a store through its plug-in, with the location', async () => {
  const res = await call('/api/search?store=coles&q=milk%20search-test&loc=4508', { 'x-passcode': 'secret-123' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.store, 'coles');
  assert.ok(body.products.length >= 8);
  const search = calls.find((c) => c.url.includes('/api/bff/products/search'));
  assert.match(search.url, /storeId=4508/);
  assert.equal(search.init.headers['ocp-apim-subscription-key'], '0123456789abcdef0123456789abcdef');
});

test('worker: a blocked store reports a clear error', async () => {
  const res = await call('/api/search?store=aldi&q=milk-blocked', { 'x-passcode': 'secret-123' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /ALDI refused/);
});

test('worker: status checks every store', async () => {
  const body = await (await call('/api/status?q=milk-status', { 'x-passcode': 'secret-123' })).json();
  const byStore = Object.fromEntries(body.results.map((r) => [r.store, r]));
  assert.equal(byStore.coles.ok, true);
  assert.equal(byStore.aldi.ok, false);
  assert.equal(byStore.aldi.blocked, true);
  assert.equal(byStore.woolworths.ok, false);
});

test('worker: other paths are served from static assets', async () => {
  const res = await call('/');
  assert.equal(await res.text(), '<html>app</html>');
});

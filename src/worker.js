// Cloudflare Worker: serves the PWA (static assets in /public) and a small API that
// fetches supermarket data server-side, because the stores block browser requests.
//
//   GET /api/stores                          list of store plug-ins (no passcode needed)
//   GET /api/auth                            check the passcode
//   GET /api/search?store=coles&q=milk&loc=  search one store
//   GET /api/locations?store=coles&lat=&lng= nearby branches (stores that support it)
//   GET /api/status?q=milk                   live test of every store
//
// All but /api/stores need the X-Passcode header to match the APP_PASSCODE secret.
import { STORES, describeStores, getStore } from './stores/index.js';

const SEARCH_TTL_SECONDS = 3 * 60 * 60;
const MEMORY_TTL_MS = 20 * 60 * 1000;
const memoryCache = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      return await handleApi(request, env, ctx, url);
    } catch (err) {
      return json({ error: err?.message || String(err) }, err?.status || 500);
    }
  },
};

async function handleApi(request, env, ctx, url) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/stores') return json({ stores: describeStores() }, 200, { 'cache-control': 'public, max-age=300' });

  const denied = await checkPasscode(request, env);
  if (denied) return denied;

  if (path === '/api/auth') return json({ ok: true });

  if (path === '/api/search') {
    const store = getStore(url.searchParams.get('store'));
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const loc = (url.searchParams.get('loc') || '').trim().slice(0, 40);
    if (!store) return json({ error: 'Unknown store' }, 400);
    if (!q) return json({ error: 'Missing q' }, 400);
    const result = await cachedSearch(store, q, loc, ctx);
    return json(result);
  }

  if (path === '/api/locations') {
    const store = getStore(url.searchParams.get('store'));
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));
    if (!store || typeof store.findLocations !== 'function') return json({ error: 'Store has no locations' }, 400);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: 'Missing lat/lng' }, 400);
    return json({ store: store.id, locations: await store.findLocations(lat, lng) });
  }

  if (path === '/api/status') {
    const q = (url.searchParams.get('q') || 'milk').slice(0, 100);
    const results = await Promise.all(STORES.map((s) => probe(s, q, url.searchParams.get(`loc_${s.id}`) || '')));
    return json({ query: q, checkedAt: new Date().toISOString(), colo: request.cf?.colo || null, results });
  }

  return json({ error: 'Not found' }, 404);
}

async function probe(store, q, loc) {
  const started = Date.now();
  try {
    const products = await store.search(q, { location: loc || store.defaultLocation?.id });
    const withUnit = products.filter((p) => p.unitPrice > 0).length;
    return {
      store: store.id,
      ok: products.length > 0,
      count: products.length,
      withUnitPrice: withUnit,
      ms: Date.now() - started,
      sample: products.slice(0, 3).map((p) => ({ name: p.name, size: p.size, price: p.price })),
      error: products.length ? null : 'No products returned',
    };
  } catch (err) {
    return { store: store.id, ok: false, count: 0, ms: Date.now() - started, error: err?.message || String(err), blocked: !!err?.blocked };
  }
}

async function cachedSearch(store, q, loc, ctx) {
  const location = loc || store.defaultLocation?.id || '';
  const key = `${store.id}|${location}|${q.toLowerCase()}`;
  const hit = memoryCache.get(key);
  if (hit && Date.now() - hit.at < MEMORY_TTL_MS) return { ...hit.value, cached: true };

  // The Cache API only persists on custom domains (it is a no-op on workers.dev), which is fine.
  const cacheUrl = `https://grocery-cache.internal/search/${encodeURIComponent(key)}`;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    try {
      const res = await cache.match(cacheUrl);
      if (res) {
        const value = await res.json();
        remember(key, value);
        return { ...value, cached: true };
      }
    } catch {
      // cache unavailable
    }
  }

  const products = await store.search(q, { location });
  const value = { store: store.id, query: q, location: location || null, fetchedAt: new Date().toISOString(), products };
  remember(key, value);
  if (cache && products.length) {
    const res = new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${SEARCH_TTL_SECONDS}` },
    });
    ctx?.waitUntil?.(cache.put(cacheUrl, res).catch(() => {}));
  }
  return { ...value, cached: false };
}

function remember(key, value) {
  memoryCache.set(key, { at: Date.now(), value });
  if (memoryCache.size > 300) memoryCache.delete(memoryCache.keys().next().value);
}

async function checkPasscode(request, env) {
  const expected = env.APP_PASSCODE;
  if (!expected) {
    return json(
      { error: 'passcode-not-set', message: 'Set the APP_PASSCODE secret in Cloudflare (Worker > Settings > Variables and Secrets).' },
      503,
    );
  }
  const given = request.headers.get('x-passcode') || '';
  if (!(await safeEqual(given, expected))) return json({ error: 'bad-passcode', message: 'Wrong passcode.' }, 401);
  return null;
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// Coles plug-in: uses the same JSON API the coles.com.au website calls.
// The API needs a subscription key that the website embeds in its homepage, so we
// read it from there (and keep a known key as a fallback).
import { normaliseUnitPrice, parseUnitString } from '../../public/js/core/units.js';
import { CookieJar, HTML_HEADERS, JSON_HEADERS, StoreError, fetchWithTimeout, readJson, round2, slugify } from '../http.js';

const BASE = 'https://www.coles.com.au';
const IMAGE_BASE = 'https://cdn.productimages.coles.com.au/productimages';
const FALLBACK_KEY = 'eae83861d1cd4de6bb9cd8a2cd6f041e';
const SESSION_TTL = 6 * 60 * 60 * 1000;
// Coles prices vary by state; a Brisbane store gives QLD pricing.
const DEFAULT_LOCATION = { id: '4553', label: 'Coles West End, QLD' };

let session = null;

async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return session;
  const jar = new CookieJar();
  let key = FALLBACK_KEY;
  try {
    const res = await fetchWithTimeout(`${BASE}/`, { headers: HTML_HEADERS });
    jar.addFrom(res);
    const html = await res.text();
    key = html.match(/"BFF_API_SUBSCRIPTION_KEY":"([0-9a-f]{32})"/)?.[1] || key;
  } catch {
    // Homepage unavailable: carry on with the fallback key.
  }
  session = { key, jar, at: Date.now() };
  return session;
}

async function bff(path, params) {
  const url = `${BASE}/api/bff/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const res = await fetchWithTimeout(url, {
      headers: { ...JSON_HEADERS, 'ocp-apim-subscription-key': s.key, cookie: s.jar.header(), referer: `${BASE}/` },
    });
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue; // key rotated: re-read it
    return readJson(res, 'Coles');
  }
  throw new StoreError('Coles rejected the API key');
}

export function normaliseColesProduct(p) {
  const pricing = p.pricing || {};
  let unit = parseUnitString(pricing.comparable);
  if (!unit.unitPrice && pricing.unit?.price) {
    unit = normaliseUnitPrice(pricing.unit.price, pricing.unit.ofMeasureQuantity, pricing.unit.ofMeasureUnits);
  }
  const name = [p.brand, p.name].filter(Boolean).join(' ');
  const heir = p.onlineHeirs?.[0];
  return {
    id: String(p.id),
    name,
    brand: p.brand || null,
    size: p.size || null,
    price: typeof pricing.now === 'number' ? round2(pricing.now) : null,
    wasPrice: pricing.was > 0 ? round2(pricing.was) : null,
    promo: pricing.was > 0 || pricing.promotionType === 'SPECIAL' ? 'Special' : pricing.offerDescription || null,
    unitPrice: unit.unitPrice,
    unitMeasure: unit.unitMeasure,
    available: p.availability !== false,
    category: heir?.category || p.merchandiseHeir?.category || null,
    url: `${BASE}/product/${slugify(`${name} ${p.size || ''}`)}-${p.id}`,
    image: p.imageUris?.[0]?.uri ? `${IMAGE_BASE}${p.imageUris[0].uri}` : null,
  };
}

export default {
  id: 'coles',
  name: 'Coles',
  color: '#e01a22',
  defaultLocation: DEFAULT_LOCATION,

  async search(query, { location } = {}) {
    const data = await bff('products/search', {
      storeId: location || DEFAULT_LOCATION.id,
      searchTerm: query,
      start: '0',
      excludeAds: 'true',
      authenticated: 'false',
    });
    if (!Array.isArray(data?.results)) throw new StoreError('Coles response had no results list');
    return data.results
      .filter((r) => r._type === 'PRODUCT')
      .map(normaliseColesProduct)
      .filter((p) => p.price != null);
  },

  async findLocations(lat, lng) {
    const data = await bff('stores/search', { latitude: lat, longitude: lng, brandIds: '2', numberOfStores: '10' });
    return (data?.stores || []).map((s) => ({
      id: String(s.storeId),
      label: `${s.storeName}${s.state ? `, ${s.state}` : ''}`,
      detail: [s.suburb, s.distance?.description].filter(Boolean).join(' · '),
    }));
  },
};

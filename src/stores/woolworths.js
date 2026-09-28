// Woolworths plug-in: uses the search API behind woolworths.com.au.
// Woolworths sits behind Akamai bot protection, which wants the cookies it sets on the
// homepage, so we visit the homepage first and reuse its cookies for a while.
import { normaliseUnitPrice, parseUnitString, splitMeasure } from '../../public/js/core/units.js';
import { CookieJar, HTML_HEADERS, JSON_HEADERS, StoreError, fetchWithTimeout, readJson, round2 } from '../http.js';

const BASE = 'https://www.woolworths.com.au';
const SESSION_TTL = 20 * 60 * 1000;

let session = null;

async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return session;
  const jar = new CookieJar();
  const res = await fetchWithTimeout(`${BASE}/`, { headers: HTML_HEADERS });
  jar.addFrom(res);
  await res.arrayBuffer();
  if (res.status === 403) {
    throw new StoreError('Woolworths refused the request (HTTP 403, Akamai bot protection)', { blocked: true });
  }
  session = { jar, at: Date.now() };
  return session;
}

function parseCategory(p) {
  const a = p.AdditionalAttributes || {};
  // Most specific first: "Full Cream Milk" beats "Milk".
  for (const key of ['piessubcategorynamesjson', 'piescategorynamesjson']) {
    try {
      const list = JSON.parse(a[key] || '[]');
      if (list.length) return list[list.length - 1];
    } catch {
      // ignore malformed attribute
    }
  }
  return a.sapsubcategoryname || a.sapcategoryname || null;
}

export function normaliseWoolworthsProduct(p) {
  let unit = { unitPrice: null, unitMeasure: null };
  if (typeof p.CupPrice === 'number' && p.CupMeasure) {
    const [q, u] = splitMeasure(p.CupMeasure);
    if (u) unit = normaliseUnitPrice(p.CupPrice, q, u);
  }
  if (!unit.unitPrice) unit = parseUnitString(p.CupString || (typeof p.CupPrice === 'string' ? p.CupPrice : ''));
  const price = typeof p.Price === 'number' ? p.Price : typeof p.InstorePrice === 'number' ? p.InstorePrice : null;
  const was = typeof p.WasPrice === 'number' && price != null && p.WasPrice > price ? p.WasPrice : null;
  const name = p.DisplayName || p.Name || '';
  return {
    id: String(p.Stockcode),
    name: p.Brand && !name.toLowerCase().startsWith(p.Brand.toLowerCase()) ? `${p.Brand} ${name}` : name,
    brand: p.Brand || null,
    size: p.PackageSize || null,
    price: price != null ? round2(price) : null,
    wasPrice: was != null ? round2(was) : null,
    promo: p.IsHalfPrice ? 'Half price' : p.IsOnSpecial || was ? 'Special' : null,
    unitPrice: unit.unitPrice,
    unitMeasure: unit.unitMeasure,
    available: p.IsAvailable !== false && p.IsInStock !== false,
    category: parseCategory(p),
    url: `${BASE}/shop/productdetails/${p.Stockcode}/${p.UrlFriendlyName || ''}`,
    image: p.MediumImageFile || p.SmallImageFile || p.ImageUris?.medium || null,
  };
}

/** Search results come as groups ("bundles") of products; flatten them. */
export function extractWoolworthsProducts(data) {
  const groups = Array.isArray(data?.Products) ? data.Products : null;
  if (!groups) throw new StoreError('Woolworths response had no Products list');
  return groups.flatMap((g) => (Array.isArray(g?.Products) ? g.Products : [g])).filter((p) => p && p.Stockcode);
}

export default {
  id: 'woolworths',
  name: 'Woolworths',
  color: '#178841',

  async search(query) {
    const body = {
      Filters: [],
      IsSpecial: false,
      Location: `/shop/search/products?searchTerm=${encodeURIComponent(query)}`,
      PageNumber: 1,
      PageSize: 36,
      SearchTerm: query,
      SortType: 'TraderRelevance',
      GroupEdmVariants: false,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await getSession(attempt > 0);
      const res = await fetchWithTimeout(`${BASE}/apis/ui/Search/products`, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'content-type': 'application/json',
          origin: BASE,
          referer: `${BASE}${body.Location}`,
          cookie: s.jar.header(),
        },
        body: JSON.stringify(body),
      });
      s.jar.addFrom(res);
      if (res.status === 403 && attempt === 0) continue; // stale cookies: start a fresh session
      const data = await readJson(res, 'Woolworths');
      return extractWoolworthsProducts(data)
        .map(normaliseWoolworthsProduct)
        .filter((p) => p.price != null);
    }
    throw new StoreError('Woolworths refused the request', { blocked: true });
  },
};

// ALDI plug-in: uses the product-search API behind aldi.com.au.
// ALDI prices are national, so there is no store/location to choose.
import { parseUnitString } from '../../public/js/core/units.js';
import { JSON_HEADERS, StoreError, fetchWithTimeout, readJson, round2, sleep } from '../http.js';

const API = 'https://asl.api.aldi.com.au/commerce/v3/product-search';
const SITE = 'https://www.aldi.com.au';
const ATTEMPTS = 4; // ALDI's bot protection refuses some requests at random; a retry usually succeeds.

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(^|[\s\-&/(])([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
}

export function normaliseAldiProduct(p) {
  const pr = p.price || {};
  const unit = parseUnitString(pr.comparisonDisplay);
  const brand = p.brandName ? titleCase(p.brandName) : null;
  // amountRelevant is what you pay for one item; for loose produce and meat
  // ("approx. 0.18 kg per piece") it is already the per-piece/per-pack estimate.
  const cents = typeof pr.amountRelevant === 'number' ? pr.amountRelevant : pr.amount;
  const price = typeof cents === 'number' ? cents / 100 : null;
  const size = p.sellingSize || (p.weightType && p.weightType !== '0' ? 'per kg' : null);
  const slugImg = (p.assets || []).find((a) => a.assetType === 'FR01') || p.assets?.[0];
  const cats = p.categories || [];
  return {
    id: String(p.sku),
    name: brand && !String(p.name).toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${p.name}` : p.name,
    brand,
    size,
    price: price != null ? round2(price) : null,
    wasPrice: pr.wasPriceDisplay ? Number(String(pr.wasPriceDisplay).replace(/[^0-9.]/g, '')) || null : null,
    promo: pr.wasPriceDisplay || pr.savingsDisplay ? 'Special' : null,
    unitPrice: unit.unitPrice,
    unitMeasure: unit.unitMeasure,
    available: !p.discontinued,
    category: cats.length ? cats[cats.length - 1].name : null,
    url: p.urlSlugText ? `${SITE}/product/${p.urlSlugText}-${p.sku}` : null,
    image: slugImg?.url ? slugImg.url.replace('{width}', '300').replace('{slug}', p.urlSlugText || 'product') : null,
  };
}

export default {
  id: 'aldi',
  name: 'ALDI',
  color: '#00457c',

  async search(query) {
    const params = new URLSearchParams({
      currency: 'AUD',
      serviceType: 'walk-in',
      q: query,
      limit: '30',
      offset: '0',
      sort: 'relevance',
    });
    let lastError;
    for (let i = 0; i < ATTEMPTS; i++) {
      if (i) await sleep(250 * i);
      try {
        const res = await fetchWithTimeout(`${API}?${params}`, {
          headers: { ...JSON_HEADERS, origin: SITE, referer: `${SITE}/` },
        });
        const data = await readJson(res, 'ALDI');
        if (!Array.isArray(data?.data)) throw new StoreError('ALDI response had no data list');
        return data.data.map(normaliseAldiProduct).filter((p) => p.price != null);
      } catch (err) {
        lastError = err;
        if (!err.blocked) break;
      }
    }
    throw lastError;
  },
};

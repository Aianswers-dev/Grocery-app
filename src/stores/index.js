// Store plug-in registry. To add a supermarket, write a module that follows the
// contract below and add it to STORES. The app picks it up automatically.
//
// A store plug-in is an object with:
//   id               short, URL-safe id, e.g. 'iga'
//   name             display name
//   color            brand colour (CSS) used in the app
//   defaultLocation  optional { id, label } when prices depend on a store/branch
//   search(query, { location })        -> Promise<Product[]>
//   findLocations(lat, lng)            -> optional, Promise<{ id, label, detail }[]>
//
// A Product is:
//   { id, name, brand, size, price, wasPrice, promo, unitPrice, unitMeasure ('L'|'kg'|'each'),
//     available, category, url, image }
// Only id, name and price are required; the rest improves matching and display.
import woolworths from './woolworths.js';
import coles from './coles.js';
import aldi from './aldi.js';

export const STORES = [woolworths, coles, aldi];

export function getStore(id) {
  return STORES.find((s) => s.id === id) || null;
}

export function describeStores() {
  return STORES.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    defaultLocation: s.defaultLocation || null,
    hasLocations: typeof s.findLocations === 'function',
  }));
}

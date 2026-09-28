// Everything is kept on the phone: the list, remembered choices and settings in
// localStorage; the (bigger) cached search results in IndexedDB.

const KEY = 'grocery.v1';
const DB_NAME = 'grocery';
const DB_STORE = 'results';

export const state = {
  items: [], // { id, text, qty, checked, addedAt }
  memory: {}, // { [itemKey]: { [storeId]: { id, name } | { none: true } } }
  settings: { passcode: '', locations: {}, disabled: [] },
  stores: [], // cached copy of /api/stores
  results: {}, // { [resultKey]: { at, products, error } }  (persisted in IndexedDB)
};

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state.items = Array.isArray(saved.items) ? saved.items : [];
      state.memory = saved.memory || {};
      state.settings = { ...state.settings, ...(saved.settings || {}) };
      state.stores = Array.isArray(saved.stores) ? saved.stores : [];
    }
  } catch {
    // corrupted or blocked storage: start empty
  }
}

export function save() {
  try {
    const { items, memory, settings, stores } = state;
    localStorage.setItem(KEY, JSON.stringify({ items, memory, settings, stores }));
  } catch {
    // storage full or blocked: keep working in memory
  }
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Ask the browser not to evict our data (helps on iOS). */
export async function persistStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // not supported
  }
}

// ---- IndexedDB for search results ----

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

export async function loadResults() {
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    try {
      const tx = d.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        if (!state.results[cur.key]) state.results[cur.key] = cur.value;
        cur.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function saveResult(key, value) {
  state.results[key] = value;
  const d = await db();
  if (!d) return;
  try {
    d.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(value, key);
  } catch {
    // ignore
  }
}

/** Drop cached results no list item uses any more. */
export async function pruneResults(keepKeys) {
  const keep = new Set(keepKeys);
  const d = await db();
  for (const key of Object.keys(state.results)) {
    if (keep.has(key)) continue;
    delete state.results[key];
    try {
      d?.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(key);
    } catch {
      // ignore
    }
  }
}

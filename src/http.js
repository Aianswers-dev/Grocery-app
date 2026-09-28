// Small HTTP helpers shared by the store plug-ins.

export const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// Akamai (Woolworths, ALDI) refuses requests that lack sec-fetch-mode + accept-encoding,
// which browsers and Node send but the Workers runtime doesn't add by itself.
const COMMON_HEADERS = {
  'user-agent': USER_AGENT,
  'accept-language': 'en-AU,en;q=0.9',
  'accept-encoding': 'gzip, deflate',
  'sec-fetch-mode': 'cors',
};

export const HTML_HEADERS = {
  ...COMMON_HEADERS,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export const JSON_HEADERS = {
  ...COMMON_HEADERS,
  accept: 'application/json, text/plain, */*',
};

/** Error with an HTTP status and a flag for "the store's bot protection refused us". */
export class StoreError extends Error {
  constructor(message, { status = 502, blocked = false } = {}) {
    super(message);
    this.status = status;
    this.blocked = blocked;
  }
}

/** fetch() with a timeout. */
export async function fetchWithTimeout(url, init = {}, ms = 15000) {
  try {
    return await fetch(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new StoreError(`Timed out after ${ms / 1000}s`, { status: 504 });
    }
    throw new StoreError(`Network error: ${err?.message || err}`);
  }
}

/** Minimal cookie jar: remembers name=value pairs from Set-Cookie headers. */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  addFrom(response) {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : splitSetCookie(response.headers.get('set-cookie'));
    for (const c of list) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return this;
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get size() {
    return this.cookies.size;
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[A-Za-z0-9_\-.]+=)/);
}

/** Read a JSON body, turning HTML block pages into a clear error. */
export async function readJson(res, storeName) {
  const text = await res.text();
  if (res.status === 403 || /Access Denied|Request unsuccessful|Incapsula|captcha/i.test(text.slice(0, 2000))) {
    throw new StoreError(`${storeName} refused the request (HTTP ${res.status}, bot protection)`, { status: 502, blocked: true });
  }
  if (!res.ok) throw new StoreError(`${storeName} returned HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError(`${storeName} returned something that isn't JSON`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

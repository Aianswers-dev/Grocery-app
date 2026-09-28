// Talks to the Worker API. Requests are queued so we never hammer the supermarkets.

const MAX_PARALLEL = 4;
let active = 0;
const queue = [];

function runQueued(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active++;
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, passcode, { timeout = 30000 } = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'x-passcode': passcode || '' }, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new ApiError(offline ? 'You are offline' : err?.name === 'TimeoutError' ? 'Timed out' : 'Network error');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON (e.g. running without the Worker)
  }
  if (!res.ok) throw new ApiError(body?.message || body?.error || `HTTP ${res.status}`, { status: res.status, code: body?.error || null });
  return body;
}

export const api = {
  stores: () => request('/api/stores', ''),
  auth: (passcode) => request('/api/auth', passcode),
  search: (passcode, store, q, loc) =>
    runQueued(() => request(`/api/search?${new URLSearchParams({ store, q, ...(loc ? { loc } : {}) })}`, passcode)),
  locations: (passcode, store, lat, lng) => request(`/api/locations?${new URLSearchParams({ store, lat, lng })}`, passcode),
  status: (passcode, q = 'milk') => request(`/api/status?${new URLSearchParams({ q })}`, passcode, { timeout: 60000 }),
};

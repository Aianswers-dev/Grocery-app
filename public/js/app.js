// Grocery list PWA: add items, compare Woolworths / Coles / ALDI, pick the cheapest.
import { api } from './api.js';
import { state, load, save, newId, persistStorage, loadResults, saveResult, pruneResults } from './state.js';
import { parseItem } from './core/query.js';
import { matchItem } from './core/match.js';
import { summarise } from './core/basket.js';
import { formatUnitPrice } from './core/units.js';

const STALE_MS = 12 * 60 * 60 * 1000;
const OPTIONS_SHOWN = 30;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

const ui = {
  sheet: null, // { type: 'item', id, store } | { type: 'settings' } | { type: 'summary' } | { type: 'welcome', reason }
  loading: new Set(),
  status: null, // /api/status result
  statusBusy: false,
  locations: null, // { store, list, busy, error }
  version: 0, // bumps when results/memory change (match cache key)
};
const inflight = new Map();
const matchCache = new Map();

// ---------- stores & keys ----------

function enabledStores() {
  return state.stores.filter((s) => !state.settings.disabled.includes(s.id));
}
function storeById(id) {
  return state.stores.find((s) => s.id === id);
}
function locFor(store) {
  return state.settings.locations[store.id]?.id || store.defaultLocation?.id || '';
}
function locLabel(store) {
  return state.settings.locations[store.id]?.label || store.defaultLocation?.label || '';
}
function resultKey(store, query) {
  return `${store.id}|${locFor(store)}|${query.trim().toLowerCase()}`;
}

// ---------- matching ----------

function itemInfo(item) {
  const p = parseItem(item.text);
  return { ...p, qty: item.qty || p.qty || 1 };
}

function matchFor(item) {
  const cached = matchCache.get(item.id);
  const sig = `${ui.version}|${item.text}|${item.qty}|${state.settings.disabled.join()}|${JSON.stringify(state.settings.locations)}`;
  if (cached && cached.sig === sig) return cached.value;
  const info = itemInfo(item);
  const results = {};
  const status = {};
  for (const s of enabledStores()) {
    const key = resultKey(s, info.name);
    const r = state.results[key];
    if (r?.products) results[s.id] = r.products;
    status[s.id] = { loading: ui.loading.has(key), error: r?.error || null, at: r?.at || null, hasData: !!r?.products };
  }
  const value = { info, status, ...matchItem(info, results, state.memory[info.key] || {}) };
  matchCache.set(item.id, { sig, value });
  return value;
}

function bump() {
  ui.version++;
}

// ---------- fetching ----------

async function fetchStore(store, query, { force = false } = {}) {
  const key = resultKey(store, query);
  const cur = state.results[key];
  if (!force && cur?.products && !cur.error && Date.now() - cur.at < STALE_MS) return cur;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    ui.loading.add(key);
    bump();
    scheduleRender();
    try {
      let res;
      try {
        res = await api.search(state.settings.passcode, store.id, query, locFor(store));
      } catch (err) {
        // Stores' bot protection occasionally refuses a request; one retry usually works.
        if (!(err.status >= 500)) throw err;
        await new Promise((r) => setTimeout(r, 3000));
        res = await api.search(state.settings.passcode, store.id, query, locFor(store));
      }
      await saveResult(key, { at: Date.now(), products: res.products || [] });
    } catch (err) {
      if (err.status === 401 || err.code === 'passcode-not-set') openSheet({ type: 'welcome', reason: err.code || 'bad-passcode' });
      await saveResult(key, { at: cur?.at || Date.now(), products: cur?.products || null, error: err.message });
    } finally {
      ui.loading.delete(key);
      inflight.delete(key);
      bump();
      scheduleRender();
    }
    return state.results[key];
  })();
  inflight.set(key, job);
  return job;
}

async function fetchItem(item, opts = {}) {
  const info = itemInfo(item);
  const stores = enabledStores();
  await Promise.all(stores.map((s) => fetchStore(s, info.name, opts)));
  // A remembered product that dropped out of the results: look it up by its own name.
  const memo = state.memory[info.key] || {};
  for (const s of stores) {
    const m = memo[s.id];
    const r = state.results[resultKey(s, info.name)];
    if (!m?.id || !m.name || !r?.products || r.products.some((p) => String(p.id) === String(m.id))) continue;
    const extra = await fetchStore(s, m.name, opts);
    const found = extra?.products?.find((p) => String(p.id) === String(m.id));
    if (found) {
      await saveResult(resultKey(s, info.name), { ...r, products: [...r.products, found] });
      bump();
      scheduleRender();
    }
  }
}

function refreshAll({ force = false } = {}) {
  if (!state.settings.passcode) return;
  for (const item of state.items) fetchItem(item, { force });
}

function keepKeys() {
  const keys = [];
  for (const item of state.items) {
    const info = itemInfo(item);
    for (const s of state.stores) {
      keys.push(resultKey(s, info.name));
      const m = state.memory[info.key]?.[s.id];
      if (m?.name) keys.push(resultKey(s, m.name));
    }
  }
  return keys;
}

// ---------- list actions ----------

function addItem(text) {
  const p = parseItem(text);
  if (!p.label) return;
  const item = { id: newId(), text: p.label, qty: p.qty, checked: false, addedAt: Date.now() };
  state.items.unshift(item);
  save();
  render();
  fetchItem(item);
}

function updateItem(id, patch) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const before = itemInfo(item).name;
  Object.assign(item, patch);
  save();
  bump();
  render();
  if (patch.text != null && itemInfo(item).name !== before) fetchItem(item);
}

function removeItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  save();
  pruneResults(keepKeys());
  closeSheet();
  render();
}

function remember(item, storeId, choice) {
  const key = itemInfo(item).key;
  const memo = { ...(state.memory[key] || {}) };
  if (choice) memo[storeId] = choice;
  else delete memo[storeId];
  if (Object.keys(memo).length) state.memory[key] = memo;
  else delete state.memory[key];
  save();
  bump();
  render();
}

// ---------- rendering ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  renderList();
  renderSummaryBar();
  renderSheet();
  const busy = ui.loading.size > 0;
  $('#refresh').classList.toggle('spin', busy);
}

function storeDot(store) {
  return `<i class="dot" style="--c:${esc(store.color)}"></i>`;
}

function priceCell(store, m, bestStore) {
  const st = m.status[store.id];
  const pick = m.picks[store.id];
  const cls = ['price'];
  let text;
  let title = store.name;
  if (pick) {
    text = money(pick.cost);
    if (store.id === bestStore) cls.push('best');
    if (pick.sizeNote) {
      cls.push('warn');
      text = `≈${text}`;
      title += ` (${pick.sizeNote})`;
    }
    if (pick.chosen) cls.push('chosen');
  } else if (st?.loading && !st.hasData) {
    text = '';
    cls.push('loading');
  } else if (st?.error && !st.hasData) {
    text = '!';
    cls.push('error');
    title += `: ${st.error}`;
  } else if (m.suggestions?.[store.id]) {
    text = '—';
    cls.push('none');
    title += ': no match at this size';
  } else {
    text = '—';
    cls.push('none');
  }
  if (st?.loading && st.hasData) cls.push('refreshing');
  return `<span class="${cls.join(' ')}" title="${esc(title)}" style="--c:${esc(store.color)}">${storeDot(store)}<span>${esc(text)}</span></span>`;
}

function bestStoreFor(m) {
  let best = null;
  for (const s of enabledStores()) {
    const p = m.picks[s.id];
    if (p && (!best || p.cost < m.picks[best].cost - 1e-9)) best = s.id;
  }
  return best;
}

function renderList() {
  const list = $('#list');
  const empty = $('#empty');
  empty.hidden = state.items.length > 0;
  const items = [...state.items].sort((a, b) => Number(a.checked) - Number(b.checked));
  const stores = enabledStores();
  list.innerHTML = items
    .map((item) => {
      const m = matchFor(item);
      const best = bestStoreFor(m);
      const bestPick = best ? m.picks[best] : null;
      const sub = bestPick
        ? `${esc(bestPick.product.name)}${bestPick.packs > 1 ? ` <b>×${bestPick.packs}</b>` : ''} · ${esc(storeById(best)?.name)}`
        : stores.some((s) => m.status[s.id]?.loading)
          ? 'Searching…'
          : stores.every((s) => m.status[s.id]?.error)
            ? 'Couldn’t reach the stores'
            : 'No match found';
      const target = m.target ? `<span class="target">${m.target.inferred ? '≈' : ''}${esc(m.target.label)}</span>` : '';
      return `<li class="item${item.checked ? ' checked' : ''}" data-id="${esc(item.id)}">
        <button class="check" data-action="toggle" aria-label="${item.checked ? 'Untick' : 'Tick off'} ${esc(item.text)}" aria-pressed="${item.checked}"></button>
        <div class="item-main" data-action="open-item">
          <div class="item-title"><span>${esc(item.text)}</span>${item.qty > 1 ? `<span class="qty">×${item.qty}</span>` : ''}${target}</div>
          <div class="item-sub">${sub}</div>
          <div class="prices">${stores.map((s) => priceCell(s, m, best)).join('')}</div>
        </div>
      </li>`;
    })
    .join('');
}

function currentSummary() {
  const stores = enabledStores().map((s) => s.id);
  const rows = state.items.map((item) => ({ item, ...matchFor(item) }));
  return { rows, stores, summary: summarise(rows, stores) };
}

function renderSummaryBar() {
  const bar = $('#summary');
  if (!state.items.length || !enabledStores().length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const { summary } = currentSummary();
  const totals = enabledStores()
    .map((s) => {
      const t = summary.perStore[s.id];
      const value = t.found ? money(t.total) : '—';
      return `<span class="total" style="--c:${esc(s.color)}">${storeDot(s)}${esc(s.name)} <b>${value}</b>${t.found && t.missing ? `<small>−${t.missing}</small>` : ''}</span>`;
    })
    .join('');
  bar.innerHTML = `<button class="summary-btn" data-action="open-summary">
      <div class="totals">${totals}</div>
      <div class="split">Best split <b>${money(summary.split.total)}</b>${summary.savings > 0 ? ` <span class="save">save ${money(summary.savings)}</span>` : ''}<span class="chev">›</span></div>
    </button>`;
}

// ---------- sheets ----------

function sheetKey(sheet) {
  return sheet ? `${sheet.type}:${sheet.id || ''}` : '';
}

function openSheet(sheet) {
  ui.sheet = sheet;
  const el = $('#sheet');
  renderSheet();
  if (!el.open) el.showModal();
  // Don't pop the keyboard up just from opening a sheet.
  if (sheet.type !== 'welcome') $('#sheet-body').focus({ preventScroll: true });
}

function closeSheet() {
  ui.sheet = null;
  ui.locations = null;
  const el = $('#sheet');
  if (el.open) el.close();
}

function renderSheet() {
  if (!ui.sheet) return;
  const body = $('#sheet-body');
  const key = sheetKey(ui.sheet);
  const same = body.dataset.key === key;
  const active = document.activeElement;
  // Don't redraw the sheet under someone who is typing in it.
  if (same && active && body.contains(active) && ['INPUT', 'TEXTAREA'].includes(active.tagName) && active.type !== 'checkbox') return;
  const html = { item: itemSheet, settings: settingsSheet, summary: summarySheet, welcome: welcomeSheet }[ui.sheet.type]?.();
  if (html == null) return closeSheet();
  const scroll = same ? $('.sheet-scroll', body)?.scrollTop || 0 : 0;
  body.innerHTML = html;
  body.dataset.key = key;
  const sc = $('.sheet-scroll', body);
  if (sc) sc.scrollTop = scroll;
}

function itemSheet() {
  const item = state.items.find((i) => i.id === ui.sheet.id);
  if (!item) return null;
  const m = matchFor(item);
  const stores = enabledStores();
  const storeId = ui.sheet.store && storeById(ui.sheet.store) ? ui.sheet.store : bestStoreFor(m) || stores[0]?.id;
  const store = storeById(storeId);
  const tabs = stores
    .map((s) => {
      const p = m.picks[s.id];
      return `<button class="tab${s.id === storeId ? ' active' : ''}" data-action="tab" data-store="${esc(s.id)}" style="--c:${esc(s.color)}">
        ${esc(s.name)}<small>${p ? money(p.cost) : m.status[s.id]?.loading ? '…' : '—'}</small></button>`;
    })
    .join('');
  const target = m.target
    ? `<p class="hint">Comparing <b>${esc(m.target.label)}</b>${m.target.inferred ? ' (the most common size — type a size like “milk 2L” to choose)' : ''}. Within ±25%, the lowest unit price wins.</p>`
    : '';
  return `<header class="sheet-head">
      <input id="item-text" class="item-edit" value="${esc(item.text)}" aria-label="Item" enterkeyhint="done" autocomplete="off" />
      <div class="stepper" role="group" aria-label="Quantity">
        <button data-action="qty" data-delta="-1" aria-label="Less">−</button><span>${item.qty}</span><button data-action="qty" data-delta="1" aria-label="More">+</button>
      </div>
      <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
    </header>
    <div class="sheet-scroll">
      ${target}
      <nav class="tabs">${tabs}</nav>
      ${store ? storeOptions(item, m, store) : '<p class="hint">No stores enabled.</p>'}
      <div class="sheet-actions">
        <button class="btn" data-action="refetch">Refresh prices</button>
        <button class="btn danger" data-action="delete">Delete item</button>
      </div>
    </div>`;
}

function storeOptions(item, m, store) {
  const st = m.status[store.id] || {};
  const pick = m.picks[store.id];
  const memo = state.memory[m.info.key]?.[store.id];
  const opts = (m.options[store.id] || []).slice(0, OPTIONS_SHOWN);
  const lines = [];
  if (st.loading) lines.push('<p class="hint">Searching…</p>');
  if (st.error) lines.push(`<p class="hint error">${esc(st.error)}${st.hasData ? ' — showing earlier prices.' : ''}</p>`);
  if (store.defaultLocation) lines.push(`<p class="hint">Prices for ${esc(locLabel(store))}.</p>`);
  if (pick?.lostChoice) lines.push(`<p class="hint warn">Your pick “${esc(pick.lostChoice.name)}” isn’t listed right now, so the cheapest match is shown.</p>`);
  const sugg = m.suggestions?.[store.id];
  if (!pick && sugg) lines.push(`<p class="hint warn">No match near ${esc(m.target?.label)} here. Closest: ${esc(sugg.product.name)} (${esc(sugg.product.size || '?')}) — tap it below to use it.</p>`);

  const auto = !memo;
  const rows = opts.map((o) => {
    const p = o.product;
    const selected = pick && String(pick.product.id) === String(p.id);
    const unit = formatUnitPrice(p.unitPrice, p.unitMeasure);
    const badges = [
      selected && !memo ? '<em class="badge">auto pick</em>' : '',
      selected && memo ? '<em class="badge mine">your pick</em>' : '',
      p.promo ? `<em class="badge promo">${esc(p.promo)}</em>` : '',
      !o.fits && o.sensible ? '<em class="badge dim">other size</em>' : '',
      p.available === false ? '<em class="badge dim">unavailable</em>' : '',
    ].join('');
    return `<li class="opt${selected ? ' selected' : ''}${o.sensible ? '' : ' faint'}">
      <button class="opt-main" data-action="choose" data-store="${esc(store.id)}" data-pid="${esc(p.id)}">
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="noimg"></span>'}
        <span class="opt-text">
          <span class="opt-name">${esc(p.name)}</span>
          <span class="opt-meta">${esc(p.size || '')}${unit ? ` · ${esc(unit)}` : ''}${p.wasPrice ? ` · <s>${money(p.wasPrice)}</s>` : ''}</span>
          <span class="badges">${badges}</span>
        </span>
        <span class="opt-price">${money(p.price)}${o.packs * item.qty > 1 ? `<small>×${o.packs * item.qty} = ${money(o.cost)}</small>` : ''}</span>
      </button>
      ${p.url ? `<a class="opt-link" href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Open on ${esc(store.name)}">↗</a>` : ''}
    </li>`;
  });
  return `${lines.join('')}
    <div class="choice-row">
      <button class="chip${auto ? ' on' : ''}" data-action="auto" data-store="${esc(store.id)}">Auto: cheapest</button>
      <button class="chip${memo?.none ? ' on' : ''}" data-action="none" data-store="${esc(store.id)}">Not at ${esc(store.name)}</button>
    </div>
    ${rows.length ? `<ul class="opts">${rows.join('')}</ul>` : st.loading ? '' : '<p class="hint">No products found.</p>'}`;
}

function summarySheet() {
  const { rows, stores, summary } = currentSummary();
  const storeRows = stores
    .map((id) => {
      const s = storeById(id);
      const t = summary.perStore[id];
      const note = !t.found ? 'no prices' : t.missing ? `${t.missing} missing` : 'all items';
      return `<tr><td>${storeDot(s)}${esc(s.name)}</td><td class="num">${t.found ? money(t.total) : '—'}</td><td class="muted">${note}</td></tr>`;
    })
    .join('');
  const warn = rows.filter((r, i) => summary.split.assignment[i] && r.picks[summary.split.assignment[i]]?.sizeNote).length;
  const pair = summary.bestPair;
  const plan = stores
    .filter((id) => summary.split.byStore[id].items.length)
    .map((id) => {
      const s = storeById(id);
      const g = summary.split.byStore[id];
      const lines = g.items
        .map((i) => {
          const r = rows[i];
          const p = r.picks[id];
          return `<li class="${r.item.checked ? 'checked' : ''}">
            <button class="check small" data-action="toggle" data-id="${esc(r.item.id)}" aria-pressed="${r.item.checked}" aria-label="Tick off"></button>
            <span class="plan-name">${r.info.qty > 1 || p.packs > 1 ? `${r.info.qty * p.packs} × ` : ''}${esc(p.product.name)}${p.sizeNote ? ' <em class="badge warn">≈ size</em>' : ''}</span>
            <span class="num">${money(p.cost)}</span></li>`;
        })
        .join('');
      return `<section class="plan"><h3 style="--c:${esc(s.color)}">${storeDot(s)}${esc(s.name)} <span class="num">${money(g.total)}</span></h3><ul>${lines}</ul></section>`;
    })
    .join('');
  const unmatched = rows.filter((r, i) => !summary.split.assignment[i]);
  return `<header class="sheet-head"><h2>Basket</h2><button class="icon-btn" data-action="close" aria-label="Close">✕</button></header>
    <div class="sheet-scroll">
      <div class="big-total">
        <div><small>Best split</small><b>${money(summary.split.total)}</b></div>
        ${
          summary.storesUsed.length === 1
            ? `<div class="save-box"><small>One shop is cheapest</small><b>${esc(storeById(summary.storesUsed[0])?.name)}</b></div>`
            : summary.cheapestStore
              ? `<div class="save-box"><small>Saves vs ${esc(storeById(summary.cheapestStore)?.name)} only</small><b>${money(summary.savings)}</b></div>`
              : ''
        }
      </div>
      <table class="totals-table"><tbody>${storeRows}</tbody></table>
      ${pair && summary.storesUsed.length > 2 ? `<p class="hint">Best with just two stores: <b>${pair.stores.map((id) => esc(storeById(id)?.name)).join(' + ')}</b> ${money(pair.total)}${pair.missing ? ` (${pair.missing} missing)` : ''}.</p>` : ''}
      ${warn ? `<p class="hint warn">${warn} item${warn > 1 ? 's use' : ' uses'} a different pack size (≈) — check them.</p>` : ''}
      <h2 class="section">Shopping plan</h2>
      ${plan || '<p class="hint">Add items to see a plan.</p>'}
      ${unmatched.length ? `<p class="hint">Not found anywhere: ${unmatched.map((r) => esc(r.item.text)).join(', ')}</p>` : ''}
    </div>`;
}

function settingsSheet() {
  const s = state.settings;
  const storeRows = state.stores
    .map((st) => {
      const on = !s.disabled.includes(st.id);
      const loc = st.hasLocations
        ? `<div class="loc">Store: <b>${esc(locLabel(st))}</b> <button class="link" data-action="find-loc" data-store="${esc(st.id)}">Use my location</button></div>`
        : '';
      const locList =
        ui.locations?.store === st.id
          ? ui.locations.busy
            ? '<p class="hint">Finding nearby stores…</p>'
            : ui.locations.error
              ? `<p class="hint error">${esc(ui.locations.error)}</p>`
              : `<ul class="loc-list">${ui.locations.list
                  .map((l) => `<li><button data-action="pick-loc" data-store="${esc(st.id)}" data-loc="${esc(l.id)}" data-label="${esc(l.label)}"><b>${esc(l.label)}</b><small>${esc(l.detail || '')}</small></button></li>`)
                  .join('')}</ul>`
          : '';
      return `<li class="store-row"><label class="switch"><input type="checkbox" data-action="toggle-store" data-store="${esc(st.id)}" ${on ? 'checked' : ''}/><span></span></label>
        <div>${storeDot(st)}<b>${esc(st.name)}</b>${loc}${locList}</div></li>`;
    })
    .join('');
  const status = ui.status
    ? `<ul class="status">${ui.status.results
        .map((r) => {
          const st = storeById(r.store);
          return `<li class="${r.ok ? 'ok' : 'bad'}">${storeDot(st || { color: '#999' })}<b>${esc(st?.name || r.store)}</b> ${r.ok ? `works — ${r.count} products in ${(r.ms / 1000).toFixed(1)}s` : `failed — ${esc(r.error)}`}</li>`;
        })
        .join('')}</ul><p class="hint">Checked from Cloudflare ${esc(ui.status.colo || '')} at ${new Date(ui.status.checkedAt).toLocaleTimeString()}.</p>`
    : '';
  const memoCount = Object.keys(state.memory).length;
  return `<header class="sheet-head"><h2>Settings</h2><button class="icon-btn" data-action="close" aria-label="Close">✕</button></header>
    <div class="sheet-scroll">
      <h3 class="section">Passcode</h3>
      <form class="row" data-form="passcode">
        <input id="passcode" type="password" value="${esc(s.passcode)}" placeholder="APP_PASSCODE" autocomplete="current-password" />
        <button class="btn">Save</button>
      </form>
      <h3 class="section">Stores</h3>
      <ul class="stores">${storeRows}</ul>
      <button class="btn" data-action="status" ${ui.statusBusy ? 'disabled' : ''}>${ui.statusBusy ? 'Checking…' : 'Check stores now'}</button>
      ${status}
      <h3 class="section">List</h3>
      <div class="btn-col">
        <button class="btn" data-action="refresh-all">Refresh all prices</button>
        <button class="btn" data-action="clear-checked">Remove ticked items</button>
        <button class="btn" data-action="forget" ${memoCount ? '' : 'disabled'}>Forget my product picks (${memoCount})</button>
        <button class="btn" data-action="export">Back up list</button>
        <label class="btn">Restore backup<input type="file" accept="application/json,.json" data-action="import" hidden /></label>
        <button class="btn danger" data-action="clear-all">Delete whole list</button>
      </div>
      <p class="hint">Your list, picks and settings are stored only on this phone.</p>
    </div>`;
}

function welcomeSheet() {
  const reason = ui.sheet.reason;
  const msg =
    reason === 'passcode-not-set'
      ? '<p class="hint error">The server has no passcode yet. In Cloudflare, open your Worker → Settings → Variables and Secrets and add a secret called <b>APP_PASSCODE</b>, then enter it here.</p>'
      : reason === 'bad-passcode'
        ? '<p class="hint error">That passcode didn’t match. Check the APP_PASSCODE secret in Cloudflare.</p>'
        : '';
  return `<header class="sheet-head"><h2>Welcome</h2></header>
    <div class="sheet-scroll">
      <p>Type items like <b>milk 2L</b>, <b>6 bananas</b> or <b>2 x coke 30 pack</b>. The app checks Woolworths, Coles and ALDI and picks the cheapest sensible match.</p>
      ${msg}
      <form class="row" data-form="passcode">
        <input id="passcode" type="password" value="${esc(state.settings.passcode)}" placeholder="Your APP_PASSCODE" autocomplete="current-password" required />
        <button class="btn primary">Continue</button>
      </form>
    </div>`;
}

// ---------- events ----------

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function savePasscode(value) {
  state.settings.passcode = value.trim();
  save();
  try {
    await api.auth(state.settings.passcode);
    toast('Passcode saved');
    if (ui.sheet?.type === 'welcome') closeSheet();
    // Retry anything that failed for lack of a passcode.
    for (const [k, r] of Object.entries(state.results)) if (r.error) delete state.results[k];
    bump();
    refreshAll();
    render();
  } catch (err) {
    openSheet({ type: 'welcome', reason: err.code || 'bad-passcode' });
    if (!err.code) toast(err.message);
  }
}

async function checkStatus() {
  ui.statusBusy = true;
  renderSheet();
  try {
    ui.status = await api.status(state.settings.passcode);
  } catch (err) {
    toast(`Check failed: ${err.message}`);
  }
  ui.statusBusy = false;
  renderSheet();
}

function findLocations(storeId) {
  ui.locations = { store: storeId, busy: true, list: [] };
  renderSheet();
  if (!navigator.geolocation) {
    ui.locations = { store: storeId, error: 'Location isn’t available on this device.' };
    return renderSheet();
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const res = await api.locations(state.settings.passcode, storeId, pos.coords.latitude.toFixed(4), pos.coords.longitude.toFixed(4));
        ui.locations = { store: storeId, list: res.locations || [] };
      } catch (err) {
        ui.locations = { store: storeId, error: err.message };
      }
      renderSheet();
    },
    (err) => {
      ui.locations = { store: storeId, error: err.code === 1 ? 'Location permission was denied.' : 'Couldn’t get your location.' };
      renderSheet();
    },
    { timeout: 15000, maximumAge: 600000 },
  );
}

function exportList() {
  const data = JSON.stringify({ app: 'grocery', version: 1, exportedAt: new Date().toISOString(), items: state.items, memory: state.memory }, null, 1);
  const file = new File([data], `grocery-list-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: 'Grocery list backup' }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importList(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.items)) throw new Error('Not a grocery backup');
    const have = new Set(state.items.map((i) => i.text.toLowerCase()));
    const added = data.items.filter((i) => i && i.text && !have.has(String(i.text).toLowerCase())).map((i) => ({ ...i, id: newId() }));
    state.items.push(...added);
    state.memory = { ...(data.memory || {}), ...state.memory };
    save();
    bump();
    render();
    refreshAll();
    toast(`Restored ${added.length} item${added.length === 1 ? '' : 's'}`);
  } catch (err) {
    toast(`Couldn’t restore: ${err.message}`);
  }
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) {
    if (e.target === $('#sheet')) closeSheet(); // tap on backdrop
    return;
  }
  const action = el.dataset.action;
  const li = el.closest('[data-id]');
  const itemId = el.dataset.id || li?.dataset.id || ui.sheet?.id;
  const item = state.items.find((i) => i.id === itemId);
  switch (action) {
    case 'toggle':
      if (item) updateItem(item.id, { checked: !item.checked });
      break;
    case 'open-item':
      // Start on the cheapest store's tab, and stay there while prices update.
      if (item) openSheet({ type: 'item', id: itemId, store: bestStoreFor(matchFor(item)) || enabledStores()[0]?.id });
      break;
    case 'open-summary':
      openSheet({ type: 'summary' });
      break;
    case 'open-settings':
      openSheet({ type: 'settings' });
      break;
    case 'close':
      closeSheet();
      break;
    case 'tab':
      ui.sheet.store = el.dataset.store;
      renderSheet();
      break;
    case 'qty':
      if (item) updateItem(item.id, { qty: Math.max(1, Math.min(99, item.qty + Number(el.dataset.delta))) });
      break;
    case 'choose': {
      const opt = matchFor(item).options[el.dataset.store]?.find((o) => String(o.product.id) === el.dataset.pid);
      if (opt) remember(item, el.dataset.store, { id: opt.product.id, name: opt.product.name });
      break;
    }
    case 'auto':
      remember(item, el.dataset.store, null);
      break;
    case 'none':
      remember(item, el.dataset.store, { none: true });
      break;
    case 'refetch':
      if (item) fetchItem(item, { force: true });
      break;
    case 'delete':
      if (item && confirm(`Delete “${item.text}”?`)) removeItem(item.id);
      break;
    case 'refresh':
    case 'refresh-all':
      refreshAll({ force: true });
      toast('Refreshing prices…');
      break;
    case 'status':
      checkStatus();
      break;
    case 'find-loc':
      findLocations(el.dataset.store);
      break;
    case 'pick-loc':
      state.settings.locations[el.dataset.store] = { id: el.dataset.loc, label: el.dataset.label };
      save();
      ui.locations = null;
      bump();
      render();
      refreshAll();
      toast(`Using ${el.dataset.label}`);
      break;
    case 'clear-checked':
      state.items = state.items.filter((i) => !i.checked);
      save();
      pruneResults(keepKeys());
      render();
      break;
    case 'forget':
      if (confirm('Forget every product you picked by hand?')) {
        state.memory = {};
        save();
        bump();
        render();
      }
      break;
    case 'export':
      exportList();
      break;
    case 'clear-all':
      if (confirm('Delete the whole list?')) {
        state.items = [];
        save();
        pruneResults([]);
        render();
      }
      break;
  }
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.action === 'toggle-store') {
    const id = el.dataset.store;
    const set = new Set(state.settings.disabled);
    if (el.checked) set.delete(id);
    else set.add(id);
    state.settings.disabled = [...set];
    save();
    bump();
    render();
    if (el.checked) refreshAll();
  } else if (el.dataset.action === 'import' && el.files?.[0]) {
    importList(el.files[0]);
    el.value = '';
  } else if (el.id === 'item-text') {
    const item = state.items.find((i) => i.id === ui.sheet?.id);
    const p = parseItem(el.value);
    if (item && p.label) updateItem(item.id, { text: p.label, ...(p.qty > 1 ? { qty: p.qty } : {}) });
  }
}

function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  if (form.id === 'add-form') {
    const input = $('#add-input');
    // Several items at once: "milk 2L, bread, 6 bananas"
    for (const part of input.value.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean).reverse()) addItem(part);
    input.value = '';
    input.focus();
  } else if (form.dataset.form === 'passcode') {
    savePasscode($('#passcode', form).value);
  }
}

// ---------- start ----------

async function start() {
  load();
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('submit', onSubmit);
  $('#sheet').addEventListener('close', () => {
    ui.sheet = null;
    ui.locations = null;
  });
  $('#sheet').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'item-text') e.target.blur();
  });
  render();
  await loadResults();
  bump();
  render();

  try {
    const res = await api.stores();
    state.stores = res.stores;
    save();
    bump();
    render();
  } catch {
    if (!state.stores.length) toast('Can’t reach the app server — showing saved prices.');
  }
  if (!state.settings.passcode) openSheet({ type: 'welcome' });
  else refreshAll();
  persistStorage();
  pruneResults(keepKeys());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAll();
  });
}

start();

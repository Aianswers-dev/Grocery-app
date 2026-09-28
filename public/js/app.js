// Trolley: a grocery list that prices every item at Woolworths, Coles and ALDI.
import { api } from './api.js';
import { state, load, save, newId, persistStorage, loadResults, saveResult, pruneResults, rememberText } from './state.js';
import { parseItem } from './core/query.js';
import { matchItem } from './core/match.js';
import { summarise } from './core/basket.js';
import { formatUnitPrice } from './core/units.js';
import { icon } from './ui/icons.js';
import { emojiFor } from './ui/emoji.js';
import { enableSwipe, enableSheetDrag, tweenNumber } from './ui/gestures.js';

const DEMO = !!api.demo;
const STALE_MS = 12 * 60 * 60 * 1000;
const OPTIONS_SHOWN = 30;
const QUICK_ADDS = ['milk 2L', 'bread', '6 bananas', 'eggs 12', 'butter', 'coffee'];

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ui = {
  sheet: null, // { type: 'item', id, store } | { type: 'settings' } | { type: 'summary' } | { type: 'welcome', reason }
  loading: new Set(),
  status: null,
  statusBusy: false,
  locations: null, // { store, list, busy, error }
  version: 0, // bumps when results/memory change (match cache key)
  fresh: new Set(), // item ids to animate in
  composerFocused: false,
  heroHidden: false,
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
function mono(store, cls = '') {
  if (!store) return '';
  const letter = (store.short || store.name || '?').trim()[0].toUpperCase();
  return `<i class="mono${cls ? ` ${cls}` : ''}" style="--c:${esc(store.color)}" aria-hidden="true">${esc(letter)}</i>`;
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

const cmpCost = (pick) => pick.compareCost ?? pick.cost;

function bestStoreFor(m) {
  let best = null;
  for (const s of enabledStores()) {
    const p = m.picks[s.id];
    if (p && (!best || cmpCost(p) < cmpCost(m.picks[best]) - 1e-9)) best = s.id;
  }
  return best;
}

function currentSummary() {
  const stores = enabledStores().map((s) => s.id);
  const rows = state.items.map((item) => ({ item, ...matchFor(item) }));
  return { rows, stores, summary: summarise(rows, stores) };
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
  if (!state.settings.passcode && !DEMO) return;
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
  rememberText(p.label);
  ui.fresh.add(item.id);
  save();
  render();
  fetchItem(item);
}

function updateItem(id, patch) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const before = itemInfo(item).name;
  Object.assign(item, patch);
  if (patch.text) rememberText(patch.text);
  save();
  bump();
  render();
  if (patch.text != null && itemInfo(item).name !== before) fetchItem(item);
}

function toggleItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  navigator.vibrate?.(10);
  updateItem(id, { checked: !item.checked });
}

function removeItem(id) {
  const index = state.items.findIndex((i) => i.id === id);
  if (index < 0) return;
  const [item] = state.items.splice(index, 1);
  save();
  if (ui.sheet?.id === id) closeSheet();
  render();
  toast(`Removed “${item.text}”`, {
    label: 'Undo',
    icon: 'undo',
    run: () => {
      state.items.splice(Math.min(index, state.items.length), 0, item);
      ui.fresh.add(item.id);
      save();
      render();
    },
  });
  setTimeout(() => pruneResults(keepKeys()), 6000);
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
  // Don't redraw rows under a finger mid-swipe.
  if (document.querySelector('.row.swiping')) {
    setTimeout(scheduleRender, 250);
    return;
  }
  const data = state.items.length && enabledStores().length ? currentSummary() : null;
  renderHeader(data);
  renderHero(data);
  renderMain();
  renderFloat(data);
  renderSheet();
  renderComposerIcon();
}

function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function renderHeader(data) {
  const busy = ui.loading.size > 0;
  $('#refresh').classList.toggle('busy', busy);
  const meta = $('#meta');
  const open = state.items.filter((i) => !i.checked).length;
  let text;
  if (navigator.onLine === false) {
    text = `<span class="offline">Offline</span> · showing saved prices`;
  } else if (!state.items.length) {
    text = esc(storeNames().replace(' and ', ' · ').replace(/, /g, ' · '));
  } else {
    const times = data?.rows.flatMap((r) => Object.values(r.status).map((s) => s.at).filter(Boolean)) || [];
    const latest = times.length ? Math.max(...times) : null;
    text = `${open} to buy${busy ? ' · checking prices…' : latest ? ` · updated ${relTime(latest)}` : ''}`;
  }
  if (meta.innerHTML !== text) meta.innerHTML = text;
}

let lastHeroTotal = null;
let heroObserver = null;

function splitBar(summary, stores) {
  const segs = stores
    .map((id) => ({ s: storeById(id), t: summary.split.byStore[id].total }))
    .filter((x) => x.t > 0)
    .map((x) => `<span style="--c:${esc(x.s.color)};flex-grow:${x.t}" title="${esc(x.s.name)} ${money(x.t)}"></span>`)
    .join('');
  return `<span class="split-bar" aria-hidden="true">${segs}</span>`;
}

function savePill(summary) {
  if (summary.storesUsed.length > 1 && summary.savings > 0) {
    return `<span class="save-pill">${icon('sparkle')}Save ${money(summary.savings)}</span>`;
  }
  if (summary.storesUsed.length === 1) {
    return `<span class="save-pill quiet">${esc(storeById(summary.storesUsed[0])?.name)} wins</span>`;
  }
  return '';
}

function splitLine(summary) {
  const used = summary.storesUsed.map((id) => esc(storeById(id)?.name));
  if (!used.length) return 'Finding prices…';
  const missing = summary.split.missing ? ` · ${summary.split.missing} not found` : '';
  return used.length === 1 ? `Everything at ${used[0]}${missing}` : `Split across ${used.join(' + ')}${missing}`;
}

function renderHero(data) {
  const slot = $('#hero-slot');
  if (!data) {
    slot.innerHTML = '';
    lastHeroTotal = null;
    return;
  }
  const { summary, stores } = data;
  const cards = stores
    .map((id) => {
      const s = storeById(id);
      const t = summary.perStore[id];
      const cheapest = summary.cheapestStore === id && t.found > 0;
      const note = !t.found ? 'no prices yet' : t.missing ? `${t.missing} missing` : cheapest ? 'cheapest' : 'all items';
      return `<span class="hs${cheapest ? ' cheapest' : ''}"><span class="hs-name"><i class="dot" style="--c:${esc(s.color)}"></i><span>${esc(s.name)}</span></span><b>${t.found ? money(t.total) : '—'}</b><small>${note}</small></span>`;
    })
    .join('');
  const pending = summary.split.found === 0;
  const from = lastHeroTotal ?? summary.split.total;
  slot.innerHTML = `<button class="hero" data-action="open-summary" aria-label="Open basket details">
      <span class="hero-deco">${icon('trolley')}</span>
      <span class="hero-top"><span class="eyebrow">Best split</span>${savePill(summary)}</span>
      ${pending ? '<span class="hero-total pending" aria-label="Finding prices"><i></i></span>' : `<span class="hero-total" data-value="${from}">${money(from)}</span>`}
      <span class="hero-sub">${splitLine(summary)}</span>
      ${splitBar(summary, stores)}
      <span class="hero-stores" style="--n:${stores.length}">${cards}</span>
    </button>`;
  if (!pending) {
    tweenNumber($('.hero-total', slot), summary.split.total, money);
    lastHeroTotal = summary.split.total;
  }
  if (heroObserver) {
    heroObserver.disconnect();
    heroObserver.observe($('.hero', slot));
  }
}

function renderFloat(data) {
  const el = $('#float-total');
  if (!data) {
    el.classList.remove('show');
    return;
  }
  const { summary } = data;
  const save = summary.storesUsed.length > 1 && summary.savings > 0 ? `<span class="save-pill">Save ${money(summary.savings)}</span>` : '';
  el.innerHTML = `${icon('trolley')}<b>${money(summary.split.total)}</b>${save}${icon('chevron')}`;
  el.classList.toggle('show', ui.heroHidden && !ui.sheet);
}

function deltaText(d) {
  if (d < 0.005) return '';
  return d < 1 ? `+${Math.round(d * 100)}¢` : `+$${d.toFixed(2)}`;
}

function chipHtml(store, m, bestCost) {
  const st = m.status[store.id] || {};
  const pick = m.picks[store.id];
  const cls = ['chip'];
  let v;
  let extra = '';
  let title = store.name;
  if (pick) {
    v = money(pick.cost);
    if (bestCost != null && cmpCost(pick) <= bestCost + 0.004) {
      cls.push('win');
      extra = `${icon('check')}best`;
    } else if (bestCost != null) {
      extra = deltaText(cmpCost(pick) - bestCost);
    }
    if (pick.sizeNote) {
      cls.push('warn');
      v = `≈${v}`;
      title += ` · ${pick.sizeNote}`;
    }
    if (pick.chosen) {
      cls.push('mine');
      title += ' · your pick';
    }
    if (st.loading) cls.push('stale');
  } else if (st.loading && !st.hasData) {
    cls.push('loading');
    v = '';
  } else if (st.error && !st.hasData) {
    cls.push('err');
    v = '!';
    extra = 'offline';
    title += `: ${st.error}`;
  } else {
    cls.push('none');
    v = '—';
    extra = m.suggestions?.[store.id] ? 'other size' : 'no match';
    title += m.suggestions?.[store.id] ? ': nothing near this size' : ': no match';
  }
  if (pick?.sizeNote) extra = pick.sizeNote.replace(' size', '');
  return `<span class="${cls.join(' ')}" title="${esc(title)}">${mono(store)}<span class="cv"><b class="v">${esc(v)}</b><small>${extra}</small></span></span>`;
}

function rowHtml(item, stores) {
  const m = matchFor(item);
  const best = bestStoreFor(m);
  const bp = best ? m.picks[best] : null;
  const bestStore = storeById(best);
  const anyLoading = stores.some((s) => m.status[s.id]?.loading && !m.status[s.id]?.hasData);
  const allErr = stores.length && stores.every((s) => m.status[s.id]?.error && !m.status[s.id]?.hasData);
  const sub = bp
    ? `${bp.packs > 1 ? `${bp.packs} × ` : ''}${esc(bp.product.name)}`
    : anyLoading
      ? 'Finding the cheapest…'
      : allErr
        ? 'Couldn’t reach the stores'
        : 'No match yet — tap to look';
  const fresh = ui.fresh.has(item.id);
  const done = item.checked;
  return `<li class="row${fresh ? ' new' : ''}${done ? ' done' : ''}" data-swipe data-id="${esc(item.id)}">
      <div class="swipe-bg" aria-hidden="true">
        <span class="sw-left">${icon(done ? 'undo' : 'check')}${done ? 'Back to list' : 'In trolley'}</span>
        <span class="sw-right">Remove${icon('trash')}</span>
      </div>
      <div class="swipe-card card item-card">
        <button class="tick" data-action="toggle" aria-pressed="${done}" aria-label="${done ? 'Untick' : 'Tick off'} ${esc(item.text)}"></button>
        <div class="item-main" data-action="open-item">
          <div class="item-top">
            <span class="avatar" aria-hidden="true">${emojiFor(itemInfo(item).name)}</span>
            <div class="titles">
              <div class="item-name"><span>${esc(item.text)}</span>${item.qty > 1 ? `<span class="qty">×${item.qty}</span>` : ''}</div>
              <div class="item-sub">${sub}</div>
            </div>
            ${bp ? `<div class="best"><b>${money(bp.cost)}</b><small>${mono(bestStore)}${esc(bestStore.name)}</small></div>` : ''}
          </div>
        </div>
        ${done ? '' : `<div class="chips" data-action="open-item" style="--n:${stores.length}">${stores.map((s) => chipHtml(s, m, bp ? cmpCost(bp) : null)).join('')}</div>`}
      </div>
    </li>`;
}

function storeNames() {
  const names = (enabledStores().length ? enabledStores() : state.stores).map((s) => s.name);
  if (!names.length) return 'Woolworths, Coles and ALDI';
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

function emptyHtml() {
  return `<section class="empty">
      <div class="empty-art" aria-hidden="true">
        <div class="blob"></div>${icon('trolley')}
        <span class="f f1">🥑</span><span class="f f2">🥛</span><span class="f f3">🍞</span><span class="f f4">🍌</span>
      </div>
      <h2>Your trolley is empty</h2>
      <p>Add what you need. Trolley finds the cheapest sensible match at ${esc(storeNames())} for every item.</p>
      <div class="quick">${QUICK_ADDS.map((t) => `<button class="pill" data-action="quick" data-text="${esc(t)}"><span class="em">${emojiFor(t)}</span>${esc(t)}</button>`).join('')}</div>
      <ol class="how">
        <li><span class="n">1</span><span>Type items the way you'd write them: <b>2 x milk 2L</b>, <b>6 bananas</b>, <b>eggs dozen</b>.</span></li>
        <li><span class="n">2</span><span>Each store's cheapest sensible match is picked by unit price. Tap an item to choose a different one — it's remembered.</span></li>
        <li><span class="n">3</span><span>Follow the best split, and swipe right to tick things off as you shop.</span></li>
      </ol>
    </section>`;
}

function renderMain() {
  const main = $('#main');
  if (!state.items.length) {
    if (!main.querySelector('.empty')) main.innerHTML = emptyHtml();
    return;
  }
  const stores = enabledStores();
  const todo = state.items.filter((i) => !i.checked);
  const done = state.items.filter((i) => i.checked);
  let html = '';
  if (todo.length) {
    html += `<div class="section-head"><h2>To buy</h2><span class="count">${todo.length}</span></div>`;
    html += `<ul class="list">${todo.map((i) => rowHtml(i, stores)).join('')}</ul>`;
    if (state.items.length <= 3) html += `<p class="hint-line" style="margin-top:10px">Tip: swipe right to tick off, left to remove. Tap an item for every option.</p>`;
  }
  if (done.length) {
    html += `<div class="section-head"><h2>In the trolley</h2><span class="count">${done.length}</span><button class="link-btn" data-action="clear-checked">Clear</button></div>`;
    html += `<ul class="list">${done.map((i) => rowHtml(i, stores)).join('')}</ul>`;
  }
  main.innerHTML = html;
  if (ui.fresh.size) setTimeout(() => ui.fresh.clear(), 500);
}

function renderComposerIcon() {
  const input = $('#add-input');
  const slot = $('#composer-icon');
  const current = input.value.split(',').pop().trim();
  const e = current ? emojiFor(parseItem(current).name) : '🛒';
  if (slot.dataset.e !== e) {
    slot.dataset.e = e;
    slot.textContent = e;
  }
}

function renderSuggest() {
  const box = $('#suggest');
  const input = $('#add-input');
  const q = input.value.split(',').pop().trim().toLowerCase();
  const inList = new Set(state.items.map((i) => i.text.toLowerCase()));
  let list = state.history.filter((h) => !inList.has(h.text.toLowerCase()));
  if (q) list = list.filter((h) => h.text.toLowerCase().includes(q) && h.text.toLowerCase() !== q);
  list = list
    .sort((a, b) => (q ? Number(b.text.toLowerCase().startsWith(q)) - Number(a.text.toLowerCase().startsWith(q)) : 0) || b.n - a.n || b.at - a.at)
    .slice(0, 10);
  if (!ui.composerFocused || !list.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML =
    (q ? '' : '<span class="suggest-label">Add again</span>') +
    list.map((h) => `<button class="pill" type="button" data-action="suggest" data-text="${esc(h.text)}"><span class="em">${emojiFor(parseItem(h.text).name)}</span>${esc(h.text)}</button>`).join('');
}

// ---------- sheets ----------

function sheetKey(sheet) {
  return sheet ? `${sheet.type}:${sheet.id || ''}` : '';
}

function openSheet(sheet) {
  ui.sheet = sheet;
  const el = $('#sheet');
  el.classList.toggle('full', sheet.type === 'welcome');
  renderSheet();
  if (!el.open) el.showModal();
  $('#float-total').classList.remove('show');
  // Don't pop the keyboard up just from opening a sheet.
  if (sheet.type !== 'welcome') $('#sheet-body').focus({ preventScroll: true });
}

function closeSheet() {
  ui.sheet = null;
  ui.locations = null;
  const el = $('#sheet');
  if (el.open) el.close();
  render();
}

function renderSheet() {
  if (!ui.sheet) return;
  const body = $('#sheet-body');
  const key = sheetKey(ui.sheet);
  const same = body.dataset.key === key;
  const active = document.activeElement;
  // Don't redraw the sheet under someone who is typing in it.
  if (same && active && body.contains(active) && active.tagName === 'INPUT' && !['checkbox', 'file'].includes(active.type)) return;
  const html = { item: itemSheet, settings: settingsSheet, summary: summarySheet, welcome: welcomeSheet }[ui.sheet.type]?.();
  if (html == null) return closeSheet();
  const scroll = same ? $('.sheet-scroll', body)?.scrollTop || 0 : 0;
  body.innerHTML = html;
  body.dataset.key = key;
  const sc = $('.sheet-scroll', body);
  if (sc) sc.scrollTop = scroll;
}

const closeBtn = () => `<button class="icon-btn plain" data-action="close" aria-label="Close">${icon('x')}</button>`;

function itemSheet() {
  const item = state.items.find((i) => i.id === ui.sheet.id);
  if (!item) return null;
  const m = matchFor(item);
  const stores = enabledStores();
  const storeId = ui.sheet.store && storeById(ui.sheet.store) ? ui.sheet.store : bestStoreFor(m) || stores[0]?.id;
  const store = storeById(storeId);
  const best = bestStoreFor(m);
  const tabs = stores
    .map((s) => {
      const p = m.picks[s.id];
      const price = p ? money(p.cost) : m.status[s.id]?.loading ? '…' : '—';
      return `<button class="${s.id === storeId ? 'on' : ''}" data-action="tab" data-store="${esc(s.id)}" aria-pressed="${s.id === storeId}">
          <span class="seg-top">${mono(s)}<span class="seg-price${s.id === best ? ' best' : ''}">${price}</span></span><span class="seg-name">${esc(s.name)}</span></button>`;
    })
    .join('');
  const target = m.target
    ? `Comparing <b>${esc(m.target.label)}</b>${m.target.inferred ? ' (the usual size)' : ''} · lowest unit price within ±25%`
    : 'Lowest price wins';
  const bp = best ? m.picks[best] : null;
  return `<div class="grip"></div>
    <header class="sheet-head">
      <span class="avatar lg" aria-hidden="true">${emojiFor(m.info.name)}</span>
      <div class="grow">
        <input id="item-text" class="title-input" value="${esc(item.text)}" aria-label="Item name" enterkeyhint="done" autocomplete="off" />
        <p class="meta">${target}</p>
      </div>
      ${closeBtn()}
    </header>
    <div class="sheet-scroll">
      <div class="group"><div class="cell">
        <span class="grow"><b>Quantity</b><small>${bp ? `Cheapest: ${money(bp.cost)} at ${esc(storeById(best)?.name)}` : 'Add a size like “milk 2L” to be exact'}</small></span>
        <div class="stepper" role="group" aria-label="Quantity">
          <button data-action="qty" data-delta="-1" aria-label="One less">${icon('minus')}</button><span>${item.qty}</span><button data-action="qty" data-delta="1" aria-label="One more">${icon('plus')}</button>
        </div>
      </div></div>
      <nav class="seg" aria-label="Store">${tabs}</nav>
      ${store ? storeOptions(item, m, store) : `<p class="note">${icon('info')}No stores are switched on — see Settings.</p>`}
      <div class="sheet-foot">
        <button class="btn" data-action="refetch">${icon('refresh')}Refresh</button>
        <button class="btn danger" data-action="delete">${icon('trash')}Remove</button>
      </div>
    </div>`;
}

function storeOptions(item, m, store) {
  const st = m.status[store.id] || {};
  const pick = m.picks[store.id];
  const memo = state.memory[m.info.key]?.[store.id];
  const opts = (m.options[store.id] || []).slice(0, OPTIONS_SHOWN);
  const notes = [];
  if (st.loading) notes.push(`<p class="note">${icon('refresh')}<span>Checking ${esc(store.name)}…</span></p>`);
  if (st.error) notes.push(`<p class="note bad">${icon('alert')}<span>${esc(st.error)}${st.hasData ? ' — showing earlier prices.' : ''}</span></p>`);
  if (pick?.lostChoice) notes.push(`<p class="note warn">${icon('info')}<span>Your pick “${esc(pick.lostChoice.name)}” isn't listed right now, so the cheapest match is shown.</span></p>`);
  const sugg = m.suggestions?.[store.id];
  if (!pick && sugg) notes.push(`<p class="note warn">${icon('scale')}<span>Nothing near ${esc(m.target?.label)} here. Closest is ${esc(sugg.product.name)} — tap it to use it.</span></p>`);
  if (store.defaultLocation) notes.push(`<p class="note">${icon('pin')}<span>Prices for ${esc(locLabel(store))}.</span></p>`);

  const fitting = opts.filter((o) => o.sensible && o.fits && o.unitCost > 0);
  const minUnit = fitting.length ? Math.min(...fitting.map((o) => o.unitCost)) : null;
  const emoji = emojiFor(m.info.name);
  const rows = opts.map((o) => {
    const p = o.product;
    const selected = pick && String(pick.product.id) === String(p.id);
    const unit = formatUnitPrice(p.unitPrice, p.unitMeasure);
    const mult = o.packs * item.qty;
    const badges = [
      selected && !memo ? '<em class="badge auto">Auto pick</em>' : '',
      selected && memo ? '<em class="badge mine">Your pick</em>' : '',
      p.promo ? `<em class="badge promo">${esc(p.promo)}</em>` : '',
      !o.fits && o.sensible ? '<em class="badge warn">Other size</em>' : '',
      p.available === false ? '<em class="badge">Unavailable</em>' : '',
    ].join('');
    const vbar = minUnit && o.sensible && o.fits ? `<span class="vbar" title="Value for money"><i style="width:${Math.max(8, Math.round((minUnit / o.unitCost) * 100))}%"></i></span>` : '';
    return `<li class="opt${selected ? ' selected' : ''}${o.sensible ? '' : ' faint'}">
        <button class="opt-main" data-action="choose" data-store="${esc(store.id)}" data-pid="${esc(p.id)}">
          <span class="thumb${p.image ? '' : ' noimg'}">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}<span class="ph">${emoji}</span>${mono(store)}</span>
          <span class="opt-text">
            <span class="opt-name">${esc(p.name)}</span>
            <span class="opt-meta">${esc(p.size || '')}${unit ? ` · ${esc(unit)}` : ''}${p.wasPrice ? ` · was <s>${money(p.wasPrice)}</s>` : ''}</span>
            ${vbar}
            ${badges ? `<span class="badges">${badges}</span>` : ''}
          </span>
          <span class="opt-price">${money(p.price)}${mult > 1 ? `<small>×${mult} = ${money(o.cost)}</small>` : ''}</span>
        </button>
        ${p.url ? `<a class="opt-link" href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Open on ${esc(store.name)}">${icon('external')}</a>` : ''}
      </li>`;
  });
  return `${notes.join('')}
    <div class="mode">
      <button class="pill${!memo ? ' on' : ''}" data-action="auto" data-store="${esc(store.id)}">${icon('sparkle')}Auto: cheapest</button>
      <button class="pill${memo?.none ? ' on' : ''}" data-action="none" data-store="${esc(store.id)}">Skip ${esc(store.name)}</button>
    </div>
    ${rows.length ? `<ul class="opts">${rows.join('')}</ul>` : st.loading ? '' : `<p class="note">${icon('info')}<span>No products found at ${esc(store.name)}.</span></p>`}`;
}

function summarySheet() {
  const { rows, stores, summary } = currentSummary();
  const max = Math.max(1, ...stores.map((id) => summary.perStore[id].total));
  const compare = stores
    .map((id) => {
      const s = storeById(id);
      const t = summary.perStore[id];
      const cheapest = summary.cheapestStore === id && t.found > 0;
      const note = !t.found ? 'no prices' : t.missing ? `${t.missing} missing` : cheapest ? 'cheapest' : 'all items';
      return `<div class="cmp-row${cheapest ? ' cheapest' : ''}">
          <span class="cmp-name">${mono(s)}${esc(s.name)}</span>
          <span class="cmp-bar"><i style="--c:${esc(s.color)};width:${t.found ? Math.max(4, (t.total / max) * 100) : 0}%"></i></span>
          <span class="cmp-val">${t.found ? money(t.total) : '—'}<small>${note}</small></span>
        </div>`;
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
          const n = r.info.qty * p.packs;
          return `<div class="plan-row${r.item.checked ? ' checked' : ''}">
              <button class="tick" data-action="toggle" data-id="${esc(r.item.id)}" aria-pressed="${r.item.checked}" aria-label="Tick off ${esc(r.item.text)}"></button>
              <span class="plan-name">${n > 1 ? `${n} × ` : ''}${esc(p.product.name)}${p.sizeNote ? ' <em class="badge warn">≈ size</em>' : ''}<small>${esc(r.item.text)}</small></span>
              <span class="num">${money(p.cost)}</span>
            </div>`;
        })
        .join('');
      return `<div class="group plan"><div class="plan-head">${mono(s, 'lg')}<b>${esc(s.name)}</b><span class="count">${plural(g.items.length, 'item')}</span><span class="num">${money(g.total)}</span></div>${lines}</div>`;
    })
    .join('');
  const unmatched = rows.filter((r, i) => !summary.split.assignment[i]);
  return `<div class="grip"></div>
    <header class="sheet-head"><h2>Your basket</h2>
      <button class="icon-btn plain" data-action="share" aria-label="Share the plan">${icon('share')}</button>
      ${closeBtn()}
    </header>
    <div class="sheet-scroll">
      <div class="basket-hero">
        <span class="hero-deco">${icon('trolley')}</span>
        <div class="hero-top"><span class="eyebrow">Best split</span>${savePill(summary)}</div>
        <div class="hero-total">${money(summary.split.total)}</div>
        <div class="hero-sub">${splitLine(summary)}</div>
        ${splitBar(summary, stores)}
      </div>
      <p class="group-title">If you shop at one store</p>
      <div class="group compare">${compare}</div>
      ${pair && summary.storesUsed.length > 2 ? `<p class="note">${icon('store')}<span>Only want two stops? <b>${pair.stores.map((id) => esc(storeById(id)?.name)).join(' + ')}</b> comes to ${money(pair.total)}${pair.missing ? ` (${pair.missing} missing)` : ''}.</span></p>` : ''}
      ${warn ? `<p class="note warn">${icon('scale')}<span>${plural(warn, 'item')} in the plan ${warn > 1 ? 'use' : 'uses'} a different pack size (≈). Worth a look.</span></p>` : ''}
      <p class="group-title">Shopping plan</p>
      ${plan || `<p class="note">${icon('info')}<span>Prices are still loading.</span></p>`}
      ${unmatched.length ? `<p class="note">${icon('info')}<span>Not found anywhere: ${unmatched.map((r) => esc(r.item.text)).join(', ')}</span></p>` : ''}
      <div class="sheet-foot"><button class="btn primary" data-action="share">${icon('share')}Share this plan</button></div>
    </div>`;
}

function settingsSheet() {
  const s = state.settings;
  const storeCells = state.stores
    .map((st) => {
      const on = !s.disabled.includes(st.id);
      const where = st.hasLocations || st.defaultLocation ? esc(locLabel(st)) : 'National online prices';
      let cells = `<label class="cell">${mono(st, 'lg')}<span class="grow"><b>${esc(st.name)}</b><small>${where}</small></span>
          <span class="switch"><input type="checkbox" data-action="toggle-store" data-store="${esc(st.id)}" ${on ? 'checked' : ''} aria-label="Use ${esc(st.name)}" /><span></span></span></label>`;
      if (st.hasLocations && on) {
        cells += `<button class="cell" data-action="find-loc" data-store="${esc(st.id)}"><span class="lead">${icon('pin')}</span><span class="grow">Use my nearest ${esc(st.name)}<small>Prices can differ between stores</small></span>${icon('chevron', 'chev')}</button>`;
        if (ui.locations?.store === st.id) {
          if (ui.locations.busy) cells += `<div class="cell"><span class="grow"><small>Finding stores near you…</small></span></div>`;
          else if (ui.locations.error) cells += `<div class="cell"><span class="grow"><small style="color:var(--bad)">${esc(ui.locations.error)}</small></span></div>`;
          else
            cells += ui.locations.list
              .map(
                (l) => `<button class="cell" data-action="pick-loc" data-store="${esc(st.id)}" data-loc="${esc(l.id)}" data-label="${esc(l.label)}">
                  <span class="lead">${locFor(st) === l.id ? icon('check') : ''}</span><span class="grow"><b>${esc(l.label)}</b><small>${esc(l.detail || '')}</small></span></button>`,
              )
              .join('');
        }
      }
      return cells;
    })
    .join('');
  const status = ui.status
    ? ui.status.results
        .map((r) => {
          const st = storeById(r.store);
          return `<div class="cell"><span class="status-dot ${r.ok ? 'ok' : 'bad'}"></span><span class="grow"><b>${esc(st?.name || r.store)}</b><small>${r.ok ? `Working · ${r.count} products in ${(r.ms / 1000).toFixed(1)}s` : esc(r.error)}</small></span></div>`;
        })
        .join('') +
      `<div class="cell"><span class="grow"><small>Checked ${ui.status.colo ? `from Cloudflare ${esc(ui.status.colo)} ` : ''}at ${new Date(ui.status.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></span></div>`
    : '';
  const memoCount = Object.keys(state.memory).length;
  const theme = s.theme || 'system';
  return `<div class="grip"></div>
    <header class="sheet-head"><h2>Settings</h2>${closeBtn()}</header>
    <div class="sheet-scroll">
      ${
        DEMO
          ? `<p class="note warn">${icon('info')}<span>This is a demo using real prices captured on 28 Sep 2026. Deploy your own copy for live prices.</span></p>`
          : `<p class="group-title">Passcode</p>
      <form class="group" data-form="passcode"><div class="cell"><span class="lead">${icon('key')}</span>
        <input id="passcode" type="password" value="${esc(s.passcode)}" placeholder="APP_PASSCODE" autocomplete="current-password" aria-label="Passcode" />
        <button class="link-btn">Save</button></div></form>`
      }
      <p class="group-title">Stores</p>
      <div class="group">${storeCells}</div>
      <div class="group">
        <button class="cell" data-action="status" ${ui.statusBusy ? 'disabled' : ''}><span class="lead">${icon('pulse')}</span><span class="grow">${ui.statusBusy ? 'Checking stores…' : 'Check stores now'}<small>Live test of every store's search</small></span>${icon('chevron', 'chev')}</button>
        ${status}
      </div>
      <p class="group-title">Appearance</p>
      <div class="seg small">${['system', 'light', 'dark'].map((t) => `<button class="${theme === t ? 'on' : ''}" data-action="theme" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <p class="group-title">Your list</p>
      <div class="group">
        <button class="cell" data-action="refresh-all"><span class="lead">${icon('refresh')}</span><span class="grow">Refresh all prices</span></button>
        <button class="cell" data-action="share"><span class="lead">${icon('share')}</span><span class="grow">Share the list</span></button>
        ${
          DEMO
            ? ''
            : `<button class="cell" data-action="export"><span class="lead">${icon('download')}</span><span class="grow">Back up list<small>Save a file you can restore on any phone</small></span></button>
        <label class="cell"><span class="lead">${icon('upload')}</span><span class="grow">Restore a backup</span><input type="file" accept="application/json,.json" data-action="import" hidden /></label>`
        }
        <button class="cell" data-action="forget" ${memoCount ? '' : 'disabled'}><span class="lead">${icon('sparkle')}</span><span class="grow">Forget my product picks<small>${memoCount ? `${plural(memoCount, 'item')} with a hand-picked product` : 'None yet'}</small></span></button>
      </div>
      <div class="group">
        <button class="cell danger" data-action="clear-checked"><span class="lead">${icon('check')}</span><span class="grow">Remove ticked items</span></button>
        <button class="cell danger" data-action="clear-all"><span class="lead">${icon('trash')}</span><span class="grow">Delete the whole list</span></button>
      </div>
      <p class="note">${icon('info')}<span>Your list, picks and settings are stored only on this phone. Prices refresh every 12 hours, or when you tap ↻.</span></p>
    </div>`;
}

function welcomeSheet() {
  const reason = ui.sheet.reason;
  const msg =
    reason === 'passcode-not-set'
      ? `<p class="note bad">${icon('alert')}<span>Your server has no passcode yet. In Cloudflare, open the Worker → Settings → Variables and Secrets, add a secret called <b>APP_PASSCODE</b>, then enter it here.</span></p>`
      : reason === 'bad-passcode'
        ? `<p class="note bad">${icon('alert')}<span>That passcode didn't match. Check the APP_PASSCODE secret in Cloudflare.</span></p>`
        : '';
  const stores = state.stores.length
    ? state.stores
    : [
        { name: 'Woolworths', color: '#178841' },
        { name: 'Coles', color: '#e01a22' },
        { name: 'ALDI', color: '#00457c' },
      ];
  return `<div class="welcome">
      <span class="logo" aria-hidden="true">${icon('trolley')}</span>
      <h1>Your list, priced <em>three ways</em>.</h1>
      <p class="lead">Trolley checks every item at each supermarket, picks the cheapest sensible match by unit price, and shows you the best way to split your shop.</p>
      <div class="store-row">${stores.map((s) => `<span class="st">${mono(s, 'lg')}${esc(s.name)}</span>`).join('')}</div>
      ${msg}
      <div class="spacer"></div>
      <form data-form="passcode">
        <label for="passcode">Passcode</label>
        <div class="field">${icon('key')}<input id="passcode" type="password" value="${esc(state.settings.passcode)}" placeholder="Your APP_PASSCODE" autocomplete="current-password" required /></div>
        <button class="btn primary">Get started${icon('chevron')}</button>
        <p class="note">${icon('info')}<span>It's the APP_PASSCODE secret you set in Cloudflare. It keeps your price server private and stays on this phone.</span></p>
      </form>
    </div>`;
}

// ---------- small helpers ----------

let toastTimer = null;
function toast(text, action = null) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button">${action.icon ? icon(action.icon) : ''}${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  if (action) {
    $('button', t).onclick = () => {
      t.hidden = true;
      action.run();
    };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 5000 : 3000);
}

function applyTheme() {
  const t = state.settings.theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') {
    root.dataset.theme = t;
    root.dataset.themeByApp = '1';
  } else if (root.dataset.themeByApp) {
    // Only undo a theme we set ourselves (a host page may set its own).
    delete root.dataset.theme;
    delete root.dataset.themeByApp;
  }
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bg || '#f6f4ee');
}

async function savePasscode(value) {
  state.settings.passcode = value.trim();
  save();
  try {
    await api.auth(state.settings.passcode);
    toast('You’re all set');
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
  if (DEMO) return api.locations('', storeId, -27.4698, 153.0251).then((res) => ((ui.locations = { store: storeId, list: res.locations }), renderSheet()));
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

function planText() {
  const { rows, stores, summary } = currentSummary();
  const saving = summary.savings > 0 && summary.storesUsed.length > 1 ? ` (saves ${money(summary.savings)})` : '';
  const lines = [`🛒 Trolley — best split ${money(summary.split.total)}${saving}`];
  for (const id of stores) {
    const g = summary.split.byStore[id];
    if (!g.items.length) continue;
    lines.push('', `${storeById(id).name} · ${money(g.total)}`);
    for (const i of g.items) {
      const r = rows[i];
      const p = r.picks[id];
      const n = r.info.qty * p.packs;
      lines.push(`${r.item.checked ? '✓' : '•'} ${n > 1 ? `${n} × ` : ''}${p.product.name} — ${money(p.cost)}`);
    }
  }
  const missing = rows.filter((r, i) => !summary.split.assignment[i]);
  if (missing.length) lines.push('', `Not found: ${missing.map((r) => r.item.text).join(', ')}`);
  return lines.join('\n');
}

async function sharePlan() {
  if (!state.items.length) return toast('Add some items first');
  const text = planText();
  try {
    if (navigator.share) return await navigator.share({ title: 'Trolley list', text });
  } catch (err) {
    if (err?.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Plan copied — paste it anywhere');
  } catch {
    toast('Couldn’t share from here');
  }
}

function exportList() {
  const data = JSON.stringify({ app: 'grocery', version: 1, exportedAt: new Date().toISOString(), items: state.items, memory: state.memory, history: state.history }, null, 1);
  const file = new File([data], `trolley-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: 'Trolley backup' }).catch(() => {});
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
    if (!Array.isArray(data.items)) throw new Error('not a Trolley backup');
    const have = new Set(state.items.map((i) => i.text.toLowerCase()));
    const added = data.items.filter((i) => i && i.text && !have.has(String(i.text).toLowerCase())).map((i) => ({ ...i, id: newId() }));
    state.items.push(...added);
    state.memory = { ...(data.memory || {}), ...state.memory };
    for (const h of data.history || []) if (h?.text) rememberText(h.text);
    save();
    bump();
    render();
    refreshAll();
    toast(`Restored ${plural(added.length, 'item')}`);
  } catch (err) {
    toast(`Couldn’t restore: ${err.message}`);
  }
}

// ---------- events ----------

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) {
    if (e.target === $('#sheet') && ui.sheet?.type !== 'welcome') closeSheet(); // tap on the backdrop
    return;
  }
  if (el.tagName === 'INPUT') return; // handled by change events
  const action = el.dataset.action;
  const row = el.closest('[data-id]');
  const itemId = el.dataset.id || row?.dataset.id || ui.sheet?.id;
  const item = state.items.find((i) => i.id === itemId);
  switch (action) {
    case 'toggle':
      if (item) toggleItem(item.id);
      break;
    case 'open-item':
      // Start on the cheapest store's tab, and stay there while prices update.
      if (item) openSheet({ type: 'item', id: itemId, store: bestStoreFor(matchFor(item)) || enabledStores()[0]?.id });
      break;
    case 'open-summary':
      if (state.items.length) openSheet({ type: 'summary' });
      break;
    case 'open-settings':
      openSheet({ type: 'settings' });
      break;
    case 'close':
      closeSheet();
      break;
    case 'quick':
    case 'suggest':
      addItem(el.dataset.text);
      if (action === 'suggest') {
        const input = $('#add-input');
        input.value = input.value.includes(',') ? input.value.replace(/[^,]*$/, ' ') : '';
        renderSuggest();
        renderComposerIcon();
      }
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
      if (opt) {
        remember(item, el.dataset.store, { id: opt.product.id, name: opt.product.name });
        navigator.vibrate?.(8);
      }
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
      if (item) removeItem(item.id);
      break;
    case 'refresh':
    case 'refresh-all':
      if (!state.items.length) return toast('Nothing to refresh yet');
      refreshAll({ force: true });
      toast('Refreshing prices…');
      break;
    case 'share':
      sharePlan();
      break;
    case 'status':
      checkStatus();
      break;
    case 'theme':
      state.settings.theme = el.dataset.theme;
      save();
      applyTheme();
      renderSheet();
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
    case 'clear-checked': {
      const n = state.items.filter((i) => i.checked).length;
      if (!n) return toast('Nothing ticked yet');
      state.items = state.items.filter((i) => !i.checked);
      save();
      pruneResults(keepKeys());
      render();
      toast(`Cleared ${plural(n, 'item')}`);
      break;
    }
    case 'forget': {
      const before = state.memory;
      state.memory = {};
      save();
      bump();
      render();
      toast('Forgot your product picks', { label: 'Undo', icon: 'undo', run: () => ((state.memory = before), save(), bump(), render()) });
      break;
    }
    case 'export':
      exportList();
      break;
    case 'clear-all': {
      if (!state.items.length) return toast('The list is already empty');
      const before = state.items;
      state.items = [];
      save();
      closeSheet();
      toast(`Deleted ${plural(before.length, 'item')}`, { label: 'Undo', icon: 'undo', run: () => ((state.items = before), save(), render()) });
      setTimeout(() => pruneResults(keepKeys()), 6000);
      break;
    }
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
    const parts = input.value.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return input.focus();
    for (const part of parts.reverse()) addItem(part);
    input.value = '';
    input.focus();
    renderSuggest();
    renderComposerIcon();
  } else if (form.dataset.form === 'passcode') {
    savePasscode($('#passcode', form).value);
  }
}

// ---------- start ----------

async function start() {
  load();
  applyTheme();
  $('.logo').innerHTML = icon('trolley');
  $('#refresh').innerHTML = icon('refresh');
  $('#settings-btn').innerHTML = icon('settings');
  $('#add-btn').innerHTML = icon('plus');
  if (DEMO) $('#demo-badge').innerHTML = '<span class="demo-badge">DEMO</span>';

  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('submit', onSubmit);
  // Product photos that fail to load fall back to the item's emoji.
  document.addEventListener('error', (e) => e.target.tagName === 'IMG' && e.target.closest('.thumb')?.classList.add('noimg'), true);

  const input = $('#add-input');
  input.addEventListener('input', () => {
    renderComposerIcon();
    renderSuggest();
  });
  input.addEventListener('focus', () => {
    ui.composerFocused = true;
    renderSuggest();
  });
  input.addEventListener('blur', () => {
    ui.composerFocused = false;
    setTimeout(renderSuggest, 150);
  });
  // Keep the keyboard up while tapping suggestions.
  $('#suggest').addEventListener('pointerdown', (e) => e.preventDefault());

  const sheet = $('#sheet');
  sheet.addEventListener('close', () => {
    if (!ui.sheet) return;
    ui.sheet = null;
    ui.locations = null;
    render();
  });
  sheet.addEventListener('cancel', (e) => {
    if (ui.sheet?.type === 'welcome') e.preventDefault();
  });
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'item-text') e.target.blur();
  });
  enableSheetDrag(sheet, () => ui.sheet?.type !== 'welcome' && closeSheet());
  enableSwipe($('#main'), (row, dir) => {
    const id = row.dataset.id;
    if (dir === 'right') toggleItem(id);
    else removeItem(id);
  });

  heroObserver = new IntersectionObserver(
    ([entry]) => {
      ui.heroHidden = !entry.isIntersecting;
      $('#float-total').classList.toggle('show', ui.heroHidden && state.items.length > 0 && !ui.sheet);
    },
    { threshold: 0, rootMargin: '-70px 0px 0px 0px' },
  );
  addEventListener('online', () => {
    render();
    refreshAll();
  });
  addEventListener('offline', render);
  setInterval(() => renderHeader(state.items.length ? currentSummary() : null), 60000);

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
    if (!state.stores.length) toast('Can’t reach the price server — showing saved prices');
  }
  if (DEMO && !state.items.length && !state.history.length && api.seed) {
    for (const t of [...api.seed.items].reverse()) addItem(t);
    for (const t of api.seed.history) rememberText(t);
    save();
  }
  if (!state.settings.passcode && !DEMO) openSheet({ type: 'welcome' });
  else refreshAll();
  persistStorage();
  pruneResults(keepKeys());

  if (!DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAll();
  });
}

start();

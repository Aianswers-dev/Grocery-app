#!/usr/bin/env node
// Live test of every store plug-in: searches real supermarket sites and shows what the
// app would pick. Run from a computer:  npm run check-stores
//
//   npm run check-stores -- --q "milk 2L" --q bananas     custom items
//   npm run check-stores -- --store coles                 one store only
//   npm run check-stores -- --worker https://grocery-app.<you>.workers.dev --passcode XXXX
//                                                         ask a deployed Worker instead
import { spawnSync } from 'node:child_process';

// Node only honours HTTPS_PROXY when NODE_USE_ENV_PROXY is set; re-run with it if needed.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, ['--no-warnings', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(r.status ?? 1);
}

const { STORES } = await import('../src/stores/index.js');
const { parseItem } = await import('../public/js/core/query.js');
const { matchItem } = await import('../public/js/core/match.js');
const { summarise } = await import('../public/js/core/basket.js');

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const queries = opt('q').length ? opt('q') : ['milk 2L', 'bread', 'bananas 1kg', 'eggs 12', 'beef mince 500g', 'coke 30 pack', 'tim tams', 'butter 500g'];
const onlyStores = opt('store');
const workerUrl = opt('worker')[0];
const passcode = opt('passcode')[0] || process.env.APP_PASSCODE || '';

if (workerUrl) {
  const res = await fetch(`${workerUrl.replace(/\/$/, '')}/api/status?q=${encodeURIComponent(queries[0])}`, { headers: { 'x-passcode': passcode } });
  const body = await res.json();
  if (!res.ok) {
    console.error(`Worker said ${res.status}:`, body);
    process.exit(1);
  }
  console.log(`Worker status (Cloudflare colo ${body.colo || '?'}), query "${body.query}":`);
  for (const r of body.results) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.store.padEnd(11)} ${r.ok ? `${r.count} products, ${r.ms}ms` : r.error}`);
  process.exit(body.results.every((r) => r.ok) ? 0 : 1);
}

const stores = STORES.filter((s) => !onlyStores.length || onlyStores.includes(s.id));
const status = Object.fromEntries(stores.map((s) => [s.id, { ok: 0, fail: 0, errors: new Set(), ms: [] }]));
const rows = [];

for (const text of queries) {
  const item = parseItem(text);
  console.log(`\n=== ${text}  (search "${item.name}", qty ${item.qty}${item.size ? `, size ${item.size.label}` : ''})`);
  const results = {};
  await Promise.all(
    stores.map(async (s) => {
      const t = Date.now();
      try {
        results[s.id] = await s.search(item.name, { location: s.defaultLocation?.id });
        status[s.id].ok++;
      } catch (err) {
        results[s.id] = null;
        status[s.id].fail++;
        status[s.id].errors.add(err.message);
      }
      status[s.id].ms.push(Date.now() - t);
    }),
  );
  const available = Object.fromEntries(Object.entries(results).filter(([, v]) => v));
  const m = matchItem(item, available);
  if (m.target) console.log(`    target size: ${m.target.label}${m.target.inferred ? ' (inferred)' : ''}`);
  const picks = {};
  for (const s of stores) {
    const list = results[s.id];
    const pick = m.picks[s.id];
    picks[s.id] = pick || null;
    if (!list) {
      console.log(`    ${s.name.padEnd(11)} ERROR  ${[...status[s.id].errors].pop()}`);
    } else if (!pick) {
      console.log(`    ${s.name.padEnd(11)} ${String(list.length).padStart(3)} results, no sensible match`);
    } else {
      const p = pick.product;
      const packs = pick.packs > 1 ? ` x${pick.packs}` : '';
      console.log(`    ${s.name.padEnd(11)} ${String(list.length).padStart(3)} results -> ${p.name} (${p.size || '?'})${packs}  $${pick.cost.toFixed(2)}${pick.sizeNote ? `  [${pick.sizeNote}]` : ''}`);
    }
  }
  rows.push({ picks });
}

const summary = summarise(rows, stores.map((s) => s.id));
console.log('\n=== Basket');
for (const s of stores) {
  const t = summary.perStore[s.id];
  console.log(`    ${s.name.padEnd(11)} $${t.total.toFixed(2)}${t.missing ? `  (${t.missing} item(s) missing)` : ''}`);
}
console.log(`    Best split  $${summary.split.total.toFixed(2)}  saves $${summary.savings.toFixed(2)} vs ${summary.cheapestStore || '-'}`);

console.log('\n=== Store status');
let allOk = true;
for (const s of stores) {
  const st = status[s.id];
  const avg = Math.round(st.ms.reduce((a, b) => a + b, 0) / (st.ms.length || 1));
  const ok = st.fail === 0;
  allOk &&= ok;
  console.log(`    ${ok ? 'WORKS  ' : st.ok ? 'PARTIAL' : 'FAILS  '} ${s.name.padEnd(11)} ${st.ok}/${st.ok + st.fail} searches ok, avg ${avg}ms${st.errors.size ? `  - ${[...st.errors].join('; ')}` : ''}`);
}
process.exit(allOk ? 0 : 1);

// Launch Radar — collects chain + launchpad activity and serves a dashboard.
// No dependencies. Run: node server.js   then open http://localhost:4321
// One-shot mode (used by GitHub Actions): node server.js --once  → runs one full cycle, writes data/export.json, exits.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4321;
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const ONCE = process.argv.includes('--once');
// Upcoming events live in config/ (edited by hand or by the weekly research task); data/ is generated.
const CATALYSTS = [path.join(__dirname, 'config', 'catalysts.json'), path.join(DATA, 'catalysts.json')].find((p) => fs.existsSync(p));
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(DATA, { recursive: true });

const CHAINS = [
  { key: 'solana', name: 'Solana', llama: 'Solana', gt: 'solana', coin: 'coingecko:solana', sym: 'SOL' },
  { key: 'base', name: 'Base', llama: 'Base', gt: 'base', coin: 'coingecko:ethereum', sym: 'ETH' },
  { key: 'robinhood', name: 'Robinhood Chain', llama: 'Robinhood Chain', gt: 'robinhood', coin: 'coingecko:ethereum', sym: 'ETH' },
  { key: 'elysium', name: 'Elysium', llama: 'Elysium', gt: 'elysium', coin: 'coingecko:hyperliquid', sym: 'HYPE' },
];

const FEE_TO_VOL = 100; // only for launchpads DefiLlama tracks fees for but not volume (assumes a 1% fee)
const SLOW_MS = 30 * 60 * 1000; // DefiLlama daily data
const FAST_MS = 10 * 60 * 1000; // new pools + prices
const HISTORY_DAYS = 45;

const state = { llama: {}, fast: {}, prices: {}, updated: {}, errors: [] };
const SNAP_FILE = path.join(DATA, 'snapshots.jsonl');
const EVENTS_FILE = path.join(DATA, 'events.json');
const CACHE_FILE = path.join(DATA, 'llama-cache.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function logErr(msg) {
  console.error(new Date().toISOString(), msg);
  state.errors.unshift({ t: Date.now(), msg: String(msg).slice(0, 300) });
  state.errors.length = Math.min(state.errors.length, 20);
}
// GeckoTerminal's free tier is strict: send its calls one at a time, at least 7 s apart.
let gtChain = Promise.resolve();
function gtGet(url) {
  const run = gtChain.then(async () => { try { return await getJSON(url); } finally { await sleep(7000); } });
  gtChain = run.catch(() => {});
  return run;
}
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'launch-radar' } });
      if (r.status === 429) { await sleep(20000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url.split('?')[0]}: ${e.message}`);
      await sleep(5000);
    }
  }
  throw new Error(`${url.split('?')[0]}: rate limited`);
}

// ---------- DefiLlama (daily) ----------
async function refreshLlama() {
  for (const c of CHAINS) {
    try {
      const enc = encodeURIComponent(c.llama);
      const fees = await getJSON(`https://api.llama.fi/overview/fees/${enc}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=false`);
      const dex = await getJSON(`https://api.llama.fi/overview/dexs/${enc}?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=false`);

      // Launchpad VOLUME is the number that matters. DefiLlama tracks real volume for most launchpads
      // (category "Launchpad" in its DEX data). Where it only has fees (e.g. clanker), estimate volume
      // from fees at a 1% fee rate and flag it as an estimate.
      const isPad = (p) => p.category === 'Launchpad' && ((p.total24h || 0) > 0 || (p.total7d || 0) > 0);
      const volP = Object.fromEntries((dex.protocols || []).filter(isPad).map((p) => [p.name, p]));
      const feeP = Object.fromEntries((fees.protocols || []).filter(isPad).map((p) => [p.name, p]));
      const names = [...new Set([...Object.keys(volP), ...Object.keys(feeP)])];
      const pads = names.map((k) => {
        const v = volP[k], f = feeP[k], est = !v;
        return {
          name: (v || f).displayName || k, key: k, est,
          vol24h: v ? v.total24h || 0 : (f.total24h || 0) * FEE_TO_VOL,
          vol7d: v ? v.total7d || 0 : (f.total7d || 0) * FEE_TO_VOL,
          fees24h: f?.total24h || 0,
        };
      }).filter((p) => p.vol24h > 0 || p.vol7d > 0).sort((a, b) => b.vol24h - a.vol24h || b.vol7d - a.vol7d);

      const daily = {};
      const addRows = (chart, keys, mult) => {
        for (const [ts, row] of (chart || []).slice(-HISTORY_DAYS)) {
          const d = daily[ts] || (daily[ts] = { t: ts * 1000, total: 0, by: {} });
          for (const [k, val] of Object.entries(row)) if (keys.has(k)) { d.by[k] = (val || 0) * mult; }
        }
      };
      addRows(fees.totalDataChartBreakdown, new Set(pads.filter((p) => p.est).map((p) => p.key)), FEE_TO_VOL);
      addRows(dex.totalDataChartBreakdown, new Set(pads.filter((p) => !p.est).map((p) => p.key)), 1);
      const padDaily = Object.values(daily).sort((a, b) => a.t - b.t).slice(-HISTORY_DAYS);
      for (const d of padDaily) d.total = Object.values(d.by).reduce((a, b) => a + b, 0);
      const dexDaily = (dex.totalDataChart || []).slice(-HISTORY_DAYS).map(([ts, v]) => ({ t: ts * 1000, v }));

      state.llama[c.key] = {
        pads, padDaily, dexDaily,
        dex24h: dex.total24h || 0, dex7d: dex.total7d || 0, dexChange1d: dex.change_1d ?? null,
      };
    } catch (e) { logErr(`DefiLlama ${c.name}: ${e.message}`); }
  }
  await refreshDiscovery();
  state.updated.llama = Date.now();
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ llama: state.llama, updated: state.updated.llama })); } catch {}
  writeExport();
}


// ---------- Discovery: launchpads on EVERY chain DefiLlama tracks (hidden gems + chains to watch) ----------
const CHAIN_LABELS = { bsc: 'BNB Chain', xlayer: 'X Layer', monad: 'Monad', robinhood: 'Robinhood Chain', solana: 'Solana', base: 'Base', elysium: 'Elysium', hyperliquid: 'Hyperliquid', arc: 'Arc', ink: 'Ink', ethereum: 'Ethereum', arbitrum: 'Arbitrum', avax: 'Avalanche', ton: 'TON', megaeth: 'MegaETH', unichain: 'Unichain', sui: 'Sui', tron: 'Tron', sonic: 'Sonic', abstract: 'Abstract', berachain: 'Berachain', supra: 'Supra', injective: 'Injective', mantle: 'Mantle', gatelayer: 'GateLayer', shido: 'Shido' };
const chainLabel = (k) => CHAIN_LABELS[k] || k.replace(/(^|[-_ ])(w)/g, (m, a, b) => (a ? ' ' : '') + b.toUpperCase());
const MAIN = new Set(['solana', 'base', 'robinhood', 'elysium']);
async function refreshDiscovery() {
  try {
    const j = await getJSON('https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true');
    const pads = (j.protocols || []).filter((p) => p.category === 'Launchpad' && (p.total7d || 0) > 0).map((p) => {
      const by = p.breakdown24h || {};
      const per = Object.entries(by).map(([ch, o]) => [ch, Object.values(o || {}).reduce((a, b) => a + (b || 0), 0)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const tot = per.reduce((a, [, v]) => a + v, 0) || 0;
      return { name: p.displayName || p.name, vol24h: p.total24h || 0, vol7d: p.total7d || 0, prev7d: p.total14dto7d || 0,
        g7: p.change_7dover7d != null ? p.change_7dover7d / 100 : null, g30: p.change_30dover30d != null ? p.change_30dover30d / 100 : null, d7: p.change_7d != null ? p.change_7d / 100 : null,
        chains: per.map(([ch, v]) => ({ key: ch, name: chainLabel(ch), share: tot ? v / tot : 0 })) };
    });
    // Chain totals: 24h from the per-chain split; 7d and the week before apportioned by each launchpad's 24h split.
    const chains = {};
    for (const p of pads) for (const c of p.chains) {
      const r = chains[c.key] || (chains[c.key] = { key: c.key, name: c.name, vol24h: 0, vol7d: 0, prev7d: 0, pads: [] });
      r.vol24h += p.vol24h * c.share; r.vol7d += p.vol7d * c.share; r.prev7d += p.prev7d * c.share;
      if (p.vol24h * c.share > 1000) r.pads.push(p.name);
    }
    const chainList = Object.values(chains).map((c) => ({ ...c, g7: c.prev7d > 0 ? c.vol7d / c.prev7d - 1 : null, main: MAIN.has(c.key), vol24h: Math.round(c.vol24h), vol7d: Math.round(c.vol7d), prev7d: Math.round(c.prev7d), pads: c.pads.slice(0, 3) }))
      .filter((c) => c.vol7d >= 100000).sort((a, b) => b.vol7d - a.vol7d);
    // Hidden gems: launchpads with real volume that grew 30%+ week over week. Big ones excluded so the list surfaces new names.
    // Also require today's volume to be at or above the same day last week (d7 >= 0), so a launch spike that is already fading doesn't count.
    const gems = pads.filter((p) => p.vol7d >= 150000 && p.prev7d >= 25000 && p.g7 != null && p.g7 >= 0.3 && (p.d7 == null || p.d7 >= 0) && p.vol24h < 20e6)
      .sort((a, b) => b.g7 - a.g7).slice(0, 8)
      .map((p) => ({ ...p, vol24h: Math.round(p.vol24h), vol7d: Math.round(p.vol7d), prev7d: Math.round(p.prev7d), chains: p.chains.slice(0, 3) }));
    const top = pads.filter((p) => p.vol7d >= 150000).sort((a, b) => b.vol7d - a.vol7d).slice(0, 15)
      .map((p) => ({ name: p.name, vol24h: Math.round(p.vol24h), vol7d: Math.round(p.vol7d), g7: p.g7, chains: p.chains.slice(0, 3) }));
    state.discovery = { chains: chainList, gems, top, at: Date.now() };
  } catch (e) { logErr(`Discovery: ${e.message}`); }
}

// ---------- Trend predictor: upcoming events (researched, in data/catalysts.json) + live signs of heat ----------
// Where an event is catching on: related trending volume and new launches per chain.
function whereOf(hot, launched) {
  const w = {};
  for (const x of hot) (w[x.ck] ||= { ck: x.ck, vol: 0, n: 0 }).vol += x.vol || 0;
  for (const r of launched) (w[r.c] ||= { ck: r.c, vol: 0, n: 0 }).n++;
  return Object.values(w).map((x) => ({ ...x, vol: Math.round(x.vol) })).sort((a, b) => (b.vol - a.vol) || (b.n - a.n));
}
function predictor() {
  let cat;
  try { cat = JSON.parse(fs.readFileSync(CATALYSTS, 'utf8')); } catch { return null; }
  const now = Date.now();
  const trendingAll = Object.entries(state.trending || {}).flatMap(([ck, l]) => l.map((t) => ({ ...t, ck })));
  const recent = Object.values(tracked).filter((r) => now - r.t < 86400000);
  const matcher = (ev) => {
    const kw = (ev.keywords || []).map((k) => k.toLowerCase()), sy = new Set((ev.symbols || []).map((x) => x.toUpperCase()));
    return (sym, nm) => {
      const S = String(sym || '').toUpperCase().replace(/^$/, ''), text = `${nm || ''} ${sym || ''}`.toLowerCase();
      return sy.has(S) || kw.some((k) => k.length >= 4 ? text.includes(k) : new RegExp(`\\b${k}\\b`).test(text));
    };
  };
  const events = (cat.events || []).map((ev) => {
    const t = Date.parse(ev.date + 'T12:00:00Z'), days = Math.round((t - now) / 86400000 * 10) / 10;
    const m = matcher(ev);
    const hot = trendingAll.filter((x) => m(x.sym, x.nm));
    const launched = recent.filter((r) => m(r.sym, r.nm));
    const heatVol = hot.reduce((a, x) => a + (x.vol || 0), 0);
    // Timing: hype usually builds in the days before and peaks on the day. Past events fade fast.
    const timing = days < -2 ? 0 : days < 0 ? 0.5 : days <= 3 ? 1 : days <= 10 ? 0.8 : days <= 25 ? 0.55 : 0.3;
    const heat = heatVol > 0 ? Math.min(1, Math.log10(heatVol) / 7) : 0; // $10M of related trading ≈ max
    const score = ev.risk ? null : Math.round(Math.min(100, ev.strength * 22 * timing + heat * 25 + Math.min(launched.length, 10)));
    const stage = ev.risk ? 'risk' : days < 0 ? 'now' : hot.length ? 'heating' : launched.length ? 'early' : 'quiet';
    return { id: ev.id, title: ev.title, date: ev.date, days, theme: ev.theme, strength: ev.strength, why: ev.why, risk: !!ev.risk, source: ev.source,
      score, stage, heatVol: Math.round(heatVol), hot: hot.slice(0, 4).map((x) => ({ sym: x.sym, vol: x.vol, ck: x.ck })), launched: launched.length,
      launchedEx: [...new Set(launched.map((r) => r.sym))].slice(0, 4), where: whereOf(hot, launched) };
  }).filter((e) => e.days >= -2).sort((a, b) => (a.risk - b.risk) || (b.score - a.score));
  return { researched: cat.researched, events, fading: cat.fading || [], viral: cat.viral || [] };
}

// ---------- Prices + new pools (fast) ----------
async function refreshFast() {
  try {
    const ids = [...new Set(CHAINS.map((c) => c.coin))].join(',');
    const [cur, pct] = await Promise.all([
      getJSON(`https://coins.llama.fi/prices/current/${ids}`),
      getJSON(`https://coins.llama.fi/percentage/${ids}?period=24h`).catch(() => ({ coins: {} })),
    ]);
    for (const id of Object.keys(cur.coins || {})) {
      state.prices[id] = { price: cur.coins[id].price, symbol: cur.coins[id].symbol, change24h: pct.coins?.[id] ?? null };
    }
  } catch (e) { logErr(`Prices: ${e.message}`); }

  const snap = { t: Date.now(), chains: {} };
  for (const c of CHAINS) {
    try {
      const d = await gtGet(`https://api.geckoterminal.com/api/v2/networks/${c.gt}/new_pools?page=1&include=base_token`);
      const tokens = tokenNames(d);
      const pools = (d.data || []).map((p) => {
        const a = p.attributes;
        return {
          name: a.name, token: tokens[p.relationships?.base_token?.data?.id] || null, ta: (p.relationships?.base_token?.data?.id || '').replace(/^[^_]+_/, ''), address: a.address, dex: p.relationships?.dex?.data?.id || '?',
          created: Date.parse(a.pool_created_at), fdv: +a.fdv_usd || 0,
          volH1: +(a.volume_usd?.h1 || 0), buysH1: a.transactions?.h1?.buys || 0, sellsH1: a.transactions?.h1?.sells || 0,
        };
      }).filter((p) => p.created);
      pools.sort((a, b) => b.created - a.created);
      let perHour = null;
      if (pools.length >= 2) {
        let spanMin = Math.max((pools[0].created - pools[pools.length - 1].created) / 60000, 0.1);
        // If the chain has gone quiet since the newest pool, stretch the window so it reads as quiet.
        const sinceNewest = Math.max((Date.now() - pools[0].created) / 60000, 0);
        if (sinceNewest > 10 && sinceNewest > 3 * spanMin) spanMin += sinceNewest;
        perHour = ((pools.length - 1) / spanMin) * 60;
      }
      const dexMix = {};
      for (const p of pools) dexMix[p.dex] = (dexMix[p.dex] || 0) + 1;
      state.fast[c.key] = { pools, perHour, dexMix, at: Date.now() };
      snap.chains[c.key] = { perHour, dexMix, price: state.prices[c.coin]?.price ?? null };
      trackNew(c, pools);
    } catch (e) { logErr(`GeckoTerminal ${c.name}: ${e.message}`); }
  }
  state.updated.fast = Date.now();
  if (Object.keys(snap.chains).length) fs.appendFileSync(SNAP_FILE, JSON.stringify(snap) + '\n');
  writeExport();
  await checkTracked();
  writeExport();
}

function tokenNames(d) {
  const out = {};
  for (const t of d.included || []) if (t.type === 'token') out[t.id] = { name: t.attributes?.name || '', symbol: t.attributes?.symbol || '' };
  return out;
}

// ---------- Launch tracker: follow every new token we see and check it 1h, 6h and 24h later ----------
// This is the "proof" behind each launchpad's success rate. It is a sample (the newest 20 tokens
// per chain every 10 minutes), not every launch, and the page says so.
const TRACK_FILE = path.join(DATA, 'tracked.json');
const CHECKS = [['h1', 1], ['h6', 6], ['h24', 24]];
const TRACK_DAYS = 10;
let tracked = {};
try { tracked = JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8')); } catch {}
const saveTracked = () => { try { fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked)); } catch (e) { logErr(`Tracker save: ${e.message}`); } };

function trackNew(c, pools) {
  for (const p of pools) {
    const id = `${c.key}:${p.address}`;
    if (tracked[id] || Date.now() - p.created > 2 * 3600000) continue;
    tracked[id] = { c: c.key, a: p.address, ta: p.ta || undefined, dex: p.dex, sym: p.token?.symbol || p.name.split(' / ')[0], nm: p.token?.name || '', t: p.created, ck: {} };
  }
}

async function checkTracked() {
  const now = Date.now();
  for (const id of Object.keys(tracked)) if (now - tracked[id].t > TRACK_DAYS * 86400000) delete tracked[id];
  for (const c of CHAINS) {
    // Which tokens are due a check? Oldest first; a check more than 12h late is skipped.
    const due = [];
    for (const r of Object.values(tracked)) {
      if (r.c !== c.key) continue;
      const age = (now - r.t) / 3600000;
      for (const [k, h] of CHECKS) {
        if (r.ck[k] || age < h) continue;
        if (age > h + 12) { r.ck[k] = { miss: 1 }; continue; }
        due.push(r); break;
      }
    }
    due.sort((a, b) => a.t - b.t);
    for (let i = 0; i < due.length && i < 150; i += 30) {
      const batch = due.slice(i, i + 30);
      try {
        // Look up the TOKEN (all its pools), not the first pool: launchpad tokens move to a new pool when they
        // graduate, and the old pool freezes (e.g. pump.fun winners looked stuck at ~$37K). Older records
        // without a token address fall back to the pool and learn the token address for next time.
        const byTok = batch.filter((r) => r.ta), byPool = batch.filter((r) => !r.ta);
        const found = {};
        if (byTok.length) {
          const d = await gtGet(`https://api.geckoterminal.com/api/v2/networks/${c.gt}/tokens/multi/${byTok.map((r) => r.ta).join(',')}`);
          for (const t of d.data || []) {
            const a = t.attributes, lp = a.launchpad_details;
            found['t:' + a.address.toLowerCase()] = { tk: 1, fdv: Math.round(+a.fdv_usd || 0), vol: Math.round(+(a.volume_usd?.h24 || 0)),
              ...(lp ? { grad: lp.completed ? 100 : Math.round(+lp.graduation_percentage || 0) } : {}) };
          }
        }
        if (byPool.length) {
          const d = await gtGet(`https://api.geckoterminal.com/api/v2/networks/${c.gt}/pools/multi/${byPool.map((r) => r.a).join(',')}`);
          for (const p of d.data || []) {
            const a = p.attributes;
            found['p:' + a.address.toLowerCase()] = { fdv: Math.round(+a.fdv_usd || 0), vol: Math.round(+(a.volume_usd?.h24 || 0)), tx: (a.transactions?.h24?.buys || 0) + (a.transactions?.h24?.sells || 0),
              ta: (p.relationships?.base_token?.data?.id || '').replace(/^[^_]+_/, '') };
          }
        }
        for (const r of batch) {
          const age = (now - r.t) / 3600000;
          const k = [...CHECKS].reverse().find(([key, h]) => age >= h && !r.ck[key])?.[0];
          if (!k) continue;
          const a = r.ta ? found['t:' + r.ta.toLowerCase()] : found['p:' + r.a.toLowerCase()];
          if (a?.ta) { r.ta = a.ta; delete a.ta; }
          r.ck[k] = a ? a : { gone: 1 };
          // Mark earlier checks this token can no longer get as missed, so it isn't asked for again.
          for (const [key, h] of CHECKS) if (h < CHECKS.find(([x]) => x === k)[1] && !r.ck[key]) r.ck[key] = { miss: 1 };
        }
      } catch (e) { logErr(`Tracker ${c.name}: ${e.message}`); }
    }
  }
  state.updated.tracker = Date.now();
  saveTracked();
}

// Readable launchpad names for GeckoTerminal's tags. Plain DEX tags mean "launched straight on a DEX"
// (on Base most of those are clanker tokens, but the tag can't tell us that).
const PAD_NAMES = {
  'pump-fun': 'pump.fun', pumpswap: 'PumpSwap', 'meteora-dbc': 'Meteora DBC (Bags, Believe…)', 'meteora-damm-v2': 'Meteora DAMM v2',
  stonkfun: 'StonkFun', 'raydium-launchlab': 'LaunchLab (Bonk.fun)', 'bags-fm': 'Bags', raydium: 'Raydium', meteora: 'Meteora',
  bankr: 'Bankr', 'o1-launchpad': 'o1 Launchpad', 'uniswap-v4-base': 'Uniswap v4 (mostly clanker)', 'uniswap-v2-base': 'Uniswap v2', 'uniswap-v3-base': 'Uniswap v3',
  'pons-v2': 'Pons V2', 'pons-v2-dex': 'Pons V2', 'long-xyz': 'Long.xyz', 'clanker-robinhood': 'clanker', 'uniswap-v4-robinhood': 'Uniswap v4', 'uniswap-v3-robinhood': 'Uniswap v3', 'uniswap-v2-robinhood': 'Uniswap v2',
  montra: 'Montra', 'uniswap-v4-elysium': 'Uniswap v4', 'uniswap-v3-elysium': 'Uniswap v3',
};
const padName = (tag) => PAD_NAMES[tag] || tag.replace(/-/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase());

// Bonding-curve launchpads: tokens move to a new pool when they graduate, so only token-level checks count.
const BONDING = new Set(['pump-fun', 'meteora-dbc', 'raydium-launchlab', 'pons-v2', 'montra', 'bags-fm', 'stonkfun', 'long-xyz']);
const WIN_VALUE = 100000; // "took off": reached $100K market value at a check
const VOL_BAR = 10000;    // "got traded": $10K+ volume in a day

function launchpadStats() {
  const out = {}, chains = {};
  for (const c of CHAINS) {
    const groups = {};
    const all = { n: 0, wins: 0, traded: 0, vols: [] };
    let followed = 0;
    for (const r of Object.values(tracked)) {
      if (r.c !== c.key) continue;
      followed++;
      const vals = Object.values(r.ck).filter((x) => x && !x.miss && (x.tk || !BONDING.has(r.dex)));
      if (!vals.length) continue;
      const ok = (x) => x && !x.miss && (x.tk || !BONDING.has(r.dex));
      const done = ok(r.ck.h6) || ok(r.ck.h24); // only judge tokens we've watched for 6h+
      if (!done) continue;
      const name = padName(r.dex);
      const g = groups[name] || (groups[name] = { name, n: 0, wins: 0, traded: 0, vols: [], best: [], gn: 0, grads: 0 });
      const peak = Math.max(...vals.map((x) => x.fdv || 0));
      const vol = Math.max(...vals.map((x) => x.vol || 0));
      const gr = vals.filter((x) => x.grad != null); if (gr.length) { g.gn++; if (Math.max(...gr.map((x) => x.grad)) >= 100) g.grads++; }
      g.n++; if (peak >= WIN_VALUE) g.wins++; if (vol >= VOL_BAR) g.traded++;
      g.vols.push(vol);
      all.n++; if (peak >= WIN_VALUE) all.wins++; if (vol >= VOL_BAR) all.traded++; all.vols.push(vol);
      g.best.push({ sym: r.sym, nm: r.nm, peak, vol, t: r.t });
    }
    out[c.key] = Object.values(groups).map((g) => ({
      name: g.name, n: g.n, winRate: g.wins / g.n, gradRate: g.gn >= 20 ? g.grads / g.gn : null, gradN: g.gn, tradedRate: g.traded / g.n, wins: g.wins,
      medianVol: Math.round(median(g.vols) || 0),
      best: g.best.sort((a, b) => b.vol - a.vol).slice(0, 3).map((b) => ({ ...b, peak: Math.round(b.peak), vol: Math.round(b.vol) })),
    })).sort((a, b) => b.n - a.n);
    chains[c.key] = { followed, n: all.n, winRate: all.n ? all.wins / all.n : null, tradedRate: all.n ? all.traded / all.n : null, medianVol: all.n ? Math.round(median(all.vols)) : null };
  }
  const all = Object.values(tracked);
  return { byChain: out, chains, since: all.length ? Math.min(...all.map((r) => r.t)) : null, total: all.length, winValue: WIN_VALUE, volBar: VOL_BAR };
}

// ---------- What's getting attention: trending tokens + themes ----------
const MAJORS = new Set(['SOL', 'WSOL', 'ETH', 'WETH', 'USDC', 'USDT', 'USDG', 'USAD', 'DAI', 'CBBTC', 'WBTC', 'BTC', 'AERO', 'VIRTUAL', 'HYPE', 'WHYPE', 'JUP', 'RAY', 'USD1', 'PYUSD', 'EURC', 'USDS']);
const THEMES = [
  ['ai', 'AI & agents', /\b(ai|agent|agents|gpt|bot|neural|llm|agi|robot|claude|grok|openai|deepseek|sentient|cyber)\b|ai$/i],
  ['stocks', 'Stocks & companies', /\b(nvda|tsla|aapl|ttwo|gta|gta6|stonk|stonks|stock|nasdaq|spy|amzn|meta|msft|coin|hood|robinhood|nvidia|tesla|apple)\b/i],
  ['politics', 'Politics & famous people', /\b(trump|maga|elon|musk|biden|vance|melania|barron|president|usa|america|kanye|jensen|cz|saylor|potus)\b/i],
  ['dogs', 'Dogs', /\b(dog|doge|shib|inu|pup|puppy|bonk|wif|shiba|corgi|snoopy|floki|dawg)\b/i],
  ['cats', 'Cats', /\b(cat|cats|kitty|kitten|meow|popcat|mew|gato|cate|neko|kitt)\b|cat$/i],
  ['frogs', 'Frogs & Pepe', /\b(pepe|frog|ribbit|frong|kek|toad)\b/i],
  ['animals', 'Other animals', /\b(monkey|ape|penguin|pengu|bear|bull|hippo|moodeng|fish|bird|duck|goat|horse|lion|tiger|panda|hamster|rat|mouse|otter|seal|whale|shark|chicken|cow|pig|bunny|rabbit|fox|wolf|hog|squirrel)\b/i],
  ['money', 'Money & finance memes', /\b(cash|money|rich|gold|bank|bill|dollar|wallet|million|billion|treasury|fund|wasted|broke|profit)\b/i],
  ['games', 'Games & anime', /\b(game|games|play|anime|pixel|mario|pokemon|waifu|nintendo|arcade|quest)\b/i],
  ['culture', 'Internet culture', /\b(chad|wojak|based|gm|lol|meme|memes|vibe|vibes|sigma|npc|rizz|bro|degen|moon|lfg|wagmi|cope|giga)\b/i],
];
function themeOf(sym, nm) {
  const text = `${nm || ''} ${sym || ''}`.replace(/[^a-z0-9$ ]/gi, ' ');
  for (const [key, , re] of THEMES) if (re.test(text) || re.test((sym || '').toLowerCase())) return key;
  return 'other';
}

async function refreshTrending() {
  state.trending = state.trending || {};
  for (const c of CHAINS) {
    try {
      const d = await gtGet(`https://api.geckoterminal.com/api/v2/networks/${c.gt}/trending_pools?page=1&duration=24h&include=base_token`);
      const tokens = tokenNames(d);
      const seen = new Set();
      state.trending[c.key] = (d.data || []).map((p) => {
        const a = p.attributes, tk = tokens[p.relationships?.base_token?.data?.id] || {};
        const sym = tk.symbol || a.name.split(' / ')[0];
        return { sym, nm: tk.name || '', dex: padName(p.relationships?.dex?.data?.id || '?'), ageH: Math.round((Date.now() - Date.parse(a.pool_created_at)) / 3600000),
          vol: Math.round(+(a.volume_usd?.h24 || 0)), fdv: Math.round(+a.fdv_usd || 0), chg: a.price_change_percentage?.h24 != null ? Math.round(+a.price_change_percentage.h24) : null };
      }).filter((t) => !MAJORS.has(String(t.sym).toUpperCase().replace(/^\$/, '')) && t.fdv < 2e9 && !seen.has(t.sym) && seen.add(t.sym))
        .map((t) => ({ ...t, theme: themeOf(t.sym, t.nm) }));
    } catch (e) { logErr(`Trending ${c.name}: ${e.message}`); }
  }
  state.updated.trending = Date.now();
  try {
    const counts = {};
    for (const list of Object.values(state.trending)) for (const t of list) counts[t.theme] = (counts[t.theme] || 0) + t.vol;
    fs.appendFileSync(THEME_FILE, JSON.stringify({ t: Date.now(), vol: counts }) + '\n');
  } catch {}
  writeExport();
}
const THEME_FILE = path.join(DATA, 'themes.jsonl');

function themeSummary() {
  // Attention = share of 24h trading among trending tokens, plus tokens from our tracker that took off this week.
  const rows = {};
  const add = (theme, vol, ex, chain) => {
    const r = rows[theme] || (rows[theme] = { key: theme, vol: 0, count: 0, examples: [], chains: {} });
    r.vol += vol; r.count++; r.chains[chain] = (r.chains[chain] || 0) + vol;
    if (r.examples.length < 4 && !r.examples.includes(ex)) r.examples.push(ex);
  };
  for (const [ck, list] of Object.entries(state.trending || {})) for (const t of list) add(t.theme, t.vol, t.sym, ck);
  const week = Date.now() - 7 * 86400000;
  for (const r of Object.values(tracked)) {
    if (r.t < week) continue;
    const vals = Object.values(r.ck).filter((x) => x && !x.miss);
    const peak = Math.max(0, ...vals.map((x) => x.fdv || 0));
    if (peak >= WIN_VALUE) add(themeOf(r.sym, r.nm), Math.max(0, ...vals.map((x) => x.vol || 0)), r.sym, r.c);
  }
  const total = Object.values(rows).reduce((a, r) => a + r.vol, 0) || 1;
  const labels = Object.fromEntries(THEMES.map(([k, l]) => [k, l]));
  labels.other = 'Other / no clear theme';

  // Rising or fading: this 24h vs the 24h before, from the theme history.
  let change = {};
  try {
    const hist = fs.readFileSync(THEME_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const now = Date.now();
    const avg = (from, to) => { const s = hist.filter((h) => h.t >= from && h.t < to); if (!s.length) return null; const o = {}; for (const h of s) { const tot = Object.values(h.vol).reduce((a, b) => a + b, 0) || 1; for (const [k, v] of Object.entries(h.vol)) o[k] = (o[k] || 0) + v / tot / s.length; } return o; };
    const cur = avg(now - 86400000, now), prev = avg(now - 2 * 86400000, now - 86400000);
    if (cur && prev) for (const k of Object.keys(cur)) change[k] = prev[k] ? cur[k] / prev[k] - 1 : null;
  } catch {}

  return Object.values(rows).map((r) => ({ ...r, label: labels[r.key] || r.key, share: r.vol / total, change: change[r.key] ?? null, vol: Math.round(r.vol), chains: Object.fromEntries(Object.entries(r.chains).map(([k, v]) => [k, Math.round(v)])) }))
    .sort((a, b) => b.vol - a.vol);
}

function readSnapshots(days = 14) {
  if (!fs.existsSync(SNAP_FILE)) return [];
  const cutoff = Date.now() - days * 86400000;
  return fs.readFileSync(SNAP_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((s) => s && s.t >= cutoff);
}

// ---------- Scoring ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function fullDays(series) {
  // Drop today's partial UTC day.
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return series.filter((d) => d.t < today.getTime());
}

function scoreChain(c, snaps) {
  const L = state.llama[c.key];
  const F = state.fast[c.key];
  const reasons = [];
  let score = 50;
  const m = {};

  if (L) {
    // Last 3 full days vs the same 3 weekdays one week earlier. Comparing like-for-like days stops
    // weekends from looking like crashes, and using 3 days stops one spike day from swinging the score.
    // One freak day (a single whale or a one-off launch) is capped at 2.5× the typical day, so it can't swing the score alone.
    const vsLastWeek = (raw) => {
      if (raw.length < 10) return null;
      const typical = median(raw.slice(-17, -3).filter((v) => v > 0)) || 0;
      const vals = typical > 0 ? raw.map((v) => Math.min(v, typical * 2.5)) : raw;
      const now = vals.slice(-3).reduce((a, b) => a + b, 0), then = vals.slice(-10, -7).reduce((a, b) => a + b, 0);
      return then > 0 ? now / then : null;
    };
    m.padMomentum = vsLastWeek(fullDays(L.padDaily).map((d) => d.total));
    m.dexTrend = vsLastWeek(fullDays(L.dexDaily).map((d) => d.v));
  }
  if (m.padMomentum != null) {
    score += clamp((m.padMomentum - 1) * 50, -30, 30);
    reasons.push(`Launchpad fees yesterday were ${fmtX(m.padMomentum)} the 7-day average`);
  } else reasons.push('Not enough launchpad history yet');
  if (m.dexTrend != null) {
    score += clamp((m.dexTrend - 1) * 30, -15, 15);
    reasons.push(`Chain DEX volume yesterday was ${fmtX(m.dexTrend)} the 7-day average`);
  }

  if (F && F.perHour != null) {
    const past = snaps.filter((s) => s.t > Date.now() - 86400000).map((s) => s.chains?.[c.key]?.perHour).filter((v) => v != null);
    if (past.length >= 6) {
      const med = median(past);
      m.competition = med > 0 ? F.perHour / med : null;
      if (m.competition != null) {
        score -= clamp((m.competition - 1) * 20, -15, 15);
        reasons.push(`New pools right now: ${fmtX(m.competition)} the 24h typical rate${m.competition > 1.2 ? ' (more competition)' : m.competition < 0.8 ? ' (less competition)' : ''}`);
      }
    } else reasons.push('Competition reading needs ~1h of collected data');
  }

  score = Math.round(clamp(score, 0, 100));
  const label = score >= 62 ? 'hot' : score >= 45 ? 'warm' : 'cold';
  return { score, label, reasons, metrics: m };
}
function fmtX(x) { return x == null ? '—' : `${x.toFixed(2)}×`; }

function hourOfDay(snaps) {
  const out = {};
  for (const c of CHAINS) {
    const buckets = Array.from({ length: 24 }, () => []);
    for (const s of snaps) {
      const v = s.chains?.[c.key]?.perHour;
      if (v != null) buckets[new Date(s.t).getUTCHours()].push(v);
    }
    out[c.key] = buckets.map((b) => (b.length ? b.reduce((a, x) => a + x, 0) / b.length : null));
  }
  return out;
}

function intraday(snaps) {
  const out = {};
  for (const c of CHAINS) out[c.key] = snaps.filter((s) => s.t > Date.now() - 2 * 86400000)
    .map((s) => ({ t: s.t, v: s.chains?.[c.key]?.perHour ?? null }));
  return out;
}

function buildState() {
  const snaps = readSnapshots(14);
  return {
    now: Date.now(),
    updated: state.updated,
    collectingSince: snaps.length ? snaps[0].t : null,
    snapshotCount: snaps.length,
    errors: state.errors.slice(0, 5),
    chains: CHAINS.map((c) => ({
      key: c.key, name: c.name, sym: c.sym,
      price: state.prices[c.coin] || null,
      llama: state.llama[c.key] || null,
      fast: state.fast[c.key] || null,
      score: scoreChain(c, snaps),
    })),
    hourOfDay: hourOfDay(snaps),
    intraday: intraday(snaps),
    proof: launchpadStats(),
    trending: state.trending || {},
    themes: themeSummary(),
    discovery: state.discovery || null,
    predictor: predictor(),
    events: readEvents(),
  };
}

// Compact copy of the dashboard state for the hosted team page (kept well under 256 KiB).
function writeExport() {
  try {
    const s = buildState();
    delete s.events; delete s.errors;
    for (const c of s.chains) {
      const L = c.llama;
      if (L) {
        L.pads = L.pads.filter((p, i) => i < 5 || p.vol24h >= 5000).slice(0, 10).map((p) => ({ ...p, vol24h: Math.round(p.vol24h), vol7d: Math.round(p.vol7d), fees24h: Math.round(p.fees24h) }));
        const keys = new Set(L.pads.map((p) => p.key));
        L.padDaily = L.padDaily.slice(-30).map((d) => ({ t: d.t, total: Math.round(d.total), by: Object.fromEntries(Object.entries(d.by).filter(([k]) => keys.has(k)).map(([k, v]) => [k, Math.round(v)])) }));
        L.dexDaily = L.dexDaily.slice(-30).map((d) => ({ t: d.t, v: Math.round(d.v) }));
      }
      if (c.fast) c.fast.pools = c.fast.pools.slice(0, 8);
    }
    for (const k of Object.keys(s.trending)) s.trending[k] = s.trending[k].slice(0, 12);
    s.themes = s.themes.slice(0, 11);
    for (const k of Object.keys(s.intraday)) s.intraday[k] = s.intraday[k].map((p) => ({ t: p.t, v: p.v == null ? null : Math.round(p.v * 10) / 10 }));
    fs.writeFileSync(path.join(DATA, 'export.json'), JSON.stringify(s));
  } catch (e) { logErr(`Export: ${e.message}`); }
}

// ---------- Events (team notes) ----------
function readEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch { return []; }
}
function addEvent(ev) {
  const list = readEvents();
  list.unshift({ id: Date.now().toString(36), t: Date.now(), chain: String(ev.chain || 'all').slice(0, 40), text: String(ev.text || '').slice(0, 500) });
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(list.slice(0, 500), null, 1));
}
function deleteEvent(id) {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(readEvents().filter((e) => e.id !== id), null, 1));
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
if (!ONCE) http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

  if (url.pathname === '/api/state') return send(200, JSON.stringify(buildState()));
  if (url.pathname === '/api/events' && req.method === 'POST') {
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 5000) req.destroy(); });
    req.on('end', () => { try { const ev = JSON.parse(body); if (ev.text?.trim()) addEvent(ev); send(200, '{"ok":true}'); } catch { send(400, '{"ok":false}'); } });
    return;
  }
  if (url.pathname.startsWith('/api/events/') && req.method === 'DELETE') { deleteEvent(url.pathname.split('/').pop()); return send(200, '{"ok":true}'); }
  if (url.pathname === '/api/refresh' && req.method === 'POST') { refreshFast(); refreshLlama(); return send(200, '{"ok":true}'); }

  const file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUB) || !fs.existsSync(file)) return send(404, 'Not found', 'text/plain');
  send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}).listen(PORT, () => console.log(`Launch Radar on http://localhost:${PORT}`));

// ---------- Start ----------
try {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  state.llama = cache.llama || {}; state.updated.llama = cache.updated;
} catch {}
let fastBusy = false;
async function fastCycle() {
  if (fastBusy) return; // a slow cycle (rate limits) must not overlap the next one
  fastBusy = true;
  try { await refreshFast(); } catch (e) { logErr(`Fast cycle: ${e.message}`); }
  fastBusy = false;
}
// Keep the growing history files bounded (they are committed to the data branch by the GitHub Action).
function trimHistory() {
  for (const [file, days] of [[SNAP_FILE, 15], [path.join(DATA, 'themes.jsonl'), 8]]) {
    try {
      const cutoff = Date.now() - days * 86400000;
      const keep = fs.readFileSync(file, 'utf8').split('\n').filter((l) => { try { return JSON.parse(l).t >= cutoff; } catch { return false; } });
      fs.writeFileSync(file, keep.join('\n') + (keep.length ? '\n' : ''));
    } catch {}
  }
}
if (ONCE) {
  const guard = setTimeout(() => { console.error('Timed out; writing what we have.'); writeExport(); process.exit(0); }, 13 * 60 * 1000);
  (async () => {
    const t0 = Date.now();
    try { await refreshLlama(); } catch (e) { logErr(`Llama: ${e.message}`); }
    try { await refreshFast(); } catch (e) { logErr(`Fast: ${e.message}`); }
    try { await refreshTrending(); } catch (e) { logErr(`Trending: ${e.message}`); }
    trimHistory(); writeExport(); clearTimeout(guard);
    console.log(`Cycle done in ${Math.round((Date.now() - t0) / 1000)}s, ${state.errors.length} errors`);
    process.exit(0);
  })();
} else {
  refreshLlama();
  fastCycle().then(() => refreshTrending());
  setInterval(refreshLlama, SLOW_MS);
  setInterval(fastCycle, FAST_MS);
  setInterval(refreshTrending, SLOW_MS);
}

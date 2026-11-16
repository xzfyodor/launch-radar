# Launch Radar

Tracks launch activity on Solana, Base, Robinhood Chain and Elysium, and on the main launchpads on each chain, to help pick when to launch.

## How the live site stays current

```
GitHub Actions (every 15 min)  →  node server.js --once  →  `data` branch (export.json + history)
Vercel site (web/)             →  /data.json  →  rewritten to the `data` branch's export.json
```

- `.github/workflows/collect.yml` runs one collector cycle every 15 minutes, with no PC needed. It loads the previous state from the `data` branch, runs, and force-pushes the new state as a single commit, so the repo doesn't grow.
- `web/` is the public website. Rebuild it after editing the page with `node scripts/build-web.js`, then commit and redeploy (`vercel --prod` from `web/`).
- `hosted/launch-radar.html` is the one page source. Inside claude.ai it reads the shared database and shows the Team log. On the website it fetches `data.json` every 2 minutes and hides the Team log.
- `config/catalysts.json` holds the upcoming events for the trend predictor. Edit it and push to `main`; the next cycle picks it up.
- GitHub pauses scheduled workflows in public repos after 60 days without activity. If the data stops updating, open the repo's **Actions** tab and re-enable `collect`.

## Run it

Needs Node 18 or newer. No install step.

```bash
node server.js
```

Then open http://localhost:4321. Keep it running: it saves a snapshot every 10 minutes, and the hour-of-day chart gets more useful the longer it runs.

## Where the data comes from (all free, no keys)

| What | Source | How often |
|---|---|---|
| Launchpad fees per day, per launchpad, per chain (last 45 days) | DefiLlama `/overview/fees/{chain}` | every 30 min |
| Chain DEX volume per day | DefiLlama `/overview/dexs/{chain}` | every 30 min |
| SOL / ETH / HYPE price and 24h change | DefiLlama coins API | every 10 min |
| 20 newest pools per chain, tagged by launchpad (e.g. `pump-fun`, `montra`, `pons-v2`) | GeckoTerminal `/networks/{chain}/new_pools` | every 10 min |

GeckoTerminal's free limit is low (about 10 to 30 calls a minute), so the collector waits 8 seconds between chains.

## The score (0 to 100)

Starts at 50, then:
- **Launchpad momentum** (up to ±30): yesterday's total launchpad fees compared with the 7 days before.
- **Chain volume trend** (up to ±15): yesterday's DEX volume compared with the 7 days before.
- **Competition** (up to ±15, needs about 1 hour of data): new pools per hour now compared with the typical rate over the last 24 hours. More new pools means more competition, which lowers the score.

62 or more is **Hot**, 45 to 61 is **Warm**, below 45 is **Cold**. These cutoffs are a first guess; tune them in `scoreChain` in `server.js` once you've compared them against real launches.

## Launchpad proof, growth and attention

- **Launch tracker** (`data/tracked.json`): every 10 minutes the collector notes the newest tokens on each chain and which launchpad made them, then looks them up again 1, 6 and 24 hours later. Per launchpad it reports how many "took off" (reached $100K market value at a check), how many "got traded" ($10K+ in a day), typical day-one volume and its best tokens. Tokens count after 6 hours of watching; a launchpad is ranked once 20 of its tokens count. Change the bars in `WIN_VALUE` and `VOL_BAR` in `server.js`.
- **Growth**: launchpad fees for the last 7 full days against the 7 before, per chain and per launchpad.
- **Attention** (`data/themes.jsonl`): trending tokens per chain (GeckoTerminal, every 30 min), sorted into themes by keywords in their names (`THEMES` in `server.js`), sized by 24h volume. Rising or fading compares the last 24h with the 24h before.

## Data quality fixes (Nov 15)

- Launchpad numbers now use **real launchpad volume** from DefiLlama's DEX data. Only launchpads with fees but no tracked volume (e.g. clanker) are estimated (fees × 100) and marked `*`.
- "vs last week" compares the **last 3 full days with the same 3 weekdays a week earlier**, and caps any single day at 2.5× the typical day, so weekends and one-off spikes don't swing the score.

## Tracker fix (Nov 17)

- The tracker now looks up each **token** (all of its pools) instead of the pool it launched in. Bonding-curve launchpads like pump.fun move a token to a new pool when it graduates and the old pool freezes, so winners used to look stuck at about $37K. For those launchpads (`BONDING` in `server.js`) only token-level checks count, so their success rates restart from Nov 17.
- Each check also records **graduation progress** where GeckoTerminal reports it, and launchpads show a "Graduated" rate once 20 tokens have it.

- Each predictor event now carries `where`: related trending volume and new launches per chain, so the page can show where an event trades and where new tokens about it launch.
- Fixed: short event keywords (3 letters or fewer, like "gta") never matched, because `\b` inside a template string became a backspace.
- The page shows the quietest 3 hours per chain (fewest new launches) from `hourOfDay`, in the viewer's local time.

## Hidden gems and trend predictor

- **Discovery** (`refreshDiscovery`, every 30 min): every launchpad DefiLlama tracks on every chain. A "gem" grew 30%+ week over week, still beats the same day last week, and has real volume. Also lists every chain with launchpad activity.
- **Predictor** (`data/catalysts.json`): upcoming events researched from the news, each with keywords. The collector checks trending tokens and newly launched tokens for matches and scores each event on size, timing and live heat. A scheduled task (`launch-radar-catalysts`, Mondays at 9:00) re-researches the news and updates this file automatically; `researched` shows when it was last done. The collector reads it fresh each cycle, so no restart is needed.

## Limits to know

- Fees stand in for trading activity, but fee rates differ by launchpad, so compare trends rather than raw size across launchpads.
- "New pools per hour" is estimated from the 20 newest pools. On Solana, 20 pools can land within seconds, so treat its number as rough.
- For a brand-new chain like Elysium, the 7-day average still includes the launch spike, so it will read as "fading" for about a week.
- Data is stored in `data/`: `snapshots.jsonl` (history), `events.json` (team notes), `llama-cache.json`.

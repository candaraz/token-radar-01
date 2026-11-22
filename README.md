# Launch Radar — token-radar-01 (radar-8)

[![Competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/competitions/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/candaraz/token-radar-01/rank.svg)](https://make.fun/competitions/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/candaraz/token-radar-01/reward.svg)](https://make.fun/competitions/token-radar-01)

A radar for pre-token protocols: what each one would be worth if it launched
a token, how likely it is to do so, and whether farming it pays after costs.

## The model

**Implied value = launch value × token odds.** Both terms are fitted on the
snapshot's own figures — no hardcoded names, no copied odds.

- **Launch value** — a size curve, log10(market cap) on log10(TVL), fitted on
  all 128 usable priced comps (protocols with a market cap of zero or less are
  excluded). Intercept 3.025, slope 0.522. Out-of-sample miss: ×3.05
  walk-forward / ×3.37 5-fold CV, against ×5.01 / ×5.05 for a flat multiple.
  Growth, kinship and category terms were tested and did not improve the value
  curve on both tests, so they are not in it.
- **Token odds** — a ridge-logistic model on 447 dated peers (protocols with a
  tracking date, outside the house-excluded categories): log age, log TVL,
  clipped 7-day growth, and **kinship** — whether a protocol sharing its name
  stem already lists a token. Siblings list at 93.9% vs 40.1% without one.
  Brier 0.167 (CV) / 0.180 (walk-forward) vs 0.248 / 0.334 for the base rate,
  and better on both tests than the previous board's age-band odds
  (0.208 / 0.310) and the top entry's reported 0.186 / 0.215. Category cells
  and life-table odds were tested and not kept; a control (another row's
  growth) does not help.
- **Ranges** — P25–P75 / P10–P90 from the size curve's out-of-sample residuals,
  with measured coverage printed on the board.

**Farm plans** — deposit 0.02% of TVL (floored $1,000, capped $100,000), a 10%
drop share pro rata by deposit, 12-week horizon, gas ($24 on Ethereum, $3
elsewhere) plus $5 fees, and the forgone 4% T-bill yield. FARM beats the
T-bill and $25/hour; MARGINAL nets positive; SKIP does not. The dashboard's
sliders re-price every row live from the same rules.

## The board

198 ranked pre-token protocols (all 40 watchlist entries), 128 priced comps,
758 protocols accounted for in the ledger. Top implied values: Steakhouse
$45.38M, Sentora $39.54M, Veda $36.64M, Gauntlet $30.92M, USDD $27.82M,
Polymarket $20.41M. Total implied $1.016B. Farm verdicts: 8 FARM, 63
MARGINAL, 127 SKIP.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22, standard library only. Deterministic: two runs are byte-identical.
The dashboard is a static page (`dashboard/`) reading `data.js`; the board,
detail and filtered views are screenshots in `screenshots/`.

## License

MIT — see [LICENSE](LICENSE).

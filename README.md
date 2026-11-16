# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/candaraz/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/candaraz/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An entry for the make.fun competition [token-radar-01: Build the best token launch radar](https://make.fun/c/token-radar-01). The program reads a sealed snapshot of every protocol DefiLlama tracks, ranks the protocols that record no token by what their launch would be worth, and writes a dashboard a reader can use: the board, a detail view for each protocol, and the steps to farm it.

## The model

A staged comparables model, fitted on the protocols whose tokens already trade:

1. **Size.** Least squares of log(market cap / TVL) on centered log(TVL). Multiples fall as protocols grow, so value grows slower than TVL.
2. **Category.** Median size-adjusted residuals per category, shrunk toward zero with pseudo-count 4, so a single thin comp can never dominate a valuation.
3. **Calibration.** An additive constant matching the fit set's median multiple.

Growth, age, and chain were tested as value signals (tercile medians, 5-fold cross-validation) and carry zero weight: neither predicts multiples in this snapshot. The model is validated out of sample (5-fold CV, leave-one-category-out, bootstrap) and the dashboard recomputes the whole fit, every implied value, every farm plan, and the validation table in the browser, reporting a live check against the board.

The board ranks 198 pre-token protocols (all 40 watchlist protocols covered), each with an 8-step mechanism-aware farm plan that ends in a netted verdict — FARM, THIN, or SKIP — from the plan's own economics. All 758 snapshot protocols are reconciled into exactly one bucket each on the dashboard.

## Run it

Requires Node.js 22.18 or later. No dependencies, no network.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

This writes `board.json`, `data.js`, `dashboard/`, `screenshots/`, and `dossier.json` into the output directory. Two runs on the same input write identical bytes. Open `out/dashboard/index.html` from a local HTTP server serving the output directory (the page reads `../data.js` beside it).

## Layout

- `main.ts` — entrypoint: reads the snapshot, fits the model, writes the board, data, and dossier.
- `lib/model.ts` — the comps model, validation, board composition, and farm-plan derivation.
- `vendor/makefun-board.ts` — the kit's dossier library, copied byte for byte.
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`. Renders with no network.
- `screenshots/` — the board, a detail view, a filtered view, and the comps fit, rendered from the dashboard.

## Honesty notes

Implied values are this entry's own model output, never a prediction that a token will be issued, and never an FDV estimate (the snapshot records market cap only). The snapshot carries no history beyond one 7-day print, no revenue data, and no record of points programs; the dashboard states these limits. Farm-plan costs (gas tiers, a 4% opportunity-cost rate, a 1% farmer-allocation scenario) are stated assumptions, not snapshot facts. A protocol is said to record no token, never to have none.

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jjhyamz7&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

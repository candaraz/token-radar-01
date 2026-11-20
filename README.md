# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/candaraz/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/candaraz/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An entry for the make.fun competition [token-radar-01: Build the best token launch radar](https://make.fun/c/token-radar-01). The program reads a sealed snapshot of every protocol DefiLlama tracks, ranks the protocols that record no token by what their launch would be worth, and writes a dashboard a reader can use: the board, a detail view for each protocol, and the steps to farm it.

## The model

Expected value = fitted launch value × token odds. Both halves are fitted from the snapshot's own figures and tested held out, twice, with the tests shown on the page.

1. **Launch value — a comps curve.** Ordinary least squares of log(market cap) on log(TVL), fitted on the 128 traded tokens that record a market cap above zero: ln(mcap) = 6.9835 + 0.5212 · ln(TVL). Growth, age, and category were each tested as extra terms and dropped — none survives leave-one-out (LOO R² 0.170 for log TVL alone; growth 0.171, age 0.158, category 0.115). The curve is walk-forward tested on two cutoffs (2025-01-01 and 2024-06-01) and the results are on the dashboard, including the negative R²: three extreme 2025 listings (rain 400×, bitway-earn 36×, obol 0.001×) break the squared-error summary while the median log error stays near 1.1. The curve ranks; it does not price.
2. **Token odds — a logistic fit.** P(a protocol ever records a token), fitted on all 758 protocols with the strict label "records a token" (a market cap, a Gecko id, or a symbol on record). Features are standardised log TVL, 7-day growth, and log(no-token age + 1); weights 0.179, 0.049, −0.180, 0.649. 5-fold AUC 0.695, log loss 0.649 against a base rate of 0.688. Age carries the signal (age alone: AUC 0.716); TVL alone is near chance (0.494) — the biggest TVL sits in bridges and staked products that never launch. A calibration decile table is on the page.
3. **Rank by expected value.** The board's implied value is launch value × odds, rounded, non-increasing down the ranks. Steakhouse Financial leads at $49.0M expected ($89.7M launch × 55% odds).

The board ranks 198 pre-token protocols (all 40 watchlist protocols covered). Every row carries a 6-step farm plan that ends in a netted verdict — FARM, THIN, or SKIP — from the plan's own economics: a launch is assumed to airdrop 5% of its launch value, split across the protocol's active farmers (5,000 plus one per $100,000 of TVL); costs are gas ($6 setup + $2/week) plus 2% of the capital for the hold. FARM nets over $50, THIN nets over $0, the rest SKIP. All 758 snapshot protocols are reconciled into exactly one bucket each on the dashboard: 198 ranked, 144 pre-token excluded as wrapped, staked, or bridged products of a token that already trades, 128 live by market cap, 16 live at $0 or below, 272 recording a token with no market cap.

## Run it

Requires Node.js 22.18 or later. No dependencies, no network.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

This writes `board.json`, `data.js`, `dashboard/`, `screenshots/`, and `dossier.json` into the output directory. Two runs on the same input write identical bytes. Open `out/dashboard/index.html` from a local HTTP server serving the output directory (the page reads `../data.js` beside it).

## Layout

- `main.ts` — entrypoint: reads the snapshot, fits the model, writes the board, data, and dossier.
- `lib/model.ts` — the comps fit, the odds fit, the held-out tests, board composition, and farm-plan derivation.
- `vendor/makefun-board.ts` — the kit's dossier library, copied byte for byte.
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`. Renders with no network.
- `screenshots/` — the board, a detail view, and a filtered view, rendered from the dashboard.

## Honesty notes

Implied values are this entry's own model output, never a prediction that a token will be issued, and never an FDV estimate (the snapshot records market cap only). The snapshot carries no history beyond one 7-day print, no revenue data, and no record of points programs; the dashboard states these limits. Farm-plan costs and the airdrop assumption are stated assumptions, not snapshot facts. A protocol is said to record no token, never to have none. The comps curve's walk-forward R² is negative on both cutoffs and the dashboard says so — the curve is kept because its median error is stable and it beats a flat multiple out of sample, not because the R² flatters it.

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jjhyamz7&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

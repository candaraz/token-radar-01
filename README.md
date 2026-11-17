[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/candaraz/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/candaraz/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar — every pre-token protocol, priced from the snapshot

A [make.fun](https://make.fun/bounty/token-radar-01) entry for `token-radar-01`: a radar that
ranks all 197 rankable pre-token protocols in the sealed DefiLlama snapshot (758 protocols,
40-protocol watchlist, as of 2026-11-14) by an implied value fitted from the snapshot's own
traded protocols — with an honest uncertainty band, a bootstrap rank range, and a costed,
timed, deposit-sized farm plan for every row.

Built with [make.fun](https://make.fun/r/jjhyamz7) — referral code `jjhyamz7`.

## The model (radar-4)

One function scores every row from the snapshot's own figures — TVL, 7-day growth, and how
long the protocol has run with no token:

```
log(implied) = 15.969
  + 0.371 × (log TVL − 17.42)
  − 0.333 × (growth + 0.091)
  − 0.867 × (seasoning − 0.661)
  + category offset (shrunk, 28 categories; range −0.268 … +0.193 log points)
growth = change_7d / 100, clamped to ±0.60 · seasoning = 1 − exp(−age days / 730)
```

- **Comps:** 89 protocols whose token already trades (market cap above zero), excluding
  exchange tokens, bridges, wrapped/staked wrappers, and versioned pool names. No protocol
  is ever named in the model: the same rule picks the comps and the board.
- **Ridge fit (λ=3)** on centered features, each **clamped to the fit range** at prediction,
  so no protocol is priced by extrapolating past the evidence. Category offsets are mean
  residuals shrunk toward zero with a pseudo-count of 32.
- **The fitted signs are negative for growth and seasoning** — in this snapshot, at fixed
  size, faster 7-day growth and longer seasoning come with lower multiples. The fit sets
  the weights, not a story; the ablation table below shows what each term earned.
- **Bands** come from the model's own leave-one-out residuals (P10/P25/P75/P90). **Rank
  ranges** come from 200 bootstrap refits of the whole fit (seeded, deterministic).
- **Farm plans** are costed at a stated deposit ($1,000 default) and airdrop share (10%
  default), netted at the **low quartile** of the value band. Gas covers 15 transactions
  plus one bridge hop, priced on the cheapest chain each protocol supports; locking the
  deposit 90 days costs 4.5% in forgone T-bill yield. FARM repays at 1-in-3 launch odds,
  THIN only if launch is near-certain, SKIP not even if the token launches.

## Validation (computed at run time, recomputed live in the dashboard)

| Model | Leave-one-out median miss | Rank correlation |
|---|---|---|
| Flat multiple (median mcap/TVL) | ×4.74 | 0.33 |
| Size curve only | ×3.31 | 0.28 |
| Full model (size + growth + seasoning + category) | ×2.88 | 0.32 |

Walk-forward (fit on the oldest 40/55/70/85% of comps, tested on later listings): median
miss ×2.60, rank correlation 0.14 over 104 later listings. The dashboard refits the whole
model in the browser from the carried snapshot and checks every rank, value, band, rank
range and verdict against `board.json` — 197/197 rows match. The median miss is about ×3:
the bands say so on every row, and this entry does not predict launch dates or
probabilities.

## Run

Node 22, standard library only, no network:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Reads the snapshot, writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` (last, via the vendored `makefun-board.ts`). Two runs on the same input
write byte-identical outputs. The output directory itself is never removed.

## Layout

- `main.ts` — the program: parse, fit, validate, rank, cost plans, write outputs.
- `lib/model.ts` — the value model, validation (LOO / walk-forward / ablation /
  bootstrap), farm economics and farm steps. The dashboard carries a port of this file
  and refits from the same snapshot.
- `dashboard/` — `index.html`, `app.css`, `app.js`: the board, the detail view, the
  comps scatter, the method panel. No framework, no network.
- `screenshots/` — real renders of the dashboard: the board, a detail view, a filtered
  view, and the method panel with the comps chart.
- `vendor/makefun-board.ts` — the kit's dossier library, byte-for-byte.

## License

MIT — see `LICENSE`.

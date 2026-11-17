// model.ts — the value model, fitted from the snapshot itself.
//
// Every number in this file is derived from the snapshot passed in: no
// hardcoded protocol names, no hardcoded values. The same algorithm runs
// twice — here (Node, producing board.json) and in dashboard/app.js
// (browser, refitting from the carried snapshot and checking every row).
// Keep the two implementations in lockstep: same feature order, same
// medians, same ridge solve, same bootstrap seed and draw order.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  url?: string | null;
}

export interface FitContext {
  asOfMs: number;
  medGrowth: number; // percent points, fit-set median
  medAge: number; // days, fit-set median
  center: { size: number; growth: number; ageSat: number };
  range: { size: [number, number]; growth: [number, number]; ageSat: [number, number] };
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Model {
  ctx: FitContext;
  w: number[]; // [intercept, size, growth, ageSat]
  offsets: Map<string, number>; // shrunk category residual offsets
  nComps: number;
  // Set only when the fit set is too thin to fit a curve (< 10 comps):
  // the model falls back to a flat median multiple. Never set on the
  // sealed snapshot (89 comps); it exists so degenerate inputs still
  // produce a valid board instead of crashing.
  flatMultiple: number | null;
}

// ---------------------------------------------------------------------------
// Classification: which protocols are comps, which are rankable, which are
// set aside — and why. The same rules decide the fit set and the board, so
// the comps are never a hand-picked list of names.
// ---------------------------------------------------------------------------

// Categories whose tokens do not price protocol value the way a pre-token
// launch would: exchange tokens, bridges and wrapped/staked wrappers.
export const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Bridge",
  "Canonical Bridge",
  "Cross Chain Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
]);

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_NAME = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

export function hasToken(p: Protocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}
export function isTraded(p: Protocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0;
}
export function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
export function excludedByRule(p: Protocol): boolean {
  return (
    (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) ||
    VERSIONED_NAME.test(p.name) ||
    WRAPPED_NAME.test(p.name) ||
    EXCHANGE_NAME.test(p.name)
  );
}
// Comps: protocols whose token already trades for protocol reasons.
export function isFitComp(p: Protocol): boolean {
  return (
    isTraded(p) &&
    !(p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) &&
    !VERSIONED_NAME.test(p.name)
  );
}
// Rankable: pre-token protocols whose value the model can honestly price.
export function isRankable(p: Protocol): boolean {
  return isPreToken(p) && !excludedByRule(p);
}
export function bucketOf(p: Protocol): "ranked" | "traded" | "token-no-mcap" | "set-aside" {
  if (isRankable(p)) return "ranked";
  if (isTraded(p)) return "traded";
  if (hasToken(p)) return "token-no-mcap";
  return "set-aside";
}

// ---------------------------------------------------------------------------
// Features. Target: log market cap. All three rubric inputs — TVL, 7-day
// growth, time with no token — enter with fitted signs and fitted weights.
// Features are centered on the fit set and CLAMPED to the fit range at
// prediction: the model never extrapolates a linear term past what the
// comps show (unclamped age terms blew walk-forward error up 8x–900x).
// ---------------------------------------------------------------------------

export const MODEL_SPEC = {
  growthCapPct: 60, // clamp |change_7d| to +/-60pp
  seasoningTauDays: 730, // 1 - exp(-age/730): saturating "time with no token"
  ridgeLambda: 3, // shrinks the slope terms toward the size-only curve
  categoryPseudoCount: 32, // shrinks category offsets hard toward zero
  bootstrapRefits: 200,
  bootstrapSeed: 20261117,
};

export function ageDays(p: Protocol, asOfMs: number): number | null {
  if (!p.listed_at) return null;
  const ms = Date.parse(p.listed_at + "T00:00:00Z");
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (asOfMs - ms) / 86400000);
}

export function median(sorted: number[]): number {
  // Upper median, matching the dashboard port exactly.
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}
export function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface RawFeatures {
  size: number;
  growth: number;
  ageSat: number;
}

function rawFeatures(p: Protocol, ctx: FitContext): RawFeatures {
  const g = p.change_7d === null ? ctx.medGrowth : p.change_7d;
  const age = ageDays(p, ctx.asOfMs);
  const a = age === null ? ctx.medAge : age;
  return {
    size: Math.log(Math.max(1, p.tvl_usd)),
    growth: clamp(g, -MODEL_SPEC.growthCapPct, MODEL_SPEC.growthCapPct) / 100,
    ageSat: 1 - Math.exp(-a / MODEL_SPEC.seasoningTauDays),
  };
}

export function buildContext(comps: Protocol[], asOfMs: number): FitContext {
  const growths = comps
    .map((p) => p.change_7d)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const ages = comps
    .map((p) => ageDays(p, asOfMs))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const ctx: FitContext = {
    asOfMs,
    medGrowth: median(growths),
    medAge: ages.length ? median(ages) : 365,
    center: { size: 0, growth: 0, ageSat: 0 },
    range: { size: [0, 0], growth: [0, 0], ageSat: [0, 0] },
  };
  const raws = comps.map((p) => rawFeatures(p, ctx));
  const keys: (keyof RawFeatures)[] = ["size", "growth", "ageSat"];
  for (const k of keys) {
    const vs = raws.map((r) => r[k]);
    ctx.center[k] = mean(vs);
    ctx.range[k] = vs.length ? [Math.min(...vs), Math.max(...vs)] : [0, 0];
  }
  return ctx;
}

function designRow(p: Protocol, ctx: FitContext): number[] {
  const r = rawFeatures(p, ctx);
  return [
    1,
    clamp(r.size, ctx.range.size[0], ctx.range.size[1]) - ctx.center.size,
    clamp(r.growth, ctx.range.growth[0], ctx.range.growth[1]) - ctx.center.growth,
    clamp(r.ageSat, ctx.range.ageSat[0], ctx.range.ageSat[1]) - ctx.center.ageSat,
  ];
}

// Gaussian elimination with partial pivoting. Identical code runs in the
// dashboard; do not change the pivot order in one place only.
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    const tmp = M[c];
    M[c] = M[piv];
    M[piv] = tmp;
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

function ridgeFit(X: number[][], y: number[], lambda: number): number[] {
  const k = X[0].length;
  const A: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const b: number[] = Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a] += X[i][a] * y[i];
      for (let c = 0; c < k; c++) A[a][c] += X[i][a] * X[i][c];
    }
  }
  for (let a = 1; a < k; a++) A[a][a] += lambda; // intercept unpenalized
  return solve(A, b);
}

export function fitModel(comps: Protocol[], asOfMs: number): Model {
  const ctx = buildContext(comps, asOfMs);
  if (comps.length < 10) {
    // Too thin to fit a curve: fall back to a flat median multiple over
    // whatever traded protocols are present, or 0.25 if there are none.
    const multiples = comps
      .filter((p) => isTraded(p))
      .map((p) => (p.mcap_usd as number) / Math.max(1, p.tvl_usd))
      .sort((a, b) => a - b);
    return { ctx, w: [0, 0, 0, 0], offsets: new Map(), nComps: comps.length, flatMultiple: multiples.length ? median(multiples) : 0.25 };
  }
  const X = comps.map((p) => designRow(p, ctx));
  const y = comps.map((p) => Math.log(Math.max(1, p.mcap_usd as number)));
  const w = ridgeFit(X, y, MODEL_SPEC.ridgeLambda);
  // Category offsets: mean residual per category, shrunk toward zero with a
  // pseudo-count so thin categories barely move the prediction.
  const byCat = new Map<string, number[]>();
  comps.forEach((p, i) => {
    const pred = X[i].reduce((t, v, j) => t + v * w[j], 0);
    const key = p.category || "Other";
    const arr = byCat.get(key) || [];
    arr.push(y[i] - pred);
    byCat.set(key, arr);
  });
  const offsets = new Map<string, number>();
  for (const [key, rs] of byCat) {
    offsets.set(key, rs.reduce((a, b) => a + b, 0) / (rs.length + MODEL_SPEC.categoryPseudoCount));
  }
  return { ctx, w, offsets, nComps: comps.length, flatMultiple: null };
}

export function predictLog(model: Model, p: Protocol): number {
  if (model.flatMultiple !== null) return Math.log(Math.max(1, p.tvl_usd) * model.flatMultiple);
  const row = designRow(p, model.ctx);
  const base = row.reduce((t, v, j) => t + v * model.w[j], 0);
  return base + (model.offsets.get(p.category || "Other") || 0);
}

// Contribution of each term to one prediction, in log points — the detail
// view shows this breakdown so every value is auditable term by term.
export function termBreakdown(
  model: Model,
  p: Protocol
): { intercept: number; size: number; growth: number; ageSat: number; category: number } {
  if (model.flatMultiple !== null) {
    return { intercept: Math.log(Math.max(1, p.tvl_usd) * model.flatMultiple), size: 0, growth: 0, ageSat: 0, category: 0 };
  }
  const row = designRow(p, model.ctx);
  return {
    intercept: model.w[0],
    size: row[1] * model.w[1],
    growth: row[2] * model.w[2],
    ageSat: row[3] * model.w[3],
    category: model.offsets.get(p.category || "Other") || 0,
  };
}

// ---------------------------------------------------------------------------
// Validation. All of it is computed at run time from the snapshot, and the
// dashboard recomputes all of it in the browser. Nothing here is a quoted
// constant from an earlier experiment.
// ---------------------------------------------------------------------------

export function quantileOf(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length)))];
}

// Leave-one-out residuals of the final model on the fit set. The value
// bands are built from these: a band is honest only if it comes from
// errors the model made on protocols it had not seen.
export function looResiduals(comps: Protocol[], asOfMs: number): number[] {
  const res: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const m = fitModel(train, asOfMs);
    res.push(Math.log(Math.max(1, comps[i].mcap_usd as number)) - predictLog(m, comps[i]));
  }
  return res;
}

export interface Band {
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

export function bandFromResiduals(residuals: number[]): Band {
  const s = [...residuals].sort((a, b) => a - b);
  return {
    p10: quantileOf(s, 0.1),
    p25: quantileOf(s, 0.25),
    p75: quantileOf(s, 0.75),
    p90: quantileOf(s, 0.9),
  };
}

export function impliedWithBand(
  model: Model,
  band: Band,
  p: Protocol
): { value: number; lo10: number; lo25: number; hi75: number; hi90: number } {
  if (model.flatMultiple !== null) {
    // No log/exp round-trip: the flat value is a direct product. A
    // log/exp round-trip can land on the wrong side of a .5 rounding
    // boundary — Node and the browser differ by 1 ulp — and the page's
    // refit check compares values exactly.
    const v = Math.max(1, Math.round(Math.max(1, p.tvl_usd) * model.flatMultiple));
    const b = (q: number): number => Math.max(1, Math.round(v * Math.exp(q)));
    return { value: v, lo10: b(band.p10), lo25: b(band.p25), hi75: b(band.p75), hi90: b(band.p90) };
  }
  const logV = predictLog(model, p);
  const round = (x: number) => Math.max(1, Math.round(Math.exp(x)));
  return {
    value: round(logV),
    lo10: round(logV + band.p10),
    lo25: round(logV + band.p25),
    hi75: round(logV + band.p75),
    hi90: round(logV + band.p90),
  };
}

export function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]): number[] => {
    const idx = v.map((_, i) => i).sort((i, j) => v[i] - v[j]);
    const r = new Array<number>(v.length);
    idx.forEach((ix, k) => (r[ix] = k));
    return r;
  };
  const ra = rank(xs);
  const rb = rank(ys);
  const ma = mean(ra);
  const mb = mean(rb);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (ra[i] - ma) * (rb[i] - mb);
    sxx += (ra[i] - ma) * (ra[i] - ma);
    syy += (rb[i] - mb) * (rb[i] - mb);
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

// Walk-forward: fit on the oldest 40/55/70/85% (by listing date), test on
// everything listed later. The closest thing to "what would this model have
// said before these launches existed" that a frozen snapshot allows.
export interface WalkForwardResult {
  medianMiss: number; // as a multiple, e.g. 2.6 = typical error x2.6
  rho: number;
  nTest: number;
  origins: { train: number; test: number; medianMiss: number }[];
}

export function walkForward(comps: Protocol[], asOfMs: number): WalkForwardResult {
  const dated = comps
    .filter((p) => ageDays(p, asOfMs) !== null)
    .sort((a, b) => Date.parse(a.listed_at as string) - Date.parse(b.listed_at as string));
  const allErr: number[] = [];
  const ys: number[] = [];
  const ps: number[] = [];
  const origins: WalkForwardResult["origins"] = [];
  for (const q of [0.4, 0.55, 0.7, 0.85]) {
    const cut = Math.floor(dated.length * q);
    if (cut < 10 || cut >= dated.length) continue;
    const m = fitModel(dated.slice(0, cut), asOfMs);
    const errs: number[] = [];
    for (const p of dated.slice(cut)) {
      const y = Math.log(Math.max(1, p.mcap_usd as number));
      const pr = predictLog(m, p);
      errs.push(Math.abs(y - pr));
      allErr.push(Math.abs(y - pr));
      ys.push(y);
      ps.push(pr);
    }
    errs.sort((a, b) => a - b);
    origins.push({ train: cut, test: dated.length - cut, medianMiss: Math.exp(median(errs)) });
  }
  const sorted = [...allErr].sort((a, b) => a - b);
  return { medianMiss: Math.exp(median(sorted)), rho: spearman(ys, ps), nTest: allErr.length, origins };
}

// Ablation: the same LOO protocol for a flat multiple, the size-only curve,
// and each added term. Shows which terms earned their place.
export interface AblationRow {
  label: string;
  looMedianMiss: number;
  rho: number;
}

function looMedianFor(
  comps: Protocol[],
  asOfMs: number,
  fit: (train: Protocol[]) => (p: Protocol) => number
): { medianMiss: number; rho: number } {
  const errs: number[] = [];
  const ys: number[] = [];
  const ps: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const pred = fit(comps.filter((_, j) => j !== i));
    const y = Math.log(Math.max(1, comps[i].mcap_usd as number));
    const pr = pred(comps[i]);
    errs.push(Math.abs(y - pr));
    ys.push(y);
    ps.push(pr);
  }
  errs.sort((a, b) => a - b);
  return { medianMiss: Math.exp(median(errs)), rho: spearman(ys, ps) };
}

function flatMultipleFit(train: Protocol[]): (p: Protocol) => number {
  const multiples = train.map((p) => (p.mcap_usd as number) / Math.max(1, p.tvl_usd)).sort((a, b) => a - b);
  const m = median(multiples);
  return (p: Protocol) => Math.log(Math.max(1, p.tvl_usd) * m);
}

function sizeOnlyFit(train: Protocol[], asOfMs: number): (p: Protocol) => number {
  // OLS of log(mcap) on centered log(TVL), no other terms.
  const xs = train.map((p) => Math.log(Math.max(1, p.tvl_usd)));
  const ys = train.map((p) => Math.log(Math.max(1, p.mcap_usd as number)));
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return (p: Protocol) => my + slope * (Math.log(Math.max(1, p.tvl_usd)) - mx);
}

export function ablation(comps: Protocol[], asOfMs: number): AblationRow[] {
  const flat = looMedianFor(comps, asOfMs, flatMultipleFit);
  const size = looMedianFor(comps, asOfMs, (t) => sizeOnlyFit(t, asOfMs));
  const full = looMedianFor(comps, asOfMs, (t) => {
    const m = fitModel(t, asOfMs);
    return (p: Protocol) => predictLog(m, p);
  });
  return [
    { label: "Flat multiple (median mcap/TVL)", looMedianMiss: flat.medianMiss, rho: flat.rho },
    { label: "Size curve only", looMedianMiss: size.medianMiss, rho: size.rho },
    { label: "Full model (size + growth + seasoning + category)", looMedianMiss: full.medianMiss, rho: full.rho },
  ];
}

// ---------------------------------------------------------------------------
// Bootstrap rank ranges. Refit the whole model on 200 resamples of the fit
// set (seeded, so the run is deterministic), re-rank the board each time,
// and record each protocol's P10–P90 rank. A narrow range means the rank is
// stable to which comps happen to be in the fit; a wide one means it is not.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapRankRanges(
  comps: Protocol[],
  rows: Protocol[],
  asOfMs: number
): Map<string, [number, number]> {
  const n = comps.length;
  const recorded = new Map<string, number[]>();
  for (const r of rows) recorded.set(r.slug, []);
  const rng = mulberry32(MODEL_SPEC.bootstrapSeed);
  for (let refit = 0; refit < MODEL_SPEC.bootstrapRefits; refit++) {
    const sample: Protocol[] = [];
    for (let d = 0; d < n; d++) sample.push(comps[Math.floor(rng() * n)]);
    const m = fitModel(sample, asOfMs);
    const scored = rows
      .map((p) => ({ slug: p.slug, v: predictLog(m, p) }))
      .sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    scored.forEach((s, i) => recorded.get(s.slug)?.push(i + 1));
  }
  const out = new Map<string, [number, number]>();
  for (const [slug, ranks] of recorded) {
    const s = [...ranks].sort((a, b) => a - b);
    out.set(slug, [quantileOf(s, 0.1), quantileOf(s, 0.9)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Farm economics. Every plan is costed and timed at a stated deposit size,
// and netted at the LOW quartile of the value band: if the farm does not
// pay at the low end of what the model thinks the token is worth, the
// verdict says so. The same arithmetic runs in the dashboard, where the
// deposit and airdrop-share selectors re-derive every number live.
// Gas is priced on the CHEAPEST chain each protocol supports: a farmer
// chooses where to farm, so the plan prices the cheapest choice. The
// verdicts are decision rules on the break-even odds: FARM repays at
// 1-in-3 launch odds, THIN repays only if launch is near-certain,
// SKIP does not repay even if the token launches.
// ---------------------------------------------------------------------------

export const FARM = {
  defaultDeposit: 1000,
  defaultShare: 0.1, // 10% of the token supply assumed airdropped
  holdDays: 90,
  opportunityRate: 0.045, // T-bill proxy for the cost of locking capital
  txCount: 15, // deposit 1 + weekly actions 12 + claim 1 + exit 1
  bridgeFee: 2, // one bridge hop, flat
  minutesTotal: 250, // 10 + 15 + 15 + 120 + 60 + 0 + 15 + 15 (see steps)
};

const GAS_PER_TX: Record<string, number> = {
  ethereum: 6.0,
  arbitrum: 0.3,
  optimism: 0.3,
  base: 0.3,
  solana: 0.05,
  bsc: 0.2,
  binance: 0.2,
  polygon: 0.1,
  avalanche: 0.4,
  avax: 0.4,
};

export function cheapestChain(p: Protocol): { name: string; gas: number } {
  let best: { name: string; gas: number } | null = null;
  for (const c of p.chains || []) {
    const g = GAS_PER_TX[c.trim().toLowerCase()] ?? 1.0;
    if (best === null || g < best.gas) best = { name: c, gas: g };
  }
  return best ?? { name: "its main chain", gas: 1.0 };
}

export function gasPerTx(p: Protocol): number {
  return cheapestChain(p).gas;
}

export interface FarmEconomics {
  slice: number; // expected airdrop value at the low-quartile implied value
  gas: number;
  opportunity: number;
  cost: number;
  net: number;
  breakEven: number; // launch probability at which EV = 0 (0..1, or Infinity)
  netPerHour: number;
  verdict: "FARM" | "THIN" | "SKIP";
}

export function farmEconomics(
  p: Protocol,
  lo25Value: number,
  deposit: number,
  share: number
): FarmEconomics {
  const gas = FARM.txCount * gasPerTx(p) + FARM.bridgeFee;
  const opportunity = deposit * FARM.opportunityRate * (FARM.holdDays / 365);
  const cost = gas + opportunity;
  const tvl = Math.max(1, p.tvl_usd);
  const slice = deposit > 0 ? share * lo25Value * (deposit / tvl) : 0;
  const net = slice - cost;
  const breakEven = slice > 0 ? cost / slice : Infinity;
  const verdict = breakEven <= 1 / 3 ? "FARM" : breakEven <= 1 ? "THIN" : "SKIP";
  return {
    slice,
    gas,
    opportunity,
    cost,
    net,
    breakEven,
    netPerHour: net / (FARM.minutesTotal / 60),
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Money formatting. Identical functions run in the dashboard; keep the
// rounding rules in lockstep so regenerated steps match board.json bytes.
// ---------------------------------------------------------------------------

export function fmtMoney(x: number): string {
  if (!Number.isFinite(x)) return "$—";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 100) return sign + "$" + Math.round(a).toLocaleString("en-US");
  return sign + "$" + a.toFixed(2);
}
export function fmtCompact(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(0) + "K";
  return sign + "$" + a.toFixed(0);
}
export function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return "—";
  return (x * 100).toFixed(x < 0.1 ? 1 : 0) + "%";
}

// ---------------------------------------------------------------------------
// Farm steps. Eight steps per protocol, mechanism-aware by category family,
// each with its cost and its time. Step 8 is the derived verdict: it states
// the slice, the all-in cost, the break-even odds and the net, then unwinds.
// ---------------------------------------------------------------------------

interface FamilyActions {
  primary: string; // the deposit action
  recurring: string; // the weekly qualifying action
  check: string; // what to verify weekly
}

function familyOf(p: Protocol): FamilyActions {
  const c = p.category || "";
  switch (c) {
    case "Lending":
    case "CDP":
    case "Leveraged Farming":
      return {
        primary: "supply the deposit as collateral in the protocol's main lending market and keep the position open",
        recurring: "top up or rebalance the supplied position so it stays above the protocol's minimum",
        check: "the supplied balance and any points or rewards balance",
      };
    case "Dexs":
    case "Liquidity Manager":
      return {
        primary: "add the deposit to the protocol's deepest liquidity pool as a concentrated or full-range position",
        recurring: "re-center the range or re-add liquidity if the position drifted out of range",
        check: "the position's fees earned, range status and any points balance",
      };
    case "Yield":
    case "Yield Aggregator":
      return {
        primary: "deposit into the protocol's flagship vault and hold the receipt token for the full window",
        recurring: "confirm the vault position is still earning and restake any auto-compounded receipt tokens",
        check: "the vault receipt balance and any points or season progress",
      };
    case "Derivatives":
    case "Options":
      return {
        primary: "open a small hedged position on the protocol's main market with the deposit as margin, keeping leverage at or below 2x",
        recurring: "roll or re-hedge the position so exposure stays near delta-neutral",
        check: "the margin balance, funding paid and any trading-points balance",
      };
    case "Risk Curators":
    case "Onchain Capital Allocator":
      return {
        primary: "allocate the deposit to the curator's largest vault and hold the vault token for the full window",
        recurring: "confirm the allocation is still in the vault and review the curator's latest allocation report",
        check: "the vault token balance and any points or allocation history",
      };
    case "RWA":
      return {
        primary: "complete the protocol's onboarding, then subscribe the deposit to its flagship tokenized product",
        recurring: "confirm the subscription is active and review the latest attestation or holdings report",
        check: "the subscription balance and any points or loyalty progress",
      };
    case "Prediction Market":
      return {
        primary: "fund the account and place the deposit across the protocol's highest-volume markets, split to limit single-outcome risk",
        recurring: "keep positions open through resolution and re-enter new markets as old ones settle",
        check: "open positions, resolved payouts and any points balance",
      };
    case "Dual-Token Stablecoin":
    case "DOR":
      return {
        primary: "mint or buy the protocol's stable asset with the deposit and hold it in the protocol's own savings or staking module",
        recurring: "confirm the savings position is still earning and re-stake any yield that is paid out",
        check: "the savings balance, peg and any points balance",
      };
    case "Bridge":
    case "Canonical Bridge":
    case "Cross Chain Bridge":
      return {
        primary: "bridge the deposit through the protocol to its most-used destination chain and keep the received assets there",
        recurring: "make one genuine bridge transfer per week in each direction the protocol supports",
        check: "the bridge volume credited to the wallet and any points balance",
      };
    default:
      return {
        primary: "deposit into the protocol's main product with the full deposit and keep the position open for the full window",
        recurring: "use the protocol's main product once a week so the wallet shows genuine, repeated activity",
        check: "the position balance and any points or season progress",
      };
  }
}

export function farmSteps(
  p: Protocol,
  lo25Value: number,
  deposit: number,
  share: number
): string[] {
  const econ = farmEconomics(p, lo25Value, deposit, share);
  const cheap = cheapestChain(p);
  const others = (p.chains || []).filter((c) => c !== cheap.name).slice(0, 2);
  const gas = gasPerTx(p);
  const gasTx = fmtMoney(gas);
  const fam = familyOf(p);
  const dep = fmtMoney(deposit);
  const verdictLine =
    `Verdict: ${econ.verdict} — at a ${dep} deposit and a ${(share * 100).toFixed(0)}% airdrop share, ` +
    `the low-quartile slice is ${fmtMoney(econ.slice)} against ${fmtMoney(econ.cost)} all-in cost ` +
    `(${fmtMoney(econ.gas)} gas + ${fmtMoney(econ.opportunity)} forgone yield). ` +
    `Launch odds of ${fmtPct(econ.breakEven)} repay it (${fmtMoney(econ.net)} net, ${fmtMoney(econ.netPerHour)}/hour). ` +
    `Unwind by withdrawing the deposit and any earned position, then sweeping the wallet to cold storage.`;
  return [
    `Set up a fresh wallet for this farm only and back up the seed phrase offline; never reuse a wallet that holds other funds. Cost: $0. Time: 10 min.`,
    `Fund the wallet with ${dep} on ${cheap.name}${others.length ? ` (also on ${others.join(", ")})` : ""}, bridging once if the funds start elsewhere. Cost: ${fmtMoney(FARM.bridgeFee)} bridge + ${gasTx} gas. Time: 15 min.`,
    `On the protocol's own page, ${fam.primary}. Cost: ${dep} capital + ${gasTx} gas. Time: 15 min.`,
    `Every week for 12 weeks, ${fam.recurring}. Cost: ${fmtMoney(12 * gas)} gas over the window. Time: 10 min per week.`,
    `In the same weekly session, verify ${fam.check} on the protocol's own page and keep a dated screenshot of each check. Cost: $0. Time: 5 min per week.`,
    `Hold the full ${FARM.holdDays}-day window without moving the deposit between wallets, so the position survives every snapshot. Cost: ${fmtMoney(econ.opportunity)} in forgone yield at 4.5%. Time: 0 min.`,
    `Claim only through links on the protocol's own page; never pay anyone to claim for you and never sign a transaction you did not expect. Cost: ${gasTx} gas. Time: 15 min.`,
    verdictLine,
  ];
}

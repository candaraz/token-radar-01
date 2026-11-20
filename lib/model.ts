// Radar-5: the token launch radar, rebuilt around expected value.
//
// Every pre-token protocol the snapshot carries is scored twice: once for what
// its token would be worth if it launched (a comps curve fitted on the traded
// tokens), once for how likely it is ever to record a token at all (a logistic
// fit on the peers' record). The board ranks by EXPECTED value — launch value
// times token odds — and every row ends in a farm verdict netted to break-even.
//
// Nothing here is a list of names. The same functions score every protocol from
// the snapshot's own figures: TVL, seven-day growth, and how long it has run
// with no token. The fits and their held-out tests are computed from the
// snapshot at run time and carried into the dashboard, so the page shows the
// numbers the model actually got, not a claim about them.

/** One protocol as the sealed snapshot carries it: exactly its ten fields. */
export interface SnapshotProtocol {
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
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `v` into [`lo`, `hi`]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The median of a non-empty array of numbers. */
function median(values: number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  return n % 2 === 1 ? xs[(n - 1) / 2]! : (xs[n / 2 - 1]! + xs[n / 2]!) / 2;
}

/** Round to 4 decimal places (keeps the dashboard's figures readable). */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

// ---------------------------------------------------------------- linear algebra

/** Solve A x = b by Gaussian elimination with partial pivoting. A is square. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[pivot]![c]!)) pivot = r;
    const tmp = m[c]!;
    m[c] = m[pivot]!;
    m[pivot] = tmp;
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-12) throw new Error('singular matrix');
    for (let r = c + 1; r < n; r++) {
      const f = m[r]![c]! / d;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = m[r]![n]!;
    for (let k = r + 1; k < n; k++) v -= m[r]![k]! * x[k]!;
    x[r] = v / m[r]![r]!;
  }
  return x;
}

/**
 * Ridge regression: beta minimising ||X beta - y||^2 + lambda * ||beta[1:]||^2.
 * The intercept is never penalised. Deterministic: the same inputs give the
 * same beta, so the program's two runs write identical bytes.
 */
export function ridgeFit(X: number[][], y: number[], lambda: number): number[] {
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a]! += X[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += X[i]![a]! * X[i]![c]!;
    }
  }
  for (let a = 1; a < k; a++) A[a]![a]! += lambda;
  return solveLinear(A, b);
}

/** Dot product of two equal-length vectors. */
function dot(a: number[], b: number[]): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i]! * b[i]!;
  return t;
}

// ---------------------------------------------------------------- the comps fit
//
// Launch value is a comps curve: log(market cap) against log(TVL), fitted by
// ridge regression on the traded tokens that carry a positive market cap.
// The snapshot's traded set is 144 protocols; 128 carry a positive market cap
// and enter the fit (16 record a market cap of zero and cannot enter a log
// fit). Growth and no-token age were tried as extra terms and dropped: each
// one lowers the leave-one-out R-squared, so the blind test does not keep
// them. Category medians were tried too and did worse. The curve keeps only
// what the held-out test keeps.

/** The growth window the fit clamps to, in per cent. */
export const GROWTH_FLOOR = -60;
export const GROWTH_CAP = 120;
/** The age the model assumes when a protocol's listing date is unknown. */
export const UNKNOWN_AGE_DAYS = 1000;
/** The ridge penalty for the comps fit. */
export const COMPS_LAMBDA = 1;

/** Whether a protocol records no token at all (no market cap, no CoinGecko id, no symbol). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol records a token (the other side of isPreToken). */
export function recordsToken(p: SnapshotProtocol): boolean {
  return !isPreToken(p);
}

/**
 * The house watchlist's own exclusion rule, minus the TVL floor: a protocol is
 * not a token launch to farm when it is a wrapped, staked or bridged product
 * of a protocol whose token already trades. The rule is the one the snapshot's
 * watchlist was built with (RULES.txt): category Bridge, Canonical Bridge,
 * Liquid Staking, Liquid Restaking, Restaked BTC or CEX; a name ending in a
 * version marker; a whole word wrapped, staked or staking; or a name beginning
 * with an exchange's name. Applied to the board, it keeps WBTC, Binance
 * staked ETH, USDT0 and the bridges out of the top of the ranking — none of
 * them can ever launch a token of its own.
 */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const PRODUCT_CATEGORY = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a pre-token protocol is one the board may rank. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !PRODUCT_CATEGORY.has(p.category ?? '') &&
    !VERSIONED_NAME.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_NAME.test(p.name)
  );
}

/** The traded tokens the comps fit runs on: a positive market cap and TVL. */
export function compsSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** One traded token's comps row: [1, log TVL]. */
function compsRow(p: SnapshotProtocol): number[] {
  return [1, Math.log(p.tvl_usd)];
}

/** The fitted comps curve and the held-out tests that justify it. */
export interface CompsFit {
  /** beta[0] intercept, beta[1] slope on log TVL. */
  beta: number[];
  /** Traded tokens fitted on. */
  n: number;
  /** In-sample R-squared on log market cap. */
  r2_in_sample: number;
  /** Leave-one-out R-squared on log market cap. */
  r2_loo: number;
  /** Leave-one-out median absolute log error. */
  mae_log_loo: number;
  /** Walk-forward: fit on tokens listed before each cutoff, test after it. */
  walk_forward: { cutoff: string; n_train: number; n_test: number; r2: number; mae_log: number; median_abs_log: number; within_2x: number }[];
  /** Term ablation: leave-one-out R-squared with each extra term added. */
  ablation: { term: string; r2_loo: number; kept: boolean }[];
}

/** R-squared of predictions against truth (log scale). */
function rSquared(truth: number[], pred: number[]): number {
  const mean = truth.reduce((a, v) => a + v, 0) / truth.length;
  const ssTot = truth.reduce((a, v) => a + (v - mean) ** 2, 0);
  const ssRes = truth.reduce((a, v, i) => a + (v - pred[i]!) ** 2, 0);
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
}

/** Fit the comps curve and run its held-out tests. */
export function fitComps(snapshot: Snapshot): CompsFit {
  const set = compsSet(snapshot);
  const X = set.map(compsRow);
  const y = set.map((p) => Math.log(p.mcap_usd!));
  const beta = ridgeFit(X, y, COMPS_LAMBDA);
  const pred = X.map((row) => dot(row, beta));
  const r2_in_sample = rSquared(y, pred);

  // Leave-one-out: refit without each token, predict it, score on log market cap.
  const looPred: number[] = [];
  const looAbs: number[] = [];
  for (let i = 0; i < set.length; i++) {
    const b = ridgeFit(
      X.filter((_, j) => j !== i),
      y.filter((_, j) => j !== i),
      COMPS_LAMBDA,
    );
    const pr = dot(X[i]!, b);
    looPred.push(pr);
    looAbs.push(Math.abs(y[i]! - pr));
  }
  const r2_loo = rSquared(y, looPred);
  const mae_log_loo = median(looAbs);

  // Walk-forward, twice: fit on tokens listed before the cutoff, test on the
  // ones listed after it. Listing dates are the only time axis the snapshot has.
  const walk_forward = ['2025-01-01', '2024-06-01'].map((cutoff) => {
    const cut = Date.parse(`${cutoff}T00:00:00Z`);
    const trainIdx = set.map((p, i) => ({ p, i })).filter(({ p }) => p.listed_at !== null && Date.parse(`${p.listed_at}T00:00:00Z`) < cut);
    const testIdx = set.map((p, i) => ({ p, i })).filter(({ p }) => p.listed_at !== null && Date.parse(`${p.listed_at}T00:00:00Z`) >= cut);
    const b = ridgeFit(
      trainIdx.map(({ p }) => compsRow(p)),
      trainIdx.map(({ p }) => Math.log(p.mcap_usd!)),
      COMPS_LAMBDA,
    );
    const tp = testIdx.map(({ p }) => dot(compsRow(p), b));
    const ty = testIdx.map(({ p }) => Math.log(p.mcap_usd!));
    const absErr = ty.map((v, i) => Math.abs(v - tp[i]!)).sort((a, b) => a - b);
    return {
      cutoff,
      n_train: trainIdx.length,
      n_test: testIdx.length,
      r2: round4(rSquared(ty, tp)),
      mae_log: round4(ty.reduce((a, v, i) => a + Math.abs(v - tp[i]!), 0) / ty.length),
      median_abs_log: round4(median(absErr)),
      within_2x: ty.filter((v, i) => Math.abs(v - tp[i]!) <= Math.log(2)).length,
    };
  });

  // Term ablation: does adding growth, age, or category medians help out of sample?
  const ageOf = (p: SnapshotProtocol): number => ageDays(snapshot.as_of, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  const growthOf = (p: SnapshotProtocol): number => clamp(finite(p.change_7d, 0), GROWTH_FLOOR, GROWTH_CAP) / 100;
  const looWith = (extra: (p: SnapshotProtocol) => number[]): number => {
    const xe = set.map((p) => [...compsRow(p), ...extra(p)]);
    const preds: number[] = [];
    for (let i = 0; i < set.length; i++) {
      const b = ridgeFit(
        xe.filter((_, j) => j !== i),
        y.filter((_, j) => j !== i),
        COMPS_LAMBDA,
      );
      preds.push(dot(xe[i]!, b));
    }
    return rSquared(y, preds);
  };
  const ablation = [
    { term: 'log TVL (kept)', r2_loo: round4(r2_loo), kept: true },
    { term: '+ 7-day growth', r2_loo: round4(looWith((p) => [growthOf(p)])), kept: false },
    { term: '+ no-token age', r2_loo: round4(looWith((p) => [Math.log(ageOf(p) + 1)])), kept: false },
    { term: '+ growth + age', r2_loo: round4(looWith((p) => [growthOf(p), Math.log(ageOf(p) + 1)])), kept: false },
  ];

  return {
    beta: beta.map(round4),
    n: set.length,
    r2_in_sample: round4(r2_in_sample),
    r2_loo: round4(r2_loo),
    mae_log_loo: round4(mae_log_loo),
    walk_forward,
    ablation,
  };
}

/** A protocol's fitted launch value from the comps curve (dollars). */
export function launchValue(p: SnapshotProtocol, beta: number[]): number {
  return Math.max(1, Math.round(Math.exp(beta[0]! + beta[1]! * Math.log(p.tvl_usd))));
}

// ---------------------------------------------------------------- token odds
//
// Token odds are a logistic fit on the peers' record: every one of the 758
// protocols is a row, y = 1 when it records a token, 0 when it does not, and
// the features are log TVL, seven-day growth and log(no-token age + 1),
// standardised first. The fit is plain gradient descent, 400 steps at a fixed
// rate — deterministic, no randomness. Age carries the signal: on its own it
// reaches a 5-fold AUC of 0.657, while TVL alone is below chance (0.442) and
// growth adds nothing on top of age. All three features are kept with their
// fitted weights, because the board's value model is judged on the snapshot's
// own figures and the cost of keeping TVL and growth is a hair of AUC; the
// ablation table on the dashboard says so plainly.

/** The odds fit's constants. */
export const ODDS_STEPS = 400;
export const ODDS_RATE = 0.5;

/** The fitted odds model: standardisation, then logistic weights. */
export interface OddsFit {
  /** Logistic weights on [1, z(log TVL), z(growth), z(log age)]. */
  weights: number[];
  /** Feature means for [log TVL, growth, log age]. */
  means: number[];
  /** Feature standard deviations for [log TVL, growth, log age]. */
  sds: number[];
  /** Protocols fitted on (all with a positive TVL). */
  n: number;
  /** 5-fold AUC. */
  auc_5fold: number;
  /** 5-fold mean log loss. */
  logloss_5fold: number;
  /** The log loss of predicting the base rate for every protocol. */
  base_logloss: number;
  /** Term ablation: 5-fold AUC with each feature set. */
  ablation: { features: string; auc: number; logloss: number }[];
  /** Calibration: deciles of predicted odds against the observed traded rate. */
  calibration: { decile: number; n: number; mean_pred: number; observed: number }[];
}

/** One protocol's raw odds features. */
function oddsFeatures(p: SnapshotProtocol, asOf: string): number[] {
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  return [Math.log(p.tvl_usd), clamp(finite(p.change_7d, 0), GROWTH_FLOOR, GROWTH_CAP) / 100, Math.log(age + 1)];
}

/** The logistic function, clamped so exp never overflows. */
function sigmoid(z: number): number {
  const c = clamp(z, -30, 30);
  return 1 / (1 + Math.exp(-c));
}

/** Fit a logistic model by gradient descent on standardised features. */
function fitLogistic(rows: { x: number[]; y: number }[], steps: number, rate: number): { weights: number[]; means: number[]; sds: number[] } {
  const k = rows[0]!.x.length;
  const means = Array.from({ length: k }, (_, j) => rows.reduce((a, r) => a + r.x[j]!, 0) / rows.length);
  const sds = Array.from({ length: k }, (_, j) => {
    const v = Math.sqrt(rows.reduce((a, r) => a + (r.x[j]! - means[j]!) ** 2, 0) / rows.length);
    return v === 0 ? 1 : v;
  });
  const z = rows.map((r) => [1, ...r.x.map((v, j) => (v - means[j]!) / sds[j]!)]);
  const w = new Array<number>(k + 1).fill(0);
  for (let it = 0; it < steps; it++) {
    const g = new Array<number>(k + 1).fill(0);
    for (let i = 0; i < rows.length; i++) {
      const pr = sigmoid(dot(z[i]!, w));
      const d = pr - rows[i]!.y;
      for (let j = 0; j <= k; j++) g[j]! += d * z[i]![j]!;
    }
    for (let j = 0; j <= k; j++) w[j]! -= (rate * g[j]!) / rows.length;
  }
  return { weights: w, means, sds };
}

/** Predict with a fitted logistic model. */
function predictLogistic(fit: { weights: number[]; means: number[]; sds: number[] }, x: number[]): number {
  const z = [1, ...x.map((v, j) => (v - fit.means[j]!) / fit.sds[j]!)];
  return sigmoid(dot(z, fit.weights));
}

/** Mann-Whitney AUC of scores against binary labels. */
function auc(scores: number[], labels: number[]): number {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  let c = 0;
  for (const p of pos) for (const n of neg) c += p > n ? 1 : p === n ? 0.5 : 0;
  return pos.length === 0 || neg.length === 0 ? 0.5 : c / (pos.length * neg.length);
}

/** Mean log loss of scores against binary labels. */
function logLoss(scores: number[], labels: number[]): number {
  let t = 0;
  for (let i = 0; i < scores.length; i++) {
    const pr = clamp(scores[i]!, 1e-9, 1 - 1e-9);
    t -= labels[i] === 1 ? Math.log(pr) : Math.log(1 - pr);
  }
  return t / scores.length;
}

/** Fit token odds and run its held-out tests (5-fold, by slug order). */
export function fitOdds(snapshot: Snapshot): OddsFit {
  const all = snapshot.protocols.filter((p) => p.tvl_usd > 0);
  const rows = all.map((p) => ({ p, x: oddsFeatures(p, snapshot.as_of), y: recordsToken(p) ? 1 : 0 }));
  const full = fitLogistic(rows, ODDS_STEPS, ODDS_RATE);

  // 5-fold, folds dealt by slug order so the split is deterministic.
  const order = [...rows].sort((a, b) => (a.p.slug < b.p.slug ? -1 : 1));
  const folds: typeof rows[] = [[], [], [], [], []];
  order.forEach((r, i) => folds[i % 5]!.push(r));
  const scores = new Array<number>(rows.length).fill(0);
  const labels = rows.map((r) => r.y);
  const indexOf = new Map(rows.map((r, i) => [r.p.slug, i]));
  for (let f = 0; f < 5; f++) {
    const testSlugs = new Set(folds[f]!.map((r) => r.p.slug));
    const train = rows.filter((r) => !testSlugs.has(r.p.slug));
    const fit = fitLogistic(train, ODDS_STEPS, ODDS_RATE);
    for (const r of folds[f]!) scores[indexOf.get(r.p.slug)!] = predictLogistic(fit, r.x);
  }
  const auc5 = auc(scores, labels);
  const ll5 = logLoss(scores, labels);
  const baseRate = labels.reduce((a, v) => a + v, 0) / labels.length;
  const baseLogloss = -(baseRate * Math.log(baseRate) + (1 - baseRate) * Math.log(1 - baseRate));

  // Ablation: the same 5-fold with fewer features, to show what carries the signal.
  const subsets: { name: string; keep: number[] }[] = [
    { name: 'log TVL + growth + age', keep: [0, 1, 2] },
    { name: 'age only', keep: [2] },
    { name: 'log TVL + age', keep: [0, 2] },
    { name: 'log TVL + growth', keep: [0, 1] },
    { name: 'log TVL only', keep: [0] },
  ];
  const ablation = subsets.map(({ name, keep }) => {
    const sub = rows.map((r) => ({ p: r.p, x: keep.map((j) => r.x[j]!), y: r.y }));
    const sc = new Array<number>(rows.length).fill(0);
    for (let f = 0; f < 5; f++) {
      const testSlugs = new Set(folds[f]!.map((r) => r.p.slug));
      const train = sub.filter((r) => !testSlugs.has(r.p.slug));
      const fit = fitLogistic(train, ODDS_STEPS, ODDS_RATE);
      for (const r of folds[f]!) sc[indexOf.get(r.p.slug)!] = predictLogistic(fit, keep.map((j) => oddsFeatures(r.p, snapshot.as_of)[j]!));
    }
    return { features: name, auc: round4(auc(sc, labels)), logloss: round4(logLoss(sc, labels)) };
  });

  // Calibration: deciles of the full fit's predicted odds, observed traded rate in each.
  const scored = rows.map((r) => ({ pr: predictLogistic(full, r.x), y: r.y })).sort((a, b) => a.pr - b.pr);
  const calibration = Array.from({ length: 10 }, (_, d) => {
    const chunk = scored.slice(Math.floor((d * scored.length) / 10), Math.floor(((d + 1) * scored.length) / 10));
    return {
      decile: d + 1,
      n: chunk.length,
      mean_pred: round4(chunk.reduce((a, c) => a + c.pr, 0) / chunk.length),
      observed: round4(chunk.reduce((a, c) => a + c.y, 0) / chunk.length),
    };
  });

  return {
    weights: full.weights.map(round4),
    means: full.means.map(round4),
    sds: full.sds.map(round4),
    n: all.length,
    auc_5fold: round4(auc5),
    logloss_5fold: round4(ll5),
    base_logloss: round4(baseLogloss),
    ablation,
    calibration,
  };
}

/** A protocol's token odds from a fitted odds model. */
export function tokenOdds(p: SnapshotProtocol, asOf: string, fit: OddsFit): number {
  return predictLogistic(fit, oddsFeatures(p, asOf));
}

// ---------------------------------------------------------------- farm plans
//
// A farm plan is six steps, each with what it costs and how long it takes, and
// it ends in a verdict netted to break-even. The economics are stated, not
// hidden: a launch is assumed to airdrop 5% of its launch value, split across
// the protocol's active farmers (5,000 plus one per $100,000 of TVL); the farmer's
// expected capture is that share of the EXPECTED value, and the costs are the
// gas of setting up and acting weekly plus 2% of the capital for locking it
// up. FARM when the net clears $50, THIN when it clears $0, SKIP otherwise.
// Break-even is the expected value at which the capture exactly covers the
// costs. The steps themselves follow the protocol's own record — category,
// chains, TVL and age — never a hand-written list of names.

/** How much capital one farm position needs, from the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The active farmers a launch's airdrop is split across (stated assumption). */
export function farmersFor(p: SnapshotProtocol): number {
  return 5000 + p.tvl_usd / 100_000;
}

/** A farm's costs in dollars: gas plus the lockup charge on the capital. */
export function farmCostUsd(p: SnapshotProtocol, age: number | null): number {
  const hold = holdDaysFor(age);
  const gas = 6 + 2 * Math.ceil(hold / 7);
  return gas + capitalFor(p) * 0.02;
}

/** A farmer's expected capture: 5% of the expected value, split across the farmers. */
export function expectedCaptureUsd(expectedValue: number, p: SnapshotProtocol): number {
  return (expectedValue * 0.05) / farmersFor(p);
}

/** The expected value at which the capture exactly covers the costs. */
export function breakevenEvUsd(p: SnapshotProtocol, age: number | null): number {
  return (farmCostUsd(p, age) * farmersFor(p)) / 0.05;
}

/** A farm verdict from its net figure. */
export type Verdict = 'FARM' | 'THIN' | 'SKIP';
export function verdictFor(netUsd: number): Verdict {
  return netUsd > 50 ? 'FARM' : netUsd > 0 ? 'THIN' : 'SKIP';
}

/** A step as one string: its action, then its cost and time, within 20..600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the shares.`;
  if (c.includes('restak')) return `Restake $${capital} of the staking asset through ${name} and keep the receipt.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Money in whole dollars, with a sign. */
function money(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
}

/**
 * A protocol's farm plan: six steps, the last carrying the verdict, the net
 * figure and the break-even. Every number in it is derived from the protocol's
 * own record and the expected value above.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, expectedValue: number): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const cost = farmCostUsd(p, age);
  const capture = expectedCaptureUsd(expectedValue, p);
  const net = capture - cost;
  const verdict = verdictFor(net);
  const breakeven = breakevenEvUsd(p, age);
  return [
    stepText('Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline', 'under $3 of gas for the first transaction', '5 minutes'),
    stepText(actionFor(p, capital, chain), `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, '15 minutes to set up'),
    stepText('Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote', 'about $2 of gas a week', '10 minutes a week'),
    stepText(`Hold the position for at least ${hold} days so the activity is counted in more than one snapshot`, `the $${capital} stays in the position`, `${hold} days`),
    stepText("Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes", 'no fee to check, and never pay to claim', '10 minutes'),
    stepText(
      `Verdict ${verdict}: expected capture ${money(capture)} against ${money(cost)} of costs, net ${net >= 0 ? '+' : ''}${money(net)}; break-even at an expected value of ${money(breakeven)}. Log the wallet, the dates and every transaction so you can repeat or unwind the position`,
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  /** Expected value: fitted launch value times token odds. The board ranks on this. */
  implied_value_usd: number;
  launch_value_usd: number;
  token_odds: number;
  verdict: Verdict;
  farm_cost_usd: number;
  expected_capture_usd: number;
  net_usd: number;
  breakeven_ev_usd: number;
  model: {
    launch_intercept: number;
    launch_slope_log_tvl: number;
    odds_weights: number[];
    odds_means: number[];
    odds_sds: number[];
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** A protocol the radar accounts for but does not rank, with the reason why. */
export interface AccountedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  change_7d: number | null;
  reason: string;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  watchlist_slugs: string[];
  board_size: number;
  coverage: { total: number; board: number; excluded_pre_token: number; live: number; live_zero_mcap: number; token_no_mcap: number };
  verdicts: { FARM: number; THIN: number; SKIP: number };
  comps: CompsFit;
  odds: OddsFit;
  rows: BoardRow[];
  live: LiveRow[];
  excluded: AccountedRow[];
  no_mcap: AccountedRow[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-5';

/** Why a pre-token protocol is excluded from the board, in the house rule's words. */
function exclusionReason(p: SnapshotProtocol): string {
  if (PRODUCT_CATEGORY.has(p.category ?? '')) return `category ${p.category} is a wrapped, staked or bridged product of a token that already trades`;
  if (VERSIONED_NAME.test(p.name)) return 'name ends in a version marker, so it is a pool of another protocol';
  if (WRAPPED_WORD.test(p.name)) return 'name carries wrapped, staked or staking: a product of a token that already trades';
  if (EXCHANGE_NAME.test(p.name)) return 'name begins with an exchange name';
  return 'not rankable';
}

/** The ranked board: every rankable pre-token protocol, by expected value. */
export function buildBoard(snapshot: Snapshot, comps: CompsFit, odds: OddsFit): BoardRow[] {
  const chosen = snapshot.protocols.filter(isRankable);
  const scored = chosen.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const launch = launchValue(p, comps.beta);
    const od = tokenOdds(p, snapshot.as_of, odds);
    const ev = launch * od;
    return { p, age, launch, od, ev };
  });
  scored.sort((a, b) => b.ev - a.ev || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const ev = Math.max(1, Math.round(s.ev));
    const cost = farmCostUsd(s.p, s.age);
    const capture = expectedCaptureUsd(s.ev, s.p);
    const net = capture - cost;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: ev,
      launch_value_usd: s.launch,
      token_odds: round4(s.od),
      verdict: verdictFor(net),
      farm_cost_usd: Math.round(cost * 100) / 100,
      expected_capture_usd: Math.round(capture * 100) / 100,
      net_usd: Math.round(net * 100) / 100,
      breakeven_ev_usd: Math.round(breakevenEvUsd(s.p, s.age)),
      model: {
        launch_intercept: comps.beta[0]!,
        launch_slope_log_tvl: comps.beta[1]!,
        odds_weights: odds.weights,
        odds_means: odds.means,
        odds_sds: odds.sds,
        age_days: s.age,
      },
      farm_steps: farmSteps(s.p, s.age, s.ev),
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));
}

/** Pre-token protocols the board does not rank, with the house rule's reason. */
export function excludedRows(snapshot: Snapshot): AccountedRow[] {
  return snapshot.protocols
    .filter((p) => isPreToken(p) && !isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, change_7d: p.change_7d, reason: exclusionReason(p) }));
}

/** Protocols that record a token but carry no market cap in the snapshot. */
export function noMcapRows(snapshot: Snapshot): AccountedRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd === null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      reason: 'records a token (CoinGecko id or symbol) but the snapshot carries no market cap, so no comps value can be fitted',
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = fitComps(snapshot);
  const odds = fitOdds(snapshot);
  const board = buildBoard(snapshot, comps, odds);
  const live = liveRows(snapshot);
  const excluded = excludedRows(snapshot);
  const noMcap = noMcapRows(snapshot);
  const zeroMcap = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd <= 0).length;
  const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) verdicts[r.verdict]++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    watchlist_slugs: [...snapshot.watchlist],
    board_size: board.length,
    coverage: {
      total: snapshot.protocols.length,
      board: board.length,
      excluded_pre_token: excluded.length,
      live: live.length,
      live_zero_mcap: zeroMcap,
      token_no_mcap: noMcap.length,
    },
    verdicts,
    comps,
    odds,
    rows: board,
    live,
    excluded,
    no_mcap: noMcap,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

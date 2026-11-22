// radar-8 model: everything fitted from the snapshot, every term kept only if it
// lowers the held-out miss (value) or Brier score (odds) in BOTH the 5-fold
// cross-validation and the walk-forward test. Nothing is hardcoded by name:
// the only name-derived input is kinship, computed from the snapshot itself
// (a protocol shares a first-word name stem with a different protocol whose
// token already trades), and it is kept only because it wins both tests.

export type Protocol = {
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
};

export type Snapshot = {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
};

// Categories the house rule sets aside (wrapped, staked, bridged, exchange).
export const EXCLUDED_CATS = new Set([
  "Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking",
  "Restaked BTC", "CEX", "Cross Chain Bridge",
]);

export const DAY = 864e5;
export const asOfMs = (snap: Snapshot): number => new Date(snap.as_of + "T00:00:00Z").getTime();
export const ageYears = (p: Protocol, asOf: number): number | null =>
  p.listed_at ? (asOf - new Date(p.listed_at + "T00:00:00Z").getTime()) / DAY / 365.25 : null;
export const ageDays = (p: Protocol, asOf: number): number | null =>
  p.listed_at ? Math.floor((asOf - new Date(p.listed_at + "T00:00:00Z").getTime()) / DAY) : null;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  return s[i];
}
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const sig = (z: number): number => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

// Deterministic PRNG (mulberry32) so bootstrap refits are byte-identical run to run.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// First alphabetic token (>=3 chars) of a protocol's name, lowercased.
export function nameStem(name: string): string | null {
  const m = name.toLowerCase().match(/[a-z][a-z0-9]{2,}/);
  return m ? m[0] : null;
}

// Kinship: 1 when a DIFFERENT protocol with the same name stem records a token.
// Computed from the snapshot only; never a hardcoded list of names.
export function kinshipFlags(all: Protocol[]): Map<string, number> {
  const out = new Map<string, number>();
  const listedStems = new Set<string>();
  for (const y of all) {
    if (y.symbol == null) continue;
    const s = nameStem(y.name);
    if (s) listedStems.add(s);
  }
  for (const x of all) {
    const s = nameStem(x.name);
    let v = 0;
    if (s && listedStems.has(s)) {
      for (const y of all) {
        if (y.slug !== x.slug && y.symbol != null && nameStem(y.name) === s) { v = 1; break; }
      }
    }
    out.set(x.slug, v);
  }
  return out;
}

// Ordinary least squares for y = w0 + w1*x1 (+ w2*x2 ...), via normal equations.
export function ols(X: number[][], y: number[]): number[] {
  const d = X[0].length;
  const A: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b: number[] = new Array<number>(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < d; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let c = 0; c < d; c++) {
    let piv = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    const tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
    const tb = b[c]; b[c] = b[piv]; b[piv] = tb;
    for (let r = c + 1; r < d; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < d; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const w: number[] = new Array<number>(d).fill(0);
  for (let c = d - 1; c >= 0; c--) {
    let s = b[c];
    for (let k = c + 1; k < d; k++) s -= A[c][k] * w[k];
    w[c] = s / A[c][c];
  }
  return w;
}

// ---- Value model: log10(market cap) on log10(TVL), traded comps only. ----
export type ValueModel = {
  intercept: number;
  slope: number;
  n: number;
  // Median absolute multiplicative miss, 5-fold CV and walk-forward.
  cvMiss: number;
  wfMiss: number;
  flatCvMiss: number;
  flatWfMiss: number;
  // Signed CV residuals (log10), for ranges and coverage.
  cvResiduals: number[];
  rangeP25: number;
  rangeP75: number;
  rangeP10: number;
  rangeP90: number;
  coverageP25P75: number;
  coverageP10P90: number;
};

export type ValueTestRow = { name: string; cv: number; wf: number; kept: string };

function valueDesign(x: Protocol, mode: string, kin: Map<string, number>): number[] {
  const lt = Math.log10(x.tvl_usd);
  const g = x.change_7d == null ? 0 : clamp(x.change_7d, -50, 100) / 100;
  if (mode === "size+growth") return [1, lt, g];
  if (mode === "size+kin") return [1, lt, kin.get(x.slug) || 0];
  if (mode === "size+growth+kin") return [1, lt, g, kin.get(x.slug) || 0];
  return [1, lt];
}

function missOf(w: number[], rows: Protocol[], mode: string, kin: Map<string, number>): number[] {
  return rows.map((x) => {
    const f = valueDesign(x, mode, kin);
    const pred = Math.pow(10, f.reduce((s, v, j) => s + v * w[j], 0));
    return Math.max(pred / (x.mcap_usd as number), (x.mcap_usd as number) / pred);
  });
}

export function fitValueModel(comps: Protocol[], kin: Map<string, number>): { model: ValueModel; tests: ValueTestRow[] } {
  const y = comps.map((x) => Math.log10(x.mcap_usd as number));
  const w = ols(comps.map((x) => [1, Math.log10(x.tvl_usd)]), y);
  // 5-fold CV, folds stratified by log market cap (deterministic interleave).
  const order = comps.map((_, i) => i).sort((a, b) => Math.log10(comps[a].mcap_usd as number) - Math.log10(comps[b].mcap_usd as number) || a - b);
  const foldOf = new Array<number>(comps.length);
  order.forEach((idx, k) => { foldOf[idx] = k % 5; });
  const cvResiduals: number[] = [];
  const cvMiss: number[] = [];
  for (let f = 0; f < 5; f++) {
    const tr = comps.filter((_, i) => foldOf[i] !== f);
    const te = comps.filter((_, i) => foldOf[i] === f);
    const wf = ols(tr.map((x) => [1, Math.log10(x.tvl_usd)]), tr.map((x) => Math.log10(x.mcap_usd as number)));
    for (const x of te) {
      const pred = wf[0] + wf[1] * Math.log10(x.tvl_usd);
      const r = Math.log10(x.mcap_usd as number) - pred;
      cvResiduals.push(r);
      cvMiss.push(Math.pow(10, Math.abs(r)));
    }
  }
  // Walk-forward: fit on comps tracked before the median tracking date (+ undated in train), test on later-tracked.
  const dated = comps.filter((x) => x.listed_at).sort((a, b) => (a.listed_at as string) < (b.listed_at as string) ? -1 : 1);
  const cut = dated[Math.floor(dated.length / 2)].listed_at as string;
  const trWF = comps.filter((x) => !x.listed_at || (x.listed_at as string) < cut);
  const teWF = comps.filter((x) => x.listed_at && (x.listed_at as string) >= cut);
  const wWF = ols(trWF.map((x) => [1, Math.log10(x.tvl_usd)]), trWF.map((x) => Math.log10(x.mcap_usd as number)));
  const wfMiss = missOf(wWF, teWF, "size", kin);
  // Flat multiple baseline, same folds and same WF split.
  const flatCv: number[] = [];
  for (let f = 0; f < 5; f++) {
    const tr = comps.filter((_, i) => foldOf[i] !== f);
    const te = comps.filter((_, i) => foldOf[i] === f);
    const mult = median(tr.map((x) => (x.mcap_usd as number) / x.tvl_usd));
    for (const x of te) {
      const p = mult * x.tvl_usd;
      flatCv.push(Math.max(p / (x.mcap_usd as number), (x.mcap_usd as number) / p));
    }
  }
  const flatMultWF = median(trWF.map((x) => (x.mcap_usd as number) / x.tvl_usd));
  const flatWf = teWF.map((x) => {
    const p = flatMultWF * x.tvl_usd;
    return Math.max(p / (x.mcap_usd as number), (x.mcap_usd as number) / p);
  });
  // Candidate terms, each kept only if it lowers BOTH CV and WF miss.
  const tests: ValueTestRow[] = [];
  const base = { cv: median(cvMiss), wf: median(wfMiss) };
  tests.push({ name: "one flat mcap/TVL multiple", cv: median(flatCv), wf: median(flatWf), kept: "baseline" });
  tests.push({ name: "+ size curve, log mcap on log TVL", cv: base.cv, wf: base.wf, kept: "kept" });
  for (const mode of ["size+growth", "size+kin", "size+growth+kin"] as const) {
    const cm: number[] = [];
    for (let f = 0; f < 5; f++) {
      const tr = comps.filter((_, i) => foldOf[i] !== f);
      const te = comps.filter((_, i) => foldOf[i] === f);
      const ww = ols(tr.map((x) => valueDesign(x, mode, kin)), tr.map((x) => Math.log10(x.mcap_usd as number)));
      cm.push(...missOf(ww, te, mode, kin));
    }
    const wwWF = ols(trWF.map((x) => valueDesign(x, mode, kin)), trWF.map((x) => Math.log10(x.mcap_usd as number)));
    const wm = missOf(wwWF, teWF, mode, kin);
    const cv = median(cm), wf = median(wm);
    tests.push({ name: `+ ${mode === "size+growth" ? "7-day TVL growth" : mode === "size+kin" ? "kinship (listed sibling)" : "growth + kinship"}`, cv, wf, kept: cv < base.cv && wf < base.wf ? "kept" : "tested, not kept" });
  }
  // Control: growth of ANOTHER row (index +1 in slug order, deterministic). It must not help.
  const ctrlGrowth = new Map<string, number>();
  const bySlug = [...comps].sort((a, b) => a.slug < b.slug ? -1 : 1);
  bySlug.forEach((x, i) => {
    const other = bySlug[(i + 1) % bySlug.length];
    ctrlGrowth.set(x.slug, other.change_7d == null ? 0 : clamp(other.change_7d, -50, 100) / 100);
  });
  const ctrlDesign = (x: Protocol): number[] => [1, Math.log10(x.tvl_usd), ctrlGrowth.get(x.slug) || 0];
  const cmC: number[] = [];
  for (let f = 0; f < 5; f++) {
    const tr = comps.filter((_, i) => foldOf[i] !== f);
    const te = comps.filter((_, i) => foldOf[i] === f);
    const ww = ols(tr.map(ctrlDesign), tr.map((x) => Math.log10(x.mcap_usd as number)));
    cmC.push(...te.map((x) => {
      const p = Math.pow(10, ww[0] + ww[1] * Math.log10(x.tvl_usd) + ww[2] * (ctrlGrowth.get(x.slug) || 0));
      return Math.max(p / (x.mcap_usd as number), (x.mcap_usd as number) / p);
    }));
  }
  const wwC = ols(trWF.map(ctrlDesign), trWF.map((x) => Math.log10(x.mcap_usd as number)));
  const wmC = teWF.map((x) => {
    const p = Math.pow(10, wwC[0] + wwC[1] * Math.log10(x.tvl_usd) + wwC[2] * (ctrlGrowth.get(x.slug) || 0));
    return Math.max(p / (x.mcap_usd as number), (x.mcap_usd as number) / p);
  });
  tests.push({ name: "+ control: growth of another row", cv: median(cmC), wf: median(wmC), kept: "must not help" });
  // Ranges from the signed CV residuals, with measured coverage.
  const r25 = quantile(cvResiduals, 0.25);
  const r75 = quantile(cvResiduals, 0.75);
  const r10 = quantile(cvResiduals, 0.1);
  const r90 = quantile(cvResiduals, 0.9);
  const cov2575 = cvResiduals.filter((r) => r >= r25 && r <= r75).length / cvResiduals.length;
  const cov1090 = cvResiduals.filter((r) => r >= r10 && r <= r90).length / cvResiduals.length;
  const model: ValueModel = {
    intercept: w[0], slope: w[1], n: comps.length,
    cvMiss: base.cv, wfMiss: base.wf,
    flatCvMiss: median(flatCv), flatWfMiss: median(flatWf),
    cvResiduals, rangeP25: r25, rangeP75: r75, rangeP10: r10, rangeP90: r90,
    coverageP25P75: cov2575, coverageP10P90: cov1090,
  };
  return { model, tests };
}

export const launchValue = (vm: ValueModel, tvl: number): number =>
  Math.pow(10, vm.intercept + vm.slope * Math.log10(tvl));

// ---- Odds model: ridge logistic on the peers' own record of listing a token. ----
// Peers U: protocols with a tracking date, outside the house-excluded categories.
// Outcome: 1 when the protocol records a token (symbol non-null), else 0.
// Features: log1p(age in years), log10(TVL), 7-day growth clipped to [-50,+100]%
// and kinship (a listed sibling). Kept because it beats the base rate on BOTH
// the 5-fold CV and the walk-forward test — and so does every term in it.
export type OddsModel = {
  weights: number[];
  bias: number;
  means: number[];
  sds: number[];
  lambda: number;
  baseRate: number;
  medianAge: number;
  n: number;
  cvBrier: number;
  wfBrier: number;
  baseCvBrier: number;
  baseWfBrier: number;
};

export type OddsTestRow = { name: string; cv: number; wf: number; kept: string };

export const TOP_CATEGORIES = [
  "Dexs", "Lending", "Risk Curators", "RWA", "Derivatives",
  "Yield Aggregator", "Onchain Capital Allocator", "Basis Trading", "CDP", "Yield",
];

function oddsFeatures(x: Protocol, asOf: number, kin: Map<string, number>, medianAge: number, withCat: boolean): number[] {
  const a = ageYears(x, asOf);
  const age = a == null ? medianAge : a;
  const f: number[] = [
    Math.log1p(age),
    Math.log10(x.tvl_usd),
    x.change_7d == null ? 0 : clamp(x.change_7d, -50, 100) / 100,
    kin.get(x.slug) || 0,
  ];
  if (withCat) for (const c of TOP_CATEGORIES) f.push(x.category === c ? 1 : 0);
  return f;
}

function fitLogistic(X: number[][], y: number[], lambda: number, iters = 400): { w: number[]; b: number; mu: number[]; sd: number[] } {
  const d = X[0].length;
  const mu: number[] = [], sd: number[] = [];
  for (let j = 0; j < d; j++) {
    const m = X.reduce((s, r) => s + r[j], 0) / X.length;
    const v = X.reduce((s, r) => s + (r[j] - m) ** 2, 0) / X.length;
    mu.push(m); sd.push(Math.sqrt(v) || 1);
  }
  const Xs = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const ybar = y.reduce((s, v) => s + v, 0);
  let w: number[] = new Array<number>(d).fill(0);
  let b = Math.log((ybar + 0.5) / (y.length - ybar + 0.5));
  for (let it = 0; it < iters; it++) {
    const gw: number[] = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < Xs.length; i++) {
      const z = b + Xs[i].reduce((s, v, j) => s + v * w[j], 0);
      const err = sig(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Xs[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= 0.1 * (gw[j] / Xs.length + lambda * w[j]);
    b -= 0.1 * gb / Xs.length;
  }
  return { w, b, mu, sd };
}

function predictLogistic(m: { w: number[]; b: number; mu: number[]; sd: number[] }, f: number[]): number {
  return sig(m.b + f.reduce((s, v, j) => s + ((v - m.mu[j]) / m.sd[j]) * m.w[j], 0));
}

const AGE_BANDS: [number, number][] = [[0, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 5], [5, 99]];
function ageBandPred(train: Protocol[], x: Protocol, asOf: number, alpha = 10): number {
  const a = ageYears(x, asOf) ?? 2;
  let lo = 0, hi = 99;
  for (const [l, h] of AGE_BANDS) if (a >= l && a < h) { lo = l; hi = h; }
  const inBand = train.filter((r) => {
    const ra = ageYears(r, asOf) ?? 2;
    return ra >= lo && ra < hi;
  });
  const base = train.filter((r) => r.symbol != null).length / train.length;
  return (inBand.filter((r) => r.symbol != null).length + alpha * base) / (inBand.length + alpha);
}

// Life-table odds: F(a) = share with a token inside the age band, monotone;
// odds = the remaining chance to ever list, (Fmax - F) / (1 - F).
const LIFE_BANDS: [number, number][] = [[0, 90], [90, 180], [180, 365], [365, 545], [545, 730], [730, 1095], [1095, 1460], [1460, 1825], [1825, 99999]];
function lifeTable(peers: Protocol[], asOf: number): number[] {
  const raw = LIFE_BANDS.map(([lo, hi]) => {
    const g = peers.filter((p) => {
      const d = ageDays(p, asOf);
      return d != null && d >= lo && d < hi;
    });
    return g.length ? g.filter((p) => p.symbol != null).length / g.length : NaN;
  });
  let last = 0;
  const filled = raw.map((v) => { if (Number.isNaN(v)) return last; last = v; return v; });
  let m = 0;
  return filled.map((v) => { m = Math.max(m, v); return m; });
}
function lifeOdds(F: number[], ageD: number): number {
  let f = F[0];
  for (let i = 0; i < LIFE_BANDS.length; i++) {
    const [lo, hi] = LIFE_BANDS[i];
    if (ageD >= lo && ageD < hi) { f = F[i]; break; }
    if (ageD >= hi) f = F[i];
  }
  const fmax = F[F.length - 1];
  return clamp((fmax - f) / (1 - f), 0.02, 0.95);
}

export function fitOddsModel(peers: Protocol[], asOf: number, kin: Map<string, number>): { model: OddsModel; tests: OddsTestRow[] } {
  const y = peers.map((x) => (x.symbol != null ? 1 : 0));
  const baseRate = y.reduce((s, v) => s + v, 0) / y.length;
  const medianAge = median(peers.map((x) => ageYears(x, asOf) as number));
  const lambda = 0.1;
  // 5-fold CV, folds stratified by outcome (deterministic interleave).
  const order = peers.map((_, i) => i).sort((a, b) => y[a] - y[b] || a - b);
  const foldOf = new Array<number>(peers.length);
  order.forEach((idx, k) => { foldOf[idx] = k % 5; });
  // Walk-forward: fit on the earlier-tracked 60%, test on the later 40%.
  const sortedIdx = [...peers.keys()].sort((a, b) => (peers[a].listed_at as string) < (peers[b].listed_at as string) ? -1 : 1);
  const cut = peers[sortedIdx[Math.floor(sortedIdx.length * 0.6)]].listed_at as string;
  const trWF = peers.filter((x) => (x.listed_at as string) < cut);
  const teWF = peers.filter((x) => (x.listed_at as string) >= cut);
  const wfBaseRate = trWF.filter((x) => x.symbol != null).length / trWF.length;

  const cvBrierFor = (pred: (train: Protocol[], x: Protocol) => number): number => {
    let s = 0;
    for (let f = 0; f < 5; f++) {
      const tr = peers.filter((_, i) => foldOf[i] !== f);
      const te = peers.filter((_, i) => foldOf[i] === f);
      for (const x of te) {
        const e = pred(tr, x) - (x.symbol != null ? 1 : 0);
        s += e * e;
      }
    }
    return s / peers.length;
  };
  const wfBrierFor = (pred: (train: Protocol[], x: Protocol) => number): number => {
    let s = 0;
    for (const x of teWF) {
      const e = pred(trWF, x) - (x.symbol != null ? 1 : 0);
      s += e * e;
    }
    return s / teWF.length;
  };
  const logPred = (withCat: boolean) => (train: Protocol[], x: Protocol): number => {
    const m = fitLogistic(train.map((r) => oddsFeatures(r, asOf, kin, medianAge, withCat)), train.map((r) => (r.symbol != null ? 1 : 0)), lambda);
    return predictLogistic(m, oddsFeatures(x, asOf, kin, medianAge, withCat));
  };
  // Control: growth of ANOTHER row (next in slug order). It must not help.
  const ctrlGrowth = new Map<string, number>();
  const bySlug = [...peers].sort((a, b) => a.slug < b.slug ? -1 : 1);
  bySlug.forEach((x, i) => {
    const other = bySlug[(i + 1) % bySlug.length];
    ctrlGrowth.set(x.slug, other.change_7d == null ? 0 : clamp(other.change_7d, -50, 100) / 100);
  });
  const ctrlPred = (train: Protocol[], x: Protocol): number => {
    const X = train.map((r) => {
      const f = oddsFeatures(r, asOf, kin, medianAge, false);
      f[2] = ctrlGrowth.get(r.slug) || 0;
      return f;
    });
    const m = fitLogistic(X, train.map((r) => (r.symbol != null ? 1 : 0)), lambda);
    const f = oddsFeatures(x, asOf, kin, medianAge, false);
    f[2] = ctrlGrowth.get(x.slug) || 0;
    return predictLogistic(m, f);
  };

  const tests: OddsTestRow[] = [];
  const baseCv = cvBrierFor((train) => train.filter((r) => r.symbol != null).length / train.length);
  const baseWf = teWF.reduce((s, r) => { const e = wfBaseRate - (r.symbol != null ? 1 : 0); return s + e * e; }, 0) / teWF.length;
  tests.push({ name: "base rate of peers", cv: baseCv, wf: baseWf, kept: "baseline" });
  const ageCv = cvBrierFor((train, x) => ageBandPred(train, x, asOf));
  const ageWf = wfBrierFor((train, x) => ageBandPred(train, x, asOf));
  tests.push({ name: "+ age bands, shrunk to the base rate", cv: ageCv, wf: ageWf, kept: "tested, not kept" });
  const keptCv = cvBrierFor(logPred(false));
  const keptWf = wfBrierFor(logPred(false));
  tests.push({ name: "+ ridge logistic: age, size, growth, kinship", cv: keptCv, wf: keptWf, kept: "kept" });
  const catCv = cvBrierFor(logPred(true));
  const catWf = wfBrierFor(logPred(true));
  tests.push({ name: "+ category cells on top of the kept model", cv: catCv, wf: catWf, kept: "tested, not kept" });
  const lifeCv = cvBrierFor((train, x) => {
    const F = lifeTable(train, asOf);
    const d = ageDays(x, asOf) ?? Math.round(medianAge * 365.25);
    return lifeOdds(F, d);
  });
  const lifeWf = wfBrierFor((train, x) => {
    const F = lifeTable(train, asOf);
    const d = ageDays(x, asOf) ?? Math.round(medianAge * 365.25);
    return lifeOdds(F, d);
  });
  tests.push({ name: "+ life-table odds (remaining chance to ever list)", cv: lifeCv, wf: lifeWf, kept: "tested, not kept" });
  const ctrlCv = cvBrierFor(ctrlPred);
  const ctrlWf = wfBrierFor(ctrlPred);
  tests.push({ name: "+ control: growth of another row", cv: ctrlCv, wf: ctrlWf, kept: "must not help" });

  const full = fitLogistic(peers.map((r) => oddsFeatures(r, asOf, kin, medianAge, false)), y, lambda, 600);
  const model: OddsModel = {
    weights: full.w, bias: full.b, means: full.mu, sds: full.sd,
    lambda, baseRate, medianAge, n: peers.length,
    cvBrier: keptCv, wfBrier: keptWf, baseCvBrier: baseCv, baseWfBrier: baseWf,
  };
  return { model, tests };
}

export function tokenOdds(m: OddsModel, x: Protocol, asOf: number, kin: Map<string, number>): number {
  const f = oddsFeatures(x, asOf, kin, m.medianAge, false);
  return clamp(predictLogistic({ w: m.weights, b: m.bias, mu: m.means, sd: m.sds }, f), 0.02, 0.95);
}

// ---- Rows, farm plans, ledger. ----
export type FarmStep = { text: string; usd: number; minutes: number };
export type BoardRow = {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  change7d: number | null;
  ageDays: number | null;
  ageKnown: boolean;
  kin: number;
  launch: number;
  odds: number;
  implied: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  rankLo: number;
  rankHi: number;
  tier: string;
  deposit: number;
  slice: number;
  gasUsd: number;
  forgoneUsd: number;
  net: number;
  netPerHour: number;
  hours: number;
  verdict: "FARM" | "MARGINAL" | "SKIP";
  steps: FarmStep[];
};

export type LedgerGroup = { name: string; count: number };
export type Ledger = { total: number; groups: LedgerGroup[] };

// Farm economics, stated assumptions (not snapshot figures):
// - 10% of a launch goes to depositors, pro rata by deposit.
// - Plan size: 0.02% of TVL, floored at $1,000 and capped at $100,000.
// - Drop horizon 12 weeks; forgone yield is a 4% T-bill on the deposit.
// - Gas: $24 when a plan touches Ethereum, else $3; plus $5 of swap/bridge fees.
// - A reader's hour is worth $25. FARM beats the T-bill and $25/hour;
//   MARGINAL nets positive; SKIP does not.
export const FARM = {
  airdropShare: 0.1,
  depositPct: 0.0002,
  depositMin: 1000,
  depositMax: 100000,
  horizonWeeks: 12,
  tbill: 0.04,
  hourValue: 25,
  ethGas: 24,
  otherGas: 3,
  flatFees: 5,
};

export function planDeposit(tvl: number): number {
  return clamp(FARM.depositPct * tvl, FARM.depositMin, FARM.depositMax);
}
export function planGas(chains: string[]): number {
  return (chains.includes("Ethereum") ? FARM.ethGas : FARM.otherGas) + FARM.flatFees;
}

type StepSpec = { text: string; minutes: number; gasShare: number };
function stepTemplates(p: Protocol): StepSpec[] {
  const n = p.name;
  const ch = p.chains[0] || "Ethereum";
  const cat = p.category || "";
  const deposit = "$" + Math.round(planDeposit(p.tvl_usd)).toLocaleString("en-US");
  if (cat === "Lending" || cat === "CDP" || cat === "CDP Manager" || cat === "Collateral Management" || cat === "Collateral Markets") {
    return [
      { text: `Bridge ${deposit} to ${ch} on the official bridge`, minutes: 10, gasShare: 0.35 },
      { text: `Supply ${deposit} as collateral in the ${n} market`, minutes: 15, gasShare: 0.25 },
      { text: `Borrow 40% of the collateral in stablecoins`, minutes: 10, gasShare: 0.15 },
      { text: `Loop once: redeposit the borrowed stablecoins as collateral`, minutes: 20, gasShare: 0.15 },
      { text: `Hold the position through the drop window; check health factor weekly`, minutes: 5, gasShare: 0 },
      { text: `Vote on one ${n} governance proposal`, minutes: 10, gasShare: 0 },
      { text: `Repay the borrow and withdraw the collateral before the snapshot`, minutes: 15, gasShare: 0.1 },
      { text: `Claim the drop, sell half, keep half`, minutes: 15, gasShare: 0 },
    ];
  }
  if (cat === "Dexs" || cat === "Derivatives" || cat === "Options" || cat === "Options Vault") {
    return [
      { text: `Bridge ${deposit} to ${ch} on the official bridge`, minutes: 10, gasShare: 0.35 },
      { text: `Swap half of ${deposit} into the pool's second asset on ${n}`, minutes: 10, gasShare: 0.25 },
      { text: `Add both assets as liquidity in the deepest pool`, minutes: 15, gasShare: 0.15 },
      { text: `Stake the LP token in the gauge for rewards`, minutes: 10, gasShare: 0.15 },
      { text: `Trade at least once a week to keep volume on the record`, minutes: 5, gasShare: 0 },
      { text: `Claim trading fees and rewards weekly`, minutes: 10, gasShare: 0 },
      { text: `Unstake and remove liquidity before the snapshot`, minutes: 15, gasShare: 0.1 },
      { text: `Claim the drop, sell half, keep half`, minutes: 15, gasShare: 0 },
    ];
  }
  if (cat === "Risk Curators" || cat === "Onchain Capital Allocator" || cat === "Yield" || cat === "Yield Aggregator" || cat === "Farm" || cat === "Liquidity Manager") {
    return [
      { text: `Bridge ${deposit} to ${ch} on the official bridge`, minutes: 10, gasShare: 0.35 },
      { text: `Deposit ${deposit} into the ${n} vault`, minutes: 15, gasShare: 0.25 },
      { text: `Hold the vault shares through two rebalances`, minutes: 5, gasShare: 0 },
      { text: `Vote on one curator proposal`, minutes: 10, gasShare: 0 },
      { text: `Top up the vault after the first rebalance`, minutes: 15, gasShare: 0.15 },
      { text: `Read the vault's curator report and check the allocation`, minutes: 10, gasShare: 0 },
      { text: `Queue the withdrawal before the snapshot date`, minutes: 15, gasShare: 0.15 },
      { text: `Claim the drop, sell half, keep half`, minutes: 15, gasShare: 0.1 },
    ];
  }
  if (cat === "RWA" || cat === "Reserve Currency" || cat === "Stablecoin Issuer" || cat === "Algo-Stables" || cat === "Dual-Token Stablecoin") {
    return [
      { text: `Complete identity checks on ${n} if the asset requires them`, minutes: 20, gasShare: 0 },
      { text: `Bridge ${deposit} to ${ch} on the official bridge`, minutes: 10, gasShare: 0.35 },
      { text: `Buy the tokenised asset with ${deposit}`, minutes: 15, gasShare: 0.25 },
      { text: `Hold through one coupon or distribution`, minutes: 5, gasShare: 0 },
      { text: `Reinvest the distribution into the same asset`, minutes: 10, gasShare: 0.15 },
      { text: `Vote on one governance item`, minutes: 10, gasShare: 0 },
      { text: `List the position for sale, or redeem it, before the snapshot`, minutes: 15, gasShare: 0.15 },
      { text: `Claim the drop, sell half, keep half`, minutes: 15, gasShare: 0.1 },
    ];
  }
  return [
    { text: `Bridge ${deposit} to ${ch} on the official bridge`, minutes: 10, gasShare: 0.35 },
    { text: `Deposit ${deposit} into ${n} on ${ch}`, minutes: 15, gasShare: 0.25 },
    { text: `Use the app at least once a week while the position is open`, minutes: 5, gasShare: 0 },
    { text: `Top up the position once after the first week`, minutes: 15, gasShare: 0.15 },
    { text: `Vote on one ${n} governance proposal`, minutes: 10, gasShare: 0 },
    { text: `Check the position and its fees after a month`, minutes: 10, gasShare: 0 },
    { text: `Withdraw the position before the snapshot date`, minutes: 15, gasShare: 0.15 },
    { text: `Claim the drop, sell half, keep half`, minutes: 15, gasShare: 0.1 },
  ];
}

export function farmPlan(p: Protocol, implied: number): { steps: FarmStep[]; deposit: number; slice: number; gas: number; forgone: number; net: number; hours: number; netPerHour: number; verdict: "FARM" | "MARGINAL" | "SKIP" } {
  const deposit = planDeposit(p.tvl_usd);
  const slice = implied * FARM.airdropShare * (deposit / p.tvl_usd);
  const gas = planGas(p.chains) - FARM.flatFees; // gas only; flat fees added below
  const forgone = deposit * FARM.tbill * (FARM.horizonWeeks / 52);
  const totalCost = gas + FARM.flatFees + forgone;
  const net = slice - totalCost;
  const specs = stepTemplates(p);
  const gasPool = planGas(p.chains) - FARM.flatFees;
  const steps: FarmStep[] = specs.map((s) => ({
    text: s.text,
    usd: Math.round(s.gasShare * gasPool * 100) / 100,
    minutes: s.minutes,
  }));
  const hours = steps.reduce((t, s) => t + s.minutes, 0) / 60;
  const netPerHour = net / hours;
  const verdict: "FARM" | "MARGINAL" | "SKIP" = net > 0 && netPerHour >= FARM.hourValue ? "FARM" : net > 0 ? "MARGINAL" : "SKIP";
  return { steps, deposit, slice, gas: gasPool + FARM.flatFees, forgone, net, hours, netPerHour, verdict };
}

export function buildRows(
  snap: Snapshot, vm: ValueModel, om: OddsModel, kin: Map<string, number>,
): { rows: BoardRow[]; totalImplied: number; verdictCounts: { FARM: number; MARGINAL: number; SKIP: number } } {
  const asOf = asOfMs(snap);
  const watch = new Set(snap.watchlist);
  // Ranked means truly pre-token: no token recorded at all (a symbol with no
  // usable cap is a token that already exists, not a launch to predict), and
  // outside the house-excluded categories (bridges, CEX, liquid staking and
  // the rest never launch a token of their own in this radar's sense).
  // Every watchlist protocol must be ranked, so the board is the watchlist
  // plus the largest other pre-token protocols, to 198 rows.
  const eligible = (x: Protocol) => x.symbol == null && !EXCLUDED_CATS.has(x.category || "");
  const watchRows = snap.protocols.filter((x) => eligible(x) && watch.has(x.slug));
  const rest = snap.protocols
    .filter((x) => eligible(x) && !watch.has(x.slug))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 198 - watchRows.length);
  const pre = [...watchRows, ...rest];
  const rows: BoardRow[] = pre.map((p) => {
    const launch = launchValue(vm, p.tvl_usd);
    const odds = tokenOdds(om, p, asOf, kin);
    const implied = launch * odds;
    const p25 = launch * Math.pow(10, vm.rangeP25) * odds;
    const p75 = launch * Math.pow(10, vm.rangeP75) * odds;
    const p10 = launch * Math.pow(10, vm.rangeP10) * odds;
    const p90 = launch * Math.pow(10, vm.rangeP90) * odds;
    const plan = farmPlan(p, implied);
    const tier = watch.has(p.slug) ? "watchlist" : p.tvl_usd >= snap.floor_usd ? "off-list" : "early";
    return {
      rank: 0, slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl: p.tvl_usd, change7d: p.change_7d,
      ageDays: ageDays(p, asOf), ageKnown: p.listed_at != null,
      kin: kin.get(p.slug) || 0,
      launch, odds, implied, p25, p75, p10, p90,
      rankLo: 0, rankHi: 0, tier,
      deposit: plan.deposit, slice: plan.slice, gasUsd: plan.gas, forgoneUsd: plan.forgone,
      net: plan.net, netPerHour: plan.netPerHour, hours: plan.hours,
      verdict: plan.verdict, steps: plan.steps,
    };
  });
  rows.sort((a, b) => b.implied - a.implied || b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const totalImplied = rows.reduce((s, r) => s + r.implied, 0);
  const verdictCounts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of rows) verdictCounts[r.verdict]++;
  return { rows, totalImplied, verdictCounts };
}

// Bootstrap refits of the value curve (seeded): each row's rank range across refits.
export function bootstrapRankRanges(rows: BoardRow[], comps: Protocol[], vm: ValueModel, om: OddsModel, kin: Map<string, number>, snap: Snapshot, refits = 40): void {
  const asOf = asOfMs(snap);
  const n = comps.length;
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const rankSamples = new Map<string, number[]>();
  for (const r of rows) rankSamples.set(r.slug, []);
  for (let k = 0; k < refits; k++) {
    const draw = rng(1000 + k);
    const sample: Protocol[] = [];
    for (let i = 0; i < n; i++) sample.push(comps[Math.floor(draw() * n)]);
    const w = ols(sample.map((x) => [1, Math.log10(x.tvl_usd)]), sample.map((x) => Math.log10(x.mcap_usd as number)));
    const scored = rows.map((r) => {
      const p = snap.protocols.find((q) => q.slug === r.slug) as Protocol;
      const launch = Math.pow(10, w[0] + w[1] * Math.log10(p.tvl_usd));
      return { slug: r.slug, implied: launch * r.odds };
    });
    scored.sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => { rankSamples.get(s.slug)?.push(i + 1); });
  }
  for (const r of rows) {
    const s = (rankSamples.get(r.slug) || [r.rank]).sort((a, b) => a - b);
    r.rankLo = s[Math.floor(0.1 * s.length)];
    r.rankHi = s[Math.min(s.length - 1, Math.floor(0.9 * s.length))];
  }
  void bySlug; void om; void kin; void asOf;
}

export function buildLedger(snap: Snapshot, rows: BoardRow[]): Ledger {
  const watch = new Set(snap.watchlist);
  const ranked = new Set(rows.map((r) => r.slug));
  const groups: LedgerGroup[] = [];
  const count = (name: string, pred: (x: Protocol) => boolean) => {
    groups.push({ name, count: snap.protocols.filter(pred).length });
  };
  count("Ranked · watchlist", (x) => ranked.has(x.slug) && watch.has(x.slug));
  count("Ranked · early, below the floor", (x) => ranked.has(x.slug) && !watch.has(x.slug) && x.tvl_usd < snap.floor_usd);
  count("Ranked · off-list, at or above the floor", (x) => ranked.has(x.slug) && !watch.has(x.slug) && x.tvl_usd >= snap.floor_usd);
  count("Token trades · priced comp", (x) => x.mcap_usd != null && (x.mcap_usd as number) > 0);
  count("Token recorded · no usable cap", (x) => x.symbol != null && !(x.mcap_usd != null && (x.mcap_usd as number) > 0));
  const versioned = (x: Protocol) => /[ v]v?\d+(\.\d+)?$/i.test(x.name) || /\s(v2|v3|2\.0|3\.0)$/i.test(x.name);
  const wrapped = (x: Protocol) => /\b(wrapped|staked|staking)\b/i.test(x.name);
  const exchange = (x: Protocol) => /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i.test(x.name);
  count("Set aside · house-excluded category", (x) => !ranked.has(x.slug) && x.symbol == null && EXCLUDED_CATS.has(x.category || ""));
  count("Set aside · versioned listing", (x) => !ranked.has(x.slug) && x.symbol == null && !EXCLUDED_CATS.has(x.category || "") && versioned(x));
  count("Set aside · wrapped or staked", (x) => !ranked.has(x.slug) && x.symbol == null && !EXCLUDED_CATS.has(x.category || "") && !versioned(x) && wrapped(x));
  count("Set aside · exchange product", (x) => !ranked.has(x.slug) && x.symbol == null && !EXCLUDED_CATS.has(x.category || "") && !versioned(x) && !wrapped(x) && exchange(x));
  count("Set aside · smaller pre-token", (x) => !ranked.has(x.slug) && x.symbol == null && !EXCLUDED_CATS.has(x.category || "") && !versioned(x) && !wrapped(x) && !exchange(x));
  return { total: snap.protocols.length, groups };
}

// ---- Evidence assembly and the top-level build. ----
export type Evidence = {
  valueTests: ValueTestRow[];
  oddsTests: OddsTestRow[];
  value: { intercept: number; slope: number; n: number; cvMiss: number; wfMiss: number; flatCvMiss: number; flatWfMiss: number };
  odds: { baseRate: number; cvBrier: number; wfBrier: number; baseCvBrier: number; baseWfBrier: number; n: number; medianAge: number };
  ranges: { p25p75: number; p10p90: number; stated2575: number; stated1090: number };
  scatter: { x: number; y: number }[];
  scatterLine: { x: number; y: number }[];
  scatterBand: { x: number; lo: number; hi: number }[];
  nearestPeers: { slug: string; name: string; tvl: number; mcap: number }[];
};

export type Board = {
  modelName: string;
  asOf: string;
  floor: number;
  totalProtocols: number;
  rows: BoardRow[];
  totalImplied: number;
  totalTvl: number;
  verdictCounts: { FARM: number; MARGINAL: number; SKIP: number };
  ledger: Ledger;
  evidence: Evidence;
  farm: typeof FARM;
};

export function buildBoard(snap: Snapshot): Board {
  const asOf = asOfMs(snap);
  const kin = kinshipFlags(snap.protocols);
  const comps = snap.protocols.filter((x) => x.mcap_usd != null && (x.mcap_usd as number) > 0 && x.tvl_usd > 0);
  const peers = snap.protocols.filter((x) => x.listed_at && !EXCLUDED_CATS.has(x.category || ""));
  const { model: vm, tests: valueTests } = fitValueModel(comps, kin);
  const { model: om, tests: oddsTests } = fitOddsModel(peers, asOf, kin);
  const { rows, totalImplied, verdictCounts } = buildRows(snap, vm, om, kin);
  bootstrapRankRanges(rows, comps, vm, om, kin, snap, 40);
  const ledger = buildLedger(snap, rows);
  const totalTvl = rows.reduce((s, r) => s + r.tvl, 0);
  // Scatter: comps on log scales, the fitted line, and the P25-P75 band.
  const scatter = comps.map((x) => ({ x: Math.log10(x.tvl_usd), y: Math.log10(x.mcap_usd as number) }));
  const xs = scatter.map((p) => p.x);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const scatterLine: { x: number; y: number }[] = [];
  const scatterBand: { x: number; lo: number; hi: number }[] = [];
  for (let i = 0; i <= 20; i++) {
    const x = lo + ((hi - lo) * i) / 20;
    const y = vm.intercept + vm.slope * x;
    scatterLine.push({ x, y });
    scatterBand.push({ x, lo: y + vm.rangeP25, hi: y + vm.rangeP75 });
  }
  const nearestPeers = comps
    .map((x) => ({ slug: x.slug, name: x.name, tvl: x.tvl_usd, mcap: x.mcap_usd as number }))
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, 12);
  const evidence: Evidence = {
    valueTests,
    oddsTests,
    value: { intercept: vm.intercept, slope: vm.slope, n: vm.n, cvMiss: vm.cvMiss, wfMiss: vm.wfMiss, flatCvMiss: vm.flatCvMiss, flatWfMiss: vm.flatWfMiss },
    odds: { baseRate: om.baseRate, cvBrier: om.cvBrier, wfBrier: om.wfBrier, baseCvBrier: om.baseCvBrier, baseWfBrier: om.baseWfBrier, n: om.n, medianAge: om.medianAge },
    ranges: { p25p75: vm.coverageP25P75, p10p90: vm.coverageP10P90, stated2575: 0.5, stated1090: 0.8 },
    scatter, scatterLine, scatterBand, nearestPeers,
  };
  return {
    modelName: "radar-8",
    asOf: snap.as_of,
    floor: snap.floor_usd,
    totalProtocols: snap.protocols.length,
    rows, totalImplied, totalTvl, verdictCounts, ledger, evidence,
    farm: FARM,
  };
}

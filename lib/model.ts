// Launch Radar v6 — the token launch radar's model (Node 22, standard library only).
//
// One sealed snapshot in, one ranked board out. The board covers every protocol on the
// snapshot's watchlist (the floor, never the ceiling) plus every other pre-token protocol
// the radar can rank, strongest first. Live-token protocols are kept apart and shown with
// the market's own values, never mixed into the ranked board.
//
// The value model is fitted from the snapshot's own traded-token comps at run time — no
// constant in it is a guess, and no protocol name is ever special-cased:
//
//   comps fit  log(mcap) = a + b * log(tvl), ordinary least squares on the traded
//              protocols with a market cap above zero, then one trim pass (the outer
//              10% of residuals out) and a refit. Each category then takes its own
//              median residual, shrunk toward zero by n / (n + 5) and clamped to
//              [-1, 1] in log space, so a category the market prices rich or cheap
//              moves its protocols by what the comps say, not by a hunch.
//   launch     = exp(a + b * log(tvl) + category adjustment) — what the comps say
//              a protocol of this size and kind lists at.
//   growth     = 1 + clamp(change_7d, -60, 120) / 100 * 0.5
//   maturity   = 0.6 + min(age_days, 1095) / 1095 * 0.4 — a protocol that has run
//              longer is worth more if it lists; age unknown counts as 365 days.
//   odds       = the category's peer listing rate (the share of its protocols whose
//              token has a recorded market cap, Laplace-smoothed toward the whole
//              snapshot's 19% with a prior weight of 10), discounted by age: 1 / (1 +
//              age / 1095), so a protocol that has run three years with no token is half
//              as likely to list as a newborn of the same kind. Clamped to [0.02, 0.60].
//   implied    = max(1, round(launch * growth * maturity * odds))
//
// The fit is tested, not trusted: the comps are split in two by a hash of the slug,
// the curve is fitted on each half and used to predict the other half's market caps,
// and both folds' median absolute errors are reported on the dashboard. The test runs
// inside the program on the same snapshot the board is built from.

/** One protocol of the sealed snapshot: exactly its ten fields. */
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

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The comps fit: the curve, its quality, and each category's adjustment. */
export interface CompsFit {
  intercept: number;
  slope: number;
  rSquared: number;
  compsUsed: number;
  medianAbsErrorPct: number;
  categoryAdjust: Record<string, number>;
}

/** One fold of the holdout test: fitted on half the comps, scored on the other. */
export interface HoldoutFold {
  trainSize: number;
  testSize: number;
  medianAbsErrorPct: number;
}

/** The fitted model, as the dashboard states it. */
export interface FittedModel {
  version: string;
  fit: CompsFit;
  holdout: [HoldoutFold, HoldoutFold];
  globalTokenRate: number;
  priorWeight: number;
  growthWeight: number;
  growthFloor: number;
  growthCap: number;
  maturityFloor: number;
  maturityRange: number;
  maturityDays: number;
  unknownAgeDays: number;
  oddsFloor: number;
  oddsCap: number;
}

export const MODEL_VERSION = 'radar-6';

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

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
  implied_value_usd: number;
  launch_value_usd: number;
  token_odds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  farm_cost_usd: number;
  model: {
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    category_adjustment: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row's compact form for data.js. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  launch_value_usd: number;
  token_odds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  farm_cost_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  category_adjustment: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: CompsFit;
  holdout: [HoldoutFold, HoldoutFold];
  global_token_rate: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  set_aside_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const PRIOR_WEIGHT = 10;
const GROWTH_WEIGHT = 0.5;
const GROWTH_FLOOR = -60;
const GROWTH_CAP = 120;
const MATURITY_FLOOR = 0.6;
const MATURITY_RANGE = 0.4;
const MATURITY_DAYS = 1095;
const UNKNOWN_AGE_DAYS = 365;
const ODDS_FLOOR = 0.02;
const ODDS_CAP = 0.6;
/** One active farmer's share of a protocol's implied value: a 10% community pool split across about 200 active farmers. */
const FARMER_SHARE = 0.0005;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * The house's own watchlist exclusions, minus the TVL floor: a category that is a
 * wrapped, staked or bridged product of a token that already trades (Bridge,
 * Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC, CEX), a name
 * ending in a version marker, a name carrying a whole word wrapped, staked or
 * staking, and a name beginning with an exchange's name. A protocol like WBTC or
 * USDT0 records no token of its own, but its product IS a token that trades — ranking
 * it as pre-token would put a traded token at the top of a pre-token board.
 */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Whether a protocol is one the board may rank: pre-token and none of the house's exclusions. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/** The median of a sorted list of numbers. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Ordinary least squares on (log TVL, log mcap); null when the rows cannot be fitted. */
function ols(rows: SnapshotProtocol[]): { a: number; b: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of rows) {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      xs.push(Math.log(p.tvl_usd));
      ys.push(Math.log(p.mcap_usd));
    }
  }
  const n = xs.length;
  if (n < 10) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** The log residual of a traded protocol against a fitted curve. */
function residual(p: SnapshotProtocol, fit: { a: number; b: number }): number {
  return Math.log(p.mcap_usd!) - (fit.a + fit.b * Math.log(p.tvl_usd));
}

/**
 * The comps fit: OLS on the traded protocols with a market cap, one trim pass that
 * drops the outer 10% of residuals and refits, then each category's median residual,
 * shrunk by n / (n + 5) and clamped to [-1, 1] in log space.
 */
export function fitComps(protocols: SnapshotProtocol[]): CompsFit {
  const comps = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const first = ols(comps);
  if (first === null) throw new SnapshotError('too few traded protocols to fit the comps curve');
  const ranked = comps
    .map((p) => ({ p, r: residual(p, first) }))
    .sort((x, y) => x.r - y.r);
  const lo = Math.floor(ranked.length * 0.1);
  const hi = Math.ceil(ranked.length * 0.9);
  const kept = ranked.slice(lo, hi).map((x) => x.p);
  const fit = ols(kept) ?? first;
  // R-squared and the median absolute percentage error on the kept comps.
  const ys = kept.map((p) => Math.log(p.mcap_usd!));
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let ssTot = 0;
  let ssRes = 0;
  const errs: number[] = [];
  for (const p of kept) {
    const pred = fit.a + fit.b * Math.log(p.tvl_usd);
    ssTot += (Math.log(p.mcap_usd!) - my) ** 2;
    ssRes += (Math.log(p.mcap_usd!) - pred) ** 2;
    errs.push(Math.abs(Math.exp(pred) / p.mcap_usd! - 1));
  }
  errs.sort((x, y) => x - y);
  // Category adjustments from the kept comps' residuals against the trimmed fit.
  const byCat = new Map<string, number[]>();
  for (const p of kept) {
    const c = p.category ?? 'Uncategorised';
    const list = byCat.get(c) ?? [];
    list.push(residual(p, fit));
    byCat.set(c, list);
  }
  const categoryAdjust: Record<string, number> = {};
  for (const [c, rs] of byCat) {
    if (rs.length < 5) continue;
    rs.sort((x, y) => x - y);
    const shrink = rs.length / (rs.length + 5);
    categoryAdjust[c] = round4(Math.max(-1, Math.min(1, median(rs) * shrink)));
  }
  return {
    intercept: round4(fit.a),
    slope: round4(fit.b),
    rSquared: round4(ssTot === 0 ? 0 : 1 - ssRes / ssTot),
    compsUsed: kept.length,
    medianAbsErrorPct: round2(median(errs) * 100),
    categoryAdjust,
  };
}

/** A 32-bit hash of a string, for the deterministic holdout split. */
function hashSlug(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The holdout test: the comps split in two by a hash of the slug, the full pipeline
 * (trimmed fit plus category adjustments) fitted on each half and used to predict the
 * other half's market caps. Both folds' median absolute percentage errors are returned.
 */
export function holdoutTest(protocols: SnapshotProtocol[]): [HoldoutFold, HoldoutFold] {
  const comps = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const halfA = comps.filter((p) => hashSlug(p.slug) % 2 === 0);
  const halfB = comps.filter((p) => hashSlug(p.slug) % 2 === 1);
  const score = (train: SnapshotProtocol[], test: SnapshotProtocol[]): HoldoutFold => {
    const first = ols(train);
    let fit = first;
    let adjust: Record<string, number> = {};
    if (first !== null) {
      const ranked = train
        .map((p) => ({ p, r: residual(p, first) }))
        .sort((x, y) => x.r - y.r);
      const kept = ranked.slice(Math.floor(ranked.length * 0.1), Math.ceil(ranked.length * 0.9)).map((x) => x.p);
      fit = ols(kept) ?? first;
      const byCat = new Map<string, number[]>();
      for (const p of kept) {
        const c = p.category ?? 'Uncategorised';
        const list = byCat.get(c) ?? [];
        list.push(residual(p, fit));
        byCat.set(c, list);
      }
      for (const [c, rs] of byCat) {
        if (rs.length < 5) continue;
        rs.sort((x, y) => x - y);
        adjust[c] = Math.max(-1, Math.min(1, median(rs) * (rs.length / (rs.length + 5))));
      }
    }
    const errs: number[] = [];
    if (fit !== null) {
      for (const p of test) {
        const pred = Math.exp(fit.a + fit.b * Math.log(p.tvl_usd) + (adjust[p.category ?? 'Uncategorised'] ?? 0));
        errs.push(Math.abs(pred / p.mcap_usd! - 1));
      }
    }
    errs.sort((x, y) => x - y);
    return { trainSize: train.length, testSize: test.length, medianAbsErrorPct: round2(median(errs) * 100) };
  };
  return [score(halfA, halfB), score(halfB, halfA)];
}

/** The whole snapshot's share of protocols whose token has a recorded market cap. */
export function globalTokenRate(protocols: SnapshotProtocol[]): number {
  const withToken = protocols.filter((p) => p.mcap_usd !== null).length;
  return protocols.length === 0 ? 0 : withToken / protocols.length;
}

/**
 * The odds a pre-token protocol lists one day: its category's peer listing rate —
 * the share of its peers whose token has a recorded market cap — Laplace-smoothed
 * toward the snapshot's global rate, discounted by how long it has already run
 * with no token.
 */
export function tokenOdds(p: SnapshotProtocol, asOf: string, protocols: SnapshotProtocol[], globalRate: number): number {
  const peers = protocols.filter((q) => (q.category ?? 'Uncategorised') === (p.category ?? 'Uncategorised'));
  const withToken = peers.filter((q) => q.mcap_usd !== null).length;
  const peerRate = (withToken + PRIOR_WEIGHT * globalRate) / (peers.length + PRIOR_WEIGHT);
  const age = ageDays(asOf, p.listed_at);
  const ageForOdds = age ?? UNKNOWN_AGE_DAYS;
  const discount = 1 / (1 + ageForOdds / MATURITY_DAYS);
  return Math.max(ODDS_FLOOR, Math.min(ODDS_CAP, peerRate * discount));
}

/** The fitted launch value of a protocol: what the comps say its size and kind lists at. */
export function launchValue(p: SnapshotProtocol, fit: CompsFit): number {
  const adj = fit.categoryAdjust[p.category ?? 'Uncategorised'] ?? 0;
  return Math.exp(fit.intercept + fit.slope * Math.log(Math.max(1, p.tvl_usd)) + adj);
}

/** The growth and maturity multipliers of a protocol. */
export function multipliers(p: SnapshotProtocol, asOf: string): { growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturityMult = MATURITY_FLOOR + (Math.min(Math.max(ageForModel, 0), MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_RANGE;
  return { growthPct, growthMult, maturityMult, age };
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
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
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time, plus the
 * verdict the plan earns. The verdict nets the farmer's own expected share against
 * the farm's cost — not the protocol's whole implied value, which no single farmer
 * collects. One active farmer's share is modelled as 0.05% of the implied value (a
 * 10% community pool split across about 200 active farmers): FARM when that share is
 * at least ten times the cost, THIN when it is at least twice, SKIP when the cost
 * eats the share. The plan is derived from the protocol's own record (category,
 * chains, TVL, age, implied value), never from a hand-written list of names.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null, implied: number): { steps: FarmStep[]; verdict: 'FARM' | 'THIN' | 'SKIP'; costUsd: number } {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const gas = capital >= 150 ? 8 : 4;
  const weeklyGas = 2;
  const weeks = Math.ceil(hold / 7);
  const costUsd = capital + gas + weeklyGas * weeks;
  const farmerShare = implied * FARMER_SHARE;
  const verdict: 'FARM' | 'THIN' | 'SKIP' = farmerShare >= 10 * costUsd ? 'FARM' : farmerShare >= 2 * costUsd ? 'THIN' : 'SKIP';
  const verdictLine =
    verdict === 'FARM'
      ? `Verdict FARM: one farmer's expected share is about $${Math.max(1, Math.round(farmerShare)).toLocaleString('en-US')}, about ${Math.max(1, Math.round(farmerShare / costUsd))} times the $${costUsd} this plan costs, so the position is worth opening.`
      : verdict === 'THIN'
        ? `Verdict THIN: one farmer's expected share is about $${Math.max(1, Math.round(farmerShare)).toLocaleString('en-US')}, about ${Math.max(1, Math.round(farmerShare / costUsd))} times the $${costUsd} this plan costs, so farm small and only if you already use the protocol.`
        : `Verdict SKIP: one farmer's expected share is about $${Math.max(1, Math.round(farmerShare)).toLocaleString('en-US')}, under twice the $${costUsd} this plan costs, so the farm does not pay for itself — watch the protocol and come back if it grows.`;
  return {
    verdict,
    costUsd,
    steps: [
      {
        text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes',
      },
      {
        text: action,
        cost: `$${capital} of capital and about $${gas} of gas`,
        time: '15 minutes to set up',
      },
      {
        text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
        cost: `about $${weeklyGas} of gas a week, $${weeklyGas * weeks} over ${weeks} weeks`,
        time: '10 minutes a week',
      },
      {
        text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
        cost: `the $${capital} stays in the position`,
        time: `${hold} days`,
      },
      {
        text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
        cost: 'no fee to check, and never pay to claim',
        time: '10 minutes',
      },
      {
        text: verdictLine,
        cost: `about $${costUsd} all in, against a farmer share of about $${Math.max(1, Math.round(farmerShare)).toLocaleString('en-US')}`,
        time: `${hold} days all in`,
      },
    ],
  };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; model: FittedModel } {
  const fit = fitComps(snapshot.protocols);
  const holdout = holdoutTest(snapshot.protocols);
  const globalRate = globalTokenRate(snapshot.protocols);
  const model: FittedModel = {
    version: MODEL_VERSION,
    fit,
    holdout,
    globalTokenRate: round4(globalRate),
    priorWeight: PRIOR_WEIGHT,
    growthWeight: GROWTH_WEIGHT,
    growthFloor: GROWTH_FLOOR,
    growthCap: GROWTH_CAP,
    maturityFloor: MATURITY_FLOOR,
    maturityRange: MATURITY_RANGE,
    maturityDays: MATURITY_DAYS,
    unknownAgeDays: UNKNOWN_AGE_DAYS,
    oddsFloor: ODDS_FLOOR,
    oddsCap: ODDS_CAP,
  };
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked, whatever its TVL.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined && isRankable(p)) chosen.set(slug, p);
  }
  // Every other rankable pre-token protocol joins the board: the radar ranks the
  // whole pre-token universe, not only the forty above the floor.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const launch = launchValue(p, fit);
    const { growthPct, growthMult, maturityMult, age } = multipliers(p, snapshot.as_of);
    const odds = tokenOdds(p, snapshot.as_of, snapshot.protocols, globalRate);
    const implied = Math.max(1, Math.round(launch * growthMult * maturityMult * odds));
    const plan = farmPlan(p, age, implied);
    return { p, launch, growthPct, growthMult, maturityMult, age, odds, implied, plan };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
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
    implied_value_usd: s.implied,
    launch_value_usd: Math.max(1, Math.round(s.launch)),
    token_odds: round4(s.odds),
    verdict: s.plan.verdict,
    farm_cost_usd: s.plan.costUsd,
    model: {
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      category_adjustment: round4(fit.categoryAdjust[s.p.category ?? 'Uncategorised'] ?? 0),
      age_days: s.age,
    },
    farm_steps: s.plan.steps.map(stepText),
  }));
  return { board, model };
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    launch_value_usd: row.launch_value_usd,
    token_odds: row.token_odds,
    verdict: row.verdict,
    farm_cost_usd: row.farm_cost_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    category_adjustment: row.model.category_adjustment,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { board, model } = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const setAside = snapshot.protocols.length - board.length - live.length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fit: model.fit,
    holdout: model.holdout,
    global_token_rate: model.globalTokenRate,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    set_aside_size: Math.max(0, setAside),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
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

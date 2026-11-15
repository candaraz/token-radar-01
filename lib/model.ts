// The token radar's model: one sealed snapshot in, one ranked board out.
//
// A protocol is pre-token when its DefiLlama record shows no token at all: no
// market cap, no CoinGecko id, no symbol. The record is not proof the protocol
// has no token, so the radar says "records no token" everywhere, never "has
// none". The board ranks the strict pre-token set: pre-token protocols that are
// not exchanges, not versioned pools of another protocol, not wrapped or
// staked receipt tokens, and not in categories whose TVL is other protocols'
// capital (bridges, liquid staking, restaking). Every watchlist slug is on the
// board; the strict set covers all forty.
//
// Implied value is fitted from the snapshot itself, at runtime, from the
// protocols that already trade. The comps are the live-token families with a
// market cap and a CoinGecko id, outside the excluded categories, chains, and
// the versioned names. The model is a log-log size curve, fitted by ordinary least
// squares:
//
//   log(market cap) = intercept + slope x log(TVL)
//
//   curve value  = exp(intercept + slope x log(TVL))
//   growth mult  = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   maturity     = 0.6 + min(age_days, 1095) / 1095 x 0.4   (unknown age: 365)
//   implied      = round(curve value x growth mult x maturity)
//
// Category yardsticks (median market-cap/TVL per category, shrunk toward the
// global median) were fitted and tested too, and LOST on leave-one-out
// validation: the curve's median held-out error is about x3.3, the yardstick's
// about x5.0. So the curve stands alone, and both backtests are computed at
// runtime and reported on the page: leave-one-out over the comps, and a
// time split (fit on the older-listed half, tested on the newer-listed half).
// No protocol name is ever special-cased and no multiple is hardcoded: the
// same fit scores every row, and the fit is recomputed from whatever snapshot
// the program is handed.
//
// Farm economics are netted, not sloganned. Expected value per wallet is the
// implied value times an assumed 7% user allocation — below the documented
// 10-31% range of Uniswap (15%), Arbitrum (11.6%), Jito (10%) and Hyperliquid
// (31%) — divided by 25,000 assumed farmers. Costs are gas on the protocol's
// first listed chain plus the opportunity cost of the farmed capital at a 4.5%
// T-bill rate over the hold. Net = EV - gas - opportunity cost. Verdict: FARM
// at net >= $100, THIN at net >= $0, SKIP below $0. Every verdict is
// conditional on a token shipping at all.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The fitted size curve and the backtests that vouch for it. */
export interface CurveFit {
  comps: number;
  intercept: number;
  slope: number;
  global_median_multiple: number;
  loo_median_factor: number;
  loo_within_2x: number;
  loo_median_log_error: number;
  yardstick_loo_median_factor: number;
  yardstick_loo_within_2x: number;
  time_split_train: number;
  time_split_test: number;
  time_split_median_factor: number;
  time_split_within_2x: number;
}

/** The model's stated constants: the dashboard states them, the sandbox moves them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  airdrop_share: number;
  assumed_farmers: number;
  tbill_rate: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  airdrop_share: 0.07,
  assumed_farmers: 25_000,
  tbill_rate: 0.045,
};

export const MODEL_VERSION = 'comps-curve-1';

/** Categories whose TVL is other protocols' capital: excluded from the board. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Chains are valid launch targets for the board, but a chain's market cap is not a protocol comp. */
const COMP_EXCLUDED_CATEGORIES = new Set([...EXCLUDED_CATEGORIES, 'Chain']);

/** A name ending in a release marker is a versioned pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A name that is a wrapped, staked or staking receipt token, whole words only. */
const RECEIPT_WORD = /\b(wrapped|staked|staking)\b/i;

/** A name starting with a centralised exchange's brand. */
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;

/** Whether a protocol's record shows no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: the strict pre-token audit. */
export function isStrictPreToken(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    p.category !== 'CEX' &&
    !VERSIONED.test(p.name) &&
    !RECEIPT_WORD.test(p.name) &&
    !EXCHANGE_NAME.test(p.name) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '')
  );
}

/** Whether a protocol is a usable comp: it trades, with a market cap and a CoinGecko id. */
export function isComp(p: SnapshotProtocol): boolean {
  return (
    p.mcap_usd !== null &&
    p.mcap_usd > 0 &&
    p.tvl_usd > 0 &&
    p.gecko_id !== null &&
    !VERSIONED.test(p.name) &&
    !COMP_EXCLUDED_CATEGORIES.has(p.category ?? '')
  );
}

const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The growth multiplier from a 7-day change, clamped to the stated band. */
export function growthMultiplier(change7d: number | null, model: ModelConstants): { pct: number; mult: number } {
  const pct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(change7d, 0)));
  return { pct, mult: 1 + (pct / 100) * model.growth_weight };
}

/** The maturity multiplier from an age in days; unknown ages score as one year old. */
export function maturityMultiplier(age: number | null, model: ModelConstants): number {
  const days = age ?? model.unknown_age_days;
  const clamped = Math.min(Math.max(days, 0), model.maturity_days);
  return model.maturity_floor + (clamped / model.maturity_days) * model.maturity_range;
}

/** Closed-form OLS on log(TVL) -> log(market cap). */
function ols(points: { x: number; y: number }[]): { intercept: number; slope: number } {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) * (p.x - mx);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The curve's raw prediction for a TVL, before growth and maturity. */
export function curveValue(tvl: number, fit: { intercept: number; slope: number }): number {
  return Math.exp(fit.intercept + fit.slope * Math.log(tvl));
}

/** Category yardsticks shrunk toward the global median: weight n/(n+k), k = 5. */
function yardsticks(comps: SnapshotProtocol[], globalMedian: number, k = 5): Map<string, number> {
  const byCategory = new Map<string, number[]>();
  for (const p of comps) {
    const key = p.category ?? 'Other';
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const out = new Map<string, number>();
  for (const [key, values] of byCategory) {
    out.set(key, (values.length * median(values) + k * globalMedian) / (values.length + k));
  }
  return out;
}

/** Summarise absolute log errors as a median factor and a within-2x share. */
function errorSummary(errors: number[]): { medianFactor: number; within2x: number; medianLog: number } {
  const sorted = [...errors].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  return {
    medianFactor: Math.exp(med),
    within2x: errors.filter((e) => e < Math.log(2)).length / errors.length,
    medianLog: med,
  };
}

/**
 * Fit the size curve on the comps and validate it twice: leave-one-out over all
 * comps, and a time split that fits the older-listed half and tests the
 * newer-listed half. The yardstick variant is validated the same way so the
 * page can show why the curve won.
 */
export function fitCurve(comps: SnapshotProtocol[]): CurveFit {
  const points = comps.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd!) }));
  const { intercept, slope } = ols(points);
  const globalMedian = median(comps.map((p) => p.mcap_usd! / p.tvl_usd));

  const looErrors: number[] = [];
  const yardErrors: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const rest = comps.filter((_, j) => j !== i);
    const held = comps[i]!;
    const refit = ols(rest.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd!) })));
    looErrors.push(Math.abs(Math.log(held.mcap_usd!) - Math.log(curveValue(held.tvl_usd, refit))));
    const yards = yardsticks(rest, median(rest.map((p) => p.mcap_usd! / p.tvl_usd)));
    const yard = yards.get(held.category ?? 'Other') ?? globalMedian;
    yardErrors.push(Math.abs(Math.log(held.mcap_usd!) - Math.log(held.tvl_usd * yard)));
  }
  const loo = errorSummary(looErrors);
  const yard = errorSummary(yardErrors);

  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const trainFit = ols(train.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd!) })));
  const split = errorSummary(test.map((p) => Math.abs(Math.log(p.mcap_usd!) - Math.log(curveValue(p.tvl_usd, trainFit)))));

  return {
    comps: comps.length,
    intercept: round4(intercept),
    slope: round4(slope),
    global_median_multiple: round4(globalMedian),
    loo_median_factor: round4(loo.medianFactor),
    loo_within_2x: round4(loo.within2x),
    loo_median_log_error: round4(loo.medianLog),
    yardstick_loo_median_factor: round4(yard.medianFactor),
    yardstick_loo_within_2x: round4(yard.within2x),
    time_split_train: train.length,
    time_split_test: test.length,
    time_split_median_factor: round4(split.medianFactor),
    time_split_within_2x: round4(split.within2x),
  };
}

/** One protocol's implied value and the breakdown the detail view shows. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  fit: { intercept: number; slope: number },
  model: ModelConstants,
): { implied: number; curve: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const { pct, mult } = growthMultiplier(p.change_7d, model);
  const maturityMult = maturityMultiplier(age, model);
  const curve = curveValue(p.tvl_usd, fit);
  const implied = Math.min(1e14, Math.max(1, Math.round(curve * mult * maturityMult)));
  return { implied, curve, growthPct: pct, growthMult: mult, maturityMult, age };
}

/** The farm economics of one row, netted to the dollar. */
export interface FarmEconomics {
  expected_value_usd: number;
  gas_usd: number;
  opportunity_usd: number;
  net_usd: number;
  capital_usd: number;
  hold_days: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

/** Chains whose transactions cost about $1: the L2 set the snapshot actually names. */
const CHEAP_L2 = new Set([
  'Arbitrum',
  'Base',
  'Optimism',
  'Unichain',
  'Polygon',
  'ZKsync',
  'Linea',
  'Scroll',
  'Blast',
  'Mode',
  'Ink',
  'Abstract',
  'Starknet',
  'Mantle',
  'Fraxtal',
  'Soneium',
  'World Chain',
]);

/** Gas for one farm's transactions, estimated on the protocol's first listed chain. */
export function gasFor(p: SnapshotProtocol): number {
  const chain = p.chains[0];
  if (chain === undefined) return 2;
  if (chain === 'Ethereum') return 8;
  if (chain === 'Bitcoin') return 3;
  if (CHEAP_L2.has(chain)) return 1;
  return 0.5;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 500_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

const money = (n: number): number => Math.round(n * 100) / 100;

/** Net the farm: expected value minus gas minus the T-bill opportunity cost of the capital. */
export function farmEconomics(implied: number, p: SnapshotProtocol, age: number | null, model: ModelConstants): FarmEconomics {
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(p);
  const expected = (implied * model.airdrop_share) / model.assumed_farmers;
  const opportunity = capital * model.tbill_rate * (hold / 365);
  const net = expected - gas - opportunity;
  return {
    expected_value_usd: money(expected),
    gas_usd: money(gas),
    opportunity_usd: money(opportunity),
    net_usd: money(net),
    capital_usd: capital,
    hold_days: hold,
    verdict: net >= 100 ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP',
  };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * The category's one action, in words a farmer can follow, with the
 * mechanism-specific caution attached. Matched on the category string, never
 * on a protocol name; most specific branches first.
 */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('curator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares; read the vault's strategy page first so you know which markets it supplies.`;
  if (c.includes('allocator')) return `Deposit $${capital} into a ${name} allocation vault on ${chain} and keep the shares; check the withdrawal delay before you commit.`;
  if (c.includes('leveraged farm')) return `Open a leveraged farm with at most $${capital} on ${name} and set the leverage to the lowest the app offers; liquidation can take the whole position.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open; borrow only if you can repay without selling at a loss.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open; check the pool's fee tier and range before depositing.`;
  if (c.includes('yield aggregator') || c.includes('yield')) return `Deposit $${capital} into ${name}'s main yield strategy on ${chain} and keep the receipt token; confirm the strategy's withdrawal window first.`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge; keep the position small enough that a liquidation cannot hurt you.`;
  if (c.includes('interest rate')) return `Open a fixed-rate position of $${capital} on ${name} and hold it to maturity; check the maturity date before you commit.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app; keep the receipt hash until the transfer settles.`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt; check the unstaking delay before you commit.`;
  if (c.includes('anchor btc') || c.includes('decentralized btc') || c.includes('btc')) return `Deposit $${capital} of BTC through ${name} on ${chain} and hold the receipt asset; check the redemption path before you commit.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it; confirm the asset's redemption terms first.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}; check the peg's history before sizing up.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}; size it so losing the position outright is affordable.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy; read what the cover excludes before you pay.`;
  if (c.includes('chain')) return `Bridge $${capital} to the chain itself and use ${name}'s native apps for a week; a chain's farm is its own usage.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index token on ${chain} and hold it; check the index's rebalance rules first.`;
  if (c.includes('otc')) return `Place one OTC order of $${capital} through ${name} and settle it in full; never send funds outside the platform's escrow.`;
  if (c.includes('governance')) return `Deposit $${capital} through ${name} and vote on one live proposal; keep the position through the vote's snapshot.`;
  if (c.includes('payment') || c.includes('card')) return `Spend $${capital} through ${name}'s card or payments app on ${chain}; keep the receipts for the farm log.`;
  if (c.includes('cedefi')) return `Deposit $${capital} into the ${name} vault on ${chain} and keep the shares; check who custodies the funds before you commit.`;
  if (c.includes('farm')) return `Deposit $${capital} into ${name}'s main farm on ${chain} and keep the position open; check the emission schedule first.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open; read the protocol's own docs before sizing up.`;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: action, cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

const usd = (n: number): string => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time,
 * derived from the protocol's own record (category, chains, TVL, age) and the
 * netted economics. The last step carries the computed dollar figures.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, econ: FarmEconomics, implied: number, model: ModelConstants): FarmStep[] {
  const chain = chainOf(p);
  const capital = econ.capital_usd;
  const hold = econ.hold_days;
  const gas = econ.gas_usd;
  const weeklyGas = Math.max(0.5, Math.round(gas / 4));
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, keep its seed phrase offline, and open the protocol only from links it publishes itself.',
      cost: `about ${usd(gas)} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `${usd(capital)} of capital and about ${usd(gas)} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a swap, a vote or a rebalance, so the wallet looks used rather than parked.`,
      cost: `about ${usd(weeklyGas)} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity lands in more than one snapshot, and check the protocol's points page weekly.`,
      cost: `the ${usd(capital)} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: 'Farm with one wallet and organic use only: multi-wallet sybil patterns get filtered out, and points are a promise, not a contract — the protocol can change the conversion or ship no token at all.',
      cost: 'nothing but discipline',
      time: '5 minutes',
    },
    {
      text: 'If a token ships, claim only from the link the protocol publishes, inside its claim window, and decide your exit before the claim opens: most recipients sell within 90 days, so the early price is rarely the patient price.',
      cost: `about ${usd(gas)} of gas to claim`,
      time: '10 minutes, plus the exit decision',
    },
    {
      text: `The math: implied ${usd(implied)} x ${(model.airdrop_share * 100).toFixed(0)}% to users / ${model.assumed_farmers.toLocaleString('en-US')} farmers = ${usd(econ.expected_value_usd)} expected per wallet, minus ${usd(econ.gas_usd)} gas and ${usd(econ.opportunity_usd)} opportunity cost at ${(model.tbill_rate * 100).toFixed(1)}% on ${usd(capital)} for ${hold} days = ${usd(econ.net_usd)} net. Verdict: ${econ.verdict}. Conditional on a token shipping at all.`,
      cost: 'nothing to check',
      time: '2 minutes',
    },
  ];
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
  watchlist: boolean;
  model: {
    curve_value_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_economics: FarmEconomics;
  farm_steps: string[];
}

/** The dashboard's view of one row: the board's numbers plus the plan, verbatim. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  watchlist: boolean;
  curve_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_economics: FarmEconomics;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the page shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  gecko_id: string | null;
  change_7d: number | null;
  listed_at: string | null;
}

/** Everything the dashboard needs: the board, the live set, the fit and the assumptions. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  fit: CurveFit;
  snapshot_size: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  audited_pre_token: number;
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

/** The board: every strict pre-token protocol, watchlist forced in, ranked by implied value. */
export function buildBoard(snapshot: Snapshot, fit: CurveFit, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) if (isStrictPreToken(p)) chosen.set(p.slug, p);
  // The watchlist is the floor: force every slug in, even one the audit would
  // drop. On this snapshot the audit already covers all forty; the force-in is
  // the gate's coverage row, never gambled.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined && isPreToken(p)) chosen.set(slug, p);
  }
  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, fit, model);
    const econ = farmEconomics(v.implied, p, v.age, model);
    return { p, v, econ };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
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
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    watchlist: watchlist.has(s.p.slug),
    model: {
      curve_value_usd: s.v.curve,
      growth_pct: s.v.growthPct,
      growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      age_days: s.v.age,
    },
    farm_economics: s.econ,
    farm_steps: farmSteps(s.p, s.v.age, s.econ, s.v.implied, model).map(stepText),
  }));
}

/** The live-token protocols with a market cap, by market cap, for the Live view and the comps table. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      gecko_id: p.gecko_id,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData; fit: CurveFit } {
  const comps = snapshot.protocols.filter(isComp);
  if (comps.length < 10) throw new SnapshotError(`only ${comps.length} usable comps: the curve cannot be fitted`);
  const fit = fitCurve(comps);
  const board = buildBoard(snapshot, fit, model);
  const live = liveRows(snapshot);
  const audited = snapshot.protocols.filter(isPreToken).length;
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    fit,
    snapshot_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    audited_pre_token: audited,
    rows: board.map((row) => ({
      rank: row.rank,
      slug: row.slug,
      name: row.name,
      category: row.category,
      chains: row.chains,
      tvl_usd: row.tvl_usd,
      change_7d: row.change_7d,
      listed_at: row.listed_at,
      age_days: row.age_days,
      implied_value_usd: row.implied_value_usd,
      watchlist: row.watchlist,
      curve_value_usd: row.model.curve_value_usd,
      growth_multiplier: row.model.growth_multiplier,
      maturity_multiplier: row.model.maturity_multiplier,
      farm_economics: row.farm_economics,
      farm_steps: row.farm_steps,
    })),
    live,
  };
  return { board, radar, fit };
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

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside the 100..4000 band`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const outside = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  if (outside < 60) return `only ${outside} rows sit outside the watchlist, fewer than 60`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (typeof r.slug !== 'string' || r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) return `${r.slug} has a bad slug`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const trimmed = s.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${r.slug} has a farm step of ${trimmed.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

// Token launch radar: comps model, board composition, farm plans.
//
// The valuation is a staged comparables model fitted on the protocols
// whose tokens already trade, in log space:
//   1. size: OLS of log(market cap / TVL) on centered log(TVL)
//   2. category: median of size-adjusted residuals per category, shrunk
//      toward zero with pseudo-count K = 4
//   3. calibration: additive constant matching the fit set's median
// Growth and age were tested (tercile medians of residuals, 5-fold CV)
// and carry zero weight: neither predicts multiples in this snapshot.
// See dashboard Method view for the validation numbers, recomputed
// there from the same data.
//
// This file and dashboard/app.js implement the same math. The page
// refits the model from the data it carries and verifies every row.

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

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface FitRow {
  slug: string;
  category: string;
  tvl: number;
  y: number; // log(mcap / TVL)
  lt: number; // log(TVL)
}

export interface Model {
  ltMed: number;
  a: number;
  b: number;
  catEff: Record<string, number>;
  calib: number;
  n: number;
}

export interface FarmEconomics {
  steps: string[];
  capital: number;
  gasPerTx: number;
  gasTotal: number;
  oppCost: number;
  totalCost: number;
  holdDays: number;
  breakEvenShare: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

// Categories whose products the watchlist rule excludes: exchanges and
// wrapped/staked/bridged products of tokens that already trade. The same
// exclusions keep exchange/bridge economics out of the comps set.
export const EXCL_CAT = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED = /\b(wrapped|staked|staking)\b/i;
const EXCH_START = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/i;

export const SHRINK_K = 4;
export const OPP_RATE = 0.04; // stated assumption: short-term dollar yield proxy
export const ALLOC_SCENARIO = 0.01; // stated scenario: 1% farmer allocation
export const PRICED_TX = 6;

export function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// Whole days between listed_at and as_of; null when unreported.
export function ageOf(p: SnapshotProtocol, asOf: string): number | null {
  if (!p.listed_at) return null;
  const days = Math.floor(
    (Date.parse(asOf + 'T00:00:00Z') - Date.parse(p.listed_at + 'T00:00:00Z')) / 86400000,
  );
  return Math.max(0, days);
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// A pre-token protocol is rankable unless the watchlist rule's own
// exclusions set it aside: the rule's excluded categories, a versioned
// name, a wrapped/staked product name, or an exchange-start name.
// Watchlist slugs are always rankable.
export function isRankable(p: SnapshotProtocol, watchlist: Set<string>): boolean {
  if (!isPreToken(p)) return false;
  if (watchlist.has(p.slug)) return true;
  if (EXCL_CAT.has(p.category ?? '')) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED.test(p.name)) return false;
  if (EXCH_START.test(p.name)) return false;
  return true;
}

export function setAsideReason(p: SnapshotProtocol): string {
  if (p.category === 'CEX') return 'Exchange: not a farm subject';
  if (EXCL_CAT.has(p.category ?? '')) return `Category ${p.category}: the watchlist rule excludes wrapped, staked, and bridged products`;
  if (VERSIONED.test(p.name)) return 'Versioned pool name: a deployment, not a standalone protocol';
  if (WRAPPED.test(p.name)) return 'Wrapped/staked product of a token that already trades';
  if (EXCH_START.test(p.name)) return 'Starts with an exchange name: an exchange product';
  return 'Set aside by the watchlist rule';
}

// Traded comps: a positive market cap, in a category the watchlist rule
// does not exclude. Dead records (mcap <= 0) cannot enter a log fit.
export function isComp(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && !EXCL_CAT.has(p.category ?? '');
}

export function toFitRow(p: SnapshotProtocol): FitRow {
  return {
    slug: p.slug,
    category: p.category ?? 'Other',
    tvl: p.tvl_usd,
    y: Math.log((p.mcap_usd as number) / p.tvl_usd),
    lt: Math.log(p.tvl_usd),
  };
}

export function fitModel(rows: FitRow[]): Model {
  const ltMed = median(rows.map((r) => r.lt));
  const xs = rows.map((r) => r.lt - ltMed);
  const mx = mean(xs);
  const my = mean(rows.map((r) => r.y));
  let sxy = 0;
  let sxx = 0;
  rows.forEach((r, i) => {
    sxy += (xs[i] - mx) * (r.y - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  });
  const b = sxy / sxx;
  const a = my - b * mx;
  const byCat: Record<string, number[]> = {};
  rows.forEach((r, i) => {
    const res = r.y - (a + b * xs[i]);
    (byCat[r.category] = byCat[r.category] || []).push(res);
  });
  const catEff: Record<string, number> = {};
  for (const [c, v] of Object.entries(byCat)) {
    catEff[c] = (v.length * median(v)) / (v.length + SHRINK_K);
  }
  const preds = rows.map((r, i) => a + b * xs[i] + (catEff[r.category] || 0));
  const calib = median(rows.map((r) => r.y)) - median(preds);
  return { ltMed, a, b, catEff, calib, n: rows.length };
}

export function predictLogMultiple(m: Model, tvl: number, category: string): number {
  return m.a + m.b * (Math.log(tvl) - m.ltMed) + (m.catEff[category] || 0) + m.calib;
}

export function impliedOf(m: Model, tvl: number, category: string): number {
  return Math.max(1, Math.round(tvl * Math.exp(predictLogMultiple(m, tvl, category))));
}

export interface CvResult {
  mdale: number;
  meanAle: number;
  within2x: number;
  within3x: number;
  n: number;
}

function summarize(errs: number[]): CvResult {
  const ln2 = Math.log(2);
  const ln3 = Math.log(3);
  return {
    mdale: median(errs),
    meanAle: mean(errs),
    within2x: errs.filter((e) => e < ln2).length / errs.length,
    within3x: errs.filter((e) => e < ln3).length / errs.length,
    n: errs.length,
  };
}

// 5-fold cross-validation, folds by slug order, the whole pipeline
// (size fit, category effects, calibration) refit inside each fold.
export function crossValidate(rows: FitRow[], folds = 5): CvResult {
  const errs: number[] = [];
  for (let k = 0; k < folds; k++) {
    const test = rows.filter((_, i) => i % folds === k);
    const train = rows.filter((_, i) => i % folds !== k);
    const m = fitModel(train);
    test.forEach((r) => errs.push(Math.abs(predictLogMultiple(m, r.tvl, r.category) - r.y)));
  }
  return summarize(errs);
}

// Leave-one-category-out: fit without each category, predict its members
// with no category effect. Tests the fallback used by board rows whose
// category has no traded comps.
export function locoValidate(rows: FitRow[]): CvResult {
  const errs: number[] = [];
  const cats = [...new Set(rows.map((r) => r.category))];
  for (const c of cats) {
    const train = rows.filter((r) => r.category !== c);
    const test = rows.filter((r) => r.category === c);
    const m = fitModel(train);
    test.forEach((r) => errs.push(Math.abs(predictLogMultiple(m, r.tvl, r.category) - r.y)));
  }
  return summarize(errs);
}

// Deterministic PRNG (mulberry32) so the bootstrap is byte-stable.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapResult {
  slopeMedian: number;
  slopeP5: number;
  slopeP95: number;
  resamples: number;
}

export function bootstrapSlope(rows: FitRow[], resamples = 200, seed = 20261114): BootstrapResult {
  const rnd = mulberry32(seed);
  const slopes: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(rnd() * rows.length)]);
    slopes.push(fitModel(sample).b);
  }
  slopes.sort((x, y) => x - y);
  return {
    slopeMedian: median(slopes),
    slopeP5: slopes[Math.floor(0.05 * resamples)],
    slopeP95: slopes[Math.ceil(0.95 * resamples) - 1],
    resamples,
  };
}

// Growth/age signal test: median size+category-adjusted residual by
// tercile of each feature. Flat or non-monotone terciles mean no
// reliable signal; the model then gives the feature zero weight.
export interface SignalTest {
  growthTerciles: number[];
  ageTerciles: number[];
}

export function signalTest(
  rows: FitRow[],
  growth: (slug: string) => number | null,
  age: (slug: string) => number | null,
): SignalTest {
  const m = fitModel(rows);
  // Residuals after the full size+category fit: does the feature add
  // anything the model does not already capture?
  const resid = rows.map((r) => r.y - predictLogMultiple(m, r.tvl, r.category));
  const terciles = (feat: (slug: string) => number | null, fallback: number): number[] => {
    const items = rows
      .map((r, i) => ({ f: feat(r.slug) ?? fallback, e: resid[i] }))
      .sort((x, y) => x.f - y.f);
    const third = Math.floor(items.length / 3);
    return [
      median(items.slice(0, third).map((x) => x.e)),
      median(items.slice(third, 2 * third).map((x) => x.e)),
      median(items.slice(2 * third).map((x) => x.e)),
    ];
  };
  const ages = rows.map((r) => age(r.slug)).filter((x): x is number => x !== null);
  const medAge = ages.length ? median(ages) : 365;
  return {
    growthTerciles: terciles(growth, 0),
    ageTerciles: terciles((s) => {
      const a = age(s);
      return a === null ? medAge : a;
    }, medAge),
  };
}

// ---------------------------------------------------------------- farm plans

export function capitalTier(tvl: number): number {
  if (tvl >= 500_000_000) return 500;
  if (tvl >= 100_000_000) return 250;
  if (tvl >= 20_000_000) return 100;
  return 50;
}

const GAS_L2 = new Set([
  'Arbitrum', 'Base', 'Optimism', 'Polygon', 'zkSync Era', 'Linea', 'Scroll',
  'Mantle', 'Ink', 'Blast', 'Mode', 'Fraxtal', 'Zora', 'World Chain', 'Manta',
  'Morph', 'Plume Mainnet', 'Reya Network', 'Unichain', 'Abstract', 'Soneium',
]);
const GAS_CHEAP = new Set([
  'Solana', 'Sui', 'Aptos', 'Monad', 'Stellar', 'TON', 'Tron', 'Avalanche',
  'Fantom', 'Celo', 'Algorand', 'Near', 'Kava', 'Klaytn', 'XION', 'Sei',
  'Injective', 'Cronos', 'Bittensor', 'Flare', 'Arc', 'Provenance', 'Ripple',
  'Hyperliquid L1', 'Starknet', 'Berachain', 'Ronin', 'Stacks', 'Bifrost Network',
  'BSquared', 'RISE', 'Endurance', 'Mixin', 'Proton', 'Mezo', 'Noble', 'Qubic',
  'Pharos', 'RSK', 'Strato', 'Canton', 'Tempo', 'Stable', 'ZIGChain', 'Fluent',
  'Plasma', 'Robinhood Chain',
]);

// Planning estimates per transaction, in dollars. These are stated
// assumptions, not snapshot facts; see the Method view.
export function gasPerTx(chain: string): number {
  if (chain === 'Ethereum') return 12;
  if (chain === 'Bitcoin') return 8;
  if (chain === 'Binance') return 0.3;
  if (GAS_L2.has(chain)) return 0.5;
  if (GAS_CHEAP.has(chain)) return 0.1;
  return 1;
}

export function holdDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age <= 730) return 45;
  return 30;
}

export interface Mechanism {
  asset: string;
  action: string;
  cadence: string;
  risk: string;
}

const DEFAULT_MECH: Mechanism = {
  asset: 'the stablecoin the protocol\u2019s main pool accepts',
  action: 'Use the protocol\u2019s main pool or vault, and read its docs before committing',
  cadence: 'revisit the position and check the pool\u2019s state',
  risk: 'Read the protocol\u2019s own docs for its specific risks before sizing; a generic plan is no substitute for understanding the mechanism.',
};

export const MECHANISMS: Record<string, Mechanism> = {
  'Risk Curators': {
    asset: 'the stablecoin or blue-chip asset the vault accepts',
    action: 'Deposit into the curator vault whose strategy you understand, after reading its allocation',
    cadence: 're-check the vault allocation and the curator fees',
    risk: 'Curator risk is the risk: a vault is only as good as its manager\u2019s allocations, so size the position as a bet on the curator, not on the chain.',
  },
  'Liquid Staking': {
    asset: 'the chain\u2019s native staking asset',
    action: 'Stake through the protocol and hold the liquid staking receipt',
    cadence: 'check the receipt\u2019s peg to the underlying asset',
    risk: 'Depeg risk: the receipt can trade below the staked asset in a stress event, so never stake funds you may need back at par on short notice.',
  },
  'Dexs': {
    asset: 'both sides of the pool pair, in equal dollar value',
    action: 'Provide liquidity to the deepest pool you understand and hold the LP position',
    cadence: 'compare the fees earned against impermanent loss',
    risk: 'Impermanent loss: if one side of the pair moves hard, the LP position underperforms holding, so prefer pairs you would hold anyway.',
  },
  'Bridge': {
    asset: 'the asset you intend to move, on the source chain',
    action: 'Bridge a test amount first, confirm receipt, then bridge the working amount',
    cadence: 'bridge small amounts on new routes as they open',
    risk: 'Bridge risk is contract risk on two chains plus the bridge\u2019s own validators; never bridge more than you can afford to have delayed.',
  },
  'Onchain Capital Allocator': {
    asset: 'the stablecoin the allocator deploys',
    action: 'Deposit into the allocator vault and read where the capital is deployed',
    cadence: 'review the allocator\u2019s deployments and reported yield',
    risk: 'The allocator\u2019s return is someone else\u2019s strategy; if you cannot see where the money goes, treat the position as unsecured exposure.',
  },
  'RWA': {
    asset: 'the stablecoin the offering settles in',
    action: 'Complete the onboarding the offering requires, then mint or buy the tokenized asset',
    cadence: 'check the issuer\u2019s attestation and the redemption window',
    risk: 'Redemption risk: tokenized real-world assets redeem on the issuer\u2019s timetable, not the market\u2019s, so confirm the window before sizing.',
  },
  'Lending': {
    asset: 'the supply asset you are willing to lend',
    action: 'Supply the asset as collateral, borrowing conservatively against it if the plan needs a borrow leg',
    cadence: 'check your health factor and the borrow rate',
    risk: 'Liquidation risk: keep the health factor well above the protocol\u2019s minimum, because a fast market move liquidates thin positions first.',
  },
  'Yield': {
    asset: 'the stablecoin or asset the vault compounds',
    action: 'Deposit into the yield vault and let the strategy compound',
    cadence: 'compare the vault\u2019s realized yield with its advertised rate',
    risk: 'Yield that looks too high is usually emissions or leverage in disguise; check where the return comes from before adding.',
  },
  'Canonical Bridge': {
    asset: 'the canonical asset the bridge wraps',
    action: 'Lock the asset on the home chain and mint the canonical representation',
    cadence: 'check the wrapped asset\u2019s peg and redemption path',
    risk: 'Canonical bridges concentrate trust in one custodian or contract set; the wrapped asset is only as redeemable as the bridge.',
  },
  'Derivatives': {
    asset: 'the margin asset the venue accepts',
    action: 'Open a small margined position within strict size limits, setting your exit before entry',
    cadence: 'review open interest, funding, and your margin',
    risk: 'Leverage cuts both ways: a derivatives position can lose the margin in full, so never add to a losing position to chase a snapshot.',
  },
  'CDP': {
    asset: 'the collateral asset the vault accepts',
    action: 'Lock collateral, mint conservatively, and keep the collateral ratio high',
    cadence: 'check the collateral ratio and the stability fee',
    risk: 'Liquidation risk: a collateral price drop triggers liquidation at the protocol\u2019s ratio, so keep a wide buffer and a top-up plan.',
  },
  'Yield Aggregator': {
    asset: 'the asset the strategy vaults accept',
    action: 'Deposit into the aggregator\u2019s vault and let it route across strategies',
    cadence: 'check which strategies the vault is currently routed to',
    risk: 'Aggregator risk stacks: you take the vault\u2019s risk plus every underlying strategy\u2019s risk, so read the current routing, not the pitch.',
  },
  'Basis Trading': {
    asset: 'the spot asset and the stablecoin margin for the short leg',
    action: 'Hold the spot leg and the offsetting short, capturing the funding spread',
    cadence: 'check the funding rate, since the trade earns only while funding stays positive',
    risk: 'Funding flips: when the basis inverts, the trade pays instead of earning, so have an exit rule before you enter.',
  },
  'Chain': {
    asset: 'the chain\u2019s native gas asset',
    action: 'Bridge in, then use the chain\u2019s own applications: swap, provide liquidity, and transact regularly',
    cadence: 'keep a weekly cadence of real transactions across different applications',
    risk: 'New-chain risk: bridges and applications on a young chain are less battle-tested, so keep most capital on chains you trust.',
  },
  'Staking Pool': {
    asset: 'the asset the pool stakes',
    action: 'Delegate or deposit into the staking pool and hold the receipt',
    cadence: 'check the pool\u2019s validator set and commission',
    risk: 'Validator risk: slashing or downtime on the pool\u2019s validators reduces returns, so prefer pools with a spread of operators.',
  },
  'Liquidity Manager': {
    asset: 'both assets of the managed range',
    action: 'Deposit into the managed liquidity position and let the manager rebalance the range',
    cadence: 'check whether the price is still inside the managed range',
    risk: 'Range risk: when price leaves the range, the position stops earning and holds one side, so check the range, not just the APY.',
  },
  'Liquid Restaking': {
    asset: 'the liquid staking token the protocol restakes',
    action: 'Restake the receipt and hold the restaking token',
    cadence: 'check the restaking token\u2019s peg and the operators securing it',
    risk: 'Stacked slashing risk: restaking adds slashing conditions on top of staking, and the receipt can depeg if operators are penalized.',
  },
  'Leveraged Farming': {
    asset: 'the farming pair plus the borrow asset',
    action: 'Open the leveraged farm at the lowest leverage the strategy allows',
    cadence: 'check the position\u2019s health and the borrow cost daily',
    risk: 'Leverage plus impermanent loss compounds fast: a leveraged farm can be liquidated by a move that would barely dent a spot position.',
  },
  'Restaking': {
    asset: 'the asset the protocol restakes',
    action: 'Restake through the protocol\u2019s operators and hold the position',
    cadence: 'review the operators and the services they secure',
    risk: 'Slashing risk is the product: restaking pays you to accept extra slashing conditions, so size for the possibility of a penalty.',
  },
  'Anchor BTC': {
    asset: 'the BTC representation the protocol anchors',
    action: 'Deposit the BTC representation into the anchor vault',
    cadence: 'check the anchor\u2019s backing and redemption terms',
    risk: 'Backing risk: an anchored BTC product is a claim on BTC held elsewhere, so verify the backing and the redemption path.',
  },
  'Decentralized BTC': {
    asset: 'BTC or its wrapped form on the supported chain',
    action: 'Bring BTC into the protocol\u2019s decentralized custody or vault',
    cadence: 'check the custody arrangement and any federation changes',
    risk: 'Custody risk: decentralized BTC products vary widely in who holds the keys, so read the custody design before depositing.',
  },
  'CeDeFi': {
    asset: 'the asset the centralized leg settles in',
    action: 'Use the CeDeFi venue\u2019s on-chain leg with funds you can withdraw on demand',
    cadence: 'test a withdrawal on schedule, not only when you need one',
    risk: 'Counterparty risk: a CeDeFi product mixes on-chain rails with an off-chain balance sheet, and a withdrawal test is the only honest audit.',
  },
  'Restaked BTC': {
    asset: 'the BTC receipt the protocol restakes',
    action: 'Restake the BTC receipt and hold the restaked position',
    cadence: 'check the peg of the restaked receipt to BTC',
    risk: 'Two layers of trust: the BTC wrapper plus the restaking operators, and a break in either layer reprices the receipt.',
  },
  'Dual-Token Stablecoin': {
    asset: 'the collateral asset and the stablecoin it backs',
    action: 'Mint or hold the stablecoin side, and understand the second token\u2019s role',
    cadence: 'check the peg of both tokens and the collateral ratio',
    risk: 'Dual-token designs concentrate risk in the junior token; if the peg breaks, the junior token absorbs the loss first.',
  },
  'Farm': {
    asset: 'the pair the farm rewards',
    action: 'Stake the LP tokens in the farm and start earning rewards',
    cadence: 'claim and restake rewards on a weekly schedule',
    risk: 'Emission risk: farm rewards are usually new tokens, and if emissions outrun demand, the reward token falls faster than you farm it.',
  },
  'Prediction Market': {
    asset: 'the stablecoin the market settles in',
    action: 'Take positions on markets you have a view on, sized small',
    cadence: 'review open positions and resolve outcomes promptly',
    risk: 'Resolution risk: a market resolves by its oracle, not by your reading of events, so size each position as a bet you can lose.',
  },
  'Stablecoin Wrapper': {
    asset: 'the stablecoin the wrapper accepts',
    action: 'Wrap the stablecoin and hold the wrapped form where it earns',
    cadence: 'check the wrapper\u2019s backing and the wrapped token\u2019s peg',
    risk: 'Wrapper risk is backing risk: the wrapped token is a claim on the underlying stablecoin, so confirm redemption works.',
  },
  'Uncollateralized Lending': {
    asset: 'the stablecoin the credit pool lends',
    action: 'Deposit into the credit pool after reading the borrower terms',
    cadence: 'check the pool\u2019s outstanding loans and any defaults',
    risk: 'No collateral means the borrower\u2019s word is the security; a single default can impair the pool, so size accordingly.',
  },
  'Interest Rate Derivatives': {
    asset: 'the yield-bearing asset the market splits',
    action: 'Trade the rate leg that matches your view: fixed for certainty, floating for upside',
    cadence: 'check the implied rate against the realized yield',
    risk: 'Rate risk: the fixed leg locks a rate that can look wrong within days, so size for the rate moving against you.',
  },
  'Cross Chain Bridge': {
    asset: 'the asset you intend to move across chains',
    action: 'Bridge a test amount on the route, confirm receipt, then move the working amount',
    cadence: 'use new routes with small amounts as they open',
    risk: 'Cross-chain risk compounds: each hop adds a contract and a validator set, so test every new route with a small amount.',
  },
  'CDP Manager': {
    asset: 'the collateral the managed vaults accept',
    action: 'Open a managed CDP position and let the manager maintain the ratio',
    cadence: 'check the managed ratio and the manager\u2019s fee',
    risk: 'Manager risk: automation maintains the ratio until it cannot, so keep your own buffer above the manager\u2019s target.',
  },
  'OTC Marketplace': {
    asset: 'the asset you intend to trade over the counter',
    action: 'Place a small first trade to test settlement before larger size',
    cadence: 'check settlement times and counterparty terms on each trade',
    risk: 'Settlement risk: OTC trades settle on trust and escrow design, so never send first without a tested settlement path.',
  },
  'Insurance': {
    asset: 'the stablecoin the cover pool accepts',
    action: 'Provide cover capital to the pool, or buy cover for a position you hold',
    cadence: 'check the pool\u2019s outstanding cover and any claims',
    risk: 'Claims risk: cover pays only for events the policy names, so read the exclusions before providing capital or buying cover.',
  },
  'Payments': {
    asset: 'the stablecoin the payment rail settles in',
    action: 'Use the rail for a real payment, then keep a regular payment cadence',
    cadence: 'make at least one real payment a week through the rail',
    risk: 'Rail risk: a payment protocol\u2019s uptime and settlement finality matter more than its rewards, so test with small amounts.',
  },
  'Governance Incentives': {
    asset: 'the asset the incentive program rewards',
    action: 'Participate in the governed protocol\u2019s activity the incentives target',
    cadence: 'vote or participate on the program\u2019s schedule',
    risk: 'Incentive risk: governance rewards can end or change by vote, so do not size a position on rewards that a vote can remove.',
  },
  'Crypto Card Issuer': {
    asset: 'the stablecoin the card spends',
    action: 'Fund the card account and use the card for ordinary spending',
    cadence: 'keep regular card spending at a level you can sustain',
    risk: 'Custody risk: card balances sit with the issuer, so fund only what you plan to spend and keep the rest in your own wallet.',
  },
  'Indexes': {
    asset: 'the stablecoin or basket asset the index mints against',
    action: 'Mint the index token and hold the diversified exposure',
    cadence: 'check the index composition and any rebalancing',
    risk: 'Composition risk: an index is only as good as its constituents and weights, so check what you actually own after each rebalance.',
  },
  'Collateral Markets': {
    asset: 'the collateral asset the market accepts',
    action: 'Post collateral and use the market\u2019s borrowing or trading leg conservatively',
    cadence: 'check your collateral ratio and the market\u2019s rates',
    risk: 'Liquidation risk: collateral markets liquidate fast in volatile conditions, so keep a wide buffer and a top-up plan.',
  },
};

export function mechanismOf(category: string): Mechanism {
  return MECHANISMS[category] ?? DEFAULT_MECH;
}

export function fmtInt(n: number): string {
  const s = String(Math.round(n));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Three significant figures, trailing zeros stripped: 0.017, 0.2, 12.3.
export function fmtSig(x: number): string {
  if (x === 0) return '0';
  const s = x.toPrecision(3);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function fmtSignedPct(g: number): string {
  return (g > 0 ? '+' : '') + g.toFixed(1) + '%';
}

export function farmPlan(
  p: SnapshotProtocol,
  age: number | null,
  implied: number,
): FarmEconomics {
  const chain = p.chains[0] ?? 'Ethereum';
  const mech = mechanismOf(p.category ?? 'Other');
  const capital = capitalTier(p.tvl_usd);
  const gas = gasPerTx(chain);
  const gasTotal = Math.round(PRICED_TX * gas);
  const hold = holdDays(age);
  const oppCost = Math.round((capital * OPP_RATE * hold) / 365);
  const totalCost = gasTotal + oppCost;
  const share = totalCost / (ALLOC_SCENARIO * implied);
  const verdict: FarmEconomics['verdict'] = share < 0.001 ? 'FARM' : share < 0.01 ? 'THIN' : 'SKIP';
  const growthNote =
    p.change_7d === null
      ? 'No 7-day TVL change is reported for this protocol in the snapshot.'
      : `TVL moved ${fmtSignedPct(p.change_7d)} over the last 7 days.`;
  const ageNote =
    age === null ? 'no listing date in the snapshot' : `listed ${fmtInt(age)} days ago`;
  const steps = [
    `Set up a fresh wallet on ${chain}. Fund it with $${fmtInt(capital)} for the position plus about $${fmtInt(gasTotal)} for gas: ${PRICED_TX} transactions at roughly $${fmtSig(gas)} each on ${chain}. Keep the seed phrase offline; this wallet only touches ${p.name}. ${growthNote}`,
    `Acquire ${mech.asset} on ${chain}. Use the venue you trust most for the swap, and keep a record of what you paid: a clean record is what makes the position auditable later.`,
    `${mech.action} with the full $${fmtInt(capital)}. Expect about 30 minutes for the first pass, including reading the pool or vault terms before you confirm anything.`,
    `Every week, ${mech.cadence}. Budget about 20 minutes a week; a position you never revisit is a position you do not understand.`,
    mech.risk,
    `Hold the position for at least ${hold} days (${ageNote}). A farm that exits in week one looks like a snapshot hunter; the hold is what makes the activity read as genuine use.`,
    `Check ${p.name}\u2019s own announcements once a week for a token, points program, or snapshot notice. If a claim opens, claim from the same wallet, record the transaction, and reassess the position before adding more.`,
    `Economics: about $${fmtInt(totalCost)} all-in ($${fmtInt(gasTotal)} gas + $${fmtInt(oppCost)} opportunity cost at the assumed 4% yearly rate on $${fmtInt(capital)} for ${hold} days). Against an implied value of $${fmtInt(implied)}, you break even on a 1% farmer-allocation scenario with a ${fmtSig(share * 100)}% share. Verdict: ${verdict}.`,
  ];
  return { steps, capital, gasPerTx: gas, gasTotal, oppCost, totalCost, holdDays: hold, breakEvenShare: share, verdict };
}

// Validate a board the way the gate does, plus the farm-step bounds.
export function boardIssue(rows: BoardRow[], watchlist: string[]): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board has ${rows.length} rows`;
  const seen = new Set<string>();
  const ranks = new Set<number>();
  let prev = Infinity;
  for (const r of rows) {
    if (!r.slug || /\s/.test(r.slug)) return `bad slug ${JSON.stringify(r.slug)}`;
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    if (!r.name) return `empty name for ${r.slug}`;
    if (!Number.isInteger(r.rank) || r.rank < 1) return `bad rank for ${r.slug}`;
    if (ranks.has(r.rank)) return `duplicate rank ${r.rank}`;
    ranks.add(r.rank);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1) return `bad value for ${r.slug}`;
    if (r.implied_value_usd > prev) return `values rise at rank ${r.rank}`;
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `farm steps count for ${r.slug}`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `farm step length ${t.length} for ${r.slug}`;
    }
  }
  for (let i = 1; i <= rows.length; i++) if (!ranks.has(i)) return `rank ${i} missing`;
  const values = new Set(rows.map((r) => r.implied_value_usd));
  if (rows.length > 1 && values.size === 1) return 'all implied values equal';
  for (const slug of watchlist) if (!seen.has(slug)) return `watchlist slug missing: ${slug}`;
  return null;
}

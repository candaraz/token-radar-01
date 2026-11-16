// Token Launch Radar: the page refits the comps model from the data file
// beside it, reprices every board row, rebuilds every farm plan, and
// recomputes the validation table. Nothing on this page is pasted.
// The program that wrote the board runs the same derivation; the line
// under the title reports the live check between the two.
'use strict';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const median = (xs) => { const v = [...xs].sort((a, b) => a - b); const n = v.length; return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const trimNum = (x, d) => { const s = x.toFixed(d); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
const fmtSig = (x) => { if (x === 0) return '0'; const s = x.toPrecision(3); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
const fmtMoney = (v) => {
  if (v >= 1e9) return '$' + trimNum(v / 1e9, 2) + 'B';
  if (v >= 1e6) return '$' + trimNum(v / 1e6, 1) + 'M';
  if (v >= 1e3) return '$' + trimNum(v / 1e3, 1) + 'K';
  return '$' + fmtInt(v);
};
const fmtSignedPct = (g) => (g > 0 ? '+' : '') + g.toFixed(1) + '%';
const fmtDate = (iso) => { const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; const [y, m, d] = iso.split('-').map(Number); return d + ' ' + M[m - 1] + ' ' + y; };
const ageOf = (listedAt, asOf) => {
  if (!listedAt) return null;
  return Math.max(0, Math.floor((Date.parse(asOf + 'T00:00:00Z') - Date.parse(listedAt + 'T00:00:00Z')) / 86400000));
};
const mulberry32 = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/* ------------------------------------------------------------------ */
/* the comps model (same derivation as the program that wrote board)   */
const SHRINK_K = 4;
function fitModel(rows) {
  const ltMed = median(rows.map((r) => r.lt));
  const xs = rows.map((r) => r.lt - ltMed);
  const mx = mean(xs), my = mean(rows.map((r) => r.y));
  let sxy = 0, sxx = 0;
  rows.forEach((r, i) => { sxy += (xs[i] - mx) * (r.y - my); sxx += (xs[i] - mx) * (xs[i] - mx); });
  const b = sxy / sxx, a = my - b * mx;
  const byCat = {};
  rows.forEach((r, i) => { (byCat[r.category] = byCat[r.category] || []).push(r.y - (a + b * xs[i])); });
  const catEff = {};
  for (const [c, v] of Object.entries(byCat)) catEff[c] = (v.length * median(v)) / (v.length + SHRINK_K);
  const preds = rows.map((r, i) => a + b * xs[i] + (catEff[r.category] || 0));
  const calib = median(rows.map((r) => r.y)) - median(preds);
  return { ltMed, a, b, catEff, calib, n: rows.length };
}
const predictLogMultiple = (m, tvl, category) => m.a + m.b * (Math.log(tvl) - m.ltMed) + (m.catEff[category] || 0) + m.calib;
const impliedOf = (m, tvl, category) => Math.max(1, Math.round(tvl * Math.exp(predictLogMultiple(m, tvl, category))));

function summarize(errs) {
  return {
    mdale: median(errs), meanAle: mean(errs),
    within2x: errs.filter((e) => e < Math.log(2)).length / errs.length,
    within3x: errs.filter((e) => e < Math.log(3)).length / errs.length,
    n: errs.length,
  };
}
function crossValidate(rows, folds) {
  folds = folds || 5;
  const errs = [];
  for (let k = 0; k < folds; k++) {
    const m = fitModel(rows.filter((_, i) => i % folds !== k));
    rows.filter((_, i) => i % folds === k).forEach((r) => errs.push(Math.abs(predictLogMultiple(m, r.tvl, r.category) - r.y)));
  }
  return summarize(errs);
}
function locoValidate(rows) {
  const errs = [];
  for (const c of [...new Set(rows.map((r) => r.category))]) {
    const m = fitModel(rows.filter((r) => r.category !== c));
    rows.filter((r) => r.category === c).forEach((r) => errs.push(Math.abs(predictLogMultiple(m, r.tvl, r.category) - r.y)));
  }
  return summarize(errs);
}
function bootstrapSlope(rows, resamples, seed) {
  const rnd = mulberry32(seed || 20261114);
  const slopes = [];
  for (let i = 0; i < (resamples || 200); i++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(rnd() * rows.length)]);
    slopes.push(fitModel(sample).b);
  }
  slopes.sort((x, y) => x - y);
  return { median: median(slopes), p5: slopes[Math.floor(0.05 * slopes.length)], p95: slopes[Math.ceil(0.95 * slopes.length) - 1] };
}
function signalTest(rows, growthFn, ageFn) {
  const m = fitModel(rows);
  const resid = rows.map((r) => r.y - predictLogMultiple(m, r.tvl, r.category));
  const terciles = (feat, fallback) => {
    const items = rows.map((r, i) => ({ f: feat(r.slug) == null ? fallback : feat(r.slug), e: resid[i] })).sort((x, y) => x.f - y.f);
    const third = Math.floor(items.length / 3);
    return [median(items.slice(0, third).map((x) => x.e)), median(items.slice(third, 2 * third).map((x) => x.e)), median(items.slice(2 * third).map((x) => x.e))];
  };
  const ages = rows.map((r) => ageFn(r.slug)).filter((x) => x !== null);
  const medAge = ages.length ? median(ages) : 365;
  return { growth: terciles(growthFn, 0), age: terciles((s) => { const a = ageFn(s); return a === null ? medAge : a; }, medAge) };
}

/* ------------------------------------------------------------------ */
/* farm plans (same derivation as the program that wrote board)        */
const OPP_RATE = 0.04, ALLOC_SCENARIO = 0.01, PRICED_TX = 6;
const capitalTier = (tvl) => (tvl >= 500e6 ? 500 : tvl >= 100e6 ? 250 : tvl >= 20e6 ? 100 : 50);
const GAS_L2 = new Set(['Arbitrum', 'Base', 'Optimism', 'Polygon', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Ink', 'Blast', 'Mode', 'Fraxtal', 'Zora', 'World Chain', 'Manta', 'Morph', 'Plume Mainnet', 'Reya Network', 'Unichain', 'Abstract', 'Soneium']);
const GAS_CHEAP = new Set(['Solana', 'Sui', 'Aptos', 'Monad', 'Stellar', 'TON', 'Tron', 'Avalanche', 'Fantom', 'Celo', 'Algorand', 'Near', 'Kava', 'Klaytn', 'XION', 'Sei', 'Injective', 'Cronos', 'Bittensor', 'Flare', 'Arc', 'Provenance', 'Ripple', 'Hyperliquid L1', 'Starknet', 'Berachain', 'Ronin', 'Stacks', 'Bifrost Network', 'BSquared', 'RISE', 'Endurance', 'Mixin', 'Proton', 'Mezo', 'Noble', 'Qubic', 'Pharos', 'RSK', 'Strato', 'Canton', 'Tempo', 'Stable', 'ZIGChain', 'Fluent', 'Plasma', 'Robinhood Chain']);
const gasPerTx = (chain) => (chain === 'Ethereum' ? 12 : chain === 'Bitcoin' ? 8 : chain === 'Binance' ? 0.3 : GAS_L2.has(chain) ? 0.5 : GAS_CHEAP.has(chain) ? 0.1 : 1);
const holdDays = (age) => (age === null ? 45 : age < 180 ? 60 : age <= 730 ? 45 : 30);

const DEFAULT_MECH = {
  asset: 'the stablecoin the protocol\u2019s main pool accepts',
  action: 'Use the protocol\u2019s main pool or vault, and read its docs before committing',
  cadence: 'revisit the position and check the pool\u2019s state',
  risk: 'Read the protocol\u2019s own docs for its specific risks before sizing; a generic plan is no substitute for understanding the mechanism.',
};
const MECHANISMS = {
  'Risk Curators': { asset: 'the stablecoin or blue-chip asset the vault accepts', action: 'Deposit into the curator vault whose strategy you understand, after reading its allocation', cadence: 're-check the vault allocation and the curator fees', risk: 'Curator risk is the risk: a vault is only as good as its manager\u2019s allocations, so size the position as a bet on the curator, not on the chain.' },
  'Liquid Staking': { asset: 'the chain\u2019s native staking asset', action: 'Stake through the protocol and hold the liquid staking receipt', cadence: 'check the receipt\u2019s peg to the underlying asset', risk: 'Depeg risk: the receipt can trade below the staked asset in a stress event, so never stake funds you may need back at par on short notice.' },
  'Dexs': { asset: 'both sides of the pool pair, in equal dollar value', action: 'Provide liquidity to the deepest pool you understand and hold the LP position', cadence: 'compare the fees earned against impermanent loss', risk: 'Impermanent loss: if one side of the pair moves hard, the LP position underperforms holding, so prefer pairs you would hold anyway.' },
  'Bridge': { asset: 'the asset you intend to move, on the source chain', action: 'Bridge a test amount first, confirm receipt, then bridge the working amount', cadence: 'bridge small amounts on new routes as they open', risk: 'Bridge risk is contract risk on two chains plus the bridge\u2019s own validators; never bridge more than you can afford to have delayed.' },
  'Onchain Capital Allocator': { asset: 'the stablecoin the allocator deploys', action: 'Deposit into the allocator vault and read where the capital is deployed', cadence: 'review the allocator\u2019s deployments and reported yield', risk: 'The allocator\u2019s return is someone else\u2019s strategy; if you cannot see where the money goes, treat the position as unsecured exposure.' },
  'RWA': { asset: 'the stablecoin the offering settles in', action: 'Complete the onboarding the offering requires, then mint or buy the tokenized asset', cadence: 'check the issuer\u2019s attestation and the redemption window', risk: 'Redemption risk: tokenized real-world assets redeem on the issuer\u2019s timetable, not the market\u2019s, so confirm the window before sizing.' },
  'Lending': { asset: 'the supply asset you are willing to lend', action: 'Supply the asset as collateral, borrowing conservatively against it if the plan needs a borrow leg', cadence: 'check your health factor and the borrow rate', risk: 'Liquidation risk: keep the health factor well above the protocol\u2019s minimum, because a fast market move liquidates thin positions first.' },
  'Yield': { asset: 'the stablecoin or asset the vault compounds', action: 'Deposit into the yield vault and let the strategy compound', cadence: 'compare the vault\u2019s realized yield with its advertised rate', risk: 'Yield that looks too high is usually emissions or leverage in disguise; check where the return comes from before adding.' },
  'Canonical Bridge': { asset: 'the canonical asset the bridge wraps', action: 'Lock the asset on the home chain and mint the canonical representation', cadence: 'check the wrapped asset\u2019s peg and redemption path', risk: 'Canonical bridges concentrate trust in one custodian or contract set; the wrapped asset is only as redeemable as the bridge.' },
  'Derivatives': { asset: 'the margin asset the venue accepts', action: 'Open a small margined position within strict size limits, setting your exit before entry', cadence: 'review open interest, funding, and your margin', risk: 'Leverage cuts both ways: a derivatives position can lose the margin in full, so never add to a losing position to chase a snapshot.' },
  'CDP': { asset: 'the collateral asset the vault accepts', action: 'Lock collateral, mint conservatively, and keep the collateral ratio high', cadence: 'check the collateral ratio and the stability fee', risk: 'Liquidation risk: a collateral price drop triggers liquidation at the protocol\u2019s ratio, so keep a wide buffer and a top-up plan.' },
  'Yield Aggregator': { asset: 'the asset the strategy vaults accept', action: 'Deposit into the aggregator\u2019s vault and let it route across strategies', cadence: 'check which strategies the vault is currently routed to', risk: 'Aggregator risk stacks: you take the vault\u2019s risk plus every underlying strategy\u2019s risk, so read the current routing, not the pitch.' },
  'Basis Trading': { asset: 'the spot asset and the stablecoin margin for the short leg', action: 'Hold the spot leg and the offsetting short, capturing the funding spread', cadence: 'check the funding rate, since the trade earns only while funding stays positive', risk: 'Funding flips: when the basis inverts, the trade pays instead of earning, so have an exit rule before you enter.' },
  'Chain': { asset: 'the chain\u2019s native gas asset', action: 'Bridge in, then use the chain\u2019s own applications: swap, provide liquidity, and transact regularly', cadence: 'keep a weekly cadence of real transactions across different applications', risk: 'New-chain risk: bridges and applications on a young chain are less battle-tested, so keep most capital on chains you trust.' },
  'Staking Pool': { asset: 'the asset the pool stakes', action: 'Delegate or deposit into the staking pool and hold the receipt', cadence: 'check the pool\u2019s validator set and commission', risk: 'Validator risk: slashing or downtime on the pool\u2019s validators reduces returns, so prefer pools with a spread of operators.' },
  'Liquidity Manager': { asset: 'both assets of the managed range', action: 'Deposit into the managed liquidity position and let the manager rebalance the range', cadence: 'check whether the price is still inside the managed range', risk: 'Range risk: when price leaves the range, the position stops earning and holds one side, so check the range, not just the APY.' },
  'Liquid Restaking': { asset: 'the liquid staking token the protocol restakes', action: 'Restake the receipt and hold the restaking token', cadence: 'check the restaking token\u2019s peg and the operators securing it', risk: 'Stacked slashing risk: restaking adds slashing conditions on top of staking, and the receipt can depeg if operators are penalized.' },
  'Leveraged Farming': { asset: 'the farming pair plus the borrow asset', action: 'Open the leveraged farm at the lowest leverage the strategy allows', cadence: 'check the position\u2019s health and the borrow cost daily', risk: 'Leverage plus impermanent loss compounds fast: a leveraged farm can be liquidated by a move that would barely dent a spot position.' },
  'Restaking': { asset: 'the asset the protocol restakes', action: 'Restake through the protocol\u2019s operators and hold the position', cadence: 'review the operators and the services they secure', risk: 'Slashing risk is the product: restaking pays you to accept extra slashing conditions, so size for the possibility of a penalty.' },
  'Anchor BTC': { asset: 'the BTC representation the protocol anchors', action: 'Deposit the BTC representation into the anchor vault', cadence: 'check the anchor\u2019s backing and redemption terms', risk: 'Backing risk: an anchored BTC product is a claim on BTC held elsewhere, so verify the backing and the redemption path.' },
  'Decentralized BTC': { asset: 'BTC or its wrapped form on the supported chain', action: 'Bring BTC into the protocol\u2019s decentralized custody or vault', cadence: 'check the custody arrangement and any federation changes', risk: 'Custody risk: decentralized BTC products vary widely in who holds the keys, so read the custody design before depositing.' },
  'CeDeFi': { asset: 'the asset the centralized leg settles in', action: 'Use the CeDeFi venue\u2019s on-chain leg with funds you can withdraw on demand', cadence: 'test a withdrawal on schedule, not only when you need one', risk: 'Counterparty risk: a CeDeFi product mixes on-chain rails with an off-chain balance sheet, and a withdrawal test is the only honest audit.' },
  'Restaked BTC': { asset: 'the BTC receipt the protocol restakes', action: 'Restake the BTC receipt and hold the restaked position', cadence: 'check the peg of the restaked receipt to BTC', risk: 'Two layers of trust: the BTC wrapper plus the restaking operators, and a break in either layer reprices the receipt.' },
  'Dual-Token Stablecoin': { asset: 'the collateral asset and the stablecoin it backs', action: 'Mint or hold the stablecoin side, and understand the second token\u2019s role', cadence: 'check the peg of both tokens and the collateral ratio', risk: 'Dual-token designs concentrate risk in the junior token; if the peg breaks, the junior token absorbs the loss first.' },
  'Farm': { asset: 'the pair the farm rewards', action: 'Stake the LP tokens in the farm and start earning rewards', cadence: 'claim and restake rewards on a weekly schedule', risk: 'Emission risk: farm rewards are usually new tokens, and if emissions outrun demand, the reward token falls faster than you farm it.' },
  'Prediction Market': { asset: 'the stablecoin the market settles in', action: 'Take positions on markets you have a view on, sized small', cadence: 'review open positions and resolve outcomes promptly', risk: 'Resolution risk: a market resolves by its oracle, not by your reading of events, so size each position as a bet you can lose.' },
  'Stablecoin Wrapper': { asset: 'the stablecoin the wrapper accepts', action: 'Wrap the stablecoin and hold the wrapped form where it earns', cadence: 'check the wrapper\u2019s backing and the wrapped token\u2019s peg', risk: 'Wrapper risk is backing risk: the wrapped token is a claim on the underlying stablecoin, so confirm redemption works.' },
  'Uncollateralized Lending': { asset: 'the stablecoin the credit pool lends', action: 'Deposit into the credit pool after reading the borrower terms', cadence: 'check the pool\u2019s outstanding loans and any defaults', risk: 'No collateral means the borrower\u2019s word is the security; a single default can impair the pool, so size accordingly.' },
  'Interest Rate Derivatives': { asset: 'the yield-bearing asset the market splits', action: 'Trade the rate leg that matches your view: fixed for certainty, floating for upside', cadence: 'check the implied rate against the realized yield', risk: 'Rate risk: the fixed leg locks a rate that can look wrong within days, so size for the rate moving against you.' },
  'Cross Chain Bridge': { asset: 'the asset you intend to move across chains', action: 'Bridge a test amount on the route, confirm receipt, then move the working amount', cadence: 'use new routes with small amounts as they open', risk: 'Cross-chain risk compounds: each hop adds a contract and a validator set, so test every new route with a small amount.' },
  'CDP Manager': { asset: 'the collateral the managed vaults accept', action: 'Open a managed CDP position and let the manager maintain the ratio', cadence: 'check the managed ratio and the manager\u2019s fee', risk: 'Manager risk: automation maintains the ratio until it cannot, so keep your own buffer above the manager\u2019s target.' },
  'OTC Marketplace': { asset: 'the asset you intend to trade over the counter', action: 'Place a small first trade to test settlement before larger size', cadence: 'check settlement times and counterparty terms on each trade', risk: 'Settlement risk: OTC trades settle on trust and escrow design, so never send first without a tested settlement path.' },
  'Insurance': { asset: 'the stablecoin the cover pool accepts', action: 'Provide cover capital to the pool, or buy cover for a position you hold', cadence: 'check the pool\u2019s outstanding cover and any claims', risk: 'Claims risk: cover pays only for events the policy names, so read the exclusions before providing capital or buying cover.' },
  'Payments': { asset: 'the stablecoin the payment rail settles in', action: 'Use the rail for a real payment, then keep a regular payment cadence', cadence: 'make at least one real payment a week through the rail', risk: 'Rail risk: a payment protocol\u2019s uptime and settlement finality matter more than its rewards, so test with small amounts.' },
  'Governance Incentives': { asset: 'the asset the incentive program rewards', action: 'Participate in the governed protocol\u2019s activity the incentives target', cadence: 'vote or participate on the program\u2019s schedule', risk: 'Incentive risk: governance rewards can end or change by vote, so do not size a position on rewards that a vote can remove.' },
  'Crypto Card Issuer': { asset: 'the stablecoin the card spends', action: 'Fund the card account and use the card for ordinary spending', cadence: 'keep regular card spending at a level you can sustain', risk: 'Custody risk: card balances sit with the issuer, so fund only what you plan to spend and keep the rest in your own wallet.' },
  'Indexes': { asset: 'the stablecoin or basket asset the index mints against', action: 'Mint the index token and hold the diversified exposure', cadence: 'check the index composition and any rebalancing', risk: 'Composition risk: an index is only as good as its constituents and weights, so check what you actually own after each rebalance.' },
  'Collateral Markets': { asset: 'the collateral asset the market accepts', action: 'Post collateral and use the market\u2019s borrowing or trading leg conservatively', cadence: 'check your collateral ratio and the market\u2019s rates', risk: 'Liquidation risk: collateral markets liquidate fast in volatile conditions, so keep a wide buffer and a top-up plan.' },
};
const mechanismOf = (category) => MECHANISMS[category] || DEFAULT_MECH;

function farmPlan(p, age, implied) {
  const chain = (p.chains && p.chains[0]) || 'Ethereum';
  const mech = mechanismOf(p.category || 'Other');
  const capital = capitalTier(p.tvl_usd);
  const gas = gasPerTx(chain);
  const gasTotal = Math.round(PRICED_TX * gas);
  const hold = holdDays(age);
  const oppCost = Math.round((capital * OPP_RATE * hold) / 365);
  const totalCost = gasTotal + oppCost;
  const share = totalCost / (ALLOC_SCENARIO * implied);
  const verdict = share < 0.001 ? 'FARM' : share < 0.01 ? 'THIN' : 'SKIP';
  const growthNote = p.change_7d === null
    ? 'No 7-day TVL change is reported for this protocol in the snapshot.'
    : 'TVL moved ' + fmtSignedPct(p.change_7d) + ' over the last 7 days.';
  const ageNote = age === null ? 'no listing date in the snapshot' : 'listed ' + fmtInt(age) + ' days ago';
  const steps = [
    'Set up a fresh wallet on ' + chain + '. Fund it with $' + fmtInt(capital) + ' for the position plus about $' + fmtInt(gasTotal) + ' for gas: ' + PRICED_TX + ' transactions at roughly $' + fmtSig(gas) + ' each on ' + chain + '. Keep the seed phrase offline; this wallet only touches ' + p.name + '. ' + growthNote,
    'Acquire ' + mech.asset + ' on ' + chain + '. Use the venue you trust most for the swap, and keep a record of what you paid: a clean record is what makes the position auditable later.',
    mech.action + ' with the full $' + fmtInt(capital) + '. Expect about 30 minutes for the first pass, including reading the pool or vault terms before you confirm anything.',
    'Every week, ' + mech.cadence + '. Budget about 20 minutes a week; a position you never revisit is a position you do not understand.',
    mech.risk,
    'Hold the position for at least ' + hold + ' days (' + ageNote + '). A farm that exits in week one looks like a snapshot hunter; the hold is what makes the activity read as genuine use.',
    'Check ' + p.name + '\u2019s own announcements once a week for a token, points program, or snapshot notice. If a claim opens, claim from the same wallet, record the transaction, and reassess the position before adding more.',
    'Economics: about $' + fmtInt(totalCost) + ' all-in ($' + fmtInt(gasTotal) + ' gas + $' + fmtInt(oppCost) + ' opportunity cost at the assumed 4% yearly rate on $' + fmtInt(capital) + ' for ' + hold + ' days). Against an implied value of $' + fmtInt(implied) + ', you break even on a 1% farmer-allocation scenario with a ' + fmtSig(share * 100) + '% share. Verdict: ' + verdict + '.',
  ];
  return { steps, capital, gasPerTx: gas, gasTotal, oppCost, totalCost, holdDays: hold, breakEvenShare: share, verdict };
}

/* ------------------------------------------------------------------ */
/* page state                                                          */
const D = window.RADAR;
const state = { view: 'board', sortKey: 'rank', sortDir: 1, q: '', cat: '', watchOnly: false, farmOnly: false, detail: null, compSortKey: 'tvl', compSortDir: -1 };
let MODEL = null, FIT = [], VALID = null, ENRICHED = [];

function enrich() {
  FIT = D.comps.filter((c) => c.inFit).map((c) => ({ slug: c.slug, category: c.category, tvl: c.tvl, y: Math.log(c.mcap / c.tvl), lt: Math.log(c.tvl) })).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  MODEL = fitModel(FIT);
  const compBySlug = new Map(D.comps.map((c) => [c.slug, c]));
  const growthFn = (s) => compBySlug.get(s).change7d;
  const ageFn = (s) => ageOf(compBySlug.get(s).listedAt, D.asOf);
  const cv = crossValidate(FIT);
  const loco = locoValidate(FIT);
  const boot = bootstrapSlope(FIT);
  const sig = signalTest(FIT, growthFn, ageFn);
  // Baselines, same folds: a flat median multiple, and the starter's
  // fixed 0.25x rule with its growth and age adjustments.
  const naiveErrs = [], starterErrs = [];
  for (let k = 0; k < 5; k++) {
    const train = FIT.filter((_, i) => i % 5 !== k), test = FIT.filter((_, i) => i % 5 === k);
    const med = median(train.map((r) => r.y));
    test.forEach((r) => naiveErrs.push(Math.abs(med - r.y)));
  }
  FIT.forEach((r) => {
    const c = compBySlug.get(r.slug);
    const g = clamp(c.change7d === null ? 0 : c.change7d, -60, 120);
    const age = ageFn(r.slug);
    const starterLog = Math.log(0.25 * (1 + (g / 100) * 0.5) * (0.6 + (Math.min(age === null ? 365 : age, 1095) / 1095) * 0.4));
    starterErrs.push(Math.abs(starterLog - r.y));
  });
  VALID = { cv, loco, boot, sig, naive: summarize(naiveErrs), starter: summarize(starterErrs) };
  ENRICHED = D.board.map((row) => {
    const shim = { name: row.name, category: row.category, chains: row.chains, tvl_usd: row.tvl, change_7d: row.change7d };
    const plan = farmPlan(shim, row.ageDays, row.implied);
    const refit = impliedOf(MODEL, row.tvl, row.category);
    return { ...row, multiple: row.implied / row.tvl, plan, verdict: plan.verdict, refit, refitDiff: Math.abs(refit - row.implied) };
  });
}

function renderMeta() {
  const nWatch = D.board.filter((r) => r.watchlist).length;
  $('#metaLine').innerHTML = 'Snapshot <b>' + esc(fmtDate(D.asOf)) + '</b> · <b>' + fmtInt(D.board.length + D.aside.length + D.comps.length) + '</b> protocols reconciled<br>' +
    '<b>' + D.board.length + '</b> ranked · <b>' + nWatch + '/40</b> watchlist · floor <b>' + fmtMoney(D.floorUsd) + '</b>';
  const exact = ENRICHED.filter((r) => r.refitDiff === 0).length;
  const maxDiff = Math.max(...ENRICHED.map((r) => r.refitDiff));
  const el = $('#verifyLine');
  el.textContent = 'Page refit check: this page refitted the model from the snapshot data and repriced ' + exact + '/' + ENRICHED.length + ' board rows exactly (largest difference $' + fmtInt(maxDiff) + ').';
  if (exact !== ENRICHED.length) el.classList.add('bad');
}

function pill(v) { return '<span class="pill ' + v.toLowerCase() + '">' + v + '</span>'; }
function growthCell(g) {
  if (g === null) return '<td class="num flat">—</td>';
  const cls = g > 0.05 ? 'pos' : g < -0.05 ? 'neg' : 'flat';
  return '<td class="num ' + cls + '">' + fmtSignedPct(g) + '</td>';
}

function boardRows() {
  let rows = ENRICHED;
  if (state.cat) rows = rows.filter((r) => r.category === state.cat);
  if (state.watchOnly) rows = rows.filter((r) => r.watchlist);
  if (state.farmOnly) rows = rows.filter((r) => r.verdict === 'FARM');
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q));
  }
  const key = state.sortKey, dir = state.sortDir;
  const val = (r) => (key === 'chains' ? r.chains.length : key === 'name' || key === 'category' || key === 'verdict' ? String(r[key]).toLowerCase() : (r[key] === null ? -Infinity : r[key]));
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return a.rank - b.rank;
  });
}

function renderBoard() {
  const rows = boardRows();
  $('#rowCount').textContent = rows.length + ' of ' + ENRICHED.length + ' rows';
  $$('#boardTable thead th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = base + (th.dataset.sort === state.sortKey ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '');
  });
  $('#boardTable tbody').innerHTML = rows.map((r) =>
    '<tr data-slug="' + esc(r.slug) + '">' +
    '<td class="num">' + r.rank + '</td>' +
    '<td><span class="name">' + esc(r.name) + '</span>' + (r.watchlist ? '<span class="pill watch">WATCHLIST</span>' : '') + '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
    '<td class="cat">' + esc(r.category) + '</td>' +
    '<td class="num">' + fmtMoney(r.tvl) + '</td>' +
    growthCell(r.change7d) +
    '<td class="num">' + (r.ageDays === null ? '—' : fmtInt(r.ageDays) + 'd') + '</td>' +
    '<td class="num">' + r.chains.length + '</td>' +
    '<td class="num"><b>' + fmtMoney(r.implied) + '</b></td>' +
    '<td class="num">' + fmtSig(r.multiple) + '×</td>' +
    '<td>' + pill(r.verdict) + '</td></tr>',
  ).join('');
  $$('#boardTable tbody tr').forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.slug)));
}

function nearestComps(row, n) {
  const lt = Math.log(row.tvl);
  const same = D.comps.filter((c) => c.inFit && c.category === row.category)
    .map((c) => ({ ...c, d: Math.abs(Math.log(c.tvl) - lt) })).sort((a, b) => a.d - b.d);
  const pool = same.length ? same : D.comps.filter((c) => c.inFit).map((c) => ({ ...c, d: Math.abs(Math.log(c.tvl) - lt) })).sort((a, b) => a.d - b.d);
  return { list: pool.slice(0, n || 5), sameCategory: same.length > 0 };
}

function openDetail(slug) {
  const row = ENRICHED.find((r) => r.slug === slug);
  if (!row) return;
  state.detail = slug;
  const lt = Math.log(row.tvl);
  const base = Math.exp(MODEL.a + MODEL.calib);
  const sizeF = Math.exp(MODEL.b * (lt - MODEL.ltMed));
  const catF = Math.exp(MODEL.catEff[row.category] || 0);
  const nCat = FIT.filter((r) => r.category === row.category).length;
  const near = nearestComps(row, 5);
  const plan = row.plan;
  $('#detailBody').innerHTML =
    '<h2>' + esc(row.name) + '</h2>' +
    '<p><span class="slug">' + esc(row.slug) + '</span> ' + (row.watchlist ? '<span class="pill watch">WATCHLIST</span>' : '') + ' ' + pill(row.verdict) + '</p>' +
    '<dl class="kv">' +
    '<dt>Rank</dt><dd>#' + row.rank + ' of ' + ENRICHED.length + '</dd>' +
    '<dt>Category</dt><dd>' + esc(row.category) + '</dd>' +
    '<dt>Chains</dt><dd>' + esc(row.chains.slice(0, 6).join(', ')) + (row.chains.length > 6 ? ' +' + (row.chains.length - 6) + ' more' : '') + '</dd>' +
    '<dt>TVL</dt><dd>' + fmtMoney(row.tvl) + '</dd>' +
    '<dt>7-day change</dt><dd>' + (row.change7d === null ? 'not reported' : fmtSignedPct(row.change7d)) + '</dd>' +
    '<dt>Age</dt><dd>' + (row.ageDays === null ? 'no listing date in the snapshot' : fmtInt(row.ageDays) + ' days since listing') + '</dd>' +
    '<dt>Implied value</dt><dd><b>' + fmtMoney(row.implied) + '</b> (' + fmtSig(row.multiple) + '× TVL)</dd>' +
    '<dt>Token status</dt><dd>Records no token in the snapshot</dd></dl>' +
    '<h3>How the value is built</h3>' +
    '<div class="auditwalk">' +
    '<div><span>Base multiple exp(a + calib)</span><span>×' + fmtSig(base) + '</span></div>' +
    '<div><span>Size factor at this TVL</span><span>×' + fmtSig(sizeF) + '</span></div>' +
    '<div><span>Category factor (' + esc(row.category) + ', ' + nCat + ' comp' + (nCat === 1 ? '' : 's') + ')</span><span>×' + fmtSig(catF) + '</span></div>' +
    '<div class="tot"><span>Fitted multiple</span><span>' + fmtSig(row.multiple) + '×</span></div>' +
    '<div class="tot"><span>TVL × multiple</span><span>' + fmtMoney(row.implied) + '</span></div></div>' +
    (nCat === 0 ? '<p class="hint">No traded comp shares this category, so the category factor is 1.00 (the global center). The leave-one-category-out check in Method tests exactly this fallback.</p>' : '') +
    '<h3>Nearest comps' + (near.sameCategory ? ' in ' + esc(row.category) : ' by size (no comp in this category)') + '</h3>' +
    '<table class="comps-mini"><tbody>' + near.list.map((c) =>
      '<tr><td>' + esc(c.name) + '</td><td class="num">' + fmtMoney(c.tvl) + '</td><td class="num">' + fmtSig(c.mcap / c.tvl) + '×</td></tr>',
    ).join('') + '</tbody></table>' +
    '<h3>Farm plan</h3><ol class="steps">' + plan.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>';
  $('#detail').hidden = false;
  syncHash();
}
function closeDetail() {
  state.detail = null;
  $('#detail').hidden = true;
  syncHash();
}

function renderComps() {
  const rows = D.comps.map((c) => {
    const fitted = Math.exp(predictLogMultiple(MODEL, c.tvl, c.category));
    const mult = c.mcap / c.tvl;
    return { ...c, multiple: mult, fitted, error: Math.exp(Math.abs(Math.log(fitted) - Math.log(mult))) };
  });
  const key = state.compSortKey, dir = state.compSortDir;
  const val = (r) => (key === 'name' || key === 'category' ? String(r[key]).toLowerCase() : key === 'inFit' ? (r.inFit ? 1 : 0) : r[key]);
  rows.sort((a, b) => { const va = val(a), vb = val(b); return va < vb ? -dir : va > vb ? dir : (a.slug < b.slug ? -1 : 1); });
  $$('#compsTable thead th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.compSortKey);
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = base + (th.dataset.sort === state.compSortKey ? (state.compSortDir === 1 ? ' ▲' : ' ▼') : '');
  });
  $('#compsTable tbody').innerHTML = rows.map((c) =>
    '<tr><td><span class="name">' + esc(c.name) + '</span><br><span class="slug">' + esc(c.slug) + '</span></td>' +
    '<td class="cat">' + esc(c.category) + '</td>' +
    '<td class="num">' + fmtMoney(c.tvl) + '</td>' +
    '<td class="num">' + fmtMoney(c.mcap) + '</td>' +
    '<td class="num">' + fmtSig(c.multiple) + '×</td>' +
    '<td class="num">' + fmtSig(c.fitted) + '×</td>' +
    '<td class="num">' + fmtSig(c.error) + '×</td>' +
    '<td>' + (c.inFit ? '<span class="pill farm">IN FIT</span>' : '<span class="pill out">KEPT OUT</span>') + '</td></tr>',
  ).join('');
  const nOut = D.comps.filter((c) => !c.inFit).length;
  $('#fitSummary').innerHTML = '<h2>The fit, in one line</h2><p><b>' + FIT.length + ' traded protocols</b> fitted (' + nOut + ' traded protocols kept out: exchange, bridge, and liquid-staking economics). ' +
    'Size slope <b>' + MODEL.b.toFixed(3) + '</b> on centered log TVL; median log TVL <b>' + MODEL.ltMed.toFixed(2) + '</b> (' + fmtMoney(Math.exp(MODEL.ltMed)) + '); ' +
    'calibration <b>' + MODEL.calib.toFixed(3) + '</b>. 5-fold out-of-sample median error <b>' + VALID.cv.mdale.toFixed(3) + '</b> log points (×' + fmtSig(Math.exp(VALID.cv.mdale)) + '). ' +
    'Category effects are shrunk medians (pseudo-count 4); the largest is ' + topEffect() + '.</p>';
  drawScatter();
}
function topEffect() {
  const entries = Object.entries(MODEL.catEff).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!entries.length) return 'none';
  const [c, e] = entries[0];
  return esc(c) + ' ×' + fmtSig(Math.exp(e));
}

function drawScatter() {
  const W = 920, H = 430, L = 64, R = 18, T = 16, B = 44;
  const pts = D.comps.map((c) => ({ x: Math.log(c.tvl), y: Math.log(c.mcap), inFit: c.inFit }));
  const board = D.board.map((r) => ({ x: Math.log(r.tvl), y: Math.log(r.implied) }));
  const xs = [...pts.map((p) => p.x), ...board.map((p) => p.x)];
  const ys = [...pts.map((p) => p.y), ...board.map((p) => p.y)];
  const x0 = Math.min(...xs) - 0.3, x1 = Math.max(...xs) + 0.3;
  const y0 = Math.min(...ys) - 0.4, y1 = Math.max(...ys) + 0.4;
  const X = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const Y = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  let s = '';
  const xTicks = [[5e6, '$5M'], [50e6, '$50M'], [500e6, '$500M'], [5e9, '$5B']];
  const yTicks = [[1e6, '$1M'], [1e7, '$10M'], [1e8, '$100M'], [1e9, '$1B'], [1e10, '$10B']];
  xTicks.forEach(([v, lab]) => { const x = X(Math.log(v)); s += '<line class="grid" x1="' + x + '" y1="' + T + '" x2="' + x + '" y2="' + (H - B) + '"/><text x="' + x + '" y="' + (H - 26) + '" text-anchor="middle">' + lab + '</text>'; });
  yTicks.forEach(([v, lab]) => { const y = Y(Math.log(v)); s += '<line class="grid" x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '"/><text x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + lab + '</text>'; });
  s += '<text x="' + ((W + L) / 2) + '" y="' + (H - 8) + '" text-anchor="middle">TVL (log scale)</text>';
  s += '<text x="20" y="' + ((H + T) / 2) + '" text-anchor="middle" transform="rotate(-90 20 ' + ((H + T) / 2) + ')">Market cap / implied value</text>';
  let d = '';
  for (let i = 0; i <= 40; i++) {
    const lt = x0 + ((x1 - x0) * i) / 40;
    const y = lt + MODEL.a + MODEL.b * (lt - MODEL.ltMed) + MODEL.calib;
    d += (i === 0 ? 'M' : 'L') + X(lt).toFixed(1) + ' ' + Y(y).toFixed(1);
  }
  s += '<path class="curve" d="' + d + '"/>';
  pts.forEach((p) => { s += '<circle class="pt' + (p.inFit ? '' : ' out') + '" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="4"/>'; });
  board.forEach((p) => { s += '<circle class="pt board" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3"/>'; });
  $('#scatter').innerHTML = s;
}

function renderMethod() {
  const set = (key, text) => $$('[data-stat="' + key + '"]').forEach((el) => { el.textContent = text; });
  set('fitN', String(FIT.length));
  set('slope', MODEL.b.toFixed(3));
  set('ltMed', MODEL.ltMed.toFixed(2) + ' (' + fmtMoney(Math.exp(MODEL.ltMed)) + ')');
  set('calib', MODEL.calib.toFixed(3));
  set('asOf', fmtDate(D.asOf));
  const f3 = (xs) => xs.map((x) => (x >= 0 ? '+' : '') + x.toFixed(3)).join(', ');
  set('growthT', f3(VALID.sig.growth));
  set('ageT', f3(VALID.sig.age));
  set('bootSlope', VALID.boot.p5.toFixed(3) + ' to ' + VALID.boot.p95.toFixed(3) + ', median ' + VALID.boot.median.toFixed(3));
  const row = (name, v) => '<tr><td>' + name + '</td><td class="num">' + v.mdale.toFixed(3) + ' (×' + fmtSig(Math.exp(v.mdale)) + ')</td><td class="num">' + v.meanAle.toFixed(3) + '</td><td class="num">' + Math.round(v.within2x * 100) + '%</td><td class="num">' + Math.round(v.within3x * 100) + '%</td></tr>';
  $('#validationRows').innerHTML =
    row('Staged comps model, 5-fold CV (n=' + VALID.cv.n + ')', VALID.cv) +
    row('Staged comps model, leave-one-category-out', VALID.loco) +
    row('Flat median multiple, 5-fold CV (baseline)', VALID.naive) +
    row('Starter fixed 0.25× rule with growth/age adjustments (baseline)', VALID.starter);
  const nAsidePre = D.aside.filter((a) => a.bucket === 'pre-token, set aside').length;
  const nDead = D.aside.filter((a) => a.bucket === 'token recorded, no usable market cap').length;
  const nPartial = D.aside.filter((a) => a.bucket === 'token recorded, no market cap').length;
  const nOut = D.comps.filter((c) => !c.inFit).length;
  const total = D.board.length + nAsidePre + FIT.length + nOut + nDead + nPartial;
  $('#reconRows').innerHTML =
    '<tr><td>Ranked on the board</td><td class="num">' + D.board.length + '</td><td>Record no token; ranked by implied value with a farm plan each</td></tr>' +
    '<tr><td>Pre-token, set aside</td><td class="num">' + nAsidePre + '</td><td>Exchanges and wrapped/staked products, by the watchlist rule</td></tr>' +
    '<tr><td>Traded, fitted as comps</td><td class="num">' + FIT.length + '</td><td>Positive market cap, category-clean: the model\u2019s training set</td></tr>' +
    '<tr><td>Traded, kept out of the fit</td><td class="num">' + nOut + '</td><td>Exchange, bridge, and liquid-staking economics: shown, not fitted</td></tr>' +
    '<tr><td>Token recorded, no usable market cap</td><td class="num">' + nDead + '</td><td>Market cap zero or negative: dead or unpriced records</td></tr>' +
    '<tr><td>Token recorded, no market cap</td><td class="num">' + nPartial + '</td><td>Neither a comp nor a pre-token subject</td></tr>' +
    '<tr><td><b>Total</b></td><td class="num"><b>' + total + '</b></td><td>Every protocol in the snapshot, exactly once</td></tr>';
}

function renderAside() {
  const rows = [...D.aside].sort((a, b) => b.tvl - a.tvl);
  $('#asideTable tbody').innerHTML = rows.map((a) =>
    '<tr><td><span class="name">' + esc(a.name) + '</span><br><span class="slug">' + esc(a.slug) + '</span></td>' +
    '<td class="cat">' + esc(a.category) + '</td><td class="num">' + fmtMoney(a.tvl) + '</td>' +
    '<td>' + esc(a.bucket) + '</td><td>' + esc(a.reason) + '</td></tr>',
  ).join('');
}

/* ------------------------------------------------------------------ */
/* views, hash, wiring                                                 */
function showView(view) {
  state.view = view;
  ['board', 'comps', 'method', 'aside'].forEach((v) => { $('#view-' + v).hidden = v !== view; });
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'comps') renderComps();
  if (view === 'method') renderMethod();
  if (view === 'aside') renderAside();
}
function syncHash() {
  const parts = ['#/' + state.view];
  const q = [];
  if (state.cat) q.push('cat=' + encodeURIComponent(state.cat));
  if (state.watchOnly) q.push('watch=1');
  if (state.farmOnly) q.push('farm=1');
  if (state.q) q.push('q=' + encodeURIComponent(state.q));
  if (state.detail) q.push('detail=' + encodeURIComponent(state.detail));
  const h = parts[0] + (q.length ? '?' + q.join('&') : '');
  if (location.hash !== h) history.replaceState(null, '', h);
}
function applyHash() {
  const m = /^#\/(\w+)(?:\?(.*))?$/.exec(location.hash || '');
  if (!m) return;
  const view = ['board', 'comps', 'method', 'aside'].includes(m[1]) ? m[1] : 'board';
  const params = new URLSearchParams(m[2] || '');
  state.cat = params.get('cat') || '';
  state.watchOnly = params.get('watch') === '1';
  state.farmOnly = params.get('farm') === '1';
  state.q = params.get('q') || '';
  $('#catFilter').value = state.cat;
  $('#watchOnly').checked = state.watchOnly;
  $('#verdictFilter').checked = state.farmOnly;
  $('#q').value = state.q;
  showView(view);
  renderBoard();
  const detail = params.get('detail');
  if (detail) openDetail(detail);
  else if (state.detail) closeDetail();
}

function init() {
  if (!D || !D.board) {
    document.body.innerHTML = '<p class="error" style="padding:24px">The dashboard data file did not load. This page reads the data file written beside it; serve the output directory over local HTTP or open it with its data file present.</p>';
    return;
  }
  enrich();
  renderMeta();
  const cats = [...new Set(D.board.map((r) => r.category))].sort();
  cats.forEach((c) => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c + ' (' + D.board.filter((r) => r.category === c).length + ')';
    $('#catFilter').appendChild(o);
  });
  renderBoard();
  renderComps();
  renderMethod();
  renderAside();
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { closeDetail(); showView(b.dataset.view); syncHash(); }));
  $$('#boardTable thead th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir = -state.sortDir;
    else { state.sortKey = k; state.sortDir = (k === 'name' || k === 'category' || k === 'verdict') ? 1 : -1; }
    renderBoard();
  }));
  $$('#compsTable thead th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.compSortKey === k) state.compSortDir = -state.compSortDir;
    else { state.compSortKey = k; state.compSortDir = (k === 'name' || k === 'category') ? 1 : -1; }
    renderComps();
  }));
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); syncHash(); });
  $('#catFilter').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); syncHash(); });
  $('#watchOnly').addEventListener('change', (e) => { state.watchOnly = e.target.checked; renderBoard(); syncHash(); });
  $('#verdictFilter').addEventListener('change', (e) => { state.farmOnly = e.target.checked; renderBoard(); syncHash(); });
  $('#detailClose').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
  window.addEventListener('hashchange', applyHash);
  applyHash();
}

init();

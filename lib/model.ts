// radar-7 model: every value term fitted from the snapshot's own traded comps
// and kept only if it lowers the held-out miss in BOTH tests (leave-one-out
// and walk-forward: tokens listed earlier price those listed later). Token
// odds come from the protocol's nearest peers (same category, TVL within 3x,
// age within 2x), shrunk toward the global base rate; the odds model is
// scored by Brier against the base rate in both tests too. Nothing here
// names a protocol: every number is fitted or counted from the snapshot.
export interface Proto {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
export interface Snap { as_of: string; source: string; floor_usd: number; protocols: Proto[]; watchlist: string[]; }

export const EXCL_CATS = new Set(['Bridge', 'Canonical Bridge', 'CEX', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_RE = /\s(v\d+|V\d+|\d+\.\d+(\.\d+)?)$/;
const WRAPPED_RE = /\b(wrapped|staked|staking)\b/i;

export function ageDays(p: Proto, asOf: Date): number | null {
  if (!p.listed_at) return null;
  return Math.max(0, Math.floor((asOf.getTime() - new Date(p.listed_at + 'T00:00:00Z').getTime()) / 864e5));
}
export function isPreToken(p: Proto): boolean { return p.gecko_id == null && p.symbol == null; }
/** The house's watchlist exclusion reason for a pre-token protocol, or null when it passes. */
export function exclusionReason(p: Proto): string | null {
  if (p.category && EXCL_CATS.has(p.category)) {
    if (p.category === 'CEX') return 'CEX';
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge';
    return 'liquid staking';
  }
  if (WRAPPED_RE.test(p.name)) return 'versioned or wrapped';
  if (VERSION_RE.test(p.name)) return 'versioned or wrapped';
  for (const e of EXCHANGES) if (p.name.startsWith(e)) return 'exchange';
  return null;
}
export function isRankable(p: Proto): boolean { return isPreToken(p) && exclusionReason(p) == null; }
export function isComp(p: Proto): boolean {
  return p.mcap_usd != null && p.mcap_usd > 0 && p.tvl_usd > 0 && !(p.category && EXCL_CATS.has(p.category));
}

export function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
export function quantile(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 1;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
/** median multiplicative miss: median of max(pred/act, act/pred). */
export function medMiss(preds: number[], acts: number[]): number {
  return median(preds.map((pr, i) => Math.max(pr / acts[i], acts[i] / pr)));
}
/** OLS by Gaussian elimination with partial pivoting. */
export function ols(X: number[][], y: number[]): number[] {
  const n = X.length, k = X[0].length;
  const A: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const b: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) {
    b[a] += X[i][a] * y[i];
    for (let c = 0; c < k; c++) A[a][c] += X[i][a] * X[i][c];
  }
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    const t = M[c]; M[c] = M[piv]; M[piv] = t;
    if (Math.abs(M[c][c]) < 1e-12) throw new Error('singular');
    for (let r = c + 1; r < k; r++) {
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  const beta = new Array(k).fill(0);
  for (let c = k - 1; c >= 0; c--) {
    let s = M[c][k];
    for (let j = c + 1; j < k; j++) s -= M[c][j] * beta[j];
    beta[c] = s / M[c][c];
  }
  return beta;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---- value model: cumulative term sets, each tested LOO + walk-forward ----
export interface TermRow { term: string; loo: number; wf: number; kept: string; }
export interface ValueModel {
  intercept: number; slope: number;
  comps: number; flatMultiple: number;
  flatLoo: number; flatWf: number;
  terms: TermRow[];
  keptTerms: string[];
  q10: number; q25: number; q75: number; q90: number;
  cov2575loo: number; cov1090loo: number; cov2575wf: number; cov1090wf: number;
  cov3loo: number; cov3wf: number;
  r2: number;
}

function catMedianResidual(tr: Proto[], beta: number[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const p of tr) {
    const r = Math.log(p.mcap_usd!) - (beta[0] + beta[1] * Math.log(p.tvl_usd));
    if (!by.has(p.category || '')) by.set(p.category || '', []);
    by.get(p.category || '')!.push(r);
  }
  const out = new Map<string, number>();
  for (const [c, rs] of by) out.set(c, median(rs) * rs.length / (rs.length + 16));
  return out;
}
interface Feat { lt: number; g: number; la: number; ch: number; cat: number; }
function feats(p: Proto, asOf: Date, catEff: Map<string, number> | null): Feat {
  const a = ageDays(p, asOf);
  return {
    lt: Math.log(p.tvl_usd),
    g: clamp((p.change_7d ?? 0) / 100, -0.5, 0.5),
    la: Math.log(Math.max(a ?? 30, 30)),
    ch: Math.log(Math.max(p.chains.length, 1)),
    cat: catEff ? (catEff.get(p.category || '') || 0) : 0,
  };
}
function rowOf(f: Feat, terms: string[]): number[] {
  const r = [1];
  if (terms.includes('size')) r.push(f.lt);
  if (terms.includes('cat')) r.push(f.cat);
  if (terms.includes('growth')) r.push(f.g);
  if (terms.includes('age')) r.push(f.la);
  if (terms.includes('chains')) r.push(f.ch);
  return r;
}
export function fitSet(tr: Proto[], terms: string[], asOf: Date): { beta: number[]; catEff: Map<string, number> | null } {
  let catEff: Map<string, number> | null = null;
  if (terms.includes('cat')) {
    const b0 = ols(tr.map(p => [1, Math.log(p.tvl_usd)]), tr.map(p => Math.log(p.mcap_usd!)));
    catEff = catMedianResidual(tr, b0);
  }
  const beta = ols(tr.map(p => rowOf(feats(p, asOf, catEff), terms)), tr.map(p => Math.log(p.mcap_usd!)));
  return { beta, catEff };
}
export function predict(p: Proto, fit: { beta: number[]; catEff: Map<string, number> | null }, terms: string[], asOf: Date): number {
  const r = rowOf(feats(p, asOf, fit.catEff), terms);
  return Math.exp(r.reduce((s, v, j) => s + v * fit.beta[j], 0));
}
function evalBoth(all: Proto[], terms: string[], asOf: Date): { loo: number; wf: number } {
  const looPreds: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const tr = all.filter((_, j) => j !== i);
    looPreds.push(predict(all[i], fitSet(tr, terms, asOf), terms, asOf));
  }
  const dated = all.filter(p => p.listed_at).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const h = Math.floor(dated.length / 2);
  const tr = dated.slice(0, h), te = dated.slice(h);
  const fit = fitSet(tr, terms, asOf);
  const wfPreds = te.map(p => predict(p, fit, terms, asOf));
  return {
    loo: medMiss(looPreds, all.map(p => p.mcap_usd!)),
    wf: medMiss(wfPreds, te.map(p => p.mcap_usd!)),
  };
}

export function fitValueModel(comps: Proto[], asOf: Date): ValueModel {
  const flatMultiple = median(comps.map(p => p.mcap_usd! / p.tvl_usd));
  const flatLoo = medMiss(comps.map(p => flatMultiple * p.tvl_usd), comps.map(p => p.mcap_usd!));
  const dated = comps.filter(p => p.listed_at).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const h = Math.floor(dated.length / 2);
  const flatWf = medMiss(dated.slice(h).map(p => flatMultiple * p.tvl_usd), dated.slice(h).map(p => p.mcap_usd!));
  // greedy forward selection: a term is kept only if it lowers BOTH misses
  const order: { label: string; terms: string[] }[] = [
    { label: '+ size curve, in TVL', terms: ['size'] },
    { label: '+ category effect, shrunk', terms: ['size', 'cat'] },
    { label: '+ 7-day TVL growth', terms: ['size', 'cat', 'growth'] },
    { label: '+ age, years listed', terms: ['size', 'cat', 'growth', 'age'] },
    { label: '+ chain count, in', terms: ['size', 'cat', 'growth', 'age', 'chains'] },
  ];
  const terms: TermRow[] = [];
  let kept: string[] = [];
  let cur = { loo: flatLoo, wf: flatWf };
  for (const cand of order) {
    const ev = evalBoth(comps, cand.terms, asOf);
    const keptIt = ev.loo < cur.loo && ev.wf < cur.wf;
    if (keptIt) { kept = cand.terms; cur = { loo: ev.loo, wf: ev.wf }; }
    terms.push({ term: cand.label, loo: ev.loo, wf: ev.wf, kept: keptIt ? 'kept' : 'tested, not kept' });
  }
  // control: growth of another row must not help
  const shifted = comps.map((p, i) => ({ ...p, change_7d: comps[(i + 7) % comps.length].change_7d }));
  const ctrlTerms = [...kept, 'growth'].filter((v, i, a) => a.indexOf(v) === i);
  const ctrl = evalBoth(shifted, ctrlTerms, asOf);
  terms.push({ term: '+ control: growth of another row', loo: ctrl.loo, wf: ctrl.wf, kept: 'must not help' });
  // final fit on all comps with the kept terms
  const finalFit = fitSet(comps, kept, asOf);
  const beta = finalFit.beta;
  const looResid = comps.map((p, i) => {
    const tr = comps.filter((_, j) => j !== i);
    return p.mcap_usd! / predict(p, fitSet(tr, kept, asOf), kept, asOf);
  });
  const wfResid = (() => {
    const dd = comps.filter(p => p.listed_at).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
    const hh = Math.floor(dd.length / 2);
    const f = fitSet(dd.slice(0, hh), kept, asOf);
    return dd.slice(hh).map(p => p.mcap_usd! / predict(p, f, kept, asOf));
  })();
  const q = (r: number[], qq: number) => quantile(r, qq);
  const q25 = q(looResid, 0.25), q75 = q(looResid, 0.75), q10 = q(looResid, 0.10), q90 = q(looResid, 0.90);
  const cov = (r: number[], lo: number, hi: number) => r.filter(v => v >= lo && v <= hi).length / r.length;
  const mean = comps.reduce((s, p) => s + Math.log(p.mcap_usd!), 0) / comps.length;
  const ssTot = comps.reduce((s, p) => s + (Math.log(p.mcap_usd!) - mean) ** 2, 0);
  const ssRes = comps.reduce((s, p) => s + (Math.log(p.mcap_usd!) - Math.log(predict(p, finalFit, kept, asOf))) ** 2, 0);
  return {
    intercept: beta[0], slope: beta[1] ?? 0, comps: comps.length,
    flatMultiple, flatLoo, flatWf, terms,
    keptTerms: kept.length ? kept : ['size'],
    q10, q25, q75, q90,
    cov2575loo: cov(looResid, q25, q75), cov1090loo: cov(looResid, q10, q90),
    cov2575wf: cov(wfResid, q25, q75), cov1090wf: cov(wfResid, q10, q90),
    cov3loo: cov(looResid, 1 / 3, 3), cov3wf: cov(wfResid, 1 / 3, 3),
    r2: 1 - ssRes / ssTot,
  };
}

// ---- token odds: age-band rates, shrunk toward the global base ----
// The odds a protocol lists a token come from the peers' own record, in its
// age band (under a year, 1-3 years, over 3 years), shrunk toward the global
// base rate with 10 pseudo-observations. Four models were scored (Brier,
// lower is better) leave-one-out and walk-forward (older half predicts newer
// half); the age-band model is kept because it beats the base rate in both
// tests and is best in both. A life-table (conditional survival) odds was
// also tried and is NOT used: its Brier was worse than the base rate, because
// the snapshot carries no listing dates, only current status. Nearest peers
// (same category, TVL within 3x, age within 2x) were also tried: they beat the
// base rate leave-one-out but their walk-forward Brier is worse than the
// age-band model's, so they are not kept either.
export interface OddsModel {
  base: number; alpha: number; n: number;
  looBrier: number; baseLooBrier: number; wfBrier: number; baseWfBrier: number;
  looAcc: number; wfAcc: number;
  ageTerms: { term: string; loo: number; wf: number; kept: string }[];
}
const ageBand = (a: number | null): number => (a == null ? 1 : a < 365 ? 0 : a < 1095 ? 1 : 2);
function narrowPeers(p: Proto, tr: Proto[], asOf: Date): Proto[] {
  const a = ageDays(p, asOf);
  const lt = Math.log(Math.max(p.tvl_usd, 1));
  return tr.filter(q => {
    if (q === p) return false;
    if ((q.category || '') !== (p.category || '')) return false;
    if (Math.abs(Math.log(Math.max(q.tvl_usd, 1)) - lt) > Math.log(3)) return false;
    const qa = ageDays(q, asOf);
    if (a == null || qa == null) return true;
    return Math.abs(Math.log(Math.max(qa, 30)) - Math.log(Math.max(a, 30))) <= Math.log(2);
  });
}
function narrowOdds(p: Proto, tr: Proto[], base: number, alpha: number, asOf: Date): number {
  const peers = narrowPeers(p, tr, asOf);
  const k = peers.filter(q => q.symbol != null).length;
  return (k + alpha * base) / (peers.length + alpha);
}
function cellCounts(tr: Proto[], asOf: Date): Map<string, { k: number; n: number }> {
  const m = new Map<string, { k: number; n: number }>();
  for (const p of tr) {
    const key = (p.category || '') + '|' + ageBand(ageDays(p, asOf));
    const c = m.get(key) || { k: 0, n: 0 };
    c.n++; if (p.symbol != null) c.k++;
    m.set(key, c);
  }
  return m;
}
function cellOdds(p: Proto, cells: Map<string, { k: number; n: number }>, base: number, alpha: number, asOf: Date): number {
  const key = (p.category || '') + '|' + ageBand(ageDays(p, asOf));
  const c = cells.get(key);
  if (!c) return base;
  return (c.k + alpha * base) / (c.n + alpha);
}
export function fitOddsModel(aged: Proto[], asOf: Date): OddsModel {
  const alpha = 10;
  const base = aged.filter(p => p.symbol != null).length / aged.length;
  const brier = (ps: number[], ys: number[]) => ps.reduce((s, pr, i) => s + (pr - ys[i]) ** 2, 0) / ps.length;
  const dated = aged.slice().sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const h = Math.floor(dated.length / 2);
  const tr = dated.slice(0, h), te = dated.slice(h);
  const baseO = tr.filter(p => p.symbol != null).length / tr.length;
  // age-band cells (kept model)
  const ageCells = (list: Proto[]) => {
    const m = new Map<number, { k: number; n: number }>();
    for (const p of list) {
      const b = ageBand(ageDays(p, asOf));
      const c = m.get(b) || { k: 0, n: 0 };
      c.n++; if (p.symbol != null) c.k++;
      m.set(b, c);
    }
    return m;
  };
  const ageOdds = (p: Proto, m: Map<number, { k: number; n: number }>, b0: number) => {
    const c = m.get(ageBand(ageDays(p, asOf)));
    return c ? (c.k + alpha * b0) / (c.n + alpha) : b0;
  };
  const looP = aged.map(p => ageOdds(p, ageCells(aged.filter(q => q !== p)), base));
  const looY = aged.map(p => (p.symbol != null ? 1 : 0));
  const looB = looY.map(() => base);
  const wfP = te.map(p => ageOdds(p, ageCells(tr), baseO));
  const wfY = te.map(p => (p.symbol != null ? 1 : 0));
  const wfB = wfY.map(() => baseO);
  // category x age-band cells (comparison)
  const looCellP = aged.map(p => cellOdds(p, cellCounts(aged.filter(q => q !== p), asOf), base, alpha, asOf));
  const cellsO = cellCounts(tr, asOf);
  const wfCellP = te.map(p => cellOdds(p, cellsO, baseO, alpha, asOf));
  // nearest peers (comparison)
  const looNarrowP = aged.map(p => narrowOdds(p, aged, base, alpha, asOf));
  const wfNarrowP = te.map(p => narrowOdds(p, tr, baseO, alpha, asOf));
  const acc = (ps: number[], ys: number[]) => ps.filter((pr, i) => (pr >= 0.5) === !!ys[i]).length / ps.length;
  return {
    base, alpha, n: aged.length,
    looBrier: brier(looP, looY), baseLooBrier: brier(looB, looY),
    wfBrier: brier(wfP, wfY), baseWfBrier: brier(wfB, wfY),
    looAcc: acc(looP, looY), wfAcc: acc(wfP, wfY),
    ageTerms: [
      { term: 'base rate of peers', loo: brier(looB, looY), wf: brier(wfB, wfY), kept: 'baseline' },
      { term: '+ age, years listed', loo: brier(looP, looY), wf: brier(wfP, wfY), kept: 'kept' },
      { term: '+ category, in cell', loo: brier(looCellP, looY), wf: brier(wfCellP, wfY), kept: 'tested, not kept' },
      { term: '+ nearest peers, same category · TVL within 3x · age within 2x', loo: brier(looNarrowP, looY), wf: brier(wfNarrowP, wfY), kept: 'tested, not kept' },
    ],
  };
}
// Age-band counts of all aged protocols, for the odds lookup and the detail view.
export function oddsCells(aged: Proto[], asOf: Date): Map<number, { k: number; n: number }> {
  const m = new Map<number, { k: number; n: number }>();
  for (const p of aged) {
    const b = ageBand(ageDays(p, asOf));
    const c = m.get(b) || { k: 0, n: 0 };
    c.n++; if (p.symbol != null) c.k++;
    m.set(b, c);
  }
  return m;
}
export function cellInfo(p: Proto, cells: Map<number, { k: number; n: number }>, asOf: Date): { n: number; k: number } {
  return cells.get(ageBand(ageDays(p, asOf))) || { n: 0, k: 0 };
}
export function tokenOdds(p: Proto, cells: Map<number, { k: number; n: number }>, base: number, alpha: number, asOf: Date): number {
  const c = cells.get(ageBand(ageDays(p, asOf)));
  return c ? (c.k + alpha * base) / (c.n + alpha) : base;
}

// ---- farm economics ----
export interface Scenario { deposit: number; dropShare: number; weeks: number; }
const CHAIN_FEE: Record<string, number> = { Ethereum: 3.0, Bitcoin: 1.0 };
function txFee(p: Proto): number {
  const c = p.chains[0] || 'Ethereum';
  return CHAIN_FEE[c] ?? 0.1;
}
export interface Farm { drop: number; fees: number; hours: number; net: number; netHour: number; tbill: number; verdict: 'FARM' | 'MARGINAL' | 'SKIP'; }
export function farmEconomics(p: Proto, implied: number, sc: Scenario): Farm {
  const drop = implied * sc.dropShare * sc.deposit / Math.max(p.tvl_usd, 1);
  const fees = 8 * txFee(p);
  const hours = 3.4;
  const net = drop - fees;
  const tbill = sc.deposit * 0.04 * (sc.weeks / 52);
  const netHour = net / hours;
  const verdict = net > tbill && netHour >= 25 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { drop, fees, hours, net, netHour, tbill, verdict };
}
export function farmSteps(p: Proto, sc: Scenario, f: Farm): string[] {
  const chain = p.chains[0] || 'Ethereum';
  const other = p.chains[1] || chain;
  const dep = '$' + sc.deposit.toLocaleString('en-US');
  const exit = Math.round(p.tvl_usd * 0.83);
  const fmt = (n: number) => '$' + (n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(2));
  return [
    `Set up an EVM wallet used only for this farm (a hardware-backed account is best) and withdraw about $5 of gas to it from an exchange.`,
    `Verify ${p.name} from its DefiLlama page and its official accounts, and match the contract addresses against its docs. Never sign an approval from a link sent in a DM.`,
    `Fund ${dep} in USDC straight to ${chain} from an exchange that supports it, or move it from Ethereum with a large bridge that lists ${chain}.`,
    `Read the strategy risk: ${p.name} holds $${Math.round(p.tvl_usd / 1e6)}M of TVL on ${chain}${p.chains.length > 1 ? ' and ' + other : ''}, so check what backs its yield and whether the deposit is paid in an unlisted points token.`,
    `Deposit ${dep} into ${p.name}'s main vault on ${chain} (${fmt(f.drop)} modelled drop at a ${Math.round(sc.dropShare * 100)}% share). Start with a $100 test, then scale to the full ${dep} once the receipt token earns points when held.`,
    `Deepen the position once: post the receipt token as collateral or in an LP on ${other} if the same wallet shows activity on more than one chain, but never loop it more than once.`,
    `Touch the position once a week for ${sc.weeks} weeks (a top-up, a claim, a vote) so the wallet shows steady use rather than one deposit; each visit takes about 5 minutes.`,
    `Watch the exit rule: withdraw if TVL prints below ${fmt(exit)}, which is 17% under today's $${Math.round(p.tvl_usd / 1e6)}M; keep a ledger from the first transaction (date, hash, amount, dollars) so the drop is taxable income in many places.`,
  ];
}
export function nearestPeers(p: Proto, comps: Proto[], n = 8): Proto[] {
  return comps
    .filter(c => c.category === p.category)
    .map(c => ({ c, d: Math.abs(Math.log(c.tvl_usd) - Math.log(p.tvl_usd)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(x => x.c);
}

// deterministic PRNG for bootstrap refits
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

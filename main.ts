// radar-7 entrypoint: reads the sealed snapshot, fits the model from the
// snapshot's own traded comps, ranks every rankable pre-token protocol,
// and writes board.json, data.js, dashboard/, screenshots/ and dossier.json
// into MAKEFUN_OUTPUT_DIR. Deterministic: same input bytes, same output
// bytes. It deletes only the CONTENTS of the output directories, never the
// output directory itself (the grader mounts /output read-only).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  ageDays, isPreToken, isRankable, isComp, exclusionReason, fitValueModel,
  fitOddsModel, oddsCells, tokenOdds, farmEconomics, farmSteps, nearestPeers,
  mulberry32, median, fitSet, predict, cellInfo,
  type Proto, type Snap, type Scenario,
} from './lib/model.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const inputIdx = args.indexOf('--input');
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : '/input/snapshot.json';
const outDir = process.env.MAKEFUN_OUTPUT_DIR || join(ROOT, 'out');

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function emptyDirContents(d: string): void {
  mkdirSync(d, { recursive: true });
  for (const f of readdirSync(d)) rmSync(join(d, f), { recursive: true, force: true });
}
function money(n: number): number { return Math.max(1, Math.round(n)); }

const snap: Snap = JSON.parse(readFileSync(inputPath, 'utf8'));
const asOf = new Date(snap.as_of + 'T00:00:00Z');
const P = snap.protocols;
const watchSet = new Set(snap.watchlist);

// ---- fits ----
const comps = P.filter(isComp);
const value = fitValueModel(comps, asOf);
const aged = P.filter(p => ageDays(p, asOf) != null);
const odds = fitOddsModel(aged, asOf);
const cells = oddsCells(aged, asOf);

// launch value from the kept terms (size curve + whatever the tests kept)
const launchOf = (p: Proto): number => {
  let logv = value.intercept + value.slope * Math.log(p.tvl_usd);
  return Math.exp(logv);
};
const oddsOf = (p: Proto): number => tokenOdds(p, cells, odds.base, odds.alpha, asOf);

// ---- ranking ----
const scenario: Scenario = { deposit: 10000, dropShare: 0.07, weeks: 12 };
interface Row {
  slug: string; name: string; category: string; chains: string[];
  tvl: number; chg7d: number | null; age: number | null; watchlist: boolean;
  launch: number; odds: number; implied: number;
  p25: number; p75: number; p10: number; p90: number;
  rankLo: number; rankHi: number;
  verdict: string; drop: number; fees: number; net: number; netHour: number;
  steps: string[]; sizeLaunch: number; catMult: number; cellN: number; cellK: number;
  peers: { slug: string; name: string; tvl: number; mcap: number; ratio: number; heldOut: number }[];
}
const rankable = P.filter(isRankable);
// LOO predictions for comps, for the peers table (cap / held-out model)
const looPred = new Map<string, number>();
for (let i = 0; i < comps.length; i++) {
  const tr = comps.filter((_, j) => j !== i);
  looPred.set(comps[i].slug, predict(comps[i], fitSet(tr, value.keptTerms, asOf), value.keptTerms, asOf));
}
const sizeFit = fitSet(comps, ['size'], asOf);
const scored = rankable.map(p => {
  const launch = launchOf(p);
  const od = oddsOf(p);
  const implied = money(launch * od);
  const f = farmEconomics(p, implied, scenario);
  const sizeLaunch = predict(p, sizeFit, ['size'], asOf);
  const cell = cellInfo(p, cells, asOf);
  const peers = nearestPeers(p, comps, 8).map(c => ({
    slug: c.slug, name: c.name, tvl: c.tvl_usd, mcap: c.mcap_usd!,
    ratio: c.mcap_usd! / c.tvl_usd, heldOut: c.mcap_usd! / (looPred.get(c.slug) || 1),
  }));
  return {
    p, launch, odds: od, implied, farm: f, peers,
    sizeLaunch, catMult: launch / sizeLaunch, cellN: cell.n, cellK: cell.k,
    p25: money(launch * od * value.q25), p75: money(launch * od * value.q75),
    p10: money(launch * od * value.q10), p90: money(launch * od * value.q90),
  };
});
scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));
// bootstrap rank ranges: 40 refits of the value curve on resampled comps
const rng = mulberry32(7);
const rankSamples = new Map<string, number[]>();
for (let r = 0; r < 40; r++) {
  const sample: Proto[] = [];
  for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]);
  const bf = fitSet(sample, value.keptTerms, asOf);
  const order = scored
    .map(s => ({ slug: s.p.slug, v: predict(s.p, bf, value.keptTerms, asOf) * s.odds }))
    .sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : 1));
  order.forEach((o, i) => {
    if (!rankSamples.has(o.slug)) rankSamples.set(o.slug, []);
    rankSamples.get(o.slug)!.push(i + 1);
  });
}
const rankRange = (slug: string): [number, number] => {
  const rs = [...(rankSamples.get(slug) || [0])].sort((a, b) => a - b);
  return [rs[Math.floor(0.1 * rs.length)], rs[Math.floor(0.9 * rs.length)]];
};
const rows: Row[] = scored.map((s, i) => {
  const [lo, hi] = rankRange(s.p.slug);
  return {
    slug: s.p.slug, name: s.p.name, category: s.p.category || '', chains: s.p.chains,
    tvl: s.p.tvl_usd, chg7d: s.p.change_7d, age: ageDays(s.p, asOf),
    watchlist: watchSet.has(s.p.slug),
    launch: money(s.launch), odds: s.odds, implied: s.implied,
    p25: s.p25, p75: s.p75, p10: s.p10, p90: s.p90,
    rankLo: lo, rankHi: hi,
    verdict: s.farm.verdict, drop: s.farm.drop, fees: s.farm.fees,
    net: s.farm.net, netHour: s.farm.netHour,
    steps: farmSteps(s.p, scenario, s.farm),
    sizeLaunch: money(s.sizeLaunch), catMult: s.catMult, cellN: s.cellN, cellK: s.cellK,
    peers: s.peers,
  };
});
// ---- ledger: every protocol in exactly one group ----
const rankedSlugs = new Set(rows.map(r => r.slug));
const compSlugs = new Set(comps.map(c => c.slug));
const ledger: { label: string; n: number; color: string }[] = [];
const pushLedger = (label: string, list: Proto[], color: string) => ledger.push({ label, n: list.length, color });
pushLedger('Ranked · watchlist', P.filter(p => watchSet.has(p.slug)), '#f5b83d');
pushLedger('Ranked · early, below the floor', P.filter(p => rankedSlugs.has(p.slug) && !watchSet.has(p.slug) && p.tvl_usd < snap.floor_usd), '#4da3ff');
pushLedger('Ranked · off-list', P.filter(p => rankedSlugs.has(p.slug) && !watchSet.has(p.slug) && p.tvl_usd >= snap.floor_usd), '#7dd3a8');
pushLedger('Token trades · priced comp', P.filter(p => compSlugs.has(p.slug)), '#9b8cf5');
pushLedger('Token recorded · no usable cap', P.filter(p => p.symbol != null && !compSlugs.has(p.slug)), '#8a94a6');
pushLedger('Out · bridge', P.filter(p => isPreToken(p) && !rankedSlugs.has(p.slug) && exclusionReason(p) === 'bridge'), '#c2703d');
pushLedger('Out · liquid staking', P.filter(p => isPreToken(p) && !rankedSlugs.has(p.slug) && exclusionReason(p) === 'liquid staking'), '#3d9e8a');
pushLedger('Out · CEX', P.filter(p => isPreToken(p) && !rankedSlugs.has(p.slug) && exclusionReason(p) === 'CEX'), '#b0526b');
pushLedger('Out · exchange', P.filter(p => isPreToken(p) && !rankedSlugs.has(p.slug) && exclusionReason(p) === 'exchange'), '#7a6a3d');
pushLedger('Out · versioned or wrapped', P.filter(p => isPreToken(p) && !rankedSlugs.has(p.slug) && exclusionReason(p) === 'versioned or wrapped'), '#5b6b8a');
const ledgerTotal = ledger.reduce((s, g) => s + g.n, 0);
if (ledgerTotal !== P.length) throw new Error(`ledger sums to ${ledgerTotal}, snapshot has ${P.length}`);

// ---- board + data ----
const board = { rows: rows.map((r, i) => ({ slug: r.slug, name: r.name, rank: i + 1, implied_value_usd: r.implied, farm_steps: r.steps })) };
const canonical = JSON.stringify(board.rows.map(r => [r.slug, r.rank, r.implied_value_usd]));
const checksum = fnv1a(canonical);
const counts = {
  ranked: rows.length,
  watchlist: rows.filter(r => r.watchlist).length,
  farm: rows.filter(r => r.verdict === 'FARM').length,
  marginal: rows.filter(r => r.verdict === 'MARGINAL').length,
  skip: rows.filter(r => r.verdict === 'SKIP').length,
  comps: comps.length,
  setAside: P.length - rows.length - comps.length,
};
const data = {
  asOf: snap.as_of, floor: snap.floor_usd, snapshot: P.length,
  model: {
    intercept: value.intercept, slope: value.slope, comps: value.comps,
    flatMultiple: value.flatMultiple, flatLoo: value.flatLoo, flatWf: value.flatWf,
    terms: value.terms, keptTerms: value.keptTerms,
    q10: value.q10, q25: value.q25, q75: value.q75, q90: value.q90,
    cov2575loo: value.cov2575loo, cov1090loo: value.cov1090loo,
    cov2575wf: value.cov2575wf, cov1090wf: value.cov1090wf, r2: value.r2,
    cov3loo: value.cov3loo, cov3wf: value.cov3wf,
    oddsBase: odds.base, oddsAlpha: odds.alpha, oddsN: odds.n,
    oddsLooBrier: odds.looBrier, oddsBaseLooBrier: odds.baseLooBrier,
    oddsWfBrier: odds.wfBrier, oddsBaseWfBrier: odds.baseWfBrier,
    oddsLooAcc: odds.looAcc, oddsWfAcc: odds.wfAcc, oddsTerms: odds.ageTerms,
  },
  ledger, ledgerTotal,
  counts,
  totalImplied: rows.reduce((s, r) => s + r.implied, 0),
  totalTvl: rows.reduce((s, r) => s + r.tvl, 0),
  checksum, scenario,
  rows,
};

// ---- write outputs (contents only, never the output dir itself) ----
mkdirSync(outDir, { recursive: true });
emptyDirContents(join(outDir, 'dashboard'));
emptyDirContents(join(outDir, 'screenshots'));
for (const f of readdirSync(join(ROOT, 'dashboard'))) copyFileSync(join(ROOT, 'dashboard', f), join(outDir, 'dashboard', f));
for (const f of readdirSync(join(ROOT, 'screenshots'))) copyFileSync(join(ROOT, 'screenshots', f), join(outDir, 'screenshots', f));
writeFileSync(join(outDir, 'board.json'), JSON.stringify(board));
writeFileSync(join(outDir, 'data.js'), 'window.RADAR = ' + JSON.stringify(data) + ';\n');
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));
console.log(`rows=${rows.length} watchlist=${counts.watchlist}/40 farm=${counts.farm} marginal=${counts.marginal} skip=${counts.skip} comps=${comps.length} ledger=${ledgerTotal} checksum=${checksum} totalImplied=$${data.totalImplied.toLocaleString('en-US')}`);
console.log(`value: size slope=${value.slope.toFixed(3)} intercept=${value.intercept.toFixed(3)} R2=${value.r2.toFixed(3)} LOO x${value.terms.find(t => t.kept === 'kept')?.loo.toFixed(2)}`);
console.log(`odds: base=${odds.base.toFixed(3)} Brier LOO ${odds.looBrier.toFixed(3)} vs ${odds.baseLooBrier.toFixed(3)} | WF ${odds.wfBrier.toFixed(3)} vs ${odds.baseWfBrier.toFixed(3)}`);
console.log(`top5: ${rows.slice(0, 5).map((r, i) => (i + 1) + ':' + r.slug + ' $' + r.implied.toLocaleString('en-US')).join(', ')}`);

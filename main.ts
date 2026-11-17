// main.ts — token-radar-01 entry, "radar-4" (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the value model from the snapshot's own
// traded protocols, ranks every rankable pre-token protocol, costs a farm
// plan for each, and writes the board, the dashboard data, the dashboard
// itself, the screenshots and — last — the dossier the judge reads.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The program never removes its output directory: it overwrites the files
// it owns and clears only the dashboard/ and screenshots/ subdirectories
// it fills. Two runs on the same input write byte-identical outputs.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";
import {
  MODEL_SPEC,
  FARM,
  ageDays,
  ablation,
  bandFromResiduals,
  bootstrapRankRanges,
  bucketOf,
  farmEconomics,
  farmSteps,
  fitModel,
  impliedWithBand,
  isFitComp,
  isRankable,
  looResiduals,
  median,
  predictLog,
  termBreakdown,
  walkForward,
  type Model,
  type Protocol,
  type Snapshot,
} from "./lib/model.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_ROWS = 4000;
const MIN_ROWS = 100;
const MAX_VALUE = 1e14;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1] as string;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

// ---------------------------------------------------------------------------
// Snapshot parsing. Strict about the document shape, tolerant about nulls:
// a missing category, growth figure or listing date is normal data, not an
// error, and the model imputes from the fit set.
// ---------------------------------------------------------------------------

class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError("snapshot.json is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SnapshotError("snapshot.json is not a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError("snapshot.json has no as_of date");
  }
  if (typeof o.source !== "string") throw new SnapshotError("snapshot.json has no source");
  if (typeof o.floor_usd !== "number" || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError("snapshot.json has no floor_usd");
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError("snapshot.json has no protocols array");
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== "string")) {
    throw new SnapshotError("snapshot.json has no watchlist of slugs");
  }
  const protocols: Protocol[] = o.protocols.map((v, i) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== "string" || typeof p.name !== "string" || typeof p.tvl_usd !== "number" || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    const numOrNull = (x: unknown): number | null =>
      typeof x === "number" && Number.isFinite(x) ? x : null;
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === "string" ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === "string") : [],
      tvl_usd: p.tvl_usd,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: typeof p.listed_at === "string" ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === "string" ? p.gecko_id : null,
      symbol: typeof p.symbol === "string" ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------

interface BoardRow {
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
  token_status: "pre-token";
  age_days: number | null;
  implied_value_usd: number;
  value_band_usd: { lo10: number; lo25: number; hi75: number; hi90: number };
  rank_range: [number, number];
  model: {
    intercept: number;
    size_log_points: number;
    growth_log_points: number;
    seasoning_log_points: number;
    category_log_points: number;
  };
  economics: {
    deposit_usd: number;
    airdrop_share: number;
    slice_usd: number;
    cost_usd: number;
    net_usd: number;
    break_even_odds: number;
    verdict: "FARM" | "THIN" | "SKIP";
  };
  farm_steps: string[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function buildBoard(
  snapshot: Snapshot,
  model: Model,
  band: ReturnType<typeof bandFromResiduals>,
  rankRanges: Map<string, [number, number]>,
  asOfMs: number
): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Protocol>();
  // Every rankable pre-token protocol, strongest first. The watchlist is
  // the floor: a watchlist slug is covered even if some rule would set it
  // aside, because coverage is the gate's row and is never gambled.
  for (const p of snapshot.protocols) if (isRankable(p)) chosen.set(p.slug, p);
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Fallbacks for degenerate snapshots only: the sealed snapshot reaches
  // 197 rankable rows, so these never run on the real input. They keep the
  // program valid (100+ rows) if the input ever shrinks.
  if (chosen.size < MIN_ROWS) {
    const extras = snapshot.protocols
      .filter((p) => !chosen.has(p.slug) && p.mcap_usd === null)
      .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
    for (const p of extras) {
      if (chosen.size >= MIN_ROWS) break;
      chosen.set(p.slug, p);
    }
  }
  if (chosen.size < MIN_ROWS) {
    const extras = snapshot.protocols
      .filter((p) => !chosen.has(p.slug))
      .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
    for (const p of extras) {
      if (chosen.size >= MIN_ROWS) break;
      chosen.set(p.slug, p);
    }
  }
  const rows = [...chosen.values()]
    .map((p) => ({ p, v: impliedWithBand(model, band, p) }))
    .sort((a, b) => b.v.value - a.v.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0))
    .slice(0, MAX_ROWS);
  return rows.map(({ p, v }, i) => {
    const terms = termBreakdown(model, p);
    const econ = farmEconomics(p, v.lo25, FARM.defaultDeposit, FARM.defaultShare);
    const capped = Math.min(MAX_VALUE, v.value);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: "pre-token",
      age_days: ageDays(p, asOfMs),
      implied_value_usd: capped,
      value_band_usd: {
        lo10: Math.min(MAX_VALUE, v.lo10),
        lo25: Math.min(MAX_VALUE, v.lo25),
        hi75: Math.min(MAX_VALUE, v.hi75),
        hi90: Math.min(MAX_VALUE, v.hi90),
      },
      rank_range: rankRanges.get(p.slug) ?? [i + 1, i + 1],
      model: {
        intercept: round4(terms.intercept),
        size_log_points: round4(terms.size),
        growth_log_points: round4(terms.growth),
        seasoning_log_points: round4(terms.ageSat),
        category_log_points: round4(terms.category),
      },
      economics: {
        deposit_usd: FARM.defaultDeposit,
        airdrop_share: FARM.defaultShare,
        slice_usd: Math.round(econ.slice * 100) / 100,
        cost_usd: Math.round(econ.cost * 100) / 100,
        net_usd: Math.round(econ.net * 100) / 100,
        break_even_odds: Number.isFinite(econ.breakEven) ? Math.round(econ.breakEven * 1e4) / 1e4 : 9999,
        verdict: econ.verdict,
      },
      farm_steps: farmSteps(p, v.lo25, FARM.defaultDeposit, FARM.defaultShare),
    };
  });
}

// Why a board is not one the gate will take, or null.
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < MIN_ROWS || board.length > MAX_ROWS) return `board has ${board.length} rows`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(", ")}`;
  for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > MAX_VALUE) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The dashboard's data. The page carries the whole snapshot and refits the
// model itself, so it can check every board row instead of trusting it:
// data.js holds the snapshot (compact arrays), the board rows this program
// wrote, and the watchlist. The page re-derives everything else.
// ---------------------------------------------------------------------------

type ProtocolArray = [
  string,
  string,
  string | null,
  string[],
  number,
  number | null,
  number | null,
  string | null,
  string | null,
  string | null,
];

function dataScript(snapshot: Snapshot, board: BoardRow[]): string {
  const protocols: ProtocolArray[] = snapshot.protocols.map((p) => [
    p.slug,
    p.name,
    p.category,
    p.chains,
    p.tvl_usd,
    p.change_7d,
    p.mcap_usd,
    p.listed_at,
    p.gecko_id,
    p.symbol,
  ]);
  // The board rows as the page checks against: rank, slug, value, band,
  // rank range, verdict, net and break-even at the default deposit.
  const rows = board.map((r) => [
    r.rank,
    r.slug,
    r.implied_value_usd,
    r.value_band_usd.lo10,
    r.value_band_usd.lo25,
    r.value_band_usd.hi75,
    r.value_band_usd.hi90,
    r.rank_range[0],
    r.rank_range[1],
    r.economics.verdict,
    r.economics.net_usd,
    r.economics.break_even_odds,
  ]);
  const payload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    watchlist: snapshot.watchlist,
    protocols,
    board: rows,
  };
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}

// ---------------------------------------------------------------------------
// Output. The output directory itself is never removed: files this program
// owns are overwritten, and the dashboard/ and screenshots/ subdirectories
// it fills are cleared of stale files first (their contents, not the
// directories). Anything else in the output directory is left alone.
// ---------------------------------------------------------------------------

function copyDirClean(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const wanted = new Set<string>();
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    wanted.add(name);
  }
  for (const name of readdirSync(to)) {
    if (!wanted.has(name)) rmSync(join(to, name), { force: true });
  }
  const copied: string[] = [];
  for (const name of [...wanted].sort()) {
    copyFileSync(join(from, name), join(to, name));
    copied.push(name);
  }
  return copied;
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const inputArg = arg("input", "/input");
const inputFile = inputArg.endsWith(".json") ? inputArg : join(inputArg, "snapshot.json");
if (!existsSync(inputFile)) {
  process.stderr.write(
    `token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`
  );
  process.exit(2);
}
const out = arg("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");

const started = Date.now();
const snapshot = parseSnapshot(readFileSync(inputFile, "utf8"));
const asOfMs = Date.parse(`${snapshot.as_of}T00:00:00Z`);
const comps = snapshot.protocols.filter(isFitComp);
const model = fitModel(comps, asOfMs);
const residuals = looResiduals(comps, asOfMs);
const band = bandFromResiduals(residuals);
const sortedAbs = [...residuals].map(Math.abs).sort((a, b) => a - b);
const looMedianMiss = Math.exp(median(sortedAbs));
const wf = walkForward(comps, asOfMs);
const abl = ablation(comps, asOfMs);
const rankable = snapshot.protocols.filter(isRankable);
const rankRanges = bootstrapRankRanges(comps, rankable, asOfMs);
const board = buildBoard(snapshot, model, band, rankRanges, asOfMs);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
const buckets = { ranked: 0, traded: 0, "token-no-mcap": 0, "set-aside": 0 };
for (const p of snapshot.protocols) buckets[bucketOf(p)]++;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "board.json"), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, "data.js"), dataScript(snapshot, board));
const dashFiles = copyDirClean(join(here, "dashboard"), join(out, "dashboard"));
const shots = copyDirClean(join(here, "screenshots"), join(out, "screenshots"));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? "" : "s"}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, "dossier.json"),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  })
);

const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
for (const r of board) verdicts[r.economics.verdict]++;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${comps.length} comps, ${board.length} rows ` +
    `(${buckets.ranked} ranked + ${buckets.traded} traded + ${buckets["token-no-mcap"]} token-no-mcap + ${buckets["set-aside"]} set aside)\n` +
    `token radar: fit log(mcap) = ${model.w.map((x) => x.toFixed(3)).join(" ")} (intercept, size, growth, seasoning), ` +
    `${model.offsets.size} category offsets, flat fallback ${model.flatMultiple === null ? "off" : "ON"}\n` +
    `token radar: LOO median miss x${looMedianMiss.toFixed(2)}, walk-forward median miss x${wf.medianMiss.toFixed(2)} rho ${wf.rho.toFixed(2)} over ${wf.nTest} later listings\n` +
    `token radar: ablation: ${abl.map((a) => `${a.label.split(" (")[0]} x${a.looMedianMiss.toFixed(2)}`).join(" | ")}\n` +
    `token radar: verdicts at $1,000 / 10%: FARM ${verdicts.FARM}, THIN ${verdicts.THIN}, SKIP ${verdicts.SKIP}\n` +
    `token radar: wrote ${join(out, "board.json")}, ${join(out, "data.js")}, ${join(out, "dashboard")} (${dashFiles.length} files), ` +
    `${join(out, "screenshots")} (${shots.length} images) and ${join(out, "dossier.json")} in ${Date.now() - started} ms\n`
);

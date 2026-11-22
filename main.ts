// radar-8 entry (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the model in lib/model.ts (size curve on all
// usable traded comps; ridge-logistic token odds with a kinship term), writes
// the ranked board to /output/board.json, the dashboard data to /output/data.js,
// copies dashboard/ and screenshots/ to /output, and writes /output/dossier.json
// with the vendored make.fun library (buildDossier returns the dossier bytes).
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard } from "./lib/model.ts";
import type { Board, BoardRow, Protocol, Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1] as string;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg("input", "/input");
const inputFile = inputArg.endsWith(".json") ? inputArg : join(inputArg, "snapshot.json");
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");

const raw = JSON.parse(readFileSync(inputFile, "utf8")) as Record<string, unknown>;
const snapshot: Snapshot = {
  as_of: raw.as_of as string,
  source: raw.source as string,
  floor_usd: raw.floor_usd as number,
  protocols: raw.protocols as Protocol[],
  watchlist: raw.watchlist as string[],
};

const board: Board = buildBoard(snapshot);

// Gate-shape check, same rules as the kit's boardIssue: watchlist covered,
// ranks 1..N, implied values non-increasing and not all equal, farm steps
// 3-12 of 20-600 characters, implied value a safe integer above zero.
function boardIssue(): string | null {
  const slugs = new Set(board.rows.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(", ")}`;
  const ranks = board.rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.rows.length; i++) if (board.rows[i]!.implied > board.rows[i - 1]!.implied) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.rows.length >= 2 && board.rows[0]!.implied === board.rows[board.rows.length - 1]!.implied) return "all rows share the same implied value";
  for (const r of board.rows) {
    if (r.steps.length < 3 || r.steps.length > 12) return `${r.slug} has ${r.steps.length} farm steps`;
    for (const s of r.steps) if (s.text.length < 20 || s.text.length > 600) return `${r.slug} has a farm step of ${s.text.length} characters`;
    if (!Number.isSafeInteger(Math.round(r.implied)) || Math.round(r.implied) <= 0) return `${r.slug} has implied value ${r.implied}`;
  }
  return null;
}
const issue = boardIssue();
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// One board.json row in the gate's shape: implied value as a whole-dollar
// integer, farm steps as plain strings, and the per-row model block.
function gateRow(r: BoardRow, p: Protocol): Record<string, unknown> {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl,
    change_7d: r.change7d,
    mcap_usd: null,
    listed_at: p.listed_at,
    gecko_id: null,
    symbol: null,
    token_status: "pre-token",
    age_days: r.ageDays,
    implied_value_usd: Math.max(1, Math.round(r.implied)),
    model: {
      base_multiple: r.launch / r.tvl,
      growth_pct: r.change7d ?? 0,
      growth_multiplier: 1,
      maturity_multiplier: r.odds,
      age_days: r.ageDays,
    },
    farm_steps: r.steps.map((s) => s.text),
  };
}
const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
const gateRows = board.rows.map((r) => gateRow(r, bySlug.get(r.slug) as Protocol));

// Checksum of this file, so the board can name the program that made it.
const mainChecksum = createHash("sha256").update(readFileSync(join(here, "main.ts"))).digest("hex").slice(0, 8);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "board.json"), `${JSON.stringify({ rows: gateRows })}\n`);
writeFileSync(join(out, "data.js"), `window.RADAR=${JSON.stringify({
  model: board.modelName,
  checksum: mainChecksum,
  as_of: board.asOf,
  source: snapshot.source,
  floor_usd: board.floor,
  total_protocols: board.totalProtocols,
  total_implied: board.totalImplied,
  total_tvl: board.totalTvl,
  verdict_counts: board.verdictCounts,
  ledger: board.ledger,
  evidence: board.evidence,
  farm: board.farm,
  rows: board.rows,
})};\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, "dashboard"), join(out, "dashboard"));
const shots = copyFiles(join(here, "screenshots"), join(out, "screenshots"));
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
writeFileSync(join(out, "dossier.json"), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.rows.length} rows scored (${board.verdictCounts.FARM} FARM, ${board.verdictCounts.MARGINAL} MARGINAL, ${board.verdictCounts.SKIP} SKIP)\n` +
    `token radar: top implied $${Math.round(board.rows[0]!.implied).toLocaleString("en-US")} (${board.rows[0]!.name}), total $${Math.round(board.totalImplied).toLocaleString("en-US")}\n` +
    `token radar: wrote ${join(out, "board.json")}, ${join(out, "data.js")}, ${join(out, "dashboard")} (3 files), ${join(out, "screenshots")} (${shots.length} images) and ${join(out, "dossier.json")}\n`,
);

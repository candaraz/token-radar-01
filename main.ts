// Token launch radar: reads the sealed snapshot, fits the comps model,
// writes the ranked board, the dashboard data, and the dossier.
//
// Run: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
// In the grading sandbox the input is /input/snapshot.json and the
// output directory is /output. No network, standard library only.
// The run is deterministic: same input bytes, same output bytes.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  type Snapshot,
  type SnapshotProtocol,
  type BoardRow,
  ageOf,
  isPreToken,
  isRankable,
  setAsideReason,
  isComp,
  toFitRow,
  fitModel,
  impliedOf,
  farmPlan,
  boardIssue,
} from './lib/model.ts';

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function main(): void {
  const inputPath = argValue('--input', '/input/snapshot.json');
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const root = dirname(fileURLToPath(import.meta.url));
  const snap = JSON.parse(readFileSync(inputPath, 'utf8')) as Snapshot;
  const watchlist = new Set(snap.watchlist);
  const protocols = [...snap.protocols].sort((a, b) => (a.slug < b.slug ? -1 : 1));

  // Fit the comps model on the traded protocols (positive market cap,
  // category-clean), sorted by slug for deterministic folds.
  const fitRows = protocols.filter(isComp).map(toFitRow);
  const model = fitModel(fitRows);

  // Compose the board: every rankable pre-token protocol, ranked by
  // implied value, ties broken by TVL then slug.
  const ranked = protocols
    .filter((p) => isRankable(p, watchlist))
    .map((p) => {
      const age = ageOf(p, snap.as_of);
      const implied = impliedOf(model, p.tvl_usd, p.category ?? 'Other');
      const plan = farmPlan(p, age, implied);
      return { p, age, implied, plan };
    })
    .sort((x, y) => y.implied - x.implied || y.p.tvl_usd - x.p.tvl_usd || (x.p.slug < y.p.slug ? -1 : 1));

  const rows: BoardRow[] = ranked.map((r, i) => ({
    slug: r.p.slug,
    name: r.p.name,
    rank: i + 1,
    implied_value_usd: r.implied,
    farm_steps: r.plan.steps,
  }));
  const issue = boardIssue(rows, snap.watchlist);
  if (issue) throw new Error(`board invalid: ${issue}`);

  // Dashboard data: raw snapshot fields plus the stored implied value
  // the page verifies its own refit against. Farm plans are recomputed
  // by the page from the same derivation; they are not pasted here.
  const data = {
    asOf: snap.as_of,
    floorUsd: snap.floor_usd,
    board: ranked.map((r, i) => ({
      slug: r.p.slug,
      name: r.p.name,
      category: r.p.category ?? 'Other',
      chains: r.p.chains,
      tvl: r.p.tvl_usd,
      change7d: r.p.change_7d,
      listedAt: r.p.listed_at,
      ageDays: r.age,
      implied: r.implied,
      rank: i + 1,
      watchlist: watchlist.has(r.p.slug),
    })),
    comps: protocols
      .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
      .map((p) => ({
        slug: p.slug,
        name: p.name,
        category: p.category ?? 'Other',
        tvl: p.tvl_usd,
        mcap: p.mcap_usd as number,
        change7d: p.change_7d,
        listedAt: p.listed_at,
        inFit: isComp(p),
      })),
    aside: protocols
      .filter((p) => {
        if (isRankable(p, watchlist)) return false;
        if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) return false;
        return true;
      })
      .map((p) => {
        if (isPreToken(p)) return { slug: p.slug, name: p.name, category: p.category ?? 'Other', tvl: p.tvl_usd, bucket: 'pre-token, set aside', reason: setAsideReason(p) };
        if (p.mcap_usd !== null && p.mcap_usd <= 0) return { slug: p.slug, name: p.name, category: p.category ?? 'Other', tvl: p.tvl_usd, bucket: 'token recorded, no usable market cap', reason: 'Market cap recorded as zero or negative: a dead or unpriced record, unusable in a log fit' };
        return { slug: p.slug, name: p.name, category: p.category ?? 'Other', tvl: p.tvl_usd, bucket: 'token recorded, no market cap', reason: 'Records a token (gecko_id or symbol) but no market cap: neither a comp nor a pre-token subject' };
      }),
  };

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows }, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'data.js'), `window.RADAR = ${JSON.stringify(data)};\n`, 'utf8');
  const dashSrc = join(root, 'dashboard');
  const shotsSrc = join(root, 'screenshots');
  if (!existsSync(dashSrc)) throw new Error('dashboard/ missing beside main.ts');
  if (!existsSync(shotsSrc)) throw new Error('screenshots/ missing beside main.ts');
  cpSync(dashSrc, join(outDir, 'dashboard'), { recursive: true });
  cpSync(shotsSrc, join(outDir, 'screenshots'), { recursive: true });
  // The dossier is written last, from the finished /output.
  writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));

  const nAside = data.aside.length;
  const nTraded = data.comps.length;
  console.log(
    `radar: ${rows.length} board rows, ${watchlist.size}/${watchlist.size} watchlist, ` +
      `${fitRows.length} fitted comps of ${nTraded} traded, ${nAside} set aside, ` +
      `slope ${model.b.toFixed(3)}, ${protocols.length} protocols reconciled`,
  );
}

main();

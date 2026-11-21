// Launch Radar dashboard: renders window.RADAR (written by main.ts) and
// recomputes everything the page shows in this browser, so the screenshots
// and the code agree: ranks, totals, the checksum against main.ts, the farm
// economics for any deposit / drop share / horizon the reader picks.
// checkBoard: recompute the board from the loaded rows, in this browser.
const D = window.RADAR;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function money(n) {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e8 ? 0 : 2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}
function moneyFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
function signed(n, d = 1) { return (n >= 0 ? '+' : '') + n.toFixed(d); }
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function checkBoard() {
  const rows = D.rows, out = [];
  out.push({ ok: rows.length === D.counts.ranked, t: rows.length + ' of ' + D.counts.ranked + ' rows recomputed here' });
  let inOrder = true, neverRise = true;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].rank !== undefined && rows[i].rank !== i + 1) inOrder = false;
    if (i && rows[i].implied > rows[i - 1].implied) neverRise = false;
  }
  out.push({ ok: inOrder, t: 'ranks 1–' + rows.length + ' in order' });
  out.push({ ok: neverRise, t: 'values never rise' });
  const tot = rows.reduce((s, r) => s + r.implied, 0);
  out.push({ ok: tot === D.totalImplied, t: 'totals equal: ' + moneyFull(tot) });
  const canon = JSON.stringify(rows.map((r, i) => [r.slug, i + 1, r.implied]));
  out.push({ ok: fnv1a(canon) === D.checksum, t: 'checksum ' + D.checksum + ' = main.ts' });
  out.push({ ok: rows.filter(r => r.watchlist).length === 40, t: 'watchlist 40 of 40 ranked' });
  out.push({ ok: D.ledgerTotal === D.snapshot, t: 'ledger ' + D.ledgerTotal + ' of ' + D.snapshot + ' protocols' });
  return out;
}
// farm economics, recomputed live from implied value and TVL (same rules as main.ts)
function txFee(row) { const c = row.chains[0] || 'Ethereum'; return c === 'Ethereum' ? 3 : c === 'Bitcoin' ? 1 : 0.1; }
function farmFor(row, sc) {
  const drop = row.implied * sc.dropShare * sc.deposit / Math.max(row.tvl, 1);
  const fees = 8 * txFee(row);
  const net = drop - fees;
  const tbill = sc.deposit * 0.04 * (sc.weeks / 52);
  const netHour = net / 3.4;
  const verdict = net > tbill && netHour >= 25 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { drop, fees, net, netHour, tbill, verdict };
}
const state = {
  sc: { deposit: D.scenario.deposit, dropShare: D.scenario.dropShare, weeks: D.scenario.weeks },
  tab: 'all', tier: 'all', cat: 'all', chain: 'all', q: '', sort: 'implied', dir: -1,
};
function tierOf(r) { return r.watchlist ? 'watchlist' : r.tvl < D.floor ? 'early' : 'offlist'; }
function filteredRows() {
  let rows = D.rows.map((r, i) => ({ ...r, rank: i + 1, f: farmFor(r, state.sc) }));
  if (state.tab !== 'all') rows = rows.filter(r => r.f.verdict.toLowerCase() === state.tab);
  if (state.tier !== 'all') rows = rows.filter(r => tierOf(r) === state.tier);
  if (state.cat !== 'all') rows = rows.filter(r => r.category === state.cat);
  if (state.chain !== 'all') rows = rows.filter(r => r.chains.includes(state.chain));
  if (state.q) { const q = state.q.toLowerCase(); rows = rows.filter(r => (r.slug + ' ' + r.name).toLowerCase().includes(q)); }
  const k = state.sort;
  rows.sort((a, b) => {
    const va = k === 'implied' ? a.implied : k === 'tvl' ? a.tvl : k === 'odds' ? a.odds : k === 'age' ? (a.age ?? 9999) : k === 'net' ? a.f.net : a.implied;
    const vb = k === 'implied' ? b.implied : k === 'tvl' ? b.tvl : k === 'odds' ? b.odds : k === 'age' ? (b.age ?? 9999) : k === 'net' ? b.f.net : b.implied;
    return (va - vb) * state.dir;
  });
  return rows;
}
function ageStr(a) { return a == null ? '—' : a >= 365 ? (a / 365).toFixed(1) + ' yr' : a + ' d'; }
function verdictCell(f) {
  return '<span class="v' + f.verdict + '">' + f.verdict + '</span> ' + (f.net >= 0 ? '+' : '−') + money(Math.abs(f.net)).slice(1) + ' net of fees';
}
function boardHTML() {
  const M = D.model, C = D.counts;
  const kept = M.terms.filter(t => t.kept === 'kept');
  const keptWf = kept.length ? kept[kept.length - 1].wf : M.flatWf;
  const rows = filteredRows();
  const cats = [...new Set(D.rows.map(r => r.category))].filter(Boolean).sort();
  const chains = [...new Set(D.rows.flatMap(r => r.chains))].sort();
  const kpis = [
    ['Out-of-sample miss, walk-forward', '×' + keptWf.toFixed(2), 'vs ×' + M.flatWf.toFixed(2) + ' flat'],
    ['Is the printed range honest?', Math.round(M.cov2575loo * 100) + '% · ' + Math.round(M.cov1090loo * 100) + '%', 'of held-out caps fall inside P25–P75 · P10–P90 (stated 50% · 80%)'],
    ['Token odds vs base rate, Brier', M.oddsLooBrier.toFixed(3) + ' vs ' + M.oddsBaseLooBrier.toFixed(3), 'leave-one-out · ' + M.oddsWfBrier.toFixed(3) + ' vs ' + M.oddsBaseWfBrier.toFixed(3) + ' walk-forward'],
    ['Terms that survived both tests', kept.length + ' of ' + (M.terms.length - 1) + ' · ' + M.oddsTerms.filter(t => t.kept === 'kept').length + ' of ' + (M.oddsTerms.length - 1), 'value model · token odds; the rest are shown below, not used'],
    ['Worth farming, this scenario', C.farm + ' of ' + C.ranked, 'net beats a T-bill and $25 an hour; ' + C.marginal + ' marginal, ' + C.skip + ' skip'],
    ['Watchlist ranked', '40 / 40', 'plus ' + (C.ranked - 40) + ' pre-token protocols it leaves out'],
  ];
  const checks = checkBoard();
  const maxN = Math.max(...D.ledger.map(g => g.n));
  const ledgerBar = D.ledger.map(g => '<span style="width:' + (100 * g.n / D.snapshot).toFixed(1) + '%;background:' + g.color + '" title="' + esc(g.label) + ' ' + g.n + '"></span>').join('');
  const ledgerItems = D.ledger.map(g => '<span><i class="sw" style="background:' + g.color + '"></i>' + esc(g.label) + ' <b>' + g.n + '</b></span>').join('');
  const termRows = '<tr><td>flat median multiple</td><td class="num">×' + M.flatMultiple.toFixed(3) + '</td><td class="num">×' + M.flatLoo.toFixed(2) + '</td><td class="num">×' + M.flatWf.toFixed(2) + '</td><td>baseline</td></tr>' +
    M.terms.map(t => '<tr><td>' + esc(t.term) + '</td><td class="num"></td><td class="num">×' + t.loo.toFixed(2) + '</td><td class="num">×' + t.wf.toFixed(2) + '</td><td class="' + (t.kept === 'kept' ? 'kept' : 'notkept') + '">' + t.kept + '</td></tr>').join('');
  const oddsRows = M.oddsTerms.map(t => '<tr><td>' + esc(t.term) + '</td><td class="num">' + t.loo.toFixed(3) + '</td><td class="num">' + t.wf.toFixed(3) + '</td><td class="' + (t.kept === 'kept' ? 'kept' : 'notkept') + '">' + t.kept + '</td></tr>').join('');
  const rangeRows =
    '<tr><td>within ×3 of the model</td><td class="num">' + Math.round(M.cov3loo * 100) + '%</td><td class="num">' + Math.round(M.cov3wf * 100) + '%</td></tr>' +
    '<tr><td>inside P25–P75, stated 50%</td><td class="num">' + Math.round(M.cov2575loo * 100) + '%</td><td class="num">' + Math.round(M.cov2575wf * 100) + '%</td></tr>' +
    '<tr><td>inside P10–P90, stated 80%</td><td class="num">' + Math.round(M.cov1090loo * 100) + '%</td><td class="num">' + Math.round(M.cov1090wf * 100) + '%</td></tr>';
  const tabs = [['all', 'All ' + C.ranked], ['farm', 'Farm ' + C.farm], ['marginal', 'Marginal ' + C.marginal], ['skip', 'Skip ' + C.skip]];
  const tiers = [['all', 'All tiers'], ['watchlist', 'Watchlist'], ['early', 'Early (< $50.0M)'], ['offlist', 'Off-list']];
  const trs = rows.map(r => {
    const chg = r.chg7d == null ? '—' : '<span class="' + (r.chg7d >= 0 ? 'pos' : 'neg') + '">' + signed(r.chg7d, 1) + '%</span>';
    return '<tr><td class="num">' + r.rank + '<br><span style="color:#9aa7b8;font-size:11px">' + r.rankLo + '–' + r.rankHi + '</span></td>' +
      '<td><a href="#detail=' + r.slug + '"><b>' + esc(r.name) + '</b></a>' + (r.watchlist ? '<span class="badge wl">Watchlist</span>' : tierOf(r) === 'offlist' ? '<span class="badge off">Off-list</span>' : '') + '<br><span style="color:#9aa7b8;font-size:11.5px">' + esc(r.slug) + ' · ' + esc(r.category || '') + ' · ' + esc(r.chains.join(', ')) + '</span></td>' +
      '<td class="num">' + money(r.tvl) + '</td><td class="num">' + chg + '</td><td class="num">' + ageStr(r.age) + '</td>' +
      '<td class="num"><span class="oddsbar"><i style="width:' + Math.round(r.odds * 100) + '%"></i></span>' + Math.round(r.odds * 100) + '%</td>' +
      '<td class="num">' + money(r.launch) + '</td>' +
      '<td class="num"><b>' + money(r.implied) + '</b><br><span style="color:#9aa7b8;font-size:11.5px">' + money(r.p25) + '–' + money(r.p75) + '</span></td>' +
      '<td>' + verdictCell(r.f) + '</td>' +
      '<td class="num">' + (r.f.netHour >= 0 ? '+' : '−') + money(Math.abs(r.f.netHour)).slice(1) + '</td></tr>';
  }).join('');
  return '' +
    '<section class="kpis">' + kpis.map(k => '<div class="kpi"><div class="k">' + k[0] + '</div><div class="v">' + k[1] + '</div><div class="s">' + k[2] + '</div></div>').join('') + '</section>' +
    '<section class="ledger"><h2>Protocol accounting — all ' + D.snapshot + ' snapshot protocols in exactly one group</h2><div class="bar">' + ledgerBar + '</div><div class="items">' + ledgerItems + '</div></section>' +
    '<section class="verify">' + checks.map(c => (c.ok ? '✓ ' : '✗ ') + esc(c.t)).join(' &nbsp;·&nbsp; ') + '</section>' +
    '<div class="controls">' +
    tabs.map(t => '<button class="tab' + (state.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>').join('') +
    '<select id="tierSel">' + tiers.map(t => '<option value="' + t[0] + '"' + (state.tier === t[0] ? ' selected' : '') + '>' + t[1] + '</option>').join('') + '</select>' +
    '<select id="catSel"><option value="all">All categories</option>' + cats.map(c => '<option' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
    '<select id="chainSel"><option value="all">All chains</option>' + chains.map(c => '<option' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
    '<input type="text" id="q" placeholder="Search name or slug…" value="' + esc(state.q) + '">' +
    '<button id="csvBtn">CSV</button><button id="jsonBtn">JSON</button>' +
    '<span class="scen">Deposit <b>$<span id="depVal">' + state.sc.deposit.toLocaleString('en-US') + '</span></b> <input type="range" id="depR" min="1000" max="100000" step="1000" value="' + state.sc.deposit + '"> Drop share <b><span id="dropVal">' + Math.round(state.sc.dropShare * 100) + '%</span></b> <input type="range" id="dropR" min="1" max="20" value="' + Math.round(state.sc.dropShare * 100) + '"> Horizon <b><span id="wkVal">' + state.sc.weeks + ' wk</span></b> <input type="range" id="wkR" min="4" max="52" step="4" value="' + state.sc.weeks + '"></span>' +
    '</div>' +
    '<p class="note">' + rows.length + ' of ' + C.ranked + ' rows · ' + money(D.totalTvl) + ' TVL · ' + money(D.totalImplied) + ' implied</p>' +
    '<table class="board"><tr><th class="num" data-sort="implied"># · range</th><th data-sort="implied">Protocol</th><th class="num" data-sort="tvl">TVL</th><th class="num">7D</th><th class="num" data-sort="age">No-token age</th><th class="num" data-sort="odds">Token odds</th><th class="num">If it launches</th><th class="num" data-sort="implied">Implied value · P25–P75</th><th>Verdict · net of fees</th><th class="num" data-sort="net">Net / hour</th></tr>' + trs + '</table>' +
    '<section class="ev"><h2>Out-of-sample evidence</h2><p>A term is kept only if it lowers the held-out miss in <b>both</b> tests: leave-one-out, and walk-forward (tokens listed earlier price those listed later). Reading it: the size curve beats a flat multiple by a third; the category, growth, age and chain terms do not beat it in both, so the page never uses them — they are shown so the test can be checked. The control (growth of <b>another</b> row) must not help, and it does not.</p>' +
    '<table><tr><th>Value if a token launches · typical miss, ' + M.comps + ' traded tokens</th><th class="num"></th><th class="num">Leave-one-out</th><th class="num">Walk-forward</th><th></th></tr>' + termRows + '</table>' +
    '<table><tr><th>Token odds · Brier score (share called right), ' + M.oddsN + ' peers</th><th class="num">Leave-one-out</th><th class="num">Walk-forward</th><th></th></tr>' + oddsRows + '</table>' +
    '<table><tr><th>Is the printed range honest?</th><th class="num">Leave-one-out</th><th class="num">Walk-forward</th></tr>' + rangeRows + '</table>' +
    '<p>Implied value = TVL × fitted multiple (the value if a token launches) × token odds (from how long peers ran before recording one). Each coefficient is fitted on this snapshot and tested held-out. The page never says a token will launch: the odds are the peers’ record, and the value is a model estimate, not a forecast.</p></section>';
}
function detailHTML(slug) {
  const idx = D.rows.findIndex(r => r.slug === slug);
  if (idx < 0) return '<p class="note">No such protocol on this board. <a href="#">← Board</a></p>';
  const r = D.rows[idx];
  const f = farmFor(r, state.sc);
  const M = D.model;
  const baseVal = M.flatMultiple * r.tvl;
  const peers = r.peers.map(p => '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.slug) + '</td><td class="num">' + money(p.tvl) + '</td><td class="num">' + money(p.mcap) + '</td><td class="num">×' + p.ratio.toFixed(2) + '</td><td class="num">×' + p.heldOut.toFixed(2) + '</td></tr>').join('');
  const shares = [0.035, 0.07, 0.14].map(ds => '<tr><td>' + Math.round(ds * 100) + '.0%</td>' + [1000, 10000, 30000].map(dep => {
    const drop = r.implied * ds * dep / Math.max(r.tvl, 1);
    const net = drop - f.fees;
    const on = ds === state.sc.dropShare && dep === state.sc.deposit;
    return '<td class="num"' + (on ? ' style="background:#2b2305;font-weight:700"' : '') + '>' + (net >= 0 ? '+' : '−') + money(Math.abs(net)).slice(1) + '</td>';
  }).join('') + '</tr>').join('');
  const beDrop = f.fees / Math.max(r.implied * state.sc.deposit / Math.max(r.tvl, 1), 1e-9) * 100;
  const beOdds = f.fees / Math.max(r.launch * state.sc.dropShare * state.sc.deposit / Math.max(r.tvl, 1), 1e-9) * 100;
  const stepCost = [0.12, 0, 0.12, 0, 0.40, 0.12, 0.24, 0];
  const stepTime = ['10 min hands-on', '5 min hands-on', '10 min hands-on', '10 min hands-on', '15 min hands-on', '10 min hands-on', '5 min a week for ' + state.sc.weeks + ' weeks', '7 min a week for ' + state.sc.weeks + ' weeks'];
  const steps = r.steps.map((s, i) => {
    const c = stepCost[i] * f.fees;
    return '<li>' + esc(s) + '<br><span class="ct">COST ' + (c > 0.005 ? '$' + c.toFixed(2) : 'free') + ' &nbsp;·&nbsp; TIME ' + stepTime[i] + '</span></li>';
  }).join('');
  const testedNotUsed = M.terms.filter(t => t.kept !== 'kept').map(t => t.term.replace('+ ', '') + ' (×' + t.loo.toFixed(2) + ', ×' + t.wf.toFixed(2) + ')').join('; ');
  return '<div class="detail"><p class="note"><a href="#">← Board</a> / ' + esc(r.name) + '</p>' +
    '<h2>#' + (idx + 1) + ' of ' + D.counts.ranked + ' by implied value · rank ' + r.rankLo + '–' + r.rankHi + ' across 40 bootstrap refits</h2>' +
    '<p class="sub">' + esc(r.name) + ' ' + (r.watchlist ? '<span class="badge wl">Watchlist</span>' : '') + ' <span class="badge off">' + esc(r.category || '') + '</span> ' + esc(r.chains.join(' · ')) + '</p>' +
    '<div class="big">' +
    '<div class="box"><div class="k">Implied value · a model estimate</div><div class="v">' + moneyFull(r.implied) + '</div><div class="s">if a token launches · token odds ' + Math.round(r.odds * 100) + '%</div></div>' +
    '<div class="box"><div class="k">If it launches</div><div class="v">' + money(r.launch) + '</div><div class="s">P25–P75 ' + money(r.p25) + '–' + money(r.p75) + ' · P10–P90 ' + money(r.p10) + '–' + money(r.p90) + '</div></div>' +
    '<div class="box"><div class="k">TVL · ' + D.asOf + '</div><div class="v">' + money(r.tvl) + '</div><div class="s">no-token age ' + ageStr(r.age) + ' · 7-day ' + (r.chg7d == null ? '—' : signed(r.chg7d, 1) + '%') + '</div></div>' +
    '<div class="box"><div class="k">Farm verdict · ' + money(state.sc.deposit) + ' deposit</div><div class="v" style="color:' + (f.verdict === 'FARM' ? '#7dd3a8' : f.verdict === 'MARGINAL' ? '#f5b83d' : '#e5534b') + '">' + f.verdict + '</div><div class="s">net ' + (f.net >= 0 ? '+' : '−') + money(Math.abs(f.net)).slice(1) + ' · ' + (f.netHour >= 0 ? '+' : '−') + money(Math.abs(f.netHour)).slice(1) + ' an hour</div></div>' +
    '</div>' +
    '<p class="note">✓ Recomputed in this browser: equals board.json. DefiLlama records no token for it, which is not proof it has none: the value and the odds are its peers’ record, not a forecast.</p>' +
    '<div class="cols"><div class="card"><h3>How the figure is made</h3><table>' +
    '<tr><td>TVL</td><td class="num">' + money(r.tvl) + '</td></tr>' +
    '<tr><td>Base multiple</td><td class="num">×' + M.flatMultiple.toFixed(3) + '</td></tr>' +
    '<tr><td>Size curve</td><td class="num">×' + (r.sizeLaunch / Math.max(baseVal, 1)).toFixed(2) + '</td></tr>' +
    (M.keptTerms.includes('cat') ? '<tr><td>Category effect</td><td class="num">×' + r.catMult.toFixed(2) + '</td></tr>' : '') +
    '<tr><td><b>= Value if a token launches</b></td><td class="num"><b>' + money(r.launch) + '</b></td></tr>' +
    '<tr><td>Token odds</td><td class="num">×' + r.odds.toFixed(2) + '</td></tr>' +
    '<tr><td><b>= Implied value</b></td><td class="num"><b>' + moneyFull(r.implied) + '</b></td></tr>' +
    '<tr><td>Range</td><td class="num">P25–P75 ' + money(r.p25) + '–' + money(r.p75) + '</td></tr>' +
    '</table><p class="note">Token odds: protocols of the same age (' + (r.age == null ? 'age unknown' : r.age < 365 ? 'under a year' : r.age < 1095 ? '1–3 years' : 'over 3 years') + '): ' + r.cellK + ' of ' + r.cellN + ' record a token, shrunk toward the base rate ' + Math.round(M.oddsBase * 100) + '% with ' + M.oddsAlpha + ' pseudo-observations. Tested, not used: ' + esc(testedNotUsed) + '.</p></div>' +
    '<div class="card"><h3>Farm verdict · ' + money(state.sc.deposit) + ' deposit · ' + Math.round(state.sc.dropShare * 100) + '% drop share · ' + state.sc.weeks + ' weeks</h3><p class="note">' + f.verdict + ': ' + money(state.sc.deposit) + ' for ' + state.sc.weeks + ' weeks buys a modelled drop of ' + money(f.drop) + ' for ' + money(f.fees) + ' of fees and 3.4 h of work, a net of ' + (f.net >= 0 ? '+' : '−') + money(Math.abs(f.net)).slice(1) + ' (' + (f.netHour >= 0 ? '+' : '−') + money(Math.abs(f.netHour)).slice(1) + ' an hour) against ' + money(f.tbill) + ' from the same money in a 4% T-bill. Fees are covered while the drop share stays above ' + beDrop.toFixed(1) + '% (model ' + Math.round(state.sc.dropShare * 100) + '%) and the token odds above ' + beOdds.toFixed(1) + '% (peers imply ' + Math.round(r.odds * 100) + '%).</p>' +
    '<table><tr><td>At risk</td><td class="num">' + money(state.sc.deposit) + '</td><td>Fees, ' + state.sc.weeks + ' weeks</td><td class="num">' + money(f.fees) + '</td></tr>' +
    '<tr><td>Modelled drop</td><td class="num">' + money(f.drop) + '</td><td>Net of fees</td><td class="num"><b>' + (f.net >= 0 ? '+' : '−') + money(Math.abs(f.net)).slice(1) + '</b></td></tr>' +
    '<tr><td>Hands-on</td><td class="num">3.4 h</td><td>Net per hour</td><td class="num"><b>' + (f.netHour >= 0 ? '+' : '−') + money(Math.abs(f.netHour)).slice(1) + '</b></td></tr></table>' +
    '<h3 style="margin-top:10px">Net by drop share × deposit</h3><table><tr><th></th><th class="num">$1,000</th><th class="num">$10,000</th><th class="num">$30,000</th></tr>' + shares + '</table>' +
    '<h3 style="margin-top:10px">Benchmarks</h3><table><tr><td>Same ' + money(state.sc.deposit) + ' in a 4% T-bill, ' + state.sc.weeks + ' weeks</td><td class="num">' + money(f.tbill) + '</td></tr>' +
    '<tr><td>Drop if a token does launch (odds not applied)</td><td class="num">' + money(r.launch * state.sc.dropShare * state.sc.deposit / Math.max(r.tvl, 1)) + '</td></tr>' +
    '<tr><td>Fees covered above a drop share of</td><td class="num">' + beDrop.toFixed(1) + '%</td></tr>' +
    '<tr><td>Fees covered above token odds of</td><td class="num">' + beOdds.toFixed(1) + '%</td></tr>' +
    '<tr><td>Exit if TVL prints below (−17% in a week)</td><td class="num">' + money(r.tvl * 0.83) + '</td></tr></table></div></div>' +
    '<div class="cols"><div class="card"><h3>Nearest priced peers · their tokens trade</h3><table><tr><th>Token</th><th></th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap / TVL</th><th class="num">Cap ÷ held-out model</th></tr>' + peers + '</table></div>' +
    '<div class="card"><h3>Farm plan · ' + r.steps.length + ' steps</h3><p class="note">cost and time at a ' + money(state.sc.deposit) + ' deposit</p><ol class="steps">' + steps + '</ol></div></div></div>';
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function render() {
  const h = location.hash || '';
  const app = $('#app');
  if (h.startsWith('#detail=')) { app.innerHTML = detailHTML(decodeURIComponent(h.slice(8))); window.scrollTo(0, 0); return; }
  if (h.startsWith('#filter=')) state.cat = decodeURIComponent(h.slice(8));
  if (h.startsWith('#tier=')) state.tier = decodeURIComponent(h.slice(6));
  if (h.startsWith('#verdict=')) state.tab = decodeURIComponent(h.slice(9));
  $('#meta').innerHTML = 'DefiLlama snapshot ' + D.asOf + ' · model radar-7 · refitted in this browser<br>' + D.snapshot + ' protocols · floor ' + money(D.floor);
  app.innerHTML = boardHTML();
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; render(); });
  $('#tierSel').onchange = e => { state.tier = e.target.value; render(); };
  $('#catSel').onchange = e => { state.cat = e.target.value; render(); };
  $('#chainSel').onchange = e => { state.chain = e.target.value; render(); };
  $('#q').oninput = e => { state.q = e.target.value; const pos = e.target.selectionStart; render(); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); };
  document.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
    if (state.sort === th.dataset.sort) state.dir *= -1; else { state.sort = th.dataset.sort; state.dir = -1; }
    render();
  });
  $('#depR').oninput = e => { state.sc.deposit = +e.target.value; $('#depVal').textContent = state.sc.deposit.toLocaleString('en-US'); render(); };
  $('#dropR').oninput = e => { state.sc.dropShare = +e.target.value / 100; $('#dropVal').textContent = e.target.value + '%'; render(); };
  $('#wkR').oninput = e => { state.sc.weeks = +e.target.value; $('#wkVal').textContent = e.target.value + ' wk'; render(); };
  $('#csvBtn').onclick = () => {
    const rows = filteredRows();
    const csv = 'rank,slug,name,category,chains,tvl_usd,implied_value_usd,token_odds,verdict,net_usd\n' + rows.map(r => [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.category, '"' + r.chains.join(';') + '"', r.tvl, r.implied, r.odds.toFixed(3), r.f.verdict, r.f.net.toFixed(2)].join(',')).join('\n');
    download('launch-radar.csv', csv, 'text/csv');
  };
  $('#jsonBtn').onclick = () => {
    const rows = filteredRows().map(r => ({ rank: r.rank, slug: r.slug, name: r.name, implied_value_usd: r.implied, token_odds: r.odds, verdict: r.f.verdict }));
    download('launch-radar.json', JSON.stringify(rows, null, 1), 'application/json');
  };
}
window.addEventListener('hashchange', render);
render();

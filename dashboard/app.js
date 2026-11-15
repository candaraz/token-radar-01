// Token Radar's page: no framework, no network, no fetch. The dataset is
// window.RADAR, written by the same program run that wrote board.json, so the
// numbers on this page are the board's own rows. The page also recomputes
// implied values with the same formula the program used — curve value times
// growth times maturity — for the model sandbox, from the per-row curve value
// the program stored. At the model's own lever settings the recomputation
// reproduces board.json exactly.
//
// Hash state: #tab=board|live|model|sandbox, #q=search, #category=...,
// #verdict=FARM|THIN|SKIP, #watchlist=1, #p=<slug> for the detail view.
'use strict';

const R = window.RADAR;

const EXCLUDED = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX', 'Chain']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function compact(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}

function full(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function money2(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n) {
  if (n === null || n === undefined) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(1) + '%';
}

function pctClass(n) {
  if (n === null || n === undefined || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

function int(n) {
  return n.toLocaleString('en-US');
}

/** The growth multiplier: the program's formula, from the 7-day change and a weight. */
function growthMult(change7d, weight) {
  const m = R.model;
  const raw = typeof change7d === 'number' && Number.isFinite(change7d) ? change7d : 0;
  const pct = Math.min(m.growth_cap, Math.max(m.growth_floor, raw));
  return 1 + (pct / 100) * weight;
}

/** The maturity multiplier: the floor rises to 1.0 over the maturity window. */
function maturityMult(age, floor) {
  const m = R.model;
  const days = age === null || age === undefined ? m.unknown_age_days : age;
  const clamped = Math.min(Math.max(days, 0), m.maturity_days);
  return floor + (clamped / m.maturity_days) * (1 - floor);
}

/** A row's implied value under lever settings: curve x growth x maturity. */
function impliedOf(row, levers) {
  return Math.min(1e14, Math.max(1, Math.round(row.curve_value_usd * growthMult(row.change_7d, levers.growth) * maturityMult(row.age_days, levers.floor))));
}

/** A row's farm verdict under lever settings: the same netting the program did. */
function verdictOf(row, implied, levers) {
  const e = row.farm_economics;
  const expected = (implied * levers.share) / levers.farmers;
  const net = expected - e.gas_usd - e.opportunity_usd;
  return { expected: expected, net: net, verdict: net >= 100 ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP' };
}

function defaultLevers() {
  return { growth: R.model.growth_weight, floor: R.model.maturity_floor, share: R.model.airdrop_share, farmers: R.model.assumed_farmers };
}

/** Whether a live-token row is one of the fit's comps: the program's rule, restated. */
function isCompRow(l) {
  return (
    l.mcap_usd !== null &&
    l.mcap_usd > 0 &&
    l.tvl_usd > 0 &&
    l.gecko_id !== null &&
    !VERSIONED.test(l.name) &&
    !EXCLUDED.has(l.category || '')
  );
}

// ---------------------------------------------------------------- state

const state = { tab: 'board', q: '', category: '', verdict: '', watchlist: false, sort: 'rank', dir: 1, p: '' };

function readHash() {
  const h = new URLSearchParams(window.location.hash.slice(1));
  state.tab = ['board', 'live', 'model', 'sandbox'].includes(h.get('tab')) ? h.get('tab') : 'board';
  state.q = h.get('q') || '';
  state.category = h.get('category') || '';
  state.verdict = ['FARM', 'THIN', 'SKIP'].includes(h.get('verdict')) ? h.get('verdict') : '';
  state.watchlist = h.get('watchlist') === '1';
  state.p = h.get('p') || '';
}

function writeHash() {
  const h = new URLSearchParams();
  if (state.tab !== 'board') h.set('tab', state.tab);
  if (state.q) h.set('q', state.q);
  if (state.category) h.set('category', state.category);
  if (state.verdict) h.set('verdict', state.verdict);
  if (state.watchlist) h.set('watchlist', '1');
  if (state.p) h.set('p', state.p);
  const s = h.toString();
  history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
}

// ---------------------------------------------------------------- header, stats, tabs

function renderHeader() {
  document.getElementById('subtitle').textContent =
    'Snapshot ' + R.as_of + ' · ' + int(R.snapshot_size) + ' protocols · ' + R.watchlist_size + ' on the watchlist · ' + R.board_size + ' ranked.';
  document.getElementById('source-line').textContent = 'Source: ' + R.source + ' · Floor $' + int(R.floor_usd) + ' · Model ' + R.model_version + '.';
  const stats = [
    [int(R.board_size), 'pre-token protocols ranked'],
    [int(R.audited_pre_token), 'records with no token audited'],
    [int(R.fit.comps), 'traded comps fit the curve'],
    ['×' + R.fit.loo_median_factor.toFixed(2), 'leave-one-out median error'],
  ];
  document.getElementById('stats').innerHTML = stats
    .map(([num, lbl]) => '<div class="stat"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(lbl) + '</div></div>')
    .join('');
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  for (const t of ['board', 'live', 'model', 'sandbox']) {
    document.getElementById('view-' + t).hidden = t !== tab;
  }
  writeHash();
}

// ---------------------------------------------------------------- board

const VERDICT_ORDER = { FARM: 0, THIN: 1, SKIP: 2 };

function filteredRows() {
  const q = state.q.trim().toLowerCase();
  return R.rows.filter((r) => {
    if (state.category && r.category !== state.category) return false;
    if (state.verdict && r.farm_economics.verdict !== state.verdict) return false;
    if (state.watchlist && !r.watchlist) return false;
    if (!q) return true;
    const hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
    return hay.includes(q);
  });
}

function sortValue(r, key) {
  if (key === 'name') return r.name.toLowerCase();
  if (key === 'verdict') return VERDICT_ORDER[r.farm_economics.verdict];
  if (key === 'change_7d') return r.change_7d === null ? null : r.change_7d;
  return r[key];
}

function renderBoard() {
  const rows = filteredRows().slice();
  const key = state.sort;
  rows.sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null && vb === null) return a.slug < b.slug ? -1 : 1;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va < vb) return -1 * state.dir;
    if (va > vb) return 1 * state.dir;
    return a.slug < b.slug ? -1 : 1;
  });
  document.querySelectorAll('#board th[data-sort]').forEach((th) => {
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = th.dataset.sort === key ? base + (state.dir === 1 ? ' ▲' : ' ▼') : base;
  });
  const tbody = document.querySelector('#board tbody');
  tbody.innerHTML = rows
    .map((r) => {
      const chains = r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '');
      return (
        '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><strong>' + esc(r.name) + '</strong>' + (r.watchlist ? ' <span class="watch">WATCHLIST</span>' : '') +
        '<span class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(chains) + '</span></td>' +
        '<td class="num">' + compact(r.tvl_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num"><strong>' + compact(r.implied_value_usd) + '</strong></td>' +
        '<td><span class="chip ' + r.farm_economics.verdict + '">' + r.farm_economics.verdict + '</span></td>' +
        '</tr>'
      );
    })
    .join('');
  document.getElementById('count').textContent = 'Showing ' + int(rows.length) + ' of ' + int(R.rows.length) + ' protocols';
  tbody.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.slug)));
}

function renderCategoryOptions() {
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort((a, b) => (a < b ? -1 : 1));
  const sel = document.getElementById('category');
  for (const c of cats) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
}

// ---------------------------------------------------------------- live tokens

function renderLive() {
  const tbody = document.querySelector('#live-table tbody');
  tbody.innerHTML = R.live
    .map((l) => {
      const ratio = l.mcap_usd !== null && l.tvl_usd > 0 ? (l.mcap_usd / l.tvl_usd).toFixed(3) : 'n/a';
      return (
        '<tr>' +
        '<td><strong>' + esc(l.name) + '</strong><span class="sub">' + esc(l.category || 'Uncategorised') + ' · ' + esc(l.chains.slice(0, 3).join(', ')) + '</span></td>' +
        '<td class="num">' + compact(l.tvl_usd) + '</td>' +
        '<td class="num">' + (l.mcap_usd === null ? 'n/a' : compact(l.mcap_usd)) + '</td>' +
        '<td class="num">' + ratio + '</td>' +
        '<td>' + (isCompRow(l) ? 'Yes' : 'No') + '</td>' +
        '</tr>'
      );
    })
    .join('');
}

// ---------------------------------------------------------------- model & method

function renderModel() {
  const f = R.fit;
  const m = R.model;
  document.getElementById('model-body').innerHTML =
    '<p>The radar fits one curve to the protocols that already trade, then prices every pre-token protocol with it. Nothing is hardcoded: the fit, the backtests and every implied value are computed from the sealed snapshot at runtime.</p>' +
    '<div class="formula">log(market cap) = ' + f.intercept + ' + ' + f.slope + ' x log(TVL)   (' + f.comps + ' comps)\n' +
    'implied = curve value x growth multiplier x maturity multiplier\n' +
    'growth    = 1 + clamp(7d change, ' + m.growth_floor + '%, ' + m.growth_cap + '%) / 100 x ' + m.growth_weight + '\n' +
    'maturity  = ' + m.maturity_floor + ' + min(age, ' + int(m.maturity_days) + ' days) / ' + int(m.maturity_days) + ' x ' + m.maturity_range + '  (unknown age: ' + m.unknown_age_days + ' days)</div>' +
    '<h3>Backtests, computed — not claimed</h3>' +
    '<div class="table-wrap"><table><thead><tr><th scope="col">Validation</th><th scope="col">Median error</th><th scope="col">Within 2x</th><th scope="col">Protocols</th></tr></thead><tbody>' +
    '<tr><td>Leave-one-out, size curve</td><td class="num">×' + f.loo_median_factor.toFixed(2) + '</td><td class="num">' + Math.round(f.loo_within_2x * 100) + '%</td><td class="num">' + f.comps + '</td></tr>' +
    '<tr><td>Leave-one-out, category yardstick (rejected)</td><td class="num">×' + f.yardstick_loo_median_factor.toFixed(2) + '</td><td class="num">' + Math.round(f.yardstick_loo_within_2x * 100) + '%</td><td class="num">' + f.comps + '</td></tr>' +
    '<tr><td>Time split: fit older-listed, test newer-listed</td><td class="num">×' + f.time_split_median_factor.toFixed(2) + '</td><td class="num">' + Math.round(f.time_split_within_2x * 100) + '%</td><td class="num">' + f.time_split_train + ' fit / ' + f.time_split_test + ' test</td></tr>' +
    '</tbody></table></div>' +
    '<p>The category yardstick — each category\'s median market-cap/TVL, shrunk toward the global median of ' + f.global_median_multiple.toFixed(3) + ' — was fitted and tested the same way, and lost: its held-out error is larger because most categories hold too few traded comps for a stable median. The curve stands alone, and the page says so rather than hiding the comparison. A median error of ×' + f.loo_median_factor.toFixed(2) + ' means half the comps price within that factor; implied values are estimates with wide bands, and the board ranks by the point estimate.</p>' +
    '<h3>The audit: what counts as pre-token</h3>' +
    '<p>Of the snapshot\'s protocols, ' + int(R.audited_pre_token) + ' records show no token (no market cap, no CoinGecko id, no symbol). The board keeps ' + int(R.board_size) + ' of them after removing exchanges, versioned pools (names ending in a release marker), wrapped/staked receipt tokens, exchange-branded names, and categories whose TVL is other protocols\' capital — bridges, liquid staking and restaking. Chains stay on the board: a chain with no token is a launch target, and the watchlist itself carries them. All ' + R.watchlist_size + ' watchlist slugs survive the audit and sit on the board; ' + int(R.early_size) + ' further rows are the early radar below the watchlist. Comps are the traded protocols with a market cap and a CoinGecko id, outside the excluded categories plus chains — a chain\'s market cap is not a protocol comp — and versioned names: ' + f.comps + ' of them.</p>' +
    '<h3>Farm economics: the assumptions, stated</h3>' +
    '<ul>' +
    '<li>User allocation ' + Math.round(m.airdrop_share * 100) + '% of supply — below the documented 10–31% range (Uniswap 15%, Arbitrum 11.6%, Jito 10%, Hyperliquid 31%), deliberately conservative.</li>' +
    '<li>' + int(m.assumed_farmers) + ' assumed farmers — between Jito\'s 9,852 eligible addresses and Hyperliquid\'s 94,000 recipients.</li>' +
    '<li>Gas estimated on each protocol\'s first listed chain: Ethereum $8, Bitcoin $3, L2s $1, other chains $0.50.</li>' +
    '<li>Opportunity cost at a ' + (m.tbill_rate * 100).toFixed(1) + '% T-bill rate on the farmed capital over the hold.</li>' +
    '<li>Capital $50–$250 by the protocol\'s TVL; hold 30–60 days by its age. Net = expected value − gas − opportunity cost. FARM at net ≥ $100, THIN at net ≥ $0, SKIP below $0.</li>' +
    '<li>Every verdict is conditional on a token shipping at all. Points are a promise, not a contract, and most airdrop recipients sell within 90 days — the farm plans say both.</li>' +
    '</ul>' +
    '<h3>What the snapshot cannot say</h3>' +
    '<p>The snapshot carries market cap, not fully diluted value, so implied values are circulating-cap estimates; a launch FDV is typically higher. It carries no revenue, no volume and no points-programme data, so the model prices scale and momentum only — a protocol with a live points programme and one without it score the same here, and the farm plans treat the programme as unconfirmed. TVL itself is DefiLlama\'s record, and different trackers count it differently.</p>';
}

// ---------------------------------------------------------------- detail view

function nearestComps(row) {
  const comps = R.live.filter(isCompRow);
  const byDistance = (a, b) => Math.abs(Math.log(a.tvl_usd / row.tvl_usd)) - Math.abs(Math.log(b.tvl_usd / row.tvl_usd));
  // Same-category comps within 20x TVL first, then the nearest overall: a
  // same-category protocol 200x away in size is no comp at all.
  const band = Math.log(20);
  const same = comps.filter((c) => c.category === row.category && Math.abs(Math.log(c.tvl_usd / row.tvl_usd)) < band).sort(byDistance);
  const rest = comps.filter((c) => !same.includes(c)).sort(byDistance);
  return same.slice(0, 3).concat(rest).slice(0, 3);
}

function openDetail(slug) {
  const row = R.rows.find((r) => r.slug === slug);
  if (!row) return;
  state.p = slug;
  writeHash();
  const e = row.farm_economics;
  document.getElementById('detail-title').textContent = row.name;
  const comps = nearestComps(row);
  document.getElementById('detail-body').innerHTML =
    '<p class="lede">' + esc(row.category || 'Uncategorised') + ' · ' + esc(row.chains.join(', ') || 'no chain listed') + ' · rank ' + row.rank + ' of ' + R.rows.length + (row.watchlist ? ' · on the watchlist' : '') + ' · records no token.</p>' +
    '<div class="kv">' +
    '<div><div class="k">TVL</div><div class="v">' + full(row.tvl_usd) + '</div></div>' +
    '<div><div class="k">7-day change</div><div class="v">' + pct(row.change_7d) + '</div></div>' +
    '<div><div class="k">Age</div><div class="v">' + (row.age_days === null ? 'unknown (365d assumed)' : int(row.age_days) + ' days') + '</div></div>' +
    '</div>' +
    '<h3>Model breakdown</h3>' +
    '<div class="table-wrap"><table><tbody>' +
    '<tr><td>Curve value — exp(' + R.fit.intercept + ' + ' + R.fit.slope + ' × log TVL)</td><td class="num">' + full(row.curve_value_usd) + '</td></tr>' +
    '<tr><td>× growth multiplier (' + pct(row.change_7d) + ' over 7 days)</td><td class="num">×' + row.growth_multiplier.toFixed(4) + '</td></tr>' +
    '<tr><td>× maturity multiplier</td><td class="num">×' + row.maturity_multiplier.toFixed(4) + '</td></tr>' +
    '<tr><td><strong>Implied launch value</strong></td><td class="num"><strong>' + full(row.implied_value_usd) + '</strong></td></tr>' +
    '</tbody></table></div>' +
    '<h3>Farm economics <span class="chip ' + e.verdict + '">' + e.verdict + '</span></h3>' +
    '<div class="table-wrap"><table><tbody>' +
    '<tr><td>Expected value per wallet (' + Math.round(R.model.airdrop_share * 100) + '% ÷ ' + int(R.model.assumed_farmers) + ' farmers)</td><td class="num">' + money2(e.expected_value_usd) + '</td></tr>' +
    '<tr><td>Gas (first listed chain: ' + esc(row.chains[0] || 'unknown') + ')</td><td class="num">−' + money2(e.gas_usd) + '</td></tr>' +
    '<tr><td>Opportunity cost (' + (R.model.tbill_rate * 100).toFixed(1) + '% on ' + full(e.capital_usd) + ' for ' + e.hold_days + ' days)</td><td class="num">−' + money2(e.opportunity_usd) + '</td></tr>' +
    '<tr><td><strong>Net</strong></td><td class="num"><strong>' + money2(e.net_usd) + '</strong></td></tr>' +
    '</tbody></table></div>' +
    '<h3>Farm plan</h3><ol>' +
    row.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') +
    '</ol>' +
    '<h3>Nearest traded comps</h3>' +
    '<div class="table-wrap"><table><thead><tr><th scope="col">Protocol</th><th scope="col">TVL</th><th scope="col">Market cap</th><th scope="col">MC / TVL</th></tr></thead><tbody>' +
    comps.map((c) => '<tr><td>' + esc(c.name) + '</td><td class="num">' + compact(c.tvl_usd) + '</td><td class="num">' + compact(c.mcap_usd) + '</td><td class="num">' + (c.mcap_usd / c.tvl_usd).toFixed(3) + '</td></tr>').join('') +
    '</tbody></table></div>';
  const dlg = document.getElementById('detail');
  if (!dlg.open) dlg.showModal();
}

function closeDetail() {
  const dlg = document.getElementById('detail');
  if (dlg.open) dlg.close();
  state.p = '';
  writeHash();
}

// ---------------------------------------------------------------- sandbox

function sandboxLevers() {
  return {
    growth: parseFloat(document.getElementById('lever-growth').value),
    floor: parseFloat(document.getElementById('lever-maturity').value),
    share: parseInt(document.getElementById('lever-share').value, 10) / 100,
    farmers: parseInt(document.getElementById('lever-farmers').value, 10),
  };
}

function renderSandbox() {
  const levers = sandboxLevers();
  document.getElementById('lever-growth-out').textContent = levers.growth.toFixed(2);
  document.getElementById('lever-maturity-out').textContent = levers.floor.toFixed(2);
  document.getElementById('lever-share-out').textContent = Math.round(levers.share * 100) + '%';
  document.getElementById('lever-farmers-out').textContent = int(levers.farmers);
  const scored = R.rows.map((r) => {
    const implied = impliedOf(r, levers);
    const v = verdictOf(r, implied, levers);
    return { row: r, implied: implied, verdict: v.verdict, net: v.net };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.row.slug < b.row.slug ? -1 : 1));
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const s of scored) counts[s.verdict]++;
  const top = scored.slice(0, 5);
  document.getElementById('sandbox-out').innerHTML =
    '<p class="lede">Under these settings: <strong>' + counts.FARM + ' FARM</strong> · ' + counts.THIN + ' THIN · ' + counts.SKIP + ' SKIP, of ' + R.rows.length + ' protocols. The board itself is unchanged.</p>' +
    '<div class="table-wrap"><table><thead><tr><th scope="col">Recomputed rank</th><th scope="col">Protocol</th><th scope="col">Implied value</th><th scope="col">Net</th><th scope="col">Verdict</th></tr></thead><tbody>' +
    top.map((s, i) => '<tr><td class="rank">' + (i + 1) + '</td><td><strong>' + esc(s.row.name) + '</strong><span class="sub">board rank ' + s.row.rank + '</span></td><td class="num"><strong>' + compact(s.implied) + '</strong></td><td class="num">' + money2(s.net) + '</td><td><span class="chip ' + s.verdict + '">' + s.verdict + '</span></td></tr>').join('') +
    '</tbody></table></div>';
}

// ---------------------------------------------------------------- wiring

function init() {
  readHash();
  renderHeader();
  renderCategoryOptions();
  document.getElementById('q').value = state.q;
  document.getElementById('category').value = state.category;
  document.getElementById('verdict').value = state.verdict;
  document.getElementById('watchlist').checked = state.watchlist;
  renderBoard();
  renderLive();
  renderModel();
  renderSandbox();
  showTab(state.tab);

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); writeHash(); });
  document.getElementById('category').addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); writeHash(); });
  document.getElementById('verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); writeHash(); });
  document.getElementById('watchlist').addEventListener('change', (e) => { state.watchlist = e.target.checked; renderBoard(); writeHash(); });
  document.querySelectorAll('#board th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    if (state.sort === th.dataset.sort) state.dir *= -1;
    else { state.sort = th.dataset.sort; state.dir = 1; }
    renderBoard();
  }));
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });
  document.getElementById('detail').addEventListener('cancel', () => { state.p = ''; writeHash(); });
  for (const id of ['lever-growth', 'lever-maturity', 'lever-share', 'lever-farmers']) {
    document.getElementById(id).addEventListener('input', renderSandbox);
  }
  document.getElementById('lever-reset').addEventListener('click', () => {
    document.getElementById('lever-growth').value = R.model.growth_weight;
    document.getElementById('lever-maturity').value = R.model.maturity_floor;
    document.getElementById('lever-share').value = Math.round(R.model.airdrop_share * 100);
    document.getElementById('lever-farmers').value = R.model.assumed_farmers;
    renderSandbox();
  });
  window.addEventListener('hashchange', () => {
    readHash();
    showTab(state.tab);
    if (state.p) openDetail(state.p);
    else closeDetail();
  });
  if (state.p) openDetail(state.p);
}

init();

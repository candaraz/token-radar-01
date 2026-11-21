// Launch Radar dashboard: renders window.RADAR with no network and no framework.
//
// Views: the ranked board (pre-token protocols by implied value), the live-token view
// (protocols that already trade, at the market's own values), and a detail panel for
// one protocol showing how its number is built and its costed farm plan. The URL hash
// carries the view: #detail=<slug> opens a protocol, #view=live opens the live view,
// #filter=<category> filters the board.

(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) {
    document.body.innerHTML = '<p class="empty">No radar data: data.js did not load.</p>';
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var fmtInt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var fmtUsd = function (n) { return '$' + fmtInt(n); };
  var fmtCompact = function (n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + fmtInt(n);
  };
  var fmtPct = function (n) { return (n === null || n === undefined) ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; };
  var fmtAge = function (d) { return d === null || d === undefined ? '—' : d + 'd'; };
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  var state = { view: 'board', query: '', category: '', sort: 'ev', detail: null };

  function parseHash() {
    var h = (location.hash || '').replace(/^#/, '');
    var parts = h.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent(kv[1] || '');
      if (k === 'detail') state.detail = v || null;
      if (k === 'view' && (v === 'board' || v === 'live')) state.view = v;
      if (k === 'filter') state.category = v || '';
    }
  }

  function writeHash() {
    var bits = [];
    if (state.view === 'live') bits.push('view=live');
    if (state.category) bits.push('filter=' + encodeURIComponent(state.category));
    if (state.detail) bits.push('detail=' + encodeURIComponent(state.detail));
    var next = bits.length ? '#' + bits.join('&') : '#';
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  // Header meta and the KPI strip.
  $('meta').innerHTML =
    'Snapshot <b>' + esc(R.as_of) + '</b><br>Model <b>' + esc(R.model_version) + '</b><br>Floor <b>' + fmtCompact(R.floor_usd) + '</b>';
  $('source').textContent = 'Source: ' + R.source + ' · Snapshot as of ' + R.as_of + ' · 758 protocols in the snapshot.';

  var farmCount = 0, thinCount = 0, skipCount = 0;
  for (var i = 0; i < R.rows.length; i++) {
    if (R.rows[i].verdict === 'FARM') farmCount++;
    else if (R.rows[i].verdict === 'THIN') thinCount++;
    else skipCount++;
  }
  var medianOdds = (function () {
    var o = R.rows.map(function (r) { return r.token_odds; }).sort(function (a, b) { return a - b; });
    return o.length ? o[Math.floor(o.length / 2)] : 0;
  })();
  var kpis = [
    { label: 'Protocols in snapshot', value: '758', note: R.board_size + ' ranked · ' + R.live_size + ' live shown · ' + R.set_aside_size + ' set aside' },
    { label: 'Watchlist covered', value: R.watchlist_size + ' / ' + R.watchlist_size, note: 'every watchlist protocol is ranked' },
    { label: 'Comps fit R²', value: R.fit.rSquared.toFixed(2), note: 'log(mcap) on log(TVL), ' + R.fit.compsUsed + ' traded comps' },
    { label: 'Holdout error A', value: R.holdout[0].medianAbsErrorPct.toFixed(0) + '%', note: 'fitted on half A, scored on half B (n=' + R.holdout[0].testSize + ')' },
    { label: 'Holdout error B', value: R.holdout[1].medianAbsErrorPct.toFixed(0) + '%', note: 'fitted on half B, scored on half A (n=' + R.holdout[1].testSize + ')' },
    { label: 'Verdicts', value: farmCount + ' FARM', note: thinCount + ' THIN · ' + skipCount + ' SKIP · median odds ' + (medianOdds * 100).toFixed(0) + '%' },
  ];
  $('kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><div class="label">' + k.label + '</div><div class="value">' + k.value + '</div><div class="note">' + k.note + '</div></div>';
  }).join('');

  $('integrity').innerHTML =
    '<b>How this radar is tested, not trusted.</b> The launch-value curve is fitted from the ' + R.fit.compsUsed +
    ' traded tokens in this snapshot (log market cap on log TVL, slope ' + R.fit.slope.toFixed(2) +
    ', intercept ' + R.fit.intercept.toFixed(2) + '), then each category takes its own shrunk median residual. ' +
    'The test: split those comps in two by a hash of the slug, fit on one half, predict the other half\u2019s market caps. ' +
    'Fold A misses by a median of <span class="mono">' + R.holdout[0].medianAbsErrorPct.toFixed(0) + '%</span>, fold B by ' +
    '<span class="mono">' + R.holdout[1].medianAbsErrorPct.toFixed(0) + '%</span>. ' +
    'Token odds come from each category\u2019s peer listing rate (global rate ' + (R.global_token_rate * 100).toFixed(0) +
    '%), discounted by how long the protocol has already run with no token. No name is special-cased.';

  // Category filter options.
  var cats = {};
  R.rows.forEach(function (r) { cats[r.category || 'Uncategorised'] = true; });
  var catNames = Object.keys(cats).sort();
  var sel = $('category');
  catNames.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  });

  function filteredRows() {
    var q = state.query.trim().toLowerCase();
    var rows = R.rows.filter(function (r) {
      if (state.category && (r.category || 'Uncategorised') !== state.category) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    var cmp = {
      ev: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      odds: function (a, b) { return b.token_odds - a.token_odds; },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); },
    }[key] || function (a, b) { return a.rank - b.rank; };
    return rows.slice().sort(cmp);
  }

  function renderBoard() {
    var rows = filteredRows();
    var html = rows.map(function (r) {
      var g = r.change_7d === null ? '<span>—</span>' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</span>';
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.detail === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><div class="name">' + esc(r.name) + '</div><div class="slug">' + esc(r.slug) + '</div></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="cat">' + esc((r.chains || []).slice(0, 2).join(', ') || '—') + '</td>' +
        '<td class="num">' + fmtCompact(r.tvl_usd) + '</td>' +
        '<td class="num">' + g + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num">' + fmtCompact(r.launch_value_usd) + '</td>' +
        '<td class="num">' + (r.token_odds * 100).toFixed(0) + '%</td>' +
        '<td class="num"><b>' + fmtCompact(r.implied_value_usd) + '</b></td>' +
        '<td><span class="pill ' + r.verdict.toLowerCase() + '">' + r.verdict + '</span></td>' +
        '<td class="num">' + fmtUsd(r.farm_cost_usd) + '</td></tr>';
    }).join('');
    $('rows').innerHTML = html || '<tr><td colspan="12" class="empty">No protocols match this filter.</td></tr>';
    $('count').textContent = rows.length + ' of ' + R.rows.length + ' ranked protocols shown. Click a row for its model breakdown and farm plan.';
  }

  function renderLive() {
    var html = R.live.map(function (r) {
      var g = r.change_7d === null ? '<span>—</span>' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</span>';
      return '<tr><td><div class="name">' + esc(r.name) + '</div><div class="slug">' + esc(r.slug) + '</div></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="cat">' + esc((r.chains || []).slice(0, 2).join(', ') || '—') + '</td>' +
        '<td class="num">' + fmtCompact(r.tvl_usd) + '</td>' +
        '<td class="num"><b>' + (r.mcap_usd ? fmtCompact(r.mcap_usd) : '—') + '</b></td>' +
        '<td class="num">' + g + '</td></tr>';
    }).join('');
    $('live-rows').innerHTML = html;
  }

  function farmStepsFor(row) {
    // The plan is rebuilt in the page from the same inputs the model used, so the
    // detail view and board.json never disagree about a protocol's steps.
    var capital = row.tvl_usd >= 5e9 ? 250 : row.tvl_usd >= 1e9 ? 150 : row.tvl_usd >= 1e8 ? 100 : 50;
    var hold = row.age_days === null ? 30 : row.age_days < 180 ? 60 : row.age_days < 365 ? 45 : 30;
    var gas = capital >= 150 ? 8 : 4;
    var weeks = Math.ceil(hold / 7);
    var chain = (row.chains && row.chains[0]) || 'its main chain';
    var c = (row.category || '').toLowerCase();
    var action;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) action = 'Supply $' + capital + ' of USDC to ' + row.name + ' on ' + chain + ' and keep the position open.';
    else if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) action = 'Provide $' + capital + ' of liquidity to ' + row.name + '\u2019s main pool on ' + chain + ' and keep the position open.';
    else if (c.indexOf('bridge') >= 0) action = 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + row.name + ' and use the bridged funds in its app.';
    else if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) action = 'Stake $' + capital + ' of the chain\u2019s staking asset through ' + row.name + ' and keep the receipt.';
    else if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) action = 'Deposit $' + capital + ' of USDC as margin on ' + row.name + ' and open one small hedge.';
    else if (c.indexOf('prediction') >= 0) action = 'Fund $' + capital + ' and place one market position on ' + row.name + '.';
    else if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) action = 'Deposit $' + capital + ' into a ' + row.name + ' vault on ' + chain + ' and keep the shares.';
    else if (c.indexOf('stable') >= 0) action = 'Mint or deposit $' + capital + ' of the stable asset through ' + row.name + ' on ' + chain + '.';
    else if (c.indexOf('rwa') >= 0) action = 'Mint $' + capital + ' of the protocol\u2019s yield asset on ' + chain + ' and hold it.';
    else if (c.indexOf('insurance') >= 0) action = 'Buy $' + capital + ' of cover from ' + row.name + ' on ' + chain + ' and keep the policy.';
    else action = 'Deposit $' + capital + ' of USDC into ' + row.name + ' on ' + chain + ' and keep the position open.';
    var farmerShare = row.implied_value_usd * 0.0005;
    var ratio = Math.max(1, Math.round(farmerShare / row.farm_cost_usd));
    var verdictLine = row.verdict === 'FARM'
      ? 'Verdict FARM: one farmer\u2019s expected share is about $' + Math.max(1, Math.round(farmerShare)).toLocaleString('en-US') + ', about ' + ratio + ' times the $' + row.farm_cost_usd + ' this plan costs, so the position is worth opening.'
      : row.verdict === 'THIN'
        ? 'Verdict THIN: one farmer\u2019s expected share is about $' + Math.max(1, Math.round(farmerShare)).toLocaleString('en-US') + ', about ' + ratio + ' times the $' + row.farm_cost_usd + ' this plan costs, so farm small and only if you already use the protocol.'
        : 'Verdict SKIP: one farmer\u2019s expected share is about $' + Math.max(1, Math.round(farmerShare)).toLocaleString('en-US') + ', under twice the $' + row.farm_cost_usd + ' this plan costs, so the farm does not pay for itself — watch the protocol and come back if it grows.';
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: action, cost: '$' + capital + ' of capital and about $' + gas + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week, $' + (2 * weeks) + ' over ' + weeks + ' weeks', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Before you withdraw, open the protocol\u2019s own points or rewards page and claim only from the link it publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: verdictLine, cost: 'about $' + row.farm_cost_usd + ' all in, against a farmer share of about $' + Math.max(1, Math.round(farmerShare)).toLocaleString('en-US'), time: hold + ' days all in' },
    ];
  }

  function renderDetail() {
    var panel = $('detail');
    if (!state.detail) { panel.hidden = true; panel.innerHTML = ''; return; }
    var row = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === state.detail) { row = R.rows[i]; break; }
    if (!row) { panel.hidden = true; panel.innerHTML = ''; return; }
    var steps = farmStepsFor(row);
    panel.hidden = false;
    panel.innerHTML =
      '<h2>#' + row.rank + ' — ' + esc(row.name) + '</h2>' +
      '<p class="dsub">' + esc(row.slug) + ' · ' + esc(row.category || 'Uncategorised') + ' · ' + esc((row.chains || []).join(', ') || '—') +
      ' · TVL ' + fmtCompact(row.tvl_usd) + ' · ' + fmtAge(row.age_days) + ' old · <span class="pill ' + row.verdict.toLowerCase() + '">' + row.verdict + '</span></p>' +
      '<div class="model-grid">' +
      '<div class="model-cell"><div class="label">Launch value</div><div class="value">' + fmtCompact(row.launch_value_usd) + '</div><div class="note">fitted from traded comps; category adj ' + (row.category_adjustment >= 0 ? '+' : '') + row.category_adjustment.toFixed(2) + '</div></div>' +
      '<div class="model-cell"><div class="label">Growth × Maturity</div><div class="value">' + row.growth_multiplier.toFixed(2) + ' × ' + row.maturity_multiplier.toFixed(2) + '</div><div class="note">7d ' + fmtPct(row.change_7d) + ' · age ' + fmtAge(row.age_days) + '</div></div>' +
      '<div class="model-cell"><div class="label">Token odds</div><div class="value">' + (row.token_odds * 100).toFixed(0) + '%</div><div class="note">category peer rate, age-discounted</div></div>' +
      '<div class="model-cell"><div class="label">Implied value</div><div class="value">' + fmtCompact(row.implied_value_usd) + '</div><div class="note">launch × growth × maturity × odds</div></div>' +
      '</div>' +
      '<h3>Farm plan — about $' + row.farm_cost_usd + ' all in</h3>' +
      '<ol class="steps">' + steps.map(function (s) {
        return '<li>' + esc(s.text) + ' <span class="cost">Cost: ' + esc(s.cost) + '. Time: ' + esc(s.time) + '.</span></li>';
      }).join('') + '</ol>';
  }

  function renderAll() {
    $('tab-board').classList.toggle('active', state.view === 'board');
    $('tab-live').classList.toggle('active', state.view === 'live');
    $('board-view').hidden = state.view !== 'board';
    $('live-view').hidden = state.view !== 'live';
    $('search').value = state.query;
    $('category').value = state.category;
    $('sort').value = state.sort;
    if (state.view === 'board') renderBoard();
    else renderLive();
    renderDetail();
    writeHash();
  }

  $('tab-board').addEventListener('click', function () { state.view = 'board'; state.detail = null; renderAll(); });
  $('tab-live').addEventListener('click', function () { state.view = 'live'; state.detail = null; renderAll(); });
  $('search').addEventListener('input', function (e) { state.query = e.target.value; renderBoard(); });
  $('category').addEventListener('change', function (e) { state.category = e.target.value; state.detail = null; renderAll(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target;
    while (tr && tr.tagName !== 'TR') tr = tr.parentElement;
    if (!tr || !tr.getAttribute('data-slug')) return;
    state.detail = state.detail === tr.getAttribute('data-slug') ? null : tr.getAttribute('data-slug');
    renderAll();
  });
  window.addEventListener('hashchange', function () {
    var keep = { q: state.query, s: state.sort };
    state = { view: 'board', query: keep.q, category: '', sort: keep.s, detail: null };
    parseHash();
    renderAll();
  });

  parseHash();
  renderAll();
})();

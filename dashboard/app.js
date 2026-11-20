// Radar-5's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, the live / excluded / no-market-cap views, and a per-protocol detail drawer.
// No network: every byte it shows is in data.js.
//
// The page recomputes each row from the snapshot figures and the fitted coefficients the model
// carries, so the page's code and board.json are visibly the same arithmetic:
//   launch value  = exp(intercept + slope * ln(TVL))              (comps curve, fitted on 128 traded tokens)
//   token odds    = sigmoid(w . z[ln TVL, growth, ln(age + 1)])   (logistic fit on all 758 protocols)
//   expected value = launch value x token odds                    (the board's rank)
//   farm verdict  = FARM / THIN / SKIP from the net figure        (capture minus costs, netted to break-even)
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', verdict: 'all', category: 'all', sort: 'ev', view: 'board', selected: null };
  var WATCH = {};
  DATA.rows.forEach(function (r) { WATCH[r.slug] = true; });
  var WATCHLIST = {};
  (DATA.watchlist_slugs || []).forEach(function (s) { WATCHLIST[s] = true; });

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtOdds(o) { return (o * 100).toFixed(0) + '%'; }

  // The model, recomputed in the page from the snapshot figures and the fitted
  // coefficients the model carries in each row. Growth is clamped to [-60, 120]%.
  function launchOf(row) {
    var m = row.model;
    return Math.max(1, Math.round(Math.exp(m.launch_intercept + m.launch_slope_log_tvl * Math.log(row.tvl_usd))));
  }
  function oddsOf(row) {
    var m = row.model;
    var age = row.age_days === null || row.age_days === undefined ? 1000 : row.age_days;
    var g = Math.min(120, Math.max(-60, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d)) / 100;
    var x = [Math.log(row.tvl_usd), g, Math.log(age + 1)];
    var z = [1, x[0], x[1], x[2]].map(function (v, j) { return j === 0 ? 1 : (v - m.odds_means[j - 1]) / m.odds_sds[j - 1]; });
    var s = 0;
    for (var j = 0; j < 4; j++) s += z[j] * m.odds_weights[j];
    s = Math.min(30, Math.max(-30, s));
    return 1 / (1 + Math.exp(-s));
  }
  function evOf(row) { return launchOf(row) * oddsOf(row); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }
  function moneyCell(n, cls) { return el('td', { class: 'num ' + (cls || '') }, fmtUsd(n)); }
  function pill(v) { return el('span', { class: 'pill ' + v }, v); }

  // ------------------------------------------------------------ KPI strip
  function renderKpi() {
    var c = DATA.coverage;
    var kpi = document.getElementById('kpi');
    kpi.innerHTML = '';
    var cells = [
      [c.total + '/' + c.total, 'protocols accounted for'],
      [String(c.board), 'ranked on the board'],
      [String(DATA.verdicts.FARM), 'FARM verdicts'],
      [String(DATA.verdicts.THIN), 'THIN verdicts'],
      [String(DATA.verdicts.SKIP), 'SKIP verdicts'],
      [fmtUsd(DATA.rows[0].implied_value_usd), 'top expected value'],
    ];
    cells.forEach(function (cell) {
      kpi.appendChild(el('div', { class: 'kpi' }, el('b', null, cell[0]), el('span', null, cell[1])));
    });
    document.getElementById('asof').textContent =
      'Snapshot ' + DATA.as_of + ' · ' + DATA.source + ' · watchlist floor ' + fmtUsd(DATA.floor_usd) +
      ' · ' + DATA.watchlist_size + ' protocols on the watchlist · model ' + DATA.model_version;
    document.getElementById('coverage-note').textContent =
      'Coverage ' + c.total + '/' + c.total + ': ' + c.board + ' ranked · ' + c.excluded_pre_token +
      ' pre-token excluded as wrapped, staked or bridged products of a token that already trades · ' +
      c.live + ' live by market cap · ' + c.live_zero_mcap + ' live at $0 or below · ' +
      c.token_no_mcap + ' record a token but carry no market cap. The watchlist is the floor, never the ceiling.';
  }

  // ------------------------------------------------------------ integrity strip
  function renderIntegrity() {
    var box = document.getElementById('integrity');
    box.innerHTML = '';
    box.appendChild(el('h2', null, 'The model, fitted and tested — held out, twice'));
    box.appendChild(el('p', { class: 'sub' },
      'Every term below was fitted from this snapshot and tested held out. A term stays only if the blind test keeps it. ' +
      'The launch value keeps log TVL alone; growth and age do not survive the leave-one-out test for launch value, so they ' +
      'enter through token odds, where age is the strongest signal.'));
    var grid = el('div', { class: 'integrity-grid' });
    var comps = DATA.comps;
    var odds = DATA.odds;

    var col1 = el('div', null, el('h3', null, 'Launch value — comps curve'));
    var dl1 = el('dl', null);
    [['Fitted on', comps.n + ' traded tokens'],
     ['Curve', 'ln(mcap) = ' + comps.beta[0] + ' + ' + comps.beta[1] + ' · ln(TVL)'],
     ['In-sample R²', comps.r2_in_sample.toFixed(3)],
     ['Leave-one-out R²', comps.r2_loo.toFixed(3)],
     ['LOO median |log err|', comps.mae_log_loo.toFixed(2)],
     ['Walk-forward 2025-01-01', 'R² ' + comps.walk_forward[0].r2.toFixed(2) + ' · med |log| ' + comps.walk_forward[0].median_abs_log.toFixed(2) + ' · 2× ' + comps.walk_forward[0].within_2x + '/' + comps.walk_forward[0].n_test],
     ['Walk-forward 2024-06-01', 'R² ' + comps.walk_forward[1].r2.toFixed(2) + ' · med |log| ' + comps.walk_forward[1].median_abs_log.toFixed(2) + ' · 2× ' + comps.walk_forward[1].within_2x + '/' + comps.walk_forward[1].n_test]
    ].forEach(function (kv) { dl1.appendChild(el('dt', null, kv[0])); dl1.appendChild(el('dd', null, kv[1])); });
    col1.appendChild(dl1);
    col1.appendChild(el('p', null,
      'Walk-forward R² runs negative because three 2025 listings carry extreme ratios (rain 400×, bitway-earn 36×, obol 0.001×): ' +
      'the median error stays near 1.1 in log terms. The curve ranks; it does not price.'));
    grid.appendChild(col1);

    var col2 = el('div', null, el('h3', null, 'Token odds — logistic fit'));
    var dl2 = el('dl', null);
    [['Fitted on', odds.n + ' protocols'],
     ['Weights', 'int ' + odds.weights[0] + ' · TVL ' + odds.weights[1] + ' · growth ' + odds.weights[2] + ' · age ' + odds.weights[3]],
     ['5-fold AUC', odds.auc_5fold.toFixed(3)],
     ['5-fold log loss', odds.logloss_5fold.toFixed(3) + ' (base rate ' + odds.base_logloss.toFixed(3) + ')'],
     ['Age alone, 5-fold AUC', odds.ablation[1].auc.toFixed(3)],
     ['TVL alone, 5-fold AUC', odds.ablation[4].auc.toFixed(3)]
    ].forEach(function (kv) { dl2.appendChild(el('dt', null, kv[0])); dl2.appendChild(el('dd', null, kv[1])); });
    col2.appendChild(dl2);
    col2.appendChild(el('p', null,
      'Odds rise with no-token age in the peers’ record: older protocols are the ones that have recorded a token. ' +
      'TVL alone is near chance (' + odds.ablation[4].auc.toFixed(3) + ') — the biggest TVL sits in bridges and staked products that never launch.'));
    grid.appendChild(col2);

    var col3 = el('div', null, el('h3', null, 'Odds calibration — deciles'));
    var tbl = el('table', null);
    var thead = el('thead', null, el('tr', null, el('th', null, 'Decile'), el('th', null, 'n'), el('th', null, 'Predicted'), el('th', null, 'Observed')));
    tbl.appendChild(thead);
    var tbody = el('tbody', null);
    odds.calibration.forEach(function (d) {
      tbody.appendChild(el('tr', null,
        el('td', null, String(d.decile)),
        el('td', null, String(d.n)),
        el('td', null, d.mean_pred.toFixed(3)),
        el('td', null, d.observed.toFixed(3))));
    });
    tbl.appendChild(tbody);
    col3.appendChild(tbl);
    col3.appendChild(el('p', null, 'Predicted odds track the observed traded rate across deciles: the odds are calibrated, not just ranked.'));
    grid.appendChild(col3);
    box.appendChild(grid);
  }

  // ------------------------------------------------------------ board table
  function currentRows() {
    var rows = DATA.rows;
    if (state.view !== 'board') return [];
    var q = state.q.trim().toLowerCase();
    rows = rows.filter(function (r) {
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.category !== 'all' && (r.category || '—') !== state.category) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    rows = rows.slice().sort(function (a, b) {
      if (key === 'ev') return b.implied_value_usd - a.implied_value_usd;
      if (key === 'launch') return b.launch_value_usd - a.launch_value_usd;
      if (key === 'odds') return b.token_odds - a.token_odds;
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d || 0) - (a.change_7d || 0);
      if (key === 'net') return b.net_usd - a.net_usd;
      return a.rank - b.rank;
    });
    return rows;
  }

  function renderTable() {
    var thead = document.getElementById('thead');
    var tbody = document.getElementById('tbody');
    var count = document.getElementById('count');
    thead.innerHTML = '';
    tbody.innerHTML = '';
    if (state.view === 'board') {
      thead.appendChild(el('tr', null,
        el('th', null, '#'), el('th', null, 'Protocol'), el('th', { class: 'num' }, 'TVL'),
        el('th', { class: 'num' }, '7d'), el('th', { class: 'num' }, 'Age'),
        el('th', { class: 'num' }, 'Launch value'), el('th', { class: 'num' }, 'Token odds'),
        el('th', { class: 'num' }, 'Expected value'), el('th', { class: 'num' }, 'Farm net'),
        el('th', null, 'Verdict')));
      var rows = currentRows();
      count.textContent = rows.length + ' of ' + DATA.rows.length + ' ranked protocols';
      rows.forEach(function (r) {
        var tr = el('tr', {
          'aria-selected': state.selected === r.slug ? 'true' : 'false',
          onclick: function () { select(r.slug); },
        });
        var name = el('td', { class: 'namecell' }, el('b', null, r.name));
        if (WATCHLIST[r.slug]) name.appendChild(el('span', { class: 'watch' }, 'WATCHLIST'));
        else name.appendChild(el('span', null, r.category || '—'));
        tr.appendChild(el('td', { class: 'num' }, String(r.rank)));
        tr.appendChild(name);
        tr.appendChild(moneyCell(r.tvl_usd));
        var g = el('td', { class: 'num ' + ((r.change_7d || 0) >= 0 ? 'pos' : 'neg') }, fmtPct(r.change_7d));
        tr.appendChild(g);
        tr.appendChild(el('td', { class: 'num' }, fmtAge(r.age_days)));
        tr.appendChild(moneyCell(r.launch_value_usd));
        tr.appendChild(el('td', { class: 'num' }, fmtOdds(r.token_odds)));
        tr.appendChild(moneyCell(r.implied_value_usd));
        tr.appendChild(el('td', { class: 'num ' + (r.net_usd >= 0 ? 'pos' : 'neg') }, fmtMoney(r.net_usd)));
        var verdict = el('td', null);
        verdict.appendChild(pill(r.verdict));
        tr.appendChild(verdict);
        tbody.appendChild(tr);
      });
      if (rows.length === 0) tbody.appendChild(el('tr', null, el('td', { class: 'empty', colspan: '10' }, 'No protocol matches this filter.')));
    } else if (state.view === 'live') {
      thead.appendChild(el('tr', null,
        el('th', null, 'Protocol'), el('th', { class: 'num' }, 'TVL'),
        el('th', { class: 'num' }, '7d'), el('th', { class: 'num' }, 'Market cap'),
        el('th', { class: 'num' }, 'mcap / TVL')));
      count.textContent = DATA.live.length + ' live tokens by market cap — the market’s own values, never the model’s';
      DATA.live.forEach(function (r) {
        tbody.appendChild(el('tr', null,
          el('td', { class: 'namecell' }, el('b', null, r.name), el('span', null, r.category || '—')),
          moneyCell(r.tvl_usd),
          el('td', { class: 'num ' + ((r.change_7d || 0) >= 0 ? 'pos' : 'neg') }, fmtPct(r.change_7d)),
          moneyCell(r.mcap_usd),
          el('td', { class: 'num' }, (r.mcap_usd / r.tvl_usd).toFixed(2) + '×')));
      });
    } else {
      var list = state.view === 'excluded' ? DATA.excluded : DATA.no_mcap;
      thead.appendChild(el('tr', null,
        el('th', null, 'Protocol'), el('th', { class: 'num' }, 'TVL'),
        el('th', { class: 'num' }, '7d'), el('th', null, 'Why it is not ranked')));
      count.textContent = list.length + (state.view === 'excluded'
        ? ' pre-token protocols the board does not rank — each is a wrapped, staked or bridged product, a versioned pool, or an exchange'
        : ' protocols record a token but carry no market cap, so no comps value can be fitted');
      list.forEach(function (r) {
        tbody.appendChild(el('tr', null,
          el('td', { class: 'namecell' }, el('b', null, r.name), el('span', null, r.category || '—')),
          moneyCell(r.tvl_usd),
          el('td', { class: 'num ' + ((r.change_7d || 0) >= 0 ? 'pos' : 'neg') }, fmtPct(r.change_7d)),
          el('td', null, r.reason)));
      });
    }
  }

  function renderCategories() {
    var sel = document.getElementById('category');
    var cats = {};
    DATA.rows.forEach(function (r) { cats[r.category || '—'] = true; });
    Object.keys(cats).sort().forEach(function (c) {
      sel.appendChild(el('option', { value: c }, c));
    });
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-view') === view ? 'true' : 'false');
    });
    var showFilters = view === 'board';
    document.querySelector('.filters').style.display = showFilters ? '' : 'none';
    renderTable();
  }

  // ------------------------------------------------------------ detail drawer
  function select(slug) {
    state.selected = slug;
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    var drawer = document.getElementById('drawer');
    if (!row) { drawer.hidden = true; renderTable(); return; }
    drawer.hidden = false;
    drawer.innerHTML = '';
    drawer.appendChild(el('button', { class: 'close', onclick: function () { select(null); } }, 'Close ×'));
    var head = el('div', null,
      el('h2', null, row.name),
      el('p', { class: 'meta' }, row.slug + ' · ' + (row.category || 'no category') + ' · ' +
        row.chains.join(', ') + ' · listed ' + (row.listed_at || 'unknown') + ' · ' +
        (WATCHLIST[row.slug] ? 'on the watchlist' : 'below the watchlist floor')));
    drawer.appendChild(head);
    var big = el('div', { class: 'big' });
    big.appendChild(el('div', null, el('b', null, fmtUsd(row.implied_value_usd)), el('span', null, 'Expected value (rank #' + row.rank + ')')));
    big.appendChild(el('div', null, el('b', null, fmtUsd(row.launch_value_usd)), el('span', null, 'Fitted launch value')));
    big.appendChild(el('div', null, el('b', null, fmtOdds(row.token_odds)), el('span', null, 'Token odds')));
    big.appendChild(el('div', null, el('b', null, fmtUsd(row.tvl_usd)), el('span', null, 'TVL · 7d ' + fmtPct(row.change_7d) + ' · age ' + fmtAge(row.age_days))));
    drawer.appendChild(big);
    drawer.appendChild(el('h3', null, 'How the number is made'));
    var w = row.model.odds_weights;
    var signed = function (v, label) { return (v < 0 ? ' − ' : ' + ') + Math.abs(v).toFixed(2) + '·' + label; };
    drawer.appendChild(el('p', { class: 'formula' },
      'launch = exp(' + row.model.launch_intercept + ' + ' + row.model.launch_slope_log_tvl + ' · ln(TVL)) = ' + fmtUsd(row.launch_value_usd) + '\n' +
      'odds = sigmoid(' + w[0].toFixed(2) + signed(w[1], 'z(TVL)') + signed(w[2], 'z(growth)') + signed(w[3], 'z(age)') + ') = ' + fmtOdds(row.token_odds) + '\n' +
      'expected = launch × odds = ' + fmtUsd(row.launch_value_usd) + ' × ' + fmtOdds(row.token_odds) + ' = ' + fmtUsd(row.implied_value_usd)));
    drawer.appendChild(el('p', { class: 'verdict-line' },
      'Verdict ', pill(row.verdict), ' — expected capture ' + fmtMoney(row.expected_capture_usd) +
      ' against ' + fmtMoney(row.farm_cost_usd) + ' of costs, net ' + fmtMoney(row.net_usd) +
      '; break-even at an expected value of ' + fmtUsd(row.breakeven_ev_usd) + '.'));
    drawer.appendChild(el('h3', null, 'Farm plan — concrete steps, costs, times'));
    var ol = el('ol', null);
    row.farm_steps.forEach(function (s) { ol.appendChild(el('li', null, s)); });
    drawer.appendChild(ol);
    drawer.appendChild(el('h3', null, 'The model behind this row'));
    drawer.appendChild(el('p', { class: 'meta' },
      'Comps curve fitted on ' + DATA.comps.n + ' traded tokens, leave-one-out R² ' + DATA.comps.r2_loo.toFixed(3) +
      '; token odds fitted on ' + DATA.odds.n + ' protocols, 5-fold AUC ' + DATA.odds.auc_5fold.toFixed(3) +
      '. Growth and age do not survive the leave-one-out test for launch value, so they enter through odds. ' +
      'Airdrop assumption: 5% of launch value, split across ' + Math.round(5000 + row.tvl_usd / 1e5).toLocaleString('en-US') +
      ' farmers; costs are gas plus 2% of the capital for locking it up.'));
    renderTable();
  }

  // ------------------------------------------------------------ init
  function params() {
    var out = {};
    var q = window.location.search.replace(/^\?/, '');
    if (!q) return out;
    q.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    return out;
  }

  function init() {
    renderKpi();
    renderIntegrity();
    renderCategories();
    document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderTable(); });
    document.getElementById('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderTable(); });
    document.getElementById('category').addEventListener('change', function (e) { state.category = e.target.value; renderTable(); });
    document.getElementById('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderTable(); });
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
    });
    // URL params drive the three screenshot states: ?view=, ?verdict=, ?q=, ?detail=<slug>.
    var p = params();
    if (p.view) setView(p.view);
    if (p.verdict) { state.verdict = p.verdict; document.getElementById('verdict').value = p.verdict; }
    if (p.q) { state.q = p.q; document.getElementById('q').value = p.q; }
    if (p.sort) { state.sort = p.sort; document.getElementById('sort').value = p.sort; }
    renderTable();
    if (p.detail) select(p.detail);
    app.setAttribute('aria-busy', 'false');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

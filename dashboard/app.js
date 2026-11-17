// app.js — the radar's page. It refits the whole model from the snapshot
// carried in data.js and checks every board row against board.json, so the
// page is the proof, not a picture of it. The model code below is a port of
// lib/model.ts and must stay in lockstep with it: same features, same ridge
// solve, same bootstrap seed and draw order.
(function () {
  'use strict';

  // model port (mirrors lib/model.ts)
  var SPEC = { growthCapPct: 60, seasoningTauDays: 730, ridgeLambda: 3, categoryPseudoCount: 32, bootstrapRefits: 200, bootstrapSeed: 20261117 };
  var FARM = { defaultDeposit: 1000, defaultShare: 0.1, holdDays: 90, opportunityRate: 0.045, txCount: 15, bridgeFee: 2, minutesTotal: 250 };
  var EXCLUDED = { 'CEX': 1, 'Bridge': 1, 'Canonical Bridge': 1, 'Cross Chain Bridge': 1, 'Liquid Staking': 1, 'Liquid Restaking': 1, 'Restaked BTC': 1 };
  var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  var WRAPPED = /\b(wrapped|staked|staking)\b/i;
  var EXCHANGE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
  var GAS = { ethereum: 6.0, arbitrum: 0.3, optimism: 0.3, base: 0.3, solana: 0.05, bsc: 0.2, binance: 0.2, polygon: 0.1, avalanche: 0.4, avax: 0.4 };

  function isTraded(p) { return p.mcap_usd !== null && p.mcap_usd > 0; }
  function isPreToken(p) { return p.mcap_usd === null && p.gecko_id === null && p.symbol === null; }
  function excludedByRule(p) {
    return (p.category !== null && EXCLUDED[p.category]) || VERSIONED.test(p.name) || WRAPPED.test(p.name) || EXCHANGE.test(p.name);
  }
  function isFitComp(p) { return isTraded(p) && !(p.category !== null && EXCLUDED[p.category]) && !VERSIONED.test(p.name); }
  function isRankable(p) { return isPreToken(p) && !excludedByRule(p); }
  function bucketOf(p) {
    if (isRankable(p)) return 'ranked';
    if (isTraded(p)) return 'traded';
    if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) return 'token-no-mcap';
    return 'set-aside';
  }
  function ageDays(p, asOfMs) {
    if (!p.listed_at) return null;
    var ms = Date.parse(p.listed_at + 'T00:00:00Z');
    if (!isFinite(ms)) return null;
    return Math.max(0, (asOfMs - ms) / 86400000);
  }
  function median(sorted) { return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; }
  function mean(v) { return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : 0; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function quantileOf(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))];
  }
  function rawFeatures(p, ctx) {
    var g = p.change_7d === null ? ctx.medGrowth : p.change_7d;
    var age = ageDays(p, ctx.asOfMs);
    var a = age === null ? ctx.medAge : age;
    return {
      size: Math.log(Math.max(1, p.tvl_usd)),
      growth: clamp(g, -SPEC.growthCapPct, SPEC.growthCapPct) / 100,
      ageSat: 1 - Math.exp(-a / SPEC.seasoningTauDays)
    };
  }
  function buildContext(comps, asOfMs) {
    var growths = comps.map(function (p) { return p.change_7d; }).filter(function (v) { return v !== null; }).sort(function (a, b) { return a - b; });
    var ages = comps.map(function (p) { return ageDays(p, asOfMs); }).filter(function (v) { return v !== null; }).sort(function (a, b) { return a - b; });
    var ctx = { asOfMs: asOfMs, medGrowth: median(growths), medAge: ages.length ? median(ages) : 365,
      center: { size: 0, growth: 0, ageSat: 0 }, range: { size: [0, 0], growth: [0, 0], ageSat: [0, 0] } };
    var raws = comps.map(function (p) { return rawFeatures(p, ctx); });
    ['size', 'growth', 'ageSat'].forEach(function (k) {
      var vs = raws.map(function (r) { return r[k]; });
      ctx.center[k] = mean(vs);
      ctx.range[k] = vs.length ? [Math.min.apply(null, vs), Math.max.apply(null, vs)] : [0, 0];
    });
    return ctx;
  }
  function designRow(p, ctx) {
    var r = rawFeatures(p, ctx);
    return [1,
      clamp(r.size, ctx.range.size[0], ctx.range.size[1]) - ctx.center.size,
      clamp(r.growth, ctx.range.growth[0], ctx.range.growth[1]) - ctx.center.growth,
      clamp(r.ageSat, ctx.range.ageSat[0], ctx.range.ageSat[1]) - ctx.center.ageSat];
  }
  function solve(A, b) {
    var n = b.length;
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      var d = M[c][c] || 1e-12;
      for (var rr = 0; rr < n; rr++) {
        if (rr === c) continue;
        var f = M[rr][c] / d;
        for (var k = c; k <= n; k++) M[rr][k] -= f * M[c][k];
      }
    }
    return M.map(function (row, i) { return row[n] / (row[i] || 1e-12); });
  }
  function ridgeFit(X, y, lambda) {
    var k = X[0].length;
    var A = [], b = [];
    for (var i = 0; i < k; i++) { A.push([]); for (var j = 0; j < k; j++) A[i].push(0); b.push(0); }
    for (var n = 0; n < X.length; n++) for (var a = 0; a < k; a++) {
      b[a] += X[n][a] * y[n];
      for (var c = 0; c < k; c++) A[a][c] += X[n][a] * X[n][c];
    }
    for (var p = 1; p < k; p++) A[p][p] += lambda;
    return solve(A, b);
  }
  function fitModel(comps, asOfMs) {
    var ctx = buildContext(comps, asOfMs);
    if (comps.length < 10) {
      var mults = comps.filter(isTraded).map(function (p) { return p.mcap_usd / Math.max(1, p.tvl_usd); }).sort(function (a, b) { return a - b; });
      return { ctx: ctx, w: [0, 0, 0, 0], offsets: {}, nComps: comps.length, flatMultiple: mults.length ? median(mults) : 0.25 };
    }
    var X = comps.map(function (p) { return designRow(p, ctx); });
    var y = comps.map(function (p) { return Math.log(Math.max(1, p.mcap_usd)); });
    var w = ridgeFit(X, y, SPEC.ridgeLambda);
    var byCat = {};
    comps.forEach(function (p, i) {
      var pred = X[i].reduce(function (t, v, j) { return t + v * w[j]; }, 0);
      var key = p.category || 'Other';
      (byCat[key] = byCat[key] || []).push(y[i] - pred);
    });
    var offsets = {};
    Object.keys(byCat).forEach(function (key) {
      var rs = byCat[key];
      offsets[key] = rs.reduce(function (a, b) { return a + b; }, 0) / (rs.length + SPEC.categoryPseudoCount);
    });
    return { ctx: ctx, w: w, offsets: offsets, nComps: comps.length, flatMultiple: null };
  }
  function predictLog(model, p) {
    if (model.flatMultiple !== null) return Math.log(Math.max(1, p.tvl_usd) * model.flatMultiple);
    var row = designRow(p, model.ctx);
    return row.reduce(function (t, v, j) { return t + v * model.w[j]; }, 0) + (model.offsets[p.category || 'Other'] || 0);
  }
  function termBreakdown(model, p) {
    if (model.flatMultiple !== null) return { intercept: Math.log(Math.max(1, p.tvl_usd) * model.flatMultiple), size: 0, growth: 0, ageSat: 0, category: 0 };
    var row = designRow(p, model.ctx);
    return { intercept: model.w[0], size: row[1] * model.w[1], growth: row[2] * model.w[2], ageSat: row[3] * model.w[3], category: model.offsets[p.category || 'Other'] || 0 };
  }
  function looResiduals(comps, asOfMs) {
    var res = [];
    for (var i = 0; i < comps.length; i++) {
      var train = comps.filter(function (_, j) { return j !== i; });
      res.push(Math.log(Math.max(1, comps[i].mcap_usd)) - predictLog(fitModel(train, asOfMs), comps[i]));
    }
    return res;
  }
  function bandFromResiduals(residuals) {
    var s = residuals.slice().sort(function (a, b) { return a - b; });
    return { p10: quantileOf(s, 0.1), p25: quantileOf(s, 0.25), p75: quantileOf(s, 0.75), p90: quantileOf(s, 0.9) };
  }
  function impliedWithBand(model, band, p) {
    if (model.flatMultiple !== null) {
      // Direct product: a log/exp round-trip flips .5 boundaries across engines.
      var v = Math.max(1, Math.round(Math.max(1, p.tvl_usd) * model.flatMultiple));
      var b = function (q) { return Math.max(1, Math.round(v * Math.exp(q))); };
      return { value: v, lo10: b(band.p10), lo25: b(band.p25), hi75: b(band.p75), hi90: b(band.p90) };
    }
    var logV = predictLog(model, p);
    function round(x) { return Math.max(1, Math.round(Math.exp(x))); }
    return { value: round(logV), lo10: round(logV + band.p10), lo25: round(logV + band.p25), hi75: round(logV + band.p75), hi90: round(logV + band.p90) };
  }
  function spearman(xs, ys) {
    function rank(v) {
      var idx = v.map(function (_, i) { return i; }).sort(function (i, j) { return v[i] - v[j]; });
      var r = new Array(v.length);
      idx.forEach(function (ix, k) { r[ix] = k; });
      return r;
    }
    var ra = rank(xs), rb = rank(ys), ma = mean(ra), mb = mean(rb), sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < xs.length; i++) { sxy += (ra[i] - ma) * (rb[i] - mb); sxx += (ra[i] - ma) * (ra[i] - ma); syy += (rb[i] - mb) * (rb[i] - mb); }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  }
  function walkForward(comps, asOfMs) {
    var dated = comps.filter(function (p) { return ageDays(p, asOfMs) !== null; })
      .sort(function (a, b) { return Date.parse(a.listed_at) - Date.parse(b.listed_at); });
    var allErr = [], ys = [], ps = [], origins = [];
    [0.4, 0.55, 0.7, 0.85].forEach(function (q) {
      var cut = Math.floor(dated.length * q);
      if (cut < 10 || cut >= dated.length) return;
      var m = fitModel(dated.slice(0, cut), asOfMs), errs = [];
      dated.slice(cut).forEach(function (p) {
        var y = Math.log(Math.max(1, p.mcap_usd)), pr = predictLog(m, p);
        errs.push(Math.abs(y - pr)); allErr.push(Math.abs(y - pr)); ys.push(y); ps.push(pr);
      });
      errs.sort(function (a, b) { return a - b; });
      origins.push({ train: cut, test: dated.length - cut, medianMiss: Math.exp(median(errs)) });
    });
    var sorted = allErr.slice().sort(function (a, b) { return a - b; });
    return { medianMiss: Math.exp(median(sorted)), rho: spearman(ys, ps), nTest: allErr.length, origins: origins };
  }
  function looMedianFor(comps, asOfMs, fit) {
    var errs = [], ys = [], ps = [];
    for (var i = 0; i < comps.length; i++) {
      var pred = fit(comps.filter(function (_, j) { return j !== i; }));
      var y = Math.log(Math.max(1, comps[i].mcap_usd)), pr = pred(comps[i]);
      errs.push(Math.abs(y - pr)); ys.push(y); ps.push(pr);
    }
    errs.sort(function (a, b) { return a - b; });
    return { medianMiss: Math.exp(median(errs)), rho: spearman(ys, ps) };
  }
  function ablation(comps, asOfMs) {
    var flat = looMedianFor(comps, asOfMs, function (train) {
      var mults = train.map(function (p) { return p.mcap_usd / Math.max(1, p.tvl_usd); }).sort(function (a, b) { return a - b; });
      var m = median(mults);
      return function (p) { return Math.log(Math.max(1, p.tvl_usd) * m); };
    });
    var size = looMedianFor(comps, asOfMs, function (train) {
      var xs = train.map(function (p) { return Math.log(Math.max(1, p.tvl_usd)); });
      var ys = train.map(function (p) { return Math.log(Math.max(1, p.mcap_usd)); });
      var mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0;
      for (var i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
      var slope = sxx > 0 ? sxy / sxx : 0;
      return function (p) { return my + slope * (Math.log(Math.max(1, p.tvl_usd)) - mx); };
    });
    var full = looMedianFor(comps, asOfMs, function (train) {
      var m = fitModel(train, asOfMs);
      return function (p) { return predictLog(m, p); };
    });
    return [
      { label: 'Flat multiple (median mcap/TVL)', looMedianMiss: flat.medianMiss, rho: flat.rho },
      { label: 'Size curve only', looMedianMiss: size.medianMiss, rho: size.rho },
      { label: 'Full model (size + growth + seasoning + category)', looMedianMiss: full.medianMiss, rho: full.rho }
    ];
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function bootstrapRankRanges(comps, rows, asOfMs) {
    var n = comps.length, recorded = {};
    rows.forEach(function (r) { recorded[r.slug] = []; });
    var rng = mulberry32(SPEC.bootstrapSeed);
    for (var refit = 0; refit < SPEC.bootstrapRefits; refit++) {
      var sample = [];
      for (var d = 0; d < n; d++) sample.push(comps[Math.floor(rng() * n)]);
      var m = fitModel(sample, asOfMs);
      var scored = rows.map(function (p) { return { slug: p.slug, v: predictLog(m, p) }; })
        .sort(function (a, b) { return b.v - a.v || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0); });
      scored.forEach(function (s, i) { recorded[s.slug].push(i + 1); });
    }
    var out = {};
    Object.keys(recorded).forEach(function (slug) {
      var s = recorded[slug].slice().sort(function (a, b) { return a - b; });
      out[slug] = [quantileOf(s, 0.1), quantileOf(s, 0.9)];
    });
    return out;
  }

  // farm economics (mirrors lib/model.ts)
  function cheapestChain(p) {
    var best = null;
    (p.chains || []).forEach(function (c) {
      var g = GAS[c.trim().toLowerCase()];
      g = g === undefined ? 1.0 : g;
      if (best === null || g < best.gas) best = { name: c, gas: g };
    });
    return best || { name: 'its main chain', gas: 1.0 };
  }
  function gasPerTx(p) { return cheapestChain(p).gas; }
  function farmEconomics(p, lo25Value, deposit, share) {
    var gas = FARM.txCount * gasPerTx(p) + FARM.bridgeFee;
    var opportunity = deposit * FARM.opportunityRate * (FARM.holdDays / 365);
    var cost = gas + opportunity;
    var slice = deposit > 0 ? share * lo25Value * (deposit / Math.max(1, p.tvl_usd)) : 0;
    var net = slice - cost;
    var breakEven = slice > 0 ? cost / slice : Infinity;
    var verdict = breakEven <= 1 / 3 ? 'FARM' : breakEven <= 1 ? 'THIN' : 'SKIP';
    return { slice: slice, gas: gas, opportunity: opportunity, cost: cost, net: net, breakEven: breakEven, netPerHour: net / (FARM.minutesTotal / 60), verdict: verdict };
  }
  function fmtMoney(x) {
    if (!isFinite(x)) return '$—';
    var sign = x < 0 ? '-' : '', a = Math.abs(x);
    if (a >= 100) return sign + '$' + Math.round(a).toLocaleString('en-US');
    return sign + '$' + a.toFixed(2);
  }
  function fmtCompact(x) {
    if (!isFinite(x)) return '—';
    var sign = x < 0 ? '-' : '', a = Math.abs(x);
    if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(0) + 'K';
    return sign + '$' + a.toFixed(0);
  }
  function fmtPct(x) {
    if (!isFinite(x)) return '—';
    return (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';
  }
  // [primary, recurring, check] per category family.
  function familyOf(p) {
    var c = p.category || '';
    if (c === 'Lending' || c === 'CDP' || c === 'Leveraged Farming') return ["supply the deposit as collateral in the protocol's main lending market and keep the position open", 'top up or rebalance the supplied position so it stays above the protocol\'s minimum', 'the supplied balance and any points or rewards balance'];
    if (c === 'Dexs' || c === 'Liquidity Manager') return ["add the deposit to the protocol's deepest liquidity pool as a concentrated or full-range position", 're-center the range or re-add liquidity if the position drifted out of range', "the position's fees earned, range status and any points balance"];
    if (c === 'Yield' || c === 'Yield Aggregator') return ["deposit into the protocol's flagship vault and hold the receipt token for the full window", 'confirm the vault position is still earning and restake any auto-compounded receipt tokens', 'the vault receipt balance and any points or season progress'];
    if (c === 'Derivatives' || c === 'Options') return ["open a small hedged position on the protocol's main market with the deposit as margin, keeping leverage at or below 2x", 'roll or re-hedge the position so exposure stays near delta-neutral', 'the margin balance, funding paid and any trading-points balance'];
    if (c === 'Risk Curators' || c === 'Onchain Capital Allocator') return ["allocate the deposit to the curator's largest vault and hold the vault token for the full window", "confirm the allocation is still in the vault and review the curator's latest allocation report", 'the vault token balance and any points or allocation history'];
    if (c === 'RWA') return ["complete the protocol's onboarding, then subscribe the deposit to its flagship tokenized product", 'confirm the subscription is active and review the latest attestation or holdings report', 'the subscription balance and any points or loyalty progress'];
    if (c === 'Prediction Market') return ["fund the account and place the deposit across the protocol's highest-volume markets, split to limit single-outcome risk", 'keep positions open through resolution and re-enter new markets as old ones settle', 'open positions, resolved payouts and any points balance'];
    if (c === 'Dual-Token Stablecoin' || c === 'DOR') return ["mint or buy the protocol's stable asset with the deposit and hold it in the protocol's own savings or staking module", 'confirm the savings position is still earning and re-stake any yield that is paid out', 'the savings balance, peg and any points balance'];
    if (c === 'Bridge' || c === 'Canonical Bridge' || c === 'Cross Chain Bridge') return ['bridge the deposit through the protocol to its most-used destination chain and keep the received assets there', 'make one genuine bridge transfer per week in each direction the protocol supports', 'the bridge volume credited to the wallet and any points balance'];
    return ["deposit into the protocol's main product with the full deposit and keep the position open for the full window", "use the protocol's main product once a week so the wallet shows genuine, repeated activity", 'the position balance and any points or season progress'];
  }
  function farmSteps(p, lo25Value, deposit, share) {
    var econ = farmEconomics(p, lo25Value, deposit, share);
    var cheap = cheapestChain(p);
    var others = (p.chains || []).filter(function (c) { return c !== cheap.name; }).slice(0, 2);
    var gasTx = fmtMoney(gasPerTx(p));
    var fam = familyOf(p);
    var dep = fmtMoney(deposit);
    return [
      'Set up a fresh wallet for this farm only and back up the seed phrase offline; never reuse a wallet that holds other funds. Cost: $0. Time: 10 min.',
      'Fund the wallet with ' + dep + ' on ' + cheap.name + (others.length ? ' (also on ' + others.join(', ') + ')' : '') + ', bridging once if the funds start elsewhere. Cost: ' + fmtMoney(FARM.bridgeFee) + ' bridge + ' + gasTx + ' gas. Time: 15 min.',
      "On the protocol's own page, " + fam[0] + '. Cost: ' + dep + ' capital + ' + gasTx + ' gas. Time: 15 min.',
      'Every week for 12 weeks, ' + fam[1] + '. Cost: ' + fmtMoney(12 * gasPerTx(p)) + ' gas over the window. Time: 10 min per week.',
      "In the same weekly session, verify " + fam[2] + " on the protocol's own page and keep a dated screenshot of each check. Cost: $0. Time: 5 min per week.",
      'Hold the full ' + FARM.holdDays + '-day window without moving the deposit between wallets, so the position survives every snapshot. Cost: ' + fmtMoney(econ.opportunity) + ' in forgone yield at 4.5%. Time: 0 min.',
      "Claim only through links on the protocol's own page; never pay anyone to claim for you and never sign a transaction you did not expect. Cost: " + gasTx + ' gas. Time: 15 min.',
      'Verdict: ' + econ.verdict + ' — at a ' + dep + ' deposit and a ' + (share * 100).toFixed(0) + '% airdrop share, the low-quartile slice is ' + fmtMoney(econ.slice) + ' against ' + fmtMoney(econ.cost) + ' all-in cost (' + fmtMoney(econ.gas) + ' gas + ' + fmtMoney(econ.opportunity) + ' forgone yield). Launch odds of ' + fmtPct(econ.breakEven) + ' repay it (' + fmtMoney(econ.net) + ' net, ' + fmtMoney(econ.netPerHour) + '/hour). Unwind by withdrawing the deposit and any earned position, then sweeping the wallet to cold storage.'
    ];
  }

  // page logic
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtGrowth(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  function fmtAge(d) { return d === null ? '—' : Math.round(d) + 'd'; }
  function signed(x) {
    return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(3);
  }

  var R = window.RADAR;
  var state = { sortK: 'rank', sortDir: 1, liveSortK: 'mcap', liveSortDir: -1, deposit: 1000, share: 0.10, q: '', cat: '', verdict: '' };
  var ctx = null; // { protocols, bySlug, comps, model, band, wf, abl, rows, check }

  function refit() {
    var t0 = performance.now();
    var protocols = R.protocols.map(function (a) {
      return { slug: a[0], name: a[1], category: a[2], chains: a[3], tvl_usd: a[4], change_7d: a[5], mcap_usd: a[6], listed_at: a[7], gecko_id: a[8], symbol: a[9] };
    });
    var bySlug = {};
    protocols.forEach(function (p) { bySlug[p.slug] = p; });
    var asOfMs = Date.parse(R.as_of + 'T00:00:00Z');
    var comps = protocols.filter(isFitComp);
    var model = fitModel(comps, asOfMs);
    var residuals = looResiduals(comps, asOfMs);
    var band = bandFromResiduals(residuals);
    var absRes = residuals.map(Math.abs).sort(function (a, b) { return a - b; });
    var wf = walkForward(comps, asOfMs);
    var abl = ablation(comps, asOfMs);
    var rankable = protocols.filter(isRankable);
    var rankRanges = bootstrapRankRanges(comps, rankable, asOfMs);
    // Row selection matches main.ts.
    var chosen = {};
    rankable.forEach(function (p) { chosen[p.slug] = p; });
    R.watchlist.forEach(function (slug) { if (bySlug[slug]) chosen[slug] = bySlug[slug]; });
    function addFallback(pred) {
      var keys = Object.keys(chosen).length;
      if (keys >= 100) return;
      protocols.filter(function (p) { return !chosen[p.slug] && pred(p); })
        .sort(function (a, b) { return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1); })
        .forEach(function (p) { if (Object.keys(chosen).length < 100) chosen[p.slug] = p; });
    }
    addFallback(function (p) { return p.mcap_usd === null; });
    addFallback(function () { return true; });
    var rows = Object.keys(chosen).map(function (s) { return chosen[s]; })
      .map(function (p) { return { p: p, v: impliedWithBand(model, band, p) }; })
      .sort(function (a, b) { return b.v.value - a.v.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0); })
      .slice(0, 4000)
      .map(function (r, i) {
        var rr = rankRanges[r.p.slug] || [i + 1, i + 1];
        return { rank: i + 1, p: r.p, value: Math.min(1e14, r.v.value),
          lo10: Math.min(1e14, r.v.lo10), lo25: Math.min(1e14, r.v.lo25),
          hi75: Math.min(1e14, r.v.hi75), hi90: Math.min(1e14, r.v.hi90),
          rankLo: rr[0], rankHi: rr[1], age: ageDays(r.p, asOfMs) };
      });
    // Check rows against the carried board.
    var carried = {};
    R.board.forEach(function (a) { carried[a[1]] = a; });
    var mismatches = [];
    if (R.board.length !== rows.length) mismatches.push('row count ' + rows.length + ' vs ' + R.board.length);
    rows.forEach(function (row) {
      var c = carried[row.p.slug];
      if (!c) { mismatches.push(row.p.slug + ': missing from carried board'); return; }
      var econ = farmEconomics(row.p, row.lo25, FARM.defaultDeposit, FARM.defaultShare);
      var be = isFinite(econ.breakEven) ? Math.round(econ.breakEven * 1e4) / 1e4 : 9999;
      var net = Math.round(econ.net * 100) / 100;
      if (c[0] !== row.rank || c[2] !== row.value || c[3] !== row.lo10 || c[4] !== row.lo25 ||
          c[5] !== row.hi75 || c[6] !== row.hi90 || c[7] !== row.rankLo || c[8] !== row.rankHi ||
          c[9] !== econ.verdict || Math.abs(c[10] - net) > 0.011 || Math.abs(c[11] - be) > 0.0002) {
        mismatches.push(row.p.slug + ': recomputed row differs');
      }
    });
    var ms = performance.now() - t0;
    return { protocols: protocols, bySlug: bySlug, comps: comps, model: model, band: band,
      looMedianMiss: Math.exp(median(absRes)), wf: wf, abl: abl, rows: rows,
      check: { ok: mismatches.length === 0, mismatches: mismatches.slice(0, 5), n: rows.length, ms: ms } };
  }

  function econFor(row) { return farmEconomics(row.p, row.lo25, state.deposit, state.share); }

  function renderStats() {
    var buckets = { ranked: 0, traded: 0, 'token-no-mcap': 0, 'set-aside': 0 };
    ctx.protocols.forEach(function (p) { buckets[bucketOf(p)]++; });
    var wlCovered = R.watchlist.filter(function (s) { return ctx.bySlug[s] && ctx.rows.some(function (r) { return r.p.slug === s; }); }).length;
    var tiles = [
      ['Watchlist', wlCovered + ' / ' + R.watchlist.length, 'every watchlist protocol ranked', true],
      ['Ranked rows', String(ctx.rows.length), 'pre-token protocols priced', false],
      ['Comps', String(ctx.comps.length), 'traded protocols fitting the model', false],
      ['Set aside', String(buckets.traded), 'already trade — market values', false],
      ['LOO miss', '×' + ctx.looMedianMiss.toFixed(2), 'median leave-one-out error', true],
      ['Walk-forward', '×' + ctx.wf.medianMiss.toFixed(2), 'fit old, tested on later listings', true]
    ];
    el('stats').innerHTML = tiles.map(function (t) {
      return '<div class="stat' + (t[3] ? ' hot' : '') + '"><b>' + esc(t[1]) + '</b><span>' + esc(t[0]) + ' — ' + esc(t[2]) + '</span></div>';
    }).join('');
  }

  function renderMethod() {
    var m = ctx.model, c = m.ctx;
    el('compCount').textContent = String(ctx.comps.length);
    var lines;
    if (m.flatMultiple !== null) {
      lines = 'log(implied) = log(TVL × ' + m.flatMultiple.toFixed(4) + ')\nflat multiple: fit set too thin for a curve.';
    } else {
      var ctr = function (name, c, d) { return name + (c < 0 ? ' + ' : ' − ') + Math.abs(c).toFixed(d); };
      lines = 'log(implied) = ' + m.w[0].toFixed(3) + '\n' +
        '  ' + signed(m.w[1]) + ' × (' + ctr('log TVL', c.center.size, 2) + ')\n' +
        '  ' + signed(m.w[2]) + ' × (' + ctr('growth', c.center.growth, 3) + ')\n' +
        '  ' + signed(m.w[3]) + ' × (' + ctr('seasoning', c.center.ageSat, 3) + ')\n' +
        '  + category offset (shrunk, ' + Object.keys(m.offsets).length + ' categories; range ' +
        signed(Math.min.apply(null, Object.keys(m.offsets).map(function (k) { return m.offsets[k]; }))) + ' … ' +
        signed(Math.max.apply(null, Object.keys(m.offsets).map(function (k) { return m.offsets[k]; }))) + ' log points)\n' +
        'growth = change_7d / 100, clamped to ±0.60 · seasoning = 1 − exp(−age days / 730) · all features clamped to the fit range.';
    }
    el('formula').textContent = lines;
    el('ablation').innerHTML = '<table><thead><tr><th>Model</th><th class="num">Leave-one-out median miss</th><th class="num">Rank corr.</th></tr></thead><tbody>' +
      ctx.abl.map(function (a) {
        return '<tr><td>' + esc(a.label) + '</td><td class="num">×' + a.looMedianMiss.toFixed(2) + '</td><td class="num">' + a.rho.toFixed(2) + '</td></tr>';
      }).join('') + '</tbody></table>';
    el('wfLine').textContent = 'Walk-forward: fit on the oldest 40/55/70/85% of comps, tested on later listings — median miss ×' +
      ctx.wf.medianMiss.toFixed(2) + ', rank corr. ' + ctx.wf.rho.toFixed(2) + ' over ' + ctx.wf.nTest + ' later listings. ' +
      'Per origin: ' + ctx.wf.origins.map(function (o) { return 'train ' + o.train + ' → test ' + o.test + ' ×' + o.medianMiss.toFixed(2); }).join('; ') + '.';
  }

  function renderChart() {
    var W = 760, H = 340, L = 64, Rr = 16, T = 12, B = 36;
    var comps = ctx.comps, rows = ctx.rows, m = ctx.model;
    var xs = [], ys = [];
    comps.forEach(function (p) { xs.push(Math.log(Math.max(1, p.tvl_usd))); ys.push(Math.log(p.mcap_usd)); });
    rows.forEach(function (r) { xs.push(Math.log(Math.max(1, r.p.tvl_usd))); ys.push(Math.log(r.value)); });
    var x0 = Math.min.apply(null, xs) - 0.3, x1 = Math.max.apply(null, xs) + 0.3;
    var y0 = Math.min.apply(null, ys) - 0.4, y1 = Math.max.apply(null, ys) + 0.4;
    function X(v) { return L + (v - x0) / (x1 - x0) * (W - L - Rr); }
    function Y(v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); }
    function powLabel(e) { return '$' + (e >= 9 ? Math.pow(10, e - 9) + 'B' : e >= 6 ? Math.pow(10, e - 6) + 'M' : Math.pow(10, e - 3) + 'K'); }
    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '">');
    // gridlines at powers of ten
    for (var e = 6; e <= 11; e++) {
      var gx = Math.log(Math.pow(10, e));
      if (gx < x0 || gx > x1) continue;
      svg.push('<line x1="' + X(gx).toFixed(1) + '" y1="' + T + '" x2="' + X(gx).toFixed(1) + '" y2="' + (H - B) + '" stroke="#e8ebe4"/>');
      svg.push('<text x="' + X(gx).toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle" font-size="10" fill="#5c6470">' + powLabel(e) + '</text>');
    }
    for (var f = 5; f <= 11; f++) {
      var gy = Math.log(Math.pow(10, f));
      if (gy < y0 || gy > y1) continue;
      svg.push('<line x1="' + L + '" y1="' + Y(gy).toFixed(1) + '" x2="' + (W - Rr) + '" y2="' + Y(gy).toFixed(1) + '" stroke="#e8ebe4"/>');
      svg.push('<text x="' + (L - 6) + '" y="' + (Y(gy) + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="#5c6470">' + powLabel(f) + '</text>');
    }
    svg.push('<text x="' + ((L + W - Rr) / 2) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="11" fill="#5c6470">TVL (log scale)</text>');
    svg.push('<text x="14" y="' + ((T + H - B) / 2) + '" text-anchor="middle" font-size="11" fill="#5c6470" transform="rotate(-90 14 ' + ((T + H - B) / 2) + ')">Market cap / implied value (log scale)</text>');
    // band + curve: size term only, growth/seasoning at their centers, offset 0
    var band = ctx.band, pts = [], top = [], bot = [];
    for (var i = 0; i <= 40; i++) {
      var xv = x0 + (x1 - x0) * i / 40;
      var yv = m.flatMultiple !== null ? Math.log(Math.exp(xv) * m.flatMultiple) : m.w[0] + m.w[1] * (xv - m.ctx.center.size);
      pts.push([X(xv), Y(yv)]);
      top.push([X(xv), Y(yv + band.p75)]);
      bot.push([X(xv), Y(yv + band.p25)]);
    }
    var poly = top.concat(bot.slice().reverse()).map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    svg.push('<polygon points="' + poly + '" fill="#0e7a6b" opacity="0.12"/>');
    svg.push('<polyline points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '" fill="none" stroke="#0e7a6b" stroke-width="2"/>');
    rows.forEach(function (r) {
      var cx = X(Math.log(Math.max(1, r.p.tvl_usd))).toFixed(1), cy = Y(Math.log(r.value)).toFixed(1);
      if (R.watchlist.indexOf(r.p.slug) >= 0) svg.push('<circle cx="' + cx + '" cy="' + cy + '" r="3.4" fill="#b45309" stroke="#fff" stroke-width="0.8"/>');
      else svg.push('<circle cx="' + cx + '" cy="' + cy + '" r="2.6" fill="#fff" stroke="#b45309" stroke-width="1.4"/>');
    });
    comps.forEach(function (p) {
      svg.push('<circle cx="' + X(Math.log(Math.max(1, p.tvl_usd))).toFixed(1) + '" cy="' + Y(Math.log(p.mcap_usd)).toFixed(1) + '" r="3.2" fill="#0e7a6b" opacity="0.85"/>');
    });
    svg.push('<g font-size="11" fill="#33383f" style="paint-order:stroke;stroke:#fff;stroke-width:3"><circle cx="' + (L + 8) + '" cy="' + (T + 8) + '" r="4" fill="#0e7a6b"/><text x="' + (L + 18) + '" y="' + (T + 12) + '">Traded comps (' + comps.length + ')</text>' +
      '<circle cx="' + (L + 150) + '" cy="' + (T + 8) + '" r="4" fill="#fff" stroke="#b45309" stroke-width="1.5"/><text x="' + (L + 160) + '" y="' + (T + 12) + '">Ranked pre-token</text>' +
      '<circle cx="' + (L + 292) + '" cy="' + (T + 8) + '" r="4" fill="#b45309"/><text x="' + (L + 302) + '" y="' + (T + 12) + '">Watchlist</text>' +
      '<line x1="' + (L + 392) + '" y1="' + (T + 8) + '" x2="' + (L + 418) + '" y2="' + (T + 8) + '" stroke="#0e7a6b" stroke-width="2"/><text x="' + (L + 424) + '" y="' + (T + 12) + '">Fitted curve + middle-half band</text></g>');
    svg.push('</svg>');
    el('chart').innerHTML = svg.join('');
  }

  function bandScale() {
    var lo = Math.min.apply(null, ctx.rows.map(function (r) { return Math.log(r.lo10); }));
    var hi = Math.max.apply(null, ctx.rows.map(function (r) { return Math.log(r.hi90); }));
    return { lo: lo, hi: hi };
  }
  var SCALE = null;
  function bandBar(row) {
    var lo = (Math.log(row.lo10) - SCALE.lo) / (SCALE.hi - SCALE.lo) * 100;
    var hi = (Math.log(row.hi90) - SCALE.lo) / (SCALE.hi - SCALE.lo) * 100;
    var p25 = (Math.log(row.lo25) - SCALE.lo) / (SCALE.hi - SCALE.lo) * 100;
    var p75 = (Math.log(row.hi75) - SCALE.lo) / (SCALE.hi - SCALE.lo) * 100;
    var pt = (Math.log(row.value) - SCALE.lo) / (SCALE.hi - SCALE.lo) * 100;
    return '<div class="bandbar" title="P10–P90 ' + fmtCompact(row.lo10) + ' – ' + fmtCompact(row.hi90) + '">' +
      '<i style="left:' + lo.toFixed(1) + '%;width:' + (hi - lo).toFixed(1) + '%;background:#f0ddba"></i>' +
      '<i style="left:' + p25.toFixed(1) + '%;width:' + (p75 - p25).toFixed(1) + '%"></i>' +
      '<b style="left:calc(' + pt.toFixed(1) + '% - 1px)"></b></div>';
  }

  function visibleRows() {
    var q = state.q.toLowerCase();
    return ctx.rows.filter(function (row) {
      if (q && (row.p.name.toLowerCase().indexOf(q) < 0 && row.p.slug.indexOf(q) < 0 && (row.p.category || '').toLowerCase().indexOf(q) < 0)) return false;
      if (state.cat === '__none__' && row.p.category !== null) return false;
      if (state.cat && state.cat !== '__none__' && row.p.category !== state.cat) return false;
      if (state.verdict && econFor(row).verdict !== state.verdict) return false;
      return true;
    });
  }
  function sortRows(list) {
    var k = state.sortK, dir = state.sortDir;
    function key(row) {
      switch (k) {
        case 'rank': return row.rank;
        case 'name': return row.p.name.toLowerCase();
        case 'value': return row.value;
        case 'tvl': return row.p.tvl_usd;
        case 'growth': return row.p.change_7d === null ? -1e18 : row.p.change_7d;
        case 'age': return row.age === null ? -1e18 : row.age;
        case 'slice': return econFor(row).slice;
        case 'net': return econFor(row).net;
        case 'be': return econFor(row).breakEven;
        case 'verdict': return { FARM: 0, THIN: 1, SKIP: 2 }[econFor(row).verdict];
        default: return row.rank;
      }
    }
    return list.slice().sort(function (a, b) {
      var ka = key(a), kb = key(b);
      var c = ka < kb ? -1 : ka > kb ? 1 : (a.p.slug < b.p.slug ? -1 : 1);
      return c * dir;
    });
  }
  function renderBoard() {
    var list = sortRows(visibleRows());
    el('boardCount').textContent = '— ' + list.length + ' of ' + ctx.rows.length + ' rows';
    el('boardBody').innerHTML = list.map(function (row) {
      var e = econFor(row);
      var wl = R.watchlist.indexOf(row.p.slug) >= 0;
      return '<tr data-slug="' + esc(row.p.slug) + '"><td><b>#' + row.rank + '</b><br><span class="range">P10–P90 ' + row.rankLo + '–' + row.rankHi + '</span></td>' +
        '<td><span class="pname">' + esc(row.p.name) + '</span>' + (wl ? ' <span class="pill">watchlist</span>' : '') + '<br><span class="pcat">' + esc(row.p.category || 'Uncategorised') + ' · ' + esc(row.p.chains.slice(0, 3).join(', ') || '—') + '</span></td>' +
        '<td><span class="val">' + fmtCompact(row.value) + '</span><br><span class="sub">' + fmtCompact(row.lo25) + ' – ' + fmtCompact(row.hi75) + '</span>' + bandBar(row) + '</td>' +
        '<td class="num">' + fmtCompact(row.p.tvl_usd) + '</td>' +
        '<td class="num ' + (row.p.change_7d !== null && row.p.change_7d < 0 ? 'neg' : row.p.change_7d !== null && row.p.change_7d > 0 ? 'pos' : '') + '">' + fmtGrowth(row.p.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(row.age) + '</td>' +
        '<td class="num">' + fmtMoney(e.slice) + '</td>' +
        '<td class="num ' + (e.net < 0 ? 'neg' : 'pos') + '">' + fmtMoney(e.net) + '</td>' +
        '<td class="num">' + fmtPct(e.breakEven) + '</td>' +
        '<td><span class="verdict ' + e.verdict + '">' + e.verdict + '</span></td></tr>';
    }).join('');
    document.querySelectorAll('#board thead th').forEach(function (th) {
      th.classList.toggle('sorted', th.getAttribute('data-k') === state.sortK);
    });
  }
  function renderLive() {
    var traded = ctx.protocols.filter(isTraded).map(function (p) { return { p: p, comp: isFitComp(p) }; });
    var k = state.liveSortK, dir = state.liveSortDir;
    function key(r) {
      switch (k) {
        case 'name': return r.p.name.toLowerCase();
        case 'mcap': return r.p.mcap_usd;
        case 'tvl': return r.p.tvl_usd;
        case 'mult': return r.p.mcap_usd / Math.max(1, r.p.tvl_usd);
        case 'growth': return r.p.change_7d === null ? -1e18 : r.p.change_7d;
        case 'comp': return r.comp ? 1 : 0;
        default: return r.p.mcap_usd;
      }
    }
    traded.sort(function (a, b) {
      var ka = key(a), kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : (a.p.slug < b.p.slug ? -1 : 1)) * dir;
    });
    el('liveCount').textContent = '— ' + traded.length + ' protocols';
    el('liveBody').innerHTML = traded.map(function (r) {
      return '<tr data-slug="' + esc(r.p.slug) + '"><td><span class="pname">' + esc(r.p.name) + '</span><br><span class="pcat">' + esc(r.p.category || 'Uncategorised') + '</span></td>' +
        '<td class="num">' + fmtCompact(r.p.mcap_usd) + '</td><td class="num">' + fmtCompact(r.p.tvl_usd) + '</td>' +
        '<td class="num">' + (r.p.mcap_usd / Math.max(1, r.p.tvl_usd)).toFixed(2) + '×</td>' +
        '<td class="num">' + fmtGrowth(r.p.change_7d) + '</td><td>' + (r.comp ? '◆ comp' : '—') + '</td></tr>';
    }).join('');
    document.querySelectorAll('#live thead th').forEach(function (th) {
      th.classList.toggle('sorted', th.getAttribute('data-k') === state.liveSortK);
    });
  }
  function renderRecon() {
    var buckets = { ranked: 0, traded: 0, 'token-no-mcap': 0, 'set-aside': 0 };
    ctx.protocols.forEach(function (p) { buckets[bucketOf(p)]++; });
    var total = ctx.protocols.length;
    el('reconBody').innerHTML = '<div class="recon-grid">' +
      '<div><b>' + buckets.ranked + '</b><span>Ranked — pre-token, not an exchange, bridge, wrapper or versioned pool.</span></div>' +
      '<div><b>' + buckets.traded + '</b><span>Already trade — shown at market values in Live tokens, never ranked.</span></div>' +
      '<div><b>' + buckets['token-no-mcap'] + '</b><span>Token on record, no usable market cap — set aside, not priced.</span></div>' +
      '<div><b>' + buckets['set-aside'] + '</b><span>Pre-token but set aside by rule — exchanges, bridges, wrappers, versioned pools.</span></div></div>' +
      '<p class="note">' + buckets.ranked + ' + ' + buckets.traded + ' + ' + buckets['token-no-mcap'] + ' + ' + buckets['set-aside'] + ' = ' + total + ' — every protocol in exactly one bucket.</p>';
  }
  function renderBestFarms() {
    var withEcon = ctx.rows.map(function (row) { return { row: row, e: econFor(row) }; });
    withEcon.sort(function (a, b) { return b.e.netPerHour - a.e.netPerHour; });
    var picks = withEcon.filter(function (x) { return x.e.verdict !== 'SKIP'; }).slice(0, 5);
    if (picks.length < 5) picks = picks.concat(withEcon.filter(function (x) { return x.e.verdict === 'SKIP'; }).slice(0, 5 - picks.length));
    el('bestfarms').innerHTML = '<div class="farm-head">Best farms at ' + fmtMoney(state.deposit) + ' deposit · ' + (state.share * 100).toFixed(0) + '% airdrop share — by net per hour</div>' +
      picks.map(function (x) {
        return '<div class="farm" data-slug="' + esc(x.row.p.slug) + '"><b>#' + x.row.rank + ' ' + esc(x.row.p.name) + '</b>' +
          '<span class="net">' + fmtMoney(x.e.net) + ' net</span><br><span>' + fmtMoney(x.e.netPerHour) + '/hour · break-even ' + fmtPct(x.e.breakEven) + '</span><br>' +
          '<span class="verdict ' + x.e.verdict + '">' + x.e.verdict + '</span></div>';
      }).join('');
  }
  function nearestComps(p) {
    var lt = Math.log(Math.max(1, p.tvl_usd));
    return ctx.comps.map(function (c) {
      return { c: c, d: Math.abs(Math.log(Math.max(1, c.tvl_usd)) - lt), same: (c.category || '') === (p.category || '') };
    }).sort(function (a, b) { return (a.same === b.same ? a.d - b.d : a.same ? -1 : 1); }).slice(0, 3);
  }
  function renderDetail(slug, scroll) {
    var row = null;
    ctx.rows.forEach(function (r) { if (r.p.slug === slug) row = r; });
    var box = el('detail');
    if (!row) {
      var p = ctx.bySlug[slug];
      if (!p) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<div class="detail-head"><h2>' + esc(p.name) + '</h2><button class="close" type="button">Close</button></div>' +
        '<p class="lede">This protocol is not on the ranked board: ' + esc(bucketOf(p) === 'traded' ? 'its token already trades, so the market prices it at ' + fmtCompact(p.mcap_usd) + '.' : bucketOf(p) === 'token-no-mcap' ? 'a token is on record but no usable market cap exists, so it is set aside, not priced.' : 'it is set aside by rule (exchange, bridge, wrapper or versioned pool).') + '</p>' +
        '<p class="lede">' + esc(p.category || 'Uncategorised') + ' · TVL ' + fmtCompact(p.tvl_usd) + ' · 7d ' + fmtGrowth(p.change_7d) + (p.mcap_usd === null ? '' : ' · market cap ' + fmtCompact(p.mcap_usd)) + '</p>';
      box.querySelector('.close').addEventListener('click', closeDetail);
      if (scroll) box.scrollIntoView({ behavior: 'auto', block: 'start' });
      return;
    }
    var p = row.p, e = econFor(row), terms = termBreakdown(ctx.model, p);
    var logSum = terms.intercept + terms.size + terms.growth + terms.ageSat + terms.category;
    var comps = nearestComps(p);
    var steps = farmSteps(p, row.lo25, state.deposit, state.share);
    var termRow = function (label, v, third) {
      return '<tr><td>' + label + '</td><td class="num">' + signed(v) + '</td><td class="num">' + (third || ('×' + Math.exp(v).toFixed(2))) + '</td></tr>';
    };
    box.hidden = false;
    box.innerHTML = '<div class="detail-head"><div><h2>#' + row.rank + ' ' + esc(p.name) + '</h2>' +
      '<p class="lede">' + esc(p.category || 'Uncategorised') + ' · ' + esc(p.chains.join(', ') || '—') + ' · TVL ' + fmtCompact(p.tvl_usd) + ' · 7d ' + fmtGrowth(p.change_7d) + ' · age ' + fmtAge(row.age) +
      (R.watchlist.indexOf(p.slug) >= 0 ? ' · <span class="pill">watchlist</span>' : '') + '</p></div>' +
      '<button class="close" type="button">Close</button></div>' +
      '<div class="detail-grid"><div><h3>How this value is built</h3>' +
      '<table><thead><tr><th>Term</th><th class="num">Log points</th><th class="num">Factor</th></tr></thead><tbody>' +
      termRow('Intercept (base value)', terms.intercept, fmtCompact(Math.exp(terms.intercept))) +
      termRow('Size — log TVL ' + Math.log(Math.max(1, p.tvl_usd)).toFixed(2), terms.size) +
      termRow('Growth — ' + fmtGrowth(p.change_7d) + (p.change_7d === null ? ' (missing: fit median)' : ''), terms.growth) +
      termRow('Seasoning — ' + fmtAge(row.age) + (row.age === null ? ' (missing: fit median)' : ''), terms.ageSat) +
      termRow('Category offset — ' + esc(p.category || 'Other'), terms.category) +
      '<tr><td><b>Implied value</b></td><td class="num"><b>' + logSum.toFixed(3) + '</b></td><td class="num"><b>' + fmtCompact(row.value) + '</b></td></tr>' +
      '</tbody></table>' +
      '<p class="note">Band (leave-one-out errors): ' + fmtCompact(row.lo10) + ' – ' + fmtCompact(row.hi90) + ' (P10–P90), middle half ' + fmtCompact(row.lo25) + ' – ' + fmtCompact(row.hi75) + '. Rank range over 200 refits: ' + row.rankLo + '–' + row.rankHi + '. Recomputed in this page.</p>' +
      '<h3>Nearest comps</h3><table><thead><tr><th>Protocol</th><th class="num">Market cap</th><th class="num">TVL</th><th class="num">Multiple</th></tr></thead><tbody>' +
      comps.map(function (x) {
        return '<tr><td>' + esc(x.c.name) + (x.same ? ' <span class="pill">same category</span>' : '') + '</td><td class="num">' + fmtCompact(x.c.mcap_usd) + '</td><td class="num">' + fmtCompact(x.c.tvl_usd) + '</td><td class="num">' + (x.c.mcap_usd / Math.max(1, x.c.tvl_usd)).toFixed(2) + '×</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div><h3>Farm economics at ' + fmtMoney(state.deposit) + ' · ' + (state.share * 100).toFixed(0) + '% share</h3>' +
      '<div class="econ"><div><b>' + fmtMoney(e.slice) + '</b><span>Slice at low-quartile value</span></div>' +
      '<div><b>' + fmtMoney(e.cost) + '</b><span>All-in cost (gas ' + fmtMoney(e.gas) + ' + yield ' + fmtMoney(e.opportunity) + ')</span></div>' +
      '<div><b class="' + (e.net < 0 ? 'neg' : 'pos') + '">' + fmtMoney(e.net) + '</b><span>Net if launch</span></div>' +
      '<div><b>' + fmtPct(e.breakEven) + '</b><span>Break-even odds</span></div></div>' +
      '<p><span class="verdict ' + e.verdict + '">' + e.verdict + '</span> <span class="note">' + fmtMoney(e.netPerHour) + ' per hour over ' + FARM.minutesTotal + ' minutes of work.</span></p>' +
      '<h3>Farm plan — 8 steps, costed and timed</h3><ol class="steps">' +
      steps.map(function (s, i) {
        return '<li>' + (i === 7 ? s.replace(/^Verdict: (FARM|THIN|SKIP) — /, '<span class="verdict $1">$1</span> ') : esc(s)) + '</li>';
      }).join('') + '</ol></div></div>';
    box.querySelector('.close').addEventListener('click', closeDetail);
    if (scroll) box.scrollIntoView({ behavior: 'auto', block: 'start' });
  }
  function openDetail(slug, scroll) {
    renderDetail(slug, scroll);
    if (history.replaceState) history.replaceState(null, '', '#' + slug);
  }
  function closeDetail() {
    el('detail').hidden = true;
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
  }
  function renderAll() {
    renderBoard();
    renderBestFarms();
    var open = location.hash ? location.hash.slice(1) : '';
    if (open && !el('detail').hidden) renderDetail(open, false);
  }

  function main() {
    if (!R || !R.protocols) {
      el('checkBadge').textContent = '✗ No data: data.js did not load';
      el('checkBadge').className = 'badge-check bad';
      window.__RADAR_ERROR__ = 'no data';
      return;
    }
    try {
      ctx = refit();
    } catch (err) {
      el('checkBadge').textContent = '✗ Refit failed: ' + err.message;
      el('checkBadge').className = 'badge-check bad';
      window.__RADAR_ERROR__ = String(err && err.message || err);
      return;
    }
    SCALE = bandScale();
    var badge = el('checkBadge');
    if (ctx.check.ok) {
      badge.textContent = '✓ board.json = this page — ' + ctx.check.n + '/' + ctx.check.n + ' rows refit in ' + (ctx.check.ms / 1000).toFixed(1) + 's';
      badge.className = 'badge-check ok';
    } else {
      badge.textContent = '✗ Refit mismatch: ' + ctx.check.mismatches.join('; ');
      badge.className = 'badge-check bad';
    }
    window.__RADAR_CHECK__ = ctx.check;
    el('snapLine').textContent = 'Snapshot ' + R.as_of + ' · ' + R.source.split(' ')[0] + ' · floor ' + fmtCompact(R.floor_usd);
    el('footLine').textContent = 'Token Radar · model radar-4 · snapshot ' + R.as_of + ' · ' + ctx.protocols.length + ' protocols';
    var cats = {};
    ctx.rows.forEach(function (r) { cats[r.p.category || 'Uncategorised'] = 1; });
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c === 'Uncategorised' ? '__none__' : c;
      o.textContent = c;
      el('cat').appendChild(o);
    });
    renderStats();
    renderMethod();
    renderChart();
    renderRecon();
    renderLive();
    renderAll();

    el('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
    el('cat').addEventListener('change', function (e) {
      state.cat = e.target.value;
      renderBoard();
    });
    el('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderAll(); });
    el('deposit').addEventListener('change', function (e) { state.deposit = Number(e.target.value); renderAll(); });
    el('share').addEventListener('change', function (e) { state.share = Number(e.target.value); renderAll(); });
    document.querySelectorAll('#board thead th').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-k');
        if (state.sortK === k) state.sortDir *= -1; else { state.sortK = k; state.sortDir = 1; }
        renderBoard();
      });
    });
    document.querySelectorAll('#live thead th').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-k');
        if (state.liveSortK === k) state.liveSortDir *= -1; else { state.liveSortK = k; state.liveSortDir = 1; }
        renderLive();
      });
    });
    el('boardBody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-slug]');
      if (tr) openDetail(tr.getAttribute('data-slug'), true);
    });
    el('liveBody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-slug]');
      if (tr) openDetail(tr.getAttribute('data-slug'), true);
    });
    el('bestfarms').addEventListener('click', function (e) {
      var card = e.target.closest('.farm[data-slug]');
      if (card) openDetail(card.getAttribute('data-slug'), true);
    });
    el('tabBoard').addEventListener('click', function () {
      el('tabBoard').classList.add('on'); el('tabLive').classList.remove('on');
      el('boardCard').hidden = false; el('liveCard').hidden = true;
    });
    el('tabLive').addEventListener('click', function () {
      el('tabLive').classList.add('on'); el('tabBoard').classList.remove('on');
      el('boardCard').hidden = true; el('liveCard').hidden = false;
    });
    window.addEventListener('hashchange', function () {
      var slug = location.hash.slice(1);
      if (slug) openDetail(slug, false); else closeDetail();
    });
    if (location.hash) openDetail(location.hash.slice(1), false);
    window.__RADAR_READY__ = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})();

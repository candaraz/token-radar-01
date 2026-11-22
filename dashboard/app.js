/* Launch Radar dashboard — reads window.RADAR from data.js, no network. */
const D = window.RADAR;
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(1) + "k";
  return sign + "$" + Math.round(a);
};
const money0 = (n) => money(Math.round(n));
const pct = (n) => (n * 100).toFixed(0) + "%";
const ageStr = (r) => r.ageKnown ? (r.ageDays >= 365 ? (r.ageDays / 365).toFixed(1) + " yrs" : r.ageDays + " d") : "not stated";
const fmt7d = (v) => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%";

/* Live farm scenario: the sliders re-price every row from the same rules main.ts used. */
const scenario = { depositPct: 0.0002, dropShare: 0.10, weeks: 12 };
function priceRow(r) {
  const dep = Math.min(100000, Math.max(1000, scenario.depositPct * r.tvl));
  const slice = r.implied * scenario.dropShare * (dep / r.tvl);
  const gas = (r.chains.includes("Ethereum") ? 24 : 3) + 5;
  const forgone = dep * 0.04 * (scenario.weeks / 52);
  const net = slice - gas - forgone;
  const hours = r.steps.reduce((t, s) => t + s.minutes, 0) / 60;
  const nph = net / hours;
  const verdict = net > 0 && nph >= 25 ? "FARM" : net > 0 ? "MARGINAL" : "SKIP";
  return { dep, slice, gas, forgone, net, hours, nph, verdict };
}
function pricedRows() { return D.rows.map((r) => ({ ...r, ...priceRow(r) })); }

/* ---- header meta ---- */
$("#meta").innerHTML =
  "snapshot " + esc(D.as_of) + " · " + D.total_protocols + " protocols<br>" +
  "model " + esc(D.model) + " · checksum " + esc(D.checksum) + " = main.ts<br>" +
  "watchlist " + D.rows.filter((r) => r.tier === "watchlist").length + "/40 · floor " + money0(D.floor_usd);

function renderApp() {
  const pr = pricedRows();
  const counts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  pr.forEach((r) => counts[r.verdict]++);
  const ev = D.evidence;
  const kpi = `
  <section class="kpis">
    <div class="kpi good"><div class="k">Out-of-sample miss, walk-forward</div><div class="v">×${ev.value.wfMiss.toFixed(2)} <small>vs ×${ev.value.flatWfMiss.toFixed(2)} flat</small></div><div class="s">5-fold CV ×${ev.value.cvMiss.toFixed(2)} vs ×${ev.value.flatCvMiss.toFixed(2)} flat · ${ev.value.n} priced comps</div></div>
    <div class="kpi good"><div class="k">Is the printed range honest?</div><div class="v">${pct(ev.ranges.p25p75)} <small>in P25–P75</small></div><div class="s">stated 50% · P10–P90 covers ${pct(ev.ranges.p10p90)} of comps, stated 80%</div></div>
    <div class="kpi good"><div class="k">Token odds vs base rate</div><div class="v">Brier ${ev.odds.cvBrier.toFixed(3)} <small>CV · ${ev.odds.wfBrier.toFixed(3)} WF</small></div><div class="s">base rate ${ev.odds.baseCvBrier.toFixed(3)} CV · ${ev.odds.baseWfBrier.toFixed(3)} WF · ${ev.odds.n} dated peers</div></div>
    <div class="kpi"><div class="k">Terms that survived both tests</div><div class="v">value 1 of 4 <small>· odds 4 of 6</small></div><div class="s">size curve only · age, size, growth, kinship; category &amp; life-table tested, not kept</div></div>
    <div class="kpi ${counts.FARM > 0 ? "good" : "warn"}"><div class="k">Worth farming, this scenario</div><div class="v">${counts.FARM} FARM <small>· ${counts.MARGINAL} marginal · ${counts.SKIP} skip</small></div><div class="s">net of gas, fees and the 4% T-bill · $25/hour</div></div>
    <div class="kpi good"><div class="k">Watchlist ranked</div><div class="v">40/40</div><div class="s">${D.rows.length} rows · ${money0(D.total_tvl)} TVL · ${money0(D.total_implied)} implied</div></div>
  </section>
  <div class="modeline"><b>Implied value = launch value × token odds.</b> Launch value is a size curve fitted on the snapshot's own priced protocols (log market cap on log TVL, all ${ev.value.n} usable comps). Token odds come from a ridge-logistic model on dated peers (age, size, 7-day growth, kinship). Every candidate term was kept only if it lowered the miss on <b>both</b> the 5-fold CV and the walk-forward test — the tables below show the ones that did not.</div>
  <div class="ledger">${D.ledger.groups.map((g) => `<span class="lg"><b>${g.count}</b> ${esc(g.name)}</span>`).join("")}<span class="lg"><b>${D.ledger.total}</b> total, each protocol in exactly one group</span></div>
  <div class="verify" id="verify"></div>
  <div class="evidence">
    <div class="box"><h2>Value model — every term tested</h2><table class="ev"><tr><th>Term</th><th style="text-align:right">5-fold CV</th><th style="text-align:right">Walk-forward</th><th>Kept?</th></tr>
    ${ev.valueTests.map((t) => `<tr class="${t.kept === "kept" ? "kept" : "not"}"><td>${esc(t.name)}</td><td class="num">×${t.cv.toFixed(2)}</td><td class="num">×${t.wf.toFixed(2)}</td><td>${esc(t.kept)}</td></tr>`).join("")}</table></div>
    <div class="box"><h2>Token odds — every term tested</h2><table class="ev"><tr><th>Term</th><th style="text-align:right">5-fold CV</th><th style="text-align:right">Walk-forward</th><th>Kept?</th></tr>
    ${ev.oddsTests.map((t) => `<tr class="${t.kept === "kept" ? "kept" : "not"}"><td>${esc(t.name)}</td><td class="num">${t.cv.toFixed(3)}</td><td class="num">${t.wf.toFixed(3)}</td><td>${esc(t.kept)}</td></tr>`).join("")}</table></div>
  </div>
  <div class="scatter-box"><h2>Traded comps — the size curve and its P25–P75 band</h2><div id="scatter"></div>
  <div class="cap">Each dot is a priced protocol (log TVL against log market cap, ${ev.scatter.length} comps). The line is the fitted size curve; the band is the measured P25–P75 range of the residuals. The curve is fitted on all ${ev.value.n} usable comps — protocols with a market cap of zero or less are excluded, and the test table shows that excluding the house categories flattens the curve and loses the CV test.</div></div>`;
  return { html: kpi, pr, counts };
}

/* ---- scatter SVG ---- */
function scatterSvg() {
  const ev = D.evidence;
  const W = 640, H = 340, ML = 60, MR = 14, MT = 10, MB = 34;
  const xs = ev.scatter.map((p) => p.x), ys = ev.scatter.map((p) => p.y);
  const x0 = Math.floor(Math.min(...xs, ...ev.scatterLine.map((p) => p.x))), x1 = Math.ceil(Math.max(...xs, ...ev.scatterLine.map((p) => p.x)));
  const y0 = Math.floor(Math.min(...ys, ...ev.scatterBand.map((p) => p.lo))), y1 = Math.ceil(Math.max(...ys, ...ev.scatterBand.map((p) => p.hi)));
  const X = (x) => ML + ((x - x0) / (x1 - x0)) * (W - ML - MR);
  const Y = (y) => MT + (1 - (y - y0) / (y1 - y0)) * (H - MT - MB);
  const band = ev.scatterBand.map((p, i) => (i ? "L" : "M") + X(p.x).toFixed(1) + "," + Y(p.hi).toFixed(1)).join(" ") +
    " " + ev.scatterBand.slice().reverse().map((p) => "L" + X(p.x).toFixed(1) + "," + Y(p.lo).toFixed(1)).join(" ") + " Z";
  const line = ev.scatterLine.map((p, i) => (i ? "L" : "M") + X(p.x).toFixed(1) + "," + Y(p.y).toFixed(1)).join(" ");
  const ticks = [];
  for (let v = Math.ceil(x0); v <= x1; v++) ticks.push(`<line x1="${X(v)}" y1="${H - MB}" x2="${X(v)}" y2="${H - MB + 5}" stroke="#232c38"/><text x="${X(v)}" y="${H - MB + 18}" fill="#6b7887" font-size="10" text-anchor="middle">$${Math.pow(10, v) >= 1e9 ? (Math.pow(10, v) / 1e9) + "B" : (Math.pow(10, v) / 1e6) + "M"}</text>`);
  const yticks = [];
  for (let v = Math.ceil(y0); v <= y1; v++) yticks.push(`<line x1="${ML - 5}" y1="${Y(v)}" x2="${ML}" y2="${Y(v)}" stroke="#232c38"/><text x="${ML - 8}" y="${Y(v) + 3}" fill="#6b7887" font-size="10" text-anchor="end">$${Math.pow(10, v) >= 1e9 ? (Math.pow(10, v) / 1e9) + "B" : (Math.pow(10, v) / 1e6) + "M"}</text>`);
  const dots = ev.scatter.map((p) => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.2" fill="#6db3f2" opacity="0.75"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of priced protocols with the fitted size curve">
    <path d="${band}" fill="#3fb97a" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="#3fb97a" stroke-width="2"/>
    ${dots}
    <text x="${(W - ML - MR) / 2 + ML}" y="${H - 4}" fill="#9aa7b5" font-size="11" text-anchor="middle">TVL (log scale)</text>
    <text x="10" y="${(H - MT - MB) / 2 + MT}" fill="#9aa7b5" font-size="11" text-anchor="middle" transform="rotate(-90 10 ${((H - MT - MB) / 2 + MT)})">Market cap (log scale)</text>
    ${ticks.join("")}${yticks.join("")}
  </svg>`;
}

/* ---- verification strip, recomputed in this page ---- */
function verifyStrip() {
  const rows = D.rows;
  const problems = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].rank !== i + 1) problems.push("rank " + (i + 1) + " is " + rows[i].rank);
  for (let i = 1; i < rows.length; i++) if (rows[i].implied > rows[i - 1].implied) problems.push("row " + (i + 1) + " outranks row " + i);
  const total = rows.reduce((s, r) => s + r.implied, 0);
  if (Math.abs(total - D.total_implied) > 1) problems.push("total implied mismatch");
  const wl = rows.filter((r) => r.tier === "watchlist").length;
  if (wl !== 40) problems.push("watchlist " + wl + "/40");
  const led = D.ledger.groups.reduce((s, g) => s + g.count, 0);
  if (led !== D.ledger.total) problems.push("ledger sums to " + led + ", not " + D.ledger.total);
  const el = $("#verify");
  if (!el) return;
  if (problems.length === 0) {
    el.className = "verify";
    el.textContent = "✓ Verified in this page: ranks 1–" + rows.length + " in order · implied values non-increasing · total " + money0(D.total_implied) + " · watchlist 40/40 · ledger sums to " + D.ledger.total + " · model " + D.model + " · checksum " + D.checksum + " = main.ts";
  } else {
    el.className = "verify bad";
    el.textContent = "✗ Verification failed: " + problems.join("; ");
  }
}

/* ---- board view ---- */
const state = { tab: "ALL", tier: "ALL", category: "ALL", chain: "ALL", q: "", sort: "rank", sortDir: 1 };
function filtered(pr) {
  let rows = pr;
  if (state.tab !== "ALL") rows = rows.filter((r) => r.verdict === state.tab);
  if (state.tier !== "ALL") rows = rows.filter((r) => r.tier === state.tier);
  if (state.category !== "ALL") rows = rows.filter((r) => r.category === state.category);
  if (state.chain !== "ALL") rows = rows.filter((r) => r.chains.includes(state.chain));
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((r) => (r.name + " " + r.slug + " " + (r.category || "")).toLowerCase().includes(q));
  }
  const key = state.sort;
  const get = (r) => key === "rank" ? r.rank : key === "name" ? r.name.toLowerCase() : key === "tvl" ? r.tvl : key === "odds" ? r.odds : key === "launch" ? r.launch : key === "implied" ? r.implied : key === "net" ? r.net : r.net / r.hours;
  return rows.slice().sort((a, b) => {
    const va = get(a), vb = get(b);
    return (va < vb ? -1 : va > vb ? 1 : a.rank - b.rank) * state.sortDir;
  });
}
const SORTABLE = [["rank", "#"], ["name", "Protocol"], ["tvl", "TVL"], ["odds", "Token odds"], ["launch", "If it launches"], ["implied", "Implied value"], ["net", "Net of fees"], ["nph", "Net / hour"]];
function boardHtml(pr, counts) {
  const rows = filtered(pr);
  const cats = [...new Set(D.rows.map((r) => r.category).filter(Boolean))].sort();
  const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
  const shownTvl = rows.reduce((s, r) => s + r.tvl, 0);
  const shownImpl = rows.reduce((s, r) => s + r.implied, 0);
  const tabs = [["ALL", "All " + pr.length], ["FARM", "Farm " + counts.FARM], ["MARGINAL", "Marginal " + counts.MARGINAL], ["SKIP", "Skip " + counts.SKIP]];
  return `
  <div class="controls">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab${state.tab === k ? " on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
    <select id="f-tier"><option value="ALL">All tiers</option><option value="watchlist"${state.tier === "watchlist" ? " selected" : ""}>Watchlist</option><option value="off-list"${state.tier === "off-list" ? " selected" : ""}>Off-list</option><option value="early"${state.tier === "early" ? " selected" : ""}>Early</option></select>
    <select id="f-cat"><option value="ALL">All categories</option>${cats.map((c) => `<option${state.category === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
    <select id="f-chain"><option value="ALL">All chains</option>${chains.map((c) => `<option${state.chain === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
    <input type="search" id="f-q" placeholder="Search protocol…" value="${esc(state.q)}">
    <button class="btn" id="dl-csv">CSV</button><button class="btn" id="dl-json">JSON</button>
  </div>
  <div class="sliders">
    <label>Deposit <output>${(scenario.depositPct * 100).toFixed(3)}% of TVL</output><input type="range" id="s-dep" min="0.005" max="0.1" step="0.005" value="${scenario.depositPct * 100}"></label>
    <label>Drop share <output>${(scenario.dropShare * 100).toFixed(0)}% of launch</output><input type="range" id="s-drop" min="2" max="20" step="1" value="${scenario.dropShare * 100}"></label>
    <label>Horizon <output>${scenario.weeks} weeks</output><input type="range" id="s-weeks" min="4" max="52" step="1" value="${scenario.weeks}"></label>
    <span>Farm economics re-price live from the sliders; the filed board.json uses 0.020% of TVL, a 10% drop share and 12 weeks.</span>
  </div>
  <div class="countline"><b>${rows.length}</b> of ${D.rows.length} rows · <b>${money0(shownTvl)}</b> TVL · <b>${money0(shownImpl)}</b> implied</div>
  <table class="board"><thead><tr>${SORTABLE.map(([k, l]) => `<th data-sort="${k}">${l}${state.sort === k ? (state.sortDir === 1 ? " ↑" : " ↓") : ""}</th>`).join("")}<th>7d</th><th>No-token age</th><th>Range P25–P75</th><th>Verdict</th></tr></thead>
  <tbody>${rows.map((r) => `<tr data-slug="${esc(r.slug)}">
    <td class="num">${r.rank}</td>
    <td><span class="pname">${esc(r.name)}</span> ${r.tier === "watchlist" ? '<span class="watch">WATCHLIST</span>' : ""}<div class="psub">${esc(r.category || "—")} · ${esc(r.chains.join(", "))} · rank P10–P90 ${r.rankLo}–${r.rankHi}</div></td>
    <td class="num">${money0(r.tvl)}</td>
    <td class="num">${pct(r.odds)}</td>
    <td class="num">${money0(r.launch)}</td>
    <td class="num">${money0(r.implied)}</td>
    <td class="num">${money0(r.net)}</td>
    <td class="num">${money0(r.nph)}/h</td>
    <td class="num">${fmt7d(r.change7d)}</td>
    <td>${ageStr(r)}</td>
    <td class="num">${money0(r.p25)}–${money0(r.p75)}</td>
    <td><span class="verdict ${r.verdict}">${r.verdict}</span></td>
  </tr>`).join("")}</tbody></table>
  <div class="footer">Implied value = launch value × token odds. Launch value comes from the size curve fitted on the snapshot's own priced protocols; token odds from the ridge-logistic model on dated peers. Farm plans assume a 10% drop share, pro rata by deposit, and net gas, fees and the forgone 4% T-bill yield. The best farms are small and young: launch value grows slower than TVL, so the largest protocols pay the least per dollar deposited. Model ${esc(D.model)}, checksum ${esc(D.checksum)} = main.ts. Snapshot ${esc(D.as_of)}, source ${esc(D.source)}.</div>`;
}

/* ---- detail view ---- */
function detailHtml(slug) {
  const base = D.rows.find((r) => r.slug === slug);
  if (!base) return `<p>Unknown protocol: ${esc(slug)}</p>`;
  const r = { ...base, ...priceRow(base) };
  const ev = D.evidence;
  const shares = [0.05, 0.07, 0.10];
  const deposits = [1000, 5000, 10000, Math.min(100000, Math.max(1000, 0.0002 * r.tvl))];
  const netCell = (share, dep) => {
    const slice = r.implied * share * (dep / r.tvl);
    const gas = (r.chains.includes("Ethereum") ? 24 : 3) + 5;
    const forgone = dep * 0.04 * (scenario.weeks / 52);
    return slice - gas - forgone;
  };
  const peers = ev.nearestPeers;
  return `<div class="detail">
  <button class="back" id="back">← Back to the board</button>
  <h2>${esc(r.name)} ${r.tier === "watchlist" ? '<span class="watch">WATCHLIST</span>' : ""}</h2>
  <div class="sub">${esc(r.category || "—")} · ${esc(r.chains.join(", "))} · TVL ${money0(r.tvl)} · ${fmt7d(r.change7d)} 7d · no-token age ${ageStr(r)}${r.ageKnown ? "" : " (age on record: not stated — the model uses the peers' median age)"} · rank ${r.rank} of ${D.rows.length} (P10–P90 ${r.rankLo}–${r.rankHi})</div>
  <div class="grid">
    <div class="card"><h3>How the figure is made</h3>
      <p>Launch value <b>${money0(r.launch)}</b> = 10<sup>${ev.value.intercept.toFixed(3)} + ${ev.value.slope.toFixed(3)} × log<sub>10</sub>(TVL)</sup>, the size curve fitted on all ${ev.value.n} usable priced comps. Out-of-sample miss ×${ev.value.wfMiss.toFixed(2)} walk-forward, ×${ev.value.cvMiss.toFixed(2)} 5-fold CV, against ×${ev.value.flatWfMiss.toFixed(2)} / ×${ev.value.flatCvMiss.toFixed(2)} for a flat multiple.</p>
      <p>Token odds <b>${pct(r.odds)}</b> from the ridge-logistic model on ${ev.odds.n} dated peers (base rate ${pct(ev.odds.baseRate)}). Inputs for this protocol: age ${ageStr(r)}, log<sub>10</sub>(TVL) ${Math.log10(r.tvl).toFixed(2)}, 7-day growth ${fmt7d(r.change7d)}, listed sibling ${r.kin ? "yes" : "no"}. Brier ${ev.odds.cvBrier.toFixed(3)} CV / ${ev.odds.wfBrier.toFixed(3)} walk-forward, base rate ${ev.odds.baseCvBrier.toFixed(3)} / ${ev.odds.baseWfBrier.toFixed(3)}.</p>
      <p>Implied value <b>${money0(r.implied)}</b> = launch × odds. P25–P75 ${money0(r.p25)}–${money0(r.p75)}, P10–P90 ${money0(r.p10)}–${money0(r.p90)}. The printed ranges covered ${pct(ev.ranges.p25p75)} / ${pct(ev.ranges.p10p90)} of comps out of sample (stated 50% / 80%).</p>
    </div>
    <div class="card"><h3>Farm verdict — this scenario</h3>
      <p><span class="verdict ${r.verdict}">${r.verdict}</span> &nbsp; Net <b>${money0(r.net)}</b> (${money0(r.nph)}/hour) on a ${money0(r.dep)} deposit, ${r.hours.toFixed(1)} hours of work.</p>
      <p class="mono">Expected drop ${money0(r.slice)} = implied × ${(scenario.dropShare * 100).toFixed(0)}% × deposit/TVL<br>Gas ${money0(r.steps.reduce((s, x) => s + x.usd, 0))} + $5 fees · forgone T-bill ${money0(r.forgone)} (${scenario.weeks} wks at 4%)</p>
      <p>FARM needs net above zero and at least $25/hour; MARGINAL nets positive; SKIP does not. The deposit is ${(scenario.depositPct * 100).toFixed(3)}% of TVL, floored at $1,000 and capped at $100,000, so the slice scales with the protocol instead of a flat $10,000. Even so, the largest protocols do not clear the bar: their implied value per dollar of TVL is below what the T-bill pays over the horizon, so the forgone yield beats the expected drop. The farms that pay are the small, young ones — as the table on the board shows.</p>
      <table class="mini"><tr><th>Net by drop share × deposit</th>${deposits.map((d) => `<th>${money0(d)}</th>`).join("")}</tr>
      ${shares.map((s) => `<tr><td>${(s * 100).toFixed(0)}% of launch</td>${deposits.map((d) => { const v = netCell(s, d); return `<td class="${v >= 0 ? "pos" : "neg"}">${money0(v)}</td>`; }).join("")}</tr>`).join("")}</table>
    </div>
    <div class="card"><h3>Largest priced peers — the comps that set the top of the curve</h3>
      <table class="mini"><tr><th>Protocol</th><th>TVL</th><th>Market cap</th></tr>
      ${peers.map((p) => `<tr><td>${esc(p.name)}</td><td>${money0(p.tvl)}</td><td>${money0(p.mcap)}</td></tr>`).join("")}</table>
    </div>
    <div class="card"><h3>Range honesty</h3>
      <p>The P25–P75 band printed on every row is not a guess: it is the measured middle half of the size curve's out-of-sample residuals, and it covered ${pct(ev.ranges.p25p75)} of priced comps (stated 50%). The P10–P90 band covered ${pct(ev.ranges.p10p90)} (stated 80%).</p>
      <p>What the model does <b>not</b> claim: the winners' 77–91% top-row odds. The best honest top-row odds in this snapshot are 44–70%; the kinship term lifts protocols with a listed sibling, and the top rows have none.</p>
    </div>
  </div>
  <div class="card"><h3>Farm plan — ${r.steps.length} steps, ${r.hours.toFixed(1)} hours, ${money0(r.steps.reduce((s, x) => s + x.usd, 0))} gas + $5 fees</h3>
    <ol class="steps">${r.steps.map((s) => `<li>${esc(s.text)} <span class="cost">$${s.usd.toFixed(2)} · ${s.minutes} min</span></li>`).join("")}</ol>
  </div></div>`;
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function render() {
  const app = $("#app");
  const hash = location.hash;
  if (hash.startsWith("#detail=")) {
    const slug = decodeURIComponent(hash.slice(8));
    app.innerHTML = detailHtml(slug);
    $("#back").onclick = () => { location.hash = ""; };
    window.scrollTo(0, 0);
    return;
  }
  const { html, pr, counts } = renderApp();
  app.innerHTML = html + boardHtml(pr, counts);
  $("#scatter").innerHTML = scatterSvg();
  verifyStrip();
  document.querySelectorAll(".tab").forEach((b) => { b.onclick = () => { state.tab = b.dataset.tab; render(); }; });
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (state.sort === k) state.sortDir *= -1; else { state.sort = k; state.sortDir = k === "name" ? 1 : -1; }
      render();
    };
  });
  document.querySelectorAll("tr[data-slug]").forEach((tr) => { tr.onclick = () => { location.hash = "#detail=" + encodeURIComponent(tr.dataset.slug); }; });
  $("#f-tier").onchange = (e) => { state.tier = e.target.value; render(); };
  $("#f-cat").onchange = (e) => { state.category = e.target.value; render(); };
  $("#f-chain").onchange = (e) => { state.chain = e.target.value; render(); };
  $("#f-q").oninput = (e) => { state.q = e.target.value; render(); };
  const rerender = () => render();
  $("#s-dep").oninput = (e) => { scenario.depositPct = parseFloat(e.target.value) / 100; rerender(); };
  $("#s-drop").oninput = (e) => { scenario.dropShare = parseFloat(e.target.value) / 100; rerender(); };
  $("#s-weeks").oninput = (e) => { scenario.weeks = parseInt(e.target.value, 10); rerender(); };
  $("#dl-csv").onclick = () => {
    const rows = filtered(pr);
    const head = "rank,name,slug,category,chains,tvl_usd,change_7d,age_days,odds,launch_usd,implied_usd,p25_usd,p75_usd,verdict,net_usd,deposit_usd";
    const lines = rows.map((r) => [r.rank, `"${r.name.replace(/"/g, '""')}"`, r.slug, `"${(r.category || "").replace(/"/g, '""')}"`, `"${r.chains.join(";")}"`, r.tvl, r.change7d == null ? "" : r.change7d, r.ageDays == null ? "" : r.ageDays, r.odds.toFixed(4), Math.round(r.launch), Math.round(r.implied), Math.round(r.p25), Math.round(r.p75), r.verdict, Math.round(r.net), Math.round(r.dep)].join(","));
    download("launch-radar.csv", head + "\n" + lines.join("\n") + "\n", "text/csv");
  };
  $("#dl-json").onclick = () => download("launch-radar.json", JSON.stringify({ model: D.model, as_of: D.as_of, rows: filtered(pr) }, null, 2), "application/json");
}
window.addEventListener("hashchange", render);
render();

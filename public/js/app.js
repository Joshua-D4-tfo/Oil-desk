import { computeSignals, BENCHMARKS, crackSeries } from "./engine.js";

// Refresh cadence per source (milliseconds). The CDN caches each endpoint for a similar period.
const SOURCES = {
  market: { url: "/api/market", every: 60_000 },
  news: { url: "/api/news", every: 5 * 60_000 },
  curve: { url: "/api/curve", every: 15 * 60_000 },
  fundamentals: { url: "/api/fundamentals", every: 30 * 60_000 },
  refining: { url: "/api/refining", every: 5 * 60_000 },
  track: { url: "/api/track", every: 5 * 60_000 },
  analysis: { url: "/api/analysis/brent", every: 15 * 60_000 },
};

const savedBench = (() => { try { return localStorage.getItem("oilDeskBenchmark"); } catch { return null; } })();
const state = { data: {}, loadedAt: {}, errors: {}, horizon: "intraday", newsFilter: "all", signals: null, benchmark: BENCHMARKS[savedBench] ? savedBench : "brent", analysis: {} };
const analysisUrl = () => `/api/analysis/${state.benchmark}`;
const $ = (id) => document.getElementById(id);
const TZ = "Asia/Dubai";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const signed = (x, d = 2) => (x == null || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const usd = (x, d = 2) => (x == null || !Number.isFinite(x) ? "n/a" : "$" + x.toFixed(d));
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const ago = (t) => {
  if (!t) return "n/a";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
const until = (h) => (h < 1 ? `in ${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `in ${h.toFixed(h < 10 ? 1 : 0)} h` : `in ${Math.round(h / 24)} d`);

async function load(name) {
  try {
    const url = name === "analysis" ? analysisUrl() : SOURCES[name].url;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (name === "analysis") state.analysis[url.split("/").pop()] = json;
    else state.data[name] = json;
    state.loadedAt[name] = Date.now();
    delete state.errors[name];
  } catch (e) {
    state.errors[name] = String(e.message || e);
  }
}

async function refresh(names = Object.keys(SOURCES).filter((n) => n !== "analysis")) {
  $("refresh-state").textContent = "Refreshing";
  await Promise.all(names.map(load));
  render();
  const failed = Object.keys(state.errors).filter((n) => n !== "analysis");
  $("refresh-state").textContent = failed.length ? `Partial data (${failed.join(", ")})` : `Live, updated ${timeFmt.format(new Date())}`;
}

// ---------- Rendering ----------

function render() {
  const { market, curve, fundamentals, news, refining } = state.data;
  state.signals = computeSignals({ market, curve, fundamentals, news, refining }, Date.now(), state.benchmark);
  document.querySelectorAll("#bench-switch .tab").forEach((x) => x.classList.toggle("active", x.dataset.b === state.benchmark));
  document.title = `Oil Desk | ${state.signals.benchmarkName} decision support`;
  $("bench-sub").textContent = `${state.signals.benchmarkName} short-term decision support`;
  renderCard("intraday", "Intraday (hours)");
  renderCard("swing", "Swing (1 to 5 days)");
  renderTiles();
  renderReasoning();
  renderNews();
  renderEvents();
  renderFundamentals();
  renderSources();
  renderAnalysis();
  renderTrack();
}

const ICON = { BUY: "▲", "LEAN BUY": "▲", SELL: "▼", "LEAN SELL": "▼", "NO TRADE": "■", WAIT: "⏸" };

function renderCard(h, title) {
  const c = state.signals[h];
  const el = $(`card-${h}`);
  if (!c) { el.innerHTML = `<div class="skeleton">Waiting for price data. If this persists, check the data sources panel.</div>`; return; }
  const tone = c.label === "WAIT" ? "wait" : c.tone;
  const pos = ((c.score + 1) / 2) * 100;
  const p = c.plan;
  const planHtml = p ? `
    <div class="plan ${p.active ? "" : "inactive"}">
      <div><div class="k">${p.active ? "Entry (" + p.direction + ")" : "Reference price"}</div><div class="v">${usd(p.entry)}</div></div>
      <div><div class="k">Stop</div><div class="v">${usd(p.stop)}</div></div>
      <div><div class="k">Target 1 (1R)</div><div class="v">${usd(p.target1)}</div></div>
      <div><div class="k">Target 2 (2R)</div><div class="v">${usd(p.target2)}</div></div>
    </div>
    <p class="one-liner muted small">Risk ${usd(p.riskPerBbl)} per barrel (${fmt(p.riskPct)}%), sized on ${p.basis}.${p.sizeMultiplier != null ? ` Volatility-adjusted size: ${Math.round(p.sizeMultiplier * 100)}% of normal.` : ""} ${p.active ? "" : "Shown for reference only: no trade is suggested."}</p>` : "";
  const warn = c.riskEvents.length
    ? `<div class="warn"><span class="ico">⚠</span><span>Event risk inside the holding window: ${c.riskEvents.map((e) => `${esc(e.name)} (${until(e.hoursAway)})`).join("; ")}.</span></div>` : "";
  el.innerHTML = `
    <div class="sig-head">
      <div>
        <div class="sig-title">${title} · ${state.signals.benchmarkName}</div>
        <div class="badge ${tone}"><span class="ico" aria-hidden="true">${ICON[c.label] || ""}</span>${c.label}</div>
        ${c.label !== c.underlying ? `<div class="underlying">Underlying reading: ${c.underlying}</div>` : ""}
      </div>
      <div class="conviction"><div class="big">${c.confidence}</div><div class="lbl">conviction / 100</div></div>
    </div>
    <div>
      <div class="meter" title="Composite score ${signed(c.score)}">
        <div class="track"></div><div class="mid"></div><div class="marker" style="left:${pos}%"></div>
      </div>
      <div class="meter-labels"><span>Sell (-1)</span><span>Composite ${signed(c.score)}</span><span>Buy (+1)</span></div>
    </div>
    ${planHtml}
    ${warn}
    <p class="one-liner">${esc(c.reasoning[1] || "")}</p>`;
}

function sparkline(bars, id) {
  if (!bars || bars.length < 2) return "";
  const pts = bars.slice(-120);
  const w = 300, hgt = 44, pad = 3;
  const lo = Math.min(...pts.map((b) => b.c)), hi = Math.max(...pts.map((b) => b.c));
  const x = (i) => pad + (i / (pts.length - 1)) * (w - 2 * pad);
  const y = (v) => hgt - pad - ((v - lo) / (hi - lo || 1)) * (hgt - 2 * pad);
  const d = pts.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.c).toFixed(1)}`).join("");
  sparkData[id] = { pts, x, y, w };
  return `<svg class="spark" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" data-spark="${id}" aria-label="Price over the last five trading days">
    <path d="${d}" fill="none" stroke="var(--series)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle class="spark-dot" r="4" fill="var(--series)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
  </svg>`;
}
const sparkData = {};

function tile(name, val, chgPct, extra, time, sparkBars, id, selected = false) {
  const cls = chgPct == null ? "" : chgPct >= 0 ? "up" : "down";
  return `<div class="tile${selected ? " sel" : ""}">
    <div class="name"><span>${name}</span><span class="muted">${extra || ""}</span></div>
    <div class="val">${val}</div>
    <div class="chg">${chgPct == null ? "&nbsp;" : `<span class="${cls}">${signed(chgPct)}% 24h</span>`}</div>
    ${sparkline(sparkBars, id)}
    <div class="time">${time || ""}</div>
  </div>`;
}

function renderTiles() {
  const s = state.signals;
  const m = state.data.market;
  const b = s.technicals.brent, w = s.technicals.wti;
  const dxy = m?.dxy?.ok ? m.dxy.data : null;
  const bk = state.benchmark;
  const cb = state.data.curve?.[bk]?.ok ? state.data.curve[bk].data : null;
  const dxyBars = dxy?.bars || [];
  const dxyChg = dxyBars.length > 24 ? ((dxy.price - dxyBars[dxyBars.length - 24].c) / dxyBars[dxyBars.length - 24].c) * 100 : null;
  const html = [
    tile("Brent (front month)", usd(b?.price), b?.ret24h, "ICE", b ? `Quote ${ago(b.priceTime)} · delayed` : "Unavailable", m?.brent?.data?.bars, "brent", bk === "brent"),
    tile("WTI (front month)", usd(w?.price), w?.ret24h, "NYMEX", w ? `Quote ${ago(w.priceTime)} · delayed` : "Unavailable", m?.wti?.data?.bars, "wti", bk === "wti"),
    tile("Brent minus WTI", s.brentWtiSpread == null ? "n/a" : usd(s.brentWtiSpread), null, "spread", "Wider spread favours US exports", null, "bw"),
    tile(`${BENCHMARKS[bk].name} M1 to M2`, cb ? signed(cb.spread) : "n/a", null, cb ? `${cb.m1.label} / ${cb.m2.label}` : "", cb ? (cb.spread > 0 ? "Backwardation (tight)" : "Contango (loose)") : "Unavailable",
      cb ? cb.history.map((h) => ({ c: h.spread })) : null, "spread"),
    tile("US dollar index", fmt(dxy?.price), dxyChg, "DXY", dxy ? `Quote ${ago(dxy.priceTime)}` : "Unavailable", dxyBars, "dxy"),
    crackTile(),
    ovxTile(),
  ].join("");
  $("tiles").innerHTML = html;
}

function renderReasoning() {
  const c = state.signals[state.horizon];
  if (!c) { $("reasoning-text").innerHTML = "<p class='muted'>No signal yet.</p>"; $("factor-rows").innerHTML = ""; return; }
  $("reasoning-text").innerHTML = c.reasoning.map((p) => `<p>${esc(p)}</p>`).join("");
  const maxAbs = Math.max(0.05, ...c.rows.map((r) => Math.abs(r.contribution)));
  $("factor-rows").innerHTML = c.rows.map((r) => {
    const width = (Math.abs(r.contribution) / maxAbs) * 50;
    return `<tr>
      <td>${esc(r.name)}</td>
      <td>${esc(r.reading)}</td>
      <td>${esc(r.explanation)}</td>
      <td class="num">${signed(r.score)}</td>
      <td class="num">${Math.round(r.weight * 100)}%</td>
      <td><div class="contrib" title="${esc(r.name)}: score ${signed(r.score)} x weight ${Math.round(r.weight * 100)}% = ${signed(r.contribution, 3)}">
        <div class="cbar"><div class="zero"></div><div class="fill ${r.contribution >= 0 ? "pos" : "neg"}" style="width:${width}%"></div></div>
        <span class="n">${signed(r.contribution, 3)}</span></div></td>
    </tr>`;
  }).join("");
}

function renderNews() {
  const d = state.signals.newsDetail;
  if (!d) { $("news-list").innerHTML = "<li class='muted'>No headlines loaded.</li>"; $("news-summary").textContent = ""; return; }
  $("news-summary").textContent = `${d.recentCount} headlines in the last 24 hours: ${d.bullishCount} bullish, ${d.bearishCount} bearish, ${d.eventRiskCount} flagged as event risk. Scores are keyword-based; open the article before acting on any single headline.`;
  const f = state.newsFilter;
  const list = d.scored.filter((n) => f === "all" || (f === "bull" && n.score > 0.5) || (f === "bear" && n.score < -0.5) || (f === "event" && n.eventRisk)).slice(0, 80);
  $("news-list").innerHTML = list.map((n) => `<li>
      <div class="score-chip ${n.score > 0.5 ? "pos" : n.score < -0.5 ? "neg" : ""}" title="Keyword score: positive is bullish for crude">${signed(n.score, 1)}</div>
      <div>
        <div class="title"><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
        <div class="meta">${esc(n.source)} · ${ago(n.published)}${n.decay < 0.1 ? " · too old to count" : ""}</div>
        <div>${n.hits.map((h) => `<span class="tag">${esc(h.tag)} ${signed(h.w, 1)}</span>`).join("")}${n.eventRisk ? `<span class="tag risk">Event risk</span>` : ""}</div>
      </div></li>`).join("") || "<li class='muted'>Nothing matches this filter.</li>";
}

function renderEvents() {
  $("events-list").innerHTML = state.signals.events.slice(0, 9).map((e) => `<li>
    <span><span class="impact ${e.impact}">${e.impact}</span>${esc(e.name)}</span>
    <span class="when">${dayFmt.format(new Date(e.t))}${e.approx ? " (approx.)" : ""}<br><span class="muted small">${until(e.hoursAway)}</span></span></li>`).join("");
}

function renderFundamentals() {
  const f = state.data.fundamentals;
  const parts = [];
  const e = f?.eia?.ok ? f.eia.data : null;
  if (e) {
    const row = (id) => {
      const s = e[id]; if (!s) return "";
      return `<span class="k">${esc(s.name)}</span><span class="v">${(s.value / 1000).toFixed(1)}m (${signed(s.change / 1000, 1)}m; seasonal ${signed(s.fiveYrAvgChange / 1000, 1)}m)</span>`;
    };
    parts.push(`<div class="kv"><h3>EIA inventories, week to ${esc(e.WCESTUS1?.period)}</h3>${["WCESTUS1", "W_EPC0_SAX_YCUOK_MBBL", "WGTSTUS1", "WDISTUS1", "WCSSTUS1"].map(row).join("")}</div>`);
  } else parts.push(`<p class="muted small">EIA inventories unavailable: ${esc(f?.eia?.error || "not loaded")}</p>`);
  const c = f?.cot?.ok ? f.cot.data : null;
  if (c) {
    parts.push(`<div class="kv"><h3>CFTC managed money, WTI, ${esc(c.date)}</h3>
      <span class="k">Net position</span><span class="v">${c.net.toLocaleString("en-US")}</span>
      <span class="k">Weekly change</span><span class="v">${signed(c.weeklyChange, 0)}</span>
      <span class="k">Three-year percentile</span><span class="v">${fmt(c.percentile3y, 0)}</span>
      <span class="k">Three-year range</span><span class="v">${c.min3y.toLocaleString("en-US")} to ${c.max3y.toLocaleString("en-US")}</span></div>`);
  } else parts.push(`<p class="muted small">CFTC positioning unavailable: ${esc(f?.cot?.error || "not loaded")}</p>`);
  const cb = state.data.curve?.[state.benchmark]?.ok ? state.data.curve[state.benchmark].data : null;
  if (cb) parts.push(`<div class="kv"><h3>${BENCHMARKS[state.benchmark].name} curve</h3>${cb.curve.map((k) => `<span class="k">${esc(k.label)}</span><span class="v">${usd(k.price)}</span>`).join("")}</div>`);
  $("fundamentals").innerHTML = parts.join("");
}

function renderSources() {
  const rows = [];
  const add = (r) => r && rows.push(`<li><span class="${r.ok ? "ok" : "fail"}">${esc(r.source)}</span><span class="muted">${r.ok ? "" : esc(r.error).slice(0, 60)}</span></li>`);
  const { market, curve, fundamentals, news } = state.data;
  const refining = state.data.refining;
  [market?.brent, market?.wti, market?.dxy, curve?.brent, curve?.wti, fundamentals?.eia, fundamentals?.cot, refining?.gasoline, refining?.heatingOil, refining?.ovx].forEach(add);
  (news?.feeds || []).forEach(add);
  for (const [n, err] of Object.entries(state.errors)) rows.push(`<li><span class="fail">/api/${esc(n)}</span><span class="muted">${esc(err)}</span></li>`);
  $("sources").innerHTML = rows.join("") || "<li class='muted'>Loading...</li>";
}

function renderAnalysis() {
  const a = state.analysis[state.benchmark];
  const panel = $("ai-panel");
  if (!a || a.enabled === false) { panel.hidden = true; return; }
  panel.hidden = false;
  $("ai-meta").textContent = a.error ? "Unavailable this cycle" : `${a.model} · ${ago(a.generatedAt)}`;
  $("ai-text").textContent = a.error ? `The written analysis could not be generated: ${a.error}` : a.text;
}

function crackTile() {
  const f = state.signals.factors.find((x) => x.id === "crack");
  const r = state.data.refining;
  const crude = state.data.market?.[state.benchmark]?.ok ? state.data.market[state.benchmark].data : null;
  const cs = crackSeries(crude, r?.gasoline?.ok ? r.gasoline.data : null, r?.heatingOil?.ok ? r.heatingOil.data : null);
  return tile(`3-2-1 crack vs ${BENCHMARKS[state.benchmark].name}`, f ? usd(f.crack) : "n/a", null, "$/bbl",
    f ? (f.score > 0.25 ? "Margins strong: supportive" : f.score < -0.25 ? "Margins weak: a drag" : "Margins near average") : "Unavailable",
    cs ? cs.series : null, "crack");
}

function ovxTile() {
  const g = state.signals.regime;
  const o = state.data.refining?.ovx?.ok ? state.data.refining.ovx.data : null;
  return tile("Oil volatility (OVX)", g ? fmt(g.ovx, 1) : "n/a", null, "CBOE",
    g ? `${Math.round(g.percentile6m)}th pct (6m) \u00B7 size ${Math.round(g.sizeMultiplier * 100)}%` : "Unavailable",
    o ? o.bars : null, "ovx");
}

const FACTOR_NAMES = { composite: "Composite score", trend: "Short-term trend", momentum: "Momentum", rsi: "RSI", news: "News flow", curve: "Futures curve", inventories: "Inventories", positioning: "Positioning", dollar: "Dollar", crack: "Refining margin" };
const pct = (x) => (x == null ? "n/a" : `${Math.round(x)}%`);

function renderTrack() {
  const el = $("track");
  const t = state.data.track;
  if (!t || t.empty) {
    el.innerHTML = `<p class="muted">No track record yet. Once the site is published, a background job logs the signals every 15 minutes. The first simulated trades close within hours; meaningful statistics need a few weeks.</p>`;
    return;
  }
  const bm = t.benchmarks?.[state.benchmark];
  if (!bm) { el.innerHTML = ""; return; }
  const name = BENCHMARKS[state.benchmark].name;
  const col = (h, title) => {
    const d = bm[h];
    const s = d.stats;
    const few = s.trades < 30;
    const open = d.open ? `<p class="small">Open: <strong>${esc(d.open.label)}</strong> ${d.open.direction} from ${usd(d.open.entry)} (stop ${usd(d.open.stop)}, target ${usd(d.open.target)}), opened ${ago(d.open.opened)}${d.open.markR != null ? `, currently ${signed(d.open.markR)}R` : ""}.</p>` : `<p class="small muted">No simulated trade open.</p>`;
    const rows = d.recent.slice(0, 10).map((r) => `<tr><td>${dayFmt.format(new Date(r.opened))}</td><td>${esc(r.label)}</td><td class="num">${usd(r.entry)}</td><td>${r.outcome === "target" ? "Target" : r.outcome === "stop" ? "Stop" : "Time exit"}</td><td class="num">${signed(r.r)}R</td></tr>`).join("");
    return `<div class="track-col">
      <h3>${title} \u00B7 ${name}</h3>
      <div class="kpis">
        <div><div class="k">Closed trades</div><div class="v">${s.trades}</div></div>
        <div><div class="k">Win rate</div><div class="v">${pct(s.winRate)}</div></div>
        <div><div class="k">Average</div><div class="v">${s.avgR == null ? "n/a" : signed(s.avgR) + "R"}</div></div>
        <div><div class="k">Total</div><div class="v">${signed(s.totalR)}R</div></div>
      </div>
      ${d.equity.length > 1 ? sparkline(d.equity, "eq-" + h) + `<p class="muted small">Cumulative result in R (multiples of the amount risked per trade).</p>` : ""}
      <p class="small">Strong signals: ${d.strong.trades} trades, ${pct(d.strong.winRate)} wins, ${d.strong.avgR == null ? "n/a" : signed(d.strong.avgR) + "R"} average. Lean signals: ${d.lean.trades} trades, ${pct(d.lean.winRate)} wins, ${d.lean.avgR == null ? "n/a" : signed(d.lean.avgR) + "R"} average.</p>
      ${few ? `<p class="small warn-text">Fewer than 30 closed trades: treat these figures as anecdotal, not evidence.</p>` : ""}
      ${open}
      ${rows ? `<div class="table-wrap"><table class="factors compact"><thead><tr><th>Opened</th><th>Signal</th><th class="num">Entry</th><th>Outcome</th><th class="num">Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    </div>`;
  };
  const factorRows = (h) => bm[h].factors.map((f) => {
    const cell = (x) => x.n ? `${pct(x.hitRate)} <span class="muted">(${x.n}, ${signed(x.avgRetPct)}%)</span>` : `<span class="muted">none</span>`;
    return `<tr${f.name === "composite" ? ' class="hl"' : ""}><td>${esc(FACTOR_NAMES[f.name] || f.name)}</td><td class="num">${f.n}</td><td class="num">${f.corr == null ? "n/a" : signed(f.corr)}</td><td>${cell(f.bull)}</td><td>${cell(f.bear)}</td></tr>`;
  }).join("");
  const fh = state.horizon;
  el.innerHTML = `
    <p class="muted small">Logging since ${t.firstRun ? dayFmt.format(new Date(t.firstRun)) : "n/a"}; last run ${ago(t.lastRun)}. Each simulated trade risks 1R and takes profit at 1R, so the break-even win rate is 50% before trading costs. Only one trade per benchmark and horizon is open at a time. To review the weights, download both CSV files and share them with Claude.</p>
    <div class="track-grid">${col("intraday", "Intraday")}${col("swing", "Swing")}</div>
    <h3 class="sub-h">Factor reliability \u00B7 ${name} \u00B7 ${fh === "intraday" ? "4-hour" : "48-hour"} forward move</h3>
    <p class="muted small">How often a clearly bullish (score above +0.25) or bearish (below -0.25) reading was followed by a price move in that direction. Hit rate, then (number of readings, average move). Correlation runs from -1 to +1; above about +0.1 with a few hundred readings suggests the factor is genuinely useful. Switch horizon with the tabs in the reasoning panel. ${bm[fh].pending} readings are waiting for their window to pass.</p>
    ${bm[fh].factors.length ? `<div class="table-wrap"><table class="factors compact"><thead><tr><th>Factor</th><th class="num">Readings</th><th class="num">Correlation</th><th>When bullish</th><th>When bearish</th></tr></thead><tbody>${factorRows(fh)}</tbody></table></div>` : `<p class="muted small">No completed readings yet.</p>`}`;
}

// ---------- Interaction ----------

document.addEventListener("mousemove", (ev) => {
  const svg = ev.target.closest?.("svg[data-spark]");
  const tip = $("tooltip");
  document.querySelectorAll(".spark-dot").forEach((d) => { if (!svg || !svg.contains(d)) d.setAttribute("visibility", "hidden"); });
  if (!svg) { tip.hidden = true; return; }
  const sd = sparkData[svg.dataset.spark];
  if (!sd) return;
  const rect = svg.getBoundingClientRect();
  const rel = ((ev.clientX - rect.left) / rect.width) * sd.w;
  let i = Math.round(((rel - 3) / (sd.w - 6)) * (sd.pts.length - 1));
  i = Math.max(0, Math.min(sd.pts.length - 1, i));
  const p = sd.pts[i];
  const dot = svg.querySelector(".spark-dot");
  dot.setAttribute("cx", sd.x(i)); dot.setAttribute("cy", sd.y(p.c)); dot.setAttribute("visibility", "visible");
  tip.hidden = false;
  tip.textContent = `${p.t ? dayFmt.format(new Date(p.t)) + "  " : ""}${fmt(p.c)}`;
  tip.style.left = `${ev.clientX + 12}px`;
  tip.style.top = `${ev.clientY - 30}px`;
});

document.querySelectorAll(".tabs .tab[data-h]").forEach((b) => b.addEventListener("click", () => {
  state.horizon = b.dataset.h;
  document.querySelectorAll(".tab[data-h]").forEach((x) => x.classList.toggle("active", x === b));
  renderReasoning();
  renderTrack();
}));
document.querySelectorAll("#news-filter .tab").forEach((b) => b.addEventListener("click", () => {
  state.newsFilter = b.dataset.f;
  document.querySelectorAll("#news-filter .tab").forEach((x) => x.classList.toggle("active", x === b));
  renderNews();
}));
document.querySelectorAll("#bench-switch .tab").forEach((b) => b.addEventListener("click", () => {
  if (state.benchmark === b.dataset.b) return;
  state.benchmark = b.dataset.b;
  try { localStorage.setItem("oilDeskBenchmark", state.benchmark); } catch {}
  render();
  if (!state.analysis[state.benchmark]) load("analysis").then(renderAnalysis);
}));
$("refresh-btn").addEventListener("click", () => refresh(Object.keys(SOURCES)));

// ---------- Schedule ----------

function tickClock() { $("clock").textContent = `Dubai ${timeFmt.format(new Date())}`; }
tickClock();
setInterval(tickClock, 15_000);

refresh().then(() => load("analysis").then(renderAnalysis));
for (const [name, s] of Object.entries(SOURCES)) {
  setInterval(() => (document.hidden ? null : refresh([name])), s.every);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - (state.loadedAt.market || 0) > 60_000) refresh();
});

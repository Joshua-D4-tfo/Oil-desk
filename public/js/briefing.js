// Daily briefing view: renders the briefings written each morning by the GitHub Action.
// Data is static JSON under /briefings/.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const signed = (x, d = 2) => (x == null || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));

const DIR = {
  bullish: { label: "Bullish", cls: "bull", icon: "▲" },
  bearish: { label: "Bearish", cls: "bear", icon: "▼" },
  neutral: { label: "Neutral", cls: "neutral", icon: "■" },
  mixed: { label: "Mixed", cls: "neutral", icon: "◆" },
  unclear: { label: "Unclear", cls: "neutral", icon: "?" },
};
const VER = {
  confirmed: { label: "Confirmed", icon: "✔", cls: "ver-ok", tip: "Primary source, or two or more independent reputable outlets" },
  reported: { label: "Reported", icon: "○", cls: "ver-rep", tip: "Reported by one reputable outlet" },
  unconfirmed: { label: "Unconfirmed", icon: "⚠", cls: "ver-un", tip: "Unnamed sources, single lower-quality outlet, social media, or not corroborated" },
};
const STRENGTH = { "-2": "strongly bearish", "-1": "moderately bearish", "0": "neutral", "1": "moderately bullish", "2": "strongly bullish" };
const verdictText = (d, s) => (d === "neutral" || !s ? (DIR[d]?.label || "Neutral") : `${DIR[d]?.label}, ${STRENGTH[String(s)]}`);

const chip = (dir) => { const x = DIR[dir] || DIR.neutral; return `<span class="dchip ${x.cls}"><span aria-hidden="true">${x.icon}</span> ${x.label}</span>`; };
const verChip = (v) => { const x = VER[v] || VER.unconfirmed; return `<span class="vchip ${x.cls}" title="${esc(x.tip)}"><span aria-hidden="true">${x.icon}</span> ${x.label}</span>`; };
const sources = (list) => (list?.length
  ? `<div class="srcs">${list.length > 1 ? "Sources" : "Source"}: ${list.map((s) => `<a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.publisher ? `${s.publisher}: ` : "")}${esc(s.title || s.url)}</a>`).join("; ")}</div>`
  : `<div class="srcs muted">No verifiable source</div>`);

const state = { index: null, consensus: null, current: null, cache: {} };

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function initBriefing() {
  try {
    [state.index, state.consensus] = await Promise.all([getJson("/briefings/index.json"), getJson("/briefings/consensus.json").catch(() => null)]);
  } catch {
    $("briefing-main").innerHTML = `<div class="panel"><h2>No briefings yet</h2><p class="muted">The first briefing is written by the GitHub Action called "Daily oil briefing". It runs every morning at 05:45 Dubai time once the <code>ANTHROPIC_API_KEY</code> secret has been added to the GitHub repository. It can also be run immediately from the repository's Actions tab.</p></div>`;
    $("briefing-side").innerHTML = "";
    return;
  }
  renderSide();
  await show(state.index.latest);
}

async function show(date) {
  if (!date) return;
  state.current = date;
  const b = state.cache[date] || (state.cache[date] = await getJson(`/briefings/${date}.json`));
  renderBriefing(b);
  document.querySelectorAll("#archive-list li").forEach((li) => li.classList.toggle("active", li.dataset.date === date));
}

function renderBriefing(b) {
  const px = b.meta?.prices || {};
  const priceBits = ["brent", "wti"].filter((k) => px[k]?.price).map((k) =>
    `<span><strong>${k === "brent" ? "Brent" : "WTI"}</strong> $${px[k].price.toFixed(2)} <span class="muted">${signed(px[k].chg24hPct)}% 24h · ${signed(px[k].chg7dPct)}% 7d</span></span>`).join("");
  const v = b.verdict || {};
  const devs = (b.developments || []).map((d) => `
    <article class="dev ${d.impact === "high" ? "high" : ""}">
      <div class="dev-tags">${chip(d.direction)}${verChip(d.verification)}<span class="tagx">${esc(d.category || "Other")}</span><span class="tagx">${esc(d.impact || "medium")} impact</span>${d.follow_up_of_previous ? `<span class="tagx upd">Update</span>` : ""}</div>
      <h3>${esc(d.title)}</h3>
      <p>${esc(d.summary)}</p>
      <p class="why"><strong>Why it matters:</strong> ${esc(d.why_it_matters)}</p>
      ${d.verification_note ? `<p class="small warn-text">${esc(d.verification_note)}</p>` : ""}
      ${sources(d.sources)}
    </article>`).join("") || `<p class="muted">No material developments in the period.</p>`;
  const list = (items, fmtItem) => (items?.length ? items.map(fmtItem).join("") : "");
  const releases = list(b.data_releases, (d) => `<div class="li"><div><strong>${esc(d.name)}:</strong> ${esc(d.result)}${d.vs_expectation ? ` <span class="muted">(${esc(d.vs_expectation)})</span>` : ""} ${chip(d.direction)}</div>${sources(d.sources)}</div>`);
  const analysts = list(b.analyst_views, (a) => `<div class="li"><div><strong>${esc(a.who)}:</strong> ${esc(a.view)} ${chip(a.direction)}</div>${sources(a.sources)}</div>`);
  const s = b.public_sentiment;
  const when = (x) => { const t = Date.parse(x); return Number.isFinite(t) && /\d{4}-\d{2}-\d{2}T/.test(x) ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Dubai", weekday: "short", hour: "2-digit", minute: "2-digit" }) + " Dubai" : x; };
  const watch = list(b.watch_today, (w) => `<li><strong>${esc(w.item)}</strong> <span class="muted">(${esc(when(w.when_utc))})</span>: ${esc(w.why)}</li>`);
  const vr = b.meta?.verification;

  $("briefing-main").innerHTML = `
    <div class="panel briefing">
      <div class="b-head">
        <div>
          <div class="sig-title">Daily briefing</div>
          <h2 class="b-date">${esc(longDate(b.date))}</h2>
        </div>
        <a class="btn" href="/briefings/docs/oil-briefing-${esc(b.date)}.docx" download>Download this briefing (Word)</a>
      </div>
      ${priceBits ? `<div class="b-prices">${priceBits}</div>` : ""}
      <p class="b-headline">${esc(b.headline)}</p>
      <p>${esc(b.overview)}</p>
      <div class="verdict ${DIR[v.direction]?.cls || "neutral"}">
        <div class="v-label">Verdict for the next 24 hours</div>
        <div class="v-dir">${chip(v.direction)} <strong>${esc(verdictText(v.direction, v.strength))}</strong></div>
        <p>${esc(v.reasoning)}</p>
      </div>
      <h2 class="sec">Developments <span class="muted small">(${(b.developments || []).length}, highest impact first)</span></h2>
      ${devs}
      ${releases ? `<h2 class="sec">Data releases</h2>${releases}` : ""}
      ${analysts ? `<h2 class="sec">Analyst views</h2>${analysts}` : ""}
      ${s ? `<h2 class="sec">Public sentiment <span class="muted small">(opinion, not fact)</span></h2>
        <div class="sentiment"><div>${chip(s.lean)}</div><p>${esc(s.summary)}</p>${s.evidence?.length ? `<ul>${s.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}${s.sources?.length ? sources(s.sources) : ""}</div>` : ""}
      ${watch ? `<h2 class="sec">What to watch</h2><ul class="watch">${watch}</ul>` : ""}
      ${vr ? `<p class="muted small foot-note">Verification: ${vr.kept} cited sources matched to pages retrieved during research; ${vr.removed} unmatched link(s) removed${vr.downgraded?.length ? `; ${vr.downgraded.length} item(s) downgraded or dropped` : ""}. Generated ${new Date(b.meta.generatedAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })} (Dubai) using ${b.meta.searches ?? "n/a"} web searches.</p>` : ""}
    </div>`;
}

function consensusCard(label, x, s) {
  if (!x) return "";
  const pos = ((Math.max(-2, Math.min(2, x.strength || 0)) + 2) / 4) * 100;
  const drivers = (arr, cls, title) => (arr?.length ? `<div class="drv ${cls}"><div class="drv-h">${title}</div><ul>${arr.map((d) => `<li>${esc(d.driver)}${d.dates?.length ? ` <span class="muted small">(${d.dates.map(shortDate).join(", ")})</span>` : ""}</li>`).join("")}</ul></div>` : "");
  return `<div class="panel cons">
    <div class="cons-head"><h2>${label}</h2><span class="muted small">${esc(x.confidence || "")} confidence${s ? ` · ${s.briefings} briefing(s)` : ""}</span></div>
    <div class="v-dir">${chip(x.direction)} <strong>${esc(verdictText(x.direction, x.strength))}</strong></div>
    <div class="meter small-meter"><div class="track"></div><div class="mid"></div><div class="marker" style="left:${pos}%"></div></div>
    <p>${esc(x.summary)}</p>
    ${drivers(x.bullish_drivers, "pos", "Bullish drivers")}
    ${drivers(x.bearish_drivers, "neg", "Bearish drivers")}
    <p><strong>How the narrative changed:</strong> ${esc(x.narrative_shift)}</p>
    <p><strong>Prices versus evidence:</strong> ${esc(x.price_vs_evidence)}</p>
    ${x.key_risks?.length ? `<p><strong>Key risks to the view:</strong></p><ul>${x.key_risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    <p><strong>What would change it:</strong> ${esc(x.what_would_change_it)}</p>
    ${s?.directionalVerdicts ? `<p class="muted small">Daily verdicts in this period: ${s.correct} of ${s.directionalVerdicts} directional calls matched Brent's next-day move.</p>` : ""}
  </div>`;
}

function renderSide() {
  const c = state.consensus;
  const sc = c?.stats?.scorecard || [];
  const cons = c?.week
    ? consensusCard("Past week", c.week, c.stats?.week) + consensusCard("Past month", c.month, c.stats?.month) +
      (c.stale ? `<p class="small warn-text">The consensus could not be refreshed this morning; showing the previous version.</p>` : "")
    : `<div class="panel"><p class="muted">Consensus not yet available.</p></div>`;
  const rows = sc.slice(0, 14).map((r) => `<tr><td>${esc(shortDate(r.date))}</td><td>${chip(r.verdict)}</td><td class="num">${r.changePct == null ? "<span class='muted'>pending</span>" : signed(r.changePct) + "%"}</td><td class="num">${r.hit == null ? "" : r.hit ? "<span class='ok-mark'>✔ Right</span>" : "<span class='bad-mark'>✖ Wrong</span>"}</td></tr>`).join("");
  const archive = (state.index?.briefings || []).map((b) => `<li data-date="${esc(b.date)}"><button type="button">${esc(shortDate(b.date))}</button><span class="arch-h">${esc(b.headline)}</span>${b.verdict ? chip(b.verdict.direction) : ""}</li>`).join("");
  $("briefing-side").innerHTML = `
    ${cons}
    <div class="panel">
      <div class="panel-head"><h2>Verdict scorecard</h2><span class="muted small">Brent, briefing to next briefing</span></div>
      ${rows ? `<div class="table-wrap"><table class="factors compact"><thead><tr><th>Date</th><th>Verdict</th><th class="num">Brent move</th><th class="num">Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted small">Scores appear from the second briefing onwards.</p>`}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Archive</h2><a class="btn" href="/briefings/${esc(state.index?.archiveDocx || "docs/oil-briefing-archive.docx")}" download>Download all (Word)</a></div>
      <p class="muted small">Briefings are kept for ${state.index?.retentionDays ?? 60} days, then deleted.</p>
      <ul class="archive" id="archive-list">${archive}</ul>
    </div>`;
  document.querySelectorAll("#archive-list li").forEach((li) => li.querySelector("button").addEventListener("click", () => show(li.dataset.date)));
}

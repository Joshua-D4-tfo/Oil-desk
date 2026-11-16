// Oil Desk signal engine.
// Pure functions only (no DOM, no network) so the browser and the server-side AI analysis
// use exactly the same logic. Every factor returns its reading, a score between -1 (bearish)
// and +1 (bullish), and a plain-language explanation of why it scored that way.

// ---------- Configuration you may want to edit ----------

// Weights per horizon. They are renormalised over whichever factors have data.
export const WEIGHTS = {
  intraday: { trend: 0.24, momentum: 0.18, rsi: 0.08, news: 0.22, curve: 0.10, inventories: 0.06, positioning: 0.04, dollar: 0.08, crack: 0.05 },
  swing:    { trend: 0.14, momentum: 0.08, rsi: 0.04, news: 0.16, curve: 0.20, inventories: 0.16, positioning: 0.14, dollar: 0.08, crack: 0.10 },
};

// WTI is priced at Cushing, Oklahoma, so US inventory data matters more for it than for Brent.
// These weights replace the defaults when WTI is selected.
export const WEIGHTS_WTI = {
  intraday: { trend: 0.24, momentum: 0.18, rsi: 0.08, news: 0.18, curve: 0.10, inventories: 0.10, positioning: 0.04, dollar: 0.08, crack: 0.05 },
  swing:    { trend: 0.14, momentum: 0.08, rsi: 0.04, news: 0.14, curve: 0.18, inventories: 0.22, positioning: 0.12, dollar: 0.08, crack: 0.10 },
};

// Volatility regime. Position size is scaled by OVX_BASELINE / current OVX (never above 100%).
export const OVX_BASELINE = 35;

export const BENCHMARKS = {
  brent: { key: "brent", name: "Brent", exchange: "ICE", note: "Global seaborne benchmark" },
  wti: { key: "wti", name: "WTI", exchange: "NYMEX", note: "US crude, priced at Cushing" },
};

export const THRESHOLDS = { strong: 0.30, lean: 0.12 };

// One-off scheduled events. Add or correct dates here. Times in UTC.
export const STATIC_EVENTS = [
  { name: "OPEC+ ministerial meeting (2027 production framework)", utc: "2026-11-29T12:00:00Z", impact: "high", approx: true },
  { name: "US Federal Reserve (FOMC) rate decision", utc: "2026-12-09T19:00:00Z", impact: "medium", approx: false },
];

// ---------- Small maths helpers ----------

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const tanh = Math.tanh;
const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const signed = (x, d = 2) => (x == null || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const usd = (x, d = 2) => (x == null || !Number.isFinite(x) ? "n/a" : "$" + x.toFixed(d));
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th");
const mb = (kb) => (kb == null ? "n/a" : (kb / 1000 >= 0 ? "+" : "") + (kb / 1000).toFixed(1) + "m bbl");

export function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(values, n = 14) {
  if (values.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function atr(bars, n = 14) {
  if (bars.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let a = tr.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

export function toDaily(bars) {
  const map = new Map();
  for (const b of bars) {
    const k = new Date(b.t).toISOString().slice(0, 10);
    const d = map.get(k);
    if (!d) map.set(k, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    else { d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); d.c = b.c; }
  }
  return [...map.values()];
}

function changeOver(bars, hours, price) {
  const target = bars.at(-1).t - hours * 3600 * 1000;
  let ref = null;
  for (const b of bars) { if (b.t <= target) ref = b; else break; }
  if (!ref) return null;
  return ((price - ref.c) / ref.c) * 100;
}

export function technicals(chart) {
  if (!chart || !chart.bars || chart.bars.length < 60) return null;
  const bars = chart.bars;
  const closes = bars.map((b) => b.c);
  const price = chart.price ?? closes.at(-1);
  const daily = toDaily(bars);
  const last20 = daily.slice(-20);
  return {
    price,
    priceTime: chart.priceTime,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    rsi14: rsi(closes, 14),
    atrH: atr(bars, 14),
    atrD: atr(daily, Math.min(14, daily.length - 1)),
    ret24h: changeOver(bars, 24, price),
    ret5d: changeOver(bars, 24 * 5, price),
    high20d: Math.max(...last20.map((d) => d.h)),
    low20d: Math.min(...last20.map((d) => d.l)),
    sessions: daily.length,
  };
}

// ---------- News scoring ----------
// Positive weight = bullish for crude, negative = bearish. Rules are checked in order and
// each tag is counted once per headline. Price-move headlines get a small weight because
// they describe what already happened rather than what is about to.

export const NEWS_RULES = [
  { tag: "Hormuz reopening", w: -2.0, re: /hormuz\b.*\b(reopen|re-open|resum|restor|recover|normali|safe passage|deal)|\b(reopen|re-open|resum|restor|normali)\w*\b.*\bhormuz/i },
  { tag: "De-escalation or ceasefire", w: -2.0, re: /\b(ceasefire|cease-fire|truce|peace (deal|talks|agreement|plan)|de-?escalat|armistice)/i },
  { tag: "Hormuz disruption", w: 2.0, re: /hormuz\b.*\b(clos|block|shut|halt|mine|threat|disrupt|seiz|attack)/i },
  { tag: "Attack on oil infrastructure", w: 2.0, re: /\b(attack|strike|struck|drone|missile|hit|explosion|ablaze|fire)\w*\b.*\b(tanker|refiner\w*|pipeline|terminal|oil port|export port|facility|oilfield|oil field|platform|depot)/i },
  { tag: "Attack on oil infrastructure", w: 2.0, re: /\b(tanker|refiner\w*|pipeline|terminal|oilfield|oil field|depot)\b.*\b(attack|struck|hit by|ablaze|explosion|on fire)/i },
  { tag: "Escalation", w: 1.5, re: /\b(escalat|retaliat|airstrike|air strike|invasion|mobiliz)/i },
  { tag: "Supply outage", w: 1.5, re: /\b(outage|shut-?in|force majeure|halt\w* (production|output|exports|loadings)|production (halt|stoppage)|supply disruption)/i },
  { tag: "Saudi price increase to buyers", w: 1.0, re: /\b(rais|hik|increas|lift)\w*\b.*\b(osp|official selling price|prices? (for|to) asia)/i },
  { tag: "Saudi price cut to buyers", w: -1.0, re: /\b(cut|lower|reduc|slash)\w*\b.*\b(osp|official selling price|prices? (for|to) asia)/i },
  { tag: "OPEC+ restraint", group: "opec", w: 1.5, re: /^(?!.*(osp|selling price|rate cut)).*\b(opec\+?|saudi|russia|riyadh)\b.*\b(cut|curb|reduc|paus|delay|extend\w* cuts|halt\w* (increase|hike))/i },
  { tag: "OPEC+ holds output steady", group: "opec", w: 0.3, re: /^(?!.*(osp|selling price)).*\b(opec\+?)\b.*\b(hold|keep|kept|steady|unchanged|maintain)/i },
  { tag: "Higher OPEC or Gulf supply", group: "opec", w: -1.5, re: /^(?!.*(osp|selling price|prices? (for|to) asia)).*\b(opec\+?|saudi|uae|abu dhabi|adnoc|aramco|kazakhstan|iraq|kuwait)\b.*\b(rais|boost|increas|hik|add|unwind|restor|ramp|lift)\w*\b.*\b(output|production|supply|exports|quota|target|barrels)/i },
  { tag: "Sanctions relief", w: -1.2, re: /(\b(lift|eas|waiv|relax|suspend)\w*\b.*\bsanction|sanctions? (relief|waiver|eased|lifted))/i },
  { tag: "New or tighter sanctions", w: 1.0, re: /^(?!.*(lift|eas|waiv|relief|relax)).*\b(sanction\w*|blacklist\w*|designat\w*)\b.*\b(oil|tanker|crude|refiner|shadow fleet|exports)/i },
  { tag: "Strategic reserve release", w: -1.2, re: /(\bspr\b|strategic (petroleum )?reserve|emergency (oil )?stocks?).*\b(release|sale|sell|tap|draw|loan)/i },
  { tag: "Strategic reserve refill", w: 0.8, re: /(\bspr\b|strategic (petroleum )?reserve).*\b(refill|buy|purchas|replenish)/i },
  { tag: "Inventory draw", w: 1.0, re: /\b(stockpiles?|inventor(y|ies)|stocks?)\b.*\b(fell|fall|falls|drop|declin|draw|lowest)|\b(draw|drawdown)\b.*\b(crude|stocks?|inventor)/i },
  { tag: "Inventory build", w: -1.0, re: /\b(stockpiles?|inventor(y|ies)|stocks?)\b.*\b(rose|rise|rises|climb|jump|build|swell|highest)|\bbuild\b.*\b(crude|stocks?|inventor)/i },
  { tag: "Supply recovery", w: -1.2, re: /\b(flows?|exports?|shipments?|loadings|production|output|transits?)\b.*\b(recover|resum|restor|rebound|return|rise|pick up|picks up|normal)/i },
  { tag: "Glut or surplus", w: -1.5, re: /\b(glut|surplus|oversuppl|over-suppl)/i },
  { tag: "Demand weakness", w: -1.0, re: /\b(recession|slowdown|weak\w* demand|demand (concern|worr|slump|destruction|fears)|tariff|trade war)/i },
  { tag: "Demand support", w: 0.6, re: /\b(stimulus|strong demand|demand (recover|rebound|surge|growth)|record (imports|demand)|imports? (hit|hits|at|reach\w*) (a )?record)/i },
  { tag: "Tight market", w: 1.0, re: /\b(shortage|tight\w* (market|supply|supplies)|supply (crunch|squeeze|deficit)|deficit)/i },
  { tag: "Price up (lagging)", group: "price", w: 0.4, re: /^(?!.*(inventor|stockpile|stocks)).*\b(oil|crude|brent|wti)\b.*\b(rise|rises|rose|jump|surge|climb|gain|rall|soar|spike|higher)/i },
  { tag: "Price down (lagging)", group: "price", w: -0.4, re: /^(?!.*(inventor|stockpile|stocks)).*\b(oil|crude|brent|wti)\b.*\b(fall|falls|fell|drop|slid|slide|slip|slump|tumbl|declin|plung|sink|lower|retreat|eas(e|es|ed))/i },
];

const EVENT_RISK_RE = /\b(opec\+? (meeting|ministerial|talks)|talks|negotiat|deadline|ultimatum|vote|summit|decision (due|expected))/i;

export function scoreHeadline(title) {
  const hits = [];
  const seen = new Set();
  for (const r of NEWS_RULES) {
    if (seen.has(r.tag) || (r.group && seen.has("group:" + r.group))) continue;
    if (r.re.test(title)) {
      hits.push({ tag: r.tag, w: r.w });
      seen.add(r.tag);
      if (r.group) seen.add("group:" + r.group);
    }
  }
  let score = hits.reduce((s, h) => s + h.w, 0);
  score = clamp(score, -3, 3);
  return { score, hits, eventRisk: EVENT_RISK_RE.test(title) };
}

export function scoreNews(items, now = Date.now()) {
  const halfLifeH = 8;
  const scored = (items || []).map((it) => {
    const s = scoreHeadline(it.title);
    const ageH = it.published ? Math.max(0, (now - it.published) / 3.6e6) : 24;
    const decay = ageH > 48 ? 0 : Math.pow(0.5, ageH / halfLifeH);
    return { ...it, ...s, ageH, decay, weighted: s.score * decay };
  });
  const recent = scored.filter((s) => s.ageH <= 24);
  const net = scored.reduce((sum, s) => sum + s.weighted, 0);
  const tagTotals = {};
  for (const s of scored) for (const h of s.hits) tagTotals[h.tag] = (tagTotals[h.tag] || 0) + h.w * s.decay;
  return {
    scored,
    net,
    recentCount: recent.length,
    bullishCount: recent.filter((s) => s.score > 0.5).length,
    bearishCount: recent.filter((s) => s.score < -0.5).length,
    eventRiskCount: recent.filter((s) => s.eventRisk).length,
    tagTotals: Object.entries(tagTotals).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
  };
}

// ---------- Event calendar ----------

function nyOffsetHours(date) {
  // Hours New York is behind UTC on a given date (5 in winter, 4 in summer).
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false, day: "numeric" }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  let diff = date.getUTCHours() - h;
  if (diff < 0) diff += 24;
  return diff;
}

function nextWeekdayNY(now, weekday, hour, minute) {
  for (let add = 0; add < 8; add++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + add, 12));
    if (d.getUTCDay() !== weekday) continue;
    const off = nyOffsetHours(d);
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour + off, minute));
    if (t > now) return t;
  }
  return null;
}

export function upcomingEvents(now = new Date()) {
  const ev = [
    { name: "API weekly inventory estimate", t: nextWeekdayNY(now, 2, 16, 30), impact: "medium" },
    { name: "EIA Weekly Petroleum Status Report", t: nextWeekdayNY(now, 3, 10, 30), impact: "high" },
    { name: "Baker Hughes US rig count", t: nextWeekdayNY(now, 5, 13, 0), impact: "low" },
    { name: "CFTC Commitments of Traders", t: nextWeekdayNY(now, 5, 15, 30), impact: "low" },
  ];
  // Saudi Aramco OSPs: usually around the 5th of each month (date varies).
  const osp = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + (now.getUTCDate() > 5 ? 1 : 0), 5, 10));
  ev.push({ name: "Saudi Aramco official selling prices (approximate date)", t: osp, impact: "medium", approx: true });
  for (const s of STATIC_EVENTS) ev.push({ name: s.name, t: new Date(s.utc), impact: s.impact, approx: s.approx });
  return ev
    .filter((e) => e.t && e.t > now)
    .map((e) => ({ ...e, t: e.t.getTime(), hoursAway: (e.t - now) / 3.6e6 }))
    .sort((a, b) => a.t - b.t);
}

// ---------- Factors ----------

function factorTrend(tb) {
  if (!tb || tb.ema20 == null || tb.ema50 == null || !tb.atrH) return null;
  const a = clamp((tb.price - tb.ema20) / (0.75 * tb.atrH));
  const b = clamp((tb.ema20 - tb.ema50) / (1.0 * tb.atrH));
  const score = 0.5 * a + 0.5 * b;
  const pos = tb.price >= tb.ema20 ? "above" : "below";
  const stack = tb.ema20 >= tb.ema50 ? "above" : "below";
  let read;
  if (score > 0.4) read = "The short-term trend is up: price is trading above its 20-hour average, which is itself above the 50-hour average. Trend-following favours longs.";
  else if (score < -0.4) read = "The short-term trend is down: price is below its 20-hour average, which sits below the 50-hour average. Trend-following favours shorts or standing aside.";
  else read = "The short-term trend is indeterminate: price and its moving averages are close together, which is typical of a range-bound or turning market.";
  return {
    id: "trend", name: "Short-term trend (hourly)", score,
    reading: `Price ${usd(tb.price)} is ${pos} the 20-hour EMA (${usd(tb.ema20)}); 20-hour EMA is ${stack} the 50-hour EMA (${usd(tb.ema50)}).`,
    explanation: read,
  };
}

function factorMomentum(tb) {
  if (!tb || tb.ret24h == null) return null;
  const score = clamp(0.7 * tanh(tb.ret24h / 1.5) + 0.3 * tanh((tb.ret5d ?? 0) / 4));
  const range = tb.high20d - tb.low20d;
  const posInRange = range > 0 ? ((tb.price - tb.low20d) / range) * 100 : null;
  return {
    id: "momentum", name: "Momentum", score,
    reading: `24-hour change ${signed(tb.ret24h)}%, 5-day change ${signed(tb.ret5d)}%. Price sits at ${fmt(posInRange, 0)}% of its 20-day range (${usd(tb.low20d)} to ${usd(tb.high20d)}).`,
    explanation:
      score > 0.3 ? "Recent price action is positive. For short holding periods, momentum tends to persist more often than it reverses."
      : score < -0.3 ? "Recent price action is negative. For short holding periods, selling pressure tends to persist more often than it reverses."
      : "Momentum is weak in either direction and adds little information.",
  };
}

function factorRsi(tb) {
  if (!tb || tb.rsi14 == null) return null;
  const r = tb.rsi14;
  let score = 0;
  if (r > 70) score = -clamp((r - 70) / 15, 0, 1);
  else if (r < 30) score = clamp((30 - r) / 15, 0, 1);
  return {
    id: "rsi", name: "Overbought / oversold (RSI)", score,
    reading: `14-hour RSI is ${fmt(r, 1)}.`,
    explanation:
      r > 70 ? "The market is stretched to the upside. Chasing longs here carries a higher risk of a pullback; this factor is a caution, not a sell signal on its own."
      : r < 30 ? "The market is stretched to the downside. Pressing shorts here carries a higher risk of a bounce; this factor is a caution, not a buy signal on its own."
      : "RSI is in its normal range, so there is no stretch to fade.",
  };
}

function factorCurve(curve, benchmark = "brent") {
  const other = benchmark === "brent" ? "wti" : "brent";
  const key = curve?.[benchmark]?.ok ? benchmark : curve?.[other]?.ok ? other : null;
  if (!key) return null;
  const c = curve[key].data;
  const bench = BENCHMARKS[key].name;
  const fallback = key !== benchmark ? `; ${BENCHMARKS[benchmark].name} curve unavailable` : "";
  const spreadPct = (c.spread / c.m1.price) * 100;
  const hist = c.history || [];
  const ref = hist.length > 5 ? hist[hist.length - 6].spread : hist[0]?.spread;
  const chg5 = ref != null ? c.spread - ref : 0;
  const score = clamp(0.5 * clamp(spreadPct / 1.0) + 0.5 * tanh(chg5 / 0.3));
  const structure = c.spread > 0.05 ? "backwardation" : c.spread < -0.05 ? "contango" : "flat";
  return {
    id: "curve", name: `Futures curve (${bench} M1 to M2${fallback})`, score,
    reading: `${c.m1.label} ${usd(c.m1.price)} versus ${c.m2.label} ${usd(c.m2.price)}: spread ${signed(c.spread)} (${structure}, ${signed(spreadPct)}% of price), ${signed(chg5)} over about five sessions.`,
    explanation:
      structure === "backwardation"
        ? (chg5 >= 0
          ? "Prompt barrels are trading at a premium and that premium is widening. This is the physical market signalling tightness, which is the most reliable bullish confirmation available."
          : "Prompt barrels still trade at a premium, but the premium is narrowing. The market is tight but loosening, so the bullish signal is fading.")
        : structure === "contango"
          ? "Later-dated barrels are dearer than prompt barrels, meaning supply is ample and storage is being rewarded. This is a bearish structure."
          : "The curve is flat, which gives no clear structural signal.",
  };
}

function factorInventories(f) {
  const e = f?.eia?.ok ? f.eia.data : null;
  if (!e || !e.WCESTUS1) return null;
  const crude = e.WCESTUS1;
  const cush = e.W_EPC0_SAX_YCUOK_MBBL;
  const gas = e.WGTSTUS1, dist = e.WDISTUS1;
  const sCrude = crude.changeVsSeasonal != null ? -tanh(crude.changeVsSeasonal / 3000) : 0;
  const prodDev = (gas?.changeVsSeasonal ?? 0) + (dist?.changeVsSeasonal ?? 0);
  const sProd = -tanh(prodDev / 4000);
  const sCush = cush ? (cush.value < 25000 ? 0.6 : cush.value > 40000 ? -0.4 : 0) : 0;
  const sLevel = crude.levelVsFiveYrPct != null ? -clamp(crude.levelVsFiveYrPct / 8) : 0;
  const score = clamp(0.45 * sCrude + 0.25 * sProd + 0.15 * sCush + 0.15 * sLevel);
  return {
    id: "inventories", name: "US inventories (EIA weekly)", score,
    reading:
      `Week to ${crude.period}: commercial crude ${mb(crude.change)} versus a five-year average of ${mb(crude.fiveYrAvgChange)} for the same week; ` +
      `level ${(crude.value / 1000).toFixed(1)}m bbl (${signed(crude.levelVsFiveYrPct, 1)}% versus five-year average). ` +
      (cush ? `Cushing ${(cush.value / 1000).toFixed(1)}m bbl. ` : "") +
      `Gasoline plus distillate ${mb(prodDev)} versus seasonal norm.`,
    explanation:
      score > 0.25 ? "Stocks are drawing faster than is normal for this time of year and/or sit below their five-year average. That points to a tight physical market and supports prices."
      : score < -0.25 ? "Stocks are building faster than is normal for this time of year and/or sit above their five-year average. That points to a looser market and weighs on prices."
      : "Inventory changes are close to seasonal norms, so they neither help nor hurt. Note that this data only updates on Wednesdays.",
  };
}

function factorPositioning(f) {
  const c = f?.cot?.ok ? f.cot.data : null;
  if (!c) return null;
  const p = c.percentile3y;
  const score = p <= 50 ? Math.pow((50 - p) / 50, 1.5) : -Math.pow((p - 50) / 50, 1.5);
  return {
    id: "positioning", name: "Speculative positioning (CFTC, WTI)", score: clamp(score),
    reading: `Managed money net ${c.net >= 0 ? "long" : "short"} ${Math.abs(c.net).toLocaleString("en-US")} contracts (week to ${c.date}), ${signed(c.weeklyChange, 0)} on the week; ${ordinal(Math.round(p))} percentile of the last three years.`,
    explanation:
      p < 20 ? "Hedge funds are unusually bearish. Crowded shorts are fuel for a squeeze if news stops getting worse, so this is a contrarian bullish factor."
      : p > 80 ? "Hedge funds are unusually bullish. Crowded longs leave the market vulnerable to sharp liquidation on any disappointment, so this is a contrarian bearish factor."
      : "Positioning is not at an extreme, so it carries little contrarian information.",
  };
}

function factorDollar(market) {
  const tb = market?.dxy?.ok ? technicals(market.dxy.data) : null;
  if (!tb || tb.ret5d == null) return null;
  const score = -tanh(tb.ret5d / 1.0);
  return {
    id: "dollar", name: "US dollar index", score,
    reading: `Dollar index ${fmt(tb.price)}; 5-day change ${signed(tb.ret5d)}%.`,
    explanation:
      tb.ret5d > 0.3 ? "A firmer dollar makes crude dearer for non-US buyers and tends to weigh on prices. The relationship is real but weaker than it once was."
      : tb.ret5d < -0.3 ? "A softer dollar makes crude cheaper for non-US buyers and tends to support prices. The relationship is real but weaker than it once was."
      : "The dollar is broadly unchanged, so it is not a factor at present.",
  };
}

function factorNews(newsData, now) {
  if (!newsData || !newsData.items || !newsData.items.length) return null;
  const n = scoreNews(newsData.items, now);
  const score = tanh(n.net / 4);
  const topTags = n.tagTotals.slice(0, 3).map(([t, v]) => `${t} (${signed(v, 1)})`).join(", ");
  return {
    id: "news", name: "News flow (last 24 to 48 hours)", score,
    reading: `${n.recentCount} headlines in 24 hours: ${n.bullishCount} bullish, ${n.bearishCount} bearish. Recency-weighted net score ${signed(n.net, 1)}. Dominant themes: ${topTags || "none detected"}.`,
    explanation:
      score > 0.3 ? "The balance of recent headlines points to tighter supply or stronger demand. Newer headlines count for more (eight-hour half-life)."
      : score < -0.3 ? "The balance of recent headlines points to looser supply or weaker demand. Newer headlines count for more (eight-hour half-life)."
      : "Headlines are mixed or neutral. Keyword scoring cannot judge nuance, so read the top headlines yourself before acting.",
    detail: n,
  };
}

// ---------- Refining margins and volatility ----------

// 3-2-1 crack spread in $/bbl: (2 x gasoline + 1 x heating oil - 3 x crude) / 3, products converted at 42 gal/bbl.
export function crackSeries(crudeChart, gasChart, hoChart) {
  if (!crudeChart?.bars?.length || !gasChart?.bars?.length || !hoChart?.bars?.length) return null;
  const hourKey = (t) => Math.round(t / 3.6e6);
  const rb = new Map(gasChart.bars.map((b) => [hourKey(b.t), b.c]));
  const ho = new Map(hoChart.bars.map((b) => [hourKey(b.t), b.c]));
  const series = [];
  for (const b of crudeChart.bars) {
    const k = hourKey(b.t);
    if (rb.has(k) && ho.has(k)) series.push({ t: b.t, c: (2 * rb.get(k) * 42 + ho.get(k) * 42 - 3 * b.c) / 3 });
  }
  if (series.length < 30) return null;
  // Use latest quotes for the current value where available.
  const last = series.at(-1).c;
  const latest = gasChart.price && hoChart.price && crudeChart.price
    ? (2 * gasChart.price * 42 + hoChart.price * 42 - 3 * crudeChart.price) / 3
    : last;
  return { series, latest };
}

function factorCrack(market, refining, benchmark) {
  const crude = market?.[benchmark]?.ok ? market[benchmark].data : null;
  const gas = refining?.gasoline?.ok ? refining.gasoline.data : null;
  const ho = refining?.heatingOil?.ok ? refining.heatingOil.data : null;
  const cs = crackSeries(crude, gas, ho);
  if (!cs) return null;
  const vals = cs.series.map((x) => x.c);
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 1;
  const target = cs.series.at(-1).t - 5 * 24 * 3.6e6;
  let ref = null;
  for (const x of cs.series) { if (x.t <= target) ref = x; else break; }
  const chg5 = ref ? cs.latest - ref.c : 0;
  const z = (cs.latest - mean) / sd;
  const score = clamp(0.5 * clamp(z / 2) + 0.5 * tanh(chg5 / 2.5));
  const name = BENCHMARKS[benchmark]?.name || "crude";
  return {
    id: "crack", name: `Refining margin (3-2-1 crack vs ${name})`, score,
    reading: `Crack spread ${usd(cs.latest)}/bbl versus a one-month average of ${usd(mean)} (${signed(z, 1)} standard deviations); ${signed(chg5)} over five days.`,
    explanation:
      score > 0.25 ? "Refiners earn more than usual for turning crude into gasoline and diesel, so they run harder and keep bidding for crude. Strong and rising margins tend to lead crude prices higher."
      : score < -0.25 ? "Refining margins are weak or falling, so refiners have less reason to buy crude and may cut runs. Weak margins tend to lead crude prices lower."
      : "Refining margins are close to their recent average and give no clear lead on crude demand.",
    crack: cs.latest,
  };
}

export function volRegime(refining) {
  const o = refining?.ovx?.ok ? refining.ovx.data : null;
  if (!o || !o.bars?.length || !Number.isFinite(o.price)) return null;
  const closes = o.bars.map((b) => b.c);
  const below = closes.filter((c) => c < o.price).length;
  const pct = Math.min(100, (below / Math.max(closes.length, 1)) * 100);
  const ref = closes.length > 5 ? closes[closes.length - 6] : closes[0];
  const chg5Pct = ref ? ((o.price - ref) / ref) * 100 : 0;
  const sizeMultiplier = Math.max(0.35, Math.min(1, OVX_BASELINE / o.price));
  const elevated = pct >= 80 || chg5Pct >= 20;
  return {
    ovx: o.price, percentile6m: pct, chg5Pct, sizeMultiplier, elevated,
    convictionMultiplier: elevated ? 0.85 : 1,
    text:
      `Oil volatility (OVX) is ${fmt(o.price, 1)}, ${ordinal(Math.round(pct))} percentile of the last six months and ${signed(chg5Pct, 0)}% over five days. ` +
      (elevated
        ? `Volatility is elevated, so conviction has been reduced by 15% and position size should be cut to about ${Math.round(sizeMultiplier * 100)}% of normal. Stops are already scaled to recent ranges, but gaps through stops are more likely in this regime.`
        : `Suggested position size is ${Math.round(sizeMultiplier * 100)}% of normal (normal size assumes OVX of ${OVX_BASELINE}).`),
  };
}

// ---------- Composite ----------

function classify(s) {
  if (s >= THRESHOLDS.strong) return { label: "BUY", tone: "bull" };
  if (s >= THRESHOLDS.lean) return { label: "LEAN BUY", tone: "bull" };
  if (s <= -THRESHOLDS.strong) return { label: "SELL", tone: "bear" };
  if (s <= -THRESHOLDS.lean) return { label: "LEAN SELL", tone: "bear" };
  return { label: "NO TRADE", tone: "neutral" };
}

function composite(factors, weights, horizon, tb, events, benchName = "Brent", regime = null) {
  const used = factors.filter((f) => f && weights[f.id] != null);
  const wSum = used.reduce((s, f) => s + weights[f.id], 0);
  const totalW = Object.values(weights).reduce((s, w) => s + w, 0);
  if (!used.length || !wSum) return null;
  const rows = used.map((f) => {
    const w = weights[f.id] / wSum;
    return { ...f, weight: w, contribution: f.score * w };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const S = rows.reduce((s, r) => s + r.contribution, 0);
  const absTotal = rows.reduce((s, r) => s + Math.abs(r.contribution), 0) || 1;
  const agreement = rows.filter((r) => Math.sign(r.contribution) === Math.sign(S)).reduce((s, r) => s + Math.abs(r.contribution), 0) / absTotal;
  const coverage = wSum / totalW;

  const windowH = horizon === "intraday" ? 6 : 36;
  const riskEvents = events.filter((e) => e.hoursAway <= windowH && (e.impact === "high" || (horizon === "swing" && e.impact === "medium")));
  const imminent = horizon === "intraday" ? events.find((e) => e.impact === "high" && e.hoursAway <= 2) : null;

  let confidence = 90 * Math.min(1, Math.abs(S) / 0.7) * (0.5 + 0.5 * agreement) * Math.sqrt(coverage);
  if (riskEvents.length) confidence *= 0.7;
  if (regime) confidence *= regime.convictionMultiplier;
  confidence = Math.round(clamp(confidence, 0, 90));

  const cls = classify(S);
  const action = imminent ? { label: "WAIT", tone: "neutral" } : cls;

  // Trade levels, based on the selected benchmark.
  let plan = null;
  if (tb && tb.atrH) {
    const dist = horizon === "intraday" ? 1.5 * tb.atrH : 1.2 * (tb.atrD || tb.atrH * 4.5);
    const dir = S >= 0 ? 1 : -1;
    plan = {
      direction: dir > 0 ? "long" : "short",
      entry: tb.price,
      stop: tb.price - dir * dist,
      target1: tb.price + dir * dist,
      target2: tb.price + dir * 2 * dist,
      riskPerBbl: dist,
      riskPct: (dist / tb.price) * 100,
      basis: horizon === "intraday" ? "1.5 x 14-hour ATR" : "1.2 x daily ATR",
      sizeMultiplier: regime ? regime.sizeMultiplier : null,
      active: cls.label !== "NO TRADE",
    };
  }

  const support = rows.filter((r) => Math.sign(r.contribution) === Math.sign(S) && Math.abs(r.contribution) > 0.005);
  const oppose = rows.filter((r) => Math.sign(r.contribution) !== Math.sign(S) && Math.abs(r.contribution) > 0.005);
  const missing = Object.keys(weights).filter((id) => !used.find((f) => f.id === id));

  const reasoning = buildReasoning({ regime, benchName, horizon, S, cls, action, confidence, agreement, coverage, support, oppose, missing, plan, riskEvents, imminent, tb });

  return { horizon, score: S, label: action.label, tone: action.tone, underlying: cls.label, confidence, agreement, coverage, rows, plan, riskEvents, missing, reasoning };
}

const NAMES = { crack: "refining margins", trend: "short-term trend", momentum: "momentum", rsi: "RSI", news: "news flow", curve: "futures curve", inventories: "inventories", positioning: "positioning", dollar: "dollar" };

function buildReasoning({ regime, benchName, horizon, S, cls, action, confidence, agreement, coverage, support, oppose, missing, plan, riskEvents, imminent, tb }) {
  const h = horizon === "intraday" ? "an intraday (holding period of hours)" : "a short swing (holding period of one to five days)";
  const p = [];
  p.push(`For ${h} trade in ${benchName}, the weighted composite score is ${signed(S)} on a scale of -1 to +1, which maps to ${cls.label}. Conviction is ${confidence} on a 0 to 100 scale (capped at 90, because no model reading justifies certainty). It is not a probability of success; it reflects the size of the score, the degree to which factors agree (${Math.round(agreement * 100)}% of the weighted evidence points the same way) and data coverage (${Math.round(coverage * 100)}% of factor weight available).`);
  if (support.length) {
    p.push(`The case rests mainly on ${support.slice(0, 3).map((r) => `${NAMES[r.id] || r.name} (${signed(r.contribution, 3)})`).join(", ")}. ${support[0].explanation}`);
  }
  if (oppose.length) {
    p.push(`The main evidence against is ${oppose.slice(0, 2).map((r) => `${NAMES[r.id] || r.name} (${signed(r.contribution, 3)})`).join(" and ")}. ${oppose[0].explanation}`);
  } else {
    p.push("No factor currently argues against this view, which is unusual and worth treating with some suspicion: one-sided readings often come late in a move.");
  }
  if (cls.label === "NO TRADE") {
    p.push("The evidence is too balanced to justify a position. Standing aside is a position in its own right; the edge comes from waiting for the factors to align.");
  } else if (plan) {
    p.push(`If taken, a ${plan.direction} from ${usd(plan.entry)} would use a stop at ${usd(plan.stop)} (${plan.basis}, ${fmt(plan.riskPct)}% risk), a first target at ${usd(plan.target1)} (1R) and a second at ${usd(plan.target2)} (2R). The view is invalidated if price reaches the stop or if the ${NAMES[oppose[0]?.id] || "opposing factors"} strengthen further.`);
  }
  if (regime) p.push(regime.text);
  if (imminent) p.push(`Action is WAIT because "${imminent.name}" is due within two hours. Event releases routinely move crude by more than a full stop distance in minutes; it is better to trade the reaction than to gamble on the number.`);
  else if (riskEvents.length) p.push(`Event risk inside the holding window (${riskEvents.map((e) => e.name).join("; ")}) has reduced confidence by 30%. Consider a smaller size or exiting beforehand.`);
  if (missing.length) p.push(`Not available this refresh: ${missing.map((m) => NAMES[m] || m).join(", ")}. The remaining weights were rescaled, which makes the reading less robust.`);
  if (tb?.priceTime && Date.now() - tb.priceTime > 3 * 3600 * 1000) p.push("The latest price is more than three hours old, so the market is probably closed. Treat the levels as indicative until trading resumes.");
  return p;
}

// ---------- Public entry point ----------

export function computeSignals({ market, curve, fundamentals, news, refining }, nowMs = Date.now(), benchmark = "brent") {
  if (!BENCHMARKS[benchmark]) benchmark = "brent";
  const now = new Date(nowMs);
  const tbBrent = market?.brent?.ok ? technicals(market.brent.data) : null;
  const tbWti = market?.wti?.ok ? technicals(market.wti.data) : null;
  const tb = benchmark === "wti" ? tbWti : tbBrent;
  const bench = BENCHMARKS[benchmark];
  const weights = benchmark === "wti" ? WEIGHTS_WTI : WEIGHTS;
  const events = upcomingEvents(now);

  const factors = [
    factorTrend(tb),
    factorMomentum(tb),
    factorRsi(tb),
    factorNews(news, nowMs),
    factorCurve(curve, benchmark),
    factorInventories(fundamentals),
    factorPositioning(fundamentals),
    factorDollar(market),
    factorCrack(market, refining, benchmark),
  ].filter(Boolean);
  const regime = volRegime(refining);

  return {
    generatedAt: nowMs,
    benchmark: bench.key,
    benchmarkName: bench.name,
    technicals: { brent: tbBrent, wti: tbWti },
    brentWtiSpread: tbBrent && tbWti ? tbBrent.price - tbWti.price : null,
    factors,
    events,
    regime,
    factorScores: Object.fromEntries(factors.map((f) => [f.id, +f.score.toFixed(4)])),
    intraday: composite(factors, weights.intraday, "intraday", tb, events, bench.name, regime),
    swing: composite(factors, weights.swing, "swing", tb, events, bench.name, regime),
    newsDetail: factors.find((f) => f.id === "news")?.detail || null,
  };
}

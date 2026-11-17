// Gathers the factual inputs for the daily briefing by calling the site's own Netlify functions
// directly (no deployment URL needed), plus public-sentiment sources. Every source fails softly.
import market from "../../netlify/functions/market.mjs";
import curve from "../../netlify/functions/curve.mjs";
import fundamentals from "../../netlify/functions/fundamentals.mjs";
import news from "../../netlify/functions/news.mjs";
import refining from "../../netlify/functions/refining.mjs";
import { yahooChart } from "../../netlify/shared/yahoo.mjs";
import { computeSignals, upcomingEvents } from "../../public/js/engine.js";

const UA = "Mozilla/5.0 (compatible; OilDeskBriefing/1.0; +https://github.com)";

async function call(fn) {
  try { return await (await fn()).json(); } catch (e) { return { error: String(e.message || e) }; }
}

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// StockTwits: retail traders tag posts Bullish or Bearish. USO is the main crude ETF; CL_F is WTI futures.
async function stocktwits(symbol, since) {
  const j = await getJson(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`);
  const msgs = (j.messages || []).filter((m) => Date.parse(m.created_at) >= since);
  const tag = (m) => m.entities?.sentiment?.basic || null;
  return {
    symbol,
    messages: msgs.length,
    bullish: msgs.filter((m) => tag(m) === "Bullish").length,
    bearish: msgs.filter((m) => tag(m) === "Bearish").length,
    samples: msgs.slice(0, 8).map((m) => ({ tag: tag(m), text: String(m.body || "").replace(/\s+/g, " ").slice(0, 220) })),
  };
}

// Reddit: titles of recent oil-related posts across a few subreddits, with engagement.
async function reddit(since) {
  const url = "https://www.reddit.com/r/oil+energy+commodities+oilandgasworkers+investing/search.json?q=oil%20OR%20crude%20OR%20OPEC%20OR%20Brent&restrict_sr=1&sort=new&t=day&limit=50";
  const j = await getJson(url);
  return (j?.data?.children || [])
    .map((c) => c.data)
    .filter((d) => d && d.created_utc * 1000 >= since)
    .map((d) => ({ subreddit: d.subreddit, title: d.title, score: d.score, comments: d.num_comments, url: `https://www.reddit.com${d.permalink}` }))
    .sort((a, b) => b.score + b.comments - (a.score + a.comments))
    .slice(0, 12);
}

function pctChange(bars, hours, price) {
  if (!bars?.length) return null;
  const target = bars.at(-1).t - hours * 3.6e6;
  let ref = null;
  for (const b of bars) { if (b.t <= target) ref = b; else break; }
  return ref ? ((price - ref.c) / ref.c) * 100 : null;
}

export async function gatherInputs(nowMs = Date.now()) {
  const [m, c, f, n, r] = await Promise.all([call(market), call(curve), call(fundamentals), call(news), call(refining)]);
  const daily = {};
  for (const [k, sym] of [["brent", "BZ=F"], ["wti", "CL=F"]]) {
    try { daily[k] = await yahooChart(sym, "1d", "3mo"); } catch (e) { daily[k] = null; }
  }

  const since = nowMs - 30 * 3600 * 1000;
  const sentiment = { stocktwits: [], reddit: null, errors: [] };
  for (const sym of ["USO", "CL_F"]) {
    try { sentiment.stocktwits.push(await stocktwits(sym, since)); } catch (e) { sentiment.errors.push(`StockTwits ${sym}: ${e.message}`); }
  }
  try { sentiment.reddit = await reddit(since); } catch (e) { sentiment.errors.push(`Reddit: ${e.message}`); }

  const signals = { brent: computeSignals({ market: m, curve: c, fundamentals: f, news: n, refining: r }, nowMs, "brent"),
    wti: computeSignals({ market: m, curve: c, fundamentals: f, news: n, refining: r }, nowMs, "wti") };

  const px = (k) => {
    const d = m?.[k]?.ok ? m[k].data : null;
    if (!d) return null;
    const dd = daily[k];
    const dBars = dd?.bars || [];
    const ago = (n) => (dBars.length > n ? dBars[dBars.length - 1 - n].c : null);
    return {
      price: d.price, priceTime: d.priceTime,
      chg24hPct: pctChange(d.bars, 24, d.price),
      chg7dPct: ago(5) ? ((d.price - ago(5)) / ago(5)) * 100 : pctChange(d.bars, 24 * 7, d.price),
      chg30dPct: ago(21) ? ((d.price - ago(21)) / ago(21)) * 100 : null,
      dailyCloses: dBars.slice(-45).map((b) => ({ date: new Date(b.t).toISOString().slice(0, 10), close: +b.c.toFixed(2) })),
    };
  };

  const headlines = (n?.items || [])
    .filter((i) => !i.published || i.published >= since)
    .slice(0, 40)
    .map((i) => ({ title: i.title, source: i.source, published: i.published ? new Date(i.published).toISOString() : null, url: i.link }));

  return {
    generatedAt: nowMs,
    prices: { brent: px("brent"), wti: px("wti") },
    curve: { brent: c?.brent?.ok ? { m1: c.brent.data.m1, m2: c.brent.data.m2, spread: c.brent.data.spread } : null,
      wti: c?.wti?.ok ? { m1: c.wti.data.m1, m2: c.wti.data.m2, spread: c.wti.data.spread } : null },
    inventories: f?.eia?.ok ? Object.fromEntries(Object.entries(f.eia.data).map(([k, v]) => [k, { name: v.name, period: v.period, valueKb: v.value, changeKb: v.change, fiveYrAvgChangeKb: v.fiveYrAvgChange }])) : null,
    positioning: f?.cot?.ok ? { date: f.cot.data.date, net: f.cot.data.net, weeklyChange: f.cot.data.weeklyChange, percentile3y: f.cot.data.percentile3y } : null,
    crack: signals.brent.factors.find((x) => x.id === "crack")?.reading || null,
    volatility: signals.brent.regime ? { ovx: signals.brent.regime.ovx, percentile6m: signals.brent.regime.percentile6m } : null,
    dashboard: Object.fromEntries(["brent", "wti"].map((k) => [k, {
      intraday: signals[k].intraday ? `${signals[k].intraday.label} (${signals[k].intraday.score.toFixed(2)})` : null,
      swing: signals[k].swing ? `${signals[k].swing.label} (${signals[k].swing.score.toFixed(2)})` : null }])),
    events: upcomingEvents(new Date(nowMs)).slice(0, 8).map((e) => ({ name: e.name, utc: new Date(e.t).toISOString(), approx: !!e.approx })),
    headlines,
    sentiment,
    sourceStatus: {
      market: !!m?.brent?.ok, curve: !!c?.brent?.ok, eia: !!f?.eia?.ok, cot: !!f?.cot?.ok, refining: !!r?.gasoline?.ok,
      newsFeeds: (n?.feeds || []).map((x) => `${x.source}: ${x.ok ? x.count : "failed"}`),
      sentimentErrors: sentiment.errors,
    },
  };
}

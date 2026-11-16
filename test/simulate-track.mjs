// Replays the track-record logic hour by hour over the mock price history.
import { computeSignals } from "../public/js/engine.js";
import { emptyState, snapshotFromSignals, maybeOpenTrades, updateOpenTrades, addPending, resolvePending, buildSummary } from "../netlify/shared/track.mjs";
import { mockMarket, mockCurve, mockFundamentals, mockNews, mockRefining } from "./mock.mjs";

export function simulate(hours = 400) {
  const full = mockMarket(), curve = mockCurve(), fundamentals = mockFundamentals(), news = mockNews(), refining = mockRefining();
  const end = full.brent.data.bars.at(-1).t;
  const state = emptyState();
  const snapshots = [];
  const fwd = {};
  state.firstRun = end - hours * 3.6e6;
  const cut = (chart, t) => { const bars = chart.bars.filter((b) => b.t <= t); return { ...chart, bars, price: bars.at(-1)?.c, priceTime: bars.at(-1)?.t }; };
  for (let t = end - hours * 3.6e6; t <= end; t += 3.6e6) {
    const market = {};
    for (const k of ["brent", "wti", "dxy"]) market[k] = { ok: true, data: cut(full[k].data, t) };
    const ref = { ...refining, gasoline: { ok: true, data: cut(refining.gasoline.data, t) }, heatingOil: { ok: true, data: cut(refining.heatingOil.data, t) } };
    const bars = { brent: market.brent.data.bars, wti: market.wti.data.bars };
    updateOpenTrades(state, bars, t);
    for (const r of resolvePending(state, bars, t)) (fwd[r.id] ||= {})[r.horizon] = r.retPct;
    for (const bm of ["brent", "wti"]) {
      const sig = computeSignals({ market, curve, fundamentals, news: { items: [] }, refining: ref }, t, bm);
      const snap = snapshotFromSignals(sig, t);
      addPending(state, snap);
      snapshots.push(snap);
      maybeOpenTrades(state, sig, t);
    }
    state.runs++; state.lastRun = t;
  }
  return { state, snapshots, fwd, summary: buildSummary(state, end) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { state, summary } = simulate();
  for (const bm of ["brent", "wti"]) for (const h of ["intraday", "swing"]) {
    const d = summary.benchmarks[bm][h];
    console.log(bm, h, JSON.stringify(d.stats), "open:", d.open ? d.open.label + " " + d.open.markR + "R" : "none", "pending:", d.pending);
    console.log("   factors:", d.factors.slice(0, 4).map((f) => `${f.name} n=${f.n} corr=${f.corr} bull=${f.bull.n}/${Math.round(f.bull.hitRate ?? 0)}%`).join(" | "));
  }
  console.log("closed sample:", JSON.stringify(state.closed[0]));
  console.log("outcomes:", state.closed.reduce((a, t) => (a[t.outcome] = (a[t.outcome] || 0) + 1, a), {}));
}

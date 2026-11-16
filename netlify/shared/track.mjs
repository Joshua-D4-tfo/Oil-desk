// Track record logic. Pure functions only, so it can be tested without Netlify.
//
// Two things are measured:
// 1. Simulated trades. When a benchmark/horizon has no open simulated trade and the suggestion is
//    BUY, LEAN BUY, SELL or LEAN SELL, a trade is opened at the suggested entry with the suggested
//    stop and first target. It closes at +1R if the target is hit first, -1R if the stop is hit
//    first (if both fall inside the same hourly bar the stop is assumed, which is conservative),
//    or at the market price when the maximum holding period runs out. One trade at a time per
//    benchmark and horizon, so a signal that persists for hours is not counted many times.
// 2. Factor reliability. Every snapshot records each factor's score. After the forward window
//    (4 hours intraday, 48 hours swing) the price change is measured, and the engine records how
//    often a clearly bullish or bearish reading was followed by a move in that direction.

export const HORIZONS = {
  intraday: { forwardH: 4, maxHoldH: 24 },
  swing: { forwardH: 48, maxHoldH: 120 },
};
export const FACTOR_THRESHOLD = 0.25;
const TRADEABLE = new Set(["BUY", "LEAN BUY", "SELL", "LEAN SELL"]);
const MAX_CLOSED = 600;
const MAX_PENDING = 2000;

export function emptyState() {
  return { version: 1, open: {}, closed: [], pending: [], agg: {}, runs: 0, lastRun: null, lastSnapshot: null };
}

export function snapshotFromSignals(sig, nowMs) {
  const tb = sig.benchmark === "wti" ? sig.technicals.wti : sig.technicals.brent;
  return {
    id: `${sig.benchmark}-${nowMs}`,
    t: nowMs,
    benchmark: sig.benchmark,
    price: tb?.price ?? null,
    priceTime: tb?.priceTime ?? null,
    factorScores: sig.factorScores,
    intraday: sig.intraday ? { label: sig.intraday.label, score: +sig.intraday.score.toFixed(4), conviction: sig.intraday.confidence } : null,
    swing: sig.swing ? { label: sig.swing.label, score: +sig.swing.score.toFixed(4), conviction: sig.swing.confidence } : null,
    ovx: sig.regime?.ovx ?? null,
  };
}

// Opens simulated trades where none is open and the suggestion is tradeable.
export function maybeOpenTrades(state, sig, nowMs) {
  const opened = [];
  for (const h of Object.keys(HORIZONS)) {
    const c = sig[h];
    const key = `${sig.benchmark}:${h}`;
    if (!c || !c.plan || state.open[key] || !TRADEABLE.has(c.label)) continue;
    const p = c.plan;
    const trade = {
      id: `${key}:${nowMs}`,
      key,
      benchmark: sig.benchmark,
      horizon: h,
      label: c.label,
      strength: c.label.startsWith("LEAN") ? "lean" : "strong",
      direction: p.direction,
      score: +c.score.toFixed(4),
      conviction: c.confidence,
      entry: p.entry,
      stop: p.stop,
      target: p.target1,
      risk: p.riskPerBbl,
      opened: nowMs,
      maxHoldUntil: nowMs + HORIZONS[h].maxHoldH * 3.6e6,
      mfeR: 0,
      maeR: 0,
    };
    state.open[key] = trade;
    opened.push(trade);
  }
  return opened;
}

// Walks hourly bars after the trade opened and decides the outcome.
export function evaluateTrade(trade, bars, nowMs) {
  const dir = trade.direction === "long" ? 1 : -1;
  const after = bars.filter((b) => b.t > trade.opened);
  let mfe = trade.mfeR || 0, mae = trade.maeR || 0;
  for (const b of after) {
    const fav = dir > 0 ? (b.h - trade.entry) / trade.risk : (trade.entry - b.l) / trade.risk;
    const adv = dir > 0 ? (b.l - trade.entry) / trade.risk : (trade.entry - b.h) / trade.risk;
    mfe = Math.max(mfe, fav);
    mae = Math.min(mae, adv);
    const hitStop = dir > 0 ? b.l <= trade.stop : b.h >= trade.stop;
    const hitTarget = dir > 0 ? b.h >= trade.target : b.l <= trade.target;
    if (hitStop) return { ...trade, mfeR: r2(mfe), maeR: r2(mae), closed: b.t, exit: trade.stop, outcome: "stop", r: -1 };
    if (hitTarget) return { ...trade, mfeR: r2(mfe), maeR: r2(mae), closed: b.t, exit: trade.target, outcome: "target", r: 1 };
    if (b.t >= trade.maxHoldUntil) {
      const r = (dir * (b.c - trade.entry)) / trade.risk;
      return { ...trade, mfeR: r2(mfe), maeR: r2(mae), closed: b.t, exit: b.c, outcome: "time", r: r2(r) };
    }
  }
  // Still open: mark to market.
  const last = after.at(-1) || bars.at(-1);
  const r = last ? (dir * (last.c - trade.entry)) / trade.risk : 0;
  return { ...trade, mfeR: r2(mfe), maeR: r2(mae), markR: r2(r), markedAt: nowMs };
}

export function updateOpenTrades(state, barsByBenchmark, nowMs) {
  const closedNow = [];
  for (const [key, trade] of Object.entries(state.open)) {
    if (!trade) continue;
    const bars = barsByBenchmark[trade.benchmark];
    if (!bars?.length) continue;
    const res = evaluateTrade(trade, bars, nowMs);
    if (res.outcome) {
      state.closed.push(res);
      closedNow.push(res);
      delete state.open[key];
    } else {
      state.open[key] = res;
    }
  }
  if (state.closed.length > MAX_CLOSED) state.closed = state.closed.slice(-MAX_CLOSED);
  return closedNow;
}

// ---------- Factor reliability ----------

function bucket() {
  return { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, bull: { n: 0, hits: 0, sumRet: 0 }, bear: { n: 0, hits: 0, sumRet: 0 } };
}

function addObservation(agg, benchmark, horizon, name, x, retPct) {
  agg[benchmark] ||= {};
  agg[benchmark][horizon] ||= {};
  const b = (agg[benchmark][horizon][name] ||= bucket());
  b.n++; b.sx += x; b.sy += retPct; b.sxx += x * x; b.syy += retPct * retPct; b.sxy += x * retPct;
  if (x > FACTOR_THRESHOLD) { b.bull.n++; b.bull.sumRet += retPct; if (retPct > 0) b.bull.hits++; }
  if (x < -FACTOR_THRESHOLD) { b.bear.n++; b.bear.sumRet += retPct; if (retPct < 0) b.bear.hits++; }
}

export function addPending(state, snap) {
  if (!snap.price) return;
  state.pending.push({
    t: snap.t, benchmark: snap.benchmark, price: snap.price, factorScores: snap.factorScores,
    composite: { intraday: snap.intraday?.score ?? null, swing: snap.swing?.score ?? null },
    done: {},
  });
  if (state.pending.length > MAX_PENDING) state.pending = state.pending.slice(-MAX_PENDING);
}

// Resolves forward returns for snapshots whose window has passed.
export function resolvePending(state, barsByBenchmark, nowMs) {
  let resolved = 0;
  const keep = [];
  for (const p of state.pending) {
    const bars = barsByBenchmark[p.benchmark];
    for (const [h, cfg] of Object.entries(HORIZONS)) {
      if (p.done[h]) continue;
      const due = p.t + cfg.forwardH * 3.6e6;
      if (due > nowMs || !bars?.length) continue;
      const bar = bars.find((b) => b.t >= due);
      if (!bar) {
        // Window passed but no bar yet (weekend or market closed). Give up after 4 days.
        if (nowMs - due > 96 * 3.6e6) p.done[h] = "expired";
        continue;
      }
      const retPct = ((bar.c - p.price) / p.price) * 100;
      for (const [name, x] of Object.entries(p.factorScores || {})) addObservation(state.agg, p.benchmark, h, name, x, retPct);
      if (p.composite[h] != null) addObservation(state.agg, p.benchmark, h, "composite", p.composite[h], retPct);
      p.done[h] = true;
      resolved++;
    }
    const finished = Object.keys(HORIZONS).every((h) => p.done[h]);
    if (!finished) keep.push(p);
  }
  state.pending = keep;
  return resolved;
}

// ---------- Summary for the page ----------

const r2 = (x) => Math.round(x * 100) / 100;

function tradeStats(list) {
  const n = list.length;
  const wins = list.filter((t) => t.r > 0).length;
  const losses = list.filter((t) => t.r < 0).length;
  const totalR = list.reduce((s, t) => s + t.r, 0);
  const grossWin = list.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const grossLoss = -list.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0);
  return {
    trades: n,
    wins,
    losses,
    timeouts: list.filter((t) => t.outcome === "time").length,
    winRate: n ? (wins / n) * 100 : null,
    avgR: n ? r2(totalR / n) : null,
    totalR: r2(totalR),
    profitFactor: grossLoss ? r2(grossWin / grossLoss) : null,
  };
}

function factorTable(aggForH) {
  if (!aggForH) return [];
  return Object.entries(aggForH).map(([name, b]) => {
    const varX = b.n * b.sxx - b.sx * b.sx;
    const varY = b.n * b.syy - b.sy * b.sy;
    const corr = varX > 0 && varY > 0 ? (b.n * b.sxy - b.sx * b.sy) / Math.sqrt(varX * varY) : null;
    const side = (s) => ({ n: s.n, hitRate: s.n ? (s.hits / s.n) * 100 : null, avgRetPct: s.n ? s.sumRet / s.n : null });
    return { name, n: b.n, corr: corr == null ? null : r2(corr), bull: side(b.bull), bear: side(b.bear) };
  }).sort((a, b) => (a.name === "composite" ? -1 : b.name === "composite" ? 1 : Math.abs(b.corr ?? 0) - Math.abs(a.corr ?? 0)));
}

export function buildSummary(state, nowMs) {
  const out = { generatedAt: nowMs, runs: state.runs, lastRun: state.lastRun, lastSnapshot: state.lastSnapshot, firstRun: state.firstRun || null, benchmarks: {} };
  for (const bm of ["brent", "wti"]) {
    out.benchmarks[bm] = {};
    for (const h of Object.keys(HORIZONS)) {
      const closed = state.closed.filter((t) => t.benchmark === bm && t.horizon === h);
      let cum = 0;
      out.benchmarks[bm][h] = {
        stats: tradeStats(closed),
        strong: tradeStats(closed.filter((t) => t.strength === "strong")),
        lean: tradeStats(closed.filter((t) => t.strength === "lean")),
        equity: closed.map((t) => ({ t: t.closed, c: r2((cum += t.r)) })),
        open: state.open[`${bm}:${h}`] || null,
        recent: closed.slice(-20).reverse(),
        factors: factorTable(state.agg?.[bm]?.[h]),
        pending: state.pending.filter((p) => p.benchmark === bm && !p.done[h]).length,
      };
    }
  }
  return out;
}

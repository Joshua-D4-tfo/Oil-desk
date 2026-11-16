// Futures curve structure: front-month versus second-month spread for Brent and WTI.
// Positive spread = backwardation (prompt barrels dearer, market tight).
import { jsonResponse, safe } from "../shared/http.mjs";
import { yahooChart, contractCandidates } from "../shared/yahoo.mjs";

const FRESH_MS = 4 * 24 * 3600 * 1000; // contract must have traded within 4 days to count as live

async function curveFor(root, startOffset) {
  const candidates = contractCandidates(root, new Date(), startOffset, 5);
  const results = await Promise.all(
    candidates.map(async (c) => {
      try {
        const chart = await yahooChart(c.ticker, "1d", "1mo");
        return { ...c, chart };
      } catch {
        return null;
      }
    })
  );
  const live = results
    .filter((r) => r && r.chart.bars.length > 3 && Date.now() - (r.chart.priceTime || 0) < FRESH_MS)
    .sort((a, b) => a.order - b.order);
  if (live.length < 2) throw new Error(`could not resolve two live ${root} contracts`);

  const [m1, m2] = live;
  // Align daily closes by date to build a spread history.
  const key = (t) => new Date(t).toISOString().slice(0, 10);
  const m2Map = new Map(m2.chart.bars.map((b) => [key(b.t), b.c]));
  const history = m1.chart.bars
    .filter((b) => m2Map.has(key(b.t)))
    .map((b) => ({ date: key(b.t), spread: +(b.c - m2Map.get(key(b.t))).toFixed(3), m1: b.c }));

  return {
    m1: { ticker: m1.ticker, label: m1.label, price: m1.chart.price },
    m2: { ticker: m2.ticker, label: m2.label, price: m2.chart.price },
    spread: +(m1.chart.price - m2.chart.price).toFixed(3),
    curve: live.map((r) => ({ label: r.label, ticker: r.ticker, price: r.chart.price })),
    history,
  };
}

export default async () => {
  const [brent, wti] = await Promise.all([
    safe("Yahoo Finance: Brent futures curve", () => curveFor("BZ", 1)),
    safe("Yahoo Finance: WTI futures curve", () => curveFor("CL", 0)),
  ]);
  return jsonResponse({ fetchedAt: Date.now(), brent, wti }, 900);
};

export const config = { path: "/api/curve" };

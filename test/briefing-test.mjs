// Offline test of the daily briefing pipeline with a fake Claude. Run from a scratch copy of the repo.
const fakeDaily = {
  headline: "Brent holds above $100 as Hormuz transits recover slowly ahead of the OPEC+ meeting",
  overview: "Brent rose 0.8% over the past 24 hours. Tanker transits through Hormuz increased for a third week. Traders are positioning ahead of the 29 November OPEC+ ministerial meeting.",
  developments: [
    { title: "Hormuz transits rise for third week", category: "Geopolitics & shipping", summary: "UKMTO reported 170 outbound transits in the week to 10 November.", why_it_matters: "More Gulf barrels reaching market erodes the risk premium.", direction: "bearish", impact: "high", verification: "confirmed", follow_up_of_previous: false,
      sources: [{ title: "Hormuz shipping below normal but not stalled", publisher: "Gulf News", url: "https://gulfnews.com/world/mena/hormuz-shipping-below-normal-but-not-stalled-ukmto-1.500741839?utm_source=x" }] },
    { title: "Saudi Arabia said to favour rollover of cuts", category: "OPEC+", summary: "Delegates told a news agency the kingdom favours rolling over cuts.", why_it_matters: "A rollover would keep supply tighter in 2027.", direction: "bullish", impact: "medium", verification: "reported", follow_up_of_previous: false,
      sources: [{ title: "Invented article", publisher: "Made Up", url: "https://example.com/fabricated-link" }] },
    { title: "US crude stocks drew 3.1m barrels", category: "Inventories & data", summary: "EIA data showed a draw of 3.1 million barrels.", why_it_matters: "A larger than seasonal draw supports prompt spreads.", direction: "bullish", impact: "medium", verification: "confirmed", follow_up_of_previous: false,
      sources: [{ title: "Weekly Petroleum Status Report", publisher: "EIA", url: "https://www.eia.gov/petroleum/supply/weekly/" }, { title: "Lost", publisher: "X", url: "https://notseen.com/a" }] },
  ],
  data_releases: [{ name: "EIA crude inventories", result: "-3.1m bbl", vs_expectation: "versus -1.0m expected", direction: "bullish", sources: [{ title: "WPSR", publisher: "EIA", url: "https://www.eia.gov/petroleum/supply/weekly/" }] },
    { name: "Fake release", result: "x", direction: "neutral", sources: [{ url: "https://nowhere.example/x" }] }],
  analyst_views: [{ who: "Goldman Sachs", view: "Sees Brent averaging $90 in 2027.", direction: "bearish", sources: [{ title: "GS note", publisher: "Reuters", url: "https://www.reuters.com/markets/commodities/gs-oil-2027/" }] }],
  public_sentiment: { lean: "bullish", summary: "Retail commentary remains bullish.", evidence: ["StockTwits USO: 40 bullish, 12 bearish tags"], sources: [] },
  watch_today: [{ item: "API inventories", when_utc: "2026-11-17T21:30:00Z", why: "Early read on Wednesday's EIA data." }],
  verdict: { direction: "bearish", strength: -1, reasoning: "Supply recovery outweighs the inventory draw for the next 24 hours." },
};
const fakeConsensus = (n) => ({
  week: { direction: "bearish", strength: -1, confidence: n < 3 ? "low" : "medium", summary: `Based on ${n} briefing(s).`, bullish_drivers: [{ driver: "Inventory draws", dates: ["2026-11-17"] }], bearish_drivers: [{ driver: "Hormuz recovery", dates: ["2026-11-17"] }], narrative_shift: "From disruption to recovery.", price_vs_evidence: "Prices lag the evidence.", key_risks: ["Renewed attacks"], what_would_change_it: "Brent above $108." },
  month: { direction: "neutral", strength: 0, confidence: "low", summary: "Too little history.", bullish_drivers: [], bearish_drivers: [], narrative_shift: "n/a", price_vs_evidence: "n/a", key_risks: [], what_would_change_it: "More data." },
});
let calls = 0;
globalThis.__askClaudeOverride = async ({ system, webSearch }) => {
  calls++;
  if (webSearch) return { text: "Here is the briefing.\n<json>" + JSON.stringify(fakeDaily) + "</json>", urls: [
    { url: "https://gulfnews.com/world/mena/hormuz-shipping-below-normal-but-not-stalled-ukmto-1.500741839" },
    { url: "https://eia.gov/petroleum/supply/weekly" }, { url: "https://www.reuters.com/markets/commodities/gs-oil-2027" }],
    usage: { input_tokens: 50000, output_tokens: 4000, web_search_requests: 11 }, stopReason: "end_turn", model: "claude-sonnet-5-5" };
  const fs = await import("node:fs");
  const n = fs.readdirSync("public/briefings").filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).length;
  return { text: "<json>" + JSON.stringify(fakeConsensus(n)) + "</json>", urls: [], usage: { input_tokens: 9000, output_tokens: 1500, web_search_requests: 0 }, stopReason: "end_turn", model: "claude-sonnet-5-5" };
};
await import("../scripts/briefing.mjs");

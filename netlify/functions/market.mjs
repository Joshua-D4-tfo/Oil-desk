// Fast-refresh price data: Brent, WTI and the US dollar index, hourly bars over about one month.
// Brent and WTI come live from Capital.com (the spot CFDs you trade) when the API keys are set in Netlify,
// with Yahoo Finance futures (delayed about 10 minutes) as the fallback. The dollar index always comes from Yahoo.
import { jsonResponse, safe } from "../shared/http.mjs";
import { yahooChart } from "../shared/yahoo.mjs";
import { capitalChart, capitalConfigured } from "../shared/capital.mjs";

async function oil(benchmark, yahooSymbol, label) {
  if (capitalConfigured()) {
    const live = await safe(`Capital.com live: ${label} spot`, () => capitalChart(benchmark));
    if (live.ok) return live;
    const fallback = await safe(`Yahoo Finance (fallback, delayed): ${label} (${yahooSymbol})`, () => yahooChart(yahooSymbol, "1h", "1mo"));
    if (fallback.ok) fallback.liveError = live.error;
    return fallback.ok ? fallback : live;
  }
  return safe(`Yahoo Finance (delayed): ${label} (${yahooSymbol})`, () => yahooChart(yahooSymbol, "1h", "1mo"));
}

export default async () => {
  const [brent, wti, dxy] = await Promise.all([
    oil("brent", "BZ=F", "Brent"),
    oil("wti", "CL=F", "WTI"),
    safe("Yahoo Finance: Dollar index (DX-Y.NYB)", () => yahooChart("DX-Y.NYB", "1h", "1mo")),
  ]);
  // Short CDN cache so the page is never more than about 15 seconds behind the live quote.
  return jsonResponse({ fetchedAt: Date.now(), live: Boolean(brent.data?.live || wti.data?.live), brent, wti, dxy }, 10);
};

export const config = { path: "/api/market" };

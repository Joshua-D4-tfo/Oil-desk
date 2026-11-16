// Fast-refresh price data: Brent, WTI and the US dollar index, hourly bars over one month.
import { jsonResponse, safe } from "../shared/http.mjs";
import { yahooChart } from "../shared/yahoo.mjs";

export default async () => {
  const [brent, wti, dxy] = await Promise.all([
    safe("Yahoo Finance: Brent (BZ=F)", () => yahooChart("BZ=F", "1h", "1mo")),
    safe("Yahoo Finance: WTI (CL=F)", () => yahooChart("CL=F", "1h", "1mo")),
    safe("Yahoo Finance: Dollar index (DX-Y.NYB)", () => yahooChart("DX-Y.NYB", "1h", "1mo")),
  ]);
  return jsonResponse({ fetchedAt: Date.now(), brent, wti, dxy }, 60);
};

export const config = { path: "/api/market" };

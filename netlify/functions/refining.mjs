// Refining margins and oil volatility.
// RBOB gasoline (RB=F) and ULSD heating oil (HO=F) are quoted in dollars per gallon.
// ^OVX is the CBOE crude oil volatility index (30-day implied volatility of USO options).
import { jsonResponse, safe } from "../shared/http.mjs";
import { yahooChart } from "../shared/yahoo.mjs";

export default async () => {
  const [gasoline, heatingOil, ovx] = await Promise.all([
    safe("Yahoo Finance: RBOB gasoline (RB=F)", () => yahooChart("RB=F", "1h", "1mo")),
    safe("Yahoo Finance: Heating oil / ULSD (HO=F)", () => yahooChart("HO=F", "1h", "1mo")),
    safe("Yahoo Finance: Oil volatility index (^OVX)", () => yahooChart("^OVX", "1d", "6mo")),
  ]);
  return jsonResponse({ fetchedAt: Date.now(), gasoline, heatingOil, ovx }, 300);
};

export const config = { path: "/api/refining" };

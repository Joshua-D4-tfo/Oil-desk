// Yahoo Finance chart API (unofficial, free). Futures quotes are typically delayed ~10 minutes.
import { fetchJson } from "./http.mjs";

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

export async function yahooChart(symbol, interval = "1h", range = "1mo") {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
      const json = await fetchJson(url);
      const r = json?.chart?.result?.[0];
      if (!r) throw new Error(json?.chart?.error?.description || "empty chart result");
      return normaliseChart(symbol, r);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export function normaliseChart(symbol, r) {
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null || Number.isNaN(c)) continue;
    bars.push({
      t: ts[i] * 1000,
      o: q.open?.[i] ?? c,
      h: q.high?.[i] ?? c,
      l: q.low?.[i] ?? c,
      c,
      v: q.volume?.[i] ?? 0,
    });
  }
  const meta = r.meta || {};
  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    price: meta.regularMarketPrice ?? bars.at(-1)?.c ?? null,
    priceTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : bars.at(-1)?.t ?? null,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency: meta.currency || "USD",
    exchange: meta.exchangeName || "",
    bars,
  };
}

const MONTH_CODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];

// Builds candidate contract tickers, e.g. BZF27.NYM, for the next few delivery months.
export function contractCandidates(root, now = new Date(), startOffset = 0, count = 5) {
  const out = [];
  for (let k = startOffset; k < startOffset + count; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    const code = MONTH_CODES[d.getUTCMonth()];
    const yy = String(d.getUTCFullYear()).slice(-2);
    out.push({
      ticker: `${root}${code}${yy}.NYM`,
      label: d.toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }),
      order: k,
    });
  }
  return out;
}

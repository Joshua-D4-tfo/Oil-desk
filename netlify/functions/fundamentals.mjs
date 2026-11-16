// Slow-moving fundamentals: EIA weekly US inventories and CFTC managed-money positioning in WTI.
import { jsonResponse, safe, fetchJson } from "../shared/http.mjs";

const EIA_SERIES = {
  WCESTUS1: "Commercial crude (ex-SPR)",
  W_EPC0_SAX_YCUOK_MBBL: "Cushing, Oklahoma crude",
  WGTSTUS1: "Total motor gasoline",
  WDISTUS1: "Distillate fuel oil",
  WCSSTUS1: "Strategic Petroleum Reserve",
};

export async function loadEia(apiKey) {
  if (!apiKey) throw new Error("EIA_API_KEY not set in Netlify environment variables");
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "weekly");
  params.append("data[0]", "value");
  for (const s of Object.keys(EIA_SERIES)) params.append("facets[series][]", s);
  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("length", "2000");
  const json = await fetchJson(`https://api.eia.gov/v2/petroleum/stoc/wstk/data/?${params}`, {}, 12000);
  const rows = json?.response?.data || [];
  if (!rows.length) throw new Error("EIA returned no rows");
  return summariseEia(rows);
}

export function summariseEia(rows) {
  const bySeries = {};
  for (const r of rows) {
    const id = r.series;
    if (!EIA_SERIES[id]) continue;
    (bySeries[id] ||= []).push({ period: r.period, value: Number(r.value) });
  }
  const out = {};
  for (const [id, list] of Object.entries(bySeries)) {
    list.sort((a, b) => (a.period < b.period ? 1 : -1)); // newest first
    const latest = list[0];
    const prev = list[1];
    const change = latest && prev ? latest.value - prev.value : null;

    // Same week in each of the previous five years: nearest period to (latest - k years).
    const latestDate = new Date(latest.period);
    const seasonalChanges = [];
    const seasonalLevels = [];
    for (let k = 1; k <= 5; k++) {
      const target = new Date(latestDate);
      target.setUTCFullYear(target.getUTCFullYear() - k);
      let bestIdx = -1;
      let bestGap = Infinity;
      list.forEach((p, i) => {
        const gap = Math.abs(new Date(p.period) - target);
        if (gap < bestGap) { bestGap = gap; bestIdx = i; }
      });
      if (bestIdx > -1 && bestGap < 5 * 864e5 && list[bestIdx + 1]) {
        seasonalChanges.push(list[bestIdx].value - list[bestIdx + 1].value);
        seasonalLevels.push(list[bestIdx].value);
      }
    }
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const fiveYrAvgChange = avg(seasonalChanges);
    const fiveYrAvgLevel = avg(seasonalLevels);
    out[id] = {
      name: EIA_SERIES[id],
      unit: "thousand barrels",
      period: latest.period,
      value: latest.value,
      change,
      fiveYrAvgChange,
      changeVsSeasonal: change != null && fiveYrAvgChange != null ? change - fiveYrAvgChange : null,
      fiveYrAvgLevel,
      levelVsFiveYrPct: fiveYrAvgLevel ? ((latest.value - fiveYrAvgLevel) / fiveYrAvgLevel) * 100 : null,
      history: list.slice(0, 26).reverse(),
    };
  }
  return out;
}

export async function loadCot() {
  // CFTC Disaggregated Futures-Only report; 067651 = WTI light sweet crude (NYMEX).
  const url =
    "https://publicreporting.cftc.gov/resource/72hh-3qpy.json?" +
    new URLSearchParams({
      cftc_contract_market_code: "067651",
      $order: "report_date_as_yyyy_mm_dd DESC",
      $limit: "160",
    });
  const rows = await fetchJson(url, {}, 12000);
  if (!Array.isArray(rows) || !rows.length) throw new Error("CFTC returned no rows");
  return summariseCot(rows);
}

export function summariseCot(rows) {
  const series = rows
    .map((r) => {
      const long = Number(r.m_money_positions_long_all);
      const short = Number(r.m_money_positions_short_all);
      return {
        date: String(r.report_date_as_yyyy_mm_dd).slice(0, 10),
        long,
        short,
        net: long - short,
        oi: Number(r.open_interest_all),
      };
    })
    .filter((r) => Number.isFinite(r.net))
    .sort((a, b) => (a.date < b.date ? -1 : 1)); // oldest first
  const latest = series.at(-1);
  const prior = series.at(-2);
  const window = series.slice(-156); // about three years
  const below = window.filter((r) => r.net < latest.net).length;
  const percentile = (below / Math.max(window.length - 1, 1)) * 100;
  return {
    market: "WTI crude (NYMEX), managed money",
    date: latest.date,
    net: latest.net,
    long: latest.long,
    short: latest.short,
    weeklyChange: prior ? latest.net - prior.net : null,
    percentile3y: percentile,
    min3y: Math.min(...window.map((r) => r.net)),
    max3y: Math.max(...window.map((r) => r.net)),
    history: series.slice(-52),
  };
}

export default async () => {
  const [eia, cot] = await Promise.all([
    safe("EIA weekly petroleum inventories", () => loadEia(process.env.EIA_API_KEY)),
    safe("CFTC Commitments of Traders (WTI)", () => loadCot()),
  ]);
  return jsonResponse({ fetchedAt: Date.now(), eia, cot }, 1800);
};

export const config = { path: "/api/fundamentals" };

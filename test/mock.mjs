// Generates realistic mock API responses in the exact shapes the functions return.
import { summariseEia, summariseCot } from "../netlify/functions/fundamentals.mjs";
import { parseRss } from "../netlify/functions/news.mjs";

function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

export function mockChart(symbol, start, drift, vol, seed) {
  const r = rng(seed);
  const bars = [];
  let p = start;
  const now = Date.now();
  for (let i = 520; i >= 0; i--) {
    const o = p;
    p = p * (1 + drift + (r() - 0.5) * vol);
    const h = Math.max(o, p) * (1 + r() * vol * 0.4);
    const l = Math.min(o, p) * (1 - r() * vol * 0.4);
    bars.push({ t: now - i * 3600e3, o, h, l, c: p, v: 1000 });
  }
  return { symbol, name: symbol, price: p, priceTime: now - 600e3, previousClose: start, currency: "USD", exchange: "NYM", bars };
}

export function mockMarket() {
  return {
    fetchedAt: Date.now(),
    brent: { ok: true, source: "mock", data: mockChart("BZ=F", 98, 0.00012, 0.006, 7) },
    wti: { ok: true, source: "mock", data: mockChart("CL=F", 94, 0.0001, 0.006, 11) },
    dxy: { ok: true, source: "mock", data: mockChart("DX-Y.NYB", 101, -0.00002, 0.0015, 3) },
  };
}

export function mockCurve() {
  const history = [];
  for (let i = 20; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    history.push({ date: d, spread: 1.6 + (20 - i) * 0.03, m1: 100 });
  }
  const data = { m1: { ticker: "BZF27.NYM", label: "Jan 27", price: 103.4 }, m2: { ticker: "BZG27.NYM", label: "Feb 27", price: 101.2 }, spread: 2.2, curve: [], history };
  return { fetchedAt: Date.now(), brent: { ok: true, data }, wti: { ok: false, error: "mock" } };
}

export function mockFundamentals() {
  const rows = [];
  const series = { WCESTUS1: 430000, W_EPC0_SAX_YCUOK_MBBL: 23000, WGTSTUS1: 210000, WDISTUS1: 115000, WCSSTUS1: 380000 };
  const r = rng(5);
  for (const [id, base] of Object.entries(series)) {
    let v = base;
    for (let w = 0; w < 320; w++) {
      const d = new Date(Date.UTC(2026, 10, 6) - w * 7 * 864e5).toISOString().slice(0, 10);
      rows.push({ period: d, series: id, value: String(Math.round(v)) });
      v += (r() - 0.48) * base * 0.01;
    }
  }
  const cotRows = [];
  for (let w = 0; w < 160; w++) {
    cotRows.push({
      report_date_as_yyyy_mm_dd: new Date(Date.UTC(2026, 10, 10) - w * 7 * 864e5).toISOString() ,
      m_money_positions_long_all: String(250000 + Math.round(Math.sin(w / 9) * 80000)),
      m_money_positions_short_all: String(90000 + Math.round(Math.cos(w / 7) * 30000)),
      open_interest_all: "1800000",
    });
  }
  return {
    fetchedAt: Date.now(),
    eia: { ok: true, data: summariseEia(rows) },
    cot: { ok: true, data: summariseCot(cotRows) },
  };
}

export function mockNews() {
  const h = (title, hrs, src) => `<item><title><![CDATA[${title} - ${src}]]></title><link>https://example.com/${encodeURIComponent(title)}</link><pubDate>${new Date(Date.now() - hrs * 3600e3).toUTCString()}</pubDate><source url="x">${src}</source></item>`;
  const xml = `<rss><channel>${[
    h("Oil climbs as Hormuz transits slow after fresh tanker attack", 1, "Reuters"),
    h("OPEC+ expected to keep cuts in place at November 29 ministerial meeting", 3, "Bloomberg"),
    h("US crude inventories fell by 3.1 million barrels, EIA says", 20, "CNBC"),
    h("Iran says talks on reopening Hormuz making progress", 5, "Al Jazeera"),
    h("Saudi Aramco raises January OSP for Asia", 30, "Argus"),
    h("China crude imports hit record in October", 26, "Reuters"),
    h("Brent slips as dollar strengthens", 9, "MarketWatch"),
    h("UAE plans to boost oil production capacity once flows normalise", 14, "The National"),
    h("Drone strike sets Russian refinery ablaze", 6, "Reuters"),
    h("Analysts warn of 2027 glut as Gulf supply returns", 18, "FT"),
  ].join("")}</channel></rss>`;
  return { fetchedAt: Date.now(), feeds: [{ ok: true, source: "mock", count: 10 }], items: parseRss(xml, "Google News: mock") };
}

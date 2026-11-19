// Capital.com Open API: live, undelayed bid/ask quotes and hourly bars for the spot oil CFDs you trade.
// Read-only: this module only calls GET /markets and GET /prices. It never opens, edits or closes positions.
// Needs the Netlify environment variables CAPITAL_API_KEY, CAPITAL_IDENTIFIER and CAPITAL_API_PASSWORD.
import { getStore } from "@netlify/blobs";

const BASE = "https://api-capital.backend-capital.com";
const SESSION_MAX_AGE = 8 * 60 * 1000; // Capital.com ends a session after 10 minutes without use
let memSession = null;

export const CAPITAL_EPICS = { brent: "OIL_BRENT", wti: "OIL_CRUDE" };

export function capitalConfigured() {
  return Boolean(process.env.CAPITAL_API_KEY && process.env.CAPITAL_IDENTIFIER && process.env.CAPITAL_API_PASSWORD);
}

function sessionStore() {
  try { return getStore({ name: "oil-desk-capital", consistency: "strong" }); } catch { return null; }
}

async function timedFetch(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

async function login() {
  const res = await timedFetch(`${BASE}/api/v1/session`, {
    method: "POST",
    headers: { "X-CAP-API-KEY": process.env.CAPITAL_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: process.env.CAPITAL_IDENTIFIER, password: process.env.CAPITAL_API_PASSWORD, encryptedPassword: false }),
  });
  if (!res.ok) throw new Error(`Capital.com login failed (HTTP ${res.status})`);
  const s = { cst: res.headers.get("CST"), token: res.headers.get("X-SECURITY-TOKEN"), at: Date.now() };
  if (!s.cst || !s.token) throw new Error("Capital.com login returned no session tokens");
  memSession = s;
  const store = sessionStore();
  if (store) await store.setJSON("session", s).catch(() => {});
  return s;
}

// Reuses one session across function calls (kept in Netlify Blobs) so the site does not log in every minute.
async function getSession(force = false) {
  if (!force) {
    if (memSession && Date.now() - memSession.at < SESSION_MAX_AGE) return memSession;
    const store = sessionStore();
    const saved = store ? await store.get("session", { type: "json" }).catch(() => null) : null;
    if (saved && Date.now() - saved.at < SESSION_MAX_AGE) return (memSession = saved);
  }
  return login();
}

async function capGet(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const res = await timedFetch(`${BASE}${path}`, {
      headers: { "X-SECURITY-TOKEN": s.token, CST: s.cst, "X-CAP-API-KEY": process.env.CAPITAL_API_KEY },
    });
    if (res.status === 401 && attempt === 0) continue; // session expired: log in again once
    if (!res.ok) throw new Error(`Capital.com HTTP ${res.status} on ${path.split("?")[0]}`);
    return res.json();
  }
  throw new Error("Capital.com session could not be renewed");
}

const utc = (s) => Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);

// Returns the same shape as yahooChart(), plus bid, ask and spread. Prices are mid (halfway between bid and ask).
export async function capitalChart(benchmark) {
  const epic = CAPITAL_EPICS[benchmark];
  const fetchedAt = Date.now();
  const [market, prices] = await Promise.all([
    capGet(`/api/v1/markets/${epic}`),
    capGet(`/api/v1/prices/${epic}?resolution=HOUR&max=600`),
  ]);

  const raw = prices?.prices || [];
  const spreads = raw.map((p) => (p.closePrice?.ask ?? NaN) - (p.closePrice?.bid ?? NaN)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const medSpread = spreads.length ? spreads[Math.floor(spreads.length / 2)] : 0.04;
  const mid = (q) => {
    if (!q) return null;
    const b = q.bid ?? (q.ask != null ? q.ask - medSpread : null);
    const a = q.ask ?? (q.bid != null ? q.bid + medSpread : null);
    return b == null || a == null ? null : (a + b) / 2;
  };
  const bars = [];
  for (const p of raw) {
    const c = mid(p.closePrice);
    if (c == null) continue;
    bars.push({ t: utc(p.snapshotTimeUTC || p.snapshotTime), o: mid(p.openPrice) ?? c, h: mid(p.highPrice) ?? c, l: mid(p.lowPrice) ?? c, c, v: p.lastTradedVolume ?? 0 });
  }
  if (bars.length < 60) throw new Error(`Capital.com returned only ${bars.length} hourly bars for ${epic}`);

  const snap = market?.snapshot || {};
  const bid = snap.bid ?? null, ask = snap.offer ?? null;
  const live = bid != null && ask != null ? (bid + ask) / 2 : bars.at(-1).c;
  const tradeable = snap.marketStatus === "TRADEABLE";
  // A tradeable market is quoted continuously, so the quote is as fresh as this request.
  // When the market is closed, the time of the last bar is used so the engine knows the quote is old.
  const priceTime = tradeable ? fetchedAt : (snap.updateTimeUTC ? utc(snap.updateTimeUTC) : bars.at(-1).t + 3600 * 1000);
  if (tradeable) bars[bars.length - 1] = { ...bars.at(-1), c: live, h: Math.max(bars.at(-1).h, live), l: Math.min(bars.at(-1).l, live) };

  return {
    symbol: epic,
    name: market?.instrument?.name || epic,
    price: live,
    priceTime,
    previousClose: snap.netChange != null ? live - snap.netChange : null,
    currency: market?.instrument?.currency || "USD",
    exchange: "Capital.com",
    bid, ask,
    spread: bid != null && ask != null ? ask - bid : null,
    marketStatus: snap.marketStatus || null,
    live: true,
    bars,
  };
}

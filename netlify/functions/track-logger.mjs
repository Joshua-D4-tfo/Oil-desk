// Scheduled every 15 minutes on the published site. Logs the current signals for Brent and WTI,
// opens and closes simulated trades, resolves factor forward returns and stores a summary.
// Storage: Netlify Blobs store "oil-desk-track".
import { getStore } from "@netlify/blobs";
import { fetchJson } from "../shared/http.mjs";
import { computeSignals } from "../../public/js/engine.js";
import {
  emptyState, snapshotFromSignals, maybeOpenTrades, updateOpenTrades,
  addPending, resolvePending, buildSummary,
} from "../shared/track.mjs";

const STALE_MS = 2 * 3600 * 1000; // older quotes mean the market is closed: do not log new signals

export default async (req) => {
  const now = Date.now();
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
  const store = getStore({ name: "oil-desk-track", consistency: "strong" });

  const [market, curve, fundamentals, news, refining] = await Promise.all(
    ["market", "curve", "fundamentals", "news", "refining"].map((p) =>
      fetchJson(`${origin}/api/${p}`, {}, 20000).catch(() => null)
    )
  );

  const state = (await store.get("state", { type: "json" })) || emptyState();
  state.firstRun ||= now;

  const barsByBenchmark = {
    brent: market?.brent?.ok ? market.brent.data.bars : null,
    wti: market?.wti?.ok ? market.wti.data.bars : null,
  };

  // 1. Close or mark open simulated trades, and resolve due forward returns.
  const closed = updateOpenTrades(state, barsByBenchmark, now);
  const resolved = resolvePending(state, barsByBenchmark, now);

  // 2. Log fresh signals while the market is open.
  const snaps = [];
  const opened = [];
  for (const bm of ["brent", "wti"]) {
    const sig = computeSignals({ market, curve, fundamentals, news, refining }, now, bm);
    const tb = bm === "wti" ? sig.technicals.wti : sig.technicals.brent;
    if (!tb || !tb.priceTime || now - tb.priceTime > STALE_MS) continue;
    const snap = snapshotFromSignals(sig, now);
    snaps.push(snap);
    addPending(state, snap);
    opened.push(...maybeOpenTrades(state, sig, now));
  }

  if (snaps.length) {
    const dayKey = `snapshots/${new Date(now).toISOString().slice(0, 10)}`;
    const day = (await store.get(dayKey, { type: "json" })) || [];
    day.push(...snaps);
    await store.setJSON(dayKey, day);
    state.lastSnapshot = now;
  }

  state.runs = (state.runs || 0) + 1;
  state.lastRun = now;
  await store.setJSON("state", state);
  await store.setJSON("summary", buildSummary(state, now));

  const result = { ok: true, snapshots: snaps.length, opened: opened.length, closed: closed.length, resolved };
  console.log("track-logger", JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

export const config = { schedule: "*/15 * * * *" };

// CSV downloads of the track record, for review and re-weighting.
// /api/export/trades.csv    every simulated trade (closed and open) with factor scores at entry
// /api/export/readings.csv  every 15-minute signal snapshot with factor scores and the forward returns that followed
import { getStore } from "@netlify/blobs";
import { tradesCsv, readingsCsv, emptyState } from "../shared/track.mjs";

async function loadByPrefix(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const keys = blobs.map((b) => b.key).sort();
  return Promise.all(keys.map((k) => store.get(k, { type: "json" })));
}

export default async (req, context) => {
  const store = getStore({ name: "oil-desk-track" });
  const file = context?.params?.file || "";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  let csv, name;

  if (file === "trades.csv") {
    const state = (await store.get("state", { type: "json" })) || emptyState();
    csv = tradesCsv(state);
    name = `oil-desk-trades-${stamp}.csv`;
  } else if (file === "readings.csv") {
    const [days, fwdDays] = await Promise.all([loadByPrefix(store, "snapshots/"), loadByPrefix(store, "forward/")]);
    const snapshots = days.filter(Boolean).flat().sort((a, b) => a.t - b.t);
    const fwdById = Object.assign({}, ...fwdDays.filter(Boolean));
    csv = readingsCsv(snapshots, fwdById);
    name = `oil-desk-readings-${stamp}.csv`;
  } else {
    return new Response("Use /api/export/trades.csv or /api/export/readings.csv", { status: 404 });
  }

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
};

export const config = { path: "/api/export/:file" };

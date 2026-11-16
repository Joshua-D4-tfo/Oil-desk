// Serves the track-record summary written by the scheduled track-logger function.
// /api/track            summary for the page
// /api/track/trades     every closed simulated trade (JSON), for your own analysis
import { getStore } from "@netlify/blobs";
import { jsonResponse } from "../shared/http.mjs";

export default async (req, context) => {
  const store = getStore({ name: "oil-desk-track" });
  if (context?.params?.what === "trades") {
    const state = await store.get("state", { type: "json" });
    return jsonResponse({ closed: state?.closed || [], open: state?.open || {} }, 300);
  }
  const summary = await store.get("summary", { type: "json" });
  if (!summary) {
    return jsonResponse({ empty: true, message: "No track record yet. The logger runs every 15 minutes on the published site." }, 120);
  }
  return jsonResponse(summary, 300);
};

export const config = { path: ["/api/track", "/api/track/:what"] };

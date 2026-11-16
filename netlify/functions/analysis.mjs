// Optional written analysis by Claude. Only runs if ANTHROPIC_API_KEY is set in Netlify.
// It reads the same cached endpoints the page uses, runs the same engine, then asks Claude to
// challenge or confirm the rule-based suggestion using the actual headlines.
import { jsonResponse, fetchJson } from "../shared/http.mjs";
import { computeSignals } from "../../public/js/engine.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

export default async (req, context) => {
  const benchmark = context?.params?.benchmark === "wti" ? "wti" : "brent";
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return jsonResponse({ enabled: false, reason: "ANTHROPIC_API_KEY not set" }, 3600);

  const origin = new URL(req.url).origin;
  const [market, curve, fundamentals, news, refining] = await Promise.all(
    ["market", "curve", "fundamentals", "news", "refining"].map((p) => fetchJson(`${origin}/api/${p}`, {}, 20000).catch(() => null))
  );
  const sig = computeSignals({ market, curve, fundamentals, news, refining }, Date.now(), benchmark);

  const factorLines = sig.factors.map((f) => `- ${f.name}: score ${f.score.toFixed(2)}. ${f.reading}`).join("\n");
  const headlines = (sig.newsDetail?.scored || [])
    .filter((h) => h.ageH <= 36)
    .slice(0, 40)
    .map((h) => `- [${h.ageH.toFixed(1)}h ago, ${h.source}] ${h.title} (keyword score ${h.score.toFixed(1)})`)
    .join("\n");
  const ev = sig.events.slice(0, 6).map((e) => `- ${e.name} in ${e.hoursAway.toFixed(1)} hours`).join("\n");
  const s = (c) => (c ? `${c.label} (score ${c.score.toFixed(2)}, conviction ${c.confidence}/100)` : "unavailable");

  const prompt = `You are reviewing a rule-based crude oil trading dashboard for a professional who makes short-term trades in ${sig.benchmarkName} crude (hours to a few days). The suggestion below is for ${sig.benchmarkName}.

Current time (UTC): ${new Date().toISOString()}
Brent: ${sig.technicals.brent?.price ?? "n/a"} | WTI: ${sig.technicals.wti?.price ?? "n/a"}

Rule-based output:
- Intraday: ${s(sig.intraday)}
- Swing: ${s(sig.swing)}

Factor readings:
${factorLines}

Volatility regime: ${sig.regime ? sig.regime.text : "OVX unavailable"}

Upcoming events:
${ev}

Recent headlines:
${headlines || "none"}

Task:
1. State in one sentence whether you agree with the intraday suggestion, and why.
2. Identify the two or three headlines or developments that matter most right now, and explain the mechanism by which each moves the price (barrels added or removed, duration, or risk premium). Note anything the keyword scoring has likely misread.
3. State what specific event or price level would change the view.
4. Give a concise overall stance for the next few hours: long, short or stand aside.

Write in formal, direct British English. Use short paragraphs with headed sections. Do not use em dashes. Do not hedge excessively. Keep it under 350 words. This is decision support, not financial advice.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return jsonResponse({ enabled: true, benchmark, model: MODEL, generatedAt: Date.now(), text }, 900);
  } catch (err) {
    return jsonResponse({ enabled: true, error: String(err.message || err), generatedAt: Date.now() }, 120);
  }
};

export const config = { path: ["/api/analysis", "/api/analysis/:benchmark"] };

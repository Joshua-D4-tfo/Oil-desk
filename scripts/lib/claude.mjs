// Minimal Claude Messages API client with web search, used by the daily briefing.
// Handles pause_turn (long research turns), retries transient errors, and records every URL
// the web search tool actually returned so that cited sources can be verified afterwards.

const API = "https://api.anthropic.com/v1/messages";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, key) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
    try {
      const res = await fetch(API, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      const msg = json?.error?.message || `HTTP ${res.status}`;
      if ([429, 500, 502, 503, 529].includes(res.status) && attempt < 4) {
        console.warn(`Claude API ${res.status} (${msg}); retrying in ${attempt * 20}s`);
        await sleep(attempt * 20000);
        continue;
      }
      throw new Error(`Claude API error: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Collects every URL from web search results in a list of content blocks.
export function searchUrls(blocks) {
  const urls = [];
  for (const b of blocks || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.type === "web_search_result" && r.url) urls.push({ url: r.url, title: r.title || "", age: r.page_age || "" });
    }
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c.url) urls.push({ url: c.url, title: c.title || "", age: "" });
    }
  }
  return urls;
}

export async function askClaude({ key, model, system, user, maxTokens = 16000, webSearch = null }) {
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const tools = webSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: webSearch.maxUses ?? 12 }] : undefined;
  const messages = [{ role: "user", content: user }];
  const allBlocks = [];
  let usage = { input_tokens: 0, output_tokens: 0, web_search_requests: 0 };
  let last;
  for (let round = 0; round < 6; round++) {
    last = await post({ model, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) }, key);
    allBlocks.push(...(last.content || []));
    usage.input_tokens += last.usage?.input_tokens || 0;
    usage.output_tokens += last.usage?.output_tokens || 0;
    usage.web_search_requests += last.usage?.server_tool_use?.web_search_requests || 0;
    if (last.stop_reason !== "pause_turn") break;
    // Continue the paused research turn by sending the partial assistant response back as-is.
    messages.push({ role: "assistant", content: last.content });
  }
  if (last.stop_reason === "max_tokens") console.warn("Claude stopped at max_tokens; output may be truncated");
  const text = (last.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, blocks: allBlocks, urls: searchUrls(allBlocks), usage, stopReason: last.stop_reason, model: last.model || model };
}

// Extracts the JSON object from <json>...</json>, or failing that the outermost braces.
export function extractJson(text) {
  const tagged = text.match(/<json>([\s\S]*?)<\/json>/i);
  let raw = tagged ? tagged[1] : null;
  if (!raw) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) throw new Error("No JSON object found in Claude's response");
    raw = text.slice(a, b + 1);
  }
  raw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(raw);
}

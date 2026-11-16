// Oil news headlines from several RSS feeds. Scoring happens in the shared engine so
// the reasoning shown on the page and the reasoning used in the suggestion are identical.
import { jsonResponse, safe, fetchText } from "../shared/http.mjs";

const gn = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

export const FEEDS = [
  { name: "Google News: oil prices", url: gn('("brent crude" OR "oil prices" OR "crude oil") when:2d') },
  { name: "Google News: OPEC+", url: gn('("OPEC+" OR OPEC OR "Saudi Aramco" OR "official selling price") when:3d') },
  { name: "Google News: Hormuz and Gulf supply", url: gn('(Hormuz OR "Iran oil" OR "tanker attack" OR "Red Sea" OR Houthi) when:2d') },
  { name: "Google News: inventories and policy", url: gn('("crude inventories" OR "EIA" OR "Strategic Petroleum Reserve" OR "oil sanctions") oil when:3d') },
  { name: "Google News: Russia and China oil", url: gn('("Russian oil" OR "China crude imports" OR "teapot refiners" OR "refinery drone") when:3d') },
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main" },
];

const decode = (s = "") =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();

export function parseRss(xml, feedName) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const get = (tag) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return mm ? decode(mm[1]) : "";
    };
    let title = get("title");
    let source = get("source");
    // Google News appends " - Publisher" to titles.
    const dash = title.lastIndexOf(" - ");
    if (feedName.startsWith("Google") && dash > 20) {
      source ||= title.slice(dash + 3);
      title = title.slice(0, dash);
    }
    const pub = Date.parse(get("pubDate"));
    items.push({
      title,
      link: get("link"),
      source: source || feedName,
      published: Number.isFinite(pub) ? pub : null,
      feed: feedName,
    });
  }
  return items;
}

export default async () => {
  const results = await Promise.all(
    FEEDS.map((f) => safe(f.name, async () => parseRss(await fetchText(f.url), f.name)))
  );
  const seen = new Set();
  const cutoff = Date.now() - 72 * 3600 * 1000;
  const items = results
    .filter((r) => r.ok)
    .flatMap((r) => r.data)
    .filter((i) => i.title && (!i.published || i.published > cutoff))
    .filter((i) => {
      const k = i.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 70);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (b.published || 0) - (a.published || 0))
    .slice(0, 120);

  return jsonResponse(
    {
      fetchedAt: Date.now(),
      feeds: results.map(({ ok, source, ms, error, data }) => ({ ok, source, ms, error, count: data?.length || 0 })),
      items,
    },
    300
  );
};

export const config = { path: "/api/news" };

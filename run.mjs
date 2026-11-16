import { computeSignals, scoreHeadline } from "../public/js/engine.js";
import { mockMarket, mockCurve, mockFundamentals, mockNews } from "./mock.mjs";
const news = mockNews();
for (const i of news.items) { const s = scoreHeadline(i.title); console.log(s.score.toFixed(1).padStart(5), i.source.padEnd(12), i.title, s.hits.map(h=>h.tag).join(" | ")); }
const sig = computeSignals({ market: mockMarket(), curve: mockCurve(), fundamentals: mockFundamentals(), news });
for (const f of sig.factors) console.log(`\n[${f.id}] ${f.score.toFixed(2)} ${f.reading}\n   ${f.explanation}`);
for (const h of ["intraday","swing"]) { const c = sig[h]; console.log(`\n=== ${h}: ${c.label} (${c.underlying}) S=${c.score.toFixed(3)} conf=${c.confidence}`); c.reasoning.forEach(p=>console.log(" - "+p)); console.log(c.plan); }
console.log(sig.events.map(e=>`${e.name} ${new Date(e.t).toISOString()} ${e.hoursAway.toFixed(1)}h`).join("\n"));

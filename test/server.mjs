// Local preview with mock data: node test/server.mjs then open http://localhost:8888
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { mockMarket, mockCurve, mockFundamentals, mockNews, mockRefining } from "./mock.mjs";
import { simulate } from "./simulate-track.mjs";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const api = { refining: mockRefining, track: () => simulate().summary, market: mockMarket, curve: mockCurve, fundamentals: mockFundamentals, news: mockNews,
  analysis: () => ({ enabled: true, model: "mock", generatedAt: Date.now(), text: "Agreement\nThis is placeholder text for the optional Claude analysis panel." }) };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const m = u.pathname.match(/^\/api\/(\w+)/);
  if (m && api[m[1]]) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(api[m[1]]())); }
  const p = join("public", u.pathname === "/" ? "index.html" : u.pathname);
  try { const body = await readFile(p); res.writeHead(200, { "Content-Type": types[extname(p)] || "text/plain" }); res.end(body); }
  catch { res.writeHead(404); res.end("not found"); }
}).listen(8888, () => console.log("http://localhost:8888"));

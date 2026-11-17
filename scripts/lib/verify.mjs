// Removes any cited URL that Claude did not actually retrieve (or that was not in the supplied
// headline list), and downgrades items left without a source. This is what keeps the briefing
// verifiable: every link in the published briefing was seen during the research.

export function normaliseUrl(u) {
  try {
    const x = new URL(String(u).trim());
    for (const p of [...x.searchParams.keys()]) if (/^(utm_|ref$|cmpid|mod$|taid|guccounter)/i.test(p)) x.searchParams.delete(p);
    x.hash = "";
    let s = `${x.protocol}//${x.host.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`;
    const q = x.searchParams.toString();
    if (q) s += `?${q}`;
    return s.toLowerCase();
  } catch {
    return null;
  }
}

export function verifySources(briefing, allowedUrls) {
  const allowed = new Set(allowedUrls.map(normaliseUrl).filter(Boolean));
  const report = { kept: 0, removed: 0, removedUrls: [], downgraded: [] };

  const clean = (sources) => (Array.isArray(sources) ? sources : []).filter((s) => {
    const n = normaliseUrl(s?.url);
    const ok = n && allowed.has(n);
    if (ok) report.kept++;
    else { report.removed++; report.removedUrls.push(s?.url || "(missing)"); }
    return ok;
  });

  for (const d of briefing.developments || []) {
    d.sources = clean(d.sources);
    if (!d.sources.length && d.verification !== "unconfirmed") {
      report.downgraded.push(d.title);
      d.verification = "unconfirmed";
      d.verification_note = "Downgraded automatically: no cited source could be matched to a page retrieved during research.";
    }
  }
  for (const key of ["data_releases", "analyst_views"]) {
    briefing[key] = (briefing[key] || []).map((x) => ({ ...x, sources: clean(x.sources) }))
      // A data point or analyst view with no verifiable source is dropped rather than shown.
      .filter((x) => x.sources.length || (report.downgraded.push(`${key}: ${x.name || x.who}`), false));
  }
  if (briefing.public_sentiment) briefing.public_sentiment.sources = clean(briefing.public_sentiment.sources);
  return report;
}

const DIRS = new Set(["bullish", "bearish", "neutral"]);
const VER = new Set(["confirmed", "reported", "unconfirmed"]);

// Light validation so a malformed response fails loudly instead of publishing nonsense.
export function validateBriefing(b) {
  const errs = [];
  if (!b || typeof b !== "object") return ["not an object"];
  if (!b.headline) errs.push("missing headline");
  if (!b.overview) errs.push("missing overview");
  if (!Array.isArray(b.developments)) errs.push("developments is not a list");
  for (const d of b.developments || []) {
    if (!DIRS.has(d.direction)) d.direction = "neutral";
    if (!VER.has(d.verification)) d.verification = "unconfirmed";
    if (!["high", "medium", "low"].includes(d.impact)) d.impact = "medium";
  }
  if (!b.verdict || !DIRS.has(b.verdict.direction)) errs.push("missing or invalid verdict");
  else b.verdict.strength = Math.max(-2, Math.min(2, Math.round(Number(b.verdict.strength) || 0)));
  return errs;
}

// How did each daily verdict compare with what Brent did before the next briefing?
// Bullish or bearish verdicts are scored; neutral verdicts are counted separately.

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

export function verdictScorecard(briefings) {
  const chron = [...briefings].sort((a, b) => (a.date < b.date ? -1 : 1));
  const rows = [];
  for (let i = 0; i < chron.length; i++) {
    const b = chron[i];
    const p0 = b.meta?.prices?.brent?.price;
    const next = chron[i + 1];
    const p1 = next?.meta?.prices?.brent?.price;
    const chg = p0 && p1 ? ((p1 - p0) / p0) * 100 : null;
    const dir = b.verdict?.direction;
    let hit = null;
    if (chg != null && dir === "bullish") hit = chg > 0;
    if (chg != null && dir === "bearish") hit = chg < 0;
    rows.push({ date: b.date, verdict: dir, strength: b.verdict?.strength ?? 0, brentAtBriefing: p0 ?? null, brentNext: p1 ?? null, changePct: r2(chg), hit });
  }
  return rows.reverse(); // newest first
}

export function summarise(rows, days, today) {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cut = cutoff.toISOString().slice(0, 10);
  const inWindow = rows.filter((r) => r.date >= cut);
  const scored = inWindow.filter((r) => r.hit != null);
  const hits = scored.filter((r) => r.hit).length;
  const prices = inWindow.filter((r) => r.brentAtBriefing).map((r) => r.brentAtBriefing);
  return {
    briefings: inWindow.length,
    directionalVerdicts: scored.length,
    correct: hits,
    hitRatePct: scored.length ? Math.round((hits / scored.length) * 100) : null,
    neutralVerdicts: inWindow.filter((r) => r.verdict === "neutral").length,
    avgStrength: inWindow.length ? r2(inWindow.reduce((s, r) => s + (r.strength || 0), 0) / inWindow.length) : null,
    brentFirst: prices.at(-1) ?? null,
    brentLast: prices[0] ?? null,
  };
}

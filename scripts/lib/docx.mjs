// Word documents for the briefings: one per day, plus a rolling archive of everything retained.
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink,
} from "docx";
import { longDate } from "./store.mjs";

const FONT = "Calibri";
const INK = "1F1F1F";
const MUTED = "6B6B6B";
const BLUE = "1F5FAD";
const GREEN = "137333";
const RED = "B3261E";

const dirColour = (d) => (d === "bullish" ? GREEN : d === "bearish" ? RED : MUTED);
const dirWord = (d) => (d === "bullish" ? "Bullish" : d === "bearish" ? "Bearish" : d === "mixed" ? "Mixed" : d === "unclear" ? "Unclear" : "Neutral");
const verWord = (v) => (v === "confirmed" ? "Confirmed" : v === "reported" ? "Reported (single outlet)" : "Unconfirmed");
const strengthWord = (s) => ({ "-2": "strongly bearish", "-1": "moderately bearish", "0": "neutral", "1": "moderately bullish", "2": "strongly bullish" }[String(s)] || "neutral");

const verdictLabel = (d, s) => (d === "neutral" || !s ? dirWord(d) : `${dirWord(d)}, ${strengthWord(s)}`);
const t = (text, o = {}) => new TextRun({ text: String(text ?? ""), font: FONT, size: o.size ?? 21, bold: o.bold, italics: o.italics, color: o.color ?? INK });
const p = (runs, o = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], spacing: { after: o.after ?? 120, before: o.before ?? 0, line: 276 }, alignment: o.align, indent: o.indent, bullet: o.bullet ? { level: 0 } : undefined });
const h = (text, level, o = {}) => new Paragraph({ heading: level, pageBreakBefore: !!o.pageBreak, spacing: { before: o.before ?? 240, after: 100 }, children: [new TextRun({ text, font: FONT, bold: true, color: o.color ?? INK, size: o.size })] });
const link = (title, url) => new ExternalHyperlink({ link: url, children: [new TextRun({ text: title, font: FONT, size: 18, color: BLUE, underline: {} })] });

function sourceLine(sources) {
  if (!sources?.length) return p([t("Source: none verifiable", { size: 18, italics: true, color: MUTED })]);
  const kids = [t(sources.length > 1 ? "Sources: " : "Source: ", { size: 18, color: MUTED })];
  sources.forEach((s, i) => {
    if (i) kids.push(t("; ", { size: 18, color: MUTED }));
    kids.push(link(`${s.publisher ? s.publisher + ": " : ""}${s.title || s.url}`, s.url));
  });
  return p(kids, { after: 160 });
}

function tag(label, colour) { return t(`${label}   `, { size: 18, bold: true, color: colour }); }

export function briefingBlocks(b, newPage = false) {
  const out = [];
  const px = b.meta?.prices || {};
  const priceLine = ["brent", "wti"].filter((k) => px[k]?.price).map((k) =>
    `${k === "brent" ? "Brent" : "WTI"} $${px[k].price.toFixed(2)} (${px[k].chg24hPct >= 0 ? "+" : ""}${(px[k].chg24hPct ?? 0).toFixed(2)}% 24h)`).join("   ·   ");

  out.push(h(`Oil briefing: ${longDate(b.date)}`, HeadingLevel.HEADING_1, { before: 0, size: 32, pageBreak: newPage }));
  if (priceLine) out.push(p(t(priceLine, { size: 19, color: MUTED })));
  out.push(p([t(b.headline, { bold: true, size: 24 })], { after: 160 }));
  out.push(p(t(b.overview)));

  const v = b.verdict || {};
  out.push(h("Verdict for the next 24 hours", HeadingLevel.HEADING_2));
  out.push(p([t(`${verdictLabel(v.direction, v.strength)}. `, { bold: true, color: dirColour(v.direction) }), t(v.reasoning)]));

  out.push(h("Developments", HeadingLevel.HEADING_2));
  if (!b.developments?.length) out.push(p(t("No material developments in the period.", { italics: true, color: MUTED })));
  for (const d of b.developments || []) {
    out.push(h(d.title, HeadingLevel.HEADING_3, { before: 160 }));
    out.push(p([tag(d.category || "Other", MUTED), tag(dirWord(d.direction), dirColour(d.direction)), tag(`${(d.impact || "medium")[0].toUpperCase() + (d.impact || "medium").slice(1)} impact`, MUTED), tag(verWord(d.verification), d.verification === "unconfirmed" ? RED : MUTED), d.follow_up_of_previous ? tag("Update", BLUE) : t("")], { after: 60 }));
    out.push(p(t(d.summary)));
    out.push(p([t("Why it matters: ", { bold: true }), t(d.why_it_matters)]));
    if (d.verification_note) out.push(p(t(d.verification_note, { italics: true, size: 18, color: RED })));
    out.push(sourceLine(d.sources));
  }

  if (b.data_releases?.length) {
    out.push(h("Data releases", HeadingLevel.HEADING_2));
    for (const d of b.data_releases) {
      out.push(p([t(`${d.name}: `, { bold: true }), t(`${d.result}${d.vs_expectation ? ` (${d.vs_expectation})` : ""}. `), t(dirWord(d.direction), { color: dirColour(d.direction), bold: true })], { after: 40 }));
      out.push(sourceLine(d.sources));
    }
  }
  if (b.analyst_views?.length) {
    out.push(h("Analyst views", HeadingLevel.HEADING_2));
    for (const a of b.analyst_views) {
      out.push(p([t(`${a.who}: `, { bold: true }), t(`${a.view} `), t(dirWord(a.direction), { color: dirColour(a.direction), bold: true })], { after: 40 }));
      out.push(sourceLine(a.sources));
    }
  }
  if (b.public_sentiment) {
    const s = b.public_sentiment;
    out.push(h("Public sentiment (opinion, not fact)", HeadingLevel.HEADING_2));
    out.push(p([t(`Lean: ${dirWord(s.lean)}. `, { bold: true }), t(s.summary)]));
    for (const e of s.evidence || []) out.push(p(t(e), { bullet: true, after: 40 }));
    if (s.sources?.length) out.push(sourceLine(s.sources));
  }
  if (b.watch_today?.length) {
    out.push(h("What to watch", HeadingLevel.HEADING_2));
    for (const w of b.watch_today) out.push(p([t(`${w.item}`, { bold: true }), t(` (${w.when_utc}): ${w.why}`)], { bullet: true, after: 60 }));
  }
  const vr = b.meta?.verification;
  if (vr) out.push(p(t(`Verification: ${vr.kept} cited sources matched to pages retrieved during research; ${vr.removed} unmatched links removed${vr.downgraded?.length ? `; ${vr.downgraded.length} item(s) downgraded` : ""}. Generated ${new Date(b.meta.generatedAt).toISOString().replace("T", " ").slice(0, 16)} UTC by ${b.meta.model}.`, { size: 16, italics: true, color: MUTED }), { before: 200 }));
  return out;
}

function consensusBlocks(c, newPage = false) {
  if (!c?.week) return [];
  const out = [h("Consensus", HeadingLevel.HEADING_1, { before: 0, size: 32, pageBreak: newPage }), p(t(`Updated ${longDate(c.date)}.`, { color: MUTED, size: 19 }))];
  for (const [key, label] of [["week", "Past week"], ["month", "Past month"]]) {
    const x = c[key];
    if (!x) continue;
    const s = c.stats?.[key];
    out.push(h(`${label}: ${verdictLabel(x.direction, x.strength)} (${x.confidence} confidence)`, HeadingLevel.HEADING_2, { color: dirColour(x.direction) }));
    if (s) out.push(p(t(`Based on ${s.briefings} briefing(s). Daily verdict record: ${s.directionalVerdicts ? `${s.correct} of ${s.directionalVerdicts} directional calls correct` : "no scored calls yet"}.`, { size: 18, color: MUTED })));
    out.push(p(t(x.summary)));
    if (x.bullish_drivers?.length) { out.push(p(t("Bullish drivers", { bold: true, color: GREEN }), { after: 40 })); x.bullish_drivers.forEach((d) => out.push(p(t(`${d.driver}${d.dates?.length ? ` (${d.dates.join(", ")})` : ""}`), { bullet: true, after: 40 }))); }
    if (x.bearish_drivers?.length) { out.push(p(t("Bearish drivers", { bold: true, color: RED }), { after: 40, before: 80 })); x.bearish_drivers.forEach((d) => out.push(p(t(`${d.driver}${d.dates?.length ? ` (${d.dates.join(", ")})` : ""}`), { bullet: true, after: 40 }))); }
    out.push(p([t("How the narrative changed: ", { bold: true }), t(x.narrative_shift)], { before: 80 }));
    out.push(p([t("Prices versus evidence: ", { bold: true }), t(x.price_vs_evidence)]));
    if (x.key_risks?.length) { out.push(p(t("Key risks to the view", { bold: true }), { after: 40 })); x.key_risks.forEach((r) => out.push(p(t(r), { bullet: true, after: 40 }))); }
    out.push(p([t("What would change it: ", { bold: true }), t(x.what_would_change_it)], { before: 80 }));
  }
  return out;
}

function doc(children, title) {
  return new Document({
    title,
    creator: "Oil Desk",
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children }],
  });
}

export async function dailyDocx(briefing, consensus) {
  const children = [...briefingBlocks(briefing)];
  if (consensus?.week) children.push(...consensusBlocks(consensus, true));
  return Packer.toBuffer(doc(children, `Oil briefing ${briefing.date}`));
}

export async function archiveDocx(briefings, consensus) {
  const children = [
    p(t("Oil Desk briefing archive", { bold: true, size: 40 }), { after: 80 }),
    p(t(`${briefings.length} daily briefing(s), ${briefings.at(-1)?.date ?? ""} to ${briefings[0]?.date ?? ""}. Briefings older than 60 days are removed automatically.`, { color: MUTED })),
    ...consensusBlocks(consensus, true),
  ];
  for (const b of briefings) children.push(...briefingBlocks(b, true));
  return Packer.toBuffer(doc(children, "Oil Desk briefing archive"));
}

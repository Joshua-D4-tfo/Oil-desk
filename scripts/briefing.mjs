// Daily oil briefing. Run by GitHub Actions each morning (see .github/workflows/daily-briefing.yml).
//
// Steps:
//  1. Gather market data, headlines and public-sentiment data.
//  2. Ask Claude, with web search, to research the last 24 hours and write a structured briefing.
//  3. Remove any cited link Claude did not actually retrieve; downgrade items left unsourced.
//  4. Rebuild the weekly and monthly consensus from all stored briefings.
//  5. Write JSON for the website, a Word document for the day and a rolling Word archive.
//  6. Delete briefings older than 60 days.
//
// Environment: ANTHROPIC_API_KEY (required), EIA_API_KEY (optional), BRIEFING_MODEL (optional),
// FORCE=1 to regenerate today's briefing if it already exists.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherInputs } from "./lib/inputs.mjs";
import { askClaude, extractJson } from "./lib/claude.mjs";
import { DAILY_SYSTEM, dailyUser, CONSENSUS_SYSTEM, consensusUser, REPAIR_SYSTEM } from "./lib/prompts.mjs";
import { verifySources, validateBriefing } from "./lib/verify.mjs";
import { verdictScorecard, summarise } from "./lib/scorecard.mjs";
import { ensureDirs, listDates, readBriefing, writeJson, loadAll, applyRetention, dubaiDate, longDate, DOCS, RETENTION_DAYS } from "./lib/store.mjs";
import { dailyDocx, archiveDocx } from "./lib/docx.mjs";

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BRIEFING_MODEL || "claude-sonnet-5-5";
const FORCE = process.env.FORCE === "1" || process.env.FORCE === "true";
// Test hook: lets the offline test inject fake Claude responses.
const ask = globalThis.__askClaudeOverride || askClaude;

async function main() {
  const now = Date.now();
  const today = dubaiDate(now);
  await ensureDirs();

  const existing = await readBriefing(today);
  let briefing = existing;

  if (!existing || FORCE) {
    console.log(`Gathering inputs for ${today}...`);
    const inputs = await gatherInputs(now);
    console.log("Source status:", JSON.stringify(inputs.sourceStatus));

    const previousDate = (await listDates()).find((d) => d < today);
    const previous = previousDate ? await readBriefing(previousDate) : null;

    console.log(`Researching with ${MODEL}...`);
    const res = await ask({ key: KEY, model: MODEL, system: DAILY_SYSTEM, user: dailyUser(inputs, previous, longDate(today)), maxTokens: 32000, webSearch: { maxUses: 15 } });
    console.log(`Claude: stop=${res.stopReason}, searches=${res.usage.web_search_requests}, tokens in=${res.usage.input_tokens} out=${res.usage.output_tokens}, urls seen=${res.urls.length}`);

    try {
      if (res.stopReason === "max_tokens") throw new Error("research output was truncated");
      briefing = extractJson(res.text);
    } catch (e) {
      // Repair: rewrite the draft as complete, valid JSON. No web search, so no new sources can be
      // introduced, and the link verification below still applies to whatever is cited.
      console.warn(`Draft could not be used (${e.message}); asking Claude to rewrite it as complete JSON...`);
      const fix = await ask({ key: KEY, model: MODEL, system: REPAIR_SYSTEM, user: `${DAILY_SYSTEM.slice(DAILY_SYSTEM.indexOf("OUTPUT"))}\n\nDRAFT (may be cut off part-way):\n${res.text}`, maxTokens: 32000 });
      console.log(`Repair: stop=${fix.stopReason}, tokens in=${fix.usage.input_tokens} out=${fix.usage.output_tokens}`);
      briefing = extractJson(fix.text);
    }
    const errs = validateBriefing(briefing);
    if (errs.length) throw new Error(`Briefing failed validation: ${errs.join("; ")}`);

    const allowed = [...res.urls.map((u) => u.url), ...inputs.headlines.map((h) => h.url), ...(inputs.sentiment.reddit || []).map((r) => r.url)];
    const verification = verifySources(briefing, allowed);
    console.log(`Verification: kept ${verification.kept}, removed ${verification.removed}, downgraded ${verification.downgraded.length}`);
    if (verification.removed) console.log("Removed URLs:", verification.removedUrls.join(" | "));

    briefing = {
      date: today,
      ...briefing,
      meta: {
        generatedAt: now,
        model: res.model,
        searches: res.usage.web_search_requests,
        tokens: { input: res.usage.input_tokens, output: res.usage.output_tokens },
        verification,
        prices: { brent: pick(inputs.prices.brent), wti: pick(inputs.prices.wti) },
        sentimentData: {
          stocktwits: inputs.sentiment.stocktwits.map(({ symbol, messages, bullish, bearish }) => ({ symbol, messages, bullish, bearish })),
          redditPosts: inputs.sentiment.reddit?.length ?? null,
          errors: inputs.sentiment.errors,
        },
        sourceStatus: inputs.sourceStatus,
      },
    };
    await writeJson(`${today}.json`, briefing);
    console.log(`Saved ${today}.json`);
  } else {
    console.log(`Briefing for ${today} already exists; rebuilding consensus and documents only (set FORCE=1 to regenerate).`);
  }

  // Retention first, so the consensus and archive only cover what is kept.
  const removed = await applyRetention(today);
  if (removed.length) console.log(`Retention (${RETENTION_DAYS} days): removed ${removed.join(", ")}`);

  const all = await loadAll(); // newest first
  const rows = verdictScorecard(all);
  const stats = { week: summarise(rows, 7, today), month: summarise(rows, 31, today), scorecard: rows.slice(0, 31) };

  let consensus = null;
  try {
    const res = await ask({ key: KEY, model: MODEL, system: CONSENSUS_SYSTEM, user: consensusUser(all, stats, longDate(today)), maxTokens: 8000 });
    consensus = { date: today, generatedAt: Date.now(), model: res.model, ...extractJson(res.text), stats };
  } catch (e) {
    console.error("Consensus failed:", e.message);
    const prior = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../public/briefings/consensus.json", import.meta.url), "utf8")).then(JSON.parse).catch(() => null);
    consensus = prior ? { ...prior, stale: true, stats } : { date: today, error: e.message, stats };
  }
  await writeJson("consensus.json", consensus);

  // Word documents.
  await writeFile(join(DOCS, `oil-briefing-${today}.docx`), await dailyDocx(briefing, consensus));
  await writeFile(join(DOCS, "oil-briefing-archive.docx"), await archiveDocx(all, consensus));

  await writeJson("index.json", {
    updatedAt: Date.now(),
    latest: all[0]?.date ?? null,
    retentionDays: RETENTION_DAYS,
    archiveDocx: "docs/oil-briefing-archive.docx",
    briefings: all.map((b) => ({
      date: b.date,
      headline: b.headline,
      verdict: b.verdict ? { direction: b.verdict.direction, strength: b.verdict.strength } : null,
      developments: b.developments?.length ?? 0,
      docx: `docs/oil-briefing-${b.date}.docx`,
    })),
  });
  console.log("Done.");
}

function pick(p) {
  if (!p) return null;
  return { price: p.price, priceTime: p.priceTime, chg24hPct: p.chg24hPct, chg7dPct: p.chg7dPct, chg30dPct: p.chg30dPct };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

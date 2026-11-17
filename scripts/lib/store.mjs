// File storage for briefings. Everything lives in public/briefings so Netlify serves it as static files.
import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const ROOT = new URL("../../public/briefings/", import.meta.url).pathname;
export const DOCS = join(ROOT, "docs");
export const RETENTION_DAYS = 60;
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export async function ensureDirs() {
  await mkdir(DOCS, { recursive: true });
}

export async function listDates() {
  const files = await readdir(ROOT).catch(() => []);
  return files.map((f) => f.match(DAY_RE)?.[1]).filter(Boolean).sort().reverse(); // newest first
}

export async function readBriefing(date) {
  try { return JSON.parse(await readFile(join(ROOT, `${date}.json`), "utf8")); } catch { return null; }
}

export async function writeJson(name, data) {
  await writeFile(join(ROOT, name), JSON.stringify(data, null, 1) + "\n");
}

export async function loadAll() {
  const dates = await listDates();
  return (await Promise.all(dates.map(readBriefing))).filter(Boolean); // newest first
}

// Deletes briefings and their documents older than RETENTION_DAYS.
export async function applyRetention(todayDate) {
  const cutoff = new Date(`${todayDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cut = cutoff.toISOString().slice(0, 10);
  const removed = [];
  for (const f of await readdir(ROOT).catch(() => [])) {
    const d = f.match(DAY_RE)?.[1];
    if (d && d < cut) { await unlink(join(ROOT, f)); removed.push(f); }
  }
  for (const f of await readdir(DOCS).catch(() => [])) {
    const d = f.match(/(\d{4}-\d{2}-\d{2})\.docx$/)?.[1];
    if (d && d < cut) { await unlink(join(DOCS, f)); removed.push(`docs/${f}`); }
  }
  return removed;
}

export function dubaiDate(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export function longDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

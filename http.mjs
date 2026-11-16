// Shared HTTP helpers for all Netlify functions.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "*/*", ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, opts, timeoutMs) {
  const res = await fetchWithTimeout(url, opts, timeoutMs);
  return res.json();
}

export async function fetchText(url, opts, timeoutMs) {
  const res = await fetchWithTimeout(url, opts, timeoutMs);
  return res.text();
}

// cdnSeconds: how long Netlify's CDN keeps the response before refetching.
// stale-while-revalidate lets visitors get an instant answer while the CDN refreshes.
export function jsonResponse(data, cdnSeconds = 60, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": `public, durable, max-age=${cdnSeconds}, stale-while-revalidate=${cdnSeconds * 2}`,
    },
  });
}

// Runs a source and records success or failure so one broken source never breaks the page.
export async function safe(name, fn) {
  const started = Date.now();
  try {
    const data = await fn();
    return { ok: true, source: name, ms: Date.now() - started, data };
  } catch (err) {
    return { ok: false, source: name, ms: Date.now() - started, error: String(err.message || err) };
  }
}

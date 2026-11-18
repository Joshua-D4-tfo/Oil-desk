# Backtests on Capital.com's own CFD prices (bid/ask), using the Capital.com Open API.
# Reads credentials from environment variables only; never prints them.
import os, sys, time, json
import numpy as np, pandas as pd, requests

exec(open("backtest3.py").read().split("rows = []; data = {}")[0])   # strategy functions (s_gap, s_pair, s_eia, s_volbreak, s_donchian, ...)
exec(open("backtest2.py").read().split("rows = []")[0])              # s_orb, s_ma_filter, s_rsi2, s_intraday_mom
exec(open("backtest.py").read().split("rows = []")[0])               # run() for the plain 9/20 rule

KEY, IDENT, PWD = os.environ.get("CAPITAL_API_KEY"), os.environ.get("CAPITAL_IDENTIFIER"), os.environ.get("CAPITAL_API_PASSWORD")
if not (KEY and IDENT and PWD): sys.exit("Missing one of CAPITAL_API_KEY / CAPITAL_IDENTIFIER / CAPITAL_API_PASSWORD")
BASES = {"live": "https://api-capital.backend-capital.com", "demo": "https://demo-api-capital.backend-capital.com"}

def session():
    for name, base in BASES.items():
        r = requests.post(f"{base}/api/v1/session", headers={"X-CAP-API-KEY": KEY, "Content-Type": "application/json"},
                          json={"identifier": IDENT, "password": PWD, "encryptedPassword": False}, timeout=30)
        if r.ok and r.headers.get("CST"):
            print(f"Session opened on the {name} server", flush=True)
            return base, {"X-CAP-API-KEY": KEY, "CST": r.headers["CST"], "X-SECURITY-TOKEN": r.headers["X-SECURITY-TOKEN"]}
        print(f"{name} server: login refused ({r.status_code}) {r.text[:200]}", flush=True)
    sys.exit("Could not open a session on either server. Check the three secrets.")

BASE, H = session()
def get(path, **params):
    for attempt in range(5):
        r = requests.get(f"{BASE}{path}", headers=H, params=params, timeout=30)
        if r.status_code == 429: time.sleep(2 + attempt); continue
        return r
    return r

# Find the oil epics.
found = []
for term in ("Brent", "Crude", "WTI", "Oil"):
    r = get("/api/v1/markets", searchTerm=term)
    for m in (r.json().get("markets", []) if r.ok else []):
        found.append((m.get("epic"), m.get("instrumentName"), m.get("instrumentType"), m.get("expiry")))
found = sorted(set(found))
print("Oil-related markets found:"); [print("  ", f) for f in found if f[2] in ("COMMODITIES", None) or "Oil" in str(f[1])]
def pick(cands, prefer):
    for p in prefer:
        for e, n, t, x in cands:
            if e == p: return e
    return None
brent = pick(found, ["OIL_BRENT", "BRENT", "UKOIL"]) or next((e for e, n, t, x in found if n and "brent" in n.lower() and (x in (None, "-", "")) and "future" not in n.lower()), None)
wti = pick(found, ["OIL_CRUDE", "US_CRUDE", "USOIL", "WTI"]) or next((e for e, n, t, x in found if n and ("crude" in n.lower() or "wti" in n.lower()) and "brent" not in n.lower() and (x in (None, "-", ""))), None)
print("Using epics -> Brent:", brent, "| WTI:", wti, flush=True)
if not brent or not wti: sys.exit("Could not identify both oil epics")

STEP = {"MINUTE_15": pd.Timedelta(minutes=15), "HOUR": pd.Timedelta(hours=1)}
SPAN = {}
def fetch(epic, res, max_pages):
    frames = []; to = pd.Timestamp.now("UTC").floor("min").tz_localize(None)
    span = SPAN.get(res, 1.0)   # fraction of 1,000 bars per request; shrunk automatically if Capital.com refuses the range
    for page in range(max_pages):
        while True:
            frm = to - STEP[res] * 1000 * span
            r = get(f"/api/v1/prices/{epic}", resolution=res, max=1000, **{"from": frm.strftime("%Y-%m-%dT%H:%M:%S"), "to": to.strftime("%Y-%m-%dT%H:%M:%S")})
            if r.status_code == 400 and "daterange" in r.text and span > 0.02:
                span *= 0.6; continue
            break
        SPAN[res] = span
        if not r.ok:
            print(f"  {epic} {res} page {page}: HTTP {r.status_code} {r.text[:150]}"); break
        if page == 0: print(f"  {epic} {res}: accepted request span = {span * 1000:.0f} bars of calendar time", flush=True)
        p = r.json().get("prices", [])
        if not p: print(f"  {epic} {res}: no data before {to}"); break
        g = lambda x, k, side: (x.get(k) or {}).get(side)
        rows = [{"t": x["snapshotTimeUTC"], "ob": g(x, "openPrice", "bid"), "oa": g(x, "openPrice", "ask"), "hb": g(x, "highPrice", "bid"), "ha": g(x, "highPrice", "ask"),
                 "lb": g(x, "lowPrice", "bid"), "la": g(x, "lowPrice", "ask"), "cb": g(x, "closePrice", "bid"), "ca": g(x, "closePrice", "ask")} for x in p]
        frames.append(pd.DataFrame(rows)); to = pd.Timestamp(rows[0]["t"]) - pd.Timedelta(seconds=1)
        time.sleep(0.25)
    if not frames: return None
    d = pd.concat(frames).drop_duplicates("t")
    d.index = pd.to_datetime(d.t, utc=True).dt.tz_convert("America/New_York"); d = d.sort_index()
    d = d.apply(lambda col: pd.to_numeric(col, errors="coerce") if col.name != "t" else col)
    med = (d.ca - d.cb).median()
    med = 0.04 if pd.isna(med) else med
    missing = d.ca.isna().sum()
    if missing: print(f"  {epic} {res}: {missing} bars had no buy price; typical spread {med:.3f} assumed for them", flush=True)
    for b_, a_ in (("ob", "oa"), ("hb", "ha"), ("lb", "la"), ("cb", "ca")):
        d[a_] = d[a_].fillna(d[b_] + med); d[b_] = d[b_].fillna(d[a_] - med)
    out = pd.DataFrame({"Open": (d.ob + d.oa) / 2, "High": (d.hb + d.ha) / 2, "Low": (d.lb + d.la) / 2, "Close": (d.cb + d.ca) / 2, "spr": d.ca - d.cb}, index=d.index).dropna()
    return out

data = {}
for name, epic in (("Brent", brent), ("WTI", wti)):
    for res, pages in (("HOUR", 120), ("MINUTE_15", 120)):
        df = fetch(epic, res, pages)
        if df is not None:
            data[(name, res)] = df
            print(f"{name} {res}: {len(df)} bars, {df.index[0]} -> {df.index[-1]}, median spread {df.spr.median():.3f}", flush=True)

def metrics_cfd(trades, df, legs=1, spr_other=None):
    # Real cost: half the bid/ask spread at entry plus half at exit, at the actual bar times.
    if not trades: return None
    tr = pd.DataFrame(trades, columns=["t_in", "t_out", "dir", "entry", "exit"])
    s = df.spr.reindex(pd.DatetimeIndex(tr.t_in), method="ffill").values / 2 + df.spr.reindex(pd.DatetimeIndex(tr.t_out), method="ffill").values / 2
    if spr_other is not None:
        s = s + spr_other.reindex(pd.DatetimeIndex(tr.t_in), method="ffill").values / 2 + spr_other.reindex(pd.DatetimeIndex(tr.t_out), method="ffill").values / 2
    tr["gross"] = (tr.exit - tr.entry) * tr.dir; tr["cost"] = np.nan_to_num(s, nan=0.04 * legs); tr["net"] = tr.gross - tr.cost
    w = tr[tr.net > 0]; l = tr[tr.net <= 0]; h = len(tr) // 2
    eq = tr.net.cumsum()
    days = max((df.index[-1] - df.index[0]).total_seconds() / 86400, 1)
    by_year = tr.groupby(pd.DatetimeIndex(tr.t_in).year).net.sum().round(2).to_dict()
    return dict(trades=len(tr), per_week=round(len(tr) / days * 7, 2), win_rate=round(100 * len(w) / len(tr), 1), gross=round(tr.gross.sum(), 2),
                costs=round(tr.cost.sum(), 2), net=round(tr.net.sum(), 2), avg_net=round(tr.net.mean(), 3),
                pf=round(w.net.sum() / -l.net.sum(), 2) if l.net.sum() < 0 else None, max_dd=round((eq - eq.cummax()).min(), 2),
                net_h1=round(tr.net.iloc[:h].sum(), 2), net_h2=round(tr.net.iloc[h:].sum(), 2), by_year=json.dumps(by_year))

def gap_up_only(df, thr=0.003):
    return [t for t in s_gap(df) if t[2] == -1] if thr == 0.003 else None

rows = []
for name in ("Brent", "WTI"):
    for res in ("HOUR", "MINUTE_15"):
        df = data.get((name, res))
        if df is None: continue
        tests = {}
        if res == "HOUR":
            tests["Weekend gap fade (both directions)"] = lambda: s_gap(df)
            tests["Weekend gap fade (gap-ups only)"] = lambda: [t for t in s_gap(df) if t[2] == -1]
            tests["EIA Wednesday momentum (hourly)"] = lambda: s_eia(df, "momentum", 60)
            tests["MA 9/20 hold (no filter)"] = lambda: run(df, "SMA", "hold")[1].pipe(lambda x: list(zip(x.open_time, x.close_time, x.dir, x.entry, x.exit)) if len(x) else [])
            tests["MA 9/20 + 200 filter"] = lambda: s_ma_filter(df, False)
            tests["Volatility breakout k=0.3"] = lambda: s_volbreak(df, 0.3)
            tests["ORB 60-min range"] = lambda: s_orb(df, 60, 60)
        else:
            tests["ORB 15-min range"] = lambda: s_orb(df, 15, 15)
            tests["ORB 30-min range"] = lambda: s_orb(df, 30, 15)
            tests["Volatility breakout k=0.3"] = lambda: s_volbreak(df, 0.3)
            tests["Volatility breakout k=0.5"] = lambda: s_volbreak(df, 0.5)
            tests["Donchian 20 + ADX>20, ATR trail"] = lambda: s_donchian(df, True)
            tests["MA 9/20 + 200 filter"] = lambda: s_ma_filter(df, False)
            tests["MA 9/20 hold (no filter)"] = lambda: run(df, "SMA", "hold")[1].pipe(lambda x: list(zip(x.open_time, x.close_time, x.dir, x.entry, x.exit)) if len(x) else [])
            tests["False breakout fade"] = lambda: s_fade(df)
        for label, fn in tests.items():
            try:
                m = metrics_cfd(fn(), df)
                if m: rows.append(dict(strategy=label, market=name, timeframe=res, start=str(df.index[0])[:10], end=str(df.index[-1])[:10], **m))
            except Exception as e: print("FAIL", name, res, label, repr(e))
for res in ("HOUR", "MINUTE_15"):
    b, w = data.get(("Brent", res)), data.get(("WTI", res))
    if b is None or w is None: continue
    spr = (b.Close - w.Close).dropna()
    jumps = spr.diff().abs().sort_values(ascending=False).head(8)
    print(f"Largest bar-to-bar jumps in the Brent-WTI spread ({res}):"); print(jumps.round(2).to_string())
    for z in (2.0, 2.5):
        try:
            m = metrics_cfd(s_pair(b, w, entry_z=z), b, legs=2, spr_other=w.spr)
            if m: rows.append(dict(strategy=f"Brent-WTI spread reversion z>{z}", market="Brent-WTI", timeframe=res, start=str(b.index[0])[:10], end=str(b.index[-1])[:10], **m))
        except Exception as e: print("FAIL pair", res, repr(e))

out = pd.DataFrame(rows); out.to_csv("capital_results.csv", index=False)
pd.set_option("display.width", 320); pd.set_option("display.max_columns", 40); pd.set_option("display.max_colwidth", 80)
print("RESULTS_START"); print(out.to_string(index=False)); print("RESULTS_END")

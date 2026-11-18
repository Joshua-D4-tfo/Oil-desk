# Short-term strategy backtests on Brent (BZ=F) and WTI (CL=F), Yahoo Finance intraday bars (New York time).
# All signals are taken at a bar's close and executed at the next bar's open (or at the stop price if hit).
# Cost: $0.04/bbl per round trip (Capital.com lists 0.032 to 0.04 for Brent).
import numpy as np, pandas as pd, yfinance as yf

SPREAD = 0.04
SYMS = {"Brent": "BZ=F", "WTI": "CL=F"}
FRAMES = {"5m": "60d", "15m": "60d", "30m": "60d", "1h": "730d"}

def load(sym, interval, period):
    df = yf.download(sym, interval=interval, period=period, progress=False, auto_adjust=False, prepost=False)
    if isinstance(df.columns, pd.MultiIndex): df.columns = df.columns.get_level_values(0)
    df = df[["Open", "High", "Low", "Close"]].dropna()
    df = df[(df.Close > 0) & (df.Open > 0)]
    if df.index.tz is None: df.index = df.index.tz_localize("UTC")
    df.index = df.index.tz_convert("America/New_York")
    return df

def sma(s, n): return s.rolling(n).mean()
def rsi(s, n):
    d = s.diff(); up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))
def atr(df, n=14):
    pc = df.Close.shift(1)
    tr = pd.concat([df.High - df.Low, (df.High - pc).abs(), (df.Low - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()

def metrics(trades, days):
    if len(trades) < 1: return None
    tr = pd.DataFrame(trades, columns=["t_in", "t_out", "dir", "entry", "exit"])
    tr["gross"] = (tr.exit - tr.entry) * tr.dir
    tr["net"] = tr.gross - SPREAD
    tr["hours"] = (tr.t_out - tr.t_in).dt.total_seconds() / 3600
    eq = tr.net.cumsum(); dd = (eq - eq.cummax()).min()
    w = tr[tr.net > 0]; l = tr[tr.net <= 0]; h = len(tr) // 2
    return dict(trades=len(tr), per_day=round(len(tr) / days * 7 / 5, 2), win_rate=round(100 * len(w) / len(tr), 1),
                gross=round(tr.gross.sum(), 2), costs=round(SPREAD * len(tr), 2), net=round(tr.net.sum(), 2),
                avg_net=round(tr.net.mean(), 3), pf=round(w.net.sum() / -l.net.sum(), 2) if l.net.sum() < 0 else None,
                max_dd=round(dd, 2), med_hours=round(tr.hours.median(), 2),
                net_h1=round(tr.net.iloc[:h].sum(), 2), net_h2=round(tr.net.iloc[h:].sum(), 2))

# ---------- Strategy 1: 9/20 SMA with 200-bar trend filter (optional US-session entry filter) ----------
def s_ma_filter(df, session):
    c = df.Close.values; o = df.Open.values; f = sma(df.Close, 9).values; s = sma(df.Close, 20).values; t = sma(df.Close, 200).values
    hrs = df.index.hour.values; idx = df.index; trades = []; pos = 0; ent = None; tin = None
    for i in range(len(df) - 1):
        if np.isnan(t[i]): continue
        above = c[i] > f[i] and c[i] > s[i]; below = c[i] < f[i] and c[i] < s[i]
        ok = (8 <= hrs[i] < 15) if session else True
        if pos == 1 and (below or c[i] < t[i]): d = 0
        elif pos == -1 and (above or c[i] > t[i]): d = 0
        else: d = pos
        if d == 0 and ok:
            if above and c[i] > t[i]: d = 1
            elif below and c[i] < t[i]: d = -1
        if d != pos:
            px = o[i + 1]
            if pos != 0: trades.append((tin, idx[i + 1], pos, ent, px))
            if d != 0: ent, tin = px, idx[i + 1]
            pos = d
    return trades

# ---------- Strategy 2: Opening range breakout (NYMEX open 09:00 ET), stop at opposite side, exit 14:30 ET ----------
def s_orb(df, or_minutes, bar_minutes):
    trades = []
    for day, g in df.groupby(df.index.date):
        mins = g.index.hour * 60 + g.index.minute
        orb = g[(mins >= 540) & (mins < 540 + or_minutes)]
        if len(orb) < max(1, or_minutes // bar_minutes): continue
        hi, lo = orb.High.max(), orb.Low.min()
        after = g[(mins >= 540 + or_minutes) & (mins < 870)]
        exit_bars = g[mins >= 870]
        pos = 0; i_list = list(after.itertuples())
        for k, b in enumerate(i_list):
            if pos == 0:
                if k + 1 >= len(i_list): break
                if b.Close > hi: pos, ent, stop, tin = 1, i_list[k + 1].Open, lo, i_list[k + 1].Index
                elif b.Close < lo: pos, ent, stop, tin = -1, i_list[k + 1].Open, hi, i_list[k + 1].Index
                continue
            if b.Index < tin: continue
            if pos == 1 and b.Low <= stop: trades.append((tin, b.Index, 1, ent, min(stop, b.Open))); pos = 2; break
            if pos == -1 and b.High >= stop: trades.append((tin, b.Index, -1, ent, max(stop, b.Open))); pos = 2; break
        if pos in (1, -1):
            px = exit_bars.Open.iloc[0] if len(exit_bars) else after.Close.iloc[-1]
            t_out = exit_bars.index[0] if len(exit_bars) else after.index[-1]
            trades.append((tin, t_out, pos, ent, px))
    return trades

# ---------- Strategy 3: Intraday momentum (Wen et al. 2021 / Gao et al. 2018 adapted to futures) ----------
# Predictor: return from the previous session's reference close to today's early close. Trade: one fixed late window.
def s_intraday_mom(df, pred_prev_start, pred_today_start, trade_start, trade_bars, eia_variant=False, bar_minutes=30):
    trades = []; days = sorted(set(df.index.date)); bym = {}
    for ts, r in df.iterrows(): bym[(ts.date(), ts.hour * 60 + ts.minute)] = r
    for j in range(1, len(days)):
        d, p = days[j], days[j - 1]
        a = bym.get((p, pred_prev_start)); b = bym.get((d, pred_today_start))
        if eia_variant and pd.Timestamp(d).weekday() == 2:
            e = bym.get((d, 630))  # 10:30-11:00 ET bar on EIA Wednesdays
            if e is None: continue
            sig = e.Close - e.Open
        else:
            if a is None or b is None: continue
            sig = b.Close - a.Close
        first = bym.get((d, trade_start)); last = bym.get((d, trade_start + (trade_bars - 1) * bar_minutes))
        if first is None or last is None or sig == 0: continue
        dirn = 1 if sig > 0 else -1
        t_in = pd.Timestamp(f"{d} {trade_start // 60:02d}:{trade_start % 60:02d}", tz="America/New_York")
        trades.append((t_in, t_in + pd.Timedelta(minutes=bar_minutes * trade_bars), dirn, first.Open, last.Close))
    return trades

# ---------- Strategy 4: Connors RSI(2) pullback with 200-bar filter, exit on 5-bar SMA, 3x ATR stop, 20-bar time stop ----------
def s_rsi2(df, lo=10, hi=90, use_stop=True):
    c = df.Close.values; o = df.Open.values; H = df.High.values; L = df.Low.values
    r = rsi(df.Close, 2).values; t = sma(df.Close, 200).values; m5 = sma(df.Close, 5).values; a = atr(df).values
    idx = df.index; trades = []; pos = 0; i = 0; n = len(df)
    while i < n - 1:
        if pos == 0:
            if not np.isnan(t[i]) and not np.isnan(r[i]):
                if c[i] > t[i] and r[i] < lo: pos, ent, tin, k0, stop = 1, o[i + 1], idx[i + 1], i + 1, o[i + 1] - 3 * a[i]
                elif c[i] < t[i] and r[i] > hi: pos, ent, tin, k0, stop = -1, o[i + 1], idx[i + 1], i + 1, o[i + 1] + 3 * a[i]
            i += 1; continue
        # in a position: bar i is live
        if use_stop and pos == 1 and L[i] <= stop: trades.append((tin, idx[i], 1, ent, min(stop, o[i]))); pos = 0; i += 1; continue
        if use_stop and pos == -1 and H[i] >= stop: trades.append((tin, idx[i], -1, ent, max(stop, o[i]))); pos = 0; i += 1; continue
        done = (pos == 1 and c[i] > m5[i]) or (pos == -1 and c[i] < m5[i]) or (i - k0 >= 20)
        if done: trades.append((tin, idx[i + 1], pos, ent, o[i + 1])); pos = 0
        i += 1
    return trades

rows = []
for name, sym in SYMS.items():
    data = {}
    for tf, per in FRAMES.items():
        try: data[tf] = load(sym, tf, per)
        except Exception as e: print("LOAD FAIL", name, tf, e)
    for tf, df in data.items():
        days = max((df.index[-1] - df.index[0]).total_seconds() / 86400, 1)
        bm = {"5m": 5, "15m": 15, "30m": 30, "1h": 60}[tf]
        tests = []
        if tf in ("15m", "30m", "1h"):
            tests += [("MA 9/20 + 200 filter", lambda: s_ma_filter(df, False)), ("MA 9/20 + 200 filter + US hours", lambda: s_ma_filter(df, True))]
            tests += [("RSI(2) pullback, 3xATR stop", lambda: s_rsi2(df, 10, 90, True)), ("RSI(2) pullback, no stop", lambda: s_rsi2(df, 10, 90, False))]
        if tf in ("5m", "15m"):
            tests += [(f"ORB {m}-min range", (lambda m=m: s_orb(df, m, bm))) for m in (15, 30) if m >= bm]
        if tf == "1h":
            tests += [("ORB 60-min range", lambda: s_orb(df, 60, 60))]
        if tf == "30m":
            tests += [("Intraday momentum: overnight+first 30m -> 14:00-14:30", lambda: s_intraday_mom(df, 840, 540, 840, 1)),
                      ("Intraday momentum: USO-style 10:00 -> 15:30-16:00", lambda: s_intraday_mom(df, 930, 570, 930, 1)),
                      ("Intraday momentum: USO-style + EIA-day variant", lambda: s_intraday_mom(df, 930, 570, 930, 1, eia_variant=True))]
        if tf == "1h":
            tests += [("Intraday momentum (hourly): overnight+09:00 hour -> 13:00-14:00", lambda: s_intraday_mom(df, 780, 540, 780, 1, bar_minutes=60)),
                      ("Intraday momentum (hourly): overnight+09:00 hour -> 15:00-16:00", lambda: s_intraday_mom(df, 900, 540, 900, 1, bar_minutes=60))]
        for label, fn in tests:
            try: m = metrics(fn(), days)
            except Exception as e: print("FAIL", name, tf, label, e); continue
            if m: rows.append(dict(strategy=label, market=name, timeframe=tf, days=round(days), **m))
        print(name, tf, len(df), "bars", df.index[0], "->", df.index[-1], flush=True)

out = pd.DataFrame(rows)
out.to_csv("results2.csv", index=False)
pd.set_option("display.width", 300); pd.set_option("display.max_columns", 30); pd.set_option("display.max_colwidth", 70)
print("RESULTS_START")
print(out.to_string(index=False))
print("RESULTS_END")
# Pass test: net positive on both markets and both halves, profit factor > 1.1, at least 30 trades each.
print("PASS_START")
for (strat, tf), g in out.groupby(["strategy", "timeframe"]):
    if set(g.market) != {"Brent", "WTI"}: continue
    ok = all((r.net > 0) and (r.net_h1 > 0) and (r.net_h2 > 0) and (r.pf or 0) > 1.1 and r.trades >= 30 for r in g.itertuples())
    print(f"{'PASS' if ok else 'fail'} | {strat} | {tf} | " + " ; ".join(f"{r.market}: net {r.net:+.2f} (h1 {r.net_h1:+.2f}, h2 {r.net_h2:+.2f}), pf {r.pf}, n {r.trades}" for r in g.itertuples()))
print("PASS_END")

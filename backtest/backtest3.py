# Batch 3 of short-term oil strategy backtests (Brent BZ=F, WTI CL=F; Yahoo intraday bars, New York time).
# Signals at bar close, execution at next bar open, or at the stop/entry level for stop orders.
# Cost: $0.04/bbl per round trip per leg (Capital.com lists 0.032 to 0.04 for Brent).
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
def ema(s, n): return s.ewm(span=n, adjust=False).mean()
def atr(df, n=14):
    pc = df.Close.shift(1)
    tr = pd.concat([df.High - df.Low, (df.High - pc).abs(), (df.Low - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()
def adx(df, n=14):
    up = df.High.diff(); dn = -df.Low.diff()
    pdm = np.where((up > dn) & (up > 0), up, 0.0); mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    a = atr(df, n)
    pdi = 100 * pd.Series(pdm, index=df.index).ewm(alpha=1 / n, adjust=False).mean() / a
    mdi = 100 * pd.Series(mdm, index=df.index).ewm(alpha=1 / n, adjust=False).mean() / a
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean()

def metrics(trades, days, cost=SPREAD):
    if len(trades) < 1: return None
    tr = pd.DataFrame(trades, columns=["t_in", "t_out", "dir", "entry", "exit"])
    tr["gross"] = (tr.exit - tr.entry) * tr.dir
    tr["net"] = tr.gross - cost
    tr["hours"] = (pd.to_datetime(tr.t_out) - pd.to_datetime(tr.t_in)).dt.total_seconds() / 3600
    eq = tr.net.cumsum(); dd = (eq - eq.cummax()).min()
    w = tr[tr.net > 0]; l = tr[tr.net <= 0]; h = len(tr) // 2
    return dict(trades=len(tr), per_day=round(len(tr) / days * 7 / 5, 2), win_rate=round(100 * len(w) / len(tr), 1),
                gross=round(tr.gross.sum(), 2), costs=round(cost * len(tr), 2), net=round(tr.net.sum(), 2),
                avg_net=round(tr.net.mean(), 3), pf=round(w.net.sum() / -l.net.sum(), 2) if l.net.sum() < 0 else None,
                max_dd=round(dd, 2), med_hours=round(tr.hours.median(), 2),
                net_h1=round(tr.net.iloc[:h].sum(), 2), net_h2=round(tr.net.iloc[h:].sum(), 2))

def by_day(df):
    g = {d: x for d, x in df.groupby(df.index.date)}
    return g, sorted(g)

def minutes(ix): return ix.hour * 60 + ix.minute

# A. Volatility breakout (Williams/Crabel): from the 09:00 ET open, enter on a move of k x prior day's range; stop at the open; exit 14:30.
def s_volbreak(df, k):
    g, days = by_day(df); trades = []
    for j in range(1, len(days)):
        prev, d = g[days[j - 1]], g[days[j]]
        R = prev.High.max() - prev.Low.min(); m = minutes(d.index)
        sess = d[(m >= 540) & (m < 870)]; ex = d[m >= 870]
        if len(sess) < 2 or R <= 0: continue
        o = sess.Open.iloc[0]; up, lo = o + k * R, o - k * R; pos = 0
        for b in sess.iloc[1:].itertuples():
            if pos == 0:
                hu, hl = b.High >= up, b.Low <= lo
                if hu and hl: break
                if hu: pos, ent, tin = 1, max(up, b.Open), b.Index
                elif hl: pos, ent, tin = -1, min(lo, b.Open), b.Index
                if pos and ((pos == 1 and b.Low <= o) or (pos == -1 and b.High >= o)):
                    trades.append((tin, b.Index, pos, ent, o)); pos = 9
                continue
            if pos == 1 and b.Low <= o: trades.append((tin, b.Index, 1, ent, min(o, b.Open))); pos = 9; break
            if pos == -1 and b.High >= o: trades.append((tin, b.Index, -1, ent, max(o, b.Open))); pos = 9; break
        if pos in (1, -1):
            px = ex.Open.iloc[0] if len(ex) else sess.Close.iloc[-1]
            trades.append((tin, ex.index[0] if len(ex) else sess.index[-1], pos, ent, px))
    return trades

# B. False breakout fade: price breaks the prior day's high (low) after 09:00, then a bar closes back inside -> fade; stop beyond the day's extreme; exit 14:30.
def s_fade(df):
    g, days = by_day(df); trades = []
    for j in range(1, len(days)):
        prev, d = g[days[j - 1]], g[days[j]]
        pH, pL = prev.High.max(), prev.Low.min(); m = minutes(d.index)
        sess = d[(m >= 540) & (m < 840)]; ex = d[m >= 870]
        if len(sess) < 3: continue
        rows = list(sess.itertuples()); brokeH = brokeL = False; hi = -1e9; lo = 1e9; pos = 0
        for i, b in enumerate(rows):
            if pos == 0:
                hi, lo = max(hi, b.High), min(lo, b.Low)
                if b.High > pH: brokeH = True
                if b.Low < pL: brokeL = True
                if i + 1 >= len(rows): break
                if brokeH and b.Close < pH: pos, ent, tin, stop = -1, rows[i + 1].Open, rows[i + 1].Index, hi
                elif brokeL and b.Close > pL: pos, ent, tin, stop = 1, rows[i + 1].Open, rows[i + 1].Index, lo
                continue
            if b.Index < tin: continue
            if pos == 1 and b.Low <= stop: trades.append((tin, b.Index, 1, ent, min(stop, b.Open))); pos = 9; break
            if pos == -1 and b.High >= stop: trades.append((tin, b.Index, -1, ent, max(stop, b.Open))); pos = 9; break
        if pos in (1, -1):
            after = d[(d.index >= tin) & (m < 870)]
            for b in after.itertuples():
                if b.Index <= rows[-1].Index: continue
                if pos == 1 and b.Low <= stop: trades.append((tin, b.Index, 1, ent, min(stop, b.Open))); pos = 9; break
                if pos == -1 and b.High >= stop: trades.append((tin, b.Index, -1, ent, max(stop, b.Open))); pos = 9; break
            if pos in (1, -1):
                px = ex.Open.iloc[0] if len(ex) else after.Close.iloc[-1]
                trades.append((tin, ex.index[0] if len(ex) else after.index[-1], pos, ent, px))
    return trades

# C. Price-channel (Donchian 20) breakout with ADX(14) > 20 filter; exit on 10-bar opposite channel or 2x ATR trailing stop.
def s_donchian(df, use_adx=True):
    c, o, H, L = df.Close.values, df.Open.values, df.High.values, df.Low.values
    hh = df.High.rolling(20).max().shift(1).values; ll = df.Low.rolling(20).min().shift(1).values
    xh = df.High.rolling(10).max().shift(1).values; xl = df.Low.rolling(10).min().shift(1).values
    a = atr(df).values; ad = adx(df).values; idx = df.index; trades = []; pos = 0
    for i in range(30, len(df) - 1):
        if pos == 0:
            okf = (ad[i] > 20) if use_adx else True
            if okf and c[i] > hh[i]: pos, ent, tin, best = 1, o[i + 1], idx[i + 1], c[i]
            elif okf and c[i] < ll[i]: pos, ent, tin, best = -1, o[i + 1], idx[i + 1], c[i]
            continue
        if pos == 1:
            best = max(best, c[i])
            if c[i] < xl[i] or c[i] < best - 2 * a[i]: trades.append((tin, idx[i + 1], 1, ent, o[i + 1])); pos = 0
        else:
            best = min(best, c[i])
            if c[i] > xh[i] or c[i] > best + 2 * a[i]: trades.append((tin, idx[i + 1], -1, ent, o[i + 1])); pos = 0
    return trades

# D. Bollinger squeeze breakout: bandwidth at its lowest decile of 120 bars, then a close outside the bands; exit on middle-band cross.
def s_squeeze(df):
    c, o = df.Close.values, df.Open.values
    mid = sma(df.Close, 20); sd = df.Close.rolling(20).std(); up = (mid + 2 * sd).values; lo = (mid - 2 * sd).values
    bw = (4 * sd / mid); q = bw.rolling(120).quantile(0.1).values; bw = bw.values; mid = mid.values
    idx = df.index; trades = []; pos = 0; last_sq = -99
    for i in range(140, len(df) - 1):
        if bw[i] <= q[i]: last_sq = i
        if pos == 0:
            if i - last_sq <= 5:
                if c[i] > up[i]: pos, ent, tin = 1, o[i + 1], idx[i + 1]
                elif c[i] < lo[i]: pos, ent, tin = -1, o[i + 1], idx[i + 1]
            continue
        if (pos == 1 and c[i] < mid[i]) or (pos == -1 and c[i] > mid[i]): trades.append((tin, idx[i + 1], pos, ent, o[i + 1])); pos = 0
    return trades

# E. MACD(12,26,9) crossover with 200-bar trend filter (popular retail benchmark).
def s_macd(df):
    c, o = df.Close, df.Open.values; m = ema(c, 12) - ema(c, 26); s = ema(m, 9); t = sma(c, 200).values
    cross_up = ((m > s) & (m.shift(1) <= s.shift(1))).values; cross_dn = ((m < s) & (m.shift(1) >= s.shift(1))).values
    cv = c.values; idx = df.index; trades = []; pos = 0
    for i in range(201, len(df) - 1):
        if pos == 1 and cross_dn[i]: trades.append((tin, idx[i + 1], 1, ent, o[i + 1])); pos = 0
        elif pos == -1 and cross_up[i]: trades.append((tin, idx[i + 1], -1, ent, o[i + 1])); pos = 0
        if pos == 0:
            if cross_up[i] and cv[i] > t[i]: pos, ent, tin = 1, o[i + 1], idx[i + 1]
            elif cross_dn[i] and cv[i] < t[i]: pos, ent, tin = -1, o[i + 1], idx[i + 1]
    return trades

# F. EIA Wednesday: measure the move in the release window, then trade it (momentum) or fade it until 14:30.
def s_eia(df, mode, bar):
    g, days = by_day(df); trades = []
    for dd in days:
        if pd.Timestamp(dd).weekday() != 2: continue
        d = g[dd]; m = minutes(d.index)
        if bar == 30:
            w = d[m == 630]; entry = d[m == 660]; ex = d[m == 870]
            if len(w) == 0 or len(entry) == 0 or len(ex) == 0: continue
            move = w.Close.iloc[0] - w.Open.iloc[0]
        else:
            pre = d[m == 540]; w = d[m == 600]; entry = d[m == 660]; ex = d[m == 840]
            if len(pre) == 0 or len(w) == 0 or len(entry) == 0 or len(ex) == 0: continue
            move = w.Close.iloc[0] - pre.Close.iloc[0]
        if move == 0: continue
        dirn = (1 if move > 0 else -1) * (1 if mode == "momentum" else -1)
        trades.append((entry.index[0], ex.index[0], dirn, entry.Open.iloc[0], ex.Open.iloc[0]))
    return trades

# G. Weekend gap fade: Sunday-evening open versus Friday close; fade gaps over 0.3%; target gap fill, stop 1x gap, exit Monday 14:00.
def s_gap(df):
    trades = []; ix = df.index
    gaps = np.where((ix[1:] - ix[:-1]) > pd.Timedelta(hours=36))[0]
    for gi in gaps:
        fri_close = df.Close.iloc[gi]; k = gi + 1; o = df.Open.iloc[k]; gap = o - fri_close
        if abs(gap) < 0.003 * fri_close: continue
        dirn = -1 if gap > 0 else 1; target = fri_close; stop = o + gap; t_in = ix[k]
        deadline = (t_in + pd.Timedelta(days=1)).normalize() + pd.Timedelta(hours=14)
        done = False
        for j in range(k, len(df)):
            b = df.iloc[j]
            if ix[j] >= deadline: trades.append((t_in, ix[j], dirn, o, b.Open)); done = True; break
            if dirn == -1:
                if b.High >= stop: trades.append((t_in, ix[j], -1, o, max(stop, b.Open))); done = True; break
                if b.Low <= target: trades.append((t_in, ix[j], -1, o, target)); done = True; break
            else:
                if b.Low <= stop: trades.append((t_in, ix[j], 1, o, min(stop, b.Open))); done = True; break
                if b.High >= target: trades.append((t_in, ix[j], 1, o, target)); done = True; break
        if not done: break
    return trades

# H. Brent-WTI spread mean reversion: z-score of (Brent - WTI) over 120 bars; enter at |z| > 2, exit at z = 0 or after 48 bars. Two legs, so double cost.
def s_pair(b, w, look=120, entry_z=2.0, max_bars=48):
    j = pd.concat([b.Close.rename("b"), w.Close.rename("w"), b.Open.rename("bo"), w.Open.rename("wo")], axis=1).dropna()
    spr = j.b - j.w; z = ((spr - spr.rolling(look).mean()) / spr.rolling(look).std()).values
    so = (j.bo - j.wo).values; idx = j.index; trades = []; pos = 0
    for i in range(look, len(j) - 1):
        if pos == 0:
            if z[i] > entry_z: pos, ent, tin, k0 = -1, so[i + 1], idx[i + 1], i
            elif z[i] < -entry_z: pos, ent, tin, k0 = 1, so[i + 1], idx[i + 1], i
            continue
        if (pos == -1 and z[i] <= 0) or (pos == 1 and z[i] >= 0) or i - k0 >= max_bars:
            trades.append((tin, idx[i + 1], pos, ent, so[i + 1])); pos = 0
    return trades

rows = []; data = {}
for name, sym in SYMS.items():
    data[name] = {}
    for tf, per in FRAMES.items():
        try: data[name][tf] = load(sym, tf, per)
        except Exception as e: print("LOAD FAIL", name, tf, e)
for name in SYMS:
    for tf, df in data[name].items():
        days = max((df.index[-1] - df.index[0]).total_seconds() / 86400, 1)
        tests = []
        if tf in ("5m", "15m", "1h"):
            tests += [("Volatility breakout k=0.3", lambda: s_volbreak(df, 0.3)), ("Volatility breakout k=0.5", lambda: s_volbreak(df, 0.5))]
        if tf in ("15m", "30m", "1h"):
            tests += [("False breakout fade (prior-day high/low)", lambda: s_fade(df))]
            tests += [("Donchian 20 + ADX>20, ATR trail", lambda: s_donchian(df, True)), ("Donchian 20, no filter", lambda: s_donchian(df, False))]
            tests += [("Bollinger squeeze breakout", lambda: s_squeeze(df)), ("MACD + 200 filter", lambda: s_macd(df))]
        if tf == "30m":
            tests += [("EIA Wednesday momentum (10:30-11:00 -> 14:30)", lambda: s_eia(df, "momentum", 30)), ("EIA Wednesday fade (10:30-11:00 -> 14:30)", lambda: s_eia(df, "fade", 30))]
        if tf == "1h":
            tests += [("EIA Wednesday momentum (hourly)", lambda: s_eia(df, "momentum", 60)), ("EIA Wednesday fade (hourly)", lambda: s_eia(df, "fade", 60))]
            tests += [("Weekend gap fade", lambda: s_gap(df))]
        for label, fn in tests:
            try: m = metrics(fn(), days)
            except Exception as e: print("FAIL", name, tf, label, repr(e)); continue
            if m: rows.append(dict(strategy=label, market=name, timeframe=tf, days=round(days), **m))
        print("done", name, tf, flush=True)
for tf in ("30m", "1h"):
    try:
        b, w = data["Brent"][tf], data["WTI"][tf]
        days = max((b.index[-1] - b.index[0]).total_seconds() / 86400, 1)
        for z in (2.0, 2.5):
            m = metrics(s_pair(b, w, entry_z=z), days, cost=2 * SPREAD)
            if m: rows.append(dict(strategy=f"Brent-WTI spread reversion z>{z}", market="Brent-WTI", timeframe=tf, days=round(days), **m))
    except Exception as e: print("FAIL pair", tf, repr(e))

out = pd.DataFrame(rows); out.to_csv("results3.csv", index=False)
pd.set_option("display.width", 300); pd.set_option("display.max_columns", 30); pd.set_option("display.max_colwidth", 60)
print("RESULTS_START"); print(out.to_string(index=False)); print("RESULTS_END")
print("PASS_START")
for (strat, tf), g in out.groupby(["strategy", "timeframe"]):
    need = {"Brent-WTI"} if strat.startswith("Brent-WTI") else {"Brent", "WTI"}
    if set(g.market) != need: continue
    ok = all((r.net > 0) and (r.net_h1 > 0) and (r.net_h2 > 0) and (r.pf or 0) > 1.1 and r.trades >= 30 for r in g.itertuples())
    print(f"{'PASS' if ok else 'fail'} | {strat} | {tf} | " + " ; ".join(f"{r.market}: net {r.net:+.2f} (h1 {r.net_h1:+.2f}, h2 {r.net_h2:+.2f}), pf {r.pf}, n {r.trades}, win {r.win_rate}%" for r in g.itertuples()))
print("PASS_END")

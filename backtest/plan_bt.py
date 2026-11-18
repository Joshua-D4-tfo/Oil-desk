# Backtest of the proposed trading plan on Capital.com Brent and WTI spot CFDs (bid/ask), about 2 years of 15-minute bars.
import warnings; warnings.filterwarnings("ignore")
# Rules:
#  - Direction: daily trend, 20-day SMA vs 50-day SMA of daily closes, using only days already completed.
#  - Entry windows (prime hours): London 08:00-10:00 local and/or New York 08:00-12:00 local; Monday to Friday.
#  - Pullback setup: in the trend direction, a 15-minute close back across the 15-minute 20-period SMA after at least
#    one of the previous 4 closes was on the other side. Enter at the next bar's open.
#  - EIA setup (Wednesdays): the 10:30-10:45 New York bar's move; if it agrees with the daily trend, enter at 10:45.
#  - Exits: stop 1.5 x hourly ATR(14), target 2 x stop (variant 1.5 x), else closed at 23:59 Dubai.
#  - Risk rules: one position at a time, at most 2 trades per day.
#  - Costs: half the actual bid/ask spread at entry and at exit.
import numpy as np, pandas as pd
src = open("capital_bt.py").read()
exec(src.split("\ndata = {}\n")[0])
STEP["DAY"] = pd.Timedelta(days=1)

def prepare(epic):
    m15 = fetch(epic, "MINUTE_15", 120)
    day = fetch(epic, "DAY", 3)
    print(f"{epic}: 15m {len(m15)} bars {m15.index[0]} -> {m15.index[-1]}; daily {len(day)} bars", flush=True)
    # Daily trend known at the start of each day = SMAs of closes up to the previous daily bar.
    dc = day.Close
    # Each daily value only becomes usable once its bar has fully closed (bar timestamp + 1 day), so no lookahead
    # whichever way Capital.com stamps its daily bars.
    trend = np.sign(dc.rolling(20).mean() - dc.rolling(50).mean()).dropna()
    avail = pd.DataFrame({"t": (trend.index + pd.Timedelta(days=1)).tz_convert("UTC"), "trend": trend.values}).sort_values("t")
    d = m15.copy()
    left = pd.DataFrame({"t": d.index.tz_convert("UTC")})
    d["trend"] = pd.merge_asof(left, avail, on="t", direction="backward").trend.values
    d["sma20"] = d.Close.rolling(20).mean()
    h = d.resample("1h").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last"}).dropna()
    pc = h.Close.shift(1)
    tr = pd.concat([h.High - h.Low, (h.High - pc).abs(), (h.Low - pc).abs()], axis=1).max(axis=1)
    atr_h = tr.ewm(alpha=1 / 14, adjust=False).mean().shift(1)   # completed hours only
    d["atr_h"] = atr_h.reindex(d.index, method="ffill")
    lon = d.index.tz_convert("Europe/London"); ny = d.index.tz_convert("America/New_York"); dxb = d.index.tz_convert("Asia/Dubai")
    d["lon_prime"] = (lon.hour >= 8) & (lon.hour < 10)
    d["us_prime"] = ((ny.hour * 60 + ny.minute) >= 8 * 60 + 30) & (ny.hour < 12)   # from 08:30 NY, after the first 30 minutes
    d["weekday"] = dxb.weekday < 5
    d["dxb_date"] = dxb.date
    d["dxb_min"] = dxb.hour * 60 + dxb.minute
    d["ny_min"] = ny.hour * 60 + ny.minute; d["ny_wd"] = ny.weekday
    return d

def backtest(d, sessions=("us",), use_trend=True, eia=True, pullback=True, target_mult=2.0, max_trades=2):
    o, h, l, c = d.Open.values, d.High.values, d.Low.values, d.Close.values
    sma, atrv, trend = d.sma20.values, d.atr_h.values, d.trend.values
    prime = np.zeros(len(d), bool)
    if "us" in sessions: prime |= d.us_prime.values
    if "lon" in sessions: prime |= d.lon_prime.values
    prime &= d.weekday.values
    dates, dmin, nymin, nywd, idx = d.dxb_date.values, d.dxb_min.values, d.ny_min.values, d.ny_wd.values, d.index
    trades = []; pos = 0; count = {}
    i = 25
    while i < len(d) - 1:
        if pos != 0:
            # Close at 23:59 Dubai: exit at the open of the first bar on a later Dubai date.
            if dates[i] != entry_date:
                trades.append((tin, idx[i], pos, ent, o[i], "time")); pos = 0; continue
            if pos == 1 and l[i] <= stop: trades.append((tin, idx[i], 1, ent, min(stop, o[i]), "stop")); pos = 0
            elif pos == -1 and h[i] >= stop: trades.append((tin, idx[i], -1, ent, max(stop, o[i]), "stop")); pos = 0
            elif pos == 1 and h[i] >= tgt: trades.append((tin, idx[i], 1, ent, max(tgt, o[i]), "target")); pos = 0
            elif pos == -1 and l[i] <= tgt: trades.append((tin, idx[i], -1, ent, min(tgt, o[i]), "target")); pos = 0
            i += 1; continue
        t = trend[i] if use_trend else 0
        signal = 0; why = None
        if count.get(dates[i], 0) < max_trades and not np.isnan(atrv[i]) and dmin[i + 1] < 23 * 60 + 30 and dates[i + 1] == dates[i]:
            if eia and nywd[i] == 2 and nymin[i] == 10 * 60 + 30:
                mv = c[i] - o[i]
                dirn = 1 if mv > 0 else -1 if mv < 0 else 0
                if dirn and (not use_trend or dirn == t): signal, why = dirn, "eia"
            if not signal and pullback and prime[i] and not np.isnan(sma[i]):
                prev = c[i - 4:i] - sma[i - 4:i]
                up = c[i] > sma[i] and (prev < 0).any()
                dn = c[i] < sma[i] and (prev > 0).any()
                if use_trend:
                    if t == 1 and up: signal = 1
                    elif t == -1 and dn: signal = -1
                else:
                    signal = 1 if up else -1 if dn else 0
                if signal: why = "pullback"
        if signal:
            pos, ent, tin, entry_date = signal, o[i + 1], idx[i + 1], dates[i + 1]
            dist = 1.5 * atrv[i]
            stop, tgt = ent - signal * dist, ent + signal * target_mult * dist
            count[dates[i]] = count.get(dates[i], 0) + 1
            meta[tin] = (dist, why)
            i += 1
            continue
        i += 1
    return trades

def evaluate(trades, d):
    if not trades: return None, None
    tr = pd.DataFrame(trades, columns=["t_in", "t_out", "dir", "entry", "exit", "outcome"])
    tr["risk"] = [meta[t][0] for t in tr.t_in]; tr["setup"] = [meta[t][1] for t in tr.t_in]
    ti, to = pd.DatetimeIndex(tr.t_in), pd.DatetimeIndex(tr.t_out)
    cost = d.spr.reindex(ti, method="ffill").values / 2 + d.spr.reindex(to, method="ffill").values / 2
    tr["gross"] = (tr.exit - tr.entry) * tr.dir; tr["cost"] = cost; tr["net"] = tr.gross - tr.cost
    tr["R"] = tr.net / tr.risk
    eqR = tr.R.cumsum(); h = len(tr) // 2
    w = tr[tr.net > 0]; lo = tr[tr.net <= 0]
    months = tr.groupby(ti.to_period("Q")).R.sum()
    res = dict(trades=len(tr), per_week=round(len(tr) / ((d.index[-1] - d.index[0]).days / 7), 2), win_rate=round(100 * len(w) / len(tr), 1),
               net_usd_per_bbl=round(tr.net.sum(), 2), costs_usd_per_bbl=round(tr.cost.sum(), 2), total_R=round(tr.R.sum(), 1), avg_R=round(tr.R.mean(), 3),
               pf=round(w.net.sum() / -lo.net.sum(), 2) if lo.net.sum() < 0 else None, max_dd_R=round((eqR - eqR.cummax()).min(), 1),
               R_h1=round(tr.R.iloc[:h].sum(), 1), R_h2=round(tr.R.iloc[h:].sum(), 1),
               pos_quarters=f"{int((months > 0).sum())}/{len(months)}",
               targets=int((tr.outcome == "target").sum()), stops=int((tr.outcome == "stop").sum()), time_exits=int((tr.outcome == "time").sum()))
    return res, tr

meta = {}
rows = []; detail = {}
for name, epic in (("Brent", brent), ("WTI", wti)):
    d = prepare(epic)
    variants = {
        "PLAN: US pullback + EIA, trend filter, 2R": dict(),
        "Plan, US + London sessions": dict(sessions=("us", "lon")),
        "Plan, target 1.5R": dict(target_mult=1.5),
        "Plan without trend filter": dict(use_trend=False),
        "Pullback only (no EIA)": dict(eia=False),
        "EIA only": dict(pullback=False),
        "Plan, 1 trade per day": dict(max_trades=1),
    }
    for label, kw in variants.items():
        res, tr = evaluate(backtest(d, **kw), d)
        if res:
            rows.append(dict(variant=label, market=name, start=str(d.index[0])[:10], end=str(d.index[-1])[:10], **res))
            if label.startswith("PLAN"): detail[name] = tr

out = pd.DataFrame(rows); out.to_csv("plan_results.csv", index=False)
pd.set_option("display.width", 330); pd.set_option("display.max_columns", 40); pd.set_option("display.max_colwidth", 60)
print("RESULTS_START"); print(out.to_string(index=False)); print("RESULTS_END")
for name, tr in detail.items():
    print(f"\n{name} PLAN by quarter (R):"); print(tr.groupby(pd.DatetimeIndex(tr.t_in).to_period("Q")).R.agg(["count", "sum"]).round(1).T.to_string())
    print(f"{name} PLAN by setup:"); print(tr.groupby("setup").agg(n=("R", "size"), R=("R", "sum"), win=("R", lambda x: round(100 * (x > 0).mean(), 1))).to_string())
    print(f"{name} PLAN by direction:"); print(tr.groupby("dir").agg(n=("R", "size"), R=("R", "sum")).to_string())

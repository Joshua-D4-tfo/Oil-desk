# 9/20 moving-average strategy backtest on Brent (BZ=F) and WTI (CL=F) intraday bars from Yahoo Finance.
# Rule: long when the candle closes above both MAs, short when it closes below both.
#   Variant "hold": when the close is between the MAs, keep the current position.
#   Variant "flat": when the close is between the MAs, close the position and wait.
# Execution at the NEXT candle's open (you only know the close once the candle has finished).
# Cost: spread of $0.04/bbl per round trip (Capital.com lists 0.032 to 0.04 for Brent).
import sys, json, math
import numpy as np, pandas as pd, yfinance as yf

SPREAD = 0.04
SYMS = {"Brent": "BZ=F", "WTI": "CL=F"}
FRAMES = {"5m": "60d", "15m": "60d", "30m": "60d", "1h": "730d"}

def load(sym, interval, period):
    df = yf.download(sym, interval=interval, period=period, progress=False, auto_adjust=False, prepost=False)
    if isinstance(df.columns, pd.MultiIndex): df.columns = df.columns.get_level_values(0)
    df = df[["Open", "High", "Low", "Close"]].dropna()
    df = df[(df.Close > 0) & (df.Open > 0)]
    return df

def ma(s, n, kind):
    return s.rolling(n).mean() if kind == "SMA" else s.ewm(span=n, adjust=False).mean()

def run(df, kind, variant):
    c = df.Close; f = ma(c, 9, kind); s = ma(c, 20, kind)
    above = (c > f) & (c > s); below = (c < f) & (c < s)
    target = pd.Series(np.nan, index=df.index)
    target[above] = 1; target[below] = -1
    if variant == "hold": target = target.ffill().fillna(0)
    else: target = target.fillna(0)
    target[s.isna()] = 0
    pos = target.shift(1).fillna(0)          # position held during each bar, entered at that bar's open
    opens = df.Open.values; closes = c.values; idx = df.index; p = pos.values
    trades = []; cur = 0; entry = None; t0 = None
    for i in range(len(df)):
        if p[i] != cur:
            if cur != 0:
                trades.append((t0, idx[i], cur, entry, opens[i]))
            cur = p[i]
            if cur != 0: entry = opens[i]; t0 = idx[i]
    if cur != 0: trades.append((t0, idx[-1], cur, entry, closes[-1]))
    if not trades: return None, []
    tr = pd.DataFrame(trades, columns=["open_time", "close_time", "dir", "entry", "exit"])
    tr["gross"] = (tr.exit - tr.entry) * tr.dir
    tr["net"] = tr.gross - SPREAD
    tr["hours"] = (tr.close_time - tr.open_time).dt.total_seconds() / 3600
    eq = tr.net.cumsum(); dd = (eq - eq.cummax()).min()
    days = max((idx[-1] - idx[0]).total_seconds() / 86400, 1)
    wins = tr[tr.net > 0]; losses = tr[tr.net <= 0]
    half = len(tr) // 2
    res = dict(trades=len(tr), trades_per_day=round(len(tr) / days * 7 / 5, 1),
               win_rate=round(100 * len(wins) / len(tr), 1),
               gross_total=round(tr.gross.sum(), 2), costs=round(SPREAD * len(tr), 2), net_total=round(tr.net.sum(), 2),
               avg_net=round(tr.net.mean(), 3), avg_win=round(wins.net.mean(), 3) if len(wins) else 0, avg_loss=round(losses.net.mean(), 3) if len(losses) else 0,
               profit_factor=round(wins.net.sum() / -losses.net.sum(), 2) if losses.net.sum() < 0 else None,
               max_drawdown=round(dd, 2), median_hours=round(tr.hours.median(), 2),
               net_first_half=round(tr.net.iloc[:half].sum(), 2), net_second_half=round(tr.net.iloc[half:].sum(), 2),
               start=str(idx[0])[:16], end=str(idx[-1])[:16], days=round(days, 1),
               price_start=round(float(c.iloc[0]), 2), price_end=round(float(c.iloc[-1]), 2))
    return res, tr

rows = []; monthly = []
for name, sym in SYMS.items():
    for tf, per in FRAMES.items():
        try: df = load(sym, tf, per)
        except Exception as e: print("LOAD FAIL", name, tf, e); continue
        print(name, tf, len(df), "bars", df.index[0], "->", df.index[-1])
        for kind in ["SMA", "EMA"]:
            for variant in ["hold", "flat"]:
                res, tr = run(df, kind, variant)
                if res: rows.append(dict(market=name, timeframe=tf, ma=kind, rule=variant, **res))
                if res and tf == "1h" and kind == "SMA":
                    m = tr.set_index("close_time").net.resample("ME").agg(["sum", "count"]).reset_index()
                    for _, r in m.iterrows(): monthly.append(dict(market=name, rule=variant, month=str(r.close_time)[:7], net=round(r["sum"], 2), trades=int(r["count"])))
out = pd.DataFrame(rows); out.to_csv("results.csv", index=False)
pd.DataFrame(monthly).to_csv("monthly_1h.csv", index=False)
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
print(out[["market","timeframe","ma","rule","trades","trades_per_day","win_rate","gross_total","costs","net_total","avg_net","profit_factor","max_drawdown","median_hours","net_first_half","net_second_half","days","price_start","price_end"]].to_string(index=False))

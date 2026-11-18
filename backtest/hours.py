# Hour-by-hour profile of Brent and WTI spot CFDs on Capital.com (15-minute bars, about 2 years), in Dubai time.
# For each hour: typical price movement versus the bid/ask spread, which is the cost of a round-trip trade.
import numpy as np, pandas as pd
src = open("capital_bt.py").read()
exec(src.split("\ndata = {}\n")[0])

def profile(df, name, since=None):
    d = df.copy()
    if since is not None: d = d[d.index >= since]
    d.index = d.index.tz_convert("Asia/Dubai")
    d["date"] = d.index.date; d["hour"] = d.index.hour; d["wd"] = d.index.weekday
    g = d.groupby(["date", "hour"]).agg(o=("Open", "first"), c=("Close", "last"), h=("High", "max"), l=("Low", "min"), spr=("spr", "median"), wd=("wd", "first"), n=("Open", "size"))
    g = g[g.n >= 3]
    g["range"] = g.h - g.l; g["move"] = (g.c - g.o).abs()
    out = g.groupby(level="hour").agg(hours=("range", "size"), avg_range=("range", "mean"), avg_move=("move", "mean"), spread=("spr", "median"))
    out["range_to_spread"] = (out.avg_range / out.spread).round(1)
    out["share_of_day_range_pct"] = (100 * out.avg_range / out.avg_range.sum()).round(1)
    wed = g[g.wd == 2].groupby(level="hour").range.mean(); other = g[g.wd != 2].groupby(level="hour").range.mean()
    out["wed_range"] = wed; out["other_days_range"] = other
    print(f"\n=== {name} {'since ' + str(since)[:10] if since is not None else 'full 2 years'} (Dubai time; $ per barrel) ===")
    print(out.round(3).to_string())
    win = out.loc[8:23]
    print(f"Within 08:00-23:59: best five hours by range-to-spread: {', '.join(f'{h:02d}:00 ({r})' for h, r in win.range_to_spread.sort_values(ascending=False).head(5).items())}")
    print(f"Quietest five hours: {', '.join(f'{h:02d}:00 ({r})' for h, r in win.range_to_spread.sort_values().head(5).items())}")

for name, epic in (("Brent", brent), ("WTI", wti)):
    df = fetch(epic, "MINUTE_15", 120)
    print(f"{name}: {len(df)} bars {df.index[0]} -> {df.index[-1]}", flush=True)
    profile(df, name)
    profile(df, name, since=df.index[-1] - pd.Timedelta(days=183))

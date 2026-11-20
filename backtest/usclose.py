# Does oil fall into the US close? Sell at a set New York time, buy back later the same day, every weekday.
# Capital.com Brent and WTI spot, 15-minute bars, about 2 years, real bid/ask spread charged.
import warnings; warnings.filterwarnings("ignore")
import numpy as np, pandas as pd
src = open("capital_bt.py").read()
exec(src.split("\ndata = {}\n")[0])

# (label, entry NY time, exit NY time). Settlement is 14:28-14:30 New York (23:28-23:30 Dubai in winter).
WINDOWS = [
    ("13:00 to 14:30 NY (22:00 to 23:30 Dubai)", "13:00", "14:30"),
    ("13:30 to 14:30 NY (22:30 to 23:30 Dubai)", "13:30", "14:30"),
    ("14:00 to 14:30 NY (23:00 to 23:30 Dubai)", "14:00", "14:30"),
    ("14:00 to 15:00 NY (23:00 to 00:00 Dubai)", "14:00", "15:00"),
    ("14:30 to 16:00 NY (23:30 to 01:00 Dubai, after settlement)", "14:30", "16:00"),
    ("12:00 to 14:30 NY (21:00 to 23:30 Dubai)", "12:00", "14:30"),
]

rows = []
for name, epic in (("Brent", brent), ("WTI", wti)):
    d = fetch(epic, "MINUTE_15", 120)
    print(f"{name}: {len(d)} bars {d.index[0]} -> {d.index[-1]}", flush=True)
    d = d[d.index.weekday < 5]
    hhmm = d.index.strftime("%H:%M"); day = d.index.date
    for label, t_in, t_out in WINDOWS:
        a = d[hhmm == t_in]; b = d[hhmm == t_out]
        a = a.set_index(pd.Index(a.index.date)); b = b.set_index(pd.Index(b.index.date))
        j = a[["Open", "spr"]].join(b[["Open", "spr"]], lsuffix="_in", rsuffix="_out", how="inner")
        if len(j) < 50: continue
        move = j.Open_out - j.Open_in                      # price change; a short profits when this is negative
        cost = j.spr_in / 2 + j.spr_out / 2
        short = -move - cost
        h = len(j) // 2
        recent = short[short.index >= (j.index[-1] - pd.Timedelta(days=91))]
        rows.append(dict(market=name, window=label, days=len(j),
                         pct_days_down=round(100 * (move < 0).mean(), 1),
                         avg_move=round(move.mean(), 3), median_move=round(move.median(), 3),
                         short_net_total=round(short.sum(), 2), short_net_avg=round(short.mean(), 3),
                         short_win_rate=round(100 * (short > 0).mean(), 1),
                         first_half=round(short.iloc[:h].sum(), 2), second_half=round(short.iloc[h:].sum(), 2),
                         last_3m=round(recent.sum(), 2), last_3m_days=len(recent),
                         t_stat=round(short.mean() / (short.std() / np.sqrt(len(short))), 2)))

out = pd.DataFrame(rows); out.to_csv("usclose_results.csv", index=False)
pd.set_option("display.width", 300); pd.set_option("display.max_columns", 30); pd.set_option("display.max_colwidth", 70)
print("RESULTS_START"); print(out.to_string(index=False)); print("RESULTS_END")

# Does oil move in a set direction into the Asian close? Enter at a set Dubai time, exit later the same morning, every weekday. Both directions.
# Capital.com Brent and WTI spot, 15-minute bars, about 2 years, real bid/ask spread charged.
import warnings; warnings.filterwarnings("ignore")
import numpy as np, pandas as pd
src = open("capital_bt.py").read()
exec(src.split("\ndata = {}\n")[0])

# (label, entry NY time, exit NY time). Settlement is 14:28-14:30 New York (23:28-23:30 Dubai in winter).
# Dubai times (no daylight saving in Dubai, Tokyo, Shanghai or Singapore). Tokyo closes 10:00 Dubai,
# Shanghai INE crude day session 11:00, Singapore 13:00; London opens 12:00 Dubai in winter, 11:00 in summer.
WINDOWS = [
    ("09:00 to 10:00 (into Tokyo close)", "09:00", "10:00"),
    ("10:00 to 11:00 (into Shanghai close)", "10:00", "11:00"),
    ("09:00 to 11:00 (Tokyo and Shanghai closes)", "09:00", "11:00"),
    ("11:00 to 12:00 (after Shanghai, before London)", "11:00", "12:00"),
    ("12:00 to 13:00 (into Singapore close)", "12:00", "13:00"),
    ("08:00 to 12:00 (whole Asian morning)", "08:00", "12:00"),
]

rows = []
for name, epic in (("Brent", brent), ("WTI", wti)):
    d = fetch(epic, "MINUTE_15", 120)
    print(f"{name}: {len(d)} bars {d.index[0]} -> {d.index[-1]}", flush=True)
    d = d.tz_convert("Asia/Dubai"); d = d[d.index.weekday < 5]
    hhmm = d.index.strftime("%H:%M"); day = d.index.date
    for label, t_in, t_out in WINDOWS:
        a = d[hhmm == t_in]; b = d[hhmm == t_out]
        a = a.set_index(pd.Index(a.index.date)); b = b.set_index(pd.Index(b.index.date))
        j = a[["Open", "spr"]].join(b[["Open", "spr"]], lsuffix="_in", rsuffix="_out", how="inner")
        if len(j) < 50: continue
        move = j.Open_out - j.Open_in                      # price change; a short profits when this is negative
        cost = j.spr_in / 2 + j.spr_out / 2
        h = len(j) // 2
        for side, pnl in (("sell", -move - cost), ("buy", move - cost)):
            recent = pnl[pnl.index >= (j.index[-1] - pd.Timedelta(days=91))]
            rows.append(dict(market=name, window=label, side=side, days=len(j),
                             pct_days_down=round(100 * (move < 0).mean(), 1), avg_move=round(move.mean(), 3),
                             net_total=round(pnl.sum(), 2), net_avg=round(pnl.mean(), 3), win_rate=round(100 * (pnl > 0).mean(), 1),
                             gross_total=round((pnl + cost).sum(), 2),
                             first_half=round(pnl.iloc[:h].sum(), 2), second_half=round(pnl.iloc[h:].sum(), 2),
                             last_3m=round(recent.sum(), 2), t_stat=round(pnl.mean() / (pnl.std() / np.sqrt(len(pnl))), 2)))

out = pd.DataFrame(rows); out.to_csv("asiaclose_results.csv", index=False)
pd.set_option("display.width", 300); pd.set_option("display.max_columns", 30); pd.set_option("display.max_colwidth", 70)
print("RESULTS_START"); print(out.to_string(index=False)); print("RESULTS_END")

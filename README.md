# Oil Desk

A Netlify-hosted dashboard that brings together the data needed to decide whether to take a short-term position in crude oil. A switch at the top of the page selects the benchmark, either **Brent** or **WTI (US crude)**, and the choice is remembered on that device. For the selected benchmark, the page produces a suggestion for two horizons and sets out the full reasoning behind each one.

The two horizons are:

- **Intraday:** a holding period of hours.
- **Swing:** a holding period of one to five days.

## 1. What the page shows

| Section | Content | Refresh |
|---|---|---|
| Suggestion cards | BUY, LEAN BUY, NO TRADE, LEAN SELL, SELL or WAIT, with a conviction score, entry, stop and two targets | Every 60 seconds |
| Price tiles | Brent, WTI, Brent minus WTI, Brent M1 to M2 spread and the dollar index, each with a five-day sparkline | Every 60 seconds (curve every 15 minutes) |
| Full reasoning | A written explanation plus a factor table: the reading, why it matters, the score, the weight and the contribution of each factor | On every data update |
| News flow | Headlines from six feeds, each scored for direction, with the matched themes and event-risk flags shown | Every 5 minutes |
| Upcoming events | EIA, API, CFTC and rig count releases, Saudi OSPs, the OPEC+ meeting and the FOMC decision, in Dubai time | Continuous |
| Fundamentals | EIA inventories against the five-year seasonal norm, CFTC managed-money positioning and the Brent curve | Every 30 minutes |
| Second opinion | Optional written review by Claude, which challenges or confirms the rule-based view | Every 15 minutes |
| Refining and volatility tiles | 3-2-1 crack spread against the selected benchmark, and the CBOE oil volatility index (OVX) with the suggested position size | Every 5 minutes |
| Track record | Simulated results of the signals (win rate, average and total R, equity curve, recent trades) and the reliability of each factor | Logged every 15 minutes |

## 2. Deployment

1. Create a new GitHub repository, for example `oil-desk`, and upload the contents of this folder. `netlify.toml` must sit at the top level of the repository.
2. In Netlify, choose **Add new site > Import an existing project**, select the repository and deploy. No build command is needed, and the project has no dependencies.
3. In Netlify, go to **Site configuration > Environment variables** and add the following:
   - `EIA_API_KEY` (required for inventories). The key is free from https://www.eia.gov/opendata/register.php and arrives by email within a few minutes.
   - `ANTHROPIC_API_KEY` (optional). This switches on the written second opinion. Each refresh is a single API call, at most four per hour per viewer cache cycle.
   - `ANTHROPIC_MODEL` (optional). This overrides the default model, `claude-sonnet-5-5`.
4. Trigger a redeploy so the functions pick up the variables.

## 3. How the suggestion is produced

Each factor is scored from -1 (bearish) to +1 (bullish). Each score is then multiplied by a horizon-specific weight. The weights are renormalised over whichever factors have data at that moment.

The weights below apply to Brent. WTI is priced at Cushing, Oklahoma, so for WTI the weight on US inventories rises (intraday 10%, swing 22%) at the expense of news flow, the curve and positioning. The exact WTI weights are in `WEIGHTS_WTI` in `public/js/engine.js`.

| Factor | Measure | Intraday weight | Swing weight |
|---|---|---|---|
| Short-term trend | Price versus 20-hour EMA; 20-hour EMA versus 50-hour EMA, scaled by ATR | 24% | 14% |
| News flow | Keyword-scored headlines with an eight-hour recency half-life | 22% | 16% |
| Momentum | 24-hour and five-day returns | 18% | 8% |
| Futures curve | Brent M1 to M2 spread level and its five-session change | 10% | 20% |
| RSI | Fades overbought (above 70) and oversold (below 30) conditions only | 8% | 4% |
| Dollar | Five-day change in the dollar index (inverse) | 8% | 8% |
| Inventories | Weekly change versus the five-year seasonal average, the Cushing level and the stock level versus its five-year average | 6% | 16% |
| Positioning | Three-year percentile of managed-money net length (contrarian at the extremes) | 4% | 14% |
| Refining margin | 3-2-1 crack spread versus its one-month average and its five-day change | 5% | 10% |

**Volatility regime (OVX).** OVX does not vote on direction. Instead it sets the suggested position size, which is 35 divided by the current OVX, capped at 100% and floored at 35%. When OVX is in the top 20% of its six-month range, or has risen 20% or more in five days, conviction is also reduced by 15%.

The composite score maps to a label as follows:

| Composite score | Label |
|---|---|
| 0.30 or above | BUY |
| 0.12 to 0.30 | LEAN BUY |
| -0.12 to 0.12 | NO TRADE |
| -0.30 to -0.12 | LEAN SELL |
| -0.30 or below | SELL |

Conviction combines three things: the size of the score, how far the factors agree, and data coverage. It is capped at 90 and is reduced by 30% when a high-impact event falls inside the holding window. It is not a probability of success.

The intraday label switches to **WAIT** when a high-impact release, such as the EIA report or an OPEC+ meeting, is less than two hours away.

Stops use 1.5 times the 14-hour ATR for intraday trades and 1.2 times the daily ATR for swing trades. Targets sit at 1R and 2R.

## 4. Editing the model

All logic sits in `public/js/engine.js`.

- **Weights and thresholds:** edit `WEIGHTS` (Brent), `WEIGHTS_WTI` and `THRESHOLDS` at the top of the file.
- **One-off events:** edit `STATIC_EVENTS`. The OPEC+ meeting time is approximate and the FOMC date should be checked against the Federal Reserve calendar.
- **News rules:** edit `NEWS_RULES`. Each rule is a regular expression with a weight; positive weights are bullish.

The same file runs in the browser and in the analysis function, so the reasoning shown on the page is exactly the reasoning behind the suggestion.

## 5. Track record

A scheduled function (`track-logger`) runs every 15 minutes on the published site and stores its results in Netlify Blobs. No setup is needed. On each run it does three things:

1. **Logs signals.** It records the suggestion and every factor score for both Brent and WTI. It skips this step when the latest quote is more than two hours old, which means the market is closed.
2. **Runs simulated trades.** When the suggestion is BUY, LEAN BUY, SELL or LEAN SELL and no simulated trade is open for that benchmark and horizon, it opens one at the suggested entry, stop and first target.
   - The trade closes at +1R if the target is hit first, or at -1R if the stop is hit first. If both fall within the same hourly bar, the stop is assumed, which is the conservative choice.
   - Otherwise the trade closes at the market price after 24 hours (intraday) or 120 hours (swing).
   - Because only one trade is open at a time, a signal that persists for hours counts once.
3. **Measures factor reliability.** After 4 hours (intraday) or 48 hours (swing), it measures the price move that followed each logged reading. It then reports, per factor, how often a clearly bullish or bearish reading was followed by a move in that direction, together with the correlation between score and move.

Because each trade risks 1R to make 1R, the break-even win rate is 50% before spreads and commissions. Treat fewer than 30 closed trades as anecdotal.

Every closed trade can be downloaded as JSON from `/api/track/trades`.

Scheduled functions only run on the published production deploy, and the hourly price data limits how precisely intraday stop and target hits can be timed.

## 6. Limitations

- Yahoo Finance futures quotes are delayed by roughly ten minutes, and the endpoint is unofficial and occasionally rate-limits cloud servers. The data sources panel shows when a source has failed, and the engine continues with the remaining factors. Execute against your broker's live quote.
- Inventories update weekly (Wednesday) and positioning weekly (Friday, covering Tuesday's data). They set direction, not timing.
- Keyword scoring cannot read nuance, sarcasm or a headline that reports a denial. Read the top headlines before acting on any one of them; the optional Claude review exists partly to catch these misreads.
- CFTC positioning covers WTI. ICE publishes Brent positioning separately and it is not included.
- This is decision support built on a transparent rule set. It is not financial advice.

## 7. Local preview with mock data

```
node test/server.mjs     # then open http://localhost:8888
node test/run.mjs        # prints every factor, the reasoning and the trade plan to the console
node test/simulate-track.mjs   # replays the track-record logic over mock prices
```

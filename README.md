# Bitcoin Tracker

An internal BTC/USD monitor: enter a target and estimate whether Bitcoin will finish above or below it **at the end of a 15-minute window**. Start immediately or schedule by a local end time or start time. Scheduled starts can be up to 24 hours ahead. Built with Next.js App Router, React, React Bootstrap, SCSS, Redux Toolkit, and RTK Query. JavaScript/JSX throughout.

React Select handles scheduling dropdowns. Apache ECharts through `echarts-for-react` handles the interactive price chart. jStat supplies sample variance and the normal cumulative distribution used by the existing forecast model.

**The app is functional; predictive reliability is not established.** Its probability engine is a transparent volatility baseline, not a trained or independently validated trading model. A probability such as 80% is a model output, not a demonstrated 80% success rate.

## Run locally

Use Node.js 22 LTS or newer and pnpm 11.19.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [localhost:3000](http://localhost:3000). No environment variables, credentials, or paid API subscription are needed. The server must be able to reach `https://api.exchange.coinbase.com`.

```sh
pnpm test
pnpm run format:check
pnpm build
pnpm start
```

The corresponding `npm run` scripts also work with the installed dependencies. The committed `pnpm-lock.yaml` is the dependency source of truth. Optional native package installation scripts are explicitly disabled; their published platform binaries are used. The SCSS load path in `next.config.mjs` handles Bootstrap partial imports with Turbopack and Windows package links.

## What it does

- Retrieves live Coinbase BTC/USD trade snapshots every 5 seconds and one-minute candles every 60 seconds through serverless-compatible Next.js GET handlers. A minute-aligned three-hour historical window avoids the stale five-minute upstream cache used by the default candle URL.
- Observes fresh data for 3–5 minutes before issuing a fixed call, and shows a separate live estimate throughout. A weak or interrupted signal produces an explicit **No clear signal**, not a forced prediction. Live estimates remain neutral below 55% in both directions.
- Rejects malformed quotes, stale data, missing minutes, insufficient history, and volatility outside the model's operating range.
- Starts immediately or schedules by a local end time or start time. Choosing an end time sets the window start exactly 15 minutes earlier. An end 12 minutes away begins a `12:00` countdown and observation now. Future schedules begin observation with fresh data at their start, with up to 15 seconds of grace. A schedule can be canceled before it starts, and a missed start can be dismissed.
- Shows a prominent countdown to the fixed deadline. Before a future scheduled start, it stays at `15:00` with a separate **Starts in** countdown. Joining a window already in progress immediately shows the remaining time.
- Records the planned start, observation start and limits, target, capture time and price when a call is issued, probabilities, model/policy versions, and deadline. An issued prediction stays fixed through the countdown, result, and reload. The target input stays editable; edits only affect Live. **New forecast** after completion or a no-call uses the edited target in a new window.
- Keeps the live estimate separate from the original prediction. During a running forecast, it uses the editable preview target and remaining time to the fixed deadline. Different recorded and preview targets are explicitly labeled. It stops at that deadline; the original prediction remains visible with the result.
- Supports hover, touch, and keyboard inspection of chart points with exact recorded timestamps and USD prices. One-minute closes and the latest trade are identified separately; future model values are labeled as estimates.
- Keeps one scheduled start, observation, or pending forecast and up to 100 journal entries in this browser, including across reloads. Tracks sampled outcomes, directional accuracy, Brier score, no-call counts, and call coverage. No orders or transactions are performed.
- Provides explicit loading, retry, storage-failure, and unobserved-result states. There is no simulated or silently substituted market data.

## Model and timing contract

Only candles fully closed **before the upstream request began** enter the historical dataset. The latest 120 completed candles provide up to 119 consecutive log returns; at least 61 candles / 60 returns are required. A partial candle never becomes eligible just because the client clock crosses a minute boundary.

For close prices `C`, the one-minute return is `r = ln(C[t] / C[t-1])`. The sample standard deviation estimates one-minute volatility. Future log-return mean is assumed to be zero; observed sample drift is removed from the variance estimate but is **not** extrapolated. For a horizon of `minutesRemaining`, the standard deviation is `sigma = stdev(r) * sqrt(minutesRemaining)`. A fixed call uses the remaining time at publication: after three minutes of observation, an ordinary 15-minute window has 12 minutes remaining. The separate live estimate uses the remaining time to that same deadline, capped at 15 minutes for previews before a future window starts.

The fixed publication policy is `observed-consensus-v1`. It waits at least three minutes after observation begins, then requires the same direction at **65% or greater model probability** throughout a full minute of fresh exchange-trade observations. At least seven distinct, increasing trade timestamps are required; neither observed-time gaps nor exchange-time gaps may exceed 15 seconds. Repeated polls of the same trade are not new evidence. A weak/reversed signal or invalid/stale data restarts confirmation. The published probability is the current model output, not an average of correlated samples or a manufactured confidence boost.

Observation stops at the earlier of five minutes after it began and one minute before the original end. If the signal never qualifies, the journal records a no-call with no probabilities or correctness score. A joined window with less than four minutes left immediately declines a fixed call while Live remains available. Reload keeps all saved deadlines but requires a new minute of actually observed quotes; it never recreates unseen confirmation data. These are conservative engineering rules, not calibrated accuracy thresholds.

```text
P(above target) = 1 - normalCDF(ln(target / spot) / sigma)
P(below target) = 1 - P(above target)
80% model interval = spot * exp(±1.2815515655 * sigma)
```

Probability outputs are limited to 1–99%. This is an uncertainty convention, not a calibration result. The normal model assumes a continuous distribution; actual cent-denominated prices can tie. Ties are recorded explicitly and excluded from scoring.

Quote trade time and server receipt time must each be within 20 seconds of the client clock and no more than 5 seconds ahead. The latest completed candle's closing boundary must be within 120 seconds. History must be contiguous; one-minute volatility below 0.001% or above 5%, or an absolute one-minute log return above 20%, pauses the model. These are engineering guardrails, not validated market-regime thresholds.

**Schedule by** offers **Start now**, **End time**, and **Start time**. Dates and times use the browser's local timezone. **End time** derives `start = end −15 minutes`; for example, a 12:30 end belongs to the window starting at 12:15. The end must be strictly in the future and no more than 24 hours 15 minutes ahead. At 12:18, selecting 12:30 begins observation now and counts down from `12:00`; no price or forecast is fabricated for 12:15. The earliest fixed call is 12:21 and the decision cutoff is 12:23. An end more than 15 minutes away schedules its future start. **Start time** retains direct selection of a future start within 24 hours.

Once a future schedule is saved, the main countdown stays at `15:00` while **Starts in** shows the wait until the planned start. At that start, the main countdown begins decreasing toward the fixed deadline. The target and timing are fixed when saved; fixed probabilities remain unset until the observation rule qualifies. The separate live preview covers 15 minutes from now before the window begins. Observation may begin with `14:xx` remaining when start data arrives a few seconds late. Cancel before the selected start to change an existing schedule.

For a future schedule, the browser begins observation at the planned start using a fresh quote and valid history. Both the trade and its server receipt must be at or after that start, with up to 15 seconds of grace. `analysis.startedAt` records the actual observation start; once issued, `createdAt` records the fixed call's capture time separately from the window's `startsAt`. The deadline is never shifted. If fresh data is unavailable through the start grace window, or the tab wakes after it, the schedule becomes missed; it is not automatically recovered as a joined window. Joining an already-started window requires a new explicit submission. A missed schedule can be dismissed.

Forecast deadlines use wall-clock time, so timer throttling does not move the deadline. **The observed outcome is a sample, not an exact exchange settlement:** the first fresh quote seen by this tab whose exchange trade time is from the deadline through deadline +15 seconds is recorded. Allowing another 20 seconds for quote delivery gives a maximum wait of 35 seconds after expiry. An unavailable, suspended, or closed tab can miss that observation; the entry becomes `unobserved` and is never backfilled with a later price. Keep the tab open and the device clock accurate. Saving a schedule does not create a server-side timer or background observer.

The shaded future chart region is an expanding **Live model 80% range** with no directional path. It updates with the live estimate rather than representing the fixed original prediction. It covers the remaining forecast horizon: a 12-minute window ends at the chart's **End** label; a full 15-minute preview shows **+15m**. Expired or invalid horizons show no forward interval. **Live window volatility** scales to the same remaining horizon. Changing chart history (30m / 1h / 2h) does not change the model lookback.

## Accuracy and limitations

Directional accuracy excludes ties, neutral calls, and no-call decisions. Brier score is the mean squared error of issued above-target probabilities across resolved non-tie outcomes, including legacy neutral calls. Lower is better; a constant 50% forecast scores 0.25. Call coverage divides issued observation-policy calls by all completed observation decisions (issued plus withheld), excluding ongoing observation and older immediate forecasts. The UI reports sample counts and does not manufacture accuracy before there are outcomes.

See [the reproducible historical comparison](docs/forecast-evaluation.md) for a chronological development/holdout comparison of immediate, delayed, and alternative volatility models. Minute candles only approximate the publication policy; they cannot validate its five-second feed continuity rules. Waiting reduces the remaining prediction horizon, and selective calls trade coverage for conditional accuracy. The current normal model is retained because the evaluated replacement's benefit was too small to justify promoting it from a short sample.

Recent volatility does not establish a directional predictive edge. News, discontinuous jumps, changing volatility, fees/spreads, and other exchanges' prices are outside this baseline. This is Coinbase BTC/USD, not a composite index, USDT pair, or a prediction market's settlement oracle.

The journal is device-local, editable, limited to 100 entries, and not synchronized between tabs or devices. Its small, user-selected sample cannot validate the model. Production accuracy claims require a separate immutable observation dataset, walk-forward evaluation without lookahead, comparison against naive baselines, probability calibration, and evaluation across market regimes.

Persistence uses a version 3 envelope at the existing `bitcoin-tracker:journal:v1` storage key. Valid version 1 and 2 histories retain their original forecasts and scheduled starts. Version 3 adds strict observation-policy metadata and no-call records. Invalid records are rejected with a storage warning.

## Project ownership

```text
src/app/                         App Router layout, thin page, error boundary
src/app/api/market/ticker/        Serverless GET ticker handler
src/app/api/market/candles/       Serverless GET candles handler
src/features/BitcoinTracker/     Tracker UI, narrow hooks, model, journal, tests
src/features/BitcoinTracker/state/slices/     Feature client state
src/features/BitcoinTracker/state/selectors/ Derived journal data
src/services/coinbase/           RTK Query API + upstream services/validation
src/state/                      Per-provider store factory and Redux provider
src/theme.scss                  Bootstrap theme variables and global utilities
```

App Router replaces the Fusion `src/pages/` route convention for this project. Product code remains feature-owned. Redux owns shared client state; RTK Query owns market-data requests. No new React Context is introduced. React 19 is used with the current Next.js App Router; React Bootstrap remains on its stable 2.x release.

## Hosting

Deploy as a **Next.js application with serverless route support**, for example to Vercel; do not use a static export. The two GET handlers require no secret keys and use fixed upstream URLs, `no-store`, validation, and an 8-second timeout. The browser timeout is 10 seconds. Build output lists both `/api/market/*` handlers as dynamic routes. Nothing has been deployed by this setup.

Serverless requests do not create a persistent background observer. An always-on production journal would need durable storage and a scheduled/streaming ingestion service. For public multi-user operation, add deployment-level rate limits and a shared, freshness-bounded market-data cache: the starter intentionally makes uncached upstream requests per polling browser. Coinbase errors/rate limits pause the estimate; there is no cross-exchange fallback that changes the price definition.

References: [Next.js route handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route), [Coinbase ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker), [Coinbase candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles).

# BitcoinTracker

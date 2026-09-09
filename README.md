# Bitcoin Tracker

An internal BTC/USD monitor: enter a target and estimate whether Bitcoin will finish above or below it **at the end of a 15-minute window**. Start immediately or schedule by a local end time or start time. Scheduled starts can be up to 24 hours ahead. Built with Next.js App Router, React, React Bootstrap, SCSS, Redux Toolkit, and RTK Query. JavaScript/JSX throughout.

React Select handles scheduling dropdowns. Apache ECharts through `echarts-for-react` handles the interactive price chart. jStat supplies sample variance and the normal cumulative distribution used by the existing forecast model.

**The app is functional; predictive reliability is not established.** New forecasts use an experimental trade-pressure adjustment around a volatility baseline. Its parameters describe recent observed trades; they are not calibrated against future 15-minute outcomes. A probability such as 80% is a model output, not a demonstrated 80% success rate.

## Run locally

Use Node.js 22 LTS or newer and pnpm 11.19.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [localhost:3000](http://localhost:3000). No environment variables, credentials, or paid API subscription are needed. The server must reach `https://api.exchange.coinbase.com`; the browser must also reach `wss://ws-feed.exchange.coinbase.com` for live trades, liquidity, and verified deadline outcomes.

```sh
pnpm test
pnpm run format:check
pnpm build
pnpm start
```

The corresponding `npm run` scripts also work with the installed dependencies. The committed `pnpm-lock.yaml` is the dependency source of truth. Optional native package installation scripts are explicitly disabled; their published platform binaries are used. The SCSS load path in `next.config.mjs` handles Bootstrap partial imports with Turbopack and Windows package links.

## What it does

- Streams Coinbase BTC/USD ticker, executed trades, heartbeats, and batched level-2 order-book updates directly to the browser. Trade continuity, freshness, and reconnection state are visible. REST ticker polling every 5 seconds can supply a healthy baseline estimate when pressure data is unavailable; REST cannot verify deadline settlement. One-minute candles refresh every 60 seconds through serverless-compatible Next.js GET handlers. A minute-aligned three-hour historical window avoids the stale five-minute upstream cache used by the default candle URL.
- Observes for three minutes, then fixes the first valid estimate, including a slight 51/49 lean or a balanced 50/50 estimate. No 65% threshold or extra minute of agreement applies to new forecasts. Weak direction is labeled explicitly; insufficient time or unavailable essential price/history data can still produce a no-call. A separate live estimate continues updating.
- Rejects malformed quotes, stale data, missing minutes, insufficient history, and volatility outside the model's operating range.
- Shows recent momentum, acceleration, relative volume, volatility/range changes, executed buy/sell flow over 15/60/180 seconds, large-trade activity, spread, and near-price depth. Available trade pressure changes the model's expected log return; responsive volatility and spread affect uncertainty. Opposing flow, ordinary volatility expansion, price jumps within essential model limits, and missing order-book data do not independently veto new fixed estimates. Older saved policies retain their original risk filters.
- Starts immediately or schedules by a local end time or start time. Choosing an end time sets the window start exactly 15 minutes earlier. An end 12 minutes away begins a `12:00` countdown and observation now. Future schedules begin observation with fresh data at their start, with up to 15 seconds of grace. A schedule can be canceled before it starts, and a missed start can be dismissed.
- Shows a prominent countdown to the fixed deadline. Before a future scheduled start, it stays at `15:00` with a separate **Starts in** countdown. Joining a window already in progress immediately shows the remaining time.
- Records the planned start, observation start and limits, target, capture time and price when a call is issued, probabilities, model/policy versions, and deadline. An issued prediction stays fixed through the countdown, result, and reload. The target input stays editable; edits only affect Live. **New forecast** after completion or a no-call uses the edited target in a new window.
- Keeps the live estimate separate from the original prediction. During a running forecast, it uses the editable preview target and remaining time to the fixed deadline. Different recorded and preview targets are explicitly labeled. It stops at that deadline; the original prediction remains visible with the result.
- Supports hover, touch, and keyboard inspection of chart points with exact recorded timestamps and USD prices. One-minute closes and the latest trade are identified separately; future model values are labeled as estimates.
- Keeps one scheduled start, observation, or pending forecast and up to 100 journal entries in this browser, including across reloads. Tracks verified deadline outcomes separately from legacy sampled outcomes, directional accuracy, Brier score, no-call counts, and call coverage. No orders or transactions are performed.
- Records prospective observations, decisions, and outcomes in a separate bounded IndexedDB store. **Research data → Export research JSONL** downloads them for chronological analysis, including withheld-window outcomes when observable. Recording stops with a warning at 25,000 rows instead of silently evicting old evidence; this is a local research record, not an immutable central audit.
- Provides explicit loading, retry, storage-failure, and unobserved-result states. There is no simulated or silently substituted market data.

## Model and timing contract

Only candles fully closed **before the upstream request began** enter the historical dataset. The latest 120 completed candles provide up to 119 consecutive log returns; at least 61 candles / 60 returns are required. A partial candle never becomes eligible just because the client clock crosses a minute boundary.

For close prices `C`, the one-minute return is `r = ln(C[t] / C[t-1])`. The retained `zero-drift-log-return-v1` baseline uses sample standard deviation and assumes zero future log-return mean: observed sample drift is removed from variance but is not extrapolated. For a horizon of `minutesRemaining`, its standard deviation is `sigma = stdev(r) * sqrt(minutesRemaining)`. A fixed estimate uses the remaining time at publication: after three minutes of observation, an ordinary 15-minute window has 12 minutes remaining. The separate live estimate uses the remaining time to that same deadline, capped at 15 minutes for previews before a future window starts.

New forecasts use model `trade-pressure-log-return-v1` and publication policy `pressure-snapshot-v3`. The model relates completed 15-second trade buckets' net aggressive BTC flow to their contemporaneous log-price changes. A shrunken, bounded impact estimate and available recent 15/60/180-second flow rates produce a decaying expected-return adjustment. This adjusts Above/Below probabilities; it is not another publication veto. Recent movement and the spread affect uncertainty, including when pressure is unavailable. Missing, stale, insufficient, or unusable flow disables the directional pressure adjustment while valid price/history data still supports a labeled price-only estimate with responsive uncertainty. That fallback need not match the older zero-drift model's probabilities exactly. The contemporaneous fit is not a measured ability to predict future returns.

The new policy waits at least three minutes after observation begins and then publishes the first valid estimate available before the fixed cutoff. A probability above 50% favors Above, below 50% favors Below, and exactly 50% is balanced. **Slight lean** identifies a winning side below 55%; it is still published without inflating its probability. There is no minimum 65% confidence requirement, no 60-second same-direction rule, and no order-book/flow-risk veto for new observations. Essential quote/history validity and model-version compatibility remain required.

Saved `observed-consensus-v1` and `market-aware-consensus-v2` windows keep their original zero-drift model and publication rules, including 65% throughout a fresh minute with at least seven distinct observations and no gap above 15 seconds. The v2 policy also retains complete-flow/book requirements and market-risk vetoes. Executed flow uses the aggressor side, reversing Coinbase's resting-maker `side`; displayed depth remains separate from executed volume. Large trades, bursts, and displayed orders are context, not evidence of a particular trader's identity or intent.

Observation stops at the earlier of five minutes after it began and one minute before the original end. If essential data never supports a valid estimate, the journal records a no-call with no probabilities or correctness score. A joined window with less than four minutes left immediately declines a fixed estimate while Live remains available. Reload keeps saved start/cutoff/deadline values; new-policy observations may publish a fresh valid estimate after their original three-minute point, while legacy consensus policies must rebuild their confirmation evidence. No unseen trade buckets or confirmation samples are recreated.

```text
P(above target) = 1 - normalCDF((ln(target / spot) - locationLogReturn) / sigma)
P(below target) = 1 - P(above target)
80% model interval = spot * exp(locationLogReturn ±1.2815515655 * sigma)
Pressure model location = pressure adjustment + midpoint component
Legacy zero-drift baseline: locationLogReturn = 0
```

Probability outputs are limited to 1–99%. This is an uncertainty convention, not a calibration result. The normal model assumes a continuous distribution; actual cent-denominated prices can tie. Ties are recorded explicitly and excluded from scoring.

Quote trade time and server receipt time must each be within 20 seconds of the client clock and no more than 5 seconds ahead. The latest completed candle's closing boundary must be within 120 seconds. History must be contiguous; one-minute volatility below 0.001% or above 5%, or an absolute one-minute log return above 20%, pauses the model. These are engineering guardrails, not validated market-regime thresholds.

**Schedule by** offers **Start now**, **End time**, and **Start time**. Dates and times use the browser's local timezone. **End time** derives `start = end −15 minutes`; for example, a 12:30 end belongs to the window starting at 12:15. The end must be strictly in the future and no more than 24 hours 15 minutes ahead. At 12:18, selecting 12:30 begins observation now and counts down from `12:00`; no price or forecast is fabricated for 12:15. The earliest fixed call is 12:21 and the decision cutoff is 12:23. An end more than 15 minutes away schedules its future start. **Start time** retains direct selection of a future start within 24 hours.

Once a future schedule is saved, the main countdown stays at `15:00` while **Starts in** shows the wait until the planned start. At that start, the main countdown begins decreasing toward the fixed deadline. The target and timing are fixed when saved; fixed probabilities remain unset until the observation rule qualifies. The separate live preview covers 15 minutes from now before the window begins. Observation may begin with `14:xx` remaining when start data arrives a few seconds late. Cancel before the selected start to change an existing schedule.

For a future schedule, the browser begins observation at the planned start using a fresh quote and valid history. Both the trade and its server receipt must be at or after that start, with up to 15 seconds of grace. `analysis.startedAt` records the actual observation start; once issued, `createdAt` records the fixed call's capture time separately from the window's `startsAt`. The deadline is never shifted. If fresh data is unavailable through the start grace window, or the tab wakes after it, the schedule becomes missed; it is not automatically recovered as a joined window. Joining an already-started window requires a new explicit submission. A missed schedule can be dismissed.

Forecast deadlines use wall-clock time, so timer throttling does not move the deadline. New entries use `coinbase-last-trade-at-deadline-v1`: the last completely observed Coinbase match **at or before the deadline**, no more than five seconds old. A continuous stream must include that trade and a heartbeat must confirm receipt of matches strictly past the deadline. The record retains the trade ID, exchange timestamp, continuity start, and confirmed-through time. Missing continuity, an old last trade, or a reconnect after the deadline produces `unobserved`; the application never substitutes a later REST quote. It allows up to 15 seconds after the deadline for stream confirmation. This is the app's explicit Coinbase outcome definition, not another venue's settlement oracle.

Legacy entries keep their earlier rule: the first fresh quote whose trade time is from the deadline through deadline +15 seconds, with up to 20 further seconds for delivery. Legacy sampled outcomes are labeled and scored separately from verified deadline outcomes. Keep the tab open and the device clock accurate. Saving a schedule does not create a server-side timer or background observer; suspension or closing the tab can leave an outcome unobserved.

The shaded future chart region shows the **Live model 80% range**, including the current model's location shift when available. It updates with the live estimate rather than representing the fixed original prediction or a promised price path. It covers the remaining forecast horizon: a 12-minute window ends at the chart's **End** label; a full 15-minute preview shows **+15m**. Expired or invalid horizons show no forward interval. **Live window volatility** scales to the same remaining horizon. Changing chart history (30m / 1h / 2h) does not change the model lookback.

## Accuracy and limitations

Directional accuracy excludes ties, balanced estimates, and no-call decisions. Brier score is the mean squared error of issued above-target probabilities across resolved non-tie outcomes, including balanced 50/50 estimates. Lower is better; a constant 50% forecast scores 0.25. Call coverage divides issued observation-policy estimates by all completed observation decisions (issued plus withheld), excluding ongoing observation and older immediate forecasts. The UI reports sample counts and does not manufacture accuracy before there are outcomes.

See [the reproducible historical comparison](docs/forecast-evaluation.md) for the 30-day chronological training/calibration/test experiment, feature ablations, same-capture current-side benchmark, probability calibration, interval coverage, and wait/threshold comparisons. The full candle-feature logistic candidate performed slightly worse than the existing normal baseline; high conditional accuracy largely matched simply checking the current side of the target at the same capture time. All test dates were already inspected in the earlier study, so this is retrospective evidence, not an independent validation. No candle-study candidate or fitted calibrator is promoted to production. That study did **not** test the new trade-pressure model or snapshot policy; neither has demonstrated improved predictive accuracy.

Minute candles cannot reproduce complete trade streams, exact deadline ticks, order-book changes, or the five-second observation rule. Waiting adds observed information and reduces the remaining prediction horizon. Publishing weaker estimates increases coverage without establishing a better success rate. The prospective JSONL export preserves capture inputs and model/policy/outcome versions for later evaluation of pressure adjustments and publication choices against same-time baseline predictions. Withheld decisions contribute to coverage and their separately observed outcomes allow future policy comparisons; they never acquire a fabricated call or probability.

Recent volatility does not establish a directional predictive edge. The current implementation has no event/news calendar, cross-venue price confirmation, derivatives funding/open-interest, or liquidation feeds. Those remain future candidates requiring explicit source/latency contracts and prospective ablation, not current features. Discontinuous jumps, changing volatility, and trading costs remain limitations. This is Coinbase BTC/USD, not a composite index, USDT pair, or a prediction market's settlement oracle.

The journal is device-local, editable, limited to 100 entries, and not synchronized between tabs or devices. Its small, user-selected sample cannot validate the model. Production accuracy claims require a separate immutable observation dataset, walk-forward evaluation without lookahead, comparison against naive baselines, probability calibration, and evaluation across market regimes.

Persistence uses a version 5 envelope at the existing `bitcoin-tracker:journal:v1` storage key. Valid version 1–4 histories retain their original forecasts, schedules, model/policy versions, and outcome semantics. New pressure snapshots retain their new model/policy identifiers, `calculationMode` (`pressure-adjusted` or `baseline-fallback` once issued), and the same strict deadline-outcome metadata. Invalid records are rejected with a storage warning. The separate `bitcoin-tracker-evidence` IndexedDB database stores schema-version-1 research events; each records capture/input timestamps explicitly, and restored decisions do not pretend current features were observed at their original capture time.

## Project ownership

```text
src/app/                         App Router layout, thin page, error boundary
src/app/api/market/ticker/        Serverless GET ticker handler
src/app/api/market/candles/       Serverless GET candles handler
src/features/BitcoinTracker/     Tracker UI, narrow hooks, model, journal, tests
src/features/BitcoinTracker/state/slices/     Feature client state
src/features/BitcoinTracker/state/selectors/ Derived journal data
src/services/coinbase/           RTK Query API + upstream services/validation
src/services/coinbase/stream/    Browser stream, trade continuity, order book
scripts/forecast-evaluation/    Offline research data/features/statistics
src/state/                      Per-provider store factory and Redux provider
src/theme.scss                  Bootstrap theme variables and global utilities
```

App Router replaces the Fusion `src/pages/` route convention for this project. Product code remains feature-owned. Redux owns shared client state; RTK Query owns market-data requests. No new React Context is introduced. React 19 is used with the current Next.js App Router; React Bootstrap remains on its stable 2.x release.

## Hosting

Deploy as a **Next.js application with serverless route support**, for example to Vercel; do not use a static export. The two GET handlers require no secret keys and use fixed upstream URLs, `no-store`, validation, and an 8-second timeout. The browser timeout is 10 seconds. Build output lists both `/api/market/*` handlers as dynamic routes. Nothing has been deployed by this setup.

The browser owns its WebSocket connection; the Next.js handlers do not maintain one. Serverless requests do not create a persistent background observer. An always-on production journal would need durable storage and a scheduled/streaming ingestion service. For public multi-user operation, add deployment-level rate limits and a shared, freshness-bounded market-data cache: the starter intentionally makes uncached upstream requests per polling browser. Coinbase errors/rate limits pause the estimate; there is no cross-exchange fallback that changes the price definition.

References: [Next.js route handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route), [Coinbase ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker), [Coinbase candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles).

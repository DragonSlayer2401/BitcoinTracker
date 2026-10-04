# Reading the Bitcoin tracker code

This repository is a Next.js App Router application using JavaScript and JSX. React Bootstrap supplies UI primitives, Redux owns the saved forecast state, and RTK Query owns cached server responses. Start with the user workflow, then follow the data into the calculation and storage layers.

The primary dashboard now serves a position-aware paper trading adviser. Its action, simulated
$100 account and positions lead the screen; prediction controls and diagnostics remain available
through the research dialog. Prediction collection and model validation still run independently.
Start adviser work at `features/TradingAdvisor/` and `services/research/tradingAdvisor/`; see
[trading adviser](trading-advisor.md) for decision math, ownership, execution and evidence.

## Start here

Read these files in order:

1. [`src/app/page.jsx`](../src/app/page.jsx) mounts the tracker. [`src/app/layout.jsx`](../src/app/layout.jsx) supplies the application shell and Redux provider.
2. [`BitcoinTracker/index.web.jsx`](../src/features/BitcoinTracker/index.web.jsx) connects market inputs, selected contracts, forecast lifecycles, and the dashboard. Its comments mark the main stages of that flow.
3. [`utils/benchmarkChart.utils.js`](../src/features/BitcoinTracker/utils/benchmarkChart.utils.js) derives the headline reference index from the existing BRTI response. [`components/CoinbaseChart.jsx`](../src/features/BitcoinTracker/components/CoinbaseChart.jsx) adapts existing market inputs for the Coinbase price chart. [`hooks/useCoinbaseMarketData.js`](../src/features/BitcoinTracker/hooks/useCoinbaseMarketData.js) chooses streamed or REST spot inputs for the calculation and market details.
4. [`hooks/useLiveKalshiForecast.js`](../src/features/BitcoinTracker/hooks/useLiveKalshiForecast.js) recalculates the displayed estimate and explains why it may be unavailable. It does not update the saved prediction.
5. [`hooks/useFixedPrediction.js`](../src/features/BitcoinTracker/hooks/useFixedPrediction.js) observes inputs for the saved contract, then publishes or withholds its fixed call.
6. [`state/slices/trackerSlice.js`](../src/features/BitcoinTracker/state/slices/trackerSlice.js) validates each state transition. [`state/selectors/trackerSelectors.js`](../src/features/BitcoinTracker/state/selectors/trackerSelectors.js) derives the active call and journal summaries.

Paths below the entry point are relative to `src/features/BitcoinTracker/` unless another owner is named.

## Follow one forecast

The user selects a real Kalshi contract. That contract supplies the target, opening time, closing time, and settlement rules. A future selection can be scheduled by identity while its target is still pending.

Manual recording and `hooks/useKalshiSchedule.js` both use `utils/kalshi/forecastRecord.utils.js` to create the same initial record. It starts in `analyzing` with no fixed probabilities. The record retains the official closing time even when the user joins late.

`utils/kalshi/forecastBatch.utils.js` creates one immutable record per selected checkpoint. The
`kalshi-checkpoint-v5` policy fixes capture at closing time minus 12, 9, 6, 3, or 1 minute, with
five seconds of grace. Actual observation start and capture timestamps remain distinct; late
reopening never moves the checkpoint. The journal accepts multiple active records only for
distinct checkpoints on the same verified contract. The active selector processes the earliest
remaining analysis first, while published calls stay visible and settle independently.

`hooks/useForecastPreferences.js` persists the nonempty checkpoint selection and opt-in Auto
switch. `hooks/useAutomaticKalshiForecast.js` starts real open contracts through the same batch
workflow, with a durable event watermark that prevents repeats after reloads or history clearing.
Selections are copied when an event is armed; later preference changes affect the next event.
Automatic and manual capture origins are saved explicitly and remain distinct from background
research. No extra market polling or trading endpoint is added.

`hooks/useForecastJournal.js` holds a Web Lock for the recording tab's lifetime, restores under
that lock, and synchronously persists each Redux journal change. Other tabs synchronize through
storage events without recording or uploading competing calls. Closing the writer transfers
ownership to a waiting tab. Storage failures pause recording; old saved predictions never get
recomputed. Journal retention preserves unfinished settlements before trimming completed calls.

`useFixedPrediction` gathers observations under the policy in `utils/fixedPrediction.utils.js`. A usable estimate becomes a `pending` fixed prediction. If essential inputs remain unavailable through the observation cutoff, the record becomes `withheld`.

After the contract closes, a pending call becomes `awaiting-settlement`. `hooks/useKalshiSettlement.js` retrieves the official finalized result, and the reducer changes a verified call to `resolved`. A later spot price cannot resolve a Kalshi forecast.

Live estimates and live reversal risk may keep changing while the saved prediction stays fixed. Risk for a saved call must always use that call's target and deadline, even if the market selector advances to another event.

## Keep the data sources distinct

| Input                                   | Owner                                         | Purpose                                                  |
| --------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| Contract details and official results   | `src/services/kalshi/`                        | Define the event and verify settlement                   |
| BRTI benchmark readings                 | `src/services/kalshi/`                        | Chart the index and model its final-minute average       |
| Coinbase ticker and candles             | `src/services/coinbase/`                      | Provide optional market context and proxy inputs         |
| Coinbase trades and order book          | `src/services/coinbase/stream/`               | Measure optional trade pressure and liquidity            |
| Bybit perpetual trades and liquidations | `src/services/derivatives/`                   | Measure optional futures pressure and liquidation stress |
| Saved calls and schedules               | Feature `state/` and `utils/journal.utils.js` | Preserve the user's forecast lifecycle across reloads    |
| Research evidence and models            | `src/services/research/`                      | Store observations and evaluate candidate models         |

The server route files in `src/app/api/` are HTTP boundaries. Service `.api.js` files define RTK Query endpoints; server and client service modules own their respective transport operations. Keep credentials and database access in server-only modules.

Research comparisons start at `utils/researchForecast.utils.js` and the optional variant output in
`utils/kalshi/forecast.utils.js`. `utils/researchExperiments.utils.js` captures and replays complete
calculation inputs. `utils/researchEvaluation.utils.js` compares prospective results, independently
of learning activation. `scripts/collect-research.analysis.js` connects those reports and
`utils/researchForwardLabels.utils.js` to the durable archive. The original input and later label
have separate tables; labels never become inputs to an earlier snapshot. See
[collector experiments](research-collector.md#paired-experiments-and-replay) for commands and limits.

`utils/researchVariantConfig.utils.js` freezes the experiment generations and pressure policies.
`utils/marketBlendForecast.utils.js` consumes the already-fetched Kalshi quote. The challenger
model and training modules in `utils/learning/` own bounded prediction, chronological fitting,
prospective scoring and monitoring. `services/research/challenger.service.js` coordinates those
six candidate families under the existing learning lease and model store. Read endpoints never
fit or promote candidates. The collector snapshots compact frozen artifacts, not analysis reports.

Research V5 adds the direct directional reversal candidate to V4's corrected BRTI history and
proxy-timing calculations. It preserves the same baseline and feature pipeline so compatible V4
observations can supply training, while only new V5 captures contain the new candidate's predictions.
V1–V4 keep their original variant sets and replay behavior. V1–V3 replay their
original math. `benchmarkConditions.utils.js` retains real minute closes when at most one interior
second is missing, reports observed-only coverage, and never fills settlement readings. The CLI's
`scripts/collect-research.background.js` and worker entry point isolate archive analysis and model
fitting from the live-feed thread. Fixed records retain the calculation generation chosen when
observation began, including through reload and later evidence collection.

For newly fitted reversal challengers, the explicit `reversalFeatureVersion` selects changing
15/60-second pressure and signed spot/futures agreement inputs, with separate availability flags.
Previously saved V1/V2 artifacts without this marker retain their original six-input calculation.

`directionalReversal.utils.js` owns the separate final-outcome flip target and oriented features.
Unlike the older bounded reversal adjustment, this family predicts flip probability directly.
Its own policy and checkpoint calibration identify those semantics. Primary-only chronological
folds select regularization; a later calibration partition and two future validation cohorts are
kept separate. Promotion additionally requires a positive paired accuracy advantage over the
current-side benchmark. Saved calls and existing artifacts retain their original math.

For current V2 challengers, `challengerCheckpoint.utils.js` owns checkpoint calibration and
reliability bins; `challengerValidation.utils.js` owns separate development and confirmation
cohorts. `challengerTrial.repository.js` persists nomination, append-only contract membership,
global attempt numbers and immutable final results. Activation checks that saved confirmation
and the current incumbent in one database transaction. `researchForecast.utils.js` applies only
approved countdown bands and stores a separate `activePrediction` in V3 snapshots, allowing a
same-family replacement to be evaluated without overwriting its incumbent's recorded estimate.

`challengerDevelopment.repository.js` owns collector readiness proofs, the immutable future
development boundary and append-only development membership. Current collector code and an actually
persisted matching prediction must be verified before a new candidate starts its test. Missing
recording evidence is distinguished from poor predictive performance; neither can promote a model.

`services/research/collectorHealth.service.js` summarizes bounded recent archive rows and durable
heartbeats. Its independent read endpoint powers modal-only polling without fitting or promotion.
Health reporting failures do not block forecasts or the research analysis cycle.

`services/kalshi/purchaseValue/` owns bounded order-book and verified fee reads through the shared
limiter. `utils/kalshi/purchaseValue.utils.js` calculates depth-aware purchase estimates;
`components/KalshiPurchaseValue.jsx` exposes them inside Forecast risk. It has no order-writing API.

`features/PaperTrading/` owns the separate experimental paper-entry policy, delayed book simulation,
accounting and report popup. `services/research/paperTrading/` stores immutable decisions and
lifecycle events without changing forecast evidence. The collector's explicit `--paper-trading`
flag supplies production forecasts and current inputs; `--paper-report` and the private report
endpoint only read saved results. See [paper trading](paper-trading.md) for costs, risk limits,
capture/fill timing and the distinction between simulated profitability and live execution.

## Read the Coinbase chart

`components/CoinbaseChart.jsx` adapts the Coinbase candles and latest ticker already fetched by
`useCoinbaseMarketData` into the native `PriceChart`. It makes no additional market requests.
The chart-only Kalshi history subscription is disabled for this source. Available history is
limited to the existing three-hour Coinbase candle response; range and zoom controls only work
with those loaded observations.

The main desktop chart spans the account and guidance rows, with compact event and index strips.
The native chart owns separate price, MACD and RSI panes, drawing management, fixed hover readouts,
zoom/pan and an expanded in-app view. Its amber Kalshi target line and price label update from the
current event even while research displays an older saved forecast. The latest Coinbase price has
its own marker. The Kalshi reference index above the chart remains the actual BRTI feed.

`utils/coinbaseChart.utils.js` supplies real completed Coinbase OHLC candles, minute-close line
observations and the independent ticker marker. A current trade does not manufacture an entire
minute candle. `utils/chartIndicators.utils.js` validates and aggregates each source according to
its actual data: Coinbase bars count completed minute candles, while the legacy BRTI path counts
observed seconds. Gaps and incomplete history remain explicit and reset indicator initialization.

Coinbase chart prices cannot establish Kalshi settlement. The numeric Kalshi strike is a visual
reference on the spot chart; the model continues to use BRTI and the official final-minute average.
Coinbase mode does not draw a BRTI settlement average or prediction range over spot prices. No
forecast input, collector policy, settlement rule or API limiter was changed by the chart work.

Coinbase drawings use `bitcoin-tracker:chart-drawings:coinbase-btc-usd:v1`. Existing drawings under
`bitcoin-tracker:chart-drawings:cf-brti:v1` are retained separately, never silently moved to another
instrument. The hosted TradingView iframe is no longer used because it cannot accept this app's
automatically updated target overlay.

## Read the calculation in layers

`utils/researchForecast.utils.js` coordinates the calculation. It obtains the pressure baseline, applies the Kalshi settlement model, builds learning features, and applies a compatible active model. A candidate can also produce a separate prospective prediction for evaluation.

`utils/kalshi/forecast.utils.js` models the settlement average. `utils/kalshi/marketConditions.utils.js` keeps benchmark price behavior distinct from Coinbase volume and liquidity. A complete BRTI reference and history can support estimates through a Coinbase outage.

`hooks/useDerivativesMarketData.js` owns the browser's public futures connection; the collector owns its own instance of the same service. `utils/derivativesForecast.utils.js` fits and bounds a futures adjustment that the settlement model applies only to future readings. `components/DerivativesDiagnostics.jsx` shows the recorded inputs and probability difference. See [derivatives.md](derivatives.md) for source semantics and versioning.

The `utils/learning/` folder separates feature extraction, numerical helpers, model application, evidence evaluation, and training. Read the exported training flow before its private fitting helpers. Training, calibration, testing, and prospective evaluation have different time windows; overlapping observations from one event must not become independent samples.

Model and policy versions describe captured assumptions. Preserve earlier supported versions when reading saved records; changing a live model must not silently recalculate an old call.

## Follow the storage order

`hooks/useForecastJournal.js` finishes browser cleanup and restores the journal before recording and synchronization become ready. The public journal utility exposes validation plus local-storage loading and saving; its `utils/journal/` helpers own the persisted record rules.

`hooks/useForecastEvidence.js` records manual-call evidence. `hooks/useBackgroundResearch.js` records independent research checkpoints under a browser lock. Background recording follows this order:

1. Load the saved recorder state.
2. Replay any evidence that was saved but not yet inserted.
3. Advance the recorder using current inputs and available official outcomes.
4. Save the new state together with its exact pending evidence.
5. Insert that evidence, then clear the pending rows.

This order permits safe retries without inventing or replacing earlier observations. `utils/backgroundResearchStorage.utils.js` owns the browser persistence steps. The separate collector in `scripts/` uses the same research workflow when running outside the browser.

On the server, `research.schema.js` owns database readiness and migration initialization, `research.validation.js` owns incoming record checks, and `research.repository.js` owns transactions and queries. `learning.service.js` coordinates analysis and candidate promotion under a lease. Keep validation before insertion and commit only after the complete batch succeeds.

## Make the next change

Keep rendering in the nearest feature component, React lifecycles in a narrowly named hook, and pure calculations in utilities. The dashboard header and price summary are small rendering components. The research modal composes reports from `components/ResearchData/`; its parent owns loading and user actions.

Before editing, find the owner above and read its existing tests in `src/features/BitcoinTracker/__tests__/`. For verification commands and the important user flows, follow [TESTING.md](TESTING.md). Passing tests verifies software behavior; it does not establish predictive accuracy.

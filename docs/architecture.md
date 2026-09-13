# Reading the Bitcoin tracker code

This repository is a Next.js App Router application using JavaScript and JSX. React Bootstrap supplies UI primitives, Redux owns the saved forecast state, and RTK Query owns cached server responses. Start with the user workflow, then follow the data into the calculation and storage layers.

## Start here

Read these files in order:

1. [`src/app/page.jsx`](../src/app/page.jsx) mounts the tracker. [`src/app/layout.jsx`](../src/app/layout.jsx) supplies the application shell and Redux provider.
2. [`BitcoinTracker/index.web.jsx`](../src/features/BitcoinTracker/index.web.jsx) connects market inputs, selected contracts, forecast lifecycles, and the dashboard. Its comments mark the main stages of that flow.
3. [`hooks/useCoinbaseMarketData.js`](../src/features/BitcoinTracker/hooks/useCoinbaseMarketData.js) chooses a recent streamed quote or REST fallback, checks freshness, and derives the displayed price change from completed candles.
4. [`hooks/useLiveKalshiForecast.js`](../src/features/BitcoinTracker/hooks/useLiveKalshiForecast.js) recalculates the displayed estimate and explains why it may be unavailable. It does not update the saved prediction.
5. [`hooks/useFixedPrediction.js`](../src/features/BitcoinTracker/hooks/useFixedPrediction.js) observes inputs for the saved contract, then publishes or withholds its fixed call.
6. [`state/slices/trackerSlice.js`](../src/features/BitcoinTracker/state/slices/trackerSlice.js) validates each state transition. [`state/selectors/trackerSelectors.js`](../src/features/BitcoinTracker/state/selectors/trackerSelectors.js) derives the active call and journal summaries.

Paths below the entry point are relative to `src/features/BitcoinTracker/` unless another owner is named.

## Follow one forecast

The user selects a real Kalshi contract. That contract supplies the target, opening time, closing time, and settlement rules. A future selection can be scheduled by identity while its target is still pending.

Manual recording and `hooks/useKalshiSchedule.js` both use `utils/kalshi/forecastRecord.utils.js` to create the same initial record. It starts in `analyzing` with no fixed probabilities. The record retains the official closing time even when the user joins late.

`useFixedPrediction` gathers observations under the policy in `utils/fixedPrediction.utils.js`. A usable estimate becomes a `pending` fixed prediction. If essential inputs remain unavailable through the observation cutoff, the record becomes `withheld`.

After the contract closes, a pending call becomes `awaiting-settlement`. `hooks/useKalshiSettlement.js` retrieves the official finalized result, and the reducer changes a verified call to `resolved`. A later spot price cannot resolve a Kalshi forecast.

Live estimates and live reversal risk may keep changing while the saved prediction stays fixed. Risk for a saved call must always use that call's target and deadline, even if the market selector advances to another event.

## Keep the data sources distinct

| Input                                   | Owner                                         | Purpose                                                  |
| --------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| Contract details and official results   | `src/services/kalshi/`                        | Define the event and verify settlement                   |
| BRTI benchmark readings                 | `src/services/kalshi/`                        | Model the final-minute index average                     |
| Coinbase ticker and candles             | `src/services/coinbase/`                      | Show spot prices and provide proxy inputs                |
| Coinbase trades and order book          | `src/services/coinbase/stream/`               | Measure optional trade pressure and liquidity            |
| Bybit perpetual trades and liquidations | `src/services/derivatives/`                   | Measure optional futures pressure and liquidation stress |
| Saved calls and schedules               | Feature `state/` and `utils/journal.utils.js` | Preserve the user's forecast lifecycle across reloads    |
| Research evidence and models            | `src/services/research/`                      | Store observations and evaluate candidate models         |

The server route files in `src/app/api/` are HTTP boundaries. Service `.api.js` files define RTK Query endpoints; server and client service modules own their respective transport operations. Keep credentials and database access in server-only modules.

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

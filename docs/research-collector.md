# Continuous Kalshi research collector

The optional Node process records real KXBTC15M contracts while the browser is closed. It uses Coinbase trades, liquidity and candles, plus Bybit BTCUSDT perpetual executions and reported liquidations as inputs, and official Kalshi results as outcomes. Public inputs need no API key. Entitled BRTI access is optional and configured through the same server environment as the app.

Use Node 24 and install project dependencies, including development dependencies:

```sh
pnpm research:collect --once
pnpm research:collect
pnpm research:collect --report
```

The launcher loads `.env.local`, then `.env`; existing environment values take precedence. Local storage defaults to `data/bitcoin-research.db`; configured Turso credentials let the collector and hosted app share an archive.

The collector and browser use the same [futures-aware calculation](derivatives.md). Futures data is optional: unavailable or warming inputs retain the existing price/spot-pressure calculation. After updating this code, stop an already-running collector with Ctrl+C and restart it to load the new calculation. Existing saved calls and pending outcomes remain intact.

## Paired experiments and replay

Collection also tests the research changes. Each new checkpoint records four probabilities from
the exact same input snapshot: settlement dynamics alone, spot pressure only, futures pressure
only, and the combined model. The actual production probability is recorded separately, including
any approved learned adjustment. Disabling an effect does not remove its feed or accidentally
change the common reference price, volatility, or known settlement readings.

New manual Fixed decisions and browser background checkpoints use the same snapshot and comparison
helpers. Full calculation inputs and frozen model artifacts are saved in `research_input_snapshots`;
compact comparison results and a SHA-256 snapshot reference remain in `evidence_events`. Both
commit in the same database transaction. Retries cannot rewrite the original inputs. Old records
without these inputs cannot be reconstructed into prospective experiments.

Every five minutes, away from the first capture period, continuous collection evaluates the saved
comparisons and replays the latest ten snapshots. It writes
`data/kalshi-collector-state.json.comparison.json` (or the corresponding selected state-file path).
Run `npm run research:collect -- --report` to print a fresh JSON report and replay the latest 100
snapshots without opening market feeds, taking the collector lock, training, or activating models.
The report includes:

- Separate 12/9/6/3/1-minute results and manual Fixed results by remaining time.
- Brier score, log loss, directional accuracy, probability calibration, settlement interval coverage,
  call coverage, and outcome coverage.
- Paired differences from the settlement-only and combined models, with exploratory consecutive-event
  block resampling. Repeated checkpoint rows do not become independent events.
- Missing experiments, unavailable variants, optional-feed fallbacks, conflicting records, and pending outcomes.
- Snapshot replay matches, failures, and captures whose timing evidence prevents safe replay.

Replay reproduces the saved calculation boundary under its original clock. It is **not a complete
exchange-message replay engine**: spot/futures inputs retain aggregated flow, and older REST
histories have batch receipt provenance. Each snapshot records those limitations. Later feed data,
model artifacts, amendments, and official outcomes never replace a saved input. A mismatch is
reported; `--report` exits unsuccessfully when a replay fails.

The collector also stores future BRTI prices after 15, 60, and 180 seconds in
`research_forward_labels`. Each label uses the first canonical second at or after its due time,
explicitly recorded in `dueAt`; it never substitutes the next available tick for a missing due tick.
The return is `log(future BRTI / BRTI observed at capture)`. The exact reading can arrive later as
history; its actual receipt/provenance is saved separately. Missing readings wait up to ten minutes
before being marked missing. Coinbase proxy captures cannot produce BRTI return labels.
Unacknowledged labels are preserved in the selected state's `.forward-labels.json` outbox.

These labels support later tests of **forward** price response to trade pressure. They do not yet
replace the current pressure coefficients. Experiment rankings do not activate a model; existing
learning validation and promotion rules remain in force. Implementation/replay tests establish
correctness, not improved market accuracy.

## Benchmark streaming

The persistent collector now opens the authenticated standard Kalshi `cfbenchmarks_value`
WebSocket for BRTI. A subscription acknowledgment alone is insufficient: the index list must
confirm BRTI and a fresh whole-second reading must arrive. Only canonical one-second observations
enter the existing settlement grid; subsecond values and upstream trailing averages are not
substituted into it. Local receipt times are retained with streamed and seeded readings.

REST supplies initial history and refreshes it once a minute while the stream is live. If streaming
is unavailable or stale, the collector returns to its existing two-second REST schedule through
the shared limiter. Reconnect attempts use at least five seconds of delay and exponential backoff
up to one minute; each connection sends one subscription and one entitlement/index-list request.
These are local connection controls, not a promise about unrelated clients on the same account.
The browser continues using the existing benchmark API; this change does not make the worker the
authoritative publisher of all browser forecasts. No 5 Hz feed or new paid provider is required.

Protocol references: [BRTI WebSocket](https://docs.kalshi.com/websockets/cfbenchmarks-value) and
[WebSocket connection](https://docs.kalshi.com/getting_started/quick_start_websockets).

## Kalshi API budget

The collector, app and `pnpm kalshi:check` share the same durable limiter for every Kalshi GET.
Configured Kalshi credentials authenticate all of those reads. The account's limit and cost
policy refreshes after five minutes; the tracker uses at most half the reported read rate and
capacity, capped at 100 tokens per second and 100 tokens of capacity. It reserves at least
50 tokens per BRTI request and 10 per other read, or more if the discovered endpoint cost
requires it. These are quota tokens, not fees. The collector sends no Kalshi write requests.
Its research inserts and limiter updates are writes to our database, not Kalshi's write bucket.
See the [Kalshi limit design and official references](kalshi.md#shared-api-limits).

Local processes launched from this project share `data/kalshi-rate-limits.db`, separately from
the research archive and collector state file. When running on multiple machines or serverless
instances, point **every app and collector using the same Kalshi account** to the same remote
store with `KALSHI_RATE_LIMIT_DATABASE_URL` and `KALSHI_RATE_LIMIT_AUTH_TOKEN`. Existing remote
`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` values are used when those overrides are absent. Detected
serverless deployments require a remote shared store; an unavailable or locked limiter pauses
Kalshi requests. Starting more collectors does not grant more quota.

Individual reads have a three-second admission deadline; delayed permissions expire before
dispatch, even if storage takes longer to answer. A Kalshi 429 applies a shared exponential
pause starting at two seconds and increasing to 60 seconds, honoring a longer `Retry-After`
when present. The transport reports the temporary failure rather than rapidly resending it;
normal collection can try again after the pause. Checkpoints still obey their capture windows:
data delayed beyond a checkpoint is recorded as missing, never fabricated. Other applications
using the account or changes to Kalshi's limits can still cause throttling outside this
deployment's control.

## Collection rules

The recorder follows actual published targets and close times. It captures once at each 12/9/6/3/1-minute checkpoint, within five seconds of that checkpoint. Late starts do not invent earlier forecasts. Unknown targets or invalid data produce missing-checkpoint metadata. Finalized results are fetched later for the exact contract.

All checkpoints and overlapping collectors for an event are grouped in evaluation. Multiple
collectors do not produce extra independent examples. Every five minutes, outside capture
boundaries, the collector can analyze records and evaluate candidate models. Early learning can
fit a small correction after 40 eligible events, then must pass a fixed group of 40 future events
before it changes predictions. An approved correction is limited to five percentage points;
continued outcome checks can suspend it. Full model training keeps its larger, separate
training/calibration/test and future-validation requirements. Neither model activates merely
because it has enough records. See [outcome learning](forecast-learning.md) for the requirements.

`--once` waits briefly for market inputs, performs one recorder step, collects due forward labels,
checks storage and saved experiment replays, writes the comparison report, and exits. It is not
verification of a complete event. A continuous collector needs an awake, connected machine.

## Durable state

State is stored in `data/kalshi-collector-state.json`. It retains collector identity, immutable contracts, pending checkpoints, official results and exact unacknowledged evidence. Each update flushes a temporary file before atomic replacement. Brief Windows file-lock failures receive bounded retries; unrecoverable failures stop collection visibly instead of silently losing state.

Database inserts are idempotent. On restart, pending rows replay before new observation. Non-Kalshi state files are rejected, and server ingest guards reject legacy records.

A process lock prevents two local processes sharing the same state file. After an unclean shutdown, verify the recorded process is stopped before removing only that state's `.lock` file. Preserve the JSON state. An isolated check can use `--state-file=data/kalshi-smoke.json`.

## Hosting and access

A serverless Next.js request cannot host a permanent WebSocket. Run continuous collection as a separate persistent process if it must operate while the page is closed. No collector service or recurring task is installed automatically.

Existing local hardware needs no additional public market-data subscription. Hosting/database charges depend on the provider. Official BRTI requires Kalshi entitlement; its API documentation does not publish an access price. See [benchmark setup](kalshi.md). Never expose private keys or database tokens to the browser.

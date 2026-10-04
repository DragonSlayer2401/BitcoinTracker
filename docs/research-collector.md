# Continuous Kalshi research collector

The optional Node process records real KXBTC15M contracts while the browser is closed. It uses Coinbase trades, liquidity and candles, plus Bybit BTCUSDT perpetual executions and reported liquidations as inputs, and official Kalshi results as outcomes. Public inputs need no API key. Entitled BRTI access is optional and configured through the same server environment as the app.

Use Node 24 and install project dependencies, including development dependencies:

```sh
pnpm research:collect --once
pnpm research:collect
pnpm research:collect --report
```

For the separate experimental paper-account lifecycle, use `pnpm research:collect --paper-trading`.
Read its saved profitability report with `pnpm research:collect --paper-report` or the dashboard's
Paper trading popup. The flag reuses these feeds and API limits; it never places real orders.
See [paper trading](paper-trading.md) for the frozen policy, simulated fills and limitations.

The launcher loads `.env.local`, then `.env`; existing environment values take precedence. Local storage defaults to `data/bitcoin-research.db`; configured Turso credentials let the collector and hosted app share an archive.

The collector and browser use the same [futures-aware calculation](derivatives.md). Futures data is optional: unavailable or warming inputs retain the existing price/spot-pressure calculation. After updating this code, stop an already-running collector with Ctrl+C and restart it to load the new calculation. Existing saved calls and pending outcomes remain intact.

## Paired experiments and replay

Collection also tests the research changes. Version `kalshi-ablation-v5` records settlement-only,
spot-only, futures-only, combined, half-pressure, faster-decay, Kalshi-market blend and market-only
comparisons from the same snapshot. Frozen reversal and forward-pressure candidates are included
when eligible; absent candidates remain unavailable rather than receiving invented scores.
The actual production probability is recorded separately, including
any approved learned adjustment. Disabling an effect does not remove its feed or accidentally
change the common reference price, volatility, or known settlement readings.

V3 records a frozen active challenger separately from a new candidate in the same family. Structural
comparisons also retain their raw probability before calibration when available, so later evaluation
can distinguish the directional change from probability correction. Old V1/V2 rows remain
historical evidence; they are not relabeled as V3 or filled with newer candidate outputs.

V5 adds the independently frozen direct directional reversal prediction. It learns final flips
using the already collected native BRTI, spot/futures and Kalshi quote inputs. It shares V4's
baseline pipeline; V4 records do not acquire a directional prediction retrospectively. The
collector automatically fits, records and evaluates this sixth family through the existing
lease and future-cohort workflow. It needs positive directional improvement over current-side
in addition to better probability error before promotion. No new feed or paid API is required.

V4 introduced the corrected calculation generation: bounded missing interior BRTI readings may retain
native minute dynamics, while proxy uncertainty starts at the quote's actual observation time.
The baseline versions are `kalshi-brti-average-v3` and `kalshi-brti-derivatives-v2`. V1–V3 input
snapshots continue to use their original strict history and proxy timing rules during replay.
Original forecasts, outcomes and candidate artifacts are never rewritten to claim newer results.

Live stream snapshots select observations whose exchange and receipt timestamps have both passed
the capture time. Slightly ahead-of-clock messages remain buffered while the most recent eligible
observation is used. Archive timing checks stay strict; these changes do not make older captures
with invalid timing eligible for replay or learning.

Archived `kalshi-ablation-v1` snapshots still replay with their original four variants. New
comparisons are never backfilled into old decisions. The Research data dialog separates checkpoint
results and shows paired Brier differences, reversal recall, false alerts and coverage. Its paired
sample count can differ from a variant's total count; compare differences on the matched sample.

New manual Fixed decisions and browser background checkpoints use the same snapshot and comparison
helpers. Full calculation inputs and frozen model artifacts are saved in `research_input_snapshots`;
compact comparison results and a SHA-256 snapshot reference remain in `evidence_events`. Both
commit in the same database transaction. Retries cannot rewrite the original inputs. Old records
without these inputs cannot be reconstructed into prospective experiments.

Every five minutes, away from the first capture period, continuous collection evaluates the saved
comparisons and replays the latest ten snapshots. Archive analysis and learning run in a serialized
background-worker queue so their CPU work cannot hold up incoming market messages or capture timers.
Jobs have bounded execution time and are stopped during collector shutdown. The collector writes
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
- Collector heartbeat status, recorded feed freshness, and recent checkpoint/forward-label coverage.

A running heartbeat is separate from successful recording. The health panel reports sanitized
storage failures and warns when no evidence has been saved for over 15 minutes despite fresh
contract data. State writes recheck lock ownership; storage retries retain the original outbox,
and unresolved writes cannot be retried concurrently. Optional health reporting and candidate
enrollment do not delay acknowledgment of an already persisted forecast.

Replay reproduces the saved calculation boundary under its original clock. It is **not a complete
exchange-message replay engine**: spot/futures inputs retain aggregated flow, and older REST
histories have batch receipt provenance. Each snapshot records those limitations. Later feed data,
model artifacts, amendments, and official outcomes never replace a saved input. A mismatch is
reported; `--report` exits unsuccessfully when a replay fails.
Browser and Node arithmetic can differ in the final floating-point digits. Replay permits an
absolute difference of at most `1e-12` in finite numerical values; keys, types, identifiers and
array shapes must match. Neither stored inputs nor saved predictions are rounded or rewritten.

The collector also stores future BRTI prices after 15, 60, and 180 seconds in
`research_forward_labels`. Each label uses the first canonical second at or after its due time,
explicitly recorded in `dueAt`; it never substitutes the next available tick for a missing due tick.
The return is `log(future BRTI / BRTI observed at capture)`. The exact reading can arrive later as
history; its actual receipt/provenance is saved separately. Missing readings wait up to ten minutes
before being marked missing. Coinbase proxy captures cannot produce BRTI return labels.
Unacknowledged labels are preserved in the selected state's `.forward-labels.json` outbox.
If two collectors submit the same observation with different local save times, the existing label
is acknowledged without changing its payload or hash. Any differing price, return, receipt time,
or provenance remains a conflict rather than an overwrite.

The 60-second labels now fit the experimental forward-pressure model, using only labels already
received at training time. Collection automatically fits and prospectively evaluates all six
challenger families alongside the existing learning cycle. The report shows readiness, frozen
candidate IDs, future-validation progress and active status. Each requires its own future evidence;
an experiment ranking alone cannot activate it. See [challenger requirements](forecast-learning.md#prospective-challengers).
Implementation/replay tests establish correctness, not improved market accuracy.

`pnpm research:compare-directions` runs a separate read-only, historical comparison of current
side, recorded production, momentum, reversal, pressure agreement and usable Kalshi midpoint
direction. It freezes the local database sequence and analysis time, keeps contract checkpoints
together and purges outcomes unavailable at the chronological split. `--as-of`, `--max-sequence`,
`--database` and `--json` support repeatable local inspection. It never trains or activates a
model. These results are exploratory; see the [September 18 investigation](directional-research-2026-09-18.md).

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

After a long shutdown, expired saved contracts remain pending until a recent matching Kalshi
response is available. Offline time alone cannot mark a result unobserved before the outcome
lookup runs. A matching finalized result resolves the original call; a recent matching response
without a valid result can still end the wait after seven days. Network failures retain the
pending contract for retry. This does not rewrite earlier terminal outcome records.

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

## Collector health and updates

Open **Research data** to see the persistent collector's last heartbeat, running/stopped status,
loaded code generation, and BRTI, spot, futures and contract freshness. The modal refreshes health
every 30 seconds using a separate read-only endpoint. These checks query the shared research
database; they do not contact Kalshi, fit models or activate candidates.

The current collector identifies itself as `kalshi-collector-2026-10-03-v4` and records
`kalshi-ablation-v5` experiments. It writes a heartbeat at startup, every 30 seconds while running,
and on a clean stop or reported error. A heartbeat more than 90 seconds old becomes **Heartbeat
overdue**; this can mean the process stopped, lost connectivity, or cannot write to the database.
Health write failures do not stop forecast recording and are retried. Feed freshness describes
the observations available at the last heartbeat, not a live feed update on every screen refresh.
Multiple collectors have separate heartbeat records; private process IDs, host names and paths
are not exposed by the health endpoint.

Collectors started before this update do not send heartbeats. Recent evidence from an older
research generation can identify an outdated writer, but cannot prove that its process is still
running. After updating, stop each old collector with Ctrl+C and run `pnpm research:collect`
again from the updated checkout. Do not delete its state or pending rows. The next heartbeat
confirms the loaded code; new V5 checkpoints begin when their scheduled capture times arrive.
Restarting cannot recreate missed checkpoints or change saved predictions.

New challengers wait for recording verification before their development test begins. The
collector must save a fresh native-BRTI prediction containing the candidate's exact ID and its
original replay inputs, with a current running heartbeat. The market-blend candidate also needs
proof that a usable Kalshi quote reached its calculation. After verification, the database saves
the next 15-minute contract boundary; the evaluation starts there and keeps its first 60 contracts.
Verification failures affect this experiment enrollment only, never normal Live or Fixed calls.

The health panel distinguishes loaded candidates from candidates whose predictions were actually
saved during this collector session, and shows the last capture that used Kalshi prices. A model
being loaded is not evidence that its predictions were captured or that it has passed validation.
Kalshi prices now travel separately from immutable contract rules into both browser and CLI
calculations before their replay inputs are saved. Missing, stale, crossed or overly wide quotes
keep the existing fallback; they do not add a publication gate.

Completed runs with missing matching predictions are labeled **Not evaluated: missing predictions**,
not failed accuracy tests. Their artifacts, captured events, original cohorts and evaluations remain
in the archive. Infrastructure recovery fits a new candidate identity and requires new future
development and confirmation events; it never rebuilds old predictions. A failed confirmation still
consumes its original global attempt number. No validation threshold is relaxed by this recovery.

The panel also shows captured versus missed/withheld checkpoints for **known contracts** in the
last 24 hours, plus observed, missing and due/pending forward BRTI labels. It does not invent
contracts from periods when collection was offline, and those operational counts are not the
number of independent learning events. The archive report includes the same health summary.

## Position-aware paper adviser

The main dashboard now leads with trading decisions and a separate simulated $100 account. Start
its prospective decision and execution collection alongside ordinary prediction research with:

```sh
pnpm research:collect --trading-advisor
```

To keep collecting the original entry-and-hold experiment as well, use
`pnpm research:collect --paper-trading --trading-advisor`. The two policies have separate paper
accounts and evidence. Stop the previous collector before restarting; preserve its state file
and database. No command sends orders to Kalshi or reads your real account positions.

`pnpm research:collect --advisor-report` reads the saved adviser account, recommendations and
results without opening market feeds, fitting models or starting collection. The dashboard reads
the same stored report. Its polling does not make additional Kalshi requests. See
[trading adviser](trading-advisor.md) for position sizing, exit math, evidence and limitations.

Prediction research and its chronological model validation continue independently. Paper profit
does not automatically activate a prediction model or approve a strategy for live execution.

## Full-model deterioration monitoring

An activated full outcome classifier is checked against the baseline probability saved at each
original capture. The check selects the latest 120 independent background contract windows that
started after activation and have reached their scheduled close. Selection happens before official
outcomes are inspected. Every selected outcome and recorded prediction must verify; missing labels
hold their slots instead of being replaced with older resolved contracts. Manual forecasts do not
qualify, and at least 60 windows must actually apply a learned probability adjustment. Valid
out-of-domain baseline fallbacks retain coverage without counting as learned adjustments.

The full model is stopped when the paired 95% bootstrap interval lies entirely beyond either
declared deterioration margin: more than 0.005 additional Brier error, or more than five percentage
points lower directional accuracy, compared with the matching saved baseline. Both metrics use
the same captures and official outcomes. A one-sided market regime is included; it is not dropped
for lacking both result classes. Incomplete evidence is reported as monitoring, never a passed
health check. A complete check within the limits means deterioration has not been established,
not that the model has proved itself profitable.

Read endpoints immediately suppress a deteriorated model so forecasts use their baseline. The
leased analysis cycle records its retirement durably, and the same cycle does not train or
activate a replacement. A failed retirement write also cannot proceed to replacement activation.
Existing artifacts, saved forecasts and outcomes remain unchanged. Subsequent replacements still
need their own original validation; retirement is not approval. The learning report exposes this
under `full.monitoring`.

These rolling checks are operational fallback rules. Repeated monitoring is not a one-time
statistical guarantee, and prediction accuracy or Brier error is not trading profitability.

## Durable state

State is stored in `data/kalshi-collector-state.json`. It retains collector identity, immutable contracts, pending checkpoints, official results and exact unacknowledged evidence. Each update flushes a temporary file before atomic replacement. Brief Windows file-lock failures receive bounded retries; unrecoverable failures stop collection visibly instead of silently losing state.

Database inserts are idempotent. On restart, pending rows replay before new observation. Non-Kalshi state files are rejected, and server ingest guards reject legacy records.

A process lock prevents two local processes sharing the same state file. After an unclean shutdown, verify the recorded process is stopped before removing only that state's `.lock` file. Preserve the JSON state. An isolated check can use `--state-file=data/kalshi-smoke.json`.

## Hosting and access

A serverless Next.js request cannot host a permanent WebSocket. Run continuous collection as a separate persistent process if it must operate while the page is closed. No collector service or recurring task is installed automatically.

Existing local hardware needs no additional public market-data subscription. Hosting/database charges depend on the provider. Official BRTI requires Kalshi entitlement; its API documentation does not publish an access price. See [benchmark setup](kalshi.md). Never expose private keys or database tokens to the browser.

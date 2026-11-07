# Event datasets and deterministic replay

Phase 5 joins verified recordings, contract specifications, official BRTI observations
and outcomes into contract datasets. It builds reproducible snapshots for later feature
work. It does not train a model, submit orders or evaluate execution profitability.
See [implementation status](BOT_IMPLEMENTATION_STATUS.md) for observed checks and live
coverage; this guide describes the implemented interfaces rather than claiming results.

## Commands

```powershell
pnpm research:dataset --help
pnpm research:dataset build --kalshi-directory data/kalshi-market --output data/event-dataset-001 --json
pnpm research:dataset inspect --dataset data/event-dataset-001 --json
pnpm research:dataset replay --dataset data/event-dataset-001 --kalshi-directory data/kalshi-market --json
```

Sources can be combined and repeated:

```powershell
pnpm research:dataset build --kalshi-directory data/kalshi-market --spot-file data/coinbase-spot/CAPTURE_ID.jsonl --history-file data/history-supplement.json --output data/event-dataset-002 --json
```

Replace `CAPTURE_ID` with a completed Phase 3 recording's actual filename. A Kalshi
source is an owned Phase 4 archive directory; a spot source is one completed recording;
a history source is a saved supplement produced by the command below. Build and replay
require at least one source. `--synthetic` explicitly labels all supplied sources as
fixtures; use it only for synthetic recording inputs. It is not a way to claim live data.

| Option                    | Commands        | Meaning                                                        |
| ------------------------- | --------------- | -------------------------------------------------------------- |
| `--kalshi-directory PATH` | build, replay   | Repeatable completed Kalshi archive directories.               |
| `--spot-file PATH`        | build, replay   | Repeatable completed Coinbase JSONL recordings.                |
| `--history-file PATH`     | build, replay   | Repeatable saved retrospective supplements.                    |
| `--output PATH`           | build, history  | New dataset directory or new supplement file; never overwrite. |
| `--dataset PATH`          | inspect, replay | Existing dataset with a valid completion manifest.             |
| `--freshness-ms N`        | build           | Positive local freshness limit; default `5000`.                |
| `--lookback-ms N`         | build           | Positive reference lookback; default `900000` (15 minutes).    |
| `--synthetic`             | build, replay   | Explicit fixture provenance for all supplied source artifacts. |
| `--json`                  | all             | Compact machine-readable command output.                       |

`build`, `replay` and `inspect` are offline and do not load credentials or write research
or account history. Replay rebuilds using the saved configuration and compares the
resulting dataset identity. Supply the same source artifacts to reproduce the same
dataset; changing quality evidence or provenance can change the complete dataset
identity even when some individual earlier snapshots remain unchanged.

## Optional historical supplement

```powershell
pnpm research:dataset history --ticker KXBTC15M-26NOV070000-00 --reference-hour 2026-11-07T04:00:00Z --output data/history-supplement.json --json
```

The ticker and hour above are an explicit request example, not evidence of available
coverage. Choose the actual contracts and completed UTC hours needed for a dataset.
Repeat `--ticker` and `--reference-hour` as needed, within the local operation limits
of 100 unique contracts and 24 unique hours. Reference hours are start timestamps;
each requested hour must have finished by capture time. Requests never infer a
contract's opening time from its ticker.

Only `history` loads `.env.local` and `.env`. It uses the existing GET-only Kalshi
transport and shared rate limiter. For routine integration checks, set
`KALSHI_RATE_LIMIT_DATABASE_URL` to an isolated file URL before running. That avoids
touching the working limiter/research database. Credentials and raw transport errors
are not written to supplements or printed.

The adapter requests current series metadata, then each contract's current market
endpoint with historical-market fallback on HTTP 404. BRTI requests use explicitly
selected completed UTC hours. Successful source bodies and actual receive times are
retained. Failed requests, missing contracts, authorization failures and partial
reference hours remain in coverage. The supplement has a persisted random identity;
rebuilding datasets from that saved artifact does not generate new IDs or timestamps.

Every supplement capture is marked `retrospective-history` with original availability
`unknown`. It becomes visible only at its actual local fetch/receive time. A market's
opening timestamp, an index calculation time or a final result does not prove that
those fields were available to this application at an earlier decision. Historical
series metadata also does not establish which series revision was known then.

## Sources and documented limits

Official documentation was retrieved **2026-11-07 UTC / 2026-11-06 America/Chicago**.
Applicable versions are **Kalshi Trade API v2** and **CF Benchmarks API v1**. The
Coinbase source is the **Exchange API**; these documentation pages otherwise have no
printed revision. Contract interpretation remains owned by the
[Phase 2 specification](market-specification.md).

| Official source                                                                                                            | What it establishes                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Kalshi historical data](https://docs.kalshi.com/getting_started/historical_data)                                          | Older market data moves to historical endpoints; cutoff fields differ by data type. Events and series retain their original endpoints.                                       |
| [Get Historical Market](https://docs.kalshi.com/api-reference/historical/get-historical-market)                            | Individual archived contract metadata and reported results. The implementation reuses the existing current-to-historical fallback.                                           |
| [Get Historical Markets](https://docs.kalshi.com/api-reference/historical/get-historical-markets)                          | A paginated archived-market listing exists. This bounded adapter uses explicit tickers and does not claim exhaustive historical discovery.                                   |
| [Historical market candles](https://docs.kalshi.com/api-reference/historical/get-historical-market-candlesticks)           | Aggregated prices and bid/ask OHLC at one-minute, hourly or daily intervals. These are not full-depth books or original publication-time records.                            |
| [CF passthrough](https://docs.kalshi.com/cfbenchmarks/rest-passthrough)                                                    | Existing Kalshi credentials and suitable account entitlement provide access without a separate CF key.                                                                       |
| [CF historical values](https://docs.cfbenchmarks.com/api/rest/historical-values/)                                          | Index permission and `STREAM_HISTORICAL_VALUES` entitlement are required. Recent history may lag by up to 15 minutes; timestamps must match the requested timespan boundary. |
| [Coinbase product candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles) | Candles may be missing where no ticks occurred, and requests are limited to 300 buckets. OHLC values do not supply historical order-book depth.                              |

No full-depth historical order-book endpoint was found in the documented interfaces
reviewed for this phase. The supplement does not fetch candles, trades, user orders or
fills. Candles and final settlement results are never transformed into historical
books. Original Phase 3/4 snapshots and updates are the available depth evidence.

## Modules and data flow

| Owner                                                                                                        | Responsibility                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [build-events.runtime.js](../scripts/build-events.runtime.js)                                                | `build`, `inspect`, `replay` and `history` commands.                                                                               |
| [eventDatasetSources.service.js](../src/services/research/eventDatasets/eventDatasetSources.service.js)      | Read-only verification and normalization of retained recordings/supplements into stable source records and source-quality reports. |
| [eventReplay.utils.js](../src/features/ForecastResearch/features/EventDatasets/utils/eventReplay.utils.js)   | Controllable clock and receipt-time `asOf()` interface; independent model and trading inputs.                                      |
| [eventDataset.utils.js](../src/features/ForecastResearch/features/EventDatasets/utils/eventDataset.utils.js) | Contract joins, fixed horizons, feature eligibility, separate official labels and dataset quality.                                 |
| [eventDataset.repository.js](../src/services/research/eventDatasets/eventDataset.repository.js)              | Canonical serialization, checksums, exclusive output and artifact inspection.                                                      |
| [kalshiEventHistory.service.js](../src/services/kalshi/history/kalshiEventHistory.service.js)                | Bounded raw historical supplements and request/reference coverage.                                                                 |

The reader reuses [spot replay](spot-capture.md) and [Kalshi ingestion replay](kalshi-ingestion.md).
A source is admitted only after its retained history verifies. Incomplete, corrupt,
missing, changed or conflicting sources appear as excluded sources with reasons; their
unverified rows are not admitted. A contract identifiable from invalid evidence or a
missing historical request remains an excluded contract. When unsafe source data cannot
identify a contract reliably, the source exclusion still remains in the quality report.

## As-of inputs and deterministic time

`createEventReplay({ records, freshnessMs, lookbackMs })` exposes:

```js
const replay = createEventReplay({ records });
replay.clock.set(decisionAt);
const snapshot = replay.asOf(ticker);
replay.clock.advance(1000);
const next = replay.asOf(ticker);
const earlier = replay.asOf(ticker, earlierDecisionAt);
```

All clock values are UTC Unix milliseconds. `clock.set()` can rewind; the replay then
reconstructs the earlier state. `clock.advance()` accepts nonnegative millisecond
increments. No wall clock or random value is used to build snapshots.

Each source record has `receivedAt` and `availableAt`. Replay processes it only when
both are no later than the simulated decision time. Verified recordings currently use
their captured receipt time for availability. Stable ordering uses availability/receipt
boundary, source identity, capture sequence, ordinal and record ID. This is a
deterministic tie-break for simultaneous observations, not proof of sub-millisecond
causal ordering across independent feeds.

The contract snapshot includes only metadata known by that boundary. Opening reference
levels retain their first-known availability and separate revisions. BRTI values use
the latest revision received by the decision time, not a later correction backdated to
its calculation time. Original publication time remains unknown where the provider did
not supply it. Retrospective data and synthetic receipts retain distinct provenance.

`modelInputs` contains official reference observations and separately labeled Coinbase
proxy observations. Kalshi quotes remain under `tradingInputs`; they are not new
probability-model inputs. `contract` excludes final outcome, payout and settlement
label fields. `labels.jsonl` contains authoritative outcomes and any observed corrections
with their own availability and provenance. A simulated decision must not read that file
as predictive input.

Original independent REST books can be visible as limited-depth evidence at their
recorded receipt time. They retain the 100-level request limit and lack a WebSocket
sequence boundary; they never seed the incremental book engine. WebSocket gaps,
disconnects, stale data and invalid updates make reconstructed books unavailable until
the recorded replacement evidence restores usability.

## Horizons, eligibility and coverage

The builder reuses the existing **12, 9, 6, 3 and 1 minute** checkpoints. It freezes
the first observed contract schedule for those requests; a later close-time revision
is reported for review rather than silently moving earlier decision times. An unknown
schedule is an exclusion reason. Missing horizon evidence remains an ineligible
snapshot instead of removing the event.

The default feature policy requires a known contract and opening reference, verified
outcome rules, and a fresh official reference with complete canonical-second coverage
over the preceding 15 minutes. The reference interval is
`(decisionAt - lookbackMs, decisionAt]`. The 15-minute lookback and five-second freshness
limit are explicit local research settings, not optimized strategy parameters or proof
that these features predict well. Spot availability and trading-depth coverage are
reported separately; neither is substituted for missing official reference samples.

The quality report includes:

- Source provenance counts, admitted/excluded sources and validation issues.
- Excluded contracts with reasons and unresolved contracts lacking official outcomes.
- Missing reference samples at each horizon, plus opening/closing reference-window
  coverage and closing samples actually known at trading close.
- Missing or unusable historical depth at each horizon.
- Historical request/entitlement failures and uncertain original availability.

An event can be excluded for feature quality and unresolved at the same time. The
report preserves both facts. Data missing locally does not establish an outage at the
settlement agency and does not create an official NO outcome. Eventual dataset-wide
quality and label status are descriptive audit outputs; they are not appended to earlier
prediction snapshots as if they were known then.

## Export, inspection and limits

A dataset uses `event-dataset-v1`. Exports contain:

- `events.jsonl`: contract identities, schedules, resolution/eligibility status and reasons.
- `snapshots.jsonl`: `event-feature-snapshot-v1` horizon inputs and as-of quality.
- `labels.jsonl`: separate `event-outcome-label-v1` official outcome evidence.
- `quality.json`: `event-data-quality-v1` coverage and exclusions.
- `manifest.json`: `event-dataset-manifest-v1`, configuration, counts, per-file byte
  lengths/SHA-256 checksums and a content-derived dataset identity.

The writer accepts a new output directory only. Files are created exclusively and
synchronized; the manifest is written last as the completion marker. Inspection checks
regular-file constraints, expected filenames, sizes, hashes, identity and counts. It
does not repair or overwrite partial exports. Hashes establish artifact consistency,
not the authenticity of an external source.

Local implementation limits are 500,000 admitted source records, 2,500 contracts,
64 MiB per historical supplement and 256 MiB per exported artifact. They are bounded
operation limits, not measured capacity guarantees. Build and inspect work in memory;
use bounded source selections. The source archives are read-only and are not pruned by
dataset commands.

Reproducible replay proves that the same admitted evidence and configuration produce
the same artifacts. It does not establish complete historical availability, forecast
accuracy, realistic execution or positive net returns.

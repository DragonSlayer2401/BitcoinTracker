# Kalshi market and official reference capture

Phase 4 records KXBTC15M market metadata, order books, and available CF Benchmarks
BRTI evidence through Kalshi. It preserves source observations for inspection and
restart without changing forecasts, models, trading decisions, or order submission.
Coinbase BTC-USD remains a separate proxy captured by the [Phase 3 recorder](spot-capture.md).
The [Phase 2 market specification](market-specification.md) owns contract interpretation,
the linked CRYPTO terms, and outstanding rule-verification blockers. Recording data
does not resolve those blockers.

## Commands and access

```powershell
pnpm kalshi:capture --help
pnpm kalshi:capture record --directory data/kalshi-market --duration-seconds 30 --json
pnpm kalshi:capture inspect --directory data/kalshi-market --json
```

Without `--duration-seconds`, recording continues until Ctrl+C or termination. Normal
shutdown stops the feeds and drains accepted writes before completing the capture.
`inspect` verifies every retained completed session by replaying its inputs and
comparing the normalized results. It does not connect to an exchange, load environment
files, repair evidence, or report archived quotes as currently executable.

`record` loads `.env.local` and `.env` through the existing Node environment loader.
It uses server-side `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` when configured.
Public market discovery remains available without credentials. Authenticated book
connections and BRTI access depend on credentials and applicable account/channel
access; a successful connection alone does not establish BRTI entitlement. Missing,
denied, stale, or unavailable official data is reported separately. No exchange spot
price replaces the missing official reference.

Network requests reuse the application's GET-only transport and shared Kalshi rate
limiter. They can therefore update its limiter database. For an isolated integration
check, select an isolated file URL with `KALSHI_RATE_LIMIT_DATABASE_URL` before
starting; do not run a routine check against the working research database.
Authentication headers, private keys, and raw transport error details are not archive
fields or command output.

| Record option           | Default              | Meaning                                                                           |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `--directory`           | `data/kalshi-market` | Owned capture directory, resolved to an absolute path.                            |
| `--duration-seconds`    | Until stopped        | Positive integer duration.                                                        |
| `--poll-seconds`        | `30`                 | Metadata, pending result, REST book and reference refresh; minimum one second.    |
| `--freshness-ms`        | `5000`               | Local book/reference freshness policy, retained in recording configuration.       |
| `--max-bytes`           | `268435456`          | 256 MiB limit across archive JSONL files; metadata bytes are reported separately. |
| `--max-pending-records` | `5000`               | Maximum queued/in-flight records.                                                 |
| `--max-pending-bytes`   | `67108864`           | 64 MiB limit on queued/in-flight input bytes.                                     |
| `--json`                | Off                  | Compact complete report rather than the normal console summary.                   |

These are configurable local operating limits, not venue capabilities or optimized
strategy parameters. `inspect` accepts only `--directory` and `--json`. Changing
normalization configuration, including freshness, requires a separate directory;
existing evidence is not silently reinterpreted.

## Sources and versions

Official documentation retrieved **2026-11-07 UTC / 2026-11-06 America/Chicago**.
The applicable interfaces are **Kalshi Trade API v2** and **CF Benchmarks API v1**.
Pages without a printed revision are recorded as unversioned. The fixed-point guide
states an update date of November 5, 2026.

| Source                                                                                                                                         | Applicable evidence                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [Get Markets](https://docs.kalshi.com/api-reference/market/get-markets), [Get Market](https://docs.kalshi.com/api-reference/market/get-market) | Series/shard discovery, pagination, market state, contract metadata and reported final results.                                         |
| [Orderbook Updates](https://docs.kalshi.com/websockets/orderbook-updates)                                                                      | Authenticated snapshots and additive deltas, subscription sequence, exchange clock and replacement snapshots.                           |
| [Get Market Orderbook](https://docs.kalshi.com/api-reference/market/get-market-orderbook)                                                      | Independent REST YES/NO bid snapshots.                                                                                                  |
| [Fixed-point representation](https://docs.kalshi.com/getting_started/fixed_point_migration)                                                    | Dollar price strings, contract quantity strings and market-specific price ranges.                                                       |
| [CF Benchmarks passthrough](https://docs.kalshi.com/cfbenchmarks/rest-passthrough)                                                             | Existing Kalshi authentication and entitlement, wrapped CF responses, supported historical access.                                      |
| [Kalshi BRTI feed](https://docs.kalshi.com/websockets/cfbenchmarks-value)                                                                      | Raw upstream index frames, provider timestamps, index availability and separately supplied averages.                                    |
| [CF value channel](https://docs.cfbenchmarks.com/api/websocket/value/), [CF REST values](https://docs.cfbenchmarks.com/api/rest/values/)       | Calculation time, exact values including scientific notation, amendment time and repeated-value flags.                                  |
| [CF historical values](https://docs.cfbenchmarks.com/api/rest/historical-values/)                                                              | Additional historical entitlement and possible publication delay of recent history.                                                     |
| [Market lifecycle](https://docs.kalshi.com/websockets/market-and-event-lifecycle)                                                              | Distinct determination and settlement events; this implementation captures REST-observed states instead of subscribing to that channel. |
| [CRYPTO terms](https://assets.kalshi.com/contract_terms/CRYPTO.pdf)                                                                            | Linked KXBTC15M contract terms; no printed revision. Interpret with the market-specific rules recorded in Phase 2.                      |

## Modules and data flow

| Owner                                                                                                                                                                                  | Responsibility                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [capture-kalshi.runtime.js](../scripts/capture-kalshi.runtime.js)                                                                                                                      | `record`/`inspect` arguments, polling, status output and graceful stop.                                          |
| [kalshiIngestion.service.js](../src/services/kalshi/ingestion/kalshiIngestion.service.js)                                                                                              | `createKalshiRecorder`, discovery, feed coordination, bounded intake, durable append and `inspectKalshiArchive`. |
| [kalshiIngestionState.utils.js](../src/services/kalshi/ingestion/kalshiIngestionState.utils.js)                                                                                        | Deterministic `createKalshiIngestionState` reducer and combined report.                                          |
| [kalshiMarket.utils.js](../src/services/kalshi/ingestion/kalshiMarket.utils.js)                                                                                                        | Market identity, local rule fingerprints, first-seen state and official result evidence.                         |
| [kalshiBookStream.service.js](../src/services/kalshi/ingestion/kalshiBookStream.service.js), [kalshiBook.utils.js](../src/services/kalshi/ingestion/kalshiBook.utils.js)               | Authenticated book capture, continuity checks, reconstruction and resynchronization.                             |
| [benchmarkStream.service.js](../src/services/kalshi/benchmarkStream/benchmarkStream.service.js), [kalshiReference.utils.js](../src/services/kalshi/ingestion/kalshiReference.utils.js) | Existing BRTI connector's optional raw capture hook and separate publication/revision normalization.             |
| [kalshiRecording.repository.js](../src/services/kalshi/recording/kalshiRecording.repository.js), [recording.repository.js](../src/services/recording/recording.repository.js)          | Kalshi archive policy over the shared append-only JSONL storage implementation.                                  |

The recorder fetches series metadata, follows open/unopened discovery pages on the
reported exchange shard, and selects contracts within its three-hour default horizon.
Previously observed unfinished contracts remain tracked after leaving discovery;
individual reads have a historical-market fallback. Each poll preserves the returned
payload and observed lifecycle changes. Polling cannot establish every intermediate
transition or its original publication time.

WebSocket input retains the original text before parsing and filtering. REST input
retains the parsed response payload, including source fields; original HTTP whitespace
and byte representation are not retained by the existing transport. Each archived
input accompanies its deterministic normalized output. Restart restores prior sessions
in durable capture order before admitting new observations.

## Evidence and units

`kalshi-market-recording-v1` rows contain a session-local ordinal, configuration, input
and normalized output. Directory and manifest versions are respectively
`kalshi-market-directory-v1` and `kalshi-market-manifest-v1`; a monotonic
`captureSequence` orders sessions. Reports use `kalshi-ingestion-report-v1`.

Market records use `kalshi-market-evidence-v1`. `firstSeenAt` is local first observation
in retained history. `ruleVersion` is a SHA-256 content fingerprint of captured rule
evidence, not a revision number assigned by Kalshi. Opening reference, trading close,
administrative expiration, provider update and settlement timestamps remain separate.
A `finalOutcome` requires an exchange `finalized`/`settled` state and YES/NO result;
closed or determined states and local BRTI calculations do not supply that result.
The settlement index value and dollar payout are separate fields. Missing source
settlement timestamps remain null.

Books use `kalshi-book-v1` / `kalshi-books-v1`. Prices are integer strings in
10^-4 USD per contract and quantities in 10^-2 contracts, calculated with exact integer
arithmetic. This representation does not certify that every increment is tradable;
Phase 2's verified metadata and trading gates still own legality. YES asks are the
one-dollar complements of NO bids, and NO asks complement YES bids.

Reference normalization emits `kalshi-reference-batch-v1` and
`kalshi-reference-observation-v1`. Source is `cf-brti`, official, via Kalshi; values
remain exact USD/BTC decimal strings with the original source string retained.
Scientific notation is expanded without floating-point price conversion. All numeric
time fields use UTC Unix milliseconds:

- `sourceCalculatedAt`: the index value's calculation time.
- `sourceAmendedAt`: supplied amendment time, otherwise null.
- `providerReceivedAt` / `providerSentAt`: supplied Kalshi envelope clocks.
- `responseServerAt`: supplied REST response clock, never a publication timestamp.
- `receivedAt` / `firstSeenAt`: local observation time for that revision.
- `sourcePublishedAt`: null because original publication time is not supplied by the
  documented fields used here.

Identical observations retain their earlier first-seen time. A changed value or
amendment creates a locally numbered revision; A → B → A is three observed revisions.
Earlier revisions remain in the archive, and as-of selection uses when each revision
was locally known. Repeated-value flags and canonical-second eligibility are explicit.
Only fresh, non-repeated canonical-second observations can make the reference report
available during a live capture; retaining another publication does not make it usable.
Raw duplicate, invalid and ignored inputs remain evidence rather than extra settlement
samples. The reference reducer has an explicit 100,000-observation capacity; it rejects
further normalized observations instead of evicting first-seen history. Raw inputs
remain recorded with an invalid normalization disposition, and old accepted values age out.

The standard Kalshi BRTI channel suppresses some duplicate/out-of-order upstream
timestamps. REST may reveal amendments that the live channel did not deliver.
Historical CF data can arrive late; fetching it now does not prove availability at an
earlier trading decision. This archive records delivered evidence and cannot promise
every source revision. Local missing data, denied access and connection failure do not
establish a source-agency outage or an official NO settlement.

## Continuity, storage and inspection

Live book reconstruction starts from a WebSocket snapshot and adds subsequent signed
quantity deltas. Zero quantity removes a level. A sequence gap, conflicting duplicate,
invalid quantity, regressed clock or lost connection invalidates availability and
requires replacement WebSocket snapshots. Control replies participate in subscription
sequence accounting. Exchange clocks are distinct from sequence numbers and may skip
or repeat. Snapshot requests are bounded and retried through the connector's existing
timeout/backoff behavior. Future, stale and crossed quotes are unavailable.

REST books are retained as independent snapshots. They have no matching WebSocket
sequence boundary and never seed or patch the delta stream. Inspect reports them as
historical evidence, even if their receipt age would otherwise be fresh.

A bounded FIFO preserves capture order. The live check's burst traffic motivated
durable batches of up to **100 rows** rather than synchronizing every delta separately;
measured run details belong in [implementation status](BOT_IMPLEMENTATION_STATUS.md).
Batch acknowledgement follows file synchronization and atomic manifest replacement.
This is not a guarantee of universal power-loss durability: directory-entry
synchronization is not provided.

Status separates received, written, unpersisted and pending records; pending bytes and
peak record/byte counts expose backlog against configured queue limits. `failureCode`
identifies capture failure. Queue overflow or append failure stops capture, marks the
session incomplete and prevents its report from presenting live books/reference data.
The latest processed observation is not itself proof of a durable write; inspect the
acknowledged counts and completion state.

Retention is disabled by default. The CLI exposes no retention, prune or repair
command. Explicit programmatic cleanup is available through
`pruneKalshiRecordings({ directory, retentionHours, now })`; it targets only eligible
completed captures in the owned archive. It refuses active locks, links and inconsistent
completed manifests. Cleanup records a retained-history warning, so later first-seen
times are described as first seen in retained evidence, not necessarily lifetime first
observation. Removing an earlier session can also remove state needed to reproduce a
later session's saved normalization; inspection and restart then reject that mismatch.
Keep the complete history for continuous verified replay, or start a separate directory.
Unknown or incomplete prior captures block new ingestion and inspection;
they are not silently skipped, deleted or repaired. Use a different directory for a
separate run while retaining damaged evidence for review.

Inspection streams completed captures, checks framing, versions, ordinals and manifest
counts/bytes, reconstructs state and compares every saved normalized result. It rejects
mismatches without rewriting the archive. Successful replay establishes reproducibility
of captured inputs, not exchange completeness, trading accuracy or profitability.

The workflow suite is
[RecordKalshiMarket.test.js](../src/features/MarketData/features/MarketFeeds/__tests__/KalshiIngestion/RecordKalshiMarket.test.js).
See [implementation status](BOT_IMPLEMENTATION_STATUS.md) for actual commands, observed
results, entitlement evidence and remaining blockers; this document does not claim an
unperformed integration or performance validation.

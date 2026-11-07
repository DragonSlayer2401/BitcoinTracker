# BTC spot capture and replay

Phase 3 captures **one feed: Coinbase Exchange BTC-USD**, reusing
`createCoinbaseStream` in [coinbaseStream.service.js](../src/services/coinbase/stream/coinbaseStream.service.js).
Coinbase prices remain a proxy for the Kalshi settlement index. This command does
not start the research collector, derivatives, a forecast model, or order submission.
It does not load `.env` files or require credentials.

## Commands

Use the existing Node/pnpm installation:

```powershell
pnpm spot:capture --help
pnpm spot:capture record --directory data/coinbase-spot --duration-seconds 30 --json
pnpm spot:capture status --directory data/coinbase-spot --json
pnpm spot:capture replay --file data/coinbase-spot/CAPTURE_ID.jsonl --json
```

Replace `CAPTURE_ID` with the filename printed by `record` or `status`. Without a
duration, recording runs until Ctrl+C. The command reports connection health,
latest observation, current quote when available, apparent receive delay, queue
and durable-write counts, storage growth and the absolute recording location.
Book arrays are summarized in console output; their normalized contents and original
payload remain in the archive. Historical observations are distinct from the current
quote: `latestQuote` is null when disconnected, stale, missing or unconfirmed.

`--freshness-ms` defaults to 5000. `--max-bytes` defaults to 268435456 (256 MiB)
across raw JSONL files in the selected archive. `--max-pending-records` defaults to
1000 and `--max-pending-bytes` to 67108864 (64 MiB). These are local operating
limits, not exchange capabilities or empirically optimized parameters. The queue
also reserves one small stopped control record so graceful shutdown can drain a
full data queue. Capacity failure stops capture visibly; it does not discard an
event and continue as if the recording were complete.

Retention defaults to disabled (`--retention-hours 0`). A configured duration is
reported alongside retained bytes and completed captures eligible for expiry.
Cleanup is a separate, explicit operation:

```powershell
pnpm spot:capture record --directory data/coinbase-spot --retention-hours 168
pnpm spot:capture prune --directory data/coinbase-spot --retention-hours 168 --json
```

`prune` deletes expired **completed** captures belonging to that archive. It refuses
an active writer lock, links and invalid manifests. Incomplete captures and unknown
files are retained; neither the research database nor account history is a cleanup
target. A crash may leave a lock. Verify its owning process has stopped before any
manual repair; the command never guesses that a lock is stale and removes it.

## Sources and documented limits

Retrieved **2026-11-06 America/Chicago** (2026-11-07 UTC). These are current official
Coinbase Exchange documentation pages, with no published numbered protocol revision:

| Source                                                                                 | Applicable evidence                                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [WebSocket overview](https://docs.cdp.coinbase.com/exchange/websocket-feed/overview)   | Public endpoint `wss://ws-feed.exchange.coinbase.com`, typed JSON messages, subscription acknowledgement and product sequence identifiers.       |
| [WebSocket channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)   | `matches`, `heartbeat`, `ticker`, `level2_batch`; heartbeat trade markers; match maker side; ticker batching; book update replacement semantics. |
| [Best practices](https://docs.cdp.coinbase.com/exchange/websocket-feed/best-practices) | Avoid slow consumers and backlog. Queue limits therefore fail explicitly rather than claiming uninterrupted capture.                             |

The existing connector subscribes to these channels for BTC-USD only. Heartbeats
arrive approximately once per second; the initial `last_match` is a baseline, not a
new trade. Matches can be missed. The channel documentation describes 50 ms book
batches; their timestamp describes the latest event in the batch. Snapshot source
time and sequence are unavailable. Sizes replace a price level; zero removes it.
Ticker updates may combine multiple trades. Consequently, **a ticker sequence jump
alone is not a trade gap**; that is an inference from the selected-channel semantics,
not a claim of a contiguous ticker stream. No REST backfill or historical completeness
claim is added. Reconnection starts a new continuity segment and retains the gap.

## Records and units

[coinbaseSpotNormalizer.utils.js](../src/services/coinbase/recording/coinbaseSpotNormalizer.utils.js)
owns `createCoinbaseSpotNormalizer`. It is deterministic: it reads captured input and
configuration, never the current wall clock or network during replay.

- `coinbase-spot-recording-v1`: a local ordinal, normalization configuration, original
  input and the corresponding normalized result. Receipt order is authoritative;
  records are never rearranged by exchange time.
- `coinbase-spot-normalized-v1`: disposition, diagnostics/gaps, observation and health
  at the captured time. Duplicate and rejected inputs still have raw archive records.
- `coinbase-spot-observation-v1`: source `coinbase-btc-usd`/proxy, venue
  `coinbase-exchange`, instrument BTC-USD, base BTC, quote USD; price in USD/BTC and
  quantity in BTC, preserved as decimal strings. Phase 2 exact-decimal helpers are
  reused; spot prices are not coerced into binary-contract price units.
- Source event time retains its original UTC ISO string and fractional precision.
  Event/receipt millisecond fields use UTC Unix milliseconds; nanosecond integer
  strings preserve source ordering and apparent delay below a millisecond. Local
  receipt has millisecond precision. Apparent receive delay includes clock skew;
  it is not an independently measured network latency.
- Source sequence and trade/event identifiers are retained separately when supplied.
  No absent identifier, timestamp or bid/ask size is invented. Snapshot source time
  stays null. Original text is preserved before parsing, including invalid JSON.
- Ticker observations normalize best bid/ask and available sizes. Match observations
  preserve maker side and explicitly derive aggressor side. Book snapshots and
  changes retain normalized levels; no unsupported global book-sequence guarantee
  is inferred from unsequenced batches.

New spot records have their own versions because the existing shared trading records
require a Kalshi market identity and USD-per-contract prices. They are not a substitute
for BRTI observations and are not fed into a new forecast model in this phase.

## Reliability and persistence

The connector's existing bounded exponential retry/backoff, jitter, handshake and
heartbeat timeout behavior is reused. Optional capture hooks record connection
transitions, raw messages and clock checks before aggregate processing. Normal browser
and collector consumers retain their current API.

Deduplication of identified trades, tickers and heartbeats affects derived observations
only, using 10,000 recent identities plus ordering checks. Unsequenced book batches
retain their payload and absolute quantities; no exchange ID is invented. A recognized repeated event does not refresh
its receipt time or the current quote. Conflicting IDs and invalid payloads have
explicit dispositions. Regressing times/IDs are reported, with original input retained.
Trade-ID discontinuities and unresolved heartbeat trade markers identify gaps; the
heartbeat grace period is a local two-second ordering allowance. Disconnections are
recorded gaps. Missing/stale heartbeats or quotes block current availability. No quote
is silently carried forward with a new timestamp, and future source time is ineligible.

[spotRecording.service.js](../src/services/coinbase/recording/spotRecording.service.js)
owns `createSpotRecorder` and `replaySpotRecording`. A bounded FIFO separates receipt
from durable append. Stop drains accepted inputs; write failures and overflow mark the
capture incomplete and withhold a current quote. A status observation is the latest
processed input; `writtenRecords` and pending counts distinguish durable completion.

[spotRecording.repository.js](../src/services/coinbase/recording/spotRecording.repository.js)
owns `createSpotRecordingStore`, `readSpotRecording`, `getSpotRecordingStatus`, and
`pruneSpotRecordings`. It uses Node's existing filesystem facilities, with no new
database or dependency. Each session writes a new JSONL file under an owned directory
and exclusive writer lock. Raw records are append-only. A separate atomic manifest
tracks versions, counts, actual UTF-8 bytes, times, retention and completion. Durable
append acknowledges only after file synchronization and metadata update.
This is file-content synchronization with atomic metadata replacement, not a claim
of universal power-loss durability; directory-entry synchronization is not provided.

Replay streams a completed archive, checks framing/counts/versions/ordinals, rebuilds
normalized results from original inputs and recorded settings, and compares every
result. It rejects partial files, incomplete sessions and mismatches without repairing
or overwriting them. Passing replay proves deterministic reproduction of captured
observations; it cannot prove that the exchange delivered every event.

## Verification and scope

Workflow fixtures are in
[MarketFeeds/**tests**/SpotRecording](../src/features/MarketData/features/MarketFeeds/__tests__/SpotRecording).
Their market messages and timing are explicitly synthetic. They exercise duplication,
ordering (including fractional timestamps), disconnect/reconnect, heartbeat gaps,
staleness, replay, storage exhaustion, incomplete writes, locks and retention in isolated
temporary storage. Filesystem link rejection may use a mocked link metadata boundary
where the Windows sandbox cannot create junctions.

See [implementation status](BOT_IMPLEMENTATION_STATUS.md) for observed command results,
the isolated live check and any remaining limitations. Phase 2's venue-rule blockers
and the Phase 1 probability-independence finding remain separate. No new exchange,
derivatives feature, model, strategy or production order integration is included.

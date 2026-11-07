# Bot implementation status

## Current phase

Phase 4 implements read-only KXBTC15M discovery, order-book capture and official
settlement-reference ingestion. Code and offline acceptance are complete; live feeds,
replay, a same-clock book comparison and an official final result were observed.
Long-run capacity and economic performance remain unvalidated. Production submission
is absent. Phase 5 has not been supplied and is not started.

See [Kalshi ingestion](kalshi-ingestion.md) for commands, official source URLs,
retrieval dates, API versions, schemas and operational limitations.

### Phase 4 changes and interfaces

- `scripts/capture-kalshi.mjs`, `scripts/capture-kalshi.runtime.js` and `package.json`
  expose `pnpm kalshi:capture record|inspect`. Reports show reference/rule verification,
  executable depth and freshness, reference-feed access, lifecycle and final outcomes.
  No rendered UI, forecast input, model, trading decision or order submission changed.
- `src/services/kalshi/ingestion/kalshiIngestion.service.js` exports
  `createKalshiRecorder` and `inspectKalshiArchive`. Discovery uses the verified series
  shard, follows cursors, applies a three-hour horizon locally and follows pending
  contracts after they disappear from active/upcoming discovery. This avoids the existing
  dashboard reader's incompatible status/close-filter combination without rewriting it.
  `rateLimit/rateLimit.policy.js` adds bounded opaque cursors to its GET-only allowlist.
- `kalshiMarket.utils.js`: `normalizeKalshiMarketEvidence` and
  `createKalshiMarketHistory` retain identifiers, local rule-content fingerprints,
  opening reference, observed lifecycle changes and authoritative finalized/settled
  YES/NO results. Close, administrative expiry, settlement time, index value and payout
  remain separate. Missing source timestamps stay null. Polling can miss intermediate states.
- `kalshiBook.utils.js`: `createKalshiBookState` and `normalizeKalshiRestBook` use exact
  fixed-point bids/complementary asks with quantities, source clocks, subscription-wide
  sequences and replacement snapshots. `kalshiBookStream.service.js` owns authenticated
  market-data subscriptions, heartbeat, reconnect and gap resynchronization. Independent
  REST snapshots never seed a WebSocket delta sequence.
- `kalshiReference.utils.js`: `createKalshiReferenceNormalizer` retains exact index
  values, raw strings and first-seen revisions. The existing
  `benchmarkStream/benchmarkStream.service.js` adds an optional raw capture hook while
  preserving default forecast behavior. Calculation, amendment, provider and receipt
  clocks remain separate; unavailable original publication time stays null. Coinbase
  remains an explicitly labeled, separate proxy that cannot determine settlement.
- `kalshiIngestionState.utils.js` combines these evidence streams for inspection.
  `src/services/recording/recording.repository.js` reuses the Phase 3 archive engine;
  spot and Kalshi wrappers retain separate formats/ownership. Spot's API and format
  remain unchanged. Kalshi adds capture ordering, locked restoration, incomplete-history
  refusal and retention warnings. Batches acknowledge up to 100 individual JSONL rows
  after synchronized data and manifest writes.
- One new workflow suite:
  `src/features/MarketData/features/MarketFeeds/__tests__/KalshiIngestion/RecordKalshiMarket.test.js`.
  Its keys, prices, states and sockets are synthetic fixtures, not historical performance.

### Phase 4 acceptance

- **Passed:** active/upcoming discovery and pagination; persisted contracts, rule
  fingerprints and references; close/determination distinct from finalization; later
  payout correction; reference revisions and first-seen times survive restart;
  as-of views; unknown publication times; explicit proxy and missing-access states.
- **Passed:** exact complements and fractional depth; fresh-snapshot agreement;
  duplicate/regressed/invalid events, negative quantities, stale/crossed books;
  subscription-wide gaps block all affected books until resnapshot; no order commands.
  Real book and standard BRTI access were confirmed with the configured account.
- **Passed:** completed replay, capture ordering, incomplete-history blocking, bounded
  queues, truthful saved-row counts, failure disables availability, and batch validation.
  Archived REST quotes and stopped captures cannot appear live/executable.
- **Limited/unverified:** original publication timestamps, revisions suppressed by the
  upstream feed, every intermediate lifecycle transition, multi-hour capacity, power-loss
  recovery and profitability. Phase 2's quantity, halfway-rounding and expiration
  conflicts remain blocking for actionable trading recommendations.

### Phase 4 observed checks

Checks occurred 2026-11-07 UTC / 2026-11-06 America/Chicago. Integration used isolated
archive directories and an isolated limiter database, with no research/account writes,
paid experiments or order submission.

| Command / check                                                                                                                                                            | Observed result                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm kalshi:capture --help`                                                                                                                                               | Passed.                                                                                                                                                                                                                           |
| `pnpm test --runTestsByPath` with `RecordKalshiMarket.test.js` and the four `MarketFeeds/__tests__/SpotRecording/` suites                                                  | **5 suites / 54 tests passed**, 3.437 seconds: 18 Phase 4 and 36 Phase 3 checks.                                                                                                                                                  |
| Initial `pnpm test`, outside Windows sandbox                                                                                                                               | **42 suites / 339 tests passed, 1 suite / 1 test failed**, 145.246 seconds. Unchanged collector test line 415 retained pending rows after its fixed 50-yield wait; this timing-sensitive failure was already observed in Phase 3. |
| `pnpm test --runTestsByPath src/features/ForecastResearch/features/EvidenceCollection/__tests__/PersistentCollector/RunPersistentCollector.test.js`, alone outside sandbox | **17 tests passed**, 3.266 seconds. No collector source/test changes.                                                                                                                                                             |
| Final `pnpm test` after batching                                                                                                                                           | **42 suites / 340 tests passed, 1 suite / 1 test failed**, 131.385 seconds; same unchanged collector timing assertion at line 415.                                                                                                |
| `pnpm format:check`; `git diff --check`                                                                                                                                    | Both passed; only existing Windows LF/CRLF notices from Git.                                                                                                                                                                      |
| `pnpm build`                                                                                                                                                               | Passed outside the Windows sandbox: Next.js 16.3.4/Turbopack compiled in 1,283 ms, generated all three static pages and existing dynamic routes.                                                                                  |
| Browser/typecheck                                                                                                                                                          | No rendered UI changed; browser check unnecessary. No standalone typecheck command exists in this JavaScript stack.                                                                                                               |

Exact live command forms (the limiter variable selects isolated storage):

```powershell
$env:KALSHI_RATE_LIMIT_DATABASE_URL = ([System.Uri](Join-Path (Get-Location) 'test-artifacts/phase4-live/rate-limits.db')).AbsoluteUri
pnpm kalshi:capture record --directory test-artifacts/phase4-live/capture --duration-seconds 20 --json
pnpm kalshi:capture inspect --directory test-artifacts/phase4-live/capture --json
pnpm kalshi:capture record --directory test-artifacts/phase4-live/capture --duration-seconds 30 --poll-seconds 10 --json
node --conditions=react-server test-artifacts/phase4-book-check.mjs
pnpm kalshi:capture record --directory test-artifacts/phase4-live-verified/capture --duration-seconds 30 --poll-seconds 10 --json
pnpm kalshi:capture record --directory test-artifacts/phase4-live-batched/capture --duration-seconds 30 --poll-seconds 10 --json
pnpm kalshi:capture inspect --directory test-artifacts/phase4-live-batched/capture --json
```

- Initial capture: **5,312 rows**, 12 contracts and 3,617 BRTI observations including
  the REST seed. All normalized rows replayed identically; books and reference were live.
- Restart continuation captured `KXBTC15M-26NOV070000-00` finalized **YES**:
  settlement index `75802.11`, payout `1.0000`, settlement timestamp `1794027605606`,
  separately from trading close `2026-11-07T05:00:00Z`. The session later stopped
  incomplete at 7,067 saved rows. Its accepted prefix drained; the initial error did not
  distinguish queue overflow from other capture failures. The 1,000-row queue was the
  supported working diagnosis. Evidence remains intact; completed-only inspection now
  refuses that directory rather than ignoring the incomplete session.
- Separate live book check: **8,374 deltas / 6 snapshots** in 12 seconds. One fresh
  snapshot at clock `18590966229` matched **143 YES / 136 NO levels** after 7,587 deltas,
  with adjacent subscription sequences 7592 → 7593. Five noncomparable snapshots were
  excluded; zero comparable mismatches. Evidence is in ignored
  `test-artifacts/phase4-live/book-comparison.json`; its script only reads market data.
- A configurable 5,000-row queue completed **10,197 rows** with zero unsaved accepted
  rows, but peak backlog 2,808 justified batching durable writes instead of relying
  on capacity alone. Failure codes and peak metrics are now explicit.
- Final batched capture: **8,051 rows**, 12 contracts, 3,629 BRTI observations,
  **8,817,113 JSONL bytes**, peak queue **629 records / 270,651 input bytes**, zero
  unsaved accepted rows and no failure. Offline replay matched all 8,051 normalized
  rows. Different runs saw different traffic; this is not a controlled throughput
  benchmark, unlimited-capacity proof or trading-performance result.

The archive remains capped at 256 MiB by default with retention disabled. Observed
growth can reach that cap quickly; recording stops instead of deleting evidence.
Queue/storage/freshness limits are configurable local settings, not venue constants.

### Phase 4 blockers and next step

No credential blocker remained for the tested book and standard BRTI interfaces.
Historical CF entitlement beyond the current-values seed was not exercised. Unknown
publication times and suppressed revisions remain evidence limitations. Phase 2's
rule-verification blockers and the pre-existing collector timing failure remain
separate concerns. Await Phase 5's supplied scope; do not begin it automatically.

## Phase 3 checkpoint (historical)

Phase 3 implements reliable capture of one Coinbase Exchange BTC-USD spot feed.
See [spot capture and replay](spot-capture.md) for source documentation, record
versions, ordering/freshness semantics, commands, storage limits and retention.
At that checkpoint only Phase 3 was authorized; Phase 4 had not been supplied. Production
submission remains absent and economic performance remains unvalidated.

### Phase 3 scope and interfaces

- Reused `createCoinbaseStream` in
  `src/services/coinbase/stream/coinbaseStream.service.js`. Its optional `onCapture`
  callback records received text before JSON parsing, connection transitions and
  clock checks. Existing browser/collector consumers retain their default API and
  reconnect/backoff behavior. No additional exchange or derivatives stream is added.
- `src/services/coinbase/recording/coinbaseSpotNormalizer.utils.js` exports
  `createCoinbaseSpotNormalizer`: exact-decimal trade/ticker/book normalization,
  explicit currencies, source/event/receipt clocks, event IDs, duplicate/order/gap
  dispositions and freshness. Snapshot source timestamps remain unavailable; a
  duplicate does not make an old quote current. Coinbase is labeled a proxy.
- `spotRecording.service.js` in the same folder exports `createSpotRecorder` and
  `replaySpotRecording`: bounded ordered intake, failure/stop draining, deterministic
  normalization, and comparison against every recorded normalized result.
- `spotRecording.repository.js` exports `createSpotRecordingStore`,
  `readSpotRecording`, `getSpotRecordingStatus` and `pruneSpotRecordings`: immutable
  raw JSONL records, synchronized writes, separate atomic manifests, ownership locks,
  growth accounting and explicit retention of completed owned captures only. Default
  retention is disabled. A byte/queue cap stops capture instead of silently losing
  data. Incomplete/corrupt captures are retained and rejected for verified replay.
- `scripts/capture-spot.mjs`, `scripts/capture-spot.runtime.js`, and the
  `package.json` command `spot:capture` provide record/status/replay/prune. They do
  not load credentials, access the research database, start paid analysis or submit
  orders. README links the new command. Earlier-phase changes remain in place.
- Four workflow suites live in
  `src/features/MarketData/features/MarketFeeds/__tests__/SpotRecording`. All test
  observations are labeled synthetic. Real live evidence is separately identified
  below. The application stack and dependencies are unchanged.

### Phase 3 decisions and acceptance

Append-only applies to raw observation records. Mutable manifests track completion;
explicit retention deletes whole completed segments, never edits retained raw rows.
The archive has its own ownership marker so it cannot adopt a nonempty unrelated
directory. It uses the existing filesystem stack rather than adding a service or
extending Kalshi-only research tables with incompatible raw exchange data.

The selected channels do not provide a contiguous ticker sequence; a ticker
sequence jump alone is not classified as a missed trade. Trade IDs and heartbeat
markers detect gaps, and disconnections remain in the history. No backfill or
universal sequence-continuity guarantee is claimed. Source fractional times are
preserved for ordering/causality. An unavailable source timestamp stays null.

| Acceptance                                                               | Evidence                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse one supported spot feed                                            | Existing Coinbase BTC-USD connector; successful public live run below; no second connector or exchange added.                                                                                                                             |
| Trades and available bid/ask normalization, raw persistence and versions | `coinbase-spot-recording-v1`, `coinbase-spot-normalized-v1`, `coinbase-spot-observation-v1`; original text, explicit BTC/USD units, source and local clocks, IDs, ticker BBO and book levels; append-only replay/storage fixtures passed. |
| Duplicate/out-of-order/disconnect/stale behavior                         | Focused fixtures passed, including fractional-time ordering, duplicate freshness, heartbeat gaps, reconnect, queue failure and disk capacity.                                                                                             |
| Identical normalized replay                                              | All 460 rows of the completed live recording reproduced exactly; 437 contained observations. Synthetic disconnect/duplicate recordings also reproduced exactly.                                                                           |
| Connection/observation/delay/location view                               | `record --json` showed connecting → connected/fresh → stopped/unavailable, apparent quote delay, absolute location and pending/durable counts. `status` reads archive metadata without starting a socket.                                 |
| Growth and retention                                                     | Live archive grew to 5,857,825 raw bytes. Configurable caps and explicit completed-segment retention have passing isolated tests; no real historical recording was pruned.                                                                |

### Phase 3 observed checks

| Command/check                                                                                                           | Result                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm spot:capture --help`                                                                                              | Passed, exit 0; lists record/status/replay/prune and operating limits.                                                                                         |
| Focused `pnpm test --runTestsByPath` on NormalizeSpotFeed, StoreSpotRecording, RecordSpotFeed and RunSpotCommand        | **4 suites, 36 tests passed**, 3.244 seconds.                                                                                                                  |
| `pnpm spot:capture record --directory test-artifacts/phase3-live-20261106 --duration-seconds 20 --json`                 | Passed, exit 0. Public unauthenticated WebSocket, isolated storage, no working database.                                                                       |
| `pnpm spot:capture replay --file test-artifacts/phase3-live-20261106/5ceac979-85fd-4e24-a40f-2bdb5687b663.jsonl --json` | Passed, exit 0: 460 input rows, 437 observations, all normalized outputs matched.                                                                              |
| `pnpm spot:capture status --directory test-artifacts/phase3-live-20261106 --json`                                       | Passed, exit 0; completed manifest, counts, raw/directory bytes and retention status.                                                                          |
| `pnpm test`                                                                                                             | **42 suites, 323 tests passed**, 153.975 seconds, outside the Windows sandbox. Sandbox timing failures and the unchanged collector rerun are documented below. |
| `pnpm format:check`                                                                                                     | Passed; all matched files use Prettier style.                                                                                                                  |
| `pnpm build`                                                                                                            | Passed outside the Windows sandbox: Next.js 16.3.4/Turbopack compiled in 2.1 seconds and generated all 3 static pages plus existing dynamic routes.            |
| Browser                                                                                                                 | Not applicable: no rendered UI changed. The requested operational view is the tested CLI.                                                                      |

Live capture `5ceac979-85fd-4e24-a40f-2bdb5687b663` ran from
`2026-11-07T04:29:51.226Z` to `2026-11-07T04:30:11.283Z` (November 6 local).
It ended with 460 received/durably written rows, zero pending rows and no capture
error. Three periodic connected status samples had available current quotes; the
final stopped status had `latestQuote: null`. The reported quote delays of 404,
394 and 393 milliseconds are individual apparent receipt delays, not a latency
distribution or a pure network measurement. Raw bytes were 5,857,825; directory
bytes were 5,858,347 after close. The JSONL, manifest and CLI logs are ignored local
test artifacts, not checked-in historical data. Repeated CLI replay returned identical output and left
the raw file SHA-256 unchanged: `4D23C0ADC68A10A8D90E0E6C28158495D6FDEBB2BCA21CB958AD566CB79392E0`.

Intermediate implementation checks exposed a real Windows manifest replacement
race during simultaneous status reads; serialized status access and bounded rename
retry now pass the storage and recorder fixtures. The sandbox denied creating an
NTFS junction for a test; that one filesystem response is explicitly mocked while
the remaining retention tests use isolated real files. This does not claim an actual
junction integration check. An unchanged persistent-collector test failed both in the first full sandbox run
(41 suites/322 tests passed, one failed) and alone in the sandbox (16/17 passed).
Its injected fake stream never calls the changed connector. Its 50 immediate-task
polls can finish before the existing Windows atomic-rename retry delay, leaving
cleanup racing a pending write. The same unchanged suite passed outside the
sandbox (17/17, 3.563 seconds). This is consistent with an existing filesystem/timing
limitation; no collector code or unrelated test was changed.

File-content synchronization is provided; universal
power-loss durability and directory-entry synchronization are not claimed.

Documentation verification: 68 relative links across README, this status file and
`docs/spot-capture.md` resolve to existing targets; `git diff --check` passed. There
is no standalone typecheck script/compiler in the current JavaScript stack.

### Phase 3 blockers and next step

Phase 3 code is complete and its stated acceptance criteria passed. Live public
access and short-recording replay are verified. Long-running/high-burst
capacity, actual network reconnection under load and power-loss recovery are not
established by the 20-second run; their stated failure paths have fixture coverage.
No venue completeness, forecast accuracy, fill quality or profitability claim follows.
Phase 2's market-rule blockers and Phase 1's quote-dependent challengers remain
unchanged. Await the user's Phase 4 scope; do not start another exchange, model,
strategy or service.

## Phase 2 scope and results (historical)

Phase 2 implements the market specification and shared domain contracts. See
[Market specification and domain contracts](market-specification.md) for verified
sources, units, interfaces, settlement contingencies and the precise live blockers.
Phase 2 stopped at its supplied scope. Production submission
remains absent. Economic performance remains unvalidated.

### Phase 2 scope and decisions

- `parseKalshiMarket` now attaches `kalshi-market-spec-v1`; contract snapshots keep
  its provenance without changing archived settlement identity. Venue rules live in
  `MarketData/utils/kalshi/marketSpecification.utils.js`, separate from strategy.
- `src/utils/tradingDomain.types.js`, `tradingDomain.utils.js`, and
  `fixedPoint.utils.js` define and validate versioned specifications, observations,
  forecasts, quotes, orders, fills, positions and BUY/HOLD/SELL decisions. Exact
  decimal arithmetic uses BigInt internally and integer strings on the wire.
- Existing adviser, candidate and paper execution paths use
  `SimulatedTrading/utils/tradingSpecification.utils.js` to reject missing or
  conflicting rules and invalid increments. Legal prices come from metadata.
  Saved actionable guidance is suppressed when current rules are unverified.
- New paper records identify their revised calculation version. Private legacy
  replay paths preserve archived decisions, fills, account reports and official
  settlement; new execution never uses those paths to bypass verification.
- The independent probability model, stored research evidence, database schemas,
  deployment, risk policy and production transport were not rewritten. The Phase 1
  quote-dependent challenger finding remains unresolved and must be addressed only
  in an authorized later phase.

### Phase 2 checks and acceptance

Focused fixtures cover threshold equality, rounding boundaries, UTC/calendar/daylight-saving
transitions, invalid price and quantity increments, missing or conflicting rules,
local gaps versus source-agency outages, and legacy paper-account preservation.
Synthetic fixtures demonstrate code behavior, not venue fills or profitability.
All requested fixture acceptance cases passed. Phase 2 code is complete; live
rule verification remains blocked as listed below. No order submission was added.

| Check                                                       | Observed Phase 2 result                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused `pnpm test --runTestsByPath` on the six files below | **6 suites, 58 tests passed**, 5.676 seconds.                                                                                                                                                                                                                                                                                                                                                                                         |
| Full `pnpm test`                                            | **38 suites, 287 tests passed**, 145.853 seconds.                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm format:check`                                         | Passed: all matched files use Prettier style. Only changed files were formatted.                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm build`                                                | Passed with Next.js 16.3.4/Turbopack: compiled in 2.5 seconds, generated all 3 static pages and existing dynamic routes. Run outside the sandbox because Phase 1 established that the Windows sandbox blocks required junction creation. No new build failure.                                                                                                                                                                        |
| Browser layout                                              | Actual `AdvisorAction` server rendering with real compiled styles and explicitly synthetic blocked saved-BUY data: desktop 1391 CSS px and mobile 424 CSS px, no horizontal overflow; blocked status visible, no executable BUY. Requested viewports were 1280/390; the browser reported the actual CSS widths above. This was an isolated static fixture, not a full live-app or hydration check. Loopback server stopped afterward. |
| Public metadata/parser                                      | Passed, with the three expected blockers detailed below. No entitlement, signed transport, or fill claim.                                                                                                                                                                                                                                                                                                                             |
| Documentation/diff                                          | Node filesystem link check: 68 relative links, zero missing targets. `git diff --check` passed.                                                                                                                                                                                                                                                                                                                                       |
| Standalone typecheck                                        | No script/compiler exists in this JavaScript project. Runtime domain validation and Next build are the available checks; no new compiler was added.                                                                                                                                                                                                                                                                                   |

Focused command (PowerShell):

```powershell
pnpm test --runTestsByPath src/features/SimulatedTrading/features/TradingAdvisor/__tests__/MarketRules/VerifySettlementRules.test.js src/features/SimulatedTrading/features/TradingAdvisor/__tests__/DomainContracts/ValidateTradingRecords.test.js src/features/SimulatedTrading/features/TradingAdvisor/__tests__/MarketRules/RespectMarketRules.test.js src/features/SimulatedTrading/features/TradingAdvisor/__tests__/MarketRules/RespectQuantityIncrements.test.js src/features/SimulatedTrading/features/PaperTrading/__tests__/MarketRules/PreservePaperHistory.test.js src/features/SimulatedTrading/features/TradingAdvisor/__tests__/Reports/AdvisorReport.test.jsx
```

Intermediate failures were introduced during this phase and corrected: a floating
point divisibility assertion was replaced with an exact expected grid price; the
existing report test now expects blocked guidance without current rule evidence;
four new positive tests temporarily failed while the halfway evidence requirement
and fixtures were being updated (35 suites/267 tests passed in that intermediate
full run); one targeted run named the not-yet-written quantity regression file
and returned ENOENT while its other 49 tests passed. None is classified as a
pre-existing baseline failure. The final results above supersede these runs.

Phase 2 public metadata check: `2026-11-07T04:13:18.254Z`, market
`KXBTC15M-26NOV062315-15`. `parseKalshiMarket` returned `rulesVerified: true`
for existing forecast identity, `kalshi-market-spec-v1`, `actionable: false`,
`quantityRules: null`, and a conflicting specification with exactly these reasons:
`contract_expiration_schedule_conflict`, `unverified_quantity_rules`, and
`unverified_halfway_rounding`. The command exited 0, asserting those blockers.
This used two unauthenticated public GETs outside the restricted network sandbox;
it bypassed the signed application transport/limiter and touched no database.

Reproduce the read-only specification inspection in PowerShell (response contents
can change; a future receipt is not the original observation):

```powershell
$env:TSX_TSCONFIG_PATH = 'jsconfig.json'
@'
const { parseKalshiMarket, parseKalshiSeries } = require('./src/services/kalshi/kalshi.validation.js');
(async () => {
  const base = 'https://external-api.kalshi.com/trade-api/v2';
  const ticker = 'KXBTC15M-26NOV062315-15';
  const paths = ['/series/KXBTC15M', '/markets/' + ticker];
  const [series, market] = await Promise.all(paths.map(async path => {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }));
  const now = Date.now();
  const parsed = parseKalshiMarket(market, parseKalshiSeries(series), now);
  const spec = parsed.specification;
  console.log(JSON.stringify({ retrievedAt: new Date(now).toISOString(), urls: paths.map(path => base + path), ticker, rulesVerified: parsed.rulesVerified, specificationVersion: spec.version, verification: spec.verification, actionable: spec.actionable, quantityRules: spec.quantityRules, rounding: spec.rounding, timestamps: spec.timestamps, priceGrid: spec.priceGrid, rawQuantityRelatedFields: Object.keys(market.market).filter(key => /quantity|fractional|increment/.test(key)) }, null, 2));
  if (spec.actionable || !spec.verification.reasons.includes('unverified_quantity_rules') || !spec.verification.reasons.includes('unverified_halfway_rounding') || !spec.verification.reasons.includes('contract_expiration_schedule_conflict')) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
'@ | node -r tsx/cjs
```

### Phase 2 blockers and next step

Current public metadata omits verified market-specific quantity requirements; the
linked terms' administrative expiration time conflicts with the market metadata;
and a halfway-rounding convention has not been established. New actionable
recommendations are blocked until those rules have authoritative evidence. A
locally missing BRTI sample never becomes a source-agency outage or an official NO.
No authenticated order or entitled feed check is claimed.

At that checkpoint, the next step was to await the user's Phase 3 scope. Reuse these contracts and existing modules;
do not start a new service or another trading engine. Reconcile official rule
evidence before enabling a recommendation, and preserve the separate later need
to prove probability independence and positive net returns within accepted risk.

## Phase 1 baseline and scope (historical)

Audit date: **2026-11-06, America/Chicago**. Source baseline:
`ba6186e12f8e40163188b809c7fbc2e7e099f85e` on `main`; the working tree was clean before
this audit. Phase 1 changes documentation only. No strategy, model, account, order,
collector, dependency, or saved research record was changed.

The objective is positive net entry/exit returns after all applicable costs within
explicit risk limits. Forecast accuracy, calibration, replay agreement, successful
builds, and synthetic-test profits do not establish that objective. **Performance
is not validated.** Production order submission remains absent from the audited
integration; adding it is outside this phase.

Status meanings:

- **Verified existing:** a narrowly stated capability has observed supporting evidence.
- **Partial:** substantive implementation exists, but a requirement or acceptance check remains.
- **Missing:** the inspected project has no implementation for the stated capability.
- **Blocked:** required scope, access, data, or other acceptance evidence is unavailable.

## Roadmap register

The roadmap has 15 phases. Phases 1–4 have been supplied. Rows 5–15
are blocked on their definitions, **not claims that their implementations are
missing**. The capability inventory below can be matched to those phases when
their scopes and acceptance criteria arrive; it is not an invented phase sequence.

| Phase | Status            | Scope, evidence, and next step                                                                                                                                                                                        |
| ----- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Verified existing | Repository audit and implementation baseline documented here; check results and limitations below. Documentation complete; economic performance unverified.                                                           |
| 2     | Partial           | Code complete and offline acceptance passed (38 suites/287 tests, formatting, build); live rule verification blocked on quantity, halfway rounding and expiration evidence. Performance unvalidated.                  |
| 3     | Verified existing | Code complete and phase acceptance passed: one Coinbase BTC-USD feed, 36 focused tests, 323 full tests, build/format and a 20-second live capture with exact replay. Long-run capacity and profitability unvalidated. |
| 4     | Verified existing | Read-only market/book/BRTI ingestion implemented; fixtures and live discovery, entitlement, snapshot agreement, final result and completed replay observed. Long-run capacity and profitability unvalidated.          |
| 5     | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 6     | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 7     | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 8     | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 9     | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 10    | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 11    | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 12    | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 13    | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 14    | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |
| 15    | Blocked           | Definition and acceptance criteria not supplied.                                                                                                                                                                      |

## Phase 1 module map and data flow

Paths below link to existing owners; function names identify the integration points
to extend. Preserve these boundaries and the separate paper accounts.

| Layer                          | Existing files and functions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Flow and responsibility                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend assembly              | [page.jsx](../src/app/page.jsx), [TradingDashboard.jsx](../src/app/_dashboard/TradingDashboard.jsx), [store.js](../src/state/store.js): `TradingDashboard`, `makeStore`                                                                                                                                                                                                                                                                                                                                                                      | Next.js App Router page composes MarketData, Forecasting, ForecastResearch, and SimulatedTrading; Redux and RTK Query share market/archive state. The Research modal owns the adviser and separate paper report.                                                                                                                                                  |
| Live market inputs             | [useMarketData.js](../src/features/MarketData/hooks/useMarketData.js); [coinbase.service.js](../src/services/coinbase/coinbase.service.js): `fetchCoinbaseTicker`, `fetchCoinbaseCandles`; [coinbaseStream.service.js](../src/services/coinbase/stream/coinbaseStream.service.js): `createCoinbaseStream`; [derivativesStream.service.js](../src/services/derivatives/derivativesStream.service.js): `createDerivativesStream`                                                                                                               | Coinbase BTC-USD candles/ticker/trades/book and optional Bybit BTCUSDT linear trades, liquidations, and ticker enter freshness-checked observations. Bybit sequence continuity is explicitly not verifiable. Missing observations remain missing.                                                                                                                 |
| Contract and settlement source | [kalshi.service.js](../src/services/kalshi/kalshi.service.js): `fetchKalshiMarkets`, `fetchKalshiMarket`, `fetchKalshiBenchmark`; [kalshi.validation.js](../src/services/kalshi/kalshi.validation.js): `parseKalshiSeries`, `parseKalshiMarket`, `parseKalshiBenchmark`; [contract.utils.js](../src/features/MarketData/utils/kalshi/contract.utils.js): `getKalshiContract`, `getKalshiOutcome`                                                                                                                                             | Series and market rules identify KXBTC15M, target, deadline, comparison, and final result. Saved contract identity excludes mutable quotes/results. Unknown rule templates fail closed. Official finalized outcomes, not local prices, settle forecasts and paper positions.                                                                                      |
| Kalshi transport               | [kalshi.transport.js](../src/services/kalshi/kalshi.transport.js): `createKalshiTransport`; [rateLimit.policy.js](../src/services/kalshi/rateLimit/rateLimit.policy.js): `getKalshiReadResource`; [rateLimit.repository.js](../src/services/kalshi/rateLimit/rateLimit.repository.js): `createKalshiRateLimitRepository`                                                                                                                                                                                                                     | Allowlisted GET requests, optional signed reads, bounded responses/timeouts, discovered account limits/costs, shared durable limiter. No order-write resource.                                                                                                                                                                                                    |
| BRTI stream/history            | [benchmarkStream.service.js](../src/services/kalshi/benchmarkStream/benchmarkStream.service.js): `createKalshiBenchmarkStream`; [benchmarkStreamHistory.utils.js](../src/services/kalshi/benchmarkStream/benchmarkStreamHistory.utils.js): `parseBenchmarkStreamValue`; [benchmarkHistory.service.js](../src/services/kalshi/benchmarkHistory/benchmarkHistory.service.js): `createBenchmarkHistoryService`                                                                                                                                  | Entitled raw BRTI observations supplement REST history. One-second samples and receipt-time causality are retained; rolling averages are not substituted for raw settlement observations.                                                                                                                                                                         |
| Probability calculation        | [forecast.utils.js](../src/features/Forecasting/features/LiveEstimates/utils/kalshi/forecast.utils.js): `getKalshiForecast`; [researchForecast.utils.js](../src/features/ForecastResearch/utils/researchForecast.utils.js): `getResearchForecast`                                                                                                                                                                                                                                                                                            | Bitcoin observations plus contract target/deadline produce settlement probabilities; compatible learned/challenger/pattern models can modify them. The quote-dependent challenger exception is detailed below.                                                                                                                                                    |
| Recording and journal          | [useCheckpointForecasts.js](../src/features/Forecasting/features/CheckpointForecasts/hooks/useCheckpointForecasts.js), [useForecastJournal.js](../src/features/Forecasting/features/ForecastJournal/hooks/useForecastJournal.js), [useKalshiSettlement.js](../src/features/Forecasting/features/ForecastJournal/hooks/useKalshiSettlement.js)                                                                                                                                                                                                | Live estimates are distinct from immutable scheduled calls. Checkpoints use absolute deadlines; missed captures are not backfilled. A browser writer lock coordinates tabs; official results are retried after expiry/reload.                                                                                                                                     |
| Evidence and replay            | [researchExperiments.utils.js](../src/features/ForecastResearch/utils/researchExperiments.utils.js): `createResearchInputSnapshot`, `replayResearchInputSnapshot`; [evidenceStorage.utils.js](../src/features/ForecastResearch/features/EvidenceCollection/utils/evidenceStorage.utils.js): `appendEvidenceRows`; [researchOutbox.utils.js](../src/features/ForecastResearch/features/EvidenceCollection/utils/researchOutbox.utils.js): `queueForecastSnapshots`                                                                            | Inputs, versions, candidate models, and expectations are captured for replay. IndexedDB stores evidence/upload backlogs; localStorage stores the journal/recorder preferences. Acknowledged batches clear only corresponding queued rows.                                                                                                                         |
| Backend and storage            | [research.repository.js](../src/services/research/research.repository.js): `getResearchDatabaseConfiguration`, `createResearchRepository`; [research.schema.js](../src/services/research/research.schema.js): `initializeResearchSchema`; [research.connection.js](../src/services/research/research.connection.js); [research.http.js](../src/services/research/research.http.js): `assertResearchRequest`                                                                                                                                  | Dynamic Node API routes validate bounded payloads and protect non-loopback access. SQLite/libSQL stores immutable hashed evidence/input records, model/label records, versioned account/trial state, and heartbeats; optional Turso uses the same repositories.                                                                                                   |
| Collector and workers          | [collect-research.mjs](../scripts/collect-research.mjs), [collect-research.runtime.js](../scripts/collect-research.runtime.js): `runCollectorCommand`; [runResearchCollector.js](../src/features/ForecastResearch/features/EvidenceCollection/runResearchCollector.js): `runResearchCollector`; [collect-research.background.js](../scripts/collect-research.background.js): `createCollectorBackgroundTasks`; [collectorControl.service.js](../src/services/research/collectorControl/collectorControl.service.js): `startManagedCollector` | Continuous acquisition, checkpoint capture, official outcomes, forward labels, and bounded worker analysis. Atomic state writes, lock ownership, durable outboxes, and restart logic exist. Managed control is local; hosted operation needs an always-on process.                                                                                                |
| Learning/evaluation            | [learning.service.js](../src/services/research/learning.service.js): `createLearningService`; [training.utils.js](../src/features/ForecastResearch/features/ModelLearning/utils/training.utils.js): `splitLearningWindows`, `trainOutcomeCandidate`, `evaluateShadowCandidate`; [statistics.utils.js](../src/features/ForecastResearch/features/ModelLearning/utils/statistics.utils.js): `scoreProbabilities`                                                                                                                               | Version/source-specific chronological training, calibration, later testing, prospective qualification, and degradation monitoring; probabilistic scores remain separate from trading returns.                                                                                                                                                                     |
| Trading/execution boundary     | [purchaseValue.service.js](../src/services/kalshi/purchaseValue/purchaseValue.service.js): `createKalshiPurchaseValueService`; [kalshiPurchaseValue.utils.js](../src/features/SimulatedTrading/utils/kalshiPurchaseValue.utils.js): `getPurchaseFeeEstimate`; [tradingAdvisor.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/utils/tradingAdvisor.utils.js): `getTradingAdvice`, `getTradingExecutionQuote`, `simulateTradingExecution`                                                                                  | Probability plus current book, fee metadata, account state, and risk policy produces an entry/exit plan. A later book observation drives simulated fills. Kalshi prices/depth/fees belong here.                                                                                                                                                                   |
| Accounts and trials            | [advisorLedger.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/utils/advisorLedger.utils.js): `applyAdvisorAdvice`, `applyAdvisorEvent`; [tradingAdvisor.repository.js](../src/services/research/tradingAdvisor/tradingAdvisor.repository.js): `saveAdvice`, `claimExecutionAttempt`, `saveExecution`, `saveSettlement`; [tradingPolicyTrials.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/features/Experiments/utils/tradingPolicyTrials.utils.js)                                                 | Versioned account transactions reserve/release capital, allocate partial-exit cost basis, and prevent repeated execution/settlement. Registered strategies use separate simulated accounts and prospective comparisons. The older [PaperTrading](../src/features/SimulatedTrading/features/PaperTrading/utils/paperTrading.utils.js) experiment remains separate. |

In sequence: external observations → validated, timestamped inputs → baseline/model
probability → immutable checkpoint/input archive → official outcome → evaluation.
Separately: probability + book/fees + account/risk → advice → reserved intent → one
later simulated execution opportunity → ledger/valuation → net-return comparison.

## Existing capability acceptance inventory

These statuses are narrower than full roadmap-phase acceptance. An implemented
capability should be accepted using the listed evidence before considering a rebuild.

| Capability                                           | Status            | Evidence already present                                                                                                                                                                        | Remaining acceptance evidence                                                                                                                       |
| ---------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forecast/journal/learning/collection UI workflows    | Partial           | Real feature composition and existing workflow suites; observed suite result below.                                                                                                             | No desktop/mobile browser or current external-feed integration check in this audit.                                                                 |
| Immutable checkpoint recording, recovery, and replay | Partial           | Browser suites and `PersistentCollector/RunPersistentCollector.test.js` exercise capture, restart, missed deadlines, hash failures, archive retries, locks, and replay using controlled inputs. | Real SQL/upstream/worker boundary integration and a complete prospectively captured event.                                                          |
| Official settlement handling                         | Partial           | `ForecastJournal/__tests__/Settlement/ObserveForecastResults.test.jsx` exercises delayed official results, equality/YES, retries, and reload.                                                   | Adviser cash/position settlement acceptance tests and a real finalized event; one active contract's rules parsed successfully, as recorded below.   |
| Baseline and ordinary learned probability model      | Partial           | Implemented BRTI/proxy model and source-separated, chronological learning; live-input and full-learning suites exercise these paths.                                                            | Empirical calibration/out-of-sample evidence and global Kalshi-quote independence.                                                                  |
| Global independence from Kalshi trading prices       | Partial           | Raw baseline and ordinary learned features are independent of bid/ask probabilities.                                                                                                            | Promotable quote-dependent challengers violate the requested invariant; see below.                                                                  |
| Fee-aware entry/exit and portfolio risk              | Partial           | Actual sizing, limits, valuation, cooldown, drawdown, reservation, and delayed-fill logic.                                                                                                      | Explicit approved risk contract; exact fee/tick fixtures; current core trading workflow acceptance coverage.                                        |
| BUY/HOLD/SELL with YES/NO and position context       | Partial           | Position-aware internal buy/sell/hold/wait and reason fields exist.                                                                                                                             | Display currently uses BUY/HOLD/REDUCE/EXIT/NO TRADE and UP/DOWN; normalize display without rewriting saved records.                                |
| Durable simulated order/account state                | Partial           | Transactional recomputation, account versions, unique execution/settlement keys, single attempt claims, partial fills, and cancellation of remainder.                                           | Balance conservation, restart/idempotency, stale/future-book, risk-rejection, and partial-sale/settlement tests.                                    |
| Prospective strategy evaluation                      | Partial           | Frozen strategy registration, separate accounts, matched per-contract net returns, confirmation, monitoring, and rollback code.                                                                 | Untouched real chronological data, credible fill/cost assumptions, serial-dependence-aware uncertainty, and accepted promotion routing.             |
| Production order submission disabled                 | Verified existing | Audited Kalshi transport is GET-only with a read-resource allowlist; no production/demo submission adapter was found.                                                                           | Retain this boundary and add regression evidence if execution integrations are later introduced. This is source evidence, not a live account audit. |
| Demo/live exchange order lifecycle                   | Missing           | Local paper intents exist, but no exchange accepted/open/cancel-request/uncertain/reconciliation lifecycle was found.                                                                           | Only implement if explicitly requested by a later phase; production submission must remain disabled.                                                |
| Positive net returns within agreed risk limits       | Blocked           | No historical or prospective performance dataset was inspected, and no profit result is asserted.                                                                                               | Reproducible real evidence, costs and fill validation, explicit risk acceptance, and an untouched prospective evaluation.                           |

No substantive unfinished scaffold or placeholder service was found in the audited
paths. Null/unavailable forecasts, insufficient-data gates, unknown fee rejection,
and refusal to run a managed collector on a hosted server are intentional behaviors.
Missing exchange execution and unverified empirical performance are separate gaps.

## Prediction inputs, evaluation, and price independence

`getKalshiForecast` estimates the average of 60 final-minute BRTI observations using
correlated log-price moments and a moment-matched lognormal approximation. Observed
samples and missing-sample uncertainty are treated separately. Native BRTI supplies
price/volatility/history when available; Coinbase is a labeled proxy when it is not.
The proxy cannot determine settlement. Coinbase trades/book supply optional spot
pressure; Bybit supplies optional futures flow, liquidations, and basis context.
Chart MACD, RSI, and drawings are display tools, not inputs to this probability path.

The ordinary learned schema in
[features.utils.js](../src/features/ForecastResearch/features/ModelLearning/utils/features.utils.js)
uses baseline log odds, target distance/time remaining, returns, acceleration,
range, spot volume/spread/flow/depth, optional derivatives, and availability flags.
It does not use Kalshi quote probabilities. Contract targets and BRTI observations
are legitimate settlement inputs; they are distinct from Kalshi trading prices.

**The complete application does not enforce price independence.**
`getResearchForecast` can apply an activated challenger to displayed/captured
probabilities. [marketBlendForecast.utils.js](../src/features/ForecastResearch/utils/marketBlendForecast.utils.js)
`getMarketResearchVariants` blends the model with contemporaneous Kalshi midpoint;
`market-blend` is promotable in
[challengerModel.utils.js](../src/features/ForecastResearch/features/ModelLearning/utils/challengerModel.utils.js).
[directionalReversal.utils.js](../src/features/ForecastResearch/features/ModelLearning/utils/directionalReversal.utils.js)
`getDirectionalReversalFeatures` includes `marketFlipLogOdds` and
`marketQuoteAvailable`; training and inference supply Kalshi probability. The
`market-only` variant is a comparator, not an allowed active challenger kind.
The database's selected model was not inspected: this is an allowed path, not a
claim that a quote-dependent model is active now. Adviser
[advisorForecast.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/utils/advisorForecast.utils.js)
also records market-blend/execution-midpoint reconciliation; shadow diagnostics
must remain distinguishable from the probability used to decide a trade.

Existing evaluation controls worth retaining:

- [evaluation.utils.js](../src/features/ForecastResearch/features/ModelLearning/utils/evaluation.utils.js)
  `collectLearningEvents`, `hasContemporaneousInputs`, and `getVerifiedLearningRows`
  reject conflicts, require contemporary inputs and matching official labels, and
  group overlapping/repeated checkpoints into independent events.
- `selectLearningPipelineRows` separates baseline generations and native/proxy
  sources. `splitLearningWindows` creates chronological train/calibration/test
  partitions and purges later groups exposed to earlier labels published too late.
- `trainOutcomeCandidate` fits regularized logistic models and later Platt
  calibration. `evaluateShadowCandidate` freezes prospective cohorts rather than
  replacing missing or unfavorable observations with later favorable ones.
- `scoreProbabilities` reports Brier score, log loss, calibration/ECE, accuracy,
  coverage, and interval coverage. Matched current-side/Kalshi-midpoint comparisons
  are evaluation baselines; their presence alone is not model leakage.
- Challenger and pattern modules implement development/confirmation, ablations,
  prospective cohorts, degradation monitoring, and retirement. Strategy trials
  evaluate simulated net returns separately from probability scores.

Existing versions include `kalshi-brti-average-v3`, `kalshi-brti-derivatives-v2`, and
ordinary `outcome-logistic-kalshi-v2`; legacy records retain their versions. Proxy
uncertainty floors, pressure weights, sample minimums, cohort lengths, and statistical
screening cutoffs are implementation assumptions, not externally validated trading
constants. Test fixtures are synthetic/controlled evidence, not historical performance.

## Trading, risk, and execution findings

1. **Retain the current decision and ledger modules.** `getTradingAdvice` manages
   held positions before new entries and compares fee-adjusted sale/holding values.
   `getTradingExecutionQuote` consumes asks for buys and bids for sells. The ledger
   reserves cash/inventory and realizes proportional basis on partial exits.
2. **Fills remain a proxy.** `simulateTradingExecution` uses a causally later book,
   an existing 2–15 second execution window, and fixed adverse slippage. V2 takes
   one partial-fill opportunity and cancels the remainder. Displayed depth is not
   an actual exchange fill; queue priority, market impact, and latency calibration
   are unvalidated. The separate six-minute PaperTrading experiment has different
   one-contract/all-or-none rules and must not be merged silently.
3. **Risk controls exist, but the user's risk contract is not yet specified.**
   [advisorPolicy.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/utils/advisorPolicy.utils.js)
   `getAdvisorEntryRisk` and `getAdvisorOpportunityBudget` constrain exposure,
   drawdown, reserves, sizing, and cooldowns. Stale/missing net-liquidation valuation
   blocks entry. `createTradingAdvisorPolicy` defaults `dailyLossLimitEnabled` to
   `false`; setup exposes allocation/risk level rather than every limit. A daily-loss
   cap must not be assumed mandatory or enabled. Existing slippage/reserve/cooldown
   values are experimental and need explicit acceptance or validation. Drawdown and
   daily-loss gates block new entries; they do not submit stops or force immediate
   liquidation of held positions.
4. **Action presentation needs a small later change.**
   [advisorPlan.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/utils/advisorPlan.utils.js)
   `getAdvisorPlanHeading` and
   [advisorDisplay.utils.js](../src/features/SimulatedTrading/features/TradingAdvisor/utils/advisorDisplay.utils.js)
   currently expose REDUCE/EXIT/NO TRADE and UP/DOWN. Map existing advice to
   BUY/HOLD/SELL plus explicit YES/NO and held/flat context. Flat HOLD must mean no
   entry; preserve historical internal actions and account records.
5. **Fees are implemented, with a bounded supported scope.**
   [purchaseValue.validation.js](../src/services/kalshi/purchaseValue/purchaseValue.validation.js)
   `parseKalshiPurchaseFees` verifies current series/event overrides and rejects
   unsupported schedules. `getPurchaseFeeEstimate` uses scaled integer arithmetic,
   per-level microdollar fee rounding, and a direct-account rounding estimator. Exact
   multi-level, fractional, sell-credit, and per-order accumulator equivalence need
   acceptance fixtures. Maker execution is not modeled. Unknown broker charges make
   net purchase value unavailable. Fee provenance currently lacks a persisted
   effective document version.
6. **Tick handling is incomplete.** The adviser uses whole-cent order limits,
   which current official documentation says are valid across price structures,
   but does not ingest market `price_ranges`. The separate PaperTrading limit
   helper searches $0.0001 increments; legality depends on the actual market grid.
   Ingest market precision metadata into existing contract/limit helpers before
   claiming order-price compatibility; do not replace one guessed tick with another.
7. **Trial code is not proof of profit.** Existing confirmation sizes and approximate
   standard-error screening are policy choices. Reports acknowledge dependence and
   changing regimes. Accept promotion/rollback and account routing with workflow
   tests, then validate performance on untouched real observations. The optional
   [advisorLanguageModel.service.js](../src/services/research/tradingAdvisor/advisorLanguageModel.service.js)
   is a disabled-unless-configured paid shadow integration, not required core
   infrastructure; it was not invoked.

## Baseline checks

Runtime observed: Node `v24.20.0`, pnpm `11.25.0`. `package.json` declares pnpm
`11.19.0`, Node `>=20.9.0`, Next `16.3.4`, React `19.2.8`, Jest `30.5.1`, and
Prettier `3.9.6`. No dependency install or version change was performed.

| Command/check                                                           | Observed result                                                                                                                                                                         | Classification                                                                                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `git status --short`; `git branch --show-current`; `git rev-parse HEAD` | Clean initial tree; `main`; baseline hash above.                                                                                                                                        | Baseline recorded before documentation edits.                                                                                                |
| `node --version`; `pnpm --version`                                      | Versions above; both succeeded.                                                                                                                                                         | Available toolchain, with pnpm declaration/runtime difference recorded.                                                                      |
| `pnpm test` (initial attempt alongside build)                           | Exit 1 before tests: Jest could not open `.next/build/package.json` (`ENOENT`).                                                                                                         | Audit scheduling/file-generation race; not evidence of a pre-existing behavioral failure. Retried serially.                                  |
| `pnpm test` (serial retry)                                              | Exit 0; 33 suites, 231 tests passed; 0 snapshots; 131.898 seconds.                                                                                                                      | Full offline regression passed. No behavioral change required.                                                                               |
| `pnpm format:check`                                                     | Exit 0; all matched files use Prettier style, both initially and after documentation edits.                                                                                             | Baseline and final formatting passed.                                                                                                        |
| `pnpm build` (restricted sandbox)                                       | Exit 1: Turbopack could not create the `.next/node_modules/@libsql/client-…` junction; Windows access denied, error 5.                                                                  | Environment permission failure before any source edit; resolved by the normal-permission run below.                                          |
| `pnpm exec next build --webpack` (restricted sandbox)                   | Exit 1: `EPERM` creating `.next/types/app/api`.                                                                                                                                         | The existing fallback was also permission-blocked; no source fix applied.                                                                    |
| `pnpm build` (outside restricted sandbox)                               | Exit 0; Next 16.3.4 Turbopack compiled and generated pages/API routes successfully.                                                                                                     | Production build passed with normal filesystem permissions.                                                                                  |
| Standalone typecheck/lint                                               | Not run: no corresponding package scripts, TypeScript source/tsconfig, or JS `checkJs` configuration found.                                                                             | Build printed its TypeScript stage, but this is not evidence of comprehensive static checking for this JavaScript project. No tooling added. |
| Documentation formatting/links and final diff                           | `pnpm exec prettier --write docs/BOT_IMPLEMENTATION_STATUS.md README.md` succeeded; all 56 relative links in this file resolve; final diff contains only this file and the README link. | Documentation checks passed; no runtime source changed.                                                                                      |
| Public market/parser smoke                                              | Direct `node -r tsx/cjs -e` command below exited 0; one actual market, orderbook and applicable fee response parsed successfully.                                                       | Narrow live public-data evidence; no signed transport/database/collector run.                                                                |
| Browser desktop/mobile, entitled feeds and database checks              | Not run.                                                                                                                                                                                | No UI changes. Live application/report initialization can migrate the working archive; use isolated storage for future integration checks.   |
| Historical/prospective return analysis                                  | Not run.                                                                                                                                                                                | No real performance dataset or accepted fill/cost/risk contract was evaluated.                                                               |

The current inventory contains 33 test files. Tests use jsdom/fake IndexedDB,
controlled fetch boundaries, synthetic archives, temporary state files, and an
in-memory SQL adviser report repository. The persistent collector suite rejects
network access; the directional-study subprocess explicitly names its isolated
database. These are offline implementation checks.

Especially useful acceptance suites include `LiveEstimates` availability, inputs,
purchase value and settlement details; `CheckpointForecasts` recording/scheduling;
`ForecastJournal` settlement/persistence; `EvidenceCollection` replay/recovery; and
`ModelLearning` full learning, challenger validation and model application. See
the feature-owned `__tests__/` folders linked through the module map. Only two
TradingAdvisor test files currently exist: reports and experiment reports. They
exercise saved balances, unsupported policies, read immutability, and separate
research funding, **not** the core execution/accounting lifecycle. No numerical
coverage percentage was measured.

## Current commands and operational boundaries

Use the existing scripts in [package.json](../package.json) and the setup in
[README.md](../README.md):

```sh
pnpm install
pnpm dev
# Existing Windows fallback:
pnpm exec next dev --webpack

pnpm test
pnpm format:check
pnpm build
# Existing Windows build fallback:
pnpm exec next build --webpack
pnpm start
```

Run tests and builds sequentially because Jest's file scan can race with build
output changes under `.next`. `pnpm test --runTestsByPath <existing-test-file>` selects a
focused workflow. `pnpm test:coverage` exists but was not needed for this baseline.
`pnpm start` serves an already successful production build.

The existing integration/analysis entry points are:

```sh
pnpm kalshi:check
pnpm research:collect --once
pnpm research:collect --report
pnpm research:collect
pnpm research:collect --paper-trading --trading-advisor
pnpm research:compare-directions --help
pnpm research:compare-patterns --help
```

These were **not run** during Phase 1. `kalshi:check` makes authenticated upstream
reads when configured and may write limiter state. Collector/report initialization
can create/migrate the research database, and continuous collection may train models.
The optional trading flags (also supplied by local UI managed start) can advance
paper accounts or invoke an enabled paid shadow candidate. Bare `research:collect`
leaves those trading services disabled. A `--once`
step does not demonstrate a complete 15-minute outcome. Hosted continuous operation
requires an always-on worker; local collector controls do not provide hosted scheduling.

For future integration checks, use a new isolated `TURSO_DATABASE_URL=file:...`,
`KALSHI_RATE_LIMIT_DATABASE_URL=file:...`, and recorder `--state-file` together;
changing only `--state-file` does not isolate the database. Keep paid LLM work
disabled. The defaults are `data/bitcoin-research.db` and
`data/kalshi-rate-limits.db`; do not use them for routine verification. In particular,
`initializeResearchSchema` can call `migrateResearchToKalshi`, which deletes legacy
non-Kalshi records. Even a report read can trigger initialization.

Credential values and the working archive were not inspected. BRTI entitlement is
**unverified**, not known absent. The current selected model, real sample counts,
saved positions, returns, and live connector health are likewise unknown.

## Official-source register

All sources below were retrieved on **2026-11-06 (America/Chicago)**. REST references
apply to Kalshi Trade API `/trade-api/v2`; WebSocket references apply to the named
channel. An unversioned web page is identified by retrieval date, not an invented
release. Public market responses were also checked with the existing pure parsers;
this does not test the full application, signed transport, or database integration.

| Official source                                                                                                                                                                                                                                        | Applicable version/date                                                                           | Relevance and observed limitation                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [KXBTC15M series response](https://external-api.kalshi.com/trade-api/v2/series/KXBTC15M)                                                                                                                                                               | Response `last_updated_ts`: `2026-10-29T18:50:05.14347Z`; metadata ID `CRYPTO15M-bulk-2026-04-20` | Observed fifteen-minute frequency, CF Benchmarks source, CRYPTO terms link, quadratic series fee with multiplier 1.                                                                                      |
| [CRYPTO contract terms](https://assets.kalshi.com/contract_terms/CRYPTO.pdf)                                                                                                                                                                           | Two-page document; no printed revision identified                                                 | General final-minute index averaging, settlement and comparison definitions. Generic terms do not replace the selected market's primary/secondary rules.                                                 |
| [Get Market](https://docs.kalshi.com/api-reference/market/get-market)                                                                                                                                                                                  | Current unversioned Trade API v2 documentation                                                    | Reference for market metadata, primary/secondary rules and price fields.                                                                                                                                 |
| [Observed market](https://external-api.kalshi.com/trade-api/v2/markets/KXBTC15M-26NOV062300-00)                                                                                                                                                        | Retrieved `2026-11-07T03:49:18.526Z`; market updated `2026-11-07T03:45:00.660794Z`                | Existing parser accepted this active contract's BRTI-average, equality/YES and two-decimal rules. Market grid recorded below.                                                                            |
| [Observed book](https://external-api.kalshi.com/trade-api/v2/markets/KXBTC15M-26NOV062300-00/orderbook?depth=100) and [event fee changes](https://external-api.kalshi.com/trade-api/v2/events/fee_changes?event_ticker=KXBTC15M-26NOV062300&limit=100) | Retrieved `2026-11-07T03:49:18.526Z`; Trade API v2                                                | Existing parsers accepted the book and series fee; no event overrides were returned, with pagination complete at that time.                                                                              |
| [Get Market Orderbook](https://docs.kalshi.com/api-reference/market/get-market-orderbook)                                                                                                                                                              | Current unversioned Trade API v2 documentation                                                    | Book contains YES/NO bids; opposite-side bids imply asks. This supports the existing complementary-side conversion, not assumed fills.                                                                   |
| [Fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf)                                                                                                                                                                                        | Printed effective date July 7, 2026                                                               | General taker quadratic fee and multiplier, with separate maker treatment and direct-balance alignment. Runtime series/event applicability and exact per-fill accounting remain acceptance requirements. |
| [Fee Rounding](https://docs.kalshi.com/getting_started/fee_rounding)                                                                                                                                                                                   | Current unversioned documentation                                                                 | Signed revenue, microdollar trade fees, direct/non-direct balance precision, per-order rounding accumulator and rebates; compare existing estimators with these mechanics.                               |
| [Fixed-Point Representation](https://docs.kalshi.com/getting_started/fixed_point_migration)                                                                                                                                                            | Printed update November 5, 2026                                                                   | Dollar/quantity precision and market `price_ranges` as the legal price grid. Fractional-fill support depends on market capability; whole-cent prices remain valid across documented structures.          |
| [CF Benchmarks REST passthrough](https://docs.kalshi.com/cfbenchmarks/rest-passthrough)                                                                                                                                                                | Current unversioned documentation                                                                 | Authenticated, entitlement-controlled raw index access; no separate CF API key required. This audit did not test entitlement.                                                                            |
| [CF Benchmarks Value Feed](https://docs.kalshi.com/websockets/cfbenchmarks-value)                                                                                                                                                                      | Current `cfbenchmarks_value` channel                                                              | Raw index frames coexist with rolling averages. Existing implementation deliberately consumes raw one-second observations.                                                                               |
| [Rate Limits and Tiers](https://docs.kalshi.com/getting_started/rate_limits)                                                                                                                                                                           | Current unversioned documentation                                                                 | Token budgets/costs and authoritative account endpoint-cost discovery; preserve existing shared limiter instead of hard-coding example request rates.                                                    |

The code stores normalized contract identity and a fee-source URL, but not a complete
immutable rules/fee document version record. Capture selected-market rules, precision,
effective fees and retrieval metadata alongside future evaluation inputs. The current
parser accepted the specific live contract below; this does not establish compatibility
with all future contracts or guarantee an official outcome has been observed.

### Public response smoke check

At `2026-11-07T03:49:18.526Z` (November 6 in America/Chicago), unauthenticated GETs
and the existing pure parsers accepted market `KXBTC15M-26NOV062300-00`:

- `parseKalshiMarket`: `supported: true`, `rulesVerified: true`,
  `comparison: greater_or_equal`, `roundDigits: 2`.
- `parseKalshiPurchaseBook`: 100 parsed ask levels on each side. This is response
  validation, not a fill or retained full-depth historical dataset.
- `parseKalshiPurchaseFees`: available quadratic series schedule, multiplier 1;
  event changes returned an empty array with an empty cursor. Applicability was
  observed only at that receipt time; the parser's 30-second validity was not extended.

The market response was updated at `2026-11-07T03:45:00.660794Z` and described a
03:45–04:00 UTC event. Its `price_ranges` used $0.001 steps in the 0–0.10 and
0.90–1.00 bands and $0.01 steps in the middle band (`tapered_deci_cent`). This is
one observed market grid, not a new global constant. Fractional-trading capability
was not established. The strict parser accepted the rules comparing the final-minute
BRTI average with the opening reference average, including equality for YES.

This smoke check bypassed the app's signed transport and limiter and did not open
either local database. Initial web-tool market-list requests were unavailable, and
the restricted shell could not resolve the API host; the same public source was
retrieved outside that network restriction. An initial `tsx -e` wrapper returned no
diagnostic output and was not counted as evidence; the direct Node invocation below
exited 0 and printed the explicit results above.

<details>
<summary>Exact public parser command used (PowerShell)</summary>

```powershell
node -r tsx/cjs -e 'const {parseKalshiSeries,parseKalshiMarket}=require("./src/services/kalshi/kalshi.validation.js"); const {parseKalshiPurchaseBook,parseKalshiPurchaseFees}=require("./src/services/kalshi/purchaseValue/purchaseValue.validation.js"); const base="https://external-api.kalshi.com/trade-api/v2"; const ticker="KXBTC15M-26NOV062300-00"; const event="KXBTC15M-26NOV062300"; const paths=["/series/KXBTC15M","/markets/"+ticker,"/markets/"+ticker+"/orderbook?depth=100","/events/fee_changes?event_ticker="+event+"&limit=100"]; (async()=>{const [series,market,book,fees]=await Promise.all(paths.map(async path=>{const response=await fetch(base+path,{signal:AbortSignal.timeout(20000)}); if(!response.ok)throw new Error(path+": HTTP "+response.status); return response.json()})); const now=Date.now(); const parsedMarket=parseKalshiMarket(market,parseKalshiSeries(series),now); const parsedBook=parseKalshiPurchaseBook(book,ticker,now); const parsedFees=parseKalshiPurchaseFees(series,fees,event,now); console.log(JSON.stringify({retrievedAt:new Date(now).toISOString(),sources:paths.map(path=>base+path),contract:{ticker:parsedMarket.ticker,supported:parsedMarket.supported,rulesVerified:parsedMarket.rulesVerified,comparison:parsedMarket.comparison,roundDigits:parsedMarket.roundDigits},book:{yesAskLevels:parsedBook.yesAsks.length,noAskLevels:parsedBook.noAsks.length},fees:parsedFees,eventFeeChanges:fees.event_fee_changes.length,eventFeeCursor:fees.cursor},null,2)); if(!parsedMarket.supported||!parsedFees.available)process.exitCode=1})().catch(error=>{console.error(error.message);process.exitCode=1})'
```

</details>

## Phase 1 proposed changes and dependencies (historical)

These are proposed bounded work items to match to the user's next phase, not
authorization to implement them now. No new service or dependency is justified by
this audit.

1. **Concrete starting point: enforce the independent forecast boundary.** Reuse
   `getResearchForecast`, `challengerModel.utils.js`, and existing model-application
   tests. Define/version which candidate types may produce the independent outcome
   probability; keep market-blend/directional-reversal research available separately
   without activation into that probability. Prove quote invariance across supported
   active model types and preserve saved probabilities and model artifacts.
2. **Establish source and money contracts before evaluating returns.** Reuse
   `parseKalshiMarket`, `parseKalshiPurchaseFees`, `getPurchaseFeeEstimate`, and the
   existing limit helpers. Turn observed selected-market rules/precision/event-fee
   provenance into reproducible fixture and capture contracts. Add checks for tie/finalization, signed
   fees, fractional depth, ticks, and cost conservation; fix only demonstrated gaps.
3. **Agree the risk/action contract, then test existing execution.** Specify risk
   limits and what costs are included. Adapt the display helpers to BUY/HOLD/SELL
   with YES/NO/position context. Exercise existing service/repository entry → intent
   → partial/no fill → HOLD/SELL → official settlement, including stale/future inputs,
   limits, account versions, repeated processing and restart. Preserve frozen policies
   and separate accounts; do not build a second trading engine.
4. **Accept collection before performance claims.** After source contracts and offline
   lifecycle checks pass, verify entitled feeds and one complete event using isolated
   storage, then collect immutable prospective observations with measured gaps and
   replay checks. Reuse collector/outbox/worker code. Existing passing fixture suites
   can accept their stated behaviors without requiring a rewrite.
5. **Evaluate net returns only after those dependencies.** Reuse matched strategy
   trials; preregister costs, risk limits, cohorts and acceptance rules. Measure
   realistic fill uncertainty and chronological out-of-sample net results. Neither
   simulated winning fixtures nor calibrated probabilities can accept profitability.
   Demo order integration is an optional later scope, not a prerequisite to making
   the existing offline engine testable. Production submission stays disabled.

Phase 1 acceptance: actual files/functions and data flow are identified, existing
checks are recorded, implemented behavior is separated from unverified evidence,
and a concrete starting point is defined. Full mapping of later phase acceptance
remains blocked on the missing phase definitions. Full live integration, BRTI
entitlement, realistic fills, accepted risk limits and positive net performance
remain unverified. Phase 1 stopped at this checkpoint; the subsequently supplied
Phase 2 scope and results are recorded at the beginning of this document.

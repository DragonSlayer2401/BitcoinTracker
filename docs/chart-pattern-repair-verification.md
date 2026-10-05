# Chart-pattern repair verification — 2026-10-04

The repaired lane remains prospective and shadow by default. No live model was activated,
no archived evidence was rewritten, and these checks do not establish improved profitability.

## Changes and versions

- `utils/patterns/chartPatterns.utils.js`: causal breakout scanning continues after returns;
  latest breakout and latest failed event retain their own ranges and timestamps. Target
  duration requires a boundary anchor and reports sample and interval coverage separately.
- `utils/patterns/patternHistory.utils.js` and `patternConfig.js`: normalization distinguishes
  the 16-minute minimum, configured 31 candles/30 returns, actual inputs and the separate
  operating-range validation history. The numerical volatility formula was not shortened.
- `utils/learning/patternEvidence.utils.js`: training and evaluation share whole-contract
  identity/outcome rejection. Missing optional legacy receipt metadata is not a contradiction.
- `utils/learning/patternCohorts.utils.js` and `utils/patternEvaluation.utils.js`: durable
  registration before contract start determines shared opportunities; all compared accounts
  start with identical capital. Broader production history is explicitly separate.
- `utils/learning/patternPromotion.utils.js`, `patternModel.utils.js` and the research services:
  explicit promotion requires fixed prospective evidence, transactionally revalidated from
  storage. Production inference, schema validation, fallback and retirement are supported.

Paths above are relative to `src/features/BitcoinTracker/`, except the research services under
`src/services/research/`. The full semantics and lifecycle are in [chart-patterns.md](chart-patterns.md).

| Contract                        | Current version                                        |
| ------------------------------- | ------------------------------------------------------ |
| Detector                        | `brti-patterns-v2`                                     |
| Feature snapshot                | `deadline-pattern-features-v5`                         |
| Model artifact                  | `pattern-logistic-kalshi-v2`                           |
| Comparison report               | `kalshi-pattern-evaluation-v2`                         |
| Paper comparison / registration | `kalshi-pattern-paper-v2` / `kalshi-pattern-cohort-v2` |
| Independent book observation    | `pattern-paper-observation-v2`                         |
| Promotion evidence              | `pattern-promotion-v1`                                 |
| Collector code                  | `kalshi-collector-2026-10-04-patterns-v5`              |

Historical detector v1, feature v4 and model v1 retain their original positional schema and
replay semantics. Current fitting excludes historical detector/feature versions. Regression
tests exercise legacy replay, artifact scoring, storage validation and mixed-version rejection.

## Verification commands and results

Repository commands were run through their local executables because the package-manager
launcher is not on this shell's PATH. The documented Windows webpack build was used.

```powershell
node node_modules/jest/bin/jest.js --runInBand
node node_modules/prettier/bin/prettier.cjs --check .
node node_modules/next/dist/bin/next build --webpack
```

- Full Jest: **139 suites, 3,141 tests passed**.
- Repository formatting: passed. Git whitespace check: passed.
- Production webpack build: passed, including page generation and build traces.
- Targeted regressions cover all five reported numerical/evidence defects, legacy compatibility,
  independent books with skipped/unavailable production forecasts, restart/write recovery,
  successful isolated-database promotion, rejected activation, production journal/replay,
  baseline fallback, monitoring after shadow replacement and retirement.
- No visual UI was changed. Tests of activation used isolated in-memory databases only.

## Graceful live rollout

The active archive was verified as
`C:\Users\jacob\OneDrive\Documentos\Projects\BitcoinTracker\data\bitcoin-research.db`.
Before restart, the managed collector was PID **4856**, owned by the existing app server PID
**31084**, started at **2026-10-04T21:08:25.462Z**. Its effective runner options were
`--paper-trading --trading-advisor`. At **22:30:04.563Z**, the archive still contained zero
pattern snapshots and zero independent pattern books; its maximum evidence sequence was 10269.

After verification passed, the existing collector-control API requested graceful IPC shutdown.
The old child exited, `pendingRows` was zero, and both ownership locks were released by their
owners. No lock was manually deleted. The same managed runner then started PID **24536** at
**22:30:28.163Z**, with the same database, options and recorder identity. A process check found
one managed collector. Its heartbeat reported the current code version and fresh input feeds.

The first new forecast was captured at **22:33:00.948Z** (17:33:00.948 CDT), sequence **10275**,
for `KXBTC15M-26OCT041845-45`, at the 12-minute checkpoint. Stored capture, recording and feature
cutoff timestamps agree. Detector v2 and feature v5 are present and available; normalization
records 31 candles/30 returns and target duration records 300 observed seconds with an anchor.
The content-hash-checked saved replay reproduces the original pattern and production outputs.
No pattern artifact exists yet, so the empty frozen candidate prediction list is expected.

The next captures at **22:36:00.834Z** and **22:39:00.942Z** were stored as sequences **10276**
and **10277**. All three new saved input snapshots passed content-hash verification and exact
replay. The existing receipt audit still identifies missing candle batch receipt metadata and
aggregated spot/futures history; replayability does not imply a complete raw exchange-message log.

At the six-minute checkpoint, the independent archive stored these v2 stages for the same contract:

| Stage        | Request time (UTC) | Stored observation time (UTC) | Contents                                                         |
| ------------ | ------------------ | ----------------------------- | ---------------------------------------------------------------- |
| Claim        | —                  | 22:39:00.969                  | Forecast captured 22:39:00.942, feature v5, empty candidate list |
| Initial book | 22:39:00.977       | 22:39:01.044                  | 100 YES ask levels and 100 NO ask levels, fee metadata           |
| Delayed book | 22:39:03.162       | 22:39:03.233                  | 100 YES ask levels and 100 NO ask levels, fee metadata           |

The two book observations are **2,189 ms** apart, within the configured 2–15-second interval.
Production's corresponding paper decision was **skipped**, reason
`insufficient_conservative_edge_or_depth`. This directly verifies independent book capture
without a production entry. The heartbeat reported `failureCode: null` and
`lastFailureAt: null`. The collector was left running.

## Fixed archive comparison

The pre-rollout read-only check used **2026-10-04T22:12:29.734Z**, sequence **10258**. It reports
zero conflicting contracts, zero matched registered suites and 475 explicitly unregistered
paper opportunities. All 2,024 contemporaneous decisions lack historical pattern snapshots;
none were backfilled. Broader production history is marked incomparable to candidate profits.

The post-rollout comparison fixes **2026-10-04T22:39:31.876Z**, sequence **10277**:

```powershell
node --conditions=react-server scripts/research/compare-patterns.mjs --as-of 2026-10-04T22:39:31.876Z --max-sequence 10277
```

It reports three available pattern snapshots, 2,030 explicitly missing historical snapshots,
zero rejected contracts, one independent book observation bundle, and zero registered suite
cohorts. All 477 observed paper opportunities are explicitly unregistered; historical production
returns remain separate and incomparable to a candidate. Initial/delayed book totals also include
legacy production-selected observations and must not be mistaken for independent coverage.
Repeating the exact as-of/sequence command produced byte-identical JSON (SHA-256
`12418f1495760f0786e8747bedad3df877bc64f9fe301d729d06ff392b901664`).

## Eligibility, activation and remaining evidence

At the fixed post-rollout audit there are **zero stored pattern artifacts and zero model
activations**. No pattern is eligible for promotion. The first three captures concern one
unsettled contract; sufficient independent training and prospective evaluation evidence does not
yet exist. No prediction or candidate was fabricated to fill that gap. Positive promotion and
matched-account equivalence are established by regression tests, not by live profit results.

The requested implementation and live forecast/book checks are complete. Predictive benefit,
profitability and future promotion remain unproven and require new evidence under the unchanged
gates. No commits or pull requests were created.

The local audit files are retained under the ignored `data/maintenance/` directory. They are
verification outputs, not training inputs or production configuration.

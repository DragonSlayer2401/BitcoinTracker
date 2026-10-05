# Numerical chart-pattern research

Pattern features are captured alongside the existing forecast. The production probability,
publication rules, trading participation rules and official settlement target are unchanged.
Seven regularized candidates run in shadow. A pattern is an input to probability estimation;
it is neither an independent vote nor an entry requirement.

## Ownership and evidence

- `src/features/BitcoinTracker/utils/patterns/` owns the frozen detector configuration,
  causal BRTI history preparation and numerical pattern calculations.
- `utils/learning/patternFeatures.utils.js` owns current v5 and historical v4 feature snapshots.
  `patternModel.utils.js` and `patternTraining.utils.js` own the shadow artifacts and fitting.
- `utils/learning/patternEvidence.utils.js` owns contract-wide evidence conflict checks;
  `patternCohorts.utils.js` owns durable suite registration and prospective enrollment.
- `utils/patternEvaluation.utils.js` scores saved predictions and compares paper accounts.
- `src/services/research/patterns/` archives initial and delayed executable books independently
  of any candidate's prediction, entry decision or existing production trade.
- Tests belong in the BitcoinTracker `__tests__` folder. Existing PaperTrading utilities remain
  the owner of fee, liquidity, limit, latency, slippage and bankroll calculations.

The prediction target remains the official final-minute BRTI settlement average against the
exact Kalshi BTC 15-minute target. The exchange's verified final result is the label. Observed
crossings, Coinbase prices, candle closes and temporary BRTI excursions cannot settle a contract.

## Inputs, timing and detector definitions

`brti-patterns-v2` freezes current engineering assumptions in `patternConfig.js`. These thresholds
have not been selected by historical profitability. Changing them requires a new detector
version and a new prospective cohort.

Benchmark candles contain one minute of BRTI observations with all 60 required seconds. The
existing benchmark chart coverage/conflict checks are reused. Only candles completed by the
captured minute boundary are eligible. An incomplete minute or gap interrupts contiguous
candle history; no forward-filled candle is introduced. Receipt/amendment timestamps must also
be known by the capture cutoff. Up to 120 minutes of causal history is considered.

When individual receipt/amendment timestamps are absent, samples are assumed present in the
contemporaneously captured payload. Their earlier availability is not independently receipt-verified.
Compression metadata separately records the price availability and optional pressure observation/
receipt times; family and snapshot availability includes the latest accepted input.

| Family                     | Numerical definitions                                                                                                                                                                                                                                                                                                                            | Required history and units                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Range breakout/failure     | Compare observations in each evaluated candle with the high/low of its preceding 5 or 15 completed candles. Search the last five completed minutes for the latest event; retain its original reference range, direction, maximum excursion, start and actual return time. A failure is recorded only after an observed return inside that range. | 10 or 20 contiguous minutes for the event search; direction −1/0/+1, distance in minute standard deviations, elapsed seconds. Volatility normalization requires the existing benchmark volatility history (at least 16 minutes).                     |
| Target crossings/rejection | Cent-round each observed BRTI value and treat equality as YES. Count transitions between consecutive observed seconds, recrossings within uninterrupted segments, observed seconds on each side and excursions. Rejection direction is the side reached by an observed recrossing. A gap resets recrossing continuity.                           | Last five minutes through the completed-minute cutoff; counts, observed seconds, excursions in USD, signed direction. Partial observations remain partial coverage.                                                                                  |
| Compression/expansion      | Median one-minute log range over three completed minutes divided by the median of the preceding ten. Divide the newest completed candle's log range by the three-minute median. A directional close beyond the compressed high/low is flagged when compression ≤0.65 and expansion ≥1.5.                                                         | 14 contiguous completed minutes; separate compression/expansion ratios and signed breakout direction. Zero denominators are unavailable. Optional pressure agreement is breakout direction × signed imbalance.                                       |
| Trend after pullback       | Measure a five-minute preceding close-to-close trend; require strength ≥0.5 trend standard deviations. Look for one to three consecutively opposing closes and a subsequent directional resumption. Record pivot confirmation only when the first opposing candle has completed.                                                                 | Ten contiguous completed minutes plus available volatility history; trend direction/strength, pullback depth as fraction of prior move, duration in minutes, resumed fraction of pullback. No earlier pivot time acquires information learned later. |
| Candle rejection/engulfing | Measure absolute body and upper/lower wicks as fractions of total range, signed body direction, signed lower-minus-upper wick rejection. Opposite-direction bodies engulf when the new body encloses the previous body and extends strictly beyond at least one boundary.                                                                        | One completed candle for shape, two for engulfing. Zero-range candles have zero fractions/direction and unavailable close position; flat bodies do not engulf. Body/range USD and close location remain descriptive metadata.                        |

The existing benchmark range and volatility calculations are reused. Close position already
exists in the baseline feature vector and is not added again as a learned pattern feature.
Likewise there is no duplicate generic momentum or generic volatility feature.

The v2 breakout search processes every observation after a return, including later observations
in the same candle. Direction, excursion and elapsed time describe the **latest started event**,
whether active or already returned. Failed-breakout direction independently describes the
**most recent observed return**. For a range of 99,999–100,001, the sequence 99,998 → 100,000 →
100,010 therefore records a latest upward breakout and an earlier failed downward excursion.
Repeated attempts are ordered by observation time. Each event retains the reference range from
before its evaluated candle; crossing a minute boundary never changes an existing event's range.
Details expose the latest event, latest failed event, active event and event/failure counts.

Target sample coverage and duration coverage are distinct. Exactly 300 samples inside
`(cutoff − 5 minutes, cutoff]` cover all expected sample slots but measure only 299 adjacent
one-second intervals without the starting anchor. Complete duration requires that anchor and
all 300 uninterrupted intervals. Family completeness requires both full sample and duration
coverage. Isolated samples and interior gaps never imply elapsed time or a crossing.

Normalization metadata distinguishes the 16 completed candles required for availability,
the configured 31-candle/30-return normalization lookback, and the separate 120-minute history
validation window. Captures report the actual candles/returns used, their window, first and
last contributing price timestamps and actual price span. The oldest contributing candle may
supply only its close, so the price span is at most 30 minutes. Earlier relevant observations
can change normalization while the latest 16 minutes remain identical; the calculation was
not shortened to match the former incomplete metadata.

Every feature definition specifies its family, units and lookback; snapshots retain capture and
availability times, observed/expected seconds, family availability/completeness and detailed
event confirmation times. `null` means unavailable; zero means observed absence. Family
availability means at least one usable numerical input, not necessarily complete family coverage.

BRTI supplies index prices only: no volume is fabricated. Optional execution pressure is accepted
only with a named `coinbase` or `bybit` source and causal fresh observation/receipt timestamps
(maximum age five seconds). Absence of pressure removes only its optional confirmation input.
Coinbase/Bybit price and volume sources remain identified in the existing baseline snapshot.

## Schema, capture and regularized challengers

`deadline-pattern-features-v5` is a separate optional `patternLearningFeatures` snapshot. The
original v2/v3 `learningFeatures` arrays and historical coefficient positions are preserved.
The v5 snapshot clones that baseline schema and appends, at model fitting time, 31 numerical
pattern values and their 31 availability flags. Missing values encode as zero with availability
zero. Seconds are divided by 900, minutes by 15 and USD excursions by target/1000; other values
retain their units, then all numerical encodings are bounded to [−8,8]. Training alone fits
normalization. Historical decisions are never silently passed through the detector again.

Current fits pair `brti-patterns-v2`, `deadline-pattern-features-v5` and
`pattern-logistic-kalshi-v2`. Historical v1 detector/v4 snapshots/v1 artifacts retain their
original ordering and explicit legacy replay behavior. Training accepts only the current
compatible generation; it never pools old and new detector semantics. Reports preserve old
frozen probabilities as descriptive evidence instead of recalculating them with v2 detectors.

`chartPatterns`, `patternLearningFeatures` and `patternShadowPredictions` are captured before
outcomes. Saved predictions include candidate identity, suite identity, model version, training
time, feature cutoff, probability and whether the fitted model was used. An unsupported input
state retains the exact original baseline probability, with the fallback recorded. A model must
have been trained strictly before the contract started to issue a prospective prediction.

The fixed suite is:

1. `combined`: baseline features plus all five pattern families.
2. `baseline-control`: the same regularized fit using baseline features only.
3. `without-rangeBreakouts`.
4. `without-targetCrossings`.
5. `without-compressionExpansion`.
6. `without-trendPullback`.
7. `without-candles`.

Family ablation removes both its numerical values and its missingness indicators. All variants
use the same rows, weights, chronological partitions and L2 penalty (0.02). All checkpoints in
overlapping contracts stay in the same partition, with total fitting weight one per independent
group. Boundaries purge labels that were not available before the next partition. Calibration
uses a later separate partition. At least 120 training, 60 calibration and 60 evaluation
independent contracts are required, with both outcomes represented. Fitting-time holdout scores
are explicitly exploratory even when the archived inputs themselves were collected prospectively.

Before fitting, splitting, calibration or class counts, a shared validator rejects every capture
of a contract with conflicting identity or official result/settlement price across checkpoints.
Nested official identity contradictions are also rejected. Rejected contracts, affected captures
and reasons are reported. Absent redundant top-level fields in legacy records (for example a
null confirmation timestamp) remain missing metadata rather than a contradictory label; a
provided value that disagrees with the verified outcome is a conflict. Archived rows are unchanged.

Pattern artifacts are created in shadow. Neither favorable holdout scores, pattern
confirmation nor this report can activate a model. Promotion still needs independent future
contracts, directional improvement, probability reliability, Brier improvement, sufficient model
use and coverage under the existing activation requirements. Paper profitability requires its
own credible prospective evidence after costs; forecast accuracy is not a profit result.

## Promotion, production inference and retirement

`pattern-promotion-v1` provides an eligibility evaluation for the predeclared `combined`
`pattern-logistic-kalshi-v2` candidate using v5 features and the v2 detector. Ablations, the
fitted baseline-control and historical v1 artifacts cannot enter production through this path.
Shadow collection remains the default. These are implemented requirements, not a statement
that a current candidate is eligible or has been activated.

Eligibility freezes the first 120 enrolled independent future contract slots after durable
registration of the complete seven-model suite. Calendar-based selection happens before
inspecting inputs, predictions or outcomes. Every selected slot must have a verified official
outcome and all seven original predictions must match the stored artifacts and captured input
snapshot. Missing inputs and terminal failures cannot be replaced with later, more favorable
contracts. Valid raw-baseline fallbacks remain in the denominator.

The frozen cohort must satisfy all of these requirements:

- At least ten official YES and ten official NO outcomes, with full matched coverage of all
  120 enrolled slots.
- At least 60 contracts where the combined model actually changes the raw-baseline probability;
  a fitted model returning the same probability does not count as a learned adjustment.
- Strict directional accuracy and Brier improvement over contemporaneous production, the raw
  baseline and the fitted baseline-control on the same contracts. Paired 95% uncertainty
  intervals must exclude no improvement for both accuracy and Brier score.
- No deterioration in calibration error or directional call coverage against those references.
  Accuracy must also improve over the current-side benchmark beyond paired uncertainty.
- When at least 30 matched contemporaneous market probabilities exist, the candidate must not
  underperform that market reference in either Brier score or directional accuracy.
- The persisted activation history must identify the same production incumbent throughout
  the cohort and at the activation decision. A change of incumbent cannot reuse the old trial
  as evidence against its replacement.

Fitting-time holdouts never count as prospective promotion evidence. Paper profitability is
not an activation criterion in this probability-model lane, and eligibility does not establish
trading profitability. The independently collected matched paper cohorts remain the separate
place to assess after-cost trading effects.

Activation is an explicit operator action through the learning service's
`activatePatternCandidate({ modelId, now })`. It first evaluates the saved evidence and returns
`activated: false` when requirements fail. On eligibility it calls the repository's
`activatePatternModelArtifact`. The repository re-reads and revalidates the exact persisted
suite, registration, prospective evidence and incumbent history within the write transaction.
Caller-supplied passing metrics are insufficient. Scheduled collection and status reports do
not automatically activate eligible pattern candidates; a retired model cannot be reactivated.

An activated model can be consumed by production inference. The saved activation and exact
feature version, original baseline version, contract target/deadline and supported input domain
must all match. Unsupported or missing inputs preserve the raw-baseline forecast. Applied
predictions carry the v5 feature schema and separate baseline schema in their learning metadata.
The calibrated model estimates the official YES probability; it does not fabricate a settlement
price interval, and its output explicitly marks such intervals unavailable.

Post-activation monitoring uses the latest 120 complete matched independent contracts and
requires at least 60 real learned adjustments. It applies the existing deterioration tolerances:
0.005 Brier score and five percentage points of directional accuracy, using paired uncertainty.
Monitoring continues from the immutable production prediction and model identity even after
a newer shadow suite replaces the seven shadow prediction slots. When deterioration is
established, read paths stop serving the model; the leased learning cycle records its retirement.
Read-only status/report requests neither activate replacements nor write retirement records.

## Evaluation procedure

Continue the normal collector to capture new features. Enable its existing `--paper-trading`
option to also archive independent pattern execution observations. At the six-minute checkpoint,
the observation service freezes the forecast before fetching an initial two-sided executable
book. It requests a delayed book after at least two seconds, regardless of signal or trade
intent, within the same 15-second maximum execution window used by paper trading. Immutable
claims precede requests. Interrupted/failed attempts remain missing instead of retrying for a
more favorable book. This option performs no real account orders.

Run the read-only comparison:

```sh
node --conditions=react-server scripts/research/compare-patterns.mjs --database data/bitcoin-research.db
node --conditions=react-server scripts/research/compare-patterns.mjs --as-of 2026-10-04T12:00:00Z --max-sequence 10000
```

The JSON output freezes an evidence sequence and an explicit as-of time, validates archived
content hashes and does not write storage or fit models. The sequence bounds forecast/outcome
evidence; book stages and saved models are bounded by as-of time. It includes:

- Prospective probabilities exactly as originally issued, with no feature/prediction backfill.
- Family availability, missing snapshots, verified outcomes and independent sample counts.
- Matched production comparisons, combined versus fitted baseline-control, and combined versus
  each family ablation on the same capture and fitted suite. Combined is also compared with the
  raw probability saved in the original baseline snapshot. Production may include an activated
  existing learned model; the raw baseline and newly fitted baseline-control are distinct references.
- Brier score, log loss, directional accuracy, neutral-aware accuracy, calibration bins/error,
  coverage, model-use subsets and baseline fallback counts.
- Deterministic paired bootstrap sensitivity intervals with blocks of 1, 4 and 8 independent
  chronological contract groups. Sparse data produces unavailable intervals, not certainty.
- Each saved artifact's exploratory holdout results in a separate section.
- A separate simulated paper account per variant with the same $100 initial bankroll,
  one-contract sizing, fee schedule, one-cent adverse slippage, five-point probability reserve,
  three-cent minimum net edge, $5 maximum open risk and $5 daily loss limit.

`kalshi-pattern-evaluation-v2` and `kalshi-pattern-paper-v2` use
`kalshi-pattern-cohort-v2` registrations for matched comparisons. A suite becomes available only
when all seven coherent artifacts have been durably saved; its registration time is the maximum
immutable `model_artifacts.saved_at`. Contract start must be strictly later than registration.
The next fully registered suite closes the previous cohort for contracts starting later than
that registration. Registration times, suite and schema identity, cohort ID, boundaries,
enrolled counts, excluded earlier/later opportunities and prediction/book coverage are explicit.

Enrollment uses only information available before each contract starts. It does not consult
outcomes, eventual pattern availability, candidate entry intent or whether a book request will
succeed. All compared accounts—production, raw baseline, combined, fitted baseline-control and
ablations—start from identical capital at that cohort boundary. An earlier production loss cannot
affect the later matched production account. Missing predictions remain recorded skips, valid
baseline fallbacks remain forecasts, and failed/missing execution books remain no-fills. Terminal
evidence conflicts remain visible as rejected enrolled opportunities instead of disappearing.

The JSON `paper.cohorts` array contains matched account results. `paper.productionHistory` is a
separate broader production/raw-baseline history explicitly marked incomparable to candidate
profits. Without a qualifying pre-start registration there is no matched paper cohort, even if
later stored predictions have an earlier training timestamp. Probability `cohorts` likewise
retain independent opportunity denominators before outcome/feature filtering; the top-level
all-frozen `comparisons` remain descriptive and are not prospective promotion evidence.

The first capture per contract/checkpoint is selected before examining feature availability.
Probability evaluation then uses the existing calendar-selected representative of each
overlapping contract group; repeated checkpoints do not inflate sample size. Ablations cannot
be mixed between separately fitted suites. Baseline fallback predictions remain in primary
metrics, with actual model-use results shown separately.

Paper evaluation replays every scheduled observed opportunity, including unresolved contracts,
using only initial and delayed executable depth/fees. Quote midpoints never create fills. A
missing initial book is a recorded skip; missing delayed coverage is no-fill. Settlements free
cash only at the archived official publication time. Reports show opportunities, trade attempts,
fills, skips and reasons, missing books, net profit, fees, return and realized drawdown. Drawdown
excludes unrealized position values; delayed snapshot fills do not establish actual exchange
executions or queue priority. Ineligible candidates are recorded as unavailable forecasts.

If independent observations do not exist, the CLI can read legacy paper book archives. Their
delayed books were sampled only when production attempted entry. The report explicitly labels
that selection limitation; it is not an independent candidate profitability trial. Preserve the
same as-of/sequence when comparing runs, and collect adequate new independent observations
before drawing conclusions about profitability or promotion.

## Verification

`ChartPatterns`, `PatternLearning`, `PatternEvaluation`, capture/storage integration and pattern
book-collection tests cover causal boundaries, availability, schema compatibility, frozen
evidence, chronological partitions and after-cost paper behavior. Run the owning tests, then
the full suite, Prettier and production build as described in `docs/TESTING.md`. Synthetic tests
establish software behavior; prospective market evidence must establish predictive or trading
benefit separately.

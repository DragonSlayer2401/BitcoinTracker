# Kalshi outcome learning and reversal risk

The fixed call is published after a bounded observation period even when its direction is weak. Model promotion rules govern replacing the math; they do not impose another confidence gate on each fixed call.

## What a reversal means

The outcome is the official KXBTC15M YES/NO result for the saved contract. YES includes equality under the final-minute BRTI average rule. A temporary price crossing is not the scored event.

The live probability of the opposite outcome is the estimated risk that the saved fixed call loses. The estimate uses the same saved target and deadline. Benchmark price, or the explicitly labeled Coinbase proxy, establishes the current side. Observed pressure changes, momentum and liquidity explain the risk; they are not separate calibrated probabilities.

## Evidence

The automatic recorder follows real contracts with checkpoints at 12, 9, 6, 3 and 1 minute remaining. A capture must occur in its five-second window with valid contemporaneous inputs. Missing checkpoints remain metadata rather than reconstructed forecasts.

Each decision saves original probabilities, model identity, contract, horizon, market features and any matching fresh Kalshi quotes. Official finalized outcomes are joined later. Journal-only records can be audited but cannot supply missing model-training inputs.

Multiple checkpoints and collectors for the same event do not count as independent outcomes. Training assigns a total weight of one per independent event across its captured checkpoints. Older learning lanes use a calendar-determined representative checkpoint per event. Current challengers evaluate each checkpoint separately, choosing one capture per independent event at that checkpoint and grouping overlapping windows.

Non-Kalshi evidence and model artifacts are rejected. The one-time Kalshi-only migration removes the previous archive records and browser queues before uploads resume.

## Early learning

The baseline can earn a small learned correction before there is enough evidence for the full
model. Early artifacts use `outcome-early-kalshi-v1`. This model has one input: the settlement
model's original probability. It fits an intercept and slope to its log odds, learning whether
those percentages tend to be too high, too low or too confident. Price dynamics and trade
pressure still enter through the original settlement calculation. This does not train a new
multi-feature direction model on a small sample.

Early training requires at least 40 independent events, including at least eight YES and eight
NO outcomes. Version and price-source compatibility rules still apply. A trained candidate is
experimental and has no influence on displayed predictions while it collects prospective
evidence. Candidate probabilities must be recorded at capture time, before the outcome is known.

The first 40 eligible future events form a fixed validation group, with at least 20 actual
learned adjustments required. Missing predictions cannot be reconstructed from later data.
Repeated analysis cannot keep extending an unsuccessful group until a favorable result appears.
Promotion requires a measured reduction in probability error against the settlement baseline,
supported by a paired 95% uncertainty interval, without reducing directional accuracy. The
report also shows the current-side benchmark. Reaching the event count alone does not approve it.

An approved early model blends 20% of its learned correction into the baseline and limits the
final change to at most five percentage points in either direction. Unsupported inputs keep the
baseline. The system continues checking future outcomes, using a minimum of 40 monitoring
events, and can suspend an adjustment whose performance deteriorates. Retraining requires at
least 20 newly recorded independent events. The full model's larger validation requirements
remain in place, and it can take over after independently passing them.

Research data identifies the model currently in use, early training and future-validation
progress, observed accuracy and Brier scores when available, and any suspension. A candidate,
an active early adjustment and an active full model are different states. All scores describe
recorded outcomes, not guaranteed future accuracy. Existing fixed calls keep the probabilities
captured when they were saved.

## Full model training and activation

Current calculations use `kalshi-brti-average-v3`, or `kalshi-brti-derivatives-v2` when the derivatives policy is present. Learned artifacts retain `outcome-logistic-kalshi-v2`; their feature snapshots use `deadline-reversal-features-v2`, or the corresponding v3 schema with derivatives inputs. Features describe target distance, time remaining, recent returns, volatility, ranges, Coinbase volume, executed flow, spread, liquidity and availability. Native BRTI history supplies price movement when available. Missing exchange volume/spread have their own availability indicators; neither is invented for an index. Logistic fitting uses jStat-based shared statistics.

Each snapshot identifies its baseline model version, reference price source and price-history source. Training, calibration, later testing and prospective comparisons use the same combination. BRTI history, BRTI price with Coinbase history, and the full Coinbase proxy are separate groups. Once native BRTI evidence is recorded for the current generation, temporary proxy fallbacks do not switch its training group back. An older or incompatible learned artifact cannot adjust the new model. Historical v1 calls remain in audit reports with their original outcomes; they cannot supply v2 training features retrospectively.

The current experiment release is recorded as `kalshi-ablation-v5`. It preserves V4's baseline
versions and native BRTI feature pipeline, while adding a separately recorded directional candidate.
Earlier baseline generations remain separate learning pipelines; their outcomes cannot be relabeled
as evidence for the new math. New candidates need compatible fitting data and fresh prospective validation under the
existing minimums. Earlier snapshots, probabilities, artifacts and outcomes are not rewritten;
V1–V4 snapshots retain their archived calculation and replay behavior.

Chronological partitions use 50% of independent window groups for training, 25% for calibration and 25% for later testing. Groups are purged at boundaries when earlier outcomes were not yet available. Normalization and fitting do not use later partitions.

Current release minimums are:

- 120 training, 60 calibration and 60 test windows, with class coverage checks.
- At least 30 actual candidate uses on the test set.
- 120 subsequent shadow windows, including at least 60 candidate uses.

These are evidence requirements, not promises that this amount of data is sufficient to discover an edge. Candidates must improve accuracy over the current model and the current-side benchmark, reduce probability error, and avoid worse calibration. When at least 30 matched Kalshi quote observations exist, performance is also compared against their contemporaneous YES bid/ask midpoint. Prospective comparisons and uncertainty checks must pass before activation.

Artifacts include their supported horizon, target-distance and feature-availability domain. Unsupported inputs fall back to the settlement model. Conditional final-minute forecasts with observed average samples also retain the settlement model instead of applying a classifier trained for a different information state.

New models affect subsequent calculations. Saved fixed probabilities and official outcomes remain immutable.

## Prospective challengers

Six alternatives share `forecast-challenger-v2` but have distinct frozen artifact IDs and policy
versions. The existing production calculation remains in use until a candidate passes future
validation. Saved artifacts and V1–V4 experiment snapshots retain their original replay semantics;
new captures use `kalshi-ablation-v5`, which records the incumbent separately from a replacement
of the same family. V1 candidates are retained for audit and are not promoted by the new lane.

| Candidate            | What it tests                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Half pressure        | Half of the existing future directional pressure shift, with liquidation variance retained.                                                                                                                                                                                                  |
| Faster decay         | A 30-second pressure half-life before the existing directional caps.                                                                                                                                                                                                                         |
| Kalshi market blend  | A YES bid/ask midpoint blend: 15% weight at 15 minutes, rising to at most 50% near expiry. Quotes must match the contract, be at most 15 seconds old and have at most a 10-cent spread.                                                                                                      |
| Reversal             | A six-input logistic fit using baseline odds, recent return, acceleration, executed pressure, price response and input availability. It predicts one YES probability; NO remains its complement.                                                                                             |
| Forward pressure     | A six-input regularized regression fits actual later 60-second BRTI returns, scaled by observed volatility, using spot/futures pressure, changing pressure, price response and availability. The shift is limited to one minute of exposure, never multiplied by the full remaining horizon. |
| Directional reversal | Learns whether the official final outcome will be opposite the current BRTI side. Uses distance, remaining time, recent movement, acceleration, spot/futures pressure and a usable Kalshi quote. It can change direction without the older blend and baseline cap.                           |

The older fitted reversal and forward-pressure candidates blend 20% of their estimate into the original
baseline and cap the final change, including calibration, at five percentage points. The three
structural alternatives use their declared policy followed by checkpoint calibration. Missing optional inputs fall back to the existing probability;
they never introduce a new Fixed publication threshold. Once the settlement minute is partially
observed, the native conditional settlement calculation takes precedence over these candidates.

### Direct directional reversal

The `kalshi-directional-reversal-v1` policy asks a specific question: will the final official
YES/NO result differ from the side occupied by BRTI at capture? A temporary crossing does not
count. Current side uses the same cent rounding and equality-to-YES rule as the benchmark.

Its ten inputs are absolute volatility-scaled target distance, remaining fraction of the event,
three-minute return and acceleration, 60-second spot and futures pressure, their two availability
flags, Kalshi midpoint flip log odds, and quote availability. Directional inputs point toward the
opposite side: selling pressure points toward a flip when currently above, buying pressure when
currently below. Missing optional feeds have explicit availability flags. The existing contract,
quote-age and spread checks decide whether the Kalshi quote is usable.

The logistic fit estimates flip probability directly. If BRTI is currently above, YES probability
is one minus flip probability; if below, YES probability equals flip probability. There is no
20% blend and no five-point cap around the baseline. This permits a different direction; it does
not imply that different directions will be more accurate.
This classifier changes outcome probabilities only. Settlement-average price and interval estimates
continue to come from the underlying settlement model; they are not fitted price predictions from
the reversal classifier.

Regularization is chosen from the frozen grid `0.001, 0.01, 0.1, 0.5` using only primary-training
events. Expanding chronological folds require at least 30 earlier contracts and score the next
ten, purging outcomes unavailable at the boundary. Each contract has equal total weight across
its checkpoints. The lowest weighted Brier error wins; ties favor stronger regularization. The
selected penalty is refitted on all primary events and stored with fold scores and cutoffs.
If no inner fold qualifies, the declared default is 0.5. Neither the later calibration partition
nor future evaluation selects the penalty.

Twenty later contracts fit `checkpoint-flip-calibration-v1`, targeting flip/stay outcomes rather
than YES/NO. Its correction is capped at five points around the direct estimate, not the baseline.
A checkpoint without enough flip/stay examples remains unsupported and uses the baseline.
Known invalid replay captures are excluded from this family's fitting. During future evaluation,
known matching contract records retain their place in the first sixty-event cohort even when
their inputs cannot be replayed. Those captures cannot supply a valid score; a later contract cannot
replace them to improve coverage. Contracts with no recorded decision at all remain outside this
record-based cohort and are reported separately through collection coverage.
Calibration-partition direction scores are diagnostics, not independent validation.

This family must improve paired directional accuracy over current-side, with a positive lower
uncertainty bound, as well as improve Brier error against baseline and production. Its development
budget covers six families, five checkpoints and three comparisons; confirmation divides the
global attempt budget across its nominated checkpoints and those three comparisons. It needs the
same separate 60-contract development and fresh 60-contract confirmation stages. It cannot
activate merely by producing different calls, matching baseline accuracy, or fitting old data.
Previously frozen families keep their declared policies and cohorts.

Primary fitting requires at least 60 independent, resolved native BRTI events with ten YES and
ten NO outcomes. Reversal fitting also needs twelve reversals. Forward fitting requires exact
observed 60-second labels and available pressure for those primary events. Twenty later independent
events are reserved for calibration; their final outcomes are sufficient and they do not require
forward labels. Primary events whose outcomes or labels were not published before calibration
began are removed. In adjacent contracts this can require more than 80 total events.

At each of 12, 9, 6, 3 and 1 minute remaining, calibration fits a small offset to the candidate's
log odds using only that reserved older period. A penalty of 20 pulls the offset toward zero;
it is bounded to [-1, 1]. New artifacts identify this fit as `checkpoint-logit-calibration-v3`.
The fit minimizes log loss plus the penalty using the probabilities that would actually be
published: it includes the calibration's five-percentage-point cap and, for fitted candidates,
the total five-point limit around the original baseline. It checks the clipping boundaries as
well as the smooth intervals between them and retains zero offset if no improvement is found.
This prevents a calibration fit from chasing changes that the publication caps would discard.
The regularization strength and publication limits are unchanged.

The V3 fit also accepts valid raw structural probabilities across 0–100%: a Kalshi midpoint
blend can legitimately produce 0.5% or 99.5%. Rejecting those observations prevented the entire
market-blend candidate from fitting. The calibrated loss still uses the actual bounded publication
rule. An unsupported identity correction retains its raw probability and reports matching
reliability bins. Invalid probabilities outside 0–100% remain rejected. Saved V1/V2 offsets and
their application math remain unchanged; the version identifies the expanded fitting support.

Fewer than 20 usable examples or five of either outcome at a checkpoint
leaves its offset at zero, labeled identity rather than fitted. No future validation outcome is
used to fit this correction. New calibration-fit bins describe the fitted, capped probabilities;
later validation bins are shown separately. Saved `checkpoint-logit-calibration-v1` artifacts
keep their stored offsets and exact original application behavior. The corrected fit applies
only to newly trained artifacts, and does not relax any promotion requirement. Better fit to
older calibration data does not establish calibrated percentages or better future accuracy.

The first 60 future independent background events form development. All five checkpoints use
those same contracts, with no reconstruction of missing predictions. Each checkpoint needs
complete paired coverage, ten outcomes of each class, at least 30 actual adjustments, no lower
directional accuracy, and a negative upper bound for paired Brier differences against both the
baseline and recorded production. Reversal candidates additionally need twelve reversals, better
reversal recall and no more than 50% false reversal alerts. A passing checkpoint only qualifies
for nomination; development can never activate a model.

A terminal unobserved or conflicting outcome inside the fixed cohort ends that development or
confirmation run immediately as unusable evidence. Waiting for sixty contracts cannot repair
an immutable terminal outcome. The original records and cohort stay intact; the normal leased
workflow retires the candidate and may fit a new one for a new future evaluation. Pending results
and missing checkpoints alone do not trigger this early stop, and approval requirements do not
change.

The first qualifying family in the declared table-independent priority order (reversal, forward
pressure, half pressure, faster decay, market blend, directional reversal) is nominated. Its successful checkpoints and
current production model identity are persisted in `challenger_trials`. One final confirmation
trial runs at a time, on the first 60 independent contracts starting after nomination. Membership
is appended by time before scoring and survives restarts. Fitting pauses during confirmation.
A changed incumbent, lost cohort membership or failed final comparison cannot be repaired by
choosing a different later cohort. Every subsequent trial starts after the earlier trial closes.

Final confirmation applies the same per-checkpoint comparisons. Attempt n has an error budget
of `0.05 / (n * (n + 1))`, divided across nominated checkpoints and the family's comparisons. The attempt
number is global and durable, including failed/abandoned trials. Uncertainty uses differences in
paired Brier losses averaged into 15 chronological four-event blocks and a Student-t bound.
These are approximate parametric intervals; dependent blocks or distribution mismatch can
invalidate their nominal confidence. The decreasing budget is not a guaranteed lifetime error
bound. The original families retain their five-family, five-checkpoint, two-comparison development
policy; the new directional family includes its additional accuracy comparison and sixth family.
Nonfinite numerical bounds fail closed to the existing production calculation.

Only final-passing checkpoints can affect predictions, within five seconds of their approved
countdown time. Other times use the settlement baseline, with no extra Fixed publication gate.
An approved model can replace a healthy incumbent because confirmation compares its recorded
probabilities with that incumbent. Activation atomically checks the persisted pass and unchanged
incumbent; a trial can activate its candidate only once. Saved Fixed calls never change.

Candidates do not stack with other learned adjustments. Older learning lanes cannot replace an
active challenger, or change production during its confirmation, using baseline-only validation.
The latest 40 resolved independent events monitor each approved checkpoint; incomplete matching
evidence, over 0.005 excess Brier error or over five percentage points of lost accuracy suspends
the challenger. Reads suppress degraded influence immediately; the leased cycle records retirement.
A healthy active family can fit a replacement after 20 new independent events since activation;
a rejected candidate waits for 20 new events since retirement. It still must pass both future stages.

The research modal shows approval by checkpoint, development/confirmation progress, replacement
status, and observed YES frequencies by probability band. Each band shows its sample count and
a 95% Wilson interval for the observed frequency; this is not a confidence interval for an individual bet.

The existing research command runs this process automatically. `--report` remains read-only.
No additional API subscription or Kalshi request is required for these learning changes. The optional
[purchase value panel](kalshi-purchase-value.md) uses separately limited read requests. Saved Fixed calls remain immutable;
their risk control now shows current loss probability and its change in percentage points since
capture. A rising risk changes the live assessment, not the historical call.
The current-side flip calculation rounds the BRTI reference to cents and counts equality as Yes,
matching the learning benchmark. A sub-cent price difference cannot reverse that risk label while
the model treats the reference as a tie. This does not change the saved call's loss probability.

## Reports and storage

Research data shows independent event counts, directional accuracy, Brier score, calibration
groups, and call/outcome coverage. Its exact 12/9/6/3/1-minute checkpoint breakdown compares each
model with predicting the current side on the **same directional events**. Extra correct calls
is the model's correct count minus that benchmark's correct count; negative values show harm.
Neutral calls stay in probability scores but are excluded from both sides of this paired accuracy
comparison. A missing comparison remains unavailable rather than appearing as zero improvement.

Reversal counts show correct reversal warnings over actual reversals, and false warnings over
all reversal warnings. A neutral prediction can therefore miss a real reversal without becoming
a directional error. High accuracy near expiry alone does not establish that the model adds
value: the current-side benchmark can also be highly accurate with little time left. Different
variants are compared only on their own matching event sets, and counts at several checkpoints
must not be summed as independent events. The existing all-row accuracy fields retain their
historical neutral conventions; `currentSideComparison` provides the explicit paired summary.

Results remain separated by baseline version and price source. Training counts identify the
source combination they qualify. The benchmark uses the forecast's actual reference price,
including BRTI for native estimates. Missing outcomes are not counted as losses. Candidate
status also separates waiting for collector proof, a scheduled future evaluation boundary,
incomplete evidence, and an actual failed performance comparison. Incomplete evidence is not
presented as proof that a model predicted badly.

The browser queues evidence in IndexedDB; server APIs persist it in local SQLite or configured remote libSQL. Analyze saved forecasts runs the durable evaluation workflow. The browser and optional persistent collector can collect real inputs, while official outcomes can be recovered after an outage.

An already initialized local archive can be read while a database viewer holds a write lock.
`/api/research/status` distinguishes readable data from current write availability. If recording
reports a locked database, finish or close the viewer's transaction; the app retains pending
uploads and retries them. It never closes the viewer or commits/reverts its unsaved edits.

No trained weights or accuracy claim ship with this change. Both learning stages use the existing
recorder, database and authorized Kalshi/BRTI access; no additional paid API is needed for early
learning. Prospective outcomes are needed to assess whether either model helps Kalshi users. See
[Kalshi methodology](kalshi.md) and [collector setup](research-collector.md).

# Kalshi outcome learning and reversal risk

The fixed call is published after a bounded observation period even when its direction is weak. Model promotion rules govern replacing the math; they do not impose another confidence gate on each fixed call.

## What a reversal means

The outcome is the official KXBTC15M YES/NO result for the saved contract. YES includes equality under the final-minute BRTI average rule. A temporary price crossing is not the scored event.

The live probability of the opposite outcome is the estimated risk that the saved fixed call loses. The estimate uses the same saved target and deadline. Benchmark price, or the explicitly labeled Coinbase proxy, establishes the current side. Observed pressure changes, momentum and liquidity explain the risk; they are not separate calibrated probabilities.

## Evidence

The automatic recorder follows real contracts with checkpoints at 12, 9, 6, 3 and 1 minute remaining. A capture must occur in its five-second window with valid contemporaneous inputs. Missing checkpoints remain metadata rather than reconstructed forecasts.

Each decision saves original probabilities, model identity, contract, horizon, market features and any matching fresh Kalshi quotes. Official finalized outcomes are joined later. Journal-only records can be audited but cannot supply missing model-training inputs.

Multiple checkpoints and collectors for the same event do not count as independent outcomes. Training assigns a total weight of one per independent event across its captured checkpoints. Evaluation uses a calendar-determined representative checkpoint per event and groups overlapping windows.

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

The current baseline is `kalshi-brti-average-v2`; learned artifacts use `outcome-logistic-kalshi-v2` with `deadline-reversal-features-v2`. Features describe target distance, time remaining, recent returns, volatility, ranges, Coinbase volume, executed flow, spread, liquidity and availability. Native BRTI history supplies price movement when available. Missing exchange volume/spread have their own availability indicators; neither is invented for an index. Logistic fitting and probability calibration use jStat-based shared statistics.

Each snapshot identifies its baseline model version, reference price source and price-history source. Training, calibration, later testing and prospective comparisons use the same combination. BRTI history, BRTI price with Coinbase history, and the full Coinbase proxy are separate groups. Once native BRTI evidence is recorded for the current generation, temporary proxy fallbacks do not switch its training group back. An older or incompatible learned artifact cannot adjust the new model. Historical v1 calls remain in audit reports with their original outcomes; they cannot supply v2 training features retrospectively.

Chronological partitions use 50% of independent window groups for training, 25% for calibration and 25% for later testing. Groups are purged at boundaries when earlier outcomes were not yet available. Normalization and fitting do not use later partitions.

Current release minimums are:

- 120 training, 60 calibration and 60 test windows, with class coverage checks.
- At least 30 actual candidate uses on the test set.
- 120 subsequent shadow windows, including at least 60 candidate uses.

These are evidence requirements, not promises that this amount of data is sufficient to discover an edge. Candidates must improve accuracy over the current model and the current-side benchmark, reduce probability error, and avoid worse calibration. When at least 30 matched Kalshi quote observations exist, performance is also compared against their contemporaneous YES bid/ask midpoint. Prospective comparisons and uncertainty checks must pass before activation.

Artifacts include their supported horizon, target-distance and feature-availability domain. Unsupported inputs fall back to the settlement model. Conditional final-minute forecasts with observed average samples also retain the settlement model instead of applying a classifier trained for a different information state.

New models affect subsequent calculations. Saved fixed probabilities and official outcomes remain immutable.

## Reports and storage

Research data shows independent event counts, directional accuracy, current-side accuracy, Brier score, calibration groups, reversal recall/false alarms, and call/outcome coverage. Results are also separated by baseline version and price sources. Training counts identify the source combination they qualify. The current-side comparison uses the forecast's actual reference price, including BRTI for native estimates. Missing outcomes are not counted as losses. Neutral calls do not count as directional wins.

The browser queues evidence in IndexedDB; server APIs persist it in local SQLite or configured remote libSQL. Analyze saved forecasts runs the durable evaluation workflow. The browser and optional persistent collector can collect real inputs, while official outcomes can be recovered after an outage.

An already initialized local archive can be read while a database viewer holds a write lock.
`/api/research/status` distinguishes readable data from current write availability. If recording
reports a locked database, finish or close the viewer's transaction; the app retains pending
uploads and retries them. It never closes the viewer or commits/reverts its unsaved edits.

No trained weights or accuracy claim ship with this change. Both learning stages use the existing
recorder, database and authorized Kalshi/BRTI access; no additional paid API is needed for early
learning. Prospective outcomes are needed to assess whether either model helps Kalshi users. See
[Kalshi methodology](kalshi.md) and [collector setup](research-collector.md).

# Forecast reconciliation at entry

A recorded loss combined a 99% YES forecast and a research-market estimate of 91.65% with
an execution-book midpoint near 62.5%. These are disagreements of 36.5 and 29.15 percentage
points against the execution book. The observation motivates a model experiment; it does
not establish a stale-data defect or prove that the midpoint is a calibrated probability.

The adviser retains the original forecast, reads the book, and recomputes production and
research variants using current collected inputs and that exact contract and book. The
new advice uses refreshed production probability. Existing market-blend weights and frozen
calibration artifacts are evaluated through the existing research forecast pipeline.
Market-blend candidates remain experimental and do not replace production automatically.

At a delayed simulated fill, the forecast is recomputed again against the actual fill book.
The already saved intention and its execution rule remain fixed. The refreshed probabilities
and their disagreements are separate evidence for comparing the model. No successful replay
or improved score changes a policy, activates a model, or rewrites a purchase.

## Saved evidence

`advisorForecast.utils.js` derives a YES bid from the complement of the best NO ask and
uses the best YES ask from the same ordered book. It preserves request and receipt times,
contract identity, original research quote, current production prediction, raw market blend,
and eligible candidate and active calibrated outputs. A two-sided midpoint is a benchmark;
the actual depth and fees still determine executable cost.

Missing, crossed, noncausal, mismatched, or stale books remain unavailable. The blend's
existing quote-age, spread and horizon guards still apply. A failed same-book calculation
is recorded with its reason; the older research quote is never substituted for the book.
Candidate identity includes model and policy versions, training cutoffs, and calibration
status. An identity calibration or an applicability fallback is not evidence of a fitted
correction at that checkpoint. Calibrated comparison coverage includes only outputs whose
recorded calibration status is `fitted`; identity, missing-checkpoint, and applicability
fallbacks remain unavailable for that comparison while their raw blend can still be scored.

The complete current input snapshot and frozen models support exact replay where captured.
Older records without this archive or reconciliation remain missing coverage. Reconstructing
their contemporary feed state from today's data would invent historical observations.

## Read-only comparison

Run the evaluator against saved local events with a Node.js runtime that supports `node:sqlite`:

```sh
node scripts/research/compare-advisor-forecasts.mjs
node scripts/research/compare-advisor-forecasts.mjs --database data/bitcoin-research.db --policy POLICY_ID --as-of 2026-10-04T17:00:00Z --max-sequence 1000
```

The default selects the configured policy and records the command's observation cutoff and
maximum event sequence in its JSON output. The reader verifies saved payload hashes and
uses a read-only database transaction. It makes no network requests, database writes,
historical backfills, calibration fits, or activation decisions.

`getAdvisorForecastEvaluation(events)` selects the earliest valid buy fill per exact
contract, ordered by observation time and then event ID. Repeated orders and partial fills
do not count as independent windows, and a later entry with more complete evidence cannot
replace an earlier missing observation. Official settlement or comparison outcomes must
match the contract; conflicting outcomes are excluded and counted separately.

The report compares these recorded YES probabilities:

- Saved intention, converting a NO-side probability into YES outcome space.
- Refreshed production at execution time.
- Midpoint derived from the same execution book.
- Raw market blend before its recorded artifact adjustment.
- Candidate and active outputs with fitted calibration, kept separate by role, model identity,
  model version, policy version, calibration version, and calibration status.

Each comparison reports Brier score and direction accuracy against the saved intention on
the same resolved contracts. Negative Brier difference is better. Direction accuracy uses
only paired rows where both forecasts give a direction; exactly 50% abstains while retaining
its Brier observation. Ten probability bins show observed YES rates. Coverage reports missing
and unavailable observations, with pending and conflicting outcomes counted independently.
No score is reported when its paired sample is empty.

## Historical advice audit

Use an exact saved advice ID to replay its original archived inputs and then substitute
the advice book and, when recorded, its delayed execution book:

```sh
node scripts/research/compare-advisor-forecasts.mjs --advice ADVICE_ID
```

This mode reports `historical-book-substitution`. It verifies advice and event payload
hashes, decompresses the input archive within the existing two-megabyte limit, verifies
its hash, and requires an exact original forecast replay. The archived research generation
must match the current calculation generation. The supplied contract, frozen models, and
learning window stay unchanged. No settlement outcome enters a prediction input.

Each substitution uses the saved book and its historical observation time while retaining
the originally archived spot, BRTI, futures, and candle inputs. It reports the elapsed time,
production probability, book midpoint, raw blend, artifact output, and calibration status.
It cannot reconstruct contemporaneous feed updates that were never archived. An output
marked `outside_checkpoint` has no fitted checkpoint correction; its artifact identity does
not establish calibrated improvement. Unavailable books remain unavailable without falling
back to the original research quote.

The optional `--as-of`, `--max-sequence`, and `--database` arguments also apply to this mode.
An optional `--policy` must match the selected advice. The JSON omits full depth, feed
histories, and model artifacts, and the read-only transaction leaves all evidence unchanged.

For the purchase motivating this experiment, the original replay reproduced 99% production,
91.65% research-market midpoint, and 95.6859% market blend. Substituting the saved advice book
100 milliseconds later produced a 62.5% midpoint and 82.5408% blend. Substituting its actual
delayed execution book 3,176 milliseconds later produced a 64.5% midpoint and 83.4014% blend.
Production remained 99% in both substitutions, and both artifact outputs were outside their
calibration checkpoints. These are historical counterfactual calculations, not current-input
recomputations, prospective validation, or proof of a stale-data defect.

## Interpretation limits

These are exploratory observational comparisons among contracts that the existing adviser
chose to enter. They do not measure behavior on skipped markets, implement a counterfactual
execution policy, estimate counterfactual PnL, or establish calibration from one loss.
Comparisons can use different coverage across candidate identities; inspect their paired
sample counts and missing observations before comparing scores. Independent chronological
prospective evidence is required before considering any model change. There is no automatic
activation path in this evaluator.

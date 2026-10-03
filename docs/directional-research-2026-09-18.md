# Directional prediction investigation — September 18, 2026

The existing forecast has not demonstrated a reliable directional advantage over simply choosing
the side BRTI currently occupies. Removing a mathematical restriction creates an opportunity to
test a better model; it does not establish that the new model is better.

## Frozen exploratory comparison

Evidence was frozen at sequence 9031, as of `2026-09-18T20:27:17.505Z`. We used verified V4
native BRTI captures, retained the earliest eligible contract/checkpoint, and kept all checkpoints
for an event together. The first two thirds supplied development data; the last third supplied
later comparison data. A development event whose official result was published after the later
partition began was purged. The follow-up audit excluded three earliest captures already flagged
as having invalid input timing; later duplicates cannot replace them. This leaves 55 development
and 29 later independent contracts, with 272 and 145 checkpoint predictions respectively.

The rules and thresholds were declared before scoring. These historical results have now been
examined during model development. They are exploratory and cannot supply release confirmation.

Reproduce the fixed-rule comparison without changing the database or models:

```sh
pnpm research:compare-directions --as-of 2026-09-18T20:27:17.505Z --max-sequence 9031
```

Omit the cutoff flags to inspect a frozen snapshot of the latest local archive. Add `--json` for
machine-readable results. More observations in that updated report do not turn a previously
inspected historical comparison into prospective validation.

| Rule                                        | Development accuracy, equal event weight | Later accuracy   | Helpful / harmful opposite-side calls on later data |
| ------------------------------------------- | ---------------------------------------- | ---------------- | --------------------------------------------------- |
| Current side                                | 79.27%                                   | 80.00% (116/145) | —                                                   |
| Existing production forecast                | 77.82%                                   | 80.00% (116/145) | 1 / 1                                               |
| Follow the three-minute return              | 59.82%                                   | 60.00% (87/145)  | 10 / 39                                             |
| Oppose the three-minute return              | 40.55%                                   | 40.00% (58/145)  | 19 / 77                                             |
| Near-target spot/futures pressure agreement | 75.27%                                   | 77.24% (112/145) | 7 / 11                                              |
| Usable Kalshi midpoint direction            | 78.91%                                   | 81.38% (118/145) | 2 / 0                                               |

The pressure rule required absolute volatility-scaled target distance at most 0.5 and agreement
between available 60-second spot and futures pressure signs, otherwise using current side.
Market direction used the existing verified quote rules and fell back to current side when
unavailable. The two market improvements both occurred with twelve minutes remaining. Development
market accuracy was slightly worse than baseline. Two corrected calls do not demonstrate an edge.
The `simple-directional-rules-v2` command reports both raw and equally weighted event accuracy,
plus its known-invalid capture count. The three exclusions affect only development; all later
comparison results above remain unchanged.

## Ending-price experiment

A separate fixed experiment predicted the official settlement-average residual relative to the
settlement-only forecast mean and standard deviation. It used 39 fitting contracts, 15 later
contracts for an empirical residual distribution, and the same 29 comparison contracts after
publication-time purges. Ridge penalty was fixed at 0.5; seven inputs described recent movement,
spot/futures pressure and availability, and time remaining. Each contract had equal total weight.

It got 117/145 directions correct versus 116/145 for current side: three helpful and two harmful
changes. Brier error was 0.135895, worse than the existing combined forecast's 0.135214 and the
settlement-only forecast's 0.131468. Its twelve-minute slice improved, but the overall result and
small calibration sample did not justify implementing it as another production candidate.
This earlier price experiment preceded the invalid-capture audit and is retained as an exploratory
record, not causal validation evidence or a deployed model. Its fitting set included the affected
contract; any renewed investigation must apply the same invalid-input exclusions.

## Implemented prospective candidate

The new directional reversal family predicts the probability that the final official outcome
will differ from the current side. It uses target distance, time remaining, recent movement and
acceleration, spot/futures pressure, a usable Kalshi midpoint, and availability flags.

The older fitted candidates could move baseline probability by at most five points and blended
only 20% of their own estimate into it. The new family predicts directly. It can therefore favor
NO when the baseline strongly favors YES, or vice versa, if learned evidence supports that call.

Regularization is selected using chronological folds entirely inside primary training. A separate
twenty-contract partition calibrates flip probabilities at each checkpoint. Unsupported checkpoints
retain the baseline. No new publication gate blocks normal Live or Fixed predictions.

A read-only fit on the frozen archive used 64 primary and 20 later calibration contracts, with
one boundary contract purged. It selected penalty 0.001 using two inner folds. Raw predictions
made no opposite-side calls in the calibration partition. Calibration subsequently created one
correct twelve-minute opposite-side call, but those same labels fitted calibration: that is
**not an independent accuracy result**. This candidate remains an experiment.

Only newly saved V5 predictions can evaluate it prospectively. Promotion requires positive paired
directional improvement over current side, better Brier scores than baseline and production, and
separate sixty-contract development and sixty-contract confirmation periods. Historical calls,
old model artifacts and existing candidate cohorts retain their original meaning.

The existing feeds and research command are sufficient. No additional paid API was added.

## Follow-up correctness audit

- The Kalshi risk panel now uses the same cent-rounded current-side definition as learning,
  including equality on Yes. Saved-call loss probabilities remain unchanged.
- A known invalid capture cannot silently remove its contract from the directional candidate's
  first sixty matching future contract records. It remains in that cohort as missing evidence,
  preventing later contracts from replacing it. Fully unrecorded offline contracts are tracked
  through collection coverage rather than invented.
- The market-blend candidate had sufficient events but could not fit because eleven valid
  calibration probabilities were outside the generic 1–99% range. New calibration fitting accepts
  raw structural probabilities from 0–100%, evaluates the same bounded probabilities it would
  publish, and keeps an unfitted identity correction unchanged. Existing model artifacts and
  archived replay calculations retain their original behavior.

## October 3 collection recovery and interim findings

The collector stopped on September 19. The October 3 report contains 33 resolved prospective
contracts for the direct directional candidate and 32 for market blend. At each supported
12/9/6/3-minute checkpoint, the direct candidate made zero opposite-side calls and gained zero
correct directions over current side. Its Brier error improved at nine and three minutes but
worsened at twelve and six minutes. The one-minute checkpoint retained its unsupported-calibration
fallback. Market blend corrected one six-minute call; this is insufficient evidence of an edge.

The frozen direct calculation reproduces its saved probabilities. Its highest calibrated flip
probabilities at 12/9/6/3 minutes were 48.68%, 45.37%, 46.34% and 43.47%. No sign, scaling or
publication-cap defect explained the absent calls. These interim results do not justify lowering
the reversal threshold or activating either candidate.

Recovery exposed a separate defect: the recorder advanced a contract older than seven days before
attempting its official outcome lookup. It wrote terminal unobserved evidence and removed the
contract from its pending list. The recorder now retains it until a recent matching market response
allows settlement or confirms that the seven-day wait still has no valid result. Regression tests
cover a continuous collector restart and preservation of the original forecasts.

The already saved terminal record remains unchanged. It invalidates the affected fixed evaluation
cohorts, so they now end immediately as unusable evidence instead of consuming more contracts on
a test that cannot pass. The normal leased workflow can fit replacements and enroll them in fresh
future cohorts. This is a data-recovery improvement, not a demonstrated accuracy improvement;
the original predictions, archived artifacts, failed runs and promotion requirements remain intact.

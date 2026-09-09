# Forecast evaluation and market-awareness experiments

The expanded 30-day retrospective evaluation does **not** show a useful directional advantage from the tested candle features over simply checking which side of the target the price occupies at the same capture time. The full logistic model performed slightly worse than the current normal baseline on Brier score and log loss. No candidate is approved for production from this study.

All dates in the new test period overlap the earlier 14-day study below. The chronological partitions prevent future rows from entering a fitted model, but they do not make previously inspected dates unseen again. These results are consumed retrospective evidence; a later prospective test is required for any accuracy claim.

## New trade-pressure model: not evaluated by these candle studies

The application now introduces experimental model `trade-pressure-log-return-v1` and publication policy `pressure-snapshot-v3`. It fits contemporaneous price response to net aggressive BTC flow in completed 15-second trade buckets, shrinks and bounds that response, and uses available recent flow with decay to adjust the expected log return. Responsive movement and spread affect uncertainty even when pressure is unavailable. Missing or unusable pressure inputs retain a price-only estimate with this responsive uncertainty rather than suppressing a prediction solely because flow or order-book data is unavailable. The fallback may therefore differ from the older zero-drift model's percentages.

After three minutes of observation, the new policy captures the first valid estimate, including a slight lean or balanced 50/50 result. It does not require a 65% threshold or a further minute of directional agreement. Original targets, endpoints, essential data validity, and publication cutoff remain fixed; earlier saved policies retain their original rules. Higher coverage is an intended behavior change, not evidence of higher predictive accuracy.

Neither the 14-day nor 30-day candle evaluation below contains the needed executed-trade history. They did **not** test this pressure adjustment, its fitted contemporaneous coefficient, or its new publication policy. A contemporaneous flow/return association is not an out-of-sample forecast result, and no fitted accuracy or calibration claim is made for the new model. The negative candle-feature findings remain unchanged and must not be cited as validation of the new model.

Prospective evaluation must freeze model/policy versions, preserve actual completed bucket inputs and capture times, and compare the pressure estimate with the zero-drift baseline and current-side benchmark at identical capture timestamps, targets, and deadlines. Report Brier/log loss, calibration bins, interval coverage, direction accuracy, coverage, missing outcomes, and results by regime with whole-window chronological partitions. Ablate the pressure mean adjustment separately from responsive uncertainty and the relaxed publication policy. The existing JSONL evidence format provides original input, model, decision, and strict-outcome timestamps; no candle proxy should be silently substituted for missing trade evidence.

## Expanded 30-day run

```sh
node scripts/evaluate-market-awareness.mjs --end=2026-09-08T00:00:00Z
node scripts/evaluate-market-awareness.mjs --end=2026-09-08T00:00:00Z --offline
```

The downloader reuses the existing candle cache and requests only missing history. Output is `test-artifacts/forecast-evaluation/market-awareness-2026-09-08-30d.json`. It contains exact split boundaries, data and source hashes, fitted coefficients and normalization, calibration parameters, all candidate policies, probability bins, and metrics by horizon, wait, regime, and horizon/regime combination. The old 14-day report is preserved separately.

Data: 43,320 completed Coinbase BTC-USD one-minute candles, including two warm-up hours, with no missing windows. The 30-day study spans August 9–September 8, 2026 UTC. The normalized candle SHA-256 is:

```text
c80ea90d6f0c5c6ad2c2d6824446613b096f5e126e22c8396e3b4a273f01e6f7
```

| Partition        | UTC start    | UTC end      | Distinct 15-minute anchors | Forecast examples |
| ---------------- | ------------ | ------------ | -------------------------: | ----------------: |
| Training, 60%    | Aug 9 00:00  | Aug 27 00:00 |                      1,728 |           112,275 |
| Calibration, 20% | Aug 27 00:15 | Sep 2 00:00  |                        575 |            37,369 |
| Test, 20%        | Sep 2 00:15  | Sep 8 00:00  |                        575 |            37,361 |

Each boundary has a 15-minute embargo. There are 65 excluded equal-to-target capture/target cases across the full dataset, not 65 necessarily distinct windows. Endpoints at 3, 5, 10, and 15 minutes share an anchor; waits of 0, 1, 3, and 5 minutes are allowed only when at least one minute remains. Targets are fixed at the initial anchor price and ±0.10%/±0.25%. The last completed close available at capture supplies spot. Later candles enter only the outcome calculation. Outcomes from the same anchor, target variants, and different waits are correlated, so example counts are not independent sample counts.

Training normalization and logistic coefficients use only training examples. Logistic regression is fitted with deterministic penalized Newton updates using jStat's least-squares solver; the fixed penalty is 0.001. Calibration fits a separate sigmoid of each model's logit on calibration data only. The calibration partition is also used to choose wait/threshold policies, so its reported fit and selection scores are optimistic development measurements. No test scores determine coefficients, calibration, or policy choices. [Time-series split guidance](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html), [probability calibration guidance](https://scikit-learn.org/stable/modules/calibration.html)

## Candle-feature ablation and benchmarks

The raw variance candidates use the normal return distribution with four alternative spread estimates: existing sample variance, root-mean-square returns, Parkinson high/low range variance, and exponentially weighted variance with a 30-minute half-life. These are evaluated separately.

Logistic ablations progressively add inputs to a distance/horizon model: one-, three-, five-, and fifteen-minute standardized returns; three-minute acceleration; recent/prior volume ratio; then five-minute range and the latest candle's close position. Distance and three-minute-return interactions with remaining time are explicit features. All indicators are derived from completed candles at capture; no order-book or trade-flow history is fabricated.

The following test scores pool the specified horizon/wait/target grid; this grid is not a measured production workload. Brier and log loss are probability-error measures, while ECE is the weighted absolute gap between predicted and observed Above rates in ten fixed-width probability bins. Lower is better, but a lower Brier score alone does not establish better calibration. The report retains each bin's count rather than hiding small bins.

| Model                           |    Brier | Log loss |      ECE |
| ------------------------------- | -------: | -------: | -------: |
| Constant 50%                    | 0.250000 | 0.693147 | 0.002583 |
| Current side, deterministic 0/1 | 0.126743 | 1.577151 | 0.111145 |
| Existing normal baseline        | 0.095246 | 0.302770 | 0.013171 |
| RMS returns                     | 0.095223 | 0.302658 | 0.013020 |
| High/low range variance         | 0.094940 | 0.302646 | 0.008151 |
| EWMA variance                   | 0.094975 | 0.301237 | 0.012102 |
| Logistic: distance/horizon only | 0.095504 | 0.304412 | 0.015978 |
| + Returns                       | 0.095493 | 0.304380 | 0.016153 |
| + Acceleration                  | 0.095452 | 0.304258 | 0.016445 |
| + Volume                        | 0.095474 | 0.304325 | 0.016082 |
| + Range and close position      | 0.095589 | 0.304643 | 0.016145 |
| Calibrated normal               | 0.095257 | 0.302783 | 0.013690 |
| Calibrated full logistic        | 0.095447 | 0.303809 | 0.012638 |

The deterministic current-side benchmark uses the very same capture price and target as the model, not the earlier starting price. At exact equality it supplies 50%. Its log loss clips 0/1 to one part per million solely to remain finite; it is not a calibrated probabilistic competitor. Accuracy on exactly the model's issued-call subset is therefore also reported. The normal model's 89.9005% pooled call accuracy equals this current-side benchmark exactly. Full logistic call accuracy is 89.6097% versus 89.5741% for current side on the same cases, a tiny retrospective difference accompanied by worse probability scores. High aggregate accuracy is driven heavily by distant targets and later observation.

## Waiting, thresholds, and interval checks

For each model and horizon, waits 0/1/3/5 and thresholds 55%/65%/75% are evaluated only on calibration data. Selection maximizes correct-minus-incorrect calls per eligible example, with earlier waits and lower thresholds breaking ties. This objective explicitly includes coverage; it is not trading profit, and it has no transaction-cost or payout assumptions. Model selection uses the same calibration objective. All candidates, not just winners, remain in the JSON report.

| Horizon | Calibration-selected candidate | Wait | Threshold | Test call accuracy | Test coverage | Current side on same calls |
| ------- | ------------------------------ | ---: | --------: | -----------------: | ------------: | -------------------------: |
| 3m      | Logistic + volume              |   1m |       55% |             93.08% |        94.64% |                     93.08% |
| 5m      | Calibrated EWMA                |   3m |       55% |             93.80% |        96.55% |                     93.80% |
| 10m     | Logistic distance/horizon      |   5m |       55% |             90.78% |        95.06% |                     90.78% |
| 15m     | Logistic + returns             |   5m |       55% |             86.92% |        94.40% |                     86.88% |

At the original-spot target, the selected 15-minute candidate achieves **73.61% call accuracy at 84.35% coverage**, exactly matching current side on its selected calls. Waiting five minutes leaves ten minutes to the endpoint and includes five minutes of additional price information. This does not demonstrate improved direction prediction from the original start, and the experiment does not authorize changing production wait/threshold rules.

For comparison, the existing normal model on the same 15-minute endpoints has Brier scores of 0.131519 immediately, 0.123300 after one minute, 0.112079 after three minutes, and 0.102463 after five minutes. At each capture time, its call accuracy again equals current side on those calls. Changes in conditional accuracy between waits must be read alongside coverage.

Central 80% price-interval coverage is counted once per capture/endpoint, not five times for the target variants. The normal baseline covers 83.69%, RMS 83.68%, range 78.06%, and EWMA 83.02% of outcomes in the pooled test grid. Normal interval coverage by nominal horizon is 82.09% (3m), 82.32% (5m), 83.78% (10m), and 85.43% (15m), pooling that horizon's allowed waits. Logistic models and calibrated binary probabilities do not define a full ending-price distribution, so no price intervals are invented for them.

Regimes are fixed using training-only volatility terciles plus a predeclared standardized fifteen-minute trend cutoff of ±1. These research labels are separate from the application's market-status labels. Normal-model interval coverage ranges from 73.40% in medium-volatility/downtrend cases to 89.83% in low-volatility/downtrend cases. Its high-volatility/uptrend ECE is 0.1082 versus 0.0132 pooled. These subgroup differences show why the pooled number cannot stand in for reliability across conditions; individual bins and regimes have smaller, dependent samples.

## Prospective evidence and outcome definition

Historical outcomes here are `coinbase-minute-close-proxy-at-deadline-v1`: the last trade represented by the candle ending at the deadline. A candle cannot prove that the last trade was within five seconds, that every stream match arrived, or that a heartbeat confirmed continuity past the deadline. This proxy is distinct from the application's `coinbase-last-trade-at-deadline-v1` stream rule, even though both refer to a last trade at or before the end. Trade-level correctness and latency need prospective stream evidence.

The agreed export format is JSON Lines with `schemaVersion: 1` and separate `observation`, `decision`, and `outcome` events. Observation rows retain forecast/window IDs, capture and receipt times, target, source, spot, quote time, contemporaneous features, trade flow, liquidity, model/policy/calibration versions, and probability. Decisions retain the issued/withheld result and reason. Outcomes retain the settlement definition, observed price/time/trade ID, stream completeness start, and confirmed-through time. Existing sampled journal entries keep their original settlement semantics. Missing historical depth, spread, aggressor flow, or news inputs are unavailable; they are not reconstructed from candle direction.

Prospective evaluation must keep whole windows together, preserve original capture features, include withheld/failed/missing outcomes in coverage reports, and estimate uncertainty using blocks of time. IndexedDB and exported JSONL are local audit records, not an immutable central journal. Freeze any chosen model, calibration, and policy before opening a genuinely later evaluation period. The fitted artifacts in this retrospective report are research outputs and are not imported by the production application.

## Earlier 14-day exploratory run: consumed data

The first historical check supports testing a delayed, selective fixed prediction. It does **not** establish a reliable win rate for the live application. The alternatives to the current probability model improved probability error only slightly in this sample; retain the normal baseline while collecting prospective results.

For targets equal to Bitcoin's price when the window started, the minute-resolution waiting rule issued 221 calls across 479 held-out windows. Of those calls, 175 were correct: **79.2% conditional accuracy, with 53.9% of windows withheld**. This result is specific to the dates and proxy below. It must not be presented as the tracker's expected accuracy.

## Reproduce

From the project root, with dependencies installed and a recent Node.js runtime supporting ES module syntax detection:

```sh
node scripts/evaluate-forecasts.mjs --days=14 --end=2026-09-08T00:00:00Z
node scripts/evaluate-forecasts.mjs --days=14 --end=2026-09-08T00:00:00Z --offline
```

The first command downloads public candles, with at least one second between requests, bounded retries, and a validated local cache. The second performs the calculation without network requests. Node may report a harmless module-type warning when importing the existing application utilities; the script does not change the application's module configuration.

Results are saved to `test-artifacts/forecast-evaluation/report-2026-09-08-14d.json`; cached response pages are under `test-artifacts/forecast-evaluation/candles/`. This directory survives Next.js production builds. These are ignored local artifacts, so retain them separately if an immutable audit record is required. Omitting `--end` uses the beginning of the current UTC day; `--days` accepts 3–30 days.

The evaluated normalized candle data has SHA-256:

```text
9ac4159e6bd14764fb94a3669305cdcb423ed67687744f424cfb771939652500
```

Historical exchange data can be revised. The cache and hash identify the exact data used in this run.

## Data and chronological boundaries

- Source: Coinbase Exchange BTC-USD one-minute candles, fetched September 8, 2026. Coinbase documents a maximum of 300 candles per request, potentially missing intervals, and bucket-start timestamps with last-trade closing prices. The script requests 299-minute pages, validates every response using the application's parser, and never fills gaps. [Coinbase candle documentation](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)
- Evaluation dates: August 25, 2026 00:00 UTC through September 8, 2026 00:00 UTC, with two earlier hours for volatility initialization.
- Data quality: 20,280 of 20,280 expected candles; no missing or invalid evaluation windows; no equal-to-target outcomes.
- Development: August 25 through September 3 00:00 UTC, 864 non-overlapping windows.
- Held-out test: September 3 00:15 UTC through September 8 00:00 UTC, 479 non-overlapping windows. One 15-minute interval separates the partitions.
- Each window has five targets: starting price multiplied by 0.9975, 0.999, 1, 1.001, and 1.0025. These produce 2,395 test examples, but there are only **479 distinct test windows**. Targets from the same window are correlated observations.

For a window starting at time T, inputs use only candles ending at or before the capture time. The spot-price proxy is the last completed candle's closing price. Every target is anchored to the price at T, including delayed forecasts. The outcome is the last trade in the candle ending at T + 15 minutes. Predictions made at T + 3 minutes therefore have 12 minutes remaining to the **same endpoint**.

The baseline uses the application's `getForecast`, model version `zero-drift-log-return-v1`, with 120 completed candles, sample log-return volatility, square-root horizon scaling, and 1–99% probability bounds. Synthetic ticker timestamps in the offline input mean only that the historical close is available at that time; they do not simulate or validate real feed freshness, spreads, latency, or trade-level deadline settlement.

## Candidate probability models

All candidates retain zero directional drift and the same target, endpoint, and probability bounds. Parameters were fixed before reading held-out scores:

- **Normal 120:** the existing normal-distribution baseline.
- **EWMA 10 / EWMA 30:** exponentially weighted sample variance of the same return history, with 10- or 30-minute half-life and a weighted sample-size correction.
- **Blend 30/120:** equal weights on the latest 30 returns' sample variance and the full history's sample variance.
- **Student t, 5 degrees of freedom:** the full-history variance with a heavier-tailed Student t distribution scaled to match the normal model's variance.

The candidate with lowest development Brier score was selected separately for immediate and three-minute capture. Student t was selected in both cases. Held-out alternatives remain visible for transparency, but their test scores should not become another tuning set.

Brier score is the mean squared difference between predicted Above probability and the binary outcome. Lower is better. The following scores include **all five targets and all eligible windows**, including predictions with no directional call.

| Model           | Development: immediate | Development: after 3m | Test: immediate | Test: after 3m |
| --------------- | ---------------------: | --------------------: | --------------: | -------------: |
| Normal 120      |                0.15044 |               0.12697 |         0.12526 |        0.10733 |
| EWMA 10         |                0.15021 |               0.12676 |         0.12453 |        0.10667 |
| EWMA 30         |                0.15016 |               0.12667 |         0.12478 |        0.10681 |
| Blend 30/120    |                0.15014 |               0.12648 |         0.12483 |        0.10696 |
| Student t, 5 df |                0.15014 |               0.12585 |         0.12480 |        0.10642 |

Waiting three minutes reduces the baseline's held-out Brier score by about 14.3%. The development-selected distribution change reduces the delayed baseline score by only about 0.8%. Waiting gives the model three extra observed minutes and a shorter prediction horizon; this is an easier task, not evidence that it can predict the full 15 minutes more accurately from the original start.

## Waiting and withholding policy: minute-close proxy

This separate comparison uses the unchanged normal baseline. At minute 3, then 4, then 5, publish the first probability for which the same direction has at least 65% model probability both now and one minute earlier. Otherwise withhold the fixed call. Once published, the probability and direction stay fixed. The earlier score is used only for the stability check; scores are not averaged and confidence is not increased.

**This proxy is not the production quote-consensus rule.** Two minute closes cannot establish that a signal stayed strong throughout the intervening minute, that seven distinct quotes arrived, or that no gap exceeded 15 seconds. It also does not evaluate shortened windows joined partway through, sub-minute starts, page suspension, reload, or outages.

Test results by target distance:

| Target versus original spot | Emitted / eligible | Coverage | Withheld | Accuracy of emitted calls | Brier of emitted calls |
| --------------------------- | -----------------: | -------: | -------: | ------------------------: | ---------------------: |
| −0.25%                      |          472 / 479 |    98.5% |     1.5% |                     96.8% |                0.02939 |
| −0.10%                      |          416 / 479 |    86.8% |    13.2% |                     88.2% |                0.10132 |
| At original spot            |          221 / 479 |    46.1% |    53.9% |                     79.2% |                0.16618 |
| +0.10%                      |          414 / 479 |    86.4% |    13.6% |                     87.7% |                0.10131 |
| +0.25%                      |          467 / 479 |    97.5% |     2.5% |                     95.3% |                0.04012 |
| All targets                 |      1,990 / 2,395 |    83.1% |    16.9% |                     90.8% |                0.07710 |

The all-target accuracy is dominated by easier, distant targets. At original spot, the policy fixes its call after 3.75 minutes on average; over all targets the average is 3.14 minutes. A high conditional accuracy must always be read with the withheld proportion.

For scale only, 175 successes among 221 emitted at-spot calls gives a nominal 95% Wilson interval of **73.4%–84.0%** under independent binomial sampling. That assumption is not established for adjacent cryptocurrency windows; this is not a dependence-adjusted interval or a range for future tracker accuracy. Pooling the five correlated targets as independent trials would be inappropriate. [NIST Wilson interval method](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)

For comparison, the ordinary three-minute normal estimate at original spot makes a directional call at the existing 55% threshold in 76.0% of windows, with 69.5% accuracy among those calls. That is a different coverage level and cannot establish an improvement by itself.

To reduce selection bias in the comparison, the report also evaluates the earlier predictions on **exactly the examples where the waiting policy emitted a call**:

| Same emitted examples | Immediate Brier | Three-minute Brier | Waiting-policy Brier |
| --------------------- | --------------: | -----------------: | -------------------: |
| At original spot: 221 |         0.25000 |            0.17675 |              0.16618 |
| All targets: 1,990    |         0.09784 |            0.07994 |              0.07710 |

The waiting rule retains a modest advantage on these paired examples. It still benefits from later observation, and its Brier score is conditional on coverage. Withheld forecasts have no emitted probability and are not silently scored as successes or assigned invented confidence.

## What this supports

Use the waiting period to seek a stronger, consistent fixed call and explicitly withhold it when the evidence is insufficient. Keep the live estimate available and keep the original deadline unchanged. Retain the current model initially: this short comparison does not establish that a different distribution or volatility weighting will produce a dependable improvement.

Record real quote timestamps, data-quality interruptions, the evaluated probability path, the eventual publication time, withheld reasons, and observed results. Evaluate the exact production policy prospectively across substantially more market conditions, with coverage and calibration by target distance and remaining time. Do not retune against these five held-out days and keep calling them unseen data. Adjacent windows can remain statistically dependent despite non-overlapping outcomes; a larger evaluation should estimate uncertainty using blocks of time and keep all targets from a window together. No future accuracy guarantee is claimed here.

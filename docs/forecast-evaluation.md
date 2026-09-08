# Forecast evaluation: waiting before fixing a prediction

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

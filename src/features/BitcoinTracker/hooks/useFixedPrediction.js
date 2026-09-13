import { useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { fixedForecastPublished, fixedForecastWithheld } from '../state/slices/trackerSlice';
import {
  getFixedPredictionProgress,
  getQualifyingDirection,
  updateConfirmationSamples,
  KALSHI_POLICY_VERSION,
} from '../utils/fixedPrediction.utils';
import {
  getKalshiMarketConditions,
  getKalshiReferenceQuote,
  hasIndependentKalshiBenchmark,
} from '../utils/kalshi/marketConditions.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { OUTCOME_MODEL_VERSION, KALSHI_OUTCOME_MODEL_VERSION } from '../utils/learning/model.utils';
import { EARLY_MODEL_VERSION } from '../utils/learning/earlyModel.utils';
import { KALSHI_DERIVATIVES_MODEL_VERSION } from '../utils/kalshi/forecast.utils';

export default function useFixedPrediction({
  forecast,
  candles,
  ticker,
  now,
  hasRequestError,
  stream,
  derivatives,
  models,
  benchmark,
}) {
  const dispatch = useDispatch();
  const observations = useRef({ id: null, samples: [] });
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    if (
      forecast?.status !== 'analyzing' ||
      forecast.analysis?.policyVersion !== KALSHI_POLICY_VERSION ||
      !now
    ) {
      observations.current = { id: null, samples: [] };
      setProgress(null);
      return;
    }
    if (observations.current.id !== forecast.id) {
      observations.current = { id: forecast.id, samples: [] };
    }

    const capturedAt = Date.now();
    const estimate = getResearchForecast(
      {
        candles,
        ticker,
        target: forecast.target,
        now: capturedAt,
        horizonMinutes: (forecast.expiresAt - capturedAt) / 60_000,
        stream,
        // A restored observation retains the baseline policy selected when it began.
        derivatives:
          forecast.modelVersion === KALSHI_DERIVATIVES_MODEL_VERSION ? derivatives : undefined,
        kalshiMarket: forecast.kalshiMarket,
        benchmark,
        expiresAt: forecast.expiresAt,
      },
      models,
      forecast.startsAt,
    );
    const conditions = getKalshiMarketConditions({
      candles,
      ticker,
      target: forecast.target,
      now: capturedAt,
      horizonMinutes: (forecast.expiresAt - capturedAt) / 60_000,
      forecast: estimate,
    });
    const reference = getKalshiReferenceQuote(estimate, ticker);
    // A restored observation needs fresh inputs from its reference; its deadline never moves.
    if (
      (hasRequestError && !hasIndependentKalshiBenchmark(estimate)) ||
      !reference ||
      reference.time < forecast.analysis.startedAt ||
      reference.receivedAt < forecast.analysis.startedAt ||
      reference.time < (observations.current.samples.at(-1)?.quoteTime ?? 0) ||
      (estimate.modelVersion !== forecast.modelVersion &&
        !(
          [OUTCOME_MODEL_VERSION, KALSHI_OUTCOME_MODEL_VERSION, EARLY_MODEL_VERSION].includes(
            estimate.modelVersion,
          ) && estimate.learning?.applied
        ))
    ) {
      estimate.available = false;
    }
    observations.current.samples = updateConfirmationSamples(observations.current.samples, {
      time: capturedAt,
      quoteTime: reference?.time,
      direction: getQualifyingDirection(estimate, forecast.analysis.policyVersion),
    });
    const nextProgress = getFixedPredictionProgress({
      analysis: forecast.analysis,
      samples: observations.current.samples,
      estimate,
      now: capturedAt,
    });

    if (estimate.modelVersion !== forecast.modelVersion && !estimate.learning?.applied) {
      nextProgress.reason =
        'The saved model version is unavailable. This fixed call cannot be issued.';
      if (nextProgress.withholdingReason !== 'insufficient-time')
        nextProgress.withholdingReason = 'model-unavailable';
    }
    if (['ready', 'withheld'].includes(nextProgress.phase)) {
      // Retain the exact decision inputs for prospective evaluation before React advances state.
      nextProgress.decisionEvidence = {
        forecastId: forecast.id,
        inputObservedAt: capturedAt,
        ticker,
        estimate,
        conditions,
        stream: { flow: stream?.flow, liquidity: stream?.liquidity, quality: stream?.quality },
      };
    }
    setProgress(nextProgress);

    if (nextProgress.phase === 'ready') {
      dispatch(
        fixedForecastPublished({
          id: forecast.id,
          now: capturedAt,
          forecast: {
            ...forecast,
            createdAt: capturedAt,
            price: reference.price,
            aboveProbability: estimate.aboveProbability,
            belowProbability: estimate.belowProbability,
            direction: estimate.direction,
            status: 'pending',
            ...(forecast.kalshiMarket ? { kalshi: estimate.kalshi } : {}),
            ...(estimate.derivatives ? { derivatives: estimate.derivatives } : {}),
            ...(estimate.learning?.applied
              ? { modelVersion: estimate.modelVersion, learning: estimate.learning }
              : {}),

            calculationMode: estimate.learning?.applied
              ? 'outcome-trained'
              : estimate.pressure?.applied || estimate.derivatives?.applied
                ? 'pressure-adjusted'
                : 'baseline-fallback',
          },
        }),
      );
    } else if (nextProgress.phase === 'withheld') {
      dispatch(
        fixedForecastWithheld({
          id: forecast.id,
          now: capturedAt,
          reason: nextProgress.withholdingReason,
        }),
      );
    }
  }, [
    forecast,
    candles,
    ticker,
    now,
    hasRequestError,
    stream,
    derivatives,
    models,
    dispatch,
    benchmark,
  ]);

  return progress;
}

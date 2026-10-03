import { useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { fixedForecastPublished, fixedForecastWithheld } from '../state/slices/trackerSlice';
import {
  getFixedPredictionProgress,
  getQualifyingDirection,
  updateConfirmationSamples,
  KALSHI_POLICY_VERSION,
  KALSHI_CHECKPOINT_POLICY_VERSION,
} from '../utils/fixedPrediction.utils';
import {
  getKalshiMarketConditions,
  getKalshiReferenceQuote,
  hasIndependentKalshiBenchmark,
} from '../utils/kalshi/marketConditions.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { createResearchInputSnapshot } from '../utils/researchExperiments.utils';
import { isLearnedModelVersion } from '../utils/journal/modelValidation.utils';
import { getKalshiQuoteSnapshot } from '../utils/kalshi/marketQuote.utils';
import { isSameKalshiContract } from '../utils/kalshi/contract.utils';
import {
  isKalshiDerivativesModelVersion,
  LEGACY_KALSHI_MODEL_VERSION,
  LEGACY_KALSHI_DERIVATIVES_MODEL_VERSION,
} from '../utils/kalshi/forecast.utils';
import { RESEARCH_EXPERIMENT_V3 } from '../utils/researchVariantConfig.utils';

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
  kalshiMarket,
}) {
  const dispatch = useDispatch();
  const observations = useRef({ id: null, samples: [] });
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    if (
      forecast?.status !== 'analyzing' ||
      ![KALSHI_POLICY_VERSION, KALSHI_CHECKPOINT_POLICY_VERSION].includes(
        forecast.analysis?.policyVersion,
      ) ||
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
    const forecastInput = {
      candles,
      ticker,
      target: forecast.target,
      now: capturedAt,
      horizonMinutes: (forecast.expiresAt - capturedAt) / 60_000,
      stream,
      // A restored observation retains the baseline policy selected when it began.
      derivatives: isKalshiDerivativesModelVersion(forecast.modelVersion) ? derivatives : undefined,
      kalshiMarket: forecast.kalshiMarket,
      kalshiQuote: isSameKalshiContract(kalshiMarket, forecast.kalshiMarket)
        ? getKalshiQuoteSnapshot(kalshiMarket, capturedAt)
        : null,
      benchmark,
      expiresAt: forecast.expiresAt,
    };
    const estimate = {
      ...getResearchForecast(forecastInput, models, forecast.startsAt, {
        researchVersion: [
          LEGACY_KALSHI_MODEL_VERSION,
          LEGACY_KALSHI_DERIVATIVES_MODEL_VERSION,
        ].includes(forecast.modelVersion)
          ? RESEARCH_EXPERIMENT_V3
          : undefined,
      }),
      kalshiQuote: forecastInput.kalshiQuote,
    };
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
        !(isLearnedModelVersion(estimate.modelVersion) && estimate.learning?.applied))
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
        researchInputSnapshot:
          capturedAt < forecast.expiresAt
            ? createResearchInputSnapshot(forecastInput, models, forecast.startsAt, estimate)
            : null,
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
    kalshiMarket,
  ]);

  return progress;
}

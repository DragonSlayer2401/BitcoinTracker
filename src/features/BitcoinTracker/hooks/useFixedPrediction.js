import { useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { fixedForecastPublished, fixedForecastWithheld } from '../state/slices/trackerSlice';
import { getForecast } from '../utils/forecast.utils';
import { getPressureForecast } from '../utils/pressureForecast.utils';
import {
  getFixedPredictionProgress,
  getQualifyingDirection,
  updateConfirmationSamples,
  MARKET_AWARE_POLICY_VERSION,
  PRESSURE_POLICY_VERSION,
} from '../utils/fixedPrediction.utils';
import { getMarketConditions } from '../utils/marketConditions.utils';
import { getPublicationRisk } from '../utils/publicationRisk.utils';

export default function useFixedPrediction({
  forecast,
  candles,
  ticker,
  now,
  hasRequestError,
  stream,
}) {
  const dispatch = useDispatch();
  const observations = useRef({ id: null, samples: [] });
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    if (forecast?.status !== 'analyzing' || !now) {
      observations.current = { id: null, samples: [] };
      setProgress(null);
      return;
    }
    if (observations.current.id !== forecast.id) {
      observations.current = { id: forecast.id, samples: [] };
    }

    const capturedAt = Date.now();
    const usesPressure = forecast.analysis.policyVersion === PRESSURE_POLICY_VERSION;
    const estimate = (usesPressure ? getPressureForecast : getForecast)({
      candles,
      ticker,
      target: forecast.target,
      now: capturedAt,
      horizonMinutes: (forecast.expiresAt - capturedAt) / 60_000,
      stream,
    });
    const usesMarketConditions = forecast.analysis.policyVersion === MARKET_AWARE_POLICY_VERSION;
    const conditions =
      usesMarketConditions || usesPressure
        ? getMarketConditions({
            candles,
            ticker,
            target: forecast.target,
            now: capturedAt,
            horizonMinutes: (forecast.expiresAt - capturedAt) / 60_000,
            forecast: estimate,
          })
        : null;
    const marketRisk = usesMarketConditions
      ? getPublicationRisk({
          conditions,
          stream,
          direction: getQualifyingDirection(estimate),
          target: forecast.target,
        })
      : null;
    // Reloading never reconstructs a consensus from unseen quotes. Fresh observations
    // must establish it again; the saved observation deadline is never moved.
    if (
      hasRequestError ||
      !ticker ||
      ticker.time < forecast.analysis.startedAt ||
      ticker.receivedAt < forecast.analysis.startedAt ||
      ticker.time < (observations.current.samples.at(-1)?.quoteTime ?? 0) ||
      estimate.modelVersion !== forecast.modelVersion ||
      (marketRisk && !marketRisk.canPublish)
    ) {
      estimate.available = false;
    }
    observations.current.samples = updateConfirmationSamples(observations.current.samples, {
      time: capturedAt,
      quoteTime: ticker?.time,
      direction: getQualifyingDirection(estimate, forecast.analysis.policyVersion),
    });
    const nextProgress = getFixedPredictionProgress({
      analysis: forecast.analysis,
      samples: observations.current.samples,
      estimate,
      now: capturedAt,
    });
    if (marketRisk && !marketRisk.canPublish) {
      nextProgress.reason = marketRisk.reason;
      if (nextProgress.withholdingReason !== 'insufficient-time')
        nextProgress.withholdingReason = marketRisk.code;
    }
    if (estimate.modelVersion !== forecast.modelVersion) {
      nextProgress.reason =
        'The saved model version is unavailable. This fixed call cannot be issued.';
      if (nextProgress.withholdingReason !== 'insufficient-time')
        nextProgress.withholdingReason = 'model-unavailable';
    }
    if (
      (usesMarketConditions || usesPressure) &&
      ['ready', 'withheld'].includes(nextProgress.phase)
    ) {
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
            price: ticker.price,
            aboveProbability: estimate.aboveProbability,
            belowProbability: estimate.belowProbability,
            direction: estimate.direction,
            status: 'pending',
            ...(usesPressure
              ? {
                  calculationMode: estimate.pressure?.applied
                    ? 'pressure-adjusted'
                    : 'baseline-fallback',
                }
              : {}),
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
  }, [forecast, candles, ticker, now, hasRequestError, stream, dispatch]);

  return progress;
}

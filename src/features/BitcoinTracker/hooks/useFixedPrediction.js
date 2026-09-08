import { useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { fixedForecastPublished, fixedForecastWithheld } from '../state/slices/trackerSlice';
import { getForecast } from '../utils/forecast.utils';
import {
  getFixedPredictionProgress,
  getQualifyingDirection,
  updateConfirmationSamples,
} from '../utils/fixedPrediction.utils';

export default function useFixedPrediction({ forecast, candles, ticker, now, hasRequestError }) {
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
    const estimate = getForecast({
      candles,
      ticker,
      target: forecast.target,
      now: capturedAt,
      horizonMinutes: (forecast.expiresAt - capturedAt) / 60_000,
    });
    // Reloading never reconstructs a consensus from unseen quotes. Fresh observations
    // must establish it again; the saved observation deadline is never moved.
    if (
      hasRequestError ||
      !ticker ||
      ticker.time < forecast.analysis.startedAt ||
      ticker.receivedAt < forecast.analysis.startedAt ||
      ticker.time < (observations.current.samples.at(-1)?.quoteTime ?? 0) ||
      estimate.modelVersion !== forecast.modelVersion
    ) {
      estimate.available = false;
    }
    observations.current.samples = updateConfirmationSamples(observations.current.samples, {
      time: capturedAt,
      quoteTime: ticker?.time,
      direction: getQualifyingDirection(estimate),
    });
    const nextProgress = getFixedPredictionProgress({
      analysis: forecast.analysis,
      samples: observations.current.samples,
      estimate,
      now: capturedAt,
    });
    if (estimate.modelVersion !== forecast.modelVersion) {
      nextProgress.reason =
        'The saved model version is unavailable. This fixed call cannot be issued.';
      if (nextProgress.withholdingReason !== 'insufficient-time')
        nextProgress.withholdingReason = 'model-unavailable';
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
  }, [forecast, candles, ticker, now, hasRequestError, dispatch]);

  return progress;
}

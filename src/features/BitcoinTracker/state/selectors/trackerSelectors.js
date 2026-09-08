import { createSelector } from '@reduxjs/toolkit';

export const selectTrackerState = (state) => state.tracker;
export const selectForecasts = (state) => selectTrackerState(state).forecasts;
export const selectScheduledForecast = (state) =>
  selectTrackerState(state).scheduledForecast ?? null;
export const selectActiveForecast = createSelector(
  [selectForecasts],
  (forecasts) => forecasts.find((forecast) => forecast.status === 'pending') ?? null,
);
export const selectHasForecastInProgress = createSelector(
  [selectActiveForecast, selectScheduledForecast],
  (forecast, schedule) => forecast !== null || schedule?.status === 'scheduled',
);

export const selectJournalSummary = createSelector([selectForecasts], (forecasts) => {
  const resolved = forecasts.filter((forecast) => forecast.status === 'resolved');
  const scored = resolved.filter((forecast) => typeof forecast.correct === 'boolean');
  const correctCount = scored.filter((forecast) => forecast.correct).length;
  const probabilityResults = resolved.filter(
    (forecast) =>
      ['above', 'below'].includes(forecast.outcome) &&
      Number.isFinite(forecast.aboveProbability) &&
      forecast.aboveProbability >= 0 &&
      forecast.aboveProbability <= 1 &&
      Number.isFinite(forecast.belowProbability) &&
      forecast.belowProbability >= 0 &&
      forecast.belowProbability <= 1 &&
      Math.abs(forecast.aboveProbability + forecast.belowProbability - 1) <= 0.000001,
  );
  const totalSquaredError = probabilityResults.reduce(
    (total, forecast) =>
      total + (forecast.aboveProbability - (forecast.outcome === 'above' ? 1 : 0)) ** 2,
    0,
  );

  return {
    resolvedCount: resolved.length,
    scoredCount: scored.length,
    correctCount,
    accuracy: scored.length === 0 ? null : correctCount / scored.length,
    brierScore:
      probabilityResults.length === 0 ? null : totalSquaredError / probabilityResults.length,
  };
});

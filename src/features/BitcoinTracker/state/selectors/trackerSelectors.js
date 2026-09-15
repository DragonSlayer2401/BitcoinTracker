import { createSelector } from '@reduxjs/toolkit';
import { KALSHI_OUTCOME_DEFINITION } from '../../utils/kalshi/contract.utils';

export const selectTrackerState = (state) => state.tracker;
export const selectForecasts = (state) => selectTrackerState(state).forecasts;
export const selectScheduledForecast = (state) =>
  selectTrackerState(state).scheduledForecast ?? null;
export const selectLatestForecast = createSelector(
  [selectForecasts],
  (forecasts) =>
    [...forecasts].sort(
      (left, right) =>
        right.startsAt - left.startsAt ||
        Number(Number.isFinite(right.aboveProbability)) -
          Number(Number.isFinite(left.aboveProbability)) ||
        right.createdAt - left.createdAt,
    )[0] ?? null,
);
export const selectActiveForecast = createSelector(
  [selectForecasts],
  (forecasts) =>
    [...forecasts]
      .filter((forecast) => forecast.status === 'analyzing')
      .sort((first, second) => first.analysis.earliestAt - second.analysis.earliestAt)[0] ??
    [...forecasts]
      .filter((forecast) => forecast.status === 'pending')
      .sort((first, second) => second.createdAt - first.createdAt)[0] ??
    null,
);
export const selectHasForecastInProgress = createSelector(
  [selectActiveForecast, selectScheduledForecast],
  (forecast, schedule) => forecast !== null || schedule?.status === 'scheduled',
);

function getJournalSummary(forecasts) {
  const resolved = forecasts.filter((forecast) => forecast.status === 'resolved');
  const scored = resolved.filter((forecast) => typeof forecast.correct === 'boolean');
  const correctCount = scored.filter((forecast) => forecast.correct).length;
  const analysisCount = forecasts.filter((forecast) => forecast.status === 'analyzing').length;
  const withheldCount = forecasts.filter((forecast) => forecast.status === 'withheld').length;
  const callCount = forecasts.filter(
    (forecast) =>
      forecast.analysis &&
      ['pending', 'resolved', 'unobserved', 'awaiting-settlement'].includes(forecast.status),
  ).length;
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
    analysisCount,
    withheldCount,
    callCount,
    coverage: callCount + withheldCount === 0 ? null : callCount / (callCount + withheldCount),
    resolvedCount: resolved.length,
    scoredCount: scored.length,
    correctCount,
    accuracy: scored.length === 0 ? null : correctCount / scored.length,
    brierScore:
      probabilityResults.length === 0 ? null : totalSquaredError / probabilityResults.length,
  };
}

export const selectJournalSummary = createSelector([selectForecasts], (forecasts) =>
  getJournalSummary(
    forecasts.filter((forecast) => forecast.outcomeDefinition === KALSHI_OUTCOME_DEFINITION),
  ),
);
export const selectJournalOutcomeGroups = createSelector([selectForecasts], (forecasts) => ({
  kalshi: getJournalSummary(
    forecasts.filter((forecast) => forecast.outcomeDefinition === KALSHI_OUTCOME_DEFINITION),
  ),
}));

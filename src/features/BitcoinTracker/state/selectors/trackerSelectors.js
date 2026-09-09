import { createSelector } from '@reduxjs/toolkit';
import { DEADLINE_OUTCOME_DEFINITION } from '../../utils/outcome.utils';
import {
  MARKET_AWARE_POLICY_VERSION,
  PRESSURE_POLICY_VERSION,
} from '../../utils/fixedPrediction.utils';

export const selectTrackerState = (state) => state.tracker;
export const selectForecasts = (state) => selectTrackerState(state).forecasts;
export const selectScheduledForecast = (state) =>
  selectTrackerState(state).scheduledForecast ?? null;
export const selectActiveForecast = createSelector(
  [selectForecasts],
  (forecasts) =>
    forecasts.find((forecast) => ['analyzing', 'pending'].includes(forecast.status)) ?? null,
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
      forecast.analysis && ['pending', 'resolved', 'unobserved'].includes(forecast.status),
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

export const selectJournalSummary = createSelector([selectForecasts], getJournalSummary);
export const selectJournalOutcomeGroups = createSelector([selectForecasts], (forecasts) => ({
  pressure: getJournalSummary(
    forecasts.filter(
      (forecast) =>
        forecast.outcomeDefinition === DEADLINE_OUTCOME_DEFINITION &&
        forecast.analysis?.policyVersion === PRESSURE_POLICY_VERSION,
    ),
  ),
  marketAware: getJournalSummary(
    forecasts.filter(
      (forecast) =>
        forecast.outcomeDefinition === DEADLINE_OUTCOME_DEFINITION &&
        forecast.analysis?.policyVersion === MARKET_AWARE_POLICY_VERSION,
    ),
  ),
  hasMarketAware: forecasts.some(
    (forecast) =>
      forecast.outcomeDefinition === DEADLINE_OUTCOME_DEFINITION &&
      forecast.analysis?.policyVersion === MARKET_AWARE_POLICY_VERSION,
  ),
  // Retain the outcome-only aggregation for existing consumers. Visible current-policy
  // metrics use the pressure group so different publication rules are never pooled.
  deadline: getJournalSummary(
    forecasts.filter((forecast) => forecast.outcomeDefinition === DEADLINE_OUTCOME_DEFINITION),
  ),
  legacy: getJournalSummary(
    forecasts.filter((forecast) => forecast.outcomeDefinition !== DEADLINE_OUTCOME_DEFINITION),
  ),
  hasLegacy: forecasts.some(
    (forecast) => forecast.outcomeDefinition !== DEADLINE_OUTCOME_DEFINITION,
  ),
}));

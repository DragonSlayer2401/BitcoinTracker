import {
  PRESSURE_POLICY_VERSION,
  KALSHI_CHECKPOINT_POLICY_VERSION,
} from '../fixedPrediction.utils';
import { KALSHI_OUTCOME_DEFINITION, isSameKalshiContract } from '../kalshi/contract.utils';
import { getValidatedForecast } from './forecastValidation.utils';
import { getValidatedScheduledForecast } from './scheduleValidation.utils';
import { isLearnedModelVersion } from './modelValidation.utils';
import { isRecord, hasOwnField, hasExactFields } from './validation.utils';

export const JOURNAL_VERSION = 7;
const MAXIMUM_FORECASTS = 100;

export function getValidatedJournal(value) {
  if (!Array.isArray(value) || value.length > MAXIMUM_FORECASTS) return null;

  const forecasts = value.map(getValidatedForecast);
  const active = forecasts.filter((forecast) =>
    ['analyzing', 'pending'].includes(forecast?.status),
  );
  const hasValidActiveCheckpoints =
    active.every(
      (forecast) =>
        forecast.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
        forecast.analysis.policyVersion === KALSHI_CHECKPOINT_POLICY_VERSION &&
        isSameKalshiContract(active[0].kalshiMarket, forecast.kalshiMarket),
    ) && new Set(active.map((forecast) => forecast.checkpointMinutes)).size === active.length;
  if (
    forecasts.some((forecast) => forecast === null) ||
    new Set(forecasts.map((forecast) => forecast.id)).size !== forecasts.length ||
    (active.length > 1 && !hasValidActiveCheckpoints)
  ) {
    return null;
  }

  return forecasts.sort((first, second) => second.createdAt - first.createdAt);
}

export function getValidatedJournalState(value) {
  if (!hasExactFields(value, ['forecasts', 'scheduledForecast'])) return null;

  const forecasts = getValidatedJournal(value.forecasts);
  const scheduledForecast = getValidatedScheduledForecast(value.scheduledForecast);
  if (
    forecasts === null ||
    (value.scheduledForecast !== null && scheduledForecast === null) ||
    (scheduledForecast !== null &&
      forecasts.some(
        (forecast) =>
          ['analyzing', 'pending'].includes(forecast.status) ||
          forecast.id === scheduledForecast.id,
      ))
  ) {
    return null;
  }

  return { forecasts, scheduledForecast };
}

export function getValidatedSavedJournal(parsedJournal) {
  if (
    !isRecord(parsedJournal) ||
    ![1, 2, 3, 4, 5, 6, JOURNAL_VERSION].includes(parsedJournal.version) ||
    Object.keys(parsedJournal).length !== (parsedJournal.version === 1 ? 2 : 3)
  ) {
    return null;
  }
  const journal = getValidatedJournalState({
    forecasts: parsedJournal.forecasts,
    scheduledForecast: parsedJournal.version === 1 ? null : parsedJournal.scheduledForecast,
  });
  if (journal === null) return null;
  if (
    parsedJournal.version < 3 &&
    journal.forecasts.some((forecast) => hasOwnField(forecast, 'analysis'))
  ) {
    return null;
  }
  if (
    parsedJournal.version < 4 &&
    (journal.scheduledForecast?.outcomeDefinition ||
      journal.forecasts.some((forecast) => forecast.outcomeDefinition))
  )
    return null;
  if (
    parsedJournal.version < 5 &&
    (journal.scheduledForecast?.policyVersion ||
      journal.forecasts.some(
        (forecast) => forecast.analysis?.policyVersion === PRESSURE_POLICY_VERSION,
      ))
  )
    return null;
  if (
    parsedJournal.version < 7 &&
    journal.forecasts.some((forecast) => forecast.outcomeDefinition === KALSHI_OUTCOME_DEFINITION)
  )
    return null;
  if (
    parsedJournal.version < 6 &&
    journal.forecasts.some((forecast) => isLearnedModelVersion(forecast.modelVersion))
  )
    return null;
  return journal;
}

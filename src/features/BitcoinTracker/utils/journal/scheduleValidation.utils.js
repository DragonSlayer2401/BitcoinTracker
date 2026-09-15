import {
  KALSHI_POLICY_VERSION,
  KALSHI_CHECKPOINT_POLICY_VERSION,
  isKalshiCheckpointSelection,
  PRESSURE_POLICY_VERSION,
} from '../fixedPrediction.utils';
import { DEADLINE_OUTCOME_DEFINITION } from '../outcome.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import {
  isRecord,
  isTimestamp,
  isPositiveNumber,
  isIdentifier,
  hasOwnField,
  hasExactFields,
  FORECAST_DURATION_MS,
} from './validation.utils';

const MAXIMUM_SCHEDULE_DELAY_MS = 24 * 60 * 60 * 1000;
const scheduleFields = ['id', 'createdAt', 'startsAt', 'expiresAt', 'target', 'status'];

export function getValidatedScheduledForecast(value) {
  const usesKalshi = value?.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  const hasDefinition = isRecord(value) && hasOwnField(value, 'outcomeDefinition');
  const hasPolicy = isRecord(value) && hasOwnField(value, 'policyVersion');
  const usesCheckpoint = value?.policyVersion === KALSHI_CHECKPOINT_POLICY_VERSION;
  const checkpoints = Array.isArray(value?.checkpointMinutes)
    ? value.checkpointMinutes
    : [value?.checkpointMinutes];
  const fields = [...scheduleFields];
  if (hasDefinition) fields.push('outcomeDefinition');
  if (hasPolicy) fields.push('policyVersion');
  if (usesCheckpoint) fields.push('checkpointMinutes');
  if (isRecord(value) && hasOwnField(value, 'captureOrigin')) fields.push('captureOrigin');
  if (usesKalshi) fields.push('marketTicker', 'eventTicker');
  if (
    !hasExactFields(value, fields) ||
    (hasDefinition &&
      ![DEADLINE_OUTCOME_DEFINITION, KALSHI_OUTCOME_DEFINITION].includes(
        value.outcomeDefinition,
      )) ||
    (hasPolicy &&
      (!hasDefinition ||
        !(
          usesKalshi
            ? [KALSHI_POLICY_VERSION, KALSHI_CHECKPOINT_POLICY_VERSION]
            : [PRESSURE_POLICY_VERSION]
        ).includes(value.policyVersion))) ||
    (usesCheckpoint && (!usesKalshi || !isKalshiCheckpointSelection(checkpoints))) ||
    (hasOwnField(value, 'captureOrigin') &&
      !['automatic', 'manual'].includes(value.captureOrigin)) ||
    (usesKalshi &&
      (!hasPolicy ||
        typeof value.marketTicker !== 'string' ||
        !/^KXBTC15M-\d{2}[A-Z]{3}\d{6}-\d{2}$/.test(value.marketTicker) ||
        typeof value.eventTicker !== 'string' ||
        !/^KXBTC15M-\d{2}[A-Z]{3}\d{6}$/.test(value.eventTicker) ||
        !value.marketTicker.startsWith(`${value.eventTicker}-`) ||
        value.startsAt % 900_000 !== 0 ||
        value.target !== null)) ||
    !isIdentifier(value.id) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.startsAt) ||
    !isTimestamp(value.expiresAt) ||
    value.startsAt <= value.createdAt ||
    value.startsAt - value.createdAt > MAXIMUM_SCHEDULE_DELAY_MS ||
    value.expiresAt - value.startsAt !== FORECAST_DURATION_MS ||
    (!usesKalshi && (!isPositiveNumber(value.target) || value.target > 1_000_000_000)) ||
    !['scheduled', 'missed'].includes(value.status)
  ) {
    return null;
  }

  return Object.fromEntries(
    fields.map((field) => [
      field,
      field === 'checkpointMinutes' && Array.isArray(value[field])
        ? [...value[field]]
        : value[field],
    ]),
  );
}

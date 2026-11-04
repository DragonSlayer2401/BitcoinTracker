import { createKalshiForecastRecord } from './forecastRecord.utils';
import { isKalshiCheckpointMinutes } from '../fixedPrediction.utils';

/** Each checkpoint owns a separate immutable prediction for the same official event. */
export function createKalshiForecastBatch({ id, checkpointMinutes, ...input }) {
  if (
    !Array.isArray(checkpointMinutes) ||
    !checkpointMinutes.length ||
    checkpointMinutes.some((minutes) => !isKalshiCheckpointMinutes(minutes)) ||
    new Set(checkpointMinutes).size !== checkpointMinutes.length
  )
    return null;
  return [...checkpointMinutes]
    .sort((left, right) => right - left)
    .map((minutes) =>
      createKalshiForecastRecord({ ...input, id: `${id}:${minutes}`, checkpointMinutes: minutes }),
    );
}

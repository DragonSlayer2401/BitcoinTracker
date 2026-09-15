import { getResearchForecast } from './researchForecast.utils';

export const RESEARCH_EXPERIMENT_VERSION = 'kalshi-ablation-v1';
export const RESEARCH_INPUT_SNAPSHOT_VERSION = 'kalshi-input-replay-v1';
export const RESEARCH_VARIANT_NAMES = Object.freeze([
  'settlement-only',
  'spot-only',
  'futures-only',
  'combined',
]);

const observationTimes = new Set([
  'time',
  'receivedAt',
  'receiptAt',
  'sourceTime',
  'sourceTimestamp',
  'asOf',
  'completeSince',
  'confirmedThrough',
  'heartbeatAt',
  'lastMessageAt',
  'lastTradeAt',
  'lastLiquidationAt',
  'updatedAt',
  'snapshotAt',
  'startAt',
  'endAt',
  'startPriceAt',
  'endPriceAt',
  'connectedAt',
  'connectionStartedAt',
  'lastPongAt',
  'lastPingAt',
  'candlesReceivedAt',
  'fetchedAt',
]);
const modelTimes = new Set([
  'trainedAt',
  'trainingCutoffAt',
  'calibrationCutoffAt',
  'evaluationCutoffAt',
  'shadowStartsAt',
  'activatedAt',
  'retiredAt',
  'evaluatedAt',
]);
const outcomeFields = new Set([
  'outcome',
  'outcomes',
  'kalshiOutcome',
  'kalshiOutcomes',
  'observedPrice',
  'observedAt',
  'settlementPrice',
  'result',
]);
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;

function getCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(getCanonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, getCanonicalValue(value[key])]),
    );
  }
  return value;
}

function getTimingAssessment(input, models, capturedAt, windowStartAt) {
  const errors = [];
  const limitations = [];
  if (!validTime(capturedAt) || input?.now !== capturedAt)
    errors.push('The input clock must equal the saved capture time.');
  if (windowStartAt !== null && (!validTime(windowStartAt) || windowStartAt > capturedAt))
    errors.push('The learning window begins after the saved capture time.');

  function inspect(value, path, times, rejectOutcomes) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (rejectOutcomes && outcomeFields.has(key) && child !== null && child !== undefined) {
        errors.push(`${childPath} is an outcome, not a contemporaneous prediction input.`);
      }
      if (times.has(key) && child !== null && child !== undefined) {
        if (!validTime(child)) errors.push(`${childPath} has an invalid observation timestamp.`);
        else if (child > capturedAt)
          errors.push(`${childPath} was observed or received after capture.`);
      }
      inspect(child, childPath, times, rejectOutcomes);
    }
  }

  // Contract starts/expiry are scheduled event times, never evidence of receipt. Every actual
  // observation/receipt timestamp is checked, including nested history and impact samples.
  inspect(input, 'input', observationTimes, true);
  for (const [name, model] of Object.entries({
    active: models?.active,
    candidate: models?.candidate,
    earlyCandidate: models?.earlyCandidate ?? models?.early?.candidate,
  })) {
    inspect(model, `models.${name}`, modelTimes, false);
  }

  if (input?.ticker && !validTime(input.ticker.receivedAt))
    limitations.push('The spot quote has no local receipt timestamp.');
  if (input?.candles?.length && !validTime(input.candlesReceivedAt))
    limitations.push('Candle history has no batch receipt timestamp.');
  if (input?.benchmark) {
    if (!validTime(input.benchmark.receivedAt))
      limitations.push('BRTI history has no batch receipt timestamp.');
    if (input.benchmark.samples?.some((sample) => !validTime(sample?.receivedAt)))
      limitations.push('BRTI samples have batch provenance only, not per-message receipt times.');
  }
  if (input?.stream?.flow)
    limitations.push('Spot flow retains aggregate inputs, not the original exchange message log.');
  if (input?.derivatives)
    limitations.push(
      'Futures flow retains aggregate inputs, not the original exchange message log.',
    );
  return {
    replayable: errors.length === 0,
    receiptTimeVerified: errors.length === 0 && limitations.length === 0,
    errors,
    limitations,
  };
}

/** Capture the complete JSON calculation boundary. No price history is trimmed or backfilled. */
export function createResearchInputSnapshot(
  input,
  models = {},
  windowStartAt = null,
  forecast = null,
) {
  const omittedFunctions = [];
  const invalidNumbers = [];
  const copy = JSON.parse(
    JSON.stringify({ input, models, windowStartAt }, (key, value) => {
      // Stream methods are not inputs to the pure calculation and cannot be serialized.
      if (typeof value === 'function') omittedFunctions.push(key);
      if (typeof value === 'number' && !Number.isFinite(value)) invalidNumbers.push(key);
      return value;
    }),
  );
  const capturedAt = copy.input?.now;
  const timing = getTimingAssessment(copy.input, copy.models, capturedAt, copy.windowStartAt);
  if (invalidNumbers.length) {
    timing.errors.push('Non-finite numerical inputs cannot be reproduced by a JSON snapshot.');
    timing.replayable = false;
    timing.receiptTimeVerified = false;
  }
  if (omittedFunctions.length) {
    timing.limitations.push('Non-JSON stream methods were omitted; all JSON inputs were retained.');
    timing.receiptTimeVerified = false;
  }
  const estimate = forecast ?? getResearchForecast(input, models, windowStartAt);
  return {
    version: RESEARCH_INPUT_SNAPSHOT_VERSION,
    capturedAt,
    ...copy,
    expectedExperiment: JSON.parse(JSON.stringify(estimate.researchExperiment)),
    timing,
  };
}

/** Re-run the saved inputs and frozen model artifacts; later results are never replay inputs. */
export function replayResearchInputSnapshot(snapshot) {
  if (
    snapshot?.version !== RESEARCH_INPUT_SNAPSHOT_VERSION ||
    !snapshot.input ||
    snapshot.expectedExperiment?.version !== RESEARCH_EXPERIMENT_VERSION ||
    snapshot.expectedExperiment.capturedAt !== snapshot.capturedAt
  ) {
    throw new Error('Unsupported or incomplete research input snapshot.');
  }
  const timing = getTimingAssessment(
    snapshot.input,
    snapshot.models,
    snapshot.capturedAt,
    snapshot.windowStartAt,
  );
  if (snapshot.timing?.replayable !== true || !timing.replayable) {
    throw new Error(
      `Research snapshot cannot be replayed safely: ${timing.errors.join(' ') || snapshot.timing?.errors?.join(' ') || 'Capture validation failed.'}`,
    );
  }
  const forecast = getResearchForecast(snapshot.input, snapshot.models, snapshot.windowStartAt);
  if (
    JSON.stringify(getCanonicalValue(forecast.researchExperiment)) !==
    JSON.stringify(getCanonicalValue(snapshot.expectedExperiment))
  ) {
    throw new Error('Research replay differs from the saved variants or production prediction.');
  }
  return forecast;
}

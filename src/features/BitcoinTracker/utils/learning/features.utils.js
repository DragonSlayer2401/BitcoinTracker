import { logit } from './statistics.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';

export const LEARNING_FEATURE_VERSION = 'deadline-reversal-features-v2';
export const LEARNING_FEATURE_NAMES = Object.freeze([
  'baselineLogOdds',
  'targetDistance',
  'remainingFraction',
  'return1',
  'return3',
  'return5',
  'return15',
  'acceleration3',
  'relativeVolume',
  'rangeRatio',
  'closePosition',
  'spread',
  'buyPressure15',
  'buyPressure60',
  'buyPressure180',
  'pressureChange',
  'priceResponseToPressure',
  'depthImbalance',
  'depthChange',
  'flow15Available',
  'flow60Available',
  'flow180Available',
  'depthAvailable',
  'depthChangeAvailable',
  'volumeAvailable',
  'spreadAvailable',
]);
export const LEARNING_AVAILABILITY_INDEXES = [19, 20, 21, 22, 23, 24, 25];
const bounded = (value, limit = 8) => Math.max(-limit, Math.min(limit, value));
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function getLearningPipeline(snapshot) {
  if (
    typeof snapshot?.baselineModelVersion !== 'string' ||
    !/^[a-z0-9-]{1,100}$/.test(snapshot.baselineModelVersion) ||
    !['cf-brti', 'coinbase-proxy'].includes(snapshot.referenceSource) ||
    !['cf-brti-history', 'coinbase-candles'].includes(snapshot.featureInputSource)
  )
    return null;
  return {
    baselineModelVersion: snapshot.baselineModelVersion,
    referenceSource: snapshot.referenceSource,
    featureInputSource: snapshot.featureInputSource,
  };
}

export function matchesLearningPipeline(snapshot, pipeline) {
  const current = getLearningPipeline(snapshot);
  return Boolean(
    current &&
    pipeline &&
    current.baselineModelVersion === pipeline.baselineModelVersion &&
    current.referenceSource === pipeline.referenceSource &&
    current.featureInputSource === pipeline.featureInputSource,
  );
}

/** Missing optional feeds get explicit missingness indicators, never invented historical data. */
export function getLearningFeatures({
  forecast,
  conditions,
  stream,
  spot,
  target,
  now,
  expiresAt,
  outcomeDefinition = forecast?.outcomeDefinition ?? KALSHI_OUTCOME_DEFINITION,
} = {}) {
  const features = conditions?.features;
  const unavailable = (reason) => ({
    schemaVersion: LEARNING_FEATURE_VERSION,
    available: false,
    reason,
    values: null,
    featureCutoffAt: timestamp(now) ? now : null,
    target,
    expiresAt,
    outcomeDefinition,
    baselineModelVersion: forecast?.modelVersion ?? null,
    referenceSource: forecast?.kalshi?.referenceSource ?? null,
    featureInputSource: forecast?.kalshi?.priceDynamicsSource ?? null,
  });
  if (
    outcomeDefinition !== KALSHI_OUTCOME_DEFINITION ||
    !forecast?.available ||
    !conditions?.available ||
    !features ||
    !timestamp(now) ||
    !timestamp(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > 900_000 ||
    !finite(spot) ||
    spot <= 0 ||
    !finite(target) ||
    target <= 0 ||
    !finite(forecast.aboveProbability) ||
    forecast.aboveProbability < 0 ||
    forecast.aboveProbability > 1 ||
    !timestamp(features.latestCompletedAt) ||
    features.latestCompletedAt > now ||
    now - features.latestCompletedAt > 120_000
  )
    return unavailable('Fresh, contemporaneous price-history features are required.');
  const required = [
    'effectiveMinuteVolatility',
    'logReturn1Minute',
    'logReturn3Minutes',
    'logReturn5Minutes',
    'logReturn15Minutes',
    'logReturnAcceleration3Minutes',
    'latestRangeToMedianRatio',
  ];
  if (
    required.some((name) => !finite(features[name])) ||
    features.effectiveMinuteVolatility <= 0 ||
    (features.relativeVolume5To30Minutes != null &&
      (!finite(features.relativeVolume5To30Minutes) || features.relativeVolume5To30Minutes < 0)) ||
    (features.spreadFraction != null &&
      (!finite(features.spreadFraction) || features.spreadFraction < 0)) ||
    (features.closePosition !== null &&
      (!finite(features.closePosition) || features.closePosition < 0 || features.closePosition > 1))
  )
    return unavailable('Required price-history features are missing or invalid.');
  const horizon = (expiresAt - now) / 60_000;
  const volumeAvailable = finite(features.relativeVolume5To30Minutes);
  const spreadAvailable = finite(features.spreadFraction);
  const sigma = features.effectiveMinuteVolatility;
  const targetDistance = Math.log(spot / target) / (sigma * Math.sqrt(horizon));
  const heartbeat = stream?.quality?.heartbeatAt;
  const freshFlow =
    ['live', 'warming'].includes(stream?.status) &&
    timestamp(heartbeat) &&
    heartbeat <= now &&
    now - heartbeat <= 5000;
  const windows = [15, 60, 180].map((seconds) => {
    const window = stream?.flow?.windows?.[seconds];
    const available =
      freshFlow &&
      window?.available === true &&
      finite(window.imbalance) &&
      Math.abs(window.imbalance) <= 1;
    return { available, imbalance: available ? window.imbalance : 0 };
  });
  const liquidity = stream?.liquidity;
  const depthAvailable =
    liquidity?.available === true &&
    timestamp(liquidity.updatedAt) &&
    liquidity.updatedAt <= now &&
    now - liquidity.updatedAt <= 5000 &&
    finite(liquidity.depth?.[10]?.imbalance) &&
    Math.abs(liquidity.depth[10].imbalance) <= 1;
  const depthChangeAvailable =
    depthAvailable &&
    liquidity.depthChange60?.available === true &&
    finite(liquidity.depthChange60.bidFraction) &&
    finite(liquidity.depthChange60.askFraction);
  const pressureChange =
    windows[0].available && windows[1].available ? windows[0].imbalance - windows[1].imbalance : 0;
  const values = [
    bounded(logit(forecast.aboveProbability)),
    bounded(targetDistance),
    horizon / 15,
    ...[1, 3, 5, 15].map((minutes) =>
      bounded(
        features[`logReturn${minutes === 1 ? '1Minute' : `${minutes}Minutes`}`] /
          (sigma * Math.sqrt(minutes)),
      ),
    ),
    bounded(features.logReturnAcceleration3Minutes / (sigma * Math.sqrt(6))),
    volumeAvailable ? bounded(Math.log(Math.max(1e-6, features.relativeVolume5To30Minutes))) : 0,
    bounded(features.latestRangeToMedianRatio),
    features.closePosition === null ? 0 : features.closePosition - 0.5,
    spreadAvailable ? bounded(features.spreadFraction / sigma) : 0,
    ...windows.map((window) => window.imbalance),
    pressureChange,
    windows[1].available ? bounded(features.logReturn1Minute / sigma) * windows[1].imbalance : 0,
    depthAvailable ? liquidity.depth[10].imbalance : 0,
    depthChangeAvailable
      ? bounded(liquidity.depthChange60.bidFraction - liquidity.depthChange60.askFraction)
      : 0,
    ...windows.map((window) => Number(window.available)),
    Number(depthAvailable),
    Number(depthChangeAvailable),
    Number(volumeAvailable),
    Number(spreadAvailable),
  ];
  if (!values.every(finite)) return unavailable('Learning features cannot be calculated safely.');
  return {
    schemaVersion: LEARNING_FEATURE_VERSION,
    available: true,
    baselineAboveProbability: forecast.aboveProbability,
    targetDistance,
    reason: null,
    values,
    featureCutoffAt: now,
    target,
    expiresAt,
    outcomeDefinition,
    baselineModelVersion: forecast.modelVersion,
    referenceSource: forecast.kalshi?.referenceSource ?? null,
    featureInputSource: forecast.kalshi?.priceDynamicsSource ?? null,
    settlementKnownFraction: (forecast.kalshi?.observedSampleCount ?? 0) / 60,
    missingFeeds: [
      ...windows.flatMap((window, index) =>
        window.available ? [] : [`flow-${[15, 60, 180][index]}`],
      ),
      ...(depthAvailable ? [] : ['depth']),
      ...(depthChangeAvailable ? [] : ['depth-change']),
      ...(volumeAvailable ? [] : ['volume']),
      ...(spreadAvailable ? [] : ['spread']),
    ],
  };
}

export function isLearningFeatureSnapshot(
  snapshot,
  { target, expiresAt, cutoffAt, outcomeDefinition } = {},
) {
  return Boolean(
    snapshot?.available === true &&
    snapshot.schemaVersion === LEARNING_FEATURE_VERSION &&
    getLearningPipeline(snapshot) !== null &&
    Array.isArray(snapshot.values) &&
    snapshot.values.length === LEARNING_FEATURE_NAMES.length &&
    snapshot.values.every((value) => finite(value) && Math.abs(value) <= 16) &&
    LEARNING_AVAILABILITY_INDEXES.every(
      (index) => snapshot.values[index] === 0 || snapshot.values[index] === 1,
    ) &&
    finite(snapshot.baselineAboveProbability) &&
    snapshot.baselineAboveProbability >= 0 &&
    snapshot.baselineAboveProbability <= 1 &&
    finite(snapshot.targetDistance) &&
    snapshot.target === target &&
    snapshot.expiresAt === expiresAt &&
    snapshot.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    (!outcomeDefinition || snapshot.outcomeDefinition === outcomeDefinition) &&
    (snapshot.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION ||
      (['cf-brti', 'coinbase-proxy'].includes(snapshot.referenceSource) &&
        finite(snapshot.settlementKnownFraction) &&
        snapshot.settlementKnownFraction >= 0 &&
        snapshot.settlementKnownFraction <= 1)) &&
    timestamp(snapshot.featureCutoffAt) &&
    snapshot.featureCutoffAt === cutoffAt &&
    cutoffAt < expiresAt,
  );
}

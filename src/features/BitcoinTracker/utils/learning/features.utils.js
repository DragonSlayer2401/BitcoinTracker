import { logit } from './statistics.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';

export const LEARNING_FEATURE_VERSION = 'deadline-reversal-features-v2';
// Persisted model coefficients address these positions. Reordering requires a new feature version.
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
const getBoundedFeatureValue = (value, limit = 8) => Math.max(-limit, Math.min(limit, value));
const isValidTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

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
  const snapshotPipeline = getLearningPipeline(snapshot);
  return Boolean(
    snapshotPipeline &&
    pipeline &&
    snapshotPipeline.baselineModelVersion === pipeline.baselineModelVersion &&
    snapshotPipeline.referenceSource === pipeline.referenceSource &&
    snapshotPipeline.featureInputSource === pipeline.featureInputSource,
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
  const getUnavailableSnapshot = (reason) => ({
    schemaVersion: LEARNING_FEATURE_VERSION,
    available: false,
    reason,
    values: null,
    featureCutoffAt: isValidTimestamp(now) ? now : null,
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
    !isValidTimestamp(now) ||
    !isValidTimestamp(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > 900_000 ||
    !isFiniteNumber(spot) ||
    spot <= 0 ||
    !isFiniteNumber(target) ||
    target <= 0 ||
    !isFiniteNumber(forecast.aboveProbability) ||
    forecast.aboveProbability < 0 ||
    forecast.aboveProbability > 1 ||
    !isValidTimestamp(features.latestCompletedAt) ||
    features.latestCompletedAt > now ||
    now - features.latestCompletedAt > 120_000
  )
    return getUnavailableSnapshot('Fresh, contemporaneous price-history features are required.');
  const requiredFeatureNames = [
    'effectiveMinuteVolatility',
    'logReturn1Minute',
    'logReturn3Minutes',
    'logReturn5Minutes',
    'logReturn15Minutes',
    'logReturnAcceleration3Minutes',
    'latestRangeToMedianRatio',
  ];
  if (
    requiredFeatureNames.some((name) => !isFiniteNumber(features[name])) ||
    features.effectiveMinuteVolatility <= 0 ||
    (features.relativeVolume5To30Minutes != null &&
      (!isFiniteNumber(features.relativeVolume5To30Minutes) ||
        features.relativeVolume5To30Minutes < 0)) ||
    (features.spreadFraction != null &&
      (!isFiniteNumber(features.spreadFraction) || features.spreadFraction < 0)) ||
    (features.closePosition !== null &&
      (!isFiniteNumber(features.closePosition) ||
        features.closePosition < 0 ||
        features.closePosition > 1))
  )
    return getUnavailableSnapshot('Required price-history features are missing or invalid.');
  const horizonMinutes = (expiresAt - now) / 60_000;
  const volumeAvailable = isFiniteNumber(features.relativeVolume5To30Minutes);
  const spreadAvailable = isFiniteNumber(features.spreadFraction);
  const minuteVolatility = features.effectiveMinuteVolatility;
  const targetDistance = Math.log(spot / target) / (minuteVolatility * Math.sqrt(horizonMinutes));
  const heartbeatAt = stream?.quality?.heartbeatAt;
  const hasFreshFlow =
    ['live', 'warming'].includes(stream?.status) &&
    isValidTimestamp(heartbeatAt) &&
    heartbeatAt <= now &&
    now - heartbeatAt <= 5000;
  const flowWindows = [15, 60, 180].map((seconds) => {
    const window = stream?.flow?.windows?.[seconds];
    const available =
      hasFreshFlow &&
      window?.available === true &&
      isFiniteNumber(window.imbalance) &&
      Math.abs(window.imbalance) <= 1;
    return { available, imbalance: available ? window.imbalance : 0 };
  });
  const liquidity = stream?.liquidity;
  const depthAvailable =
    liquidity?.available === true &&
    isValidTimestamp(liquidity.updatedAt) &&
    liquidity.updatedAt <= now &&
    now - liquidity.updatedAt <= 5000 &&
    isFiniteNumber(liquidity.depth?.[10]?.imbalance) &&
    Math.abs(liquidity.depth[10].imbalance) <= 1;
  const depthChangeAvailable =
    depthAvailable &&
    liquidity.depthChange60?.available === true &&
    isFiniteNumber(liquidity.depthChange60.bidFraction) &&
    isFiniteNumber(liquidity.depthChange60.askFraction);
  const pressureChange =
    flowWindows[0].available && flowWindows[1].available
      ? flowWindows[0].imbalance - flowWindows[1].imbalance
      : 0;
  // Continuous inputs precede their availability flags, in LEARNING_FEATURE_NAMES order.
  // Availability flags distinguish missing optional feeds from measured zero values.
  const values = [
    getBoundedFeatureValue(logit(forecast.aboveProbability)),
    getBoundedFeatureValue(targetDistance),
    horizonMinutes / 15,
    ...[1, 3, 5, 15].map((minutes) =>
      getBoundedFeatureValue(
        features[`logReturn${minutes === 1 ? '1Minute' : `${minutes}Minutes`}`] /
          (minuteVolatility * Math.sqrt(minutes)),
      ),
    ),
    getBoundedFeatureValue(
      features.logReturnAcceleration3Minutes / (minuteVolatility * Math.sqrt(6)),
    ),
    volumeAvailable
      ? getBoundedFeatureValue(Math.log(Math.max(1e-6, features.relativeVolume5To30Minutes)))
      : 0,
    getBoundedFeatureValue(features.latestRangeToMedianRatio),
    features.closePosition === null ? 0 : features.closePosition - 0.5,
    spreadAvailable ? getBoundedFeatureValue(features.spreadFraction / minuteVolatility) : 0,
    ...flowWindows.map((window) => window.imbalance),
    pressureChange,
    flowWindows[1].available
      ? getBoundedFeatureValue(features.logReturn1Minute / minuteVolatility) *
        flowWindows[1].imbalance
      : 0,
    depthAvailable ? liquidity.depth[10].imbalance : 0,
    depthChangeAvailable
      ? getBoundedFeatureValue(
          liquidity.depthChange60.bidFraction - liquidity.depthChange60.askFraction,
        )
      : 0,
    ...flowWindows.map((window) => Number(window.available)),
    Number(depthAvailable),
    Number(depthChangeAvailable),
    Number(volumeAvailable),
    Number(spreadAvailable),
  ];
  if (!values.every(isFiniteNumber))
    return getUnavailableSnapshot('Learning features cannot be calculated safely.');
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
      ...flowWindows.flatMap((window, index) =>
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
    snapshot.values.every((value) => isFiniteNumber(value) && Math.abs(value) <= 16) &&
    LEARNING_AVAILABILITY_INDEXES.every(
      (index) => snapshot.values[index] === 0 || snapshot.values[index] === 1,
    ) &&
    isFiniteNumber(snapshot.baselineAboveProbability) &&
    snapshot.baselineAboveProbability >= 0 &&
    snapshot.baselineAboveProbability <= 1 &&
    isFiniteNumber(snapshot.targetDistance) &&
    snapshot.target === target &&
    snapshot.expiresAt === expiresAt &&
    snapshot.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    (!outcomeDefinition || snapshot.outcomeDefinition === outcomeDefinition) &&
    (snapshot.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION ||
      (['cf-brti', 'coinbase-proxy'].includes(snapshot.referenceSource) &&
        isFiniteNumber(snapshot.settlementKnownFraction) &&
        snapshot.settlementKnownFraction >= 0 &&
        snapshot.settlementKnownFraction <= 1)) &&
    isValidTimestamp(snapshot.featureCutoffAt) &&
    snapshot.featureCutoffAt === cutoffAt &&
    cutoffAt < expiresAt,
  );
}

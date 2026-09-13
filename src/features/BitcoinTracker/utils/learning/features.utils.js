import { logit } from './statistics.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import { KALSHI_DERIVATIVES_MODEL_VERSION } from '../kalshi/forecast.utils';
import { isDerivativesForecastMetadata } from '../derivativesForecast.utils';

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
export const DERIVATIVES_LEARNING_FEATURE_VERSION = 'deadline-reversal-features-v3';
export const DERIVATIVES_LEARNING_FEATURE_NAMES = Object.freeze([
  ...LEARNING_FEATURE_NAMES,
  'futuresPressure15',
  'futuresPressure60',
  'futuresPressure180',
  'futuresLargeTradePressure',
  'futuresLargeTradeShare',
  'futuresLiquidationPressure',
  'futuresRelativeLiquidationVolume',
  'futuresPriceResponse',
  'futuresBasis',
  'futuresFlow15Available',
  'futuresFlow60Available',
  'futuresFlow180Available',
  'futuresLargeTradesAvailable',
  'futuresLiquidationsAvailable',
  'futuresPriceResponseAvailable',
  'futuresBasisAvailable',
]);
const derivativesAvailabilityIndexes = [
  ...LEARNING_AVAILABILITY_INDEXES,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
];

/** Historical coefficients keep their original positions and dimensions. */
export function getLearningFeatureSchema(version) {
  if (version === LEARNING_FEATURE_VERSION)
    return { names: LEARNING_FEATURE_NAMES, availabilityIndexes: LEARNING_AVAILABILITY_INDEXES };
  if (version === DERIVATIVES_LEARNING_FEATURE_VERSION)
    return {
      names: DERIVATIVES_LEARNING_FEATURE_NAMES,
      availabilityIndexes: derivativesAvailabilityIndexes,
    };
  return null;
}

export function isLearningSchemaCompatibleWithBaseline(featureVersion, baselineModelVersion) {
  return Boolean(
    getLearningFeatureSchema(featureVersion) &&
    (featureVersion === DERIVATIVES_LEARNING_FEATURE_VERSION) ===
      (baselineModelVersion === KALSHI_DERIVATIVES_MODEL_VERSION),
  );
}
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
    ...((snapshot.schemaVersion ?? snapshot.featureVersion) === DERIVATIVES_LEARNING_FEATURE_VERSION
      ? { featureVersion: DERIVATIVES_LEARNING_FEATURE_VERSION }
      : {}),
  };
}

export function matchesLearningPipeline(snapshot, pipeline) {
  const snapshotPipeline = getLearningPipeline(snapshot);
  return Boolean(
    snapshotPipeline &&
    pipeline &&
    snapshotPipeline.baselineModelVersion === pipeline.baselineModelVersion &&
    snapshotPipeline.referenceSource === pipeline.referenceSource &&
    // The baseline identifies the information used; the feature version identifies its encoding.
    snapshotPipeline.featureInputSource === pipeline.featureInputSource &&
    (snapshotPipeline.featureVersion ?? LEARNING_FEATURE_VERSION) ===
      (pipeline.featureVersion ?? LEARNING_FEATURE_VERSION),
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
  const schemaVersion =
    forecast?.modelVersion === KALSHI_DERIVATIVES_MODEL_VERSION
      ? DERIVATIVES_LEARNING_FEATURE_VERSION
      : LEARNING_FEATURE_VERSION;
  const getUnavailableSnapshot = (reason) => ({
    schemaVersion,
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
  const missingDerivativesFeeds = [];
  if (schemaVersion === DERIVATIVES_LEARNING_FEATURE_VERSION) {
    const derivatives = forecast.derivatives;
    if (
      !isDerivativesForecastMetadata(derivatives) ||
      (derivatives.available &&
        (!isValidTimestamp(derivatives.asOf) ||
          derivatives.asOf > now ||
          now - derivatives.asOf > 5000))
    )
      return getUnavailableSnapshot(
        'A contemporaneous futures snapshot or explicit fallback is required.',
      );
    const available = derivatives.available === true;
    const flowAvailable = [15, 60, 180].map(
      (seconds) => available && isFiniteNumber(derivatives[`imbalance${seconds}`]),
    );
    const liquidationsAvailable =
      available &&
      isFiniteNumber(derivatives.liquidationImbalance) &&
      isFiniteNumber(derivatives.relativeLiquidationVolume);
    const largeTradesAvailable =
      available &&
      isFiniteNumber(derivatives.largeTradeImbalance) &&
      isFiniteNumber(derivatives.largeTradeShare);
    const priceResponseAvailable = available && isFiniteNumber(derivatives.priceResponse);
    const basisAvailable = available && isFiniteNumber(derivatives.basisLogReturn);
    values.push(
      ...[15, 60, 180].map((seconds, index) =>
        flowAvailable[index] ? derivatives[`imbalance${seconds}`] : 0,
      ),
      largeTradesAvailable ? derivatives.largeTradeImbalance : 0,
      largeTradesAvailable ? derivatives.largeTradeShare : 0,
      liquidationsAvailable ? derivatives.liquidationImbalance : 0,
      liquidationsAvailable ? getBoundedFeatureValue(derivatives.relativeLiquidationVolume) : 0,
      priceResponseAvailable ? derivatives.priceResponse : 0,
      basisAvailable ? getBoundedFeatureValue(derivatives.basisLogReturn / minuteVolatility) : 0,
      ...flowAvailable.map(Number),
      Number(largeTradesAvailable),
      Number(liquidationsAvailable),
      Number(priceResponseAvailable),
      Number(basisAvailable),
    );
    missingDerivativesFeeds.push(
      ...flowAvailable.flatMap((present, index) =>
        present ? [] : [`futures-flow-${[15, 60, 180][index]}`],
      ),
      ...(liquidationsAvailable ? [] : ['futures-liquidations']),
      ...(largeTradesAvailable ? [] : ['futures-large-trades']),
      ...(priceResponseAvailable ? [] : ['futures-price-response']),
      ...(basisAvailable ? [] : ['futures-basis']),
    );
  }
  if (!values.every(isFiniteNumber))
    return getUnavailableSnapshot('Learning features cannot be calculated safely.');
  return {
    schemaVersion,
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
      ...missingDerivativesFeeds,
    ],
  };
}

export function isLearningFeatureSnapshot(
  snapshot,
  { target, expiresAt, cutoffAt, outcomeDefinition } = {},
) {
  const schema = getLearningFeatureSchema(snapshot?.schemaVersion);
  return Boolean(
    snapshot?.available === true &&
    schema &&
    isLearningSchemaCompatibleWithBaseline(snapshot.schemaVersion, snapshot.baselineModelVersion) &&
    getLearningPipeline(snapshot) !== null &&
    Array.isArray(snapshot.values) &&
    snapshot.values.length === schema.names.length &&
    snapshot.values.every((value) => isFiniteNumber(value) && Math.abs(value) <= 16) &&
    schema.availabilityIndexes.every(
      (index) => snapshot.values[index] === 0 || snapshot.values[index] === 1,
    ) &&
    (snapshot.schemaVersion !== DERIVATIVES_LEARNING_FEATURE_VERSION ||
      ([26, 27, 28, 29, 31].every((index) => Math.abs(snapshot.values[index]) <= 1) &&
        [30, 33].every((index) => snapshot.values[index] >= 0 && snapshot.values[index] <= 1) &&
        snapshot.values[32] >= 0 &&
        snapshot.values[32] <= 8 &&
        Math.abs(snapshot.values[34]) <= 8 &&
        [
          [35, 26],
          [36, 27],
          [37, 28],
          [38, 29, 30],
          [39, 31, 32],
          [40, 33],
          [41, 34],
        ].every(
          ([flag, ...indexes]) =>
            snapshot.values[flag] === 1 || indexes.every((index) => snapshot.values[index] === 0),
        ))) &&
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

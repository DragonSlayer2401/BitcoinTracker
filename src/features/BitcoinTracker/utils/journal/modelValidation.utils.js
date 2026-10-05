import { PRESSURE_MODEL_VERSION } from '../pressureForecast.utils';
import {
  OUTCOME_MODEL_VERSION,
  KALSHI_OUTCOME_MODEL_VERSION,
  CALIBRATION_VERSION,
} from '../learning/model.utils';
import {
  LEARNING_FEATURE_VERSION,
  DERIVATIVES_LEARNING_FEATURE_VERSION,
} from '../learning/features.utils';
import { PATTERN_MODEL_VERSION } from '../learning/patternVersions.utils';
import { isDerivativesForecastMetadata } from '../derivativesForecast.utils';
import {
  EARLY_MODEL_VERSION,
  EARLY_CALIBRATION_VERSION,
  EARLY_LEARNING_REQUIREMENTS,
} from '../learning/earlyModel.utils';
import {
  CHALLENGER_KINDS,
  CHALLENGER_MODEL_VERSION,
  CHALLENGER_POLICY_VERSION,
  LEGACY_CHALLENGER_MODEL_VERSION,
  LEGACY_CHALLENGER_POLICY_VERSION,
  CHALLENGER_REQUIREMENTS,
  DIRECTIONAL_REVERSAL_KIND,
  DIRECTIONAL_REVERSAL_POLICY_VERSION,
  isFittedChallenger,
} from '../learning/challengerModel.utils';
import {
  KALSHI_MODEL_VERSION,
  KALSHI_DERIVATIVES_MODEL_VERSION,
  LEGACY_KALSHI_MODEL_VERSION,
  LEGACY_KALSHI_DERIVATIVES_MODEL_VERSION,
  KALSHI_MODEL_PARAMETERS,
} from '../kalshi/forecast.utils';
import {
  isRecord,
  isTimestamp,
  isPositiveNumber,
  isProbability,
  isIdentifier,
  hasExactFields,
} from './validation.utils';

// Persisted calls retain the model and assumptions used at capture. A new live
// model must not invalidate or silently recalculate the user's earlier calls.
const legacyKalshiModelParameters = Object.freeze({
  sampleCount: 60,
  maximumBenchmarkAgeMs: 5000,
  minimumProxyBasisLogDeviation: 0.0005,
});
const kalshiBaselineVersions = [
  'kalshi-brti-average-v1',
  LEGACY_KALSHI_MODEL_VERSION,
  LEGACY_KALSHI_DERIVATIVES_MODEL_VERSION,
  KALSHI_MODEL_VERSION,
  KALSHI_DERIVATIVES_MODEL_VERSION,
];
const learnedModelVersions = [
  PATTERN_MODEL_VERSION,
  LEGACY_CHALLENGER_MODEL_VERSION,
  CHALLENGER_MODEL_VERSION,
  EARLY_MODEL_VERSION,
  'outcome-logistic-v1',
  'outcome-logistic-kalshi-v1',
  OUTCOME_MODEL_VERSION,
  KALSHI_OUTCOME_MODEL_VERSION,
];
const kalshiModelVersions = [
  PATTERN_MODEL_VERSION,
  LEGACY_CHALLENGER_MODEL_VERSION,
  CHALLENGER_MODEL_VERSION,
  EARLY_MODEL_VERSION,
  ...kalshiBaselineVersions,
  'outcome-logistic-kalshi-v1',
  KALSHI_OUTCOME_MODEL_VERSION,
];

export const isLearnedModelVersion = (version) => learnedModelVersions.includes(version);
export const isKalshiModelVersion = (version) => kalshiModelVersions.includes(version);
export const isSnapshotModelVersion = (version) =>
  [PRESSURE_MODEL_VERSION, ...learnedModelVersions, ...kalshiBaselineVersions].includes(version);

export function hasValidLearningMetadata(learning, forecast) {
  const usesPatterns = forecast.modelVersion === PATTERN_MODEL_VERSION;
  const fields = [
    'applied',
    'modelId',
    'calibrationVersion',
    'trainingCutoffAt',
    'baselineAboveProbability',
    'aboveProbability',
    'featureVersion',
  ];
  if (usesPatterns) fields.push('baselineFeatureVersion');
  const usesLegacyModel = ['outcome-logistic-v1', 'outcome-logistic-kalshi-v1'].includes(
    forecast.modelVersion,
  );
  const usesChallenger = [CHALLENGER_MODEL_VERSION, LEGACY_CHALLENGER_MODEL_VERSION].includes(
    forecast.modelVersion,
  );
  const challengerKind =
    usesChallenger && typeof learning?.modelId === 'string'
      ? CHALLENGER_KINDS.find(
          (kind) =>
            learning.modelId.startsWith(`${forecast.modelVersion}-${kind}-`) &&
            learning.modelId.length > forecast.modelVersion.length + kind.length + 2,
        )
      : null;
  return (
    hasExactFields(learning, fields) &&
    learning.applied === true &&
    isIdentifier(learning.modelId) &&
    learning.modelId.startsWith(`${forecast.modelVersion}-`) &&
    /^[a-z0-9-]+$/.test(learning.modelId.slice(forecast.modelVersion.length + 1)) &&
    (!usesChallenger || Boolean(challengerKind)) &&
    (challengerKind !== DIRECTIONAL_REVERSAL_KIND ||
      forecast.modelVersion === CHALLENGER_MODEL_VERSION) &&
    learning.calibrationVersion ===
      (usesChallenger
        ? forecast.modelVersion === LEGACY_CHALLENGER_MODEL_VERSION
          ? LEGACY_CHALLENGER_POLICY_VERSION
          : challengerKind === DIRECTIONAL_REVERSAL_KIND
            ? DIRECTIONAL_REVERSAL_POLICY_VERSION
            : CHALLENGER_POLICY_VERSION
        : forecast.modelVersion === EARLY_MODEL_VERSION
          ? EARLY_CALIBRATION_VERSION
          : CALIBRATION_VERSION) &&
    (usesPatterns
      ? learning.featureVersion === 'deadline-pattern-features-v5' &&
        learning.modelId.startsWith(`${PATTERN_MODEL_VERSION}-combined-`) &&
        [LEARNING_FEATURE_VERSION, DERIVATIVES_LEARNING_FEATURE_VERSION].includes(
          learning.baselineFeatureVersion,
        )
      : usesLegacyModel
        ? learning.featureVersion === 'deadline-reversal-features-v1'
        : [LEARNING_FEATURE_VERSION, DERIVATIVES_LEARNING_FEATURE_VERSION].includes(
            learning.featureVersion,
          )) &&
    ((usesPatterns ? learning.baselineFeatureVersion : learning.featureVersion) ===
    DERIVATIVES_LEARNING_FEATURE_VERSION
      ? hasValidDerivativesMetadata(forecast.derivatives, forecast)
      : forecast.derivatives == null) &&
    isTimestamp(learning.trainingCutoffAt) &&
    learning.trainingCutoffAt < forecast.createdAt &&
    isProbability(learning.baselineAboveProbability) &&
    (forecast.modelVersion !== EARLY_MODEL_VERSION ||
      Math.abs(learning.aboveProbability - learning.baselineAboveProbability) <=
        EARLY_LEARNING_REQUIREMENTS.maximumProbabilityAdjustment + 1e-9) &&
    (!usesChallenger ||
      !isFittedChallenger(challengerKind) ||
      challengerKind === DIRECTIONAL_REVERSAL_KIND ||
      Math.abs(learning.aboveProbability - learning.baselineAboveProbability) <=
        CHALLENGER_REQUIREMENTS.maximumProbabilityAdjustment + 1e-9) &&
    learning.aboveProbability === forecast.aboveProbability
  );
}

/** Validate captured futures math without replacing or recalculating historical calls. */
export function hasValidDerivativesMetadata(metadata, forecast) {
  if (!isDerivativesForecastMetadata(metadata)) return false;
  return (
    (metadata.asOf === null ||
      (metadata.asOf <= forecast.createdAt && forecast.createdAt - metadata.asOf <= 5000)) &&
    (!metadata.available || metadata.asOf !== null) &&
    metadata.aboveProbability ===
      (isLearnedModelVersion(forecast.modelVersion)
        ? forecast.learning?.baselineAboveProbability
        : forecast.aboveProbability)
  );
}

export function hasValidKalshiMetadata(metadata, forecast) {
  if (!isRecord(metadata)) return false;
  const sampleCountFields = [
    'observedSampleCount',
    'missingElapsedSampleCount',
    'futureSampleCount',
  ];
  const positiveNumberFields = [
    'referencePrice',
    'expectedSettlementAverage',
    'settlementStandardDeviation',
    'settlementLowerBound',
    'settlementUpperBound',
  ];
  const usesProxy = metadata.referenceSource === 'coinbase-proxy';
  const parameters = ['kalshi-brti-average-v1', 'outcome-logistic-kalshi-v1'].includes(
    forecast.modelVersion,
  )
    ? legacyKalshiModelParameters
    : KALSHI_MODEL_PARAMETERS;
  return (
    metadata.marketTicker === forecast.kalshiMarket.ticker &&
    metadata.comparison === 'greater_or_equal' &&
    metadata.roundDigits === 2 &&
    ['coinbase-proxy', 'cf-brti'].includes(metadata.referenceSource) &&
    metadata.modelKind === 'experimental' &&
    metadata.approximate === true &&
    sampleCountFields.every(
      (field) =>
        Number.isSafeInteger(metadata[field]) && metadata[field] >= 0 && metadata[field] <= 60,
    ) &&
    sampleCountFields.reduce((sum, field) => sum + metadata[field], 0) === 60 &&
    metadata.futureSampleCount ===
      Math.min(60, Math.ceil((forecast.expiresAt - forecast.createdAt) / 1000)) &&
    positiveNumberFields.every((field) => isPositiveNumber(metadata[field])) &&
    metadata.settlementLowerBound <= metadata.settlementUpperBound &&
    isTimestamp(metadata.referenceAt) &&
    metadata.referenceAt <= forecast.createdAt &&
    (usesProxy
      ? ([KALSHI_MODEL_VERSION, KALSHI_DERIVATIVES_MODEL_VERSION].includes(forecast.modelVersion)
          ? forecast.createdAt - metadata.referenceAt <= 20_000
          : metadata.referenceAt === forecast.createdAt) &&
        isPositiveNumber(metadata.basisLogDeviation) &&
        metadata.basisLogDeviation >= parameters.minimumProxyBasisLogDeviation
      : forecast.createdAt - metadata.referenceAt <= parameters.maximumBenchmarkAgeMs &&
        metadata.basisLogDeviation === 0) &&
    (metadata.requiredFutureAverage === null
      ? metadata.missingElapsedSampleCount > 0
      : typeof metadata.requiredFutureAverage === 'number' &&
        Number.isFinite(metadata.requiredFutureAverage) &&
        metadata.missingElapsedSampleCount === 0) &&
    typeof metadata.warning === 'string' &&
    metadata.warning.length <= 500 &&
    (usesProxy
      ? typeof metadata.basisAssumption === 'string'
      : metadata.basisAssumption === null) &&
    isRecord(metadata.parameters) &&
    Object.entries(parameters).every(([key, value]) => metadata.parameters[key] === value)
  );
}

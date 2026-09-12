import { PRESSURE_MODEL_VERSION } from '../pressureForecast.utils';
import {
  OUTCOME_MODEL_VERSION,
  KALSHI_OUTCOME_MODEL_VERSION,
  CALIBRATION_VERSION,
} from '../learning/model.utils';
import { LEARNING_FEATURE_VERSION } from '../learning/features.utils';
import {
  EARLY_MODEL_VERSION,
  EARLY_CALIBRATION_VERSION,
  EARLY_LEARNING_REQUIREMENTS,
} from '../learning/earlyModel.utils';
import { KALSHI_MODEL_VERSION, KALSHI_MODEL_PARAMETERS } from '../kalshi/forecast.utils';
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
const kalshiBaselineVersions = ['kalshi-brti-average-v1', KALSHI_MODEL_VERSION];
const learnedModelVersions = [
  EARLY_MODEL_VERSION,
  'outcome-logistic-v1',
  'outcome-logistic-kalshi-v1',
  OUTCOME_MODEL_VERSION,
  KALSHI_OUTCOME_MODEL_VERSION,
];
const kalshiModelVersions = [
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
  const fields = [
    'applied',
    'modelId',
    'calibrationVersion',
    'trainingCutoffAt',
    'baselineAboveProbability',
    'aboveProbability',
    'featureVersion',
  ];
  const usesLegacyModel = ['outcome-logistic-v1', 'outcome-logistic-kalshi-v1'].includes(
    forecast.modelVersion,
  );
  return (
    hasExactFields(learning, fields) &&
    learning.applied === true &&
    isIdentifier(learning.modelId) &&
    learning.modelId.startsWith(`${forecast.modelVersion}-`) &&
    /^[a-z0-9-]+$/.test(learning.modelId.slice(forecast.modelVersion.length + 1)) &&
    learning.calibrationVersion ===
      (forecast.modelVersion === EARLY_MODEL_VERSION
        ? EARLY_CALIBRATION_VERSION
        : CALIBRATION_VERSION) &&
    learning.featureVersion ===
      (usesLegacyModel ? 'deadline-reversal-features-v1' : LEARNING_FEATURE_VERSION) &&
    isTimestamp(learning.trainingCutoffAt) &&
    learning.trainingCutoffAt < forecast.createdAt &&
    isProbability(learning.baselineAboveProbability) &&
    (forecast.modelVersion !== EARLY_MODEL_VERSION ||
      Math.abs(learning.aboveProbability - learning.baselineAboveProbability) <=
        EARLY_LEARNING_REQUIREMENTS.maximumProbabilityAdjustment + 1e-9) &&
    learning.aboveProbability === forecast.aboveProbability
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
      ? metadata.referenceAt === forecast.createdAt &&
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

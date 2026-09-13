import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import {
  LEARNING_FEATURE_VERSION,
  getLearningFeatureSchema,
  isLearningSchemaCompatibleWithBaseline,
  isLearningFeatureSnapshot,
  matchesLearningPipeline,
} from './features.utils';
import { getBoundedProbability, logit, predictLogistic } from './statistics.utils';
import {
  isEarlyModelArtifact,
  isWithinEarlyModelDomain,
  predictEarlyCandidate,
} from './earlyModel.utils';

export const OUTCOME_MODEL_VERSION = 'outcome-logistic-kalshi-v2';
export const KALSHI_OUTCOME_MODEL_VERSION = OUTCOME_MODEL_VERSION;
export const CALIBRATION_VERSION = 'platt-v1';
const isValidTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isFiniteNumberArray = (values, length) =>
  Array.isArray(values) && values.length === length && values.every(Number.isFinite);

export function matchesOutcomeModelPipeline(model, snapshot) {
  const applicability = model?.applicability;
  return (
    (model?.featureVersion ?? LEARNING_FEATURE_VERSION) ===
      (snapshot?.schemaVersion ?? snapshot?.featureVersion ?? LEARNING_FEATURE_VERSION) &&
    matchesLearningPipeline(snapshot, {
      baselineModelVersion: applicability?.baselineModelVersion,
      referenceSource: applicability?.referenceSources?.[0],
      featureInputSource: applicability?.featureInputSources?.[0],
      featureVersion: model?.featureVersion ?? LEARNING_FEATURE_VERSION,
    })
  );
}

export function isWithinOutcomeModelDomain(model, snapshot) {
  const horizonMinutes = (snapshot?.expiresAt - snapshot?.featureCutoffAt) / 60_000;
  const applicability = model?.applicability;
  const schema = getLearningFeatureSchema(model?.featureVersion ?? LEARNING_FEATURE_VERSION);
  const availabilityPattern = (schema?.availabilityIndexes ?? [])
    .map((index) => snapshot?.values?.[index])
    .join('');
  return Boolean(
    Number.isFinite(horizonMinutes) &&
    applicability &&
    horizonMinutes >= applicability.minimumHorizonMinutes - 1e-9 &&
    horizonMinutes <= applicability.maximumHorizonMinutes + 1e-9 &&
    snapshot.targetDistance >= applicability.minimumTargetDistance - 1e-9 &&
    snapshot.targetDistance <= applicability.maximumTargetDistance + 1e-9 &&
    applicability.availabilityPatterns?.includes(availabilityPattern) &&
    // Source identity alone is insufficient: BRTI spot with Coinbase history is a different
    // feature generation process from native BRTI history, even for the same settlement rule.
    (model?.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION ||
      (matchesOutcomeModelPipeline(model, snapshot) && snapshot.settlementKnownFraction === 0)),
  );
}

function isLogisticFit(model, indexes) {
  return Boolean(
    model &&
    Array.isArray(model.indexes) &&
    model.indexes.length === indexes.length &&
    model.indexes.every((value, index) => value === indexes[index]) &&
    isFiniteNumberArray(model.means, indexes.length) &&
    isFiniteNumberArray(model.scales, indexes.length) &&
    model.scales.every((value) => value > 0) &&
    isFiniteNumberArray(model.coefficients, indexes.length + 1) &&
    model.coefficients.every((value) => Math.abs(value) <= 1000),
  );
}

export function isOutcomeModelArtifact(model) {
  const schema = getLearningFeatureSchema(model?.featureVersion);
  return Boolean(
    model &&
    typeof model.id === 'string' &&
    /^outcome-logistic-kalshi-v2-[a-z0-9-]+$/.test(model.id) &&
    model.version === KALSHI_OUTCOME_MODEL_VERSION &&
    model.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    Array.isArray(model.applicability?.referenceSources) &&
    model.applicability.referenceSources.length === 1 &&
    model.applicability.referenceSources.every((source) =>
      ['cf-brti', 'coinbase-proxy'].includes(source),
    ) &&
    typeof model.applicability.baselineModelVersion === 'string' &&
    /^[a-z0-9-]{1,100}$/.test(model.applicability.baselineModelVersion) &&
    Array.isArray(model.applicability.featureInputSources) &&
    model.applicability.featureInputSources.length === 1 &&
    ['cf-brti-history', 'coinbase-candles'].includes(model.applicability.featureInputSources[0]) &&
    model.status === 'shadow' &&
    schema &&
    isLearningSchemaCompatibleWithBaseline(
      model.featureVersion,
      model.applicability.baselineModelVersion,
    ) &&
    [
      model.trainedAt,
      model.trainingCutoffAt,
      model.calibrationCutoffAt,
      model.evaluationCutoffAt,
      model.shadowStartsAt,
    ].every(isValidTimestamp) &&
    model.trainingCutoffAt < model.calibrationCutoffAt &&
    model.calibrationCutoffAt < model.evaluationCutoffAt &&
    model.evaluationCutoffAt <= model.trainedAt &&
    model.shadowStartsAt === model.trainedAt &&
    Number.isFinite(model.applicability?.minimumHorizonMinutes) &&
    model.applicability.minimumHorizonMinutes > 0 &&
    Number.isFinite(model.applicability.maximumHorizonMinutes) &&
    model.applicability.maximumHorizonMinutes <= 15 &&
    model.applicability.maximumHorizonMinutes >= model.applicability.minimumHorizonMinutes &&
    Number.isFinite(model.applicability.minimumTargetDistance) &&
    Number.isFinite(model.applicability.maximumTargetDistance) &&
    model.applicability.maximumTargetDistance >= model.applicability.minimumTargetDistance &&
    Array.isArray(model.applicability.availabilityPatterns) &&
    model.applicability.availabilityPatterns.length > 0 &&
    model.applicability.availabilityPatterns.length <= 2 ** schema.availabilityIndexes.length &&
    model.applicability.availabilityPatterns.every(
      (pattern) =>
        typeof pattern === 'string' &&
        pattern.length === schema.availabilityIndexes.length &&
        /^[01]+$/.test(pattern),
    ) &&
    isLogisticFit(
      model.model,
      schema.names.map((_, index) => index),
    ) &&
    model.calibration?.version === CALIBRATION_VERSION &&
    isLogisticFit(model.calibration.model, [0]) &&
    model.calibration.model.coefficients[1] >= 0,
  );
}

/** Used only to record prospective shadow scores; never makes a shadow candidate active. */
export function predictOutcomeCandidate(model, snapshot) {
  if (model?.retirement) return null;
  if (isEarlyModelArtifact(model)) return predictEarlyCandidate(model, snapshot);
  if (
    !isOutcomeModelArtifact(model) ||
    !isLearningFeatureSnapshot(snapshot, {
      target: snapshot?.target,
      expiresAt: snapshot?.expiresAt,
      cutoffAt: snapshot?.featureCutoffAt,
      outcomeDefinition: model?.outcomeDefinition,
    }) ||
    snapshot.featureCutoffAt < model.trainedAt
  )
    return null;
  if (!isWithinOutcomeModelDomain(model, snapshot)) return snapshot.baselineAboveProbability;
  const uncalibratedProbability = predictLogistic(model.model, snapshot.values);
  const probability = predictLogistic(model.calibration.model, [logit(uncalibratedProbability)]);
  return Number.isFinite(probability) ? getBoundedProbability(probability) : null;
}

export function applyOutcomeModel(
  baseForecast,
  { learningFeatures, target, expiresAt, now } = {},
  model,
) {
  if (
    !baseForecast?.available ||
    !isValidTimestamp(now) ||
    !isLearningFeatureSnapshot(learningFeatures, {
      target,
      expiresAt,
      cutoffAt: now,
      outcomeDefinition: model?.outcomeDefinition,
    }) ||
    !(isOutcomeModelArtifact(model) || isEarlyModelArtifact(model)) ||
    model.retirement ||
    baseForecast.outcomeDefinition !== model.outcomeDefinition ||
    model.activation?.modelId !== model.id ||
    model.activation?.shadowEvaluation?.eligibleForPromotion !== true ||
    !isValidTimestamp(model.activation?.activatedAt) ||
    model.activation.activatedAt > now ||
    model.activation.activatedAt < model.trainedAt
  )
    return baseForecast;
  if (
    !(isEarlyModelArtifact(model)
      ? isWithinEarlyModelDomain(model, learningFeatures)
      : isWithinOutcomeModelDomain(model, learningFeatures)) ||
    Math.abs(learningFeatures.baselineAboveProbability - baseForecast.aboveProbability) > 1e-9
  )
    return baseForecast;
  const aboveProbability = predictOutcomeCandidate(model, learningFeatures);
  if (aboveProbability === null) return baseForecast;
  return {
    ...baseForecast,
    modelVersion: model.version,
    aboveProbability,
    belowProbability: 1 - aboveProbability,
    direction: aboveProbability > 0.5 ? 'above' : aboveProbability < 0.5 ? 'below' : 'neutral',
    lowerBound: null,
    upperBound: null,
    intervalAvailable: false,
    intervalReason:
      'The outcome classifier estimates Above/Below probabilities, not an ending-price distribution.',
    learning: {
      applied: true,
      modelId: model.id,
      calibrationVersion: model.calibration.version,
      trainingCutoffAt: model.trainingCutoffAt,
      baselineAboveProbability: baseForecast.aboveProbability,
      aboveProbability,
      featureVersion: model.featureVersion,
    },
  };
}

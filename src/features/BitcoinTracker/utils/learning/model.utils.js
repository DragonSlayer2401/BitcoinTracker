import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import {
  LEARNING_FEATURE_NAMES,
  LEARNING_FEATURE_VERSION,
  LEARNING_AVAILABILITY_INDEXES,
  isLearningFeatureSnapshot,
  matchesLearningPipeline,
} from './features.utils';
import { getBoundedProbability, logit, predictLogistic } from './statistics.utils';

export const OUTCOME_MODEL_VERSION = 'outcome-logistic-kalshi-v2';
export const KALSHI_OUTCOME_MODEL_VERSION = OUTCOME_MODEL_VERSION;
export const CALIBRATION_VERSION = 'platt-v1';
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const numbers = (values, length) =>
  Array.isArray(values) && values.length === length && values.every(Number.isFinite);

export function matchesOutcomeModelPipeline(model, snapshot) {
  const support = model?.applicability;
  return matchesLearningPipeline(snapshot, {
    baselineModelVersion: support?.baselineModelVersion,
    referenceSource: support?.referenceSources?.[0],
    featureInputSource: support?.featureInputSources?.[0],
  });
}

export function isWithinOutcomeModelDomain(model, snapshot) {
  const horizon = (snapshot?.expiresAt - snapshot?.featureCutoffAt) / 60_000;
  const support = model?.applicability;
  const availability = LEARNING_AVAILABILITY_INDEXES.map((index) => snapshot?.values?.[index]).join(
    '',
  );
  return Boolean(
    Number.isFinite(horizon) &&
    support &&
    horizon >= support.minimumHorizonMinutes - 1e-9 &&
    horizon <= support.maximumHorizonMinutes + 1e-9 &&
    snapshot.targetDistance >= support.minimumTargetDistance - 1e-9 &&
    snapshot.targetDistance <= support.maximumTargetDistance + 1e-9 &&
    support.availabilityPatterns?.includes(availability) &&
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
    numbers(model.means, indexes.length) &&
    numbers(model.scales, indexes.length) &&
    model.scales.every((value) => value > 0) &&
    numbers(model.coefficients, indexes.length + 1) &&
    model.coefficients.every((value) => Math.abs(value) <= 1000),
  );
}

export function isOutcomeModelArtifact(model) {
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
    model.featureVersion === LEARNING_FEATURE_VERSION &&
    [
      model.trainedAt,
      model.trainingCutoffAt,
      model.calibrationCutoffAt,
      model.evaluationCutoffAt,
      model.shadowStartsAt,
    ].every(timestamp) &&
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
    model.applicability.availabilityPatterns.length <= 128 &&
    model.applicability.availabilityPatterns.every((pattern) => /^[01]{7}$/.test(pattern)) &&
    isLogisticFit(
      model.model,
      LEARNING_FEATURE_NAMES.map((_, index) => index),
    ) &&
    model.calibration?.version === CALIBRATION_VERSION &&
    isLogisticFit(model.calibration.model, [0]) &&
    model.calibration.model.coefficients[1] >= 0,
  );
}

/** Used only to record prospective shadow scores; never makes a shadow candidate active. */
export function predictOutcomeCandidate(model, snapshot) {
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
  const raw = predictLogistic(model.model, snapshot.values);
  const probability = predictLogistic(model.calibration.model, [logit(raw)]);
  return Number.isFinite(probability) ? getBoundedProbability(probability) : null;
}

export function applyOutcomeModel(
  baseForecast,
  { learningFeatures, target, expiresAt, now } = {},
  model,
) {
  if (
    !baseForecast?.available ||
    !timestamp(now) ||
    !isLearningFeatureSnapshot(learningFeatures, {
      target,
      expiresAt,
      cutoffAt: now,
      outcomeDefinition: model?.outcomeDefinition,
    }) ||
    !isOutcomeModelArtifact(model) ||
    baseForecast.outcomeDefinition !== model.outcomeDefinition ||
    model.activation?.modelId !== model.id ||
    model.activation?.shadowEvaluation?.eligibleForPromotion !== true ||
    !timestamp(model.activation?.activatedAt) ||
    model.activation.activatedAt > now ||
    model.activation.activatedAt < model.trainedAt
  )
    return baseForecast;
  if (
    !isWithinOutcomeModelDomain(model, learningFeatures) ||
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

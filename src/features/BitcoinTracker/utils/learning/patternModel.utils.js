import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import { getLearningFeatureSchema, isLearningSchemaCompatibleWithBaseline } from './features.utils';
import { CALIBRATION_VERSION, isWithinOutcomeModelDomain } from './model.utils';
import {
  PATTERN_DETECTOR_VERSION,
  PATTERN_FEATURE_VERSION,
  PATTERN_FEATURE_NAMES,
  LEGACY_PATTERN_FEATURE_VERSION,
  LEGACY_PATTERN_DETECTOR_VERSION,
  PATTERN_FAMILIES,
  getPatternAvailabilitySignature,
  getPatternModelIndexes,
  getPatternModelValues,
  isPatternLearningFeatureSnapshot,
} from './patternFeatures.utils';
import { logit, predictLogistic } from './statistics.utils';
import { LEARNING_REQUIREMENTS } from './training.utils';

import {
  PATTERN_MODEL_VERSION,
  LEGACY_PATTERN_MODEL_VERSION,
  PATTERN_PROMOTION_VERSION,
} from './patternVersions.utils';
export { PATTERN_MODEL_VERSION, LEGACY_PATTERN_MODEL_VERSION } from './patternVersions.utils';
export const PATTERN_CANDIDATE_KINDS = Object.freeze([
  'combined',
  'baseline-control',
  ...PATTERN_FAMILIES.map((family) => `without-${family}`),
]);
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const finiteArray = (values, length) =>
  Array.isArray(values) && values.length === length && values.every(Number.isFinite);

export function getPatternModelSchema(version) {
  if (version === PATTERN_MODEL_VERSION)
    return { featureVersion: PATTERN_FEATURE_VERSION, patternVersion: PATTERN_DETECTOR_VERSION };
  if (version === LEGACY_PATTERN_MODEL_VERSION)
    return {
      featureVersion: LEGACY_PATTERN_FEATURE_VERSION,
      patternVersion: LEGACY_PATTERN_DETECTOR_VERSION,
    };
  return null;
}

function isFit(fit, indexes) {
  return Boolean(
    fit &&
    Array.isArray(fit.indexes) &&
    fit.indexes.length === indexes.length &&
    indexes.every((value, index) => fit.indexes[index] === value) &&
    finiteArray(fit.means, indexes.length) &&
    finiteArray(fit.scales, indexes.length) &&
    fit.scales.every((value) => value > 0) &&
    finiteArray(fit.coefficients, indexes.length + 1) &&
    fit.coefficients.every((value) => Math.abs(value) <= 1000) &&
    Number.isFinite(fit.penalty) &&
    fit.penalty > 0,
  );
}

export function isPatternModelArtifact(model) {
  const schema = getLearningFeatureSchema(model?.baselineFeatureVersion);
  const domain = model?.applicability;
  return Boolean(
    [PATTERN_MODEL_VERSION, LEGACY_PATTERN_MODEL_VERSION].includes(model?.version) &&
    PATTERN_CANDIDATE_KINDS.includes(model.kind) &&
    typeof model.suiteId === 'string' &&
    /^[0-9]+-[a-z0-9]+$/.test(model.suiteId) &&
    model.id === `${model.version}-${model.kind}-${model.suiteId}` &&
    model.status === 'shadow' &&
    model.featureVersion ===
      (model.version === LEGACY_PATTERN_MODEL_VERSION
        ? LEGACY_PATTERN_FEATURE_VERSION
        : PATTERN_FEATURE_VERSION) &&
    model.patternVersion ===
      (model.version === LEGACY_PATTERN_MODEL_VERSION
        ? LEGACY_PATTERN_DETECTOR_VERSION
        : PATTERN_DETECTOR_VERSION) &&
    model.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    schema &&
    typeof domain?.baselineModelVersion === 'string' &&
    /^[a-z0-9-]{1,100}$/.test(domain.baselineModelVersion) &&
    isLearningSchemaCompatibleWithBaseline(
      model.baselineFeatureVersion,
      domain?.baselineModelVersion,
    ) &&
    [
      model.trainedAt,
      model.trainingCutoffAt,
      model.calibrationCutoffAt,
      model.evaluationCutoffAt,
      model.shadowStartsAt,
    ].every(isTimestamp) &&
    model.trainingCutoffAt < model.calibrationCutoffAt &&
    model.calibrationCutoffAt < model.evaluationCutoffAt &&
    model.evaluationCutoffAt <= model.trainedAt &&
    model.shadowStartsAt === model.trainedAt &&
    Number.isFinite(domain?.minimumHorizonMinutes) &&
    domain.minimumHorizonMinutes > 0 &&
    Number.isFinite(domain.maximumHorizonMinutes) &&
    domain.maximumHorizonMinutes <= 15 &&
    domain.maximumHorizonMinutes >= domain.minimumHorizonMinutes &&
    Number.isFinite(domain.minimumTargetDistance) &&
    Number.isFinite(domain.maximumTargetDistance) &&
    domain.maximumTargetDistance >= domain.minimumTargetDistance &&
    Array.isArray(domain.referenceSources) &&
    domain.referenceSources.length === 1 &&
    ['cf-brti', 'coinbase-proxy'].includes(domain.referenceSources[0]) &&
    Array.isArray(domain.featureInputSources) &&
    domain.featureInputSources.length === 1 &&
    ['cf-brti-history', 'coinbase-candles'].includes(domain.featureInputSources[0]) &&
    Array.isArray(domain.availabilityPatterns) &&
    domain.availabilityPatterns.length > 0 &&
    domain.availabilityPatterns.every(
      (value) =>
        typeof value === 'string' &&
        value.length === schema.availabilityIndexes.length &&
        /^[01]+$/.test(value),
    ) &&
    Array.isArray(model.patternAvailabilityPatterns) &&
    model.patternAvailabilityPatterns.length > 0 &&
    model.patternAvailabilityPatterns.every(
      (value) =>
        typeof value === 'string' &&
        value.length === PATTERN_FEATURE_NAMES.length / 2 &&
        /^[01]+$/.test(value),
    ) &&
    isFit(model.model, getPatternModelIndexes(model.kind, schema.names.length)) &&
    model.calibration?.version === CALIBRATION_VERSION &&
    isFit(model.calibration.model, [0]) &&
    model.calibration.model.coefficients[1] >= 0,
  );
}

/** A missing or previously unseen input state retains the exact original baseline probability. */
export function isWithinPatternModelDomain(model, snapshot) {
  return Boolean(
    snapshot?.patternAvailable &&
    model.featureVersion === snapshot.schemaVersion &&
    model.patternVersion === snapshot.patternVersion &&
    model.baselineFeatureVersion === snapshot.baselineFeatureVersion &&
    model.patternAvailabilityPatterns.includes(getPatternAvailabilitySignature(snapshot)) &&
    isWithinOutcomeModelDomain(
      { ...model, featureVersion: model.baselineFeatureVersion },
      snapshot.baselineFeatures,
    ),
  );
}

export function predictPatternCandidate(model, snapshot, { windowStartAt } = {}) {
  if (
    !isPatternModelArtifact(model) ||
    model.retirement ||
    !isPatternLearningFeatureSnapshot(snapshot, {
      target: snapshot?.target,
      expiresAt: snapshot?.expiresAt,
      cutoffAt: snapshot?.featureCutoffAt,
    }) ||
    !isTimestamp(windowStartAt) ||
    model.trainedAt >= windowStartAt ||
    windowStartAt > snapshot.featureCutoffAt
  )
    return null;
  const modelUsed = isWithinPatternModelDomain(model, snapshot);
  const aboveProbability = modelUsed
    ? predictLogistic(model.calibration.model, [
        logit(predictLogistic(model.model, getPatternModelValues(snapshot))),
      ])
    : snapshot.baselineFeatures.baselineAboveProbability;
  if (!Number.isFinite(aboveProbability)) return null;
  return {
    modelId: model.id,
    modelVersion: model.version,
    suiteId: model.suiteId,
    kind: model.kind,
    trainedAt: model.trainedAt,
    featureCutoffAt: snapshot.featureCutoffAt,
    aboveProbability,
    modelUsed,
    reason: modelUsed
      ? null
      : 'Pattern inputs or baseline domain are unsupported; baseline retained.',
  };
}

/** Captured scores remain immutable research metadata, including after deliberate activation. */
export function predictPatternCandidates({ candidates = [], snapshot, windowStartAt } = {}) {
  if (!Array.isArray(candidates) || !snapshot) return [];
  return candidates.flatMap((model) => {
    const prediction = predictPatternCandidate(model, snapshot, { windowStartAt });
    return prediction ? [prediction] : [];
  });
}

export function hasPatternActivation(model, now) {
  const activation = model?.activation;
  const evaluation = activation?.shadowEvaluation;
  return Boolean(
    isPatternModelArtifact(model) &&
    model.version === PATTERN_MODEL_VERSION &&
    model.kind === 'combined' &&
    !model.retirement &&
    isTimestamp(now) &&
    activation?.modelId === model.id &&
    isTimestamp(activation.activatedAt) &&
    activation.activatedAt > model.trainedAt &&
    activation.activatedAt <= now &&
    evaluation?.version === PATTERN_PROMOTION_VERSION &&
    evaluation.phase === 'prospective-pattern-promotion' &&
    evaluation.modelId === model.id &&
    evaluation.suiteId === model.suiteId &&
    evaluation.featureVersion === model.featureVersion &&
    evaluation.patternVersion === model.patternVersion &&
    evaluation.eligibleForPromotion === true &&
    evaluation.evaluationComplete === true &&
    isTimestamp(evaluation.evaluatedAt) &&
    evaluation.evaluatedAt > model.trainedAt &&
    evaluation.evaluatedAt <= activation.activatedAt &&
    evaluation.independentWindows >= LEARNING_REQUIREMENTS.minimumShadowWindows &&
    evaluation.callCoverage === 1 &&
    evaluation.modelUses >= LEARNING_REQUIREMENTS.minimumShadowModelUses &&
    Array.isArray(evaluation.reasons) &&
    evaluation.reasons.length === 0,
  );
}

/** Only a stored prospective activation can replace production; unsupported inputs retain it. */
export function applyPatternModel(baseForecast, { snapshot, windowStartAt, now } = {}, model) {
  if (
    !baseForecast?.available ||
    !hasPatternActivation(model, now) ||
    !snapshot ||
    !isPatternLearningFeatureSnapshot(snapshot, {
      target: baseForecast.target,
      expiresAt: baseForecast.expiresAt,
      cutoffAt: now,
    }) ||
    !isWithinPatternModelDomain(model, snapshot) ||
    baseForecast.outcomeDefinition !== model.outcomeDefinition ||
    Math.abs(snapshot.baselineFeatures.baselineAboveProbability - baseForecast.aboveProbability) >
      1e-9
  )
    return baseForecast;
  const prediction = predictPatternCandidate(model, snapshot, { windowStartAt });
  if (!prediction?.modelUsed) return baseForecast;
  const aboveProbability = prediction.aboveProbability;
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
      'The calibrated pattern model estimates the official YES probability, not an ending-price distribution.',
    learning: {
      applied: true,
      modelId: model.id,
      calibrationVersion: model.calibration.version,
      trainingCutoffAt: model.trainingCutoffAt,
      baselineAboveProbability: baseForecast.aboveProbability,
      aboveProbability,
      featureVersion: model.featureVersion,
      baselineFeatureVersion: model.baselineFeatureVersion,
    },
  };
}

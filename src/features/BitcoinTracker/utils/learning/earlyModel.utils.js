import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import { LEARNING_FEATURE_VERSION, isLearningFeatureSnapshot } from './features.utils';
import { matchesOutcomeModelPipeline } from './model.utils';
import { predictLogistic } from './statistics.utils';

export const EARLY_MODEL_VERSION = 'outcome-early-kalshi-v1';
export const EARLY_CALIBRATION_VERSION = 'baseline-correction-v1';

// Predeclared experiment limits. Smaller sample requirements do not establish accuracy.
export const EARLY_LEARNING_REQUIREMENTS = Object.freeze({
  minimumTrainingWindows: 40,
  minimumClassExamples: 8,
  minimumShadowWindows: 40,
  minimumShadowModelUses: 20,
  maximumProbabilityAdjustment: 0.05,
  blendWeight: 0.2,
  minimumNewWindowsForRetraining: 20,
  minimumMonitoringWindows: 40,
});
export const EARLY_FIT_PARAMETERS = Object.freeze({ penalty: 0.25, maximumIterations: 50 });

const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const finiteArray = (value, length) =>
  Array.isArray(value) && value.length === length && value.every(Number.isFinite);

/** A separate two-parameter artifact cannot be mistaken for the full multifeature model. */
export function isEarlyModelArtifact(artifact) {
  const domain = artifact?.applicability;
  const fit = artifact?.model;
  return Boolean(
    artifact &&
    typeof artifact.id === 'string' &&
    /^outcome-early-kalshi-v1-[a-z0-9-]+$/.test(artifact.id) &&
    artifact.version === EARLY_MODEL_VERSION &&
    artifact.status === 'shadow' &&
    artifact.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    artifact.featureVersion === LEARNING_FEATURE_VERSION &&
    [
      artifact.trainedAt,
      artifact.trainingCutoffAt,
      artifact.calibrationCutoffAt,
      artifact.evaluationCutoffAt,
      artifact.shadowStartsAt,
    ].every(timestamp) &&
    artifact.trainingCutoffAt <= artifact.trainedAt &&
    artifact.calibrationCutoffAt === artifact.trainingCutoffAt &&
    artifact.evaluationCutoffAt === artifact.trainingCutoffAt &&
    artifact.shadowStartsAt === artifact.trainedAt &&
    Object.entries(EARLY_LEARNING_REQUIREMENTS).every(
      ([name, value]) => artifact.requirements?.[name] === value,
    ) &&
    domain &&
    typeof domain.baselineModelVersion === 'string' &&
    /^[a-z0-9-]{1,100}$/.test(domain.baselineModelVersion) &&
    Array.isArray(domain.referenceSources) &&
    domain.referenceSources.length === 1 &&
    ['cf-brti', 'coinbase-proxy'].includes(domain.referenceSources[0]) &&
    Array.isArray(domain.featureInputSources) &&
    domain.featureInputSources.length === 1 &&
    ['cf-brti-history', 'coinbase-candles'].includes(domain.featureInputSources[0]) &&
    Number.isFinite(domain.minimumHorizonMinutes) &&
    domain.minimumHorizonMinutes > 0 &&
    Number.isFinite(domain.maximumHorizonMinutes) &&
    domain.maximumHorizonMinutes >= domain.minimumHorizonMinutes &&
    domain.maximumHorizonMinutes <= 15 &&
    Number.isFinite(domain.minimumTargetDistance) &&
    Number.isFinite(domain.maximumTargetDistance) &&
    domain.maximumTargetDistance >= domain.minimumTargetDistance &&
    Number.isFinite(domain.minimumBaselineProbability) &&
    domain.minimumBaselineProbability >= 0 &&
    Number.isFinite(domain.maximumBaselineProbability) &&
    domain.maximumBaselineProbability <= 1 &&
    domain.maximumBaselineProbability >= domain.minimumBaselineProbability &&
    Array.isArray(domain.availabilityPatterns) &&
    domain.availabilityPatterns.length > 0 &&
    domain.availabilityPatterns.length <= 128 &&
    domain.availabilityPatterns.every((pattern) => /^[01]{7}$/.test(pattern)) &&
    Array.isArray(fit?.indexes) &&
    fit.indexes.length === 1 &&
    fit.indexes[0] === 0 &&
    finiteArray(fit.means, 1) &&
    finiteArray(fit.scales, 1) &&
    fit.scales[0] > 0 &&
    finiteArray(fit.coefficients, 2) &&
    fit.coefficients.every((value) => Math.abs(value) <= 1000) &&
    fit.coefficients[1] >= 0 &&
    fit.penalty === EARLY_FIT_PARAMETERS.penalty &&
    artifact.calibration?.version === EARLY_CALIBRATION_VERSION,
  );
}

/** Only used inputs define this simpler model's domain; optional feed flags do not veto it. */
export function isWithinEarlyModelDomain(artifact, snapshot) {
  const domain = artifact?.applicability;
  const horizon = (snapshot?.expiresAt - snapshot?.featureCutoffAt) / 60_000;
  const checkpointGraceMinutes = 5 / 60;
  return Boolean(
    domain &&
    matchesOutcomeModelPipeline(artifact, snapshot) &&
    snapshot?.settlementKnownFraction === 0 &&
    Number.isFinite(horizon) &&
    horizon > 0 &&
    horizon >= domain.minimumHorizonMinutes - checkpointGraceMinutes &&
    horizon <= domain.maximumHorizonMinutes + checkpointGraceMinutes &&
    snapshot.targetDistance >= domain.minimumTargetDistance - 1e-9 &&
    snapshot.targetDistance <= domain.maximumTargetDistance + 1e-9 &&
    snapshot.baselineAboveProbability >= domain.minimumBaselineProbability - 1e-9 &&
    snapshot.baselineAboveProbability <= domain.maximumBaselineProbability + 1e-9,
  );
}

/** Predict only with an artifact that already existed at this capture; otherwise never backfill. */
export function predictEarlyCandidate(artifact, snapshot) {
  if (
    !isEarlyModelArtifact(artifact) ||
    !isLearningFeatureSnapshot(snapshot, {
      target: snapshot?.target,
      expiresAt: snapshot?.expiresAt,
      cutoffAt: snapshot?.featureCutoffAt,
      outcomeDefinition: artifact?.outcomeDefinition,
    }) ||
    snapshot.featureCutoffAt < artifact.trainedAt ||
    (artifact.retirement &&
      (!timestamp(artifact.retirement.retiredAt) ||
        snapshot.featureCutoffAt >= artifact.retirement.retiredAt))
  )
    return null;
  const baseline = snapshot.baselineAboveProbability;
  if (!isWithinEarlyModelDomain(artifact, snapshot)) return baseline;
  const correction = predictLogistic(artifact.model, snapshot.values);
  if (!Number.isFinite(correction)) return null;
  const adjustment = Math.max(
    -EARLY_LEARNING_REQUIREMENTS.maximumProbabilityAdjustment,
    Math.min(
      EARLY_LEARNING_REQUIREMENTS.maximumProbabilityAdjustment,
      EARLY_LEARNING_REQUIREMENTS.blendWeight * (correction - baseline),
    ),
  );
  return Math.max(0, Math.min(1, baseline + adjustment));
}

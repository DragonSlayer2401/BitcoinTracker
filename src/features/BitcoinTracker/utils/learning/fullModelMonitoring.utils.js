import { scoreLearningRows } from './evaluation.utils';
import {
  isOutcomeModelArtifact,
  isWithinOutcomeModelDomain,
  predictOutcomeCandidate,
} from './model.utils';
import { getProspectiveLearningCohort } from './prospectiveCohort.utils';
import { getPairedBootstrapUncertainty, LEARNING_REQUIREMENTS } from './training.utils';

// Operational fallback rules, not evidence that a prediction model earns trading profits.
export const FULL_MODEL_MONITORING_REQUIREMENTS = Object.freeze({
  minimumWindows: LEARNING_REQUIREMENTS.minimumShadowWindows,
  minimumModelUses: LEARNING_REQUIREMENTS.minimumShadowModelUses,
  maximumBrierDeterioration: 0.005,
  maximumAccuracyDeterioration: 0.05,
  confidenceLevel: 0.95,
});

const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const matchesProbability = (actual, expected) =>
  Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 1e-9;

function hasRecordedModelPrediction(row, model) {
  const learning = row.decision.learning;
  const expected = predictOutcomeCandidate(model, row.learningFeatures);
  const baseline = row.learningFeatures.baselineAboveProbability;
  if (!matchesProbability(row.probability, expected)) return false;
  // A capture outside the trained domain legitimately retains the baseline. It contributes
  // a paired observation but never counts as evidence that the learned model was used.
  if (!isWithinOutcomeModelDomain(model, row.learningFeatures))
    return (
      matchesProbability(row.probability, baseline) &&
      learning?.applied !== true &&
      row.decision.modelVersion === row.learningFeatures.baselineModelVersion
    );
  return (
    row.decision.modelVersion === model.version &&
    learning?.applied === true &&
    learning.modelId === model.id &&
    matchesProbability(learning.aboveProbability, expected) &&
    matchesProbability(learning.baselineAboveProbability, baseline)
  );
}

/** Compare actual post-activation calls with their contemporaneously captured baselines. */
export function evaluateFullActiveModel(model, events, { now = Date.now() } = {}) {
  const activation = model?.activation;
  const requirements = FULL_MODEL_MONITORING_REQUIREMENTS;
  const valid =
    validTime(now) &&
    isOutcomeModelArtifact(model) &&
    !model.retirement &&
    activation?.modelId === model.id &&
    validTime(activation.activatedAt) &&
    activation.activatedAt >= model.trainedAt &&
    activation.activatedAt <= now &&
    activation.shadowEvaluation?.eligibleForPromotion === true &&
    activation.shadowEvaluation.modelId === model.id &&
    validTime(activation.shadowEvaluation.evaluatedAt) &&
    activation.shadowEvaluation.evaluatedAt >= model.trainedAt &&
    activation.shadowEvaluation.evaluatedAt <= activation.activatedAt;
  if (!valid)
    return {
      status: 'monitoring',
      reason: 'An activated full model with a verified promotion is required for monitoring.',
      independentWindows: 0,
      eligibleWindows: 0,
      callCoverage: 0,
      requirements,
    };

  const cohort = getProspectiveLearningCohort(model, events, now, activation.activatedAt);
  // Scheduled closure determines eligibility before labels are inspected. A delayed official
  // outcome holds its slot; older resolved contracts cannot replace it to improve the score.
  const prospective = cohort.prospective
    .filter((row) => row.expiresAt <= now)
    .slice(-requirements.minimumWindows);
  const resolved = prospective.map((row) => cohort.resolved.get(row.id)).filter(Boolean);
  const scored = resolved.filter((row) => hasRecordedModelPrediction(row, model));
  const modelUses = scored.filter(
    (row) => Math.abs(row.probability - row.learningFeatures.baselineAboveProbability) > 1e-9,
  ).length;
  const common = {
    modelId: model.id,
    evaluatedAt: now,
    independentWindows: scored.length,
    eligibleWindows: prospective.length,
    resolvedWindows: resolved.length,
    callCoverage: prospective.length ? scored.length / prospective.length : 0,
    modelUses,
    fallbackUses: scored.length - modelUses,
    requirements,
  };
  if (scored.length < requirements.minimumWindows || modelUses < requirements.minimumModelUses)
    return {
      ...common,
      status: 'monitoring',
      reason:
        'Wait for all 120 selected independent official outcomes and matching recorded predictions, including 60 learned adjustments; incomplete evidence is not a healthy check.',
    };

  const probabilities = scored.map((row) => row.probability);
  const baselineRows = scored.map((row) => ({
    ...row,
    probability: row.learningFeatures.baselineAboveProbability,
  }));
  const candidate = scoreLearningRows(scored);
  const baseline = scoreLearningRows(baselineRows);
  const uncertainty = getPairedBootstrapUncertainty(baselineRows, probabilities);
  const reasons = [];
  if (uncertainty.brierDifference[0] > requirements.maximumBrierDeterioration)
    reasons.push(
      'The paired 95% interval shows probability error more than 0.005 Brier points above the baseline.',
    );
  if (uncertainty.accuracyDifference[1] < -requirements.maximumAccuracyDeterioration)
    reasons.push(
      'The paired 95% interval shows directional accuracy more than five percentage points below the baseline.',
    );
  return {
    ...common,
    candidate,
    baseline,
    uncertainty,
    status: reasons.length ? 'disabled' : 'healthy',
    reason:
      reasons[0] ??
      'The latest 120 matched windows do not establish deterioration beyond the declared fallback limits.',
    reasons,
    firstWindowAt: scored[0].windowStartAt,
    lastDeadlineAt: Math.max(...scored.map((row) => row.expiresAt)),
  };
}

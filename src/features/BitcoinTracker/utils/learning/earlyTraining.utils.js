import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import { LEARNING_FEATURE_VERSION, isLearningFeatureSnapshot } from './features.utils';
import {
  getVerifiedLearningRows,
  groupOverlappingWindows,
  getIndependentRows,
  getWindowRepresentative,
  scoreLearningRows,
  collectLearningEvents,
  hasContemporaneousInputs,
} from './evaluation.utils';
import {
  selectLearningPipelineRows,
  getWeightedCheckpoints,
  getLatestResolvedAt,
  getDatasetFingerprint,
  getModelApplicability,
  getPairedBootstrapUncertainty,
} from './training.utils';
import { matchesOutcomeModelPipeline } from './model.utils';
import { fitLogistic, logit } from './statistics.utils';
import {
  EARLY_MODEL_VERSION,
  EARLY_CALIBRATION_VERSION,
  EARLY_LEARNING_REQUIREMENTS,
  EARLY_FIT_PARAMETERS,
  isEarlyModelArtifact,
  predictEarlyCandidate,
} from './earlyModel.utils';

export const EARLY_MONITORING_THRESHOLDS = Object.freeze({
  maximumBrierDeterioration: 0.005,
  maximumAccuracyDeterioration: 0.05,
});

const countOutcomes = (rows) => ({
  above: rows.filter((row) => row.outcome === 1).length,
  below: rows.filter((row) => row.outcome === 0).length,
});
const hasBothOutcomes = (rows) =>
  Object.values(countOutcomes(rows)).every(
    (count) => count >= EARLY_LEARNING_REQUIREMENTS.minimumClassExamples,
  );
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;

/** Fit one monotone baseline correction; only later recorded shadow outcomes can approve it. */
export function trainEarlyCandidate(events, { now = Date.now() } = {}) {
  const { rows, counts: evidenceCounts } = getVerifiedLearningRows(events, now);
  const { rows: usable, pipeline } = selectLearningPipelineRows(rows);
  const groups = groupOverlappingWindows(usable);
  const independent = groups.map(getWindowRepresentative);
  const checkpoints = getWeightedCheckpoints(groups);
  const counts = {
    training: groups.length,
    independentWindows: groups.length,
    trainingCheckpoints: checkpoints.length,
    classes: countOutcomes(independent),
    pipeline,
  };
  if (
    !timestamp(now) ||
    groups.length < EARLY_LEARNING_REQUIREMENTS.minimumTrainingWindows ||
    !hasBothOutcomes(independent)
  )
    return {
      status: 'insufficient-data',
      artifact: null,
      counts,
      evidenceCounts,
      reason:
        'At least 40 independent resolved windows from the same input pipeline, including eight of each outcome, are required.',
    };
  try {
    const model = fitLogistic(checkpoints, [0], EARLY_FIT_PARAMETERS);
    if (model.coefficients[1] < 0) {
      // The constrained optimum at slope zero is the weighted outcome rate, not a reversal of
      // the baseline ranking. Intercept and slope are the only fitted parameters.
      const totalWeight = checkpoints.reduce((sum, row) => sum + row.weight, 0);
      const aboveRate =
        checkpoints.reduce((sum, row) => sum + row.weight * row.outcome, 0) / totalWeight;
      model.coefficients = [logit(aboveRate), 0];
      model.trainingLoss =
        -aboveRate * Math.log(aboveRate) - (1 - aboveRate) * Math.log(1 - aboveRate);
    }
    const cutoff = getLatestResolvedAt(groups);
    const fingerprint = getDatasetFingerprint(checkpoints);
    const artifact = {
      id: `${EARLY_MODEL_VERSION}-${now}-${fingerprint}`,
      version: EARLY_MODEL_VERSION,
      status: 'shadow',
      trainedAt: now,
      featureVersion: LEARNING_FEATURE_VERSION,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      trainingCutoffAt: cutoff,
      // Common storage fields describe this single fitting partition. No holdout/calibration
      // performance is claimed: the first later shadow cohort is the only release test.
      calibrationCutoffAt: cutoff,
      evaluationCutoffAt: cutoff,
      shadowStartsAt: now,
      datasetFingerprint: fingerprint,
      applicability: {
        ...getModelApplicability(checkpoints, pipeline, KALSHI_OUTCOME_DEFINITION),
        minimumBaselineProbability: Math.min(
          ...checkpoints.map((row) => row.learningFeatures.baselineAboveProbability),
        ),
        maximumBaselineProbability: Math.max(
          ...checkpoints.map((row) => row.learningFeatures.baselineAboveProbability),
        ),
      },
      requirements: { ...EARLY_LEARNING_REQUIREMENTS },
      model,
      calibration: { version: EARLY_CALIBRATION_VERSION },
      evaluation: { eligibleForShadow: true, counts, reasons: [] },
    };
    if (!isEarlyModelArtifact(artifact)) throw new Error('Invalid early artifact.');
    return {
      artifact,
      status: 'shadow',
      reason:
        'A bounded baseline correction is ready for prospective shadow recording; no training-set accuracy threshold was used.',
      counts,
      evidenceCounts,
    };
  } catch {
    return {
      artifact: null,
      status: 'candidate-rejected',
      reason: 'The early correction fit was unstable. The baseline is retained.',
      counts,
      evidenceCounts,
    };
  }
}

function getProspectiveRows(model, events, now, startsAfter) {
  const { rows } = getVerifiedLearningRows(events, now);
  const { decisions, outcomes, conflicts } = collectLearningEvents(events, now);
  // Select chronological decisions before consulting outcome availability. A slow official
  // result must hold its original cohort slot rather than letting a later winner replace it.
  const eligible = [...decisions.values()]
    .filter(
      (decision) =>
        decision.cohort === 'kalshi-background' &&
        hasContemporaneousInputs(decision) &&
        Number.isFinite(decision.aboveProbability) &&
        decision.aboveProbability >= 0 &&
        decision.aboveProbability <= 1 &&
        Number.isFinite(decision.belowProbability) &&
        decision.belowProbability >= 0 &&
        decision.belowProbability <= 1 &&
        Math.abs(decision.aboveProbability + decision.belowProbability - 1) <= 1e-6 &&
        matchesOutcomeModelPipeline(model, decision.learningFeatures) &&
        isLearningFeatureSnapshot(decision.learningFeatures, {
          target: decision.target,
          expiresAt: decision.expiresAt,
          cutoffAt: decision.inputObservedAt,
          outcomeDefinition: model.outcomeDefinition,
        }) &&
        decision.learningFeatures.settlementKnownFraction === 0 &&
        decision.windowStartAt > startsAfter &&
        decision.capturedAt > startsAfter,
    )
    .map((decision) => ({
      id: decision.forecastId,
      windowStartAt: decision.windowStartAt,
      capturedAt: decision.capturedAt,
      expiresAt: decision.expiresAt,
      horizonMinutes: (decision.expiresAt - decision.capturedAt) / 60_000,
      outcomeDefinition: model.outcomeDefinition,
      learningFeatures: decision.learningFeatures,
      decision,
    }));
  return {
    prospective: getIndependentRows(eligible),
    resolved: new Map(rows.map((row) => [row.id, row])),
    terminalFailures: new Set([
      ...conflicts,
      ...[...outcomes.entries()]
        .filter(([, outcome]) => outcome.outcomeStatus === 'unobserved')
        .map(([id]) => id),
    ]),
  };
}

function compareWithBaseline(rows, probabilities, { includeUncertainty = true } = {}) {
  const baselineRows = rows.map((row) => ({
    ...row,
    probability: row.learningFeatures.baselineAboveProbability,
  }));
  const candidate = scoreLearningRows(
    rows.map((row, index) => ({ ...row, probability: probabilities[index] })),
  );
  const baseline = scoreLearningRows(baselineRows);
  const benchmark = scoreLearningRows(
    rows.map((row) => ({ ...row, probability: row.currentSide })),
  );
  const matched = rows.flatMap((row, index) =>
    row.marketProbability == null ? [] : [{ ...row, candidateProbability: probabilities[index] }],
  );
  const modelUses = rows.filter(
    (row, index) =>
      Math.abs(probabilities[index] - row.learningFeatures.baselineAboveProbability) > 1e-9,
  ).length;
  return {
    candidate,
    current: baseline,
    baseline,
    benchmark,
    marketBenchmark: scoreLearningRows(
      matched.map((row) => ({ ...row, probability: row.marketProbability })),
    ),
    candidateOnMarketRows: scoreLearningRows(
      matched.map((row) => ({ ...row, probability: row.candidateProbability })),
    ),
    modelUses,
    fallbackUses: rows.length - modelUses,
    uncertainty:
      includeUncertainty && rows.length
        ? getPairedBootstrapUncertainty(baselineRows, probabilities)
        : null,
  };
}

/** Freeze the first 40 eligible windows before checking whether recorded shadow scores exist. */
export function evaluateEarlyShadowCandidate(model, events, { now = Date.now() } = {}) {
  if (
    !timestamp(now) ||
    !isEarlyModelArtifact(model) ||
    model.evaluation?.eligibleForShadow !== true
  )
    return {
      status: 'candidate-rejected',
      eligibleForPromotion: false,
      evaluationComplete: false,
      modelId: model?.id ?? null,
      independentWindows: 0,
      reasons: ['A valid early candidate is required.'],
    };
  const cohort = getProspectiveRows(model, events, now, model.shadowStartsAt);
  const prospective = cohort.prospective.slice(0, EARLY_LEARNING_REQUIREMENTS.minimumShadowWindows);
  const resolved = prospective.map((row) => cohort.resolved.get(row.id)).filter(Boolean);
  const scored = resolved.filter((row) => {
    const recorded = row.decision.earlyShadowPrediction;
    const expected = predictEarlyCandidate(model, row.learningFeatures);
    return (
      recorded?.modelId === model.id &&
      recorded.featureCutoffAt === row.capturedAt &&
      Number.isFinite(recorded.aboveProbability) &&
      expected !== null &&
      Math.abs(recorded.aboveProbability - expected) <= 1e-9
    );
  });
  const terminalFailure =
    prospective.length >= EARLY_LEARNING_REQUIREMENTS.minimumShadowWindows &&
    prospective.some((row) => cohort.terminalFailures.has(row.id));
  const evaluationComplete =
    prospective.length >= EARLY_LEARNING_REQUIREMENTS.minimumShadowWindows &&
    (terminalFailure || resolved.length === prospective.length);
  const common = {
    modelId: model.id,
    evaluatedAt: now,
    independentWindows: scored.length,
    eligibleWindows: prospective.length,
    resolvedWindows: resolved.length,
    evaluationComplete,
    callCoverage: prospective.length ? scored.length / prospective.length : 0,
  };
  if (
    terminalFailure ||
    !evaluationComplete ||
    scored.length !== prospective.length ||
    !hasBothOutcomes(scored)
  )
    return {
      ...common,
      ...(scored.length
        ? compareWithBaseline(
            scored,
            scored.map((row) => row.decision.earlyShadowPrediction.aboveProbability),
            { includeUncertainty: false },
          )
        : {}),
      status: evaluationComplete ? 'shadow' : 'insufficient-data',
      eligibleForPromotion: false,
      reasons: [
        terminalFailure
          ? 'The fixed first 40 windows contain conflicting evidence or a terminal unobserved outcome; this candidate cannot be promoted.'
          : evaluationComplete
            ? 'The first 40 eligible windows lack complete recorded coverage or eight examples of each outcome; this candidate cannot be promoted.'
            : 'Record the early candidate prospectively across 40 independent later windows and wait for every selected official outcome, including eight of each outcome.',
      ],
    };
  const probabilities = scored.map((row) => row.decision.earlyShadowPrediction.aboveProbability);
  const comparison = compareWithBaseline(scored, probabilities);
  const reasons = [];
  if (comparison.modelUses < EARLY_LEARNING_REQUIREMENTS.minimumShadowModelUses)
    reasons.push('At least 20 prospective windows must actually use the bounded correction.');
  if (comparison.candidate.callAccuracy < comparison.baseline.callAccuracy)
    reasons.push(
      'The bounded correction reduces directional accuracy versus the baseline at the same capture times.',
    );
  if (comparison.uncertainty.brierDifference[1] >= 0)
    reasons.push(
      'The paired 95% probability-error interval does not establish improvement over the baseline.',
    );
  return {
    ...common,
    ...comparison,
    status: reasons.length ? 'shadow' : 'ready',
    eligibleForPromotion: reasons.length === 0,
    firstWindowAt: scored[0].windowStartAt,
    lastDeadlineAt: Math.max(...scored.map((row) => row.expiresAt)),
    reasons,
  };
}

/** Missing activation evidence cannot be called a healthy result; only real matched uses score. */
export function evaluateEarlyActiveModel(model, events, { now = Date.now() } = {}) {
  const activation = model?.activation;
  const valid =
    timestamp(now) &&
    isEarlyModelArtifact(model) &&
    activation?.modelId === model.id &&
    timestamp(activation.activatedAt) &&
    activation.activatedAt >= model.trainedAt &&
    activation.activatedAt <= now &&
    activation.shadowEvaluation?.eligibleForPromotion === true;
  if (!valid)
    return {
      status: 'monitoring',
      reason: 'An activated early correction with a verified promotion is required for monitoring.',
      independentWindows: 0,
      eligibleWindows: 0,
      callCoverage: 0,
      thresholds: EARLY_MONITORING_THRESHOLDS,
    };
  const cohort = getProspectiveRows(model, events, now, activation.activatedAt);
  const prospective = cohort.prospective.slice(
    -EARLY_LEARNING_REQUIREMENTS.minimumMonitoringWindows,
  );
  const resolved = prospective.map((row) => cohort.resolved.get(row.id)).filter(Boolean);
  const scored = resolved.filter((row) => {
    const learning = row.decision.learning;
    const expected = predictEarlyCandidate(model, row.learningFeatures);
    if (expected === null || Math.abs(row.probability - expected) > 1e-9) return false;
    const baseline = row.learningFeatures.baselineAboveProbability;
    // An unsupported capture legitimately keeps the baseline, without claiming a learned use.
    if (
      Math.abs(expected - baseline) <= 1e-9 &&
      Math.abs(row.probability - baseline) <= 1e-9 &&
      learning?.applied !== true
    )
      return true;
    return (
      learning?.applied === true &&
      learning.modelId === model.id &&
      Number.isFinite(learning.aboveProbability) &&
      Math.abs(learning.aboveProbability - expected) <= 1e-9 &&
      Number.isFinite(learning.baselineAboveProbability) &&
      Math.abs(learning.baselineAboveProbability - row.learningFeatures.baselineAboveProbability) <=
        1e-9
    );
  });
  const common = {
    modelId: model.id,
    evaluatedAt: now,
    independentWindows: scored.length,
    eligibleWindows: prospective.length,
    resolvedWindows: resolved.length,
    callCoverage: prospective.length ? scored.length / prospective.length : 0,
    thresholds: EARLY_MONITORING_THRESHOLDS,
  };
  const probabilities = scored.map((row) => row.probability);
  const modelUses = scored.filter(
    (row) => Math.abs(row.probability - row.learningFeatures.baselineAboveProbability) > 1e-9,
  ).length;
  if (
    scored.length < EARLY_LEARNING_REQUIREMENTS.minimumMonitoringWindows ||
    modelUses < EARLY_LEARNING_REQUIREMENTS.minimumShadowModelUses
  )
    return {
      ...common,
      status: 'monitoring',
      modelUses,
      reason:
        'Forty recent independent windows with matching recorded probabilities, including 20 learned adjustments, are required; missing evidence is not a passed check.',
    };
  const comparison = compareWithBaseline(scored, probabilities);
  const reasons = [];
  if (
    comparison.candidate.brier - comparison.baseline.brier >
    EARLY_MONITORING_THRESHOLDS.maximumBrierDeterioration
  )
    reasons.push('Recent probability error exceeds the baseline by more than 0.005 Brier points.');
  if (
    comparison.baseline.callAccuracy - comparison.candidate.callAccuracy >
    EARLY_MONITORING_THRESHOLDS.maximumAccuracyDeterioration
  )
    reasons.push(
      'Recent directional accuracy is more than five percentage points below the baseline.',
    );
  return {
    ...common,
    ...comparison,
    status: reasons.length ? 'disabled' : 'healthy',
    reason:
      reasons[0] ??
      'The latest 40 matched independent windows remain within the declared deterioration limits.',
    reasons,
    firstWindowAt: scored[0].windowStartAt,
    lastDeadlineAt: Math.max(...scored.map((row) => row.expiresAt)),
  };
}

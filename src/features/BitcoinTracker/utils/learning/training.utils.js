import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import {
  LEARNING_FEATURE_NAMES,
  LEARNING_FEATURE_VERSION,
  LEARNING_AVAILABILITY_INDEXES,
  getLearningPipeline,
  matchesLearningPipeline,
} from './features.utils';
import {
  getVerifiedLearningRows,
  groupOverlappingWindows,
  getIndependentRows,
  scoreLearningRows,
  getWindowRepresentative,
} from './evaluation.utils';
import {
  CALIBRATION_VERSION,
  KALSHI_OUTCOME_MODEL_VERSION,
  isOutcomeModelArtifact,
  predictOutcomeCandidate,
  isWithinOutcomeModelDomain,
  matchesOutcomeModelPipeline,
} from './model.utils';
import { fitLogistic, logit, predictLogistic } from './statistics.utils';

// These are predeclared evidence minimums for model releases, not publication thresholds.
export const LEARNING_REQUIREMENTS = Object.freeze({
  minimumTrainingWindows: 120,
  minimumCalibrationWindows: 60,
  minimumTestWindows: 60,
  minimumShadowWindows: 120,
  minimumShadowModelUses: 60,
  minimumTestModelUses: 30,
  minimumClassExamples: 10,
  penalty: 0.02,
  bootstrapReplicates: 500,
});

export function getWeightedCheckpoints(groups) {
  return groups.flatMap((group) => {
    // Multiple collectors may see the same checkpoint. Retain one contemporaneous decision per
    // contract horizon, then give every independent window a total fitting weight of one.
    const checkpoints = new Map();
    for (const row of [...group.rows].sort(
      (a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id),
    )) {
      const checkpointMinutes = row.decision?.checkpointMinutes ?? Math.round(row.horizonMinutes);
      if (!checkpoints.has(checkpointMinutes)) checkpoints.set(checkpointMinutes, row);
    }
    return [...checkpoints.values()].map((row) => ({ ...row, weight: 1 / checkpoints.size }));
  });
}

function hasEnoughExamplesOfBothOutcomes(rows) {
  return [0, 1].every(
    (outcome) =>
      rows.filter((row) => row.outcome === outcome).length >=
      LEARNING_REQUIREMENTS.minimumClassExamples,
  );
}

export function getLatestResolvedAt(groups) {
  return groups.length
    ? Math.max(
        ...groups.map((group) => Math.max(group.endAt, ...group.rows.map((row) => row.resolvedAt))),
      )
    : 0;
}

/** Different price feeds and baseline releases are separate experiments, never pooled evidence. */
export function selectLearningPipelineRows(rows) {
  const usable = rows.filter(
    (row) =>
      row.features &&
      row.decision.cohort === 'kalshi-background' &&
      row.learningFeatures.settlementKnownFraction === 0,
  );
  const latest = [...usable].sort((left, right) => right.capturedAt - left.capturedAt)[0];
  if (!latest) return { rows: [], pipeline: null };
  const generation = usable.filter(
    (row) =>
      row.learningFeatures.baselineModelVersion === latest.learningFeatures.baselineModelVersion,
  );
  // Once native history exists for a release, intermittent proxy fallbacks must not switch
  // its training population back and forth. Those fallbacks remain separately auditable.
  const native = generation.find(
    (row) =>
      row.learningFeatures.referenceSource === 'cf-brti' &&
      row.learningFeatures.featureInputSource === 'cf-brti-history',
  );
  const pipeline = getLearningPipeline((native ?? latest).learningFeatures);
  return {
    rows: usable.filter((row) => matchesLearningPipeline(row.learningFeatures, pipeline)),
    pipeline,
  };
}

/** Purges complete overlapping groups; normalization/calibration never use later partitions. */
export function splitLearningWindows(rows) {
  const groups = groupOverlappingWindows(rows);
  const trainingEnd = Math.floor(groups.length * 0.5);
  const calibrationEnd = Math.floor(groups.length * 0.75);
  const trainingGroups = groups.slice(0, trainingEnd);
  // A later partition must start after both the contract deadline and label publication.
  const trainingCutoffAt = getLatestResolvedAt(trainingGroups);
  const calibrationGroups = groups
    .slice(trainingEnd, calibrationEnd)
    .filter((group) => group.startAt >= trainingCutoffAt);
  const calibrationCutoffAt = getLatestResolvedAt(calibrationGroups);
  const testGroups = groups
    .slice(calibrationEnd)
    .filter((group) => group.startAt >= Math.max(trainingCutoffAt, calibrationCutoffAt));
  return {
    train: trainingGroups.map(getWindowRepresentative),
    calibration: calibrationGroups.map(getWindowRepresentative),
    test: testGroups.map(getWindowRepresentative),
    trainingCheckpoints: getWeightedCheckpoints(trainingGroups),
    calibrationCheckpoints: getWeightedCheckpoints(calibrationGroups),
    trainingCutoffAt,
    calibrationCutoffAt,
    evaluationCutoffAt: getLatestResolvedAt(testGroups),
    groupCount: groups.length,
    purgedGroups:
      groups.length - trainingGroups.length - calibrationGroups.length - testGroups.length,
  };
}

function comparePredictions(rows, probabilities) {
  const candidate = scoreLearningRows(
    rows.map((row, index) => ({ ...row, probability: probabilities[index] })),
  );
  const current = scoreLearningRows(rows);
  const benchmark = scoreLearningRows(
    rows.map((row) => ({ ...row, probability: row.currentSide })),
  );
  const reasons = [];
  const matchedMarketRows = rows.flatMap((row, index) =>
    row.marketProbability != null ? [{ ...row, candidateProbability: probabilities[index] }] : [],
  );
  const marketBenchmark = scoreLearningRows(
    matchedMarketRows.map((row) => ({ ...row, probability: row.marketProbability })),
  );
  const candidateOnMarketRows = scoreLearningRows(
    matchedMarketRows.map((row) => ({ ...row, probability: row.candidateProbability })),
  );
  if (candidate.callAccuracy <= current.callAccuracy)
    reasons.push(
      'Candidate does not improve accuracy over the current model at the same capture times.',
    );
  if (candidate.callAccuracy <= benchmark.callAccuracy)
    reasons.push('Candidate does not improve accuracy over the current-side benchmark.');
  if (candidate.brier >= current.brier)
    reasons.push('Candidate does not improve probability error over the current model.');
  if (candidate.expectedCalibrationError > current.expectedCalibrationError)
    reasons.push('Candidate calibration error is worse than the current model.');
  if (
    matchedMarketRows.length >= LEARNING_REQUIREMENTS.minimumTestModelUses &&
    (candidateOnMarketRows.brier > marketBenchmark.brier ||
      candidateOnMarketRows.callAccuracy < marketBenchmark.callAccuracy)
  )
    reasons.push(
      'Candidate underperforms the contemporaneous Kalshi midpoint on matched contracts.',
    );
  return { candidate, current, benchmark, marketBenchmark, candidateOnMarketRows, reasons };
}

export function getDatasetFingerprint(rows) {
  let hash = 2166136261;
  for (const row of rows) {
    const encoded = JSON.stringify([
      row.id,
      row.capturedAt,
      row.expiresAt,
      row.target,
      row.outcome,
      row.features,
      getLearningPipeline(row.learningFeatures),
    ]);
    for (let index = 0; index < encoded.length; index++)
      hash = Math.imul(hash ^ encoded.charCodeAt(index), 16777619) >>> 0;
  }
  return hash.toString(36);
}

/** A fit can adjust only horizons, target distances and feed states seen during training. */
export function getModelApplicability(trainingCheckpoints, pipeline, outcomeDefinition) {
  return {
    baselineModelVersion: pipeline.baselineModelVersion,
    featureInputSources: [pipeline.featureInputSource],
    minimumHorizonMinutes: Math.min(...trainingCheckpoints.map((row) => row.horizonMinutes)),
    maximumHorizonMinutes: Math.max(...trainingCheckpoints.map((row) => row.horizonMinutes)),
    minimumTargetDistance: Math.min(
      ...trainingCheckpoints.map((row) => row.learningFeatures.targetDistance),
    ),
    maximumTargetDistance: Math.max(
      ...trainingCheckpoints.map((row) => row.learningFeatures.targetDistance),
    ),
    availabilityPatterns: [
      ...new Set(
        trainingCheckpoints.map((row) =>
          LEARNING_AVAILABILITY_INDEXES.map((index) => row.features[index]).join(''),
        ),
      ),
    ],
    ...(outcomeDefinition === KALSHI_OUTCOME_DEFINITION
      ? {
          referenceSources: [
            ...new Set(trainingCheckpoints.map((row) => row.learningFeatures.referenceSource)),
          ],
        }
      : {}),
  };
}

function getCalibrationRows(rows, model, modelDomain) {
  return rows
    .filter((row) => isWithinOutcomeModelDomain(modelDomain, row.learningFeatures))
    .map((row) => ({
      ...row,
      // Platt calibration learns one intercept and slope from the raw model's log odds.
      features: [logit(predictLogistic(model, row.features))],
    }));
}

function countLearnedAdjustments(rows, probabilities, modelDomain) {
  return rows.filter(
    (row, index) =>
      isWithinOutcomeModelDomain(modelDomain, row.learningFeatures) &&
      Math.abs(probabilities[index] - row.learningFeatures.baselineAboveProbability) > 1e-9,
  ).length;
}

/** A trained candidate is always shadow-only, even when its retrospective test passes. */
export function trainOutcomeCandidate(events, { now = Date.now() } = {}) {
  const outcomeDefinition = KALSHI_OUTCOME_DEFINITION;
  const { rows, counts } = getVerifiedLearningRows(events, now, { outcomeDefinition });
  const { rows: usable, pipeline } = selectLearningPipelineRows(rows);
  const split = splitLearningWindows(usable);
  const sampleCounts = {
    training: split.train.length,
    calibration: split.calibration.length,
    test: split.test.length,
    independentWindows: split.groupCount,
    purgedGroups: split.purgedGroups,
    pipeline,
  };
  const hasEnoughIndependentWindows =
    split.train.length >= LEARNING_REQUIREMENTS.minimumTrainingWindows &&
    split.calibration.length >= LEARNING_REQUIREMENTS.minimumCalibrationWindows &&
    split.test.length >= LEARNING_REQUIREMENTS.minimumTestWindows;
  if (
    !hasEnoughIndependentWindows ||
    ![split.train, split.calibration, split.test].every(hasEnoughExamplesOfBothOutcomes)
  ) {
    return {
      status: 'insufficient-data',
      artifact: null,
      counts: sampleCounts,
      evidenceCounts: counts,
      reason:
        'Collect at least 120 training, 60 calibration, and 60 later test windows from the same model version and price-data sources, with both outcomes represented after overlap grouping and boundary purging.',
    };
  }
  try {
    // Fit the classifier using training checkpoints only; later rows cannot change its scaling.
    const model = fitLogistic(
      split.trainingCheckpoints,
      LEARNING_FEATURE_NAMES.map((_, index) => index),
      { penalty: LEARNING_REQUIREMENTS.penalty, maximumIterations: 50 },
    );
    const applicability = getModelApplicability(
      split.trainingCheckpoints,
      pipeline,
      outcomeDefinition,
    );
    const modelDomain = { applicability, outcomeDefinition };
    const supportedCalibration = split.calibration.filter((row) =>
      isWithinOutcomeModelDomain(modelDomain, row.learningFeatures),
    );
    if (
      supportedCalibration.length < LEARNING_REQUIREMENTS.minimumCalibrationWindows ||
      !hasEnoughExamplesOfBothOutcomes(supportedCalibration)
    )
      return {
        status: 'insufficient-data',
        artifact: null,
        counts: sampleCounts,
        reason:
          'More independent calibration windows are needed within the training horizon and observed feed-availability states.',
      };
    // Calibrate on the separate middle partition, then evaluate on untouched later windows.
    const calibrationRows = getCalibrationRows(split.calibrationCheckpoints, model, modelDomain);
    const calibration = fitLogistic(calibrationRows, [0], {
      penalty: LEARNING_REQUIREMENTS.penalty,
      maximumIterations: 50,
    });
    if (calibration.coefficients[1] < 0)
      return {
        status: 'candidate-rejected',
        artifact: null,
        counts: sampleCounts,
        reason:
          'The calibration period reverses the learned ordering; collect later evidence before trying another candidate.',
      };
    const probabilities = split.test.map((row) =>
      isWithinOutcomeModelDomain(modelDomain, row.learningFeatures)
        ? predictLogistic(calibration, [logit(predictLogistic(model, row.features))])
        : row.learningFeatures.baselineAboveProbability,
    );
    const evaluation = comparePredictions(split.test, probabilities);
    evaluation.modelUses = countLearnedAdjustments(split.test, probabilities, modelDomain);
    evaluation.fallbackUses = split.test.length - evaluation.modelUses;
    if (evaluation.modelUses < LEARNING_REQUIREMENTS.minimumTestModelUses)
      evaluation.reasons.push(
        'At least 30 later test windows must actually use a learned adjustment; a baseline-only candidate is not an improvement.',
      );
    const version = KALSHI_OUTCOME_MODEL_VERSION;
    const artifact = {
      id: `${version}-${now}-${getDatasetFingerprint(usable)}`,
      version,
      status: 'shadow',
      trainedAt: now,
      featureVersion: LEARNING_FEATURE_VERSION,
      outcomeDefinition,
      trainingCutoffAt: split.trainingCutoffAt,
      calibrationCutoffAt: split.calibrationCutoffAt,
      evaluationCutoffAt: split.evaluationCutoffAt,
      shadowStartsAt: now,
      datasetFingerprint: getDatasetFingerprint(usable),
      applicability,
      model,
      calibration: { version: CALIBRATION_VERSION, model: calibration },
      evaluation: {
        ...evaluation,
        eligibleForShadow: evaluation.reasons.length === 0,
        counts: sampleCounts,
      },
    };
    if (!isOutcomeModelArtifact(artifact))
      return {
        status: 'candidate-rejected',
        artifact: null,
        counts: sampleCounts,
        reason: 'The fitted artifact failed validation.',
      };
    return {
      status: evaluation.reasons.length ? 'candidate-rejected' : 'shadow',
      artifact,
      counts: sampleCounts,
      reason:
        evaluation.reasons[0] ??
        'Retrospective checks passed. The candidate must now prove itself on newly recorded background windows before activation.',
    };
  } catch {
    return {
      status: 'candidate-rejected',
      artifact: null,
      counts: sampleCounts,
      reason: 'The statistical fit was unstable. The current model is retained.',
    };
  }
}

export function getPairedBootstrapUncertainty(rows, probabilities) {
  // Reuse the same sampled window for all models. A fixed seed makes repeated audits stable.
  let seed = 0x1a2b3c4d;
  const getNextRandomValue = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const accuracyDifferences = [];
  const brierDifferences = [];
  const benchmarkAccuracyDifferences = [];
  for (let sample = 0; sample < LEARNING_REQUIREMENTS.bootstrapReplicates; sample++) {
    let accuracyDifference = 0;
    let brierDifference = 0;
    let benchmarkAccuracyDifference = 0;
    for (let index = 0; index < rows.length; index++) {
      const selectedIndex = Math.floor(getNextRandomValue() * rows.length);
      const row = rows[selectedIndex];
      const probability = probabilities[selectedIndex];
      const candidateAccuracy =
        probability === 0.5 ? 0.5 : Number(Number(probability > 0.5) === row.outcome);
      accuracyDifference +=
        candidateAccuracy -
        (row.probability === 0.5 ? 0.5 : Number(Number(row.probability > 0.5) === row.outcome));
      benchmarkAccuracyDifference +=
        candidateAccuracy -
        (row.currentSide === 0.5 ? 0.5 : Number(row.currentSide === row.outcome));
      brierDifference += (probability - row.outcome) ** 2 - (row.probability - row.outcome) ** 2;
    }
    accuracyDifferences.push(accuracyDifference / rows.length);
    brierDifferences.push(brierDifference / rows.length);
    benchmarkAccuracyDifferences.push(benchmarkAccuracyDifference / rows.length);
  }
  const getConfidenceInterval = (values) => {
    values.sort((a, b) => a - b);
    return [
      values[Math.floor(values.length * 0.025)],
      values[Math.min(values.length - 1, Math.floor(values.length * 0.975))],
    ];
  };
  return {
    method: 'paired-independent-window-bootstrap',
    confidenceLevel: 0.95,
    accuracyDifference: getConfidenceInterval(accuracyDifferences),
    brierDifference: getConfidenceInterval(brierDifferences),
    benchmarkAccuracyDifference: getConfidenceInterval(benchmarkAccuracyDifferences),
  };
}

export function evaluateShadowCandidate(model, events, { now = Date.now() } = {}) {
  if (!isOutcomeModelArtifact(model) || model.evaluation?.eligibleForShadow !== true)
    return {
      status: 'candidate-rejected',
      eligibleForPromotion: false,
      modelId: model?.id ?? null,
      reasons: ['A valid candidate that passed retrospective checks is required.'],
      independentWindows: 0,
    };
  const { rows } = getVerifiedLearningRows(events, now, {
    outcomeDefinition: model.outcomeDefinition,
  });
  // Freeze the first predeclared prospective cohort. Repeated polling must not keep extending
  // a failed test until random fluctuations happen to make its confidence interval favorable.
  const prospective = getIndependentRows(
    rows.filter(
      (row) =>
        row.decision.cohort === 'kalshi-background' &&
        matchesOutcomeModelPipeline(model, row.learningFeatures) &&
        row.windowStartAt > model.shadowStartsAt &&
        row.capturedAt > model.shadowStartsAt,
    ),
  ).slice(0, LEARNING_REQUIREMENTS.minimumShadowWindows);
  const scored = prospective.filter((row) => {
    const shadow = row.decision.shadowPrediction;
    const expectedProbability = predictOutcomeCandidate(model, row.learningFeatures);
    return (
      shadow?.modelId === model.id &&
      shadow.featureCutoffAt === row.capturedAt &&
      row.features &&
      typeof shadow.aboveProbability === 'number' &&
      Number.isFinite(shadow.aboveProbability) &&
      shadow.aboveProbability >= 0 &&
      shadow.aboveProbability <= 1 &&
      expectedProbability !== null &&
      Math.abs(shadow.aboveProbability - expectedProbability) <= 1e-9
    );
  });
  const coverage = prospective.length ? scored.length / prospective.length : 0;
  const evaluationComplete = prospective.length >= LEARNING_REQUIREMENTS.minimumShadowWindows;
  if (
    scored.length < LEARNING_REQUIREMENTS.minimumShadowWindows ||
    !hasEnoughExamplesOfBothOutcomes(scored)
  )
    return {
      status: evaluationComplete ? 'shadow' : 'insufficient-data',
      evaluationComplete,
      eligibleForPromotion: false,
      modelId: model.id,
      evaluatedAt: now,
      independentWindows: scored.length,
      eligibleWindows: prospective.length,
      callCoverage: coverage,
      reasons: [
        evaluationComplete
          ? 'The first 120 eligible windows lack complete candidate coverage or enough examples of both outcomes. This candidate cannot be promoted.'
          : 'At least 120 new independent background windows with both outcomes and contemporaneously recorded candidate predictions are required.',
      ],
    };
  const probabilities = scored.map((row) => row.decision.shadowPrediction.aboveProbability);
  const evaluation = comparePredictions(scored, probabilities);
  evaluation.modelUses = countLearnedAdjustments(scored, probabilities, model);
  evaluation.fallbackUses = scored.length - evaluation.modelUses;
  const uncertainty = getPairedBootstrapUncertainty(scored, probabilities);
  const reasons = [...evaluation.reasons];
  if (evaluation.modelUses < LEARNING_REQUIREMENTS.minimumShadowModelUses)
    reasons.push('At least 60 of the prospective windows must actually use a learned adjustment.');
  if (coverage < 1)
    reasons.push(
      'The candidate lacks a recorded prediction for some eligible windows; equal call coverage is required.',
    );
  if (
    uncertainty.accuracyDifference[0] <= 0 ||
    uncertainty.brierDifference[1] >= 0 ||
    uncertainty.benchmarkAccuracyDifference[0] <= 0
  )
    reasons.push('The prospective improvement is not yet separated from sampling uncertainty.');
  return {
    ...evaluation,
    evaluationComplete,
    status: reasons.length ? 'shadow' : 'ready',
    eligibleForPromotion: reasons.length === 0,
    modelId: model.id,
    evaluatedAt: now,
    independentWindows: scored.length,
    eligibleWindows: prospective.length,
    firstWindowAt: scored[0].windowStartAt,
    lastDeadlineAt: Math.max(...scored.map((row) => row.expiresAt)),
    callCoverage: coverage,
    uncertainty,
    reasons,
  };
}

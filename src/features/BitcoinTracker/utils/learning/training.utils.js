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

const representative = getWindowRepresentative;
const weightedCheckpoints = (groups) =>
  groups.flatMap((group) => {
    // Multiple collectors may see the same checkpoint. Retain one contemporaneous decision per
    // contract horizon, then give every independent window a total fitting weight of one.
    const checkpoints = new Map();
    for (const row of [...group.rows].sort(
      (a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id),
    )) {
      const key = row.decision?.checkpointMinutes ?? Math.round(row.horizonMinutes);
      if (!checkpoints.has(key)) checkpoints.set(key, row);
    }
    return [...checkpoints.values()].map((row) => ({ ...row, weight: 1 / checkpoints.size }));
  });
const bothClasses = (rows) =>
  [0, 1].every(
    (outcome) =>
      rows.filter((row) => row.outcome === outcome).length >=
      LEARNING_REQUIREMENTS.minimumClassExamples,
  );
const cutoff = (groups) =>
  groups.length
    ? Math.max(
        ...groups.map((group) => Math.max(group.endAt, ...group.rows.map((row) => row.resolvedAt))),
      )
    : 0;

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
  const trainingCutoffAt = cutoff(trainingGroups);
  const calibrationGroups = groups
    .slice(trainingEnd, calibrationEnd)
    .filter((group) => group.startAt >= trainingCutoffAt);
  const calibrationCutoffAt = cutoff(calibrationGroups);
  const testGroups = groups
    .slice(calibrationEnd)
    .filter((group) => group.startAt >= Math.max(trainingCutoffAt, calibrationCutoffAt));
  return {
    train: trainingGroups.map(representative),
    calibration: calibrationGroups.map(representative),
    test: testGroups.map(representative),
    trainingCheckpoints: weightedCheckpoints(trainingGroups),
    calibrationCheckpoints: weightedCheckpoints(calibrationGroups),
    trainingCutoffAt,
    calibrationCutoffAt,
    evaluationCutoffAt: cutoff(testGroups),
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

function fingerprint(rows) {
  let value = 2166136261;
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
      value = Math.imul(value ^ encoded.charCodeAt(index), 16777619) >>> 0;
  }
  return value.toString(36);
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
  const sufficient =
    split.train.length >= LEARNING_REQUIREMENTS.minimumTrainingWindows &&
    split.calibration.length >= LEARNING_REQUIREMENTS.minimumCalibrationWindows &&
    split.test.length >= LEARNING_REQUIREMENTS.minimumTestWindows;
  if (!sufficient || ![split.train, split.calibration, split.test].every(bothClasses)) {
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
    const model = fitLogistic(
      split.trainingCheckpoints,
      LEARNING_FEATURE_NAMES.map((_, index) => index),
      { penalty: LEARNING_REQUIREMENTS.penalty, maximumIterations: 50 },
    );
    const applicability = {
      baselineModelVersion: pipeline.baselineModelVersion,
      featureInputSources: [pipeline.featureInputSource],
      minimumHorizonMinutes: Math.min(
        ...split.trainingCheckpoints.map((row) => row.horizonMinutes),
      ),
      maximumHorizonMinutes: Math.max(
        ...split.trainingCheckpoints.map((row) => row.horizonMinutes),
      ),
      minimumTargetDistance: Math.min(
        ...split.trainingCheckpoints.map((row) => row.learningFeatures.targetDistance),
      ),
      maximumTargetDistance: Math.max(
        ...split.trainingCheckpoints.map((row) => row.learningFeatures.targetDistance),
      ),
      availabilityPatterns: [
        ...new Set(
          split.trainingCheckpoints.map((row) =>
            LEARNING_AVAILABILITY_INDEXES.map((index) => row.features[index]).join(''),
          ),
        ),
      ],
      ...(outcomeDefinition === KALSHI_OUTCOME_DEFINITION
        ? {
            referenceSources: [
              ...new Set(
                split.trainingCheckpoints.map((row) => row.learningFeatures.referenceSource),
              ),
            ],
          }
        : {}),
    };
    const supportedCalibration = split.calibration.filter((row) =>
      isWithinOutcomeModelDomain({ applicability, outcomeDefinition }, row.learningFeatures),
    );
    if (
      supportedCalibration.length < LEARNING_REQUIREMENTS.minimumCalibrationWindows ||
      !bothClasses(supportedCalibration)
    )
      return {
        status: 'insufficient-data',
        artifact: null,
        counts: sampleCounts,
        reason:
          'More independent calibration windows are needed within the training horizon and observed feed-availability states.',
      };
    const calibrationRows = split.calibrationCheckpoints
      .filter((row) =>
        isWithinOutcomeModelDomain({ applicability, outcomeDefinition }, row.learningFeatures),
      )
      .map((row) => ({
        ...row,
        features: [logit(predictLogistic(model, row.features))],
      }));
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
      isWithinOutcomeModelDomain({ applicability, outcomeDefinition }, row.learningFeatures)
        ? predictLogistic(calibration, [logit(predictLogistic(model, row.features))])
        : row.learningFeatures.baselineAboveProbability,
    );
    const evaluation = comparePredictions(split.test, probabilities);
    evaluation.modelUses = split.test.filter(
      (row, index) =>
        isWithinOutcomeModelDomain({ applicability, outcomeDefinition }, row.learningFeatures) &&
        Math.abs(probabilities[index] - row.learningFeatures.baselineAboveProbability) > 1e-9,
    ).length;
    evaluation.fallbackUses = split.test.length - evaluation.modelUses;
    if (evaluation.modelUses < LEARNING_REQUIREMENTS.minimumTestModelUses)
      evaluation.reasons.push(
        'At least 30 later test windows must actually use a learned adjustment; a baseline-only candidate is not an improvement.',
      );
    const version = KALSHI_OUTCOME_MODEL_VERSION;
    const artifact = {
      id: `${version}-${now}-${fingerprint(usable)}`,
      version,
      status: 'shadow',
      trainedAt: now,
      featureVersion: LEARNING_FEATURE_VERSION,
      outcomeDefinition,
      trainingCutoffAt: split.trainingCutoffAt,
      calibrationCutoffAt: split.calibrationCutoffAt,
      evaluationCutoffAt: split.evaluationCutoffAt,
      shadowStartsAt: now,
      datasetFingerprint: fingerprint(usable),
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

function pairedUncertainty(rows, probabilities) {
  let seed = 0x1a2b3c4d;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const accuracy = [];
  const brier = [];
  const benchmarkAccuracy = [];
  for (let sample = 0; sample < LEARNING_REQUIREMENTS.bootstrapReplicates; sample++) {
    let accuracyDelta = 0;
    let brierDelta = 0;
    let benchmarkDelta = 0;
    for (let index = 0; index < rows.length; index++) {
      const selected = Math.floor(random() * rows.length);
      const row = rows[selected];
      const probability = probabilities[selected];
      const correct = probability === 0.5 ? 0.5 : Number(Number(probability > 0.5) === row.outcome);
      accuracyDelta +=
        correct -
        (row.probability === 0.5 ? 0.5 : Number(Number(row.probability > 0.5) === row.outcome));
      benchmarkDelta +=
        correct - (row.currentSide === 0.5 ? 0.5 : Number(row.currentSide === row.outcome));
      brierDelta += (probability - row.outcome) ** 2 - (row.probability - row.outcome) ** 2;
    }
    accuracy.push(accuracyDelta / rows.length);
    brier.push(brierDelta / rows.length);
    benchmarkAccuracy.push(benchmarkDelta / rows.length);
  }
  const interval = (values) => {
    values.sort((a, b) => a - b);
    return [
      values[Math.floor(values.length * 0.025)],
      values[Math.min(values.length - 1, Math.floor(values.length * 0.975))],
    ];
  };
  return {
    method: 'paired-independent-window-bootstrap',
    confidenceLevel: 0.95,
    accuracyDifference: interval(accuracy),
    brierDifference: interval(brier),
    benchmarkAccuracyDifference: interval(benchmarkAccuracy),
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
  if (scored.length < LEARNING_REQUIREMENTS.minimumShadowWindows || !bothClasses(scored))
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
  evaluation.modelUses = scored.filter(
    (row, index) =>
      isWithinOutcomeModelDomain(model, row.learningFeatures) &&
      Math.abs(probabilities[index] - row.learningFeatures.baselineAboveProbability) > 1e-9,
  ).length;
  evaluation.fallbackUses = scored.length - evaluation.modelUses;
  const uncertainty = pairedUncertainty(scored, probabilities);
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

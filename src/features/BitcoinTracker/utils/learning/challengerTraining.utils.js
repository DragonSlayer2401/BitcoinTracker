import jStat from 'jstat';
import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import {
  RESEARCH_EXPERIMENT_V2,
  RESEARCH_EXPERIMENT_V3,
  RESEARCH_EXPERIMENT_V4,
  RESEARCH_EXPERIMENT_V5,
} from '../researchVariantConfig.utils';
import { isLearningFeatureSnapshot } from './features.utils';
import {
  collectLearningEvents,
  getVerifiedLearningRows,
  getIndependentRows,
  groupOverlappingWindows,
  hasContemporaneousInputs,
  scoreLearningRows,
} from './evaluation.utils';
import {
  getWeightedCheckpoints,
  getLatestResolvedAt,
  getDatasetFingerprint,
  selectLearningPipelineRows,
} from './training.utils';
import { fitLogistic, predictLogistic } from './statistics.utils';
import {
  CHALLENGER_KINDS,
  CHALLENGER_MODEL_VERSION,
  CHALLENGER_POLICY_VERSION,
  CHALLENGER_REQUIREMENTS,
  CHALLENGER_VARIANTS,
  REVERSAL_PRESSURE_FEATURE_VERSION,
  getChallengerFeatures,
  LEGACY_CHALLENGER_MODEL_VERSION,
  LEGACY_CHALLENGER_POLICY_VERSION,
  getChallengerRequirements,
  getUncalibratedChallengerProbability,
  isChallengerArtifact,
  isFittedChallenger,
  matchesChallengerPipeline,
  predictChallengerProbability,
  getChallengerPolicyVersion,
  DIRECTIONAL_REVERSAL_KIND,
  DIRECTIONAL_REVERSAL_POLICY_VERSION,
  isDirectionalReversalChallenger,
} from './challengerModel.utils';
import {
  getDirectionalOutcomeProbability,
  DIRECTIONAL_REGULARIZATION_GRID,
  DIRECTIONAL_REGULARIZATION_POLICY,
} from './directionalReversal.utils';

import {
  CHALLENGER_CALIBRATION_VERSION,
  DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION,
  getChallengerCheckpoint,
  fitCheckpointCalibration,
} from './challengerCheckpoint.utils';
import {
  evaluateCheckpointChallenger,
  evaluateCheckpointChallengerActive,
  getChallengerConfirmationCohort,
} from './challengerValidation.utils';
export { getChallengerConfirmationCohort };

const time = (value) => Number.isSafeInteger(value) && value >= 0;
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const classes = (rows) => ({
  above: rows.filter((row) => row.outcome === 1).length,
  below: rows.filter((row) => row.outcome === 0).length,
});
const bothClasses = (rows) =>
  Object.values(classes(rows)).every(
    (count) => count >= CHALLENGER_REQUIREMENTS.minimumClassExamples,
  );

function getForwardLabel(label, row, now) {
  const reference = label?.reference;
  const reading = label?.reading;
  const decision = row.decision;
  const sigma = decision.researchExperiment?.variants?.['settlement-only']?.minuteVolatility;
  if (
    label?.version !== 'brti-forward-label-v1' ||
    label.status !== 'observed' ||
    label.horizonSeconds !== CHALLENGER_REQUIREMENTS.forwardHorizonSeconds ||
    label.snapshotId !== decision.eventId ||
    label.forecastId !== row.id ||
    label.labelId !== `${decision.eventId}:forward:60` ||
    label.capturedAt !== row.capturedAt ||
    !time(label.recordedAt) ||
    label.recordedAt > now ||
    label.dueAt !== Math.ceil((row.capturedAt + 60_000) / 1000) * 1000 ||
    label.recordedAt < label.dueAt ||
    reference?.source !== 'cf-brti' ||
    reference.time !== decision.quoteTime ||
    reference.price !== decision.spot ||
    reference.receivedAt !== decision.receivedAt ||
    !time(reference.time) ||
    reference.time % 1000 !== 0 ||
    !Number.isFinite(reference.price) ||
    reference.price <= 0 ||
    reference.time > row.capturedAt ||
    row.capturedAt - reference.time > 5000 ||
    !time(reference.receivedAt) ||
    reference.receivedAt < reference.time ||
    reference.receivedAt > row.capturedAt ||
    reading?.time !== label.dueAt ||
    !time(reading.receivedAt) ||
    reading.receivedAt < reading.time ||
    reading.receivedAt > label.recordedAt ||
    !Number.isFinite(reading.price) ||
    !(reading.price > 0) ||
    !Number.isFinite(label.logReturn) ||
    Math.abs(label.logReturn - Math.log(reading.price / reference.price)) > 1e-12 ||
    !Number.isFinite(sigma) ||
    sigma <= 0
  )
    return null;
  const normalizedReturn =
    label.logReturn / (sigma * Math.sqrt((label.dueAt - reference.time) / 60_000));
  return Number.isFinite(normalizedReturn)
    ? { normalizedReturn, recordedAt: label.recordedAt }
    : null;
}

export function getChallengerTrainingRows(events, labels = [], kind, now = Date.now()) {
  const verified = getVerifiedLearningRows(events, now);
  const selected = selectLearningPipelineRows(verified.rows);
  const pipeline = selected.pipeline && {
    ...selected.pipeline,
    featureVersion: selected.rows[0]?.learningFeatures.schemaVersion,
  };
  if (
    !pipeline ||
    pipeline.referenceSource !== 'cf-brti' ||
    pipeline.featureInputSource !== 'cf-brti-history'
  )
    return {
      rows: [],
      pipeline: null,
      counts: { independentWindows: 0, classes: { above: 0, below: 0 } },
    };
  const byId = new Map();
  const conflicts = new Set();
  for (const label of labels) {
    if (label?.horizonSeconds !== 60) continue;
    if (
      byId.has(label.snapshotId) &&
      JSON.stringify(byId.get(label.snapshotId)) !== JSON.stringify(label)
    )
      conflicts.add(label.snapshotId);
    byId.set(label.snapshotId, label);
  }
  const rows = selected.rows.flatMap((row) => {
    if (kind === DIRECTIONAL_REVERSAL_KIND && row.decision.researchReplay?.replayable === false)
      return [];
    if (kind !== 'forward-pressure') return [row];
    const label = conflicts.has(row.decision.eventId)
      ? null
      : getForwardLabel(byId.get(row.decision.eventId), row, now);
    const features = getChallengerFeatures(kind, row.learningFeatures);
    return label && (features[4] || features[5])
      ? [{ ...row, forwardReturn: label.normalizedReturn, forwardRecordedAt: label.recordedAt }]
      : [];
  });
  const independent = getIndependentRows(rows);
  return {
    rows,
    pipeline,
    counts: {
      independentWindows: independent.length,
      classes: classes(independent),
      reversals: independent.filter((row) => row.currentSide !== row.outcome).length,
    },
  };
}

function fitForwardRegression(rows) {
  const indexes = [0, 1, 2, 3, 4, 5];
  const weight = rows.reduce((sum, row) => sum + row.weight, 0);
  const means = indexes.map(
    (index) => rows.reduce((sum, row) => sum + row.features[index] * row.weight, 0) / weight,
  );
  const scales = indexes.map(
    (index) =>
      Math.sqrt(
        rows.reduce((sum, row) => sum + row.weight * (row.features[index] - means[index]) ** 2, 0) /
          weight,
      ) || 1,
  );
  const matrix = Array.from({ length: 7 }, () => Array(7).fill(0));
  const response = Array(7).fill(0);
  for (const row of rows) {
    const x = [1, ...indexes.map((index) => (row.features[index] - means[index]) / scales[index])];
    for (let i = 0; i < 7; i++) {
      response[i] += (row.weight * x[i] * row.forwardReturn) / weight;
      for (let j = 0; j < 7; j++) matrix[i][j] += (row.weight * x[i] * x[j]) / weight;
    }
  }
  for (let index = 0; index < 7; index++) matrix[index][index] += index ? 0.5 : 1e-8;
  const coefficients = jStat.lstsq(matrix, response);
  if (!coefficients.every(Number.isFinite))
    throw new Error('The forward pressure fit is unstable.');
  return { indexes, means, scales, coefficients, penalty: 0.5, trainingRows: rows.length };
}

/** Read-only readiness uses the same chronological partitions as the actual fit. */
function getTrainingPartition(events, labels, { kind, now, version }) {
  if (!CHALLENGER_KINDS.includes(kind) || !time(now))
    throw new Error('Invalid challenger training request.');
  const selected = getChallengerTrainingRows(events, labels, kind, now);
  const { pipeline } = selected;
  const legacy = version === LEGACY_CHALLENGER_MODEL_VERSION;
  if (legacy && kind === DIRECTIONAL_REVERSAL_KIND)
    throw new Error('Directional reversal requires the current lifecycle.');
  if (!legacy && version !== CHALLENGER_MODEL_VERSION)
    throw new Error('Unsupported challenger version.');
  const requirements = getChallengerRequirements(version, kind);
  const all =
    legacy || kind === DIRECTIONAL_REVERSAL_KIND
      ? selected
      : getChallengerTrainingRows(events, [], 'reversal', now);
  const allGroups = groupOverlappingWindows(all.rows);
  const heldOutStart = Math.max(
    0,
    allGroups.length - (requirements.minimumCalibrationWindows ?? 0),
  );
  const calibrationStartAt = allGroups[heldOutStart]?.startAt ?? 0;
  // Adjacent Kalshi contracts start before the previous result is published. Purge
  // the trailing fit group, preserving all twenty held-out calibration contracts.
  const historical = legacy
    ? selected.rows
    : groupOverlappingWindows(selected.rows)
        .filter(
          (group) =>
            Math.max(
              getLatestResolvedAt([group]),
              ...group.rows.map((row) => row.forwardRecordedAt ?? 0),
            ) <= calibrationStartAt,
        )
        .flatMap((group) => group.rows);
  const groups = groupOverlappingWindows(historical);
  const primaryCutoffAt = Math.max(
    getLatestResolvedAt(groups),
    ...historical.map((row) => row.forwardRecordedAt ?? 0),
  );
  const calibrationGroups = legacy
    ? []
    : allGroups.slice(heldOutStart).filter((group) => group.startAt >= primaryCutoffAt);
  const primaryIndependent = getIndependentRows(historical);
  const counts = {
    ...selected.counts,
    primaryFitWindows: primaryIndependent.length,
    calibrationWindows: calibrationGroups.length,
    requiredCalibrationWindows: requirements.minimumCalibrationWindows ?? 0,
  };
  const ready =
    counts.primaryFitWindows >= requirements.minimumTrainingWindows &&
    (legacy || calibrationGroups.length >= requirements.minimumCalibrationWindows) &&
    bothClasses(primaryIndependent) &&
    (!['reversal', DIRECTIONAL_REVERSAL_KIND].includes(kind) ||
      primaryIndependent.filter((row) => row.currentSide !== row.outcome).length >=
        requirements.minimumReversalExamples) &&
    (kind !== DIRECTIONAL_REVERSAL_KIND ||
      primaryIndependent.filter((row) => row.currentSide === row.outcome).length >=
        requirements.minimumClassExamples);
  const reason = legacy
    ? 'Collect 60 independent completed native BRTI events, with ten of each outcome; reversal fitting also needs twelve opposite-side outcomes and forward pressure needs exact 60-second labels.'
    : 'Collect 60 earlier independent native BRTI events for primary fitting, then 20 separate later events for calibration. Reversal fitting needs twelve opposite-side outcomes; forward fitting needs exact 60-second labels only in its primary partition.';
  return {
    ready,
    reason,
    counts,
    selected,
    pipeline,
    groups,
    primaryCutoffAt,
    calibrationGroups,
    legacy,
    requirements,
  };
}

export function getChallengerTrainingReadiness(
  events,
  labels = [],
  { kind, now = Date.now(), version = CHALLENGER_MODEL_VERSION } = {},
) {
  const { ready, counts, reason } = getTrainingPartition(events, labels, { kind, now, version });
  return { ready, counts, reason };
}

function selectDirectionalRegularization(groups, getCheckpoints) {
  const folds = [];
  for (let start = 30; start + 10 <= groups.length; start += 10) {
    const validation = groups.slice(start, start + 10);
    const earlier = groups
      .slice(0, start)
      .filter((group) => getLatestResolvedAt([group]) <= validation[0].startAt);
    if (earlier.length < 30) continue;
    folds.push({
      training: getCheckpoints(earlier),
      validation: getCheckpoints(validation),
      details: {
        trainingWindows: earlier.length,
        validationWindows: validation.length,
        trainingCutoffAt: getLatestResolvedAt(earlier),
        validationStartedAt: validation[0].startAt,
        validationCutoffAt: getLatestResolvedAt(validation),
      },
    });
  }
  const scores = [...DIRECTIONAL_REGULARIZATION_GRID].reverse().map((penalty) => {
    let error = 0;
    let weight = 0;
    for (const fold of folds) {
      const model = fitLogistic(
        fold.training,
        fold.training[0].features.map((_, index) => index),
        { penalty, maximumIterations: 50 },
      );
      for (const row of fold.validation) {
        error += row.weight * (predictLogistic(model, row.features) - row.outcome) ** 2;
        weight += row.weight;
      }
    }
    return { penalty, brier: weight ? error / weight : null };
  });
  let selected = scores[0];
  for (const score of scores)
    if (score.brier !== null && (selected.brier === null || score.brier < selected.brier - 1e-12))
      selected = score;
  return {
    version: DIRECTIONAL_REGULARIZATION_POLICY,
    criterion: 'event-weighted-forward-validation-brier',
    grid: [...DIRECTIONAL_REGULARIZATION_GRID],
    folds: folds.map((fold) => fold.details),
    scores,
    selectedPenalty: selected.penalty,
    fallback: folds.length === 0,
  };
}

/** Historical outcomes fit frozen candidates; only later recorded decisions can approve them. */
export function trainChallengerCandidate(
  events,
  labels = [],
  { kind, now = Date.now(), version = CHALLENGER_MODEL_VERSION } = {},
) {
  const {
    ready,
    reason,
    counts,
    selected,
    pipeline,
    groups,
    primaryCutoffAt,
    calibrationGroups,
    legacy,
    requirements,
  } = getTrainingPartition(events, labels, { kind, now, version });
  if (!ready) return { status: 'insufficient-data', artifact: null, counts, reason };
  try {
    const reversalFeatureVersion =
      kind === 'reversal' && !legacy ? REVERSAL_PRESSURE_FEATURE_VERSION : undefined;
    const getCheckpoints = (selectedGroups) =>
      getWeightedCheckpoints(selectedGroups).map((row) => ({
        ...row,
        features: getChallengerFeatures(
          kind,
          row.learningFeatures,
          reversalFeatureVersion,
          row.currentSide,
          row.marketProbability,
        ),
        ...(kind === DIRECTIONAL_REVERSAL_KIND
          ? { outcome: Number(row.outcome !== row.currentSide) }
          : {}),
      }));
    const checkpoints = getCheckpoints(groups);
    const regularization =
      kind === DIRECTIONAL_REVERSAL_KIND
        ? selectDirectionalRegularization(groups, getCheckpoints)
        : null;
    const model = ['reversal', DIRECTIONAL_REVERSAL_KIND].includes(kind)
      ? fitLogistic(
          checkpoints,
          checkpoints[0].features.map((_, index) => index),
          {
            penalty: regularization?.selectedPenalty ?? 0.5,
            maximumIterations: 50,
          },
        )
      : kind === 'forward-pressure'
        ? fitForwardRegression(checkpoints)
        : null;
    if (regularization) model.regularization = regularization;
    const cutoff = Math.max(
      getLatestResolvedAt(groups),
      ...checkpoints.map((row) => row.forwardRecordedAt ?? 0),
    );
    const artifact = {
      id: `${version}-${kind}-${now}-${getDatasetFingerprint(checkpoints)}`,
      version,
      kind,
      variantName: CHALLENGER_VARIANTS[kind],
      policyVersion:
        kind === DIRECTIONAL_REVERSAL_KIND
          ? DIRECTIONAL_REVERSAL_POLICY_VERSION
          : legacy
            ? LEGACY_CHALLENGER_POLICY_VERSION
            : CHALLENGER_POLICY_VERSION,
      status: 'shadow',
      variantPolicyVersion: getChallengerPolicyVersion(kind, version),
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      trainedAt: now,
      trainingCutoffAt: cutoff,
      shadowStartsAt: now,
      featureVersion: pipeline.featureVersion,
      ...(reversalFeatureVersion ? { reversalFeatureVersion } : {}),
      pipeline,
      requirements: { ...requirements },
      model,
      applicability: {
        minimumHorizonMinutes: Math.min(...selected.rows.map((row) => row.horizonMinutes)),
        maximumHorizonMinutes: Math.max(...selected.rows.map((row) => row.horizonMinutes)),
      },
      evaluation: { eligibleForShadow: true, counts, reasons: [] },
    };
    if (!legacy) {
      const calibrationRows = getWeightedCheckpoints(calibrationGroups).flatMap((row) => {
        const experiment = row.decision.researchExperiment;
        const raw = getUncalibratedChallengerProbability(artifact, {
          baseForecast: {
            available: true,
            aboveProbability: row.learningFeatures.baselineAboveProbability,
            target: row.target,
            expiresAt: row.expiresAt,
            researchVariants: experiment?.variants,
            kalshi: { referencePrice: row.decision.spot },
          },
          learningFeatures: row.learningFeatures,
          input: {
            now: row.capturedAt,
            kalshiMarket: row.decision.kalshiMarket,
            kalshiQuote: row.decision.kalshiQuote,
          },
          variantBase: experiment?.variants?.[artifact.variantName],
        });
        return probability(raw)
          ? [
              {
                ...row,
                probability: isDirectionalReversalChallenger(artifact)
                  ? getDirectionalOutcomeProbability(raw, row.currentSide)
                  : raw,
                ...(isDirectionalReversalChallenger(artifact)
                  ? { outcome: Number(row.outcome !== row.currentSide) }
                  : {}),
              },
            ]
          : [];
      });
      artifact.calibration = {
        version: isDirectionalReversalChallenger(artifact)
          ? DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION
          : CHALLENGER_CALIBRATION_VERSION,
        ...(isDirectionalReversalChallenger(artifact) ? { target: 'opposite-current-side' } : {}),
        primaryCutoffAt,
        startedAt: calibrationGroups[0].startAt,
        cutoffAt: getLatestResolvedAt(calibrationGroups),
        independentWindows: calibrationGroups.length,
        checkpoints: fitCheckpointCalibration(calibrationRows, {
          maximumBaselineAdjustment:
            isFittedChallenger(kind) && !isDirectionalReversalChallenger(artifact)
              ? requirements.maximumProbabilityAdjustment
              : null,
        }),
      };
      if (isDirectionalReversalChallenger(artifact)) {
        // This is diagnostic only: these labels subsequently fit calibration. Activation
        // still requires two untouched prospective cohorts to establish directional lift.
        artifact.evaluation.heldOutDirection = artifact.calibration.checkpoints.map((entry) => {
          const rows = calibrationRows.filter(
            (row) => getChallengerCheckpoint(row.horizonMinutes) === entry.checkpointMinutes,
          );
          const candidateCorrect = rows.filter(
            (row) => row.probability !== 0.5 && Number(row.probability > 0.5) === row.outcome,
          ).length;
          const currentSideCorrect = rows.filter((row) => row.outcome === 0).length;
          return {
            checkpointMinutes: entry.checkpointMinutes,
            samples: rows.length,
            candidateCorrect,
            currentSideCorrect,
            additionalCorrect: candidateCorrect - currentSideCorrect,
          };
        });
      }
      artifact.trainingCutoffAt = Math.max(cutoff, artifact.calibration.cutoffAt);
    }
    if (!isChallengerArtifact(artifact)) throw new Error('Invalid challenger artifact.');
    return {
      status: 'shadow',
      artifact,
      counts,
      reason:
        'The candidate is frozen for prospective comparison and cannot change production forecasts yet.',
    };
  } catch {
    return {
      status: 'candidate-rejected',
      artifact: null,
      counts,
      reason:
        'The fit did not produce a valid bounded candidate; the production model is retained.',
    };
  }
}

function getBrierUncertainty(rows, probabilities, comparator) {
  let seed = 0x2a3b4c5d;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const differences = [];
  // Short chronological blocks preserve nearby-event dependence. Five declared candidate
  // families use 99% intervals (Bonferroni .05/5), not five unadjusted 95% opportunities.
  for (let replicate = 0; replicate < CHALLENGER_REQUIREMENTS.bootstrapReplicates; replicate++) {
    let total = 0;
    let count = 0;
    while (count < rows.length) {
      const start = Math.floor(next() * Math.max(1, rows.length - 3));
      for (let offset = 0; offset < 4 && count < rows.length; offset++, count++) {
        const index = Math.min(rows.length - 1, start + offset);
        total +=
          (probabilities[index] - rows[index].outcome) ** 2 -
          (comparator(rows[index]) - rows[index].outcome) ** 2;
      }
    }
    differences.push(total / rows.length);
  }
  differences.sort((a, b) => a - b);
  return {
    confidenceLevel: CHALLENGER_REQUIREMENTS.familyConfidenceLevel,
    method: 'paired-four-event-block-bootstrap',
    brierDifference: [
      differences[Math.floor(differences.length * 0.005)],
      differences[Math.min(differences.length - 1, Math.floor(differences.length * 0.995))],
    ],
  };
}

function getRecordedVariant(artifact, row) {
  // An invalid captured input stays in its prospective contract cohort, but cannot
  // supply a score. Excluding it during enrollment would backfill a later contract.
  if (
    isDirectionalReversalChallenger(artifact) &&
    row.decision.researchReplay?.replayable === false
  )
    return null;
  const experiment = row.decision.researchExperiment;
  const variant =
    experiment?.activePrediction?.modelId === artifact.id
      ? experiment.activePrediction
      : experiment?.variants?.[artifact.variantName];
  const production = experiment?.production;
  const combined = experiment?.variants?.combined;
  if (
    ![
      RESEARCH_EXPERIMENT_V2,
      RESEARCH_EXPERIMENT_V3,
      RESEARCH_EXPERIMENT_V4,
      RESEARCH_EXPERIMENT_V5,
    ].includes(experiment?.version) ||
    experiment.capturedAt !== row.capturedAt ||
    experiment.target !== row.target ||
    experiment.expiresAt !== row.expiresAt ||
    experiment.marketTicker !== row.marketTicker ||
    variant?.modelId !== artifact.id ||
    variant.available !== true ||
    variant.policyVersion !== artifact.variantPolicyVersion ||
    variant.featureCutoffAt !== row.capturedAt ||
    combined?.available !== true ||
    variant.referenceSource !== 'cf-brti' ||
    variant.referenceSource !== combined.referenceSource ||
    variant.referenceAt !== combined.referenceAt ||
    variant.referencePrice !== combined.referencePrice ||
    variant.minuteVolatility !== combined.minuteVolatility ||
    !probability(variant.aboveProbability) ||
    !probability(variant.belowProbability) ||
    Math.abs(variant.aboveProbability + variant.belowProbability - 1) > 1e-9 ||
    !probability(production?.aboveProbability) ||
    production.aboveProbability !== row.probability
  )
    return null;
  // Fitted probabilities can be reproduced from the contemporaneous compact features/moments.
  // Fixed-policy experiments retain their frozen policy identity in their original snapshot.
  const expected = predictChallengerProbability(artifact, {
    baseForecast: {
      available: true,
      aboveProbability: row.learningFeatures.baselineAboveProbability,
      target: row.target,
      expiresAt: row.expiresAt,
      researchVariants: experiment.variants,
      kalshi: { referencePrice: row.decision.spot },
    },
    learningFeatures: row.learningFeatures,
    input: {
      now: row.capturedAt,
      kalshiMarket: row.decision.kalshiMarket,
      kalshiQuote: row.decision.kalshiQuote,
    },
    windowStartAt: row.windowStartAt,
    variantBase: variant,
  });
  return expected !== null && Math.abs(expected - variant.aboveProbability) <= 1e-9
    ? variant.aboveProbability
    : null;
}

/** Freeze the first future cohort before consulting labels or recorded candidate coverage. */
function evaluateLegacyChallengerCandidate(artifact, events, { now = Date.now() } = {}) {
  if (!isChallengerArtifact(artifact) || artifact.retirement)
    return {
      status: 'candidate-rejected',
      eligibleForPromotion: false,
      evaluationComplete: false,
      reasons: ['A current frozen challenger artifact is required.'],
      modelId: artifact?.id ?? null,
    };
  const { decisions, outcomes, conflicts } = collectLearningEvents(events, now);
  const eligible = [...decisions.values()]
    .filter(
      (decision) =>
        decision.cohort === 'kalshi-background' &&
        hasContemporaneousInputs(decision) &&
        decision.windowStartAt > artifact.shadowStartsAt &&
        matchesChallengerPipeline(artifact, decision.learningFeatures) &&
        decision.learningFeatures.settlementKnownFraction === 0 &&
        isLearningFeatureSnapshot(decision.learningFeatures, {
          target: decision.target,
          expiresAt: decision.expiresAt,
          cutoffAt: decision.capturedAt,
          outcomeDefinition: artifact.outcomeDefinition,
        }) &&
        probability(decision.aboveProbability),
    )
    .map((decision) => ({
      id: decision.forecastId,
      windowStartAt: decision.windowStartAt,
      expiresAt: decision.expiresAt,
      capturedAt: decision.capturedAt,
      horizonMinutes: (decision.expiresAt - decision.capturedAt) / 60_000,
      outcomeDefinition: artifact.outcomeDefinition,
      decision,
    }));
  const prospective = getIndependentRows(eligible).slice(
    0,
    CHALLENGER_REQUIREMENTS.minimumShadowWindows,
  );
  const verified = new Map(getVerifiedLearningRows(events, now).rows.map((row) => [row.id, row]));
  const resolved = prospective.map((row) => verified.get(row.id)).filter(Boolean);
  const scored = resolved.flatMap((row) => {
    const predicted = getRecordedVariant(artifact, row);
    return predicted === null ? [] : [{ ...row, challengerProbability: predicted }];
  });
  const terminalFailure = prospective.some(
    (row) => conflicts.has(row.id) || outcomes.get(row.id)?.outcomeStatus === 'unobserved',
  );
  const complete =
    prospective.length === CHALLENGER_REQUIREMENTS.minimumShadowWindows &&
    (resolved.length === prospective.length || terminalFailure);
  const common = {
    modelId: artifact.id,
    kind: artifact.kind,
    evaluatedAt: now,
    independentWindows: scored.length,
    eligibleWindows: prospective.length,
    resolvedWindows: resolved.length,
    scoredWindows: scored.length,
    requiredWindows: CHALLENGER_REQUIREMENTS.minimumShadowWindows,
    cohortForecastIds: prospective.map((row) => row.id),
    callCoverage: prospective.length ? scored.length / prospective.length : 0,
    evaluationComplete: complete,
  };
  const probabilities = scored.map((row) => row.challengerProbability);
  const metrics = {
    candidate: scoreLearningRows(
      scored.map((row) => ({ ...row, probability: row.challengerProbability })),
    ),
    baseline: scoreLearningRows(
      scored.map((row) => ({ ...row, probability: row.learningFeatures.baselineAboveProbability })),
    ),
    production: scoreLearningRows(scored),
    currentSide: scoreLearningRows(scored.map((row) => ({ ...row, probability: row.currentSide }))),
  };
  if (!complete || terminalFailure || scored.length !== prospective.length || !bothClasses(scored))
    return {
      ...common,
      ...metrics,
      status: complete ? 'candidate-rejected' : 'collecting',
      eligibleForPromotion: false,
      reasons: [
        complete
          ? 'The fixed validation cohort lacks complete recorded coverage or ten examples of each outcome.'
          : 'Record the first 60 independent future events and wait for their official outcomes.',
      ],
    };
  const uncertainty = getBrierUncertainty(
    scored,
    probabilities,
    (row) => row.learningFeatures.baselineAboveProbability,
  );
  const productionUncertainty = getBrierUncertainty(
    scored,
    probabilities,
    (row) => row.probability,
  );
  const modelUses = scored.filter(
    (row) =>
      Math.abs(row.challengerProbability - row.learningFeatures.baselineAboveProbability) > 1e-9,
  ).length;
  const reasons = [];
  if (modelUses < CHALLENGER_REQUIREMENTS.minimumModelUses)
    reasons.push('At least 30 future events must use a real adjustment.');
  if (uncertainty.brierDifference[1] >= 0 || productionUncertainty.brierDifference[1] >= 0)
    reasons.push(
      'Family-adjusted probability-error intervals do not establish improvement over both baseline and production.',
    );
  if (
    metrics.candidate.callAccuracy < metrics.baseline.callAccuracy ||
    metrics.candidate.callAccuracy < metrics.production.callAccuracy
  )
    reasons.push('The candidate reduces directional accuracy versus baseline or production.');
  if (
    artifact.kind === 'reversal' &&
    (metrics.baseline.reversals < CHALLENGER_REQUIREMENTS.minimumReversalExamples ||
      !(metrics.candidate.reversalRecall > metrics.baseline.reversalRecall) ||
      (metrics.candidate.reversalFalseAlarmRate ?? 0) >
        CHALLENGER_REQUIREMENTS.maximumReversalFalseAlarmRate)
  )
    reasons.push(
      'The reversal candidate needs improved reversal recall with sufficient reversal outcomes and at most 50% false alerts.',
    );
  return {
    ...common,
    ...metrics,
    modelUses,
    uncertainty,
    productionUncertainty,
    status: reasons.length ? 'candidate-rejected' : 'ready',
    eligibleForPromotion: reasons.length === 0,
    reasons,
  };
}

/** Read-only monitoring uses later recorded decisions, never rebuilt historical calls. */
function evaluateLegacyChallengerActiveModel(artifact, events, { now = Date.now() } = {}) {
  const activation = artifact?.activation;
  if (
    !isChallengerArtifact(artifact) ||
    artifact.retirement ||
    activation?.modelId !== artifact.id ||
    !time(activation.activatedAt) ||
    activation.activatedAt < artifact.trainedAt ||
    activation.activatedAt > now ||
    activation.shadowEvaluation?.modelId !== artifact.id ||
    activation.shadowEvaluation?.eligibleForPromotion !== true
  )
    return {
      status: 'disabled',
      reason: 'The challenger has no valid prospective activation.',
      independentWindows: 0,
    };
  const rows = getVerifiedLearningRows(events, now).rows.filter(
    (row) =>
      row.windowStartAt > activation.activatedAt &&
      matchesChallengerPipeline(artifact, row.learningFeatures),
  );
  const latest = getIndependentRows(rows).slice(-CHALLENGER_REQUIREMENTS.minimumMonitoringWindows);
  const scored = latest.filter((row) => {
    const expected = getRecordedVariant(artifact, row);
    return (
      expected !== null &&
      Math.abs(expected - row.probability) <= 1e-9 &&
      (Math.abs(expected - row.learningFeatures.baselineAboveProbability) <= 1e-9 ||
        (row.decision.learning?.applied === true && row.decision.learning.modelId === artifact.id))
    );
  });
  const common = {
    modelId: artifact.id,
    evaluatedAt: now,
    independentWindows: scored.length,
    eligibleWindows: latest.length,
    callCoverage: latest.length ? scored.length / latest.length : 0,
  };
  if (latest.length < CHALLENGER_REQUIREMENTS.minimumMonitoringWindows)
    return {
      ...common,
      status: 'monitoring',
      reason: 'Collect 40 later independent outcomes to monitor the active challenger.',
    };
  if (scored.length !== latest.length)
    return {
      ...common,
      status: 'disabled',
      reason: 'Recent active challenger decisions lack complete matching recorded evidence.',
    };
  const candidate = scoreLearningRows(scored);
  const baseline = scoreLearningRows(
    scored.map((row) => ({ ...row, probability: row.learningFeatures.baselineAboveProbability })),
  );
  const degraded =
    candidate.brier - baseline.brier > CHALLENGER_REQUIREMENTS.maximumBrierDeterioration ||
    baseline.callAccuracy - candidate.callAccuracy >
      CHALLENGER_REQUIREMENTS.maximumAccuracyDeterioration;
  return {
    ...common,
    candidate,
    baseline,
    status: degraded ? 'disabled' : 'healthy',
    reason: degraded
      ? 'Recent challenger probability error or accuracy exceeded the declared deterioration limit.'
      : 'The latest 40 matching independent outcomes remain within the declared deterioration limits.',
  };
}

export function evaluateChallengerCandidate(artifact, events, options = {}) {
  return artifact?.version === LEGACY_CHALLENGER_MODEL_VERSION
    ? evaluateLegacyChallengerCandidate(artifact, events, options)
    : evaluateCheckpointChallenger(artifact, events, options, getRecordedVariant);
}

export function evaluateChallengerActiveModel(artifact, events, options = {}) {
  return artifact?.version === LEGACY_CHALLENGER_MODEL_VERSION
    ? evaluateLegacyChallengerActiveModel(artifact, events, options)
    : evaluateCheckpointChallengerActive(artifact, events, options, getRecordedVariant);
}

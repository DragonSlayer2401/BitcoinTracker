import jStat from 'jstat';
import {
  collectLearningEvents,
  getVerifiedLearningRows,
  groupOverlappingWindows,
  hasContemporaneousInputs,
  scoreLearningRows,
} from './evaluation.utils';
import { isLearningFeatureSnapshot } from './features.utils';
import {
  CHALLENGER_MODEL_VERSION,
  CHALLENGER_REQUIREMENTS,
  isChallengerArtifact,
  matchesChallengerPipeline,
  isDirectionalReversalChallenger,
  DIRECTIONAL_REVERSAL_REQUIREMENTS,
} from './challengerModel.utils';
import {
  CHALLENGER_CHECKPOINTS,
  getChallengerCheckpoint,
  getChallengerConfirmationAlpha,
  getCheckpointReliability,
} from './challengerCheckpoint.utils';

const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const order = (left, right) =>
  left.capturedAt - right.capturedAt || left.id.localeCompare(right.id);

function getFutureGroups(artifact, events, startedAt, now, inclusiveBoundary = false) {
  const { decisions } = collectLearningEvents(events, now);
  // Membership uses recorded contracts with the matching pipeline, not unknown
  // contracts while offline. A bad replay remains a member and fails scoring later.
  return groupOverlappingWindows(
    [...decisions.values()]
      .filter(
        (decision) =>
          decision.cohort === 'kalshi-background' &&
          hasContemporaneousInputs(decision) &&
          (inclusiveBoundary
            ? decision.windowStartAt >= startedAt
            : decision.windowStartAt > startedAt) &&
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
      })),
  );
}

function selectCohort(
  artifact,
  events,
  { startedAt, cohortForecastIds = [], now, inclusiveBoundary = false },
) {
  const groups = getFutureGroups(artifact, events, startedAt, now, inclusiveBoundary).slice(
    0,
    CHALLENGER_REQUIREMENTS.minimumConfirmationWindows,
  );
  const valid =
    Array.isArray(cohortForecastIds) &&
    cohortForecastIds.length <= CHALLENGER_REQUIREMENTS.minimumConfirmationWindows &&
    new Set(cohortForecastIds).size === cohortForecastIds.length &&
    cohortForecastIds.every((id, index) => groups[index]?.rows.some((row) => row.id === id));
  return {
    valid,
    groups,
    cohortForecastIds: valid
      ? groups.map((group, index) => cohortForecastIds[index] ?? [...group.rows].sort(order)[0].id)
      : cohortForecastIds,
    reason: valid ? null : 'Stored cohort members are missing, reordered, or duplicated.',
  };
}

/** Call before scoring: append members by time only, never by outcome or candidate availability. */
export function getChallengerConfirmationCohort(
  artifact,
  events,
  { startedAt, cohortForecastIds = [], now = Date.now(), inclusiveBoundary = false } = {},
) {
  if (
    !isChallengerArtifact(artifact) ||
    artifact.version !== CHALLENGER_MODEL_VERSION ||
    !timestamp(startedAt) ||
    startedAt < artifact.trainedAt ||
    startedAt > now
  )
    return {
      valid: false,
      cohortForecastIds: [],
      eligibleWindows: 0,
      reason: 'Invalid confirmation boundary.',
    };
  const cohort = selectCohort(artifact, events, {
    startedAt,
    cohortForecastIds,
    now,
    inclusiveBoundary,
  });
  return {
    valid: cohort.valid,
    cohortForecastIds: cohort.cohortForecastIds,
    eligibleWindows: cohort.groups.length,
    reason: cohort.reason,
  };
}

/** Approximate parametric uncertainty for chronological four-event block means. */
export function getCheckpointBrierUncertainty(rows, comparator, alpha) {
  const differences = rows.map(
    (row) => (row.challengerProbability - row.outcome) ** 2 - (comparator(row) - row.outcome) ** 2,
  );
  const blocks = [];
  for (let index = 0; index + 4 <= differences.length; index += 4)
    blocks.push(differences.slice(index, index + 4).reduce((sum, value) => sum + value, 0) / 4);
  if (blocks.length < 15 || !(alpha > 0 && alpha < 0.5)) return null;
  const critical = jStat.studentt.inv(1 - alpha, blocks.length - 1);
  if (!Number.isFinite(critical) || critical <= 0) return null;
  const mean = jStat.mean(blocks);
  const error = jStat.stdev(blocks, true) / Math.sqrt(blocks.length);
  return {
    method: 'paired-four-event-block-t-interval',
    assumption: 'Approximate Student t inference for independent chronological block means.',
    confidenceLevel: 1 - alpha,
    oneSided: true,
    blocks: blocks.length,
    alpha,
    brierDifference: [mean - critical * error, mean + critical * error],
  };
}

/** Paired correctness counts test useful disagreements, rather than rewarding a high base rate. */
export function getCheckpointAccuracyUncertainty(rows, alpha) {
  const differences = rows.map(
    (row) =>
      Number(
        row.challengerProbability !== 0.5 &&
          Number(row.challengerProbability > 0.5) === row.outcome,
      ) - Number(row.currentSide === row.outcome),
  );
  const blocks = [];
  for (let index = 0; index + 4 <= differences.length; index += 4)
    blocks.push(differences.slice(index, index + 4).reduce((sum, value) => sum + value, 0) / 4);
  if (blocks.length < 15 || !(alpha > 0 && alpha < 0.5)) return null;
  const critical = jStat.studentt.inv(1 - alpha, blocks.length - 1);
  if (!Number.isFinite(critical) || critical <= 0) return null;
  const mean = jStat.mean(blocks);
  const error = jStat.stdev(blocks, true) / Math.sqrt(blocks.length);
  return {
    method: 'paired-four-event-block-t-interval',
    assumption: 'Approximate Student t inference for independent chronological block means.',
    confidenceLevel: 1 - alpha,
    oneSided: true,
    blocks: blocks.length,
    alpha,
    accuracyDifference: [mean - critical * error, mean + critical * error],
  };
}

function getMetrics(rows) {
  return {
    candidate: scoreLearningRows(
      rows.map((row) => ({ ...row, probability: row.challengerProbability })),
    ),
    baseline: scoreLearningRows(
      rows.map((row) => ({ ...row, probability: row.learningFeatures.baselineAboveProbability })),
    ),
    production: scoreLearningRows(rows),
    currentSide: scoreLearningRows(rows.map((row) => ({ ...row, probability: row.currentSide }))),
  };
}

function evaluateCheckpoint(
  artifact,
  groups,
  verified,
  checkpointMinutes,
  options,
  getRecordedVariant,
) {
  const representatives = groups.map((group) =>
    [...group.rows]
      .sort(order)
      .find((row) => getChallengerCheckpoint(row.horizonMinutes) === checkpointMinutes),
  );
  const resolved = representatives.map((row) => row && verified.get(row.id)).filter(Boolean);
  const scored = resolved.flatMap((row) => {
    const estimate = getRecordedVariant(artifact, row);
    const baseline = row.learningFeatures.baselineAboveProbability;
    const incumbentMatches =
      options.phase !== 'confirmation' ||
      (options.productionModelId == null
        ? row.decision.learning?.applied !== true
        : row.decision.learning?.modelId === options.productionModelId ||
          (row.decision.learning?.applied !== true &&
            Math.abs(row.probability - baseline) <= 1e-9));
    return estimate === null || !incumbentMatches
      ? []
      : [{ ...row, challengerProbability: estimate }];
  });
  const metrics = getMetrics(scored);
  const common = {
    checkpointMinutes,
    ...metrics,
    eligibleWindows: groups.length,
    resolvedWindows: resolved.length,
    independentWindows: scored.length,
    scoredWindows: scored.length,
    requiredWindows: CHALLENGER_REQUIREMENTS.minimumShadowWindows,
    callCoverage: groups.length ? scored.length / groups.length : 0,
    reliability: getCheckpointReliability(
      scored.map((row) => ({ ...row, probability: row.challengerProbability })),
    ),
    modelUses: scored.filter(
      (row) =>
        Math.abs(row.challengerProbability - row.learningFeatures.baselineAboveProbability) > 1e-9,
    ).length,
  };
  const reasons = [];
  const directional = isDirectionalReversalChallenger(artifact);
  if (
    options.complete &&
    (scored.length !== 60 ||
      [0, 1].some((value) => scored.filter((row) => row.outcome === value).length < 10))
  )
    reasons.push(
      'The fixed cohort needs complete matching checkpoint coverage and ten outcomes of each class.',
    );
  const comparisonCount = directional ? DIRECTIONAL_REVERSAL_REQUIREMENTS.comparisonCount : 2;
  const perComparisonAlpha =
    options.phase === 'confirmation'
      ? getChallengerConfirmationAlpha(options.attemptNumber, options.approvedCheckpoints.length) /
        comparisonCount
      : 0.05 /
        ((directional ? DIRECTIONAL_REVERSAL_REQUIREMENTS.developmentFamilyCount : 5) *
          5 *
          comparisonCount);
  const uncertainty =
    options.complete && !reasons.length
      ? getCheckpointBrierUncertainty(
          scored,
          (row) => row.learningFeatures.baselineAboveProbability,
          perComparisonAlpha,
        )
      : null;
  const productionUncertainty =
    options.complete && !reasons.length
      ? getCheckpointBrierUncertainty(scored, (row) => row.probability, perComparisonAlpha)
      : null;
  const incompleteEvidence = options.complete && scored.length !== 60;
  const directionUncertainty =
    directional && options.complete && !reasons.length
      ? getCheckpointAccuracyUncertainty(scored, perComparisonAlpha)
      : null;
  if (options.complete && !incompleteEvidence) {
    if (directional) {
      if (
        artifact.calibration.checkpoints.find(
          (entry) => entry.checkpointMinutes === checkpointMinutes,
        )?.status !== 'fitted'
      )
        reasons.push('This checkpoint needs fitted flip-probability calibration before approval.');
      if (!directionUncertainty || directionUncertainty.accuracyDifference[0] <= 0)
        reasons.push(
          'The paired directional-accuracy interval does not establish improvement over the current-side benchmark.',
        );
    }
    if (common.modelUses < CHALLENGER_REQUIREMENTS.minimumModelUses)
      reasons.push('At least 30 independent events at this checkpoint must use a real adjustment.');
    if (
      !uncertainty ||
      !productionUncertainty ||
      uncertainty.brierDifference[1] >= 0 ||
      productionUncertainty.brierDifference[1] >= 0
    )
      reasons.push(
        'The declared probability-error intervals do not establish improvement over both baseline and production.',
      );
    if (
      metrics.candidate.callAccuracy < metrics.baseline.callAccuracy ||
      metrics.candidate.callAccuracy < metrics.production.callAccuracy
    )
      reasons.push(
        'Directional accuracy is worse than the baseline or production at this checkpoint.',
      );
    if (
      (artifact.kind === 'reversal' || directional) &&
      (metrics.baseline.reversals < CHALLENGER_REQUIREMENTS.minimumReversalExamples ||
        !(metrics.candidate.reversalRecall > metrics.baseline.reversalRecall) ||
        (metrics.candidate.reversalFalseAlarmRate ?? 0) >
          CHALLENGER_REQUIREMENTS.maximumReversalFalseAlarmRate)
    )
      reasons.push(
        'Reversal recall must improve with twelve reversals and at most 50% false alerts.',
      );
  } else if (!options.complete)
    reasons.push('Waiting for the fixed group of 60 future independent event outcomes.');
  const passed = options.complete && reasons.length === 0;
  return {
    ...common,
    uncertainty,
    productionUncertainty,
    ...(directional ? { directionUncertainty } : {}),
    evaluationComplete: options.complete,
    status: passed
      ? 'ready'
      : incompleteEvidence
        ? 'unusable-evidence'
        : options.complete
          ? 'candidate-rejected'
          : 'collecting',
    failureCategory: incompleteEvidence
      ? 'evidence'
      : options.complete && !passed
        ? 'performance'
        : null,
    failureCode: incompleteEvidence
      ? scored.length
        ? 'incomplete-recordings'
        : 'predictions-not-recorded'
      : null,
    developmentPassed: options.phase === 'development' && passed,
    eligibleForPromotion: options.phase === 'confirmation' && passed,
    reasons,
    reason: reasons[0] ?? 'This checkpoint passed its declared comparisons.',
  };
}

export function evaluateCheckpointChallenger(artifact, events, options, getRecordedVariant) {
  const {
    now = Date.now(),
    phase = 'development',
    startedAt = artifact?.shadowStartsAt,
    cohortForecastIds = [],
    approvedCheckpoints = CHALLENGER_CHECKPOINTS,
    attemptNumber,
    inclusiveBoundary = false,
  } = options;
  const reject = (reason) => ({
    modelId: artifact?.id ?? null,
    kind: artifact?.kind ?? null,
    phase,
    evaluatedAt: now,
    eligibleForPromotion: false,
    developmentPassed: false,
    evaluationComplete: false,
    independentWindows: 0,
    eligibleWindows: 0,
    resolvedWindows: 0,
    requiredWindows: 60,
    status: 'candidate-rejected',
    checkpoints: [],
    approvedCheckpoints: [],
    reasons: [reason],
  });
  if (
    !isChallengerArtifact(artifact) ||
    artifact.version !== CHALLENGER_MODEL_VERSION ||
    artifact.retirement
  )
    return reject('A current frozen challenger artifact is required.');
  if (
    !['development', 'confirmation'].includes(phase) ||
    !timestamp(startedAt) ||
    startedAt < artifact.trainedAt ||
    startedAt > now
  )
    return reject('The prospective evaluation boundary is invalid.');
  if (
    phase === 'confirmation' &&
    (!Object.hasOwn(options, 'startedAt') ||
      !Object.hasOwn(options, 'approvedCheckpoints') ||
      !Array.isArray(approvedCheckpoints) ||
      new Set(approvedCheckpoints).size !== approvedCheckpoints.length ||
      approvedCheckpoints.some((minutes) => !CHALLENGER_CHECKPOINTS.includes(minutes)) ||
      getChallengerConfirmationAlpha(attemptNumber, approvedCheckpoints.length) === null)
  )
    return reject(
      'Confirmation requires a frozen checkpoint nomination and a global attempt number.',
    );
  const selected = selectCohort(artifact, events, {
    startedAt,
    cohortForecastIds,
    now,
    inclusiveBoundary,
  });
  if (!selected.valid) return reject(selected.reason);
  const { groups } = selected;
  const verified = new Map(getVerifiedLearningRows(events, now).rows.map((row) => [row.id, row]));
  const { outcomes, conflicts } = collectLearningEvents(events, now);
  const resolvedGroups = groups.filter((group) => group.rows.some((row) => verified.has(row.id)));
  const terminal = groups.some((group) =>
    group.rows.some(
      (row) => conflicts.has(row.id) || outcomes.get(row.id)?.outcomeStatus === 'unobserved',
    ),
  );
  // A terminal outcome cannot be repaired by adding later contracts to this fixed cohort.
  const complete = terminal || (groups.length === 60 && resolvedGroups.length === 60);
  const checkpointList = phase === 'confirmation' ? approvedCheckpoints : CHALLENGER_CHECKPOINTS;
  const checkpoints = checkpointList.map((minutes) =>
    evaluateCheckpoint(
      artifact,
      groups,
      verified,
      minutes,
      { ...options, phase, complete, approvedCheckpoints, attemptNumber },
      getRecordedVariant,
    ),
  );
  const approved = checkpoints
    .filter((entry) => entry.developmentPassed || entry.eligibleForPromotion)
    .map((entry) => entry.checkpointMinutes);
  const passed = complete && !terminal && approved.length > 0;
  const incompleteEvidence =
    complete &&
    !passed &&
    (terminal || checkpoints.every((entry) => entry.failureCategory === 'evidence'));
  return {
    modelId: artifact.id,
    kind: artifact.kind,
    phase,
    evaluatedAt: now,
    startedAt,
    attemptNumber: attemptNumber ?? null,
    status: passed
      ? phase === 'development'
        ? 'development-passed'
        : 'ready'
      : incompleteEvidence
        ? 'unusable-evidence'
        : complete
          ? 'candidate-rejected'
          : 'collecting',
    failureCategory: incompleteEvidence ? 'evidence' : complete && !passed ? 'performance' : null,
    failureCode: incompleteEvidence
      ? terminal
        ? 'invalid-outcomes'
        : checkpoints.every((entry) => entry.scoredWindows === 0)
          ? 'predictions-not-recorded'
          : 'incomplete-recordings'
      : null,
    eligibleForPromotion: phase === 'confirmation' && passed,
    developmentPassed: phase === 'development' && passed,
    evaluationComplete: complete,
    independentWindows: Math.max(0, ...checkpoints.map((entry) => entry.independentWindows)),
    eligibleWindows: groups.length,
    resolvedWindows: resolvedGroups.length,
    requiredWindows: 60,
    cohortForecastIds: selected.cohortForecastIds,
    checkpoints,
    approvedCheckpoints: passed ? approved : [],
    reasons: passed
      ? []
      : [
          incompleteEvidence
            ? terminal
              ? 'The fixed cohort contains unobserved or conflicting outcomes. This run was not a valid performance test.'
              : 'The fixed cohort is missing matching recorded predictions. This run was not a valid performance test.'
            : complete
              ? 'No nominated checkpoint passed all comparisons on the fixed cohort.'
              : 'Waiting for 60 independent future event outcomes.',
        ],
  };
}

export function evaluateCheckpointChallengerActive(
  artifact,
  events,
  { now = Date.now() } = {},
  getRecordedVariant,
) {
  const activation = artifact?.activation;
  const approved = activation?.shadowEvaluation?.approvedCheckpoints;
  if (
    !isChallengerArtifact(artifact) ||
    artifact.retirement ||
    activation?.modelId !== artifact.id ||
    !timestamp(activation.activatedAt) ||
    activation.activatedAt < artifact.trainedAt ||
    activation.activatedAt > now ||
    activation.shadowEvaluation?.modelId !== artifact.id ||
    activation.shadowEvaluation?.phase !== 'confirmation' ||
    activation.shadowEvaluation?.eligibleForPromotion !== true ||
    !Array.isArray(approved) ||
    !approved.length ||
    approved.some((minutes) => !CHALLENGER_CHECKPOINTS.includes(minutes))
  )
    return {
      status: 'disabled',
      reason: 'The challenger has no valid checkpoint confirmation.',
      independentWindows: 0,
      checkpoints: [],
    };
  const verified = new Map(getVerifiedLearningRows(events, now).rows.map((row) => [row.id, row]));
  const { outcomes, conflicts } = collectLearningEvents(events, now);
  const hasCompletedOutcome = (group) =>
    group.rows.some(
      (row) =>
        verified.has(row.id) ||
        conflicts.has(row.id) ||
        outcomes.get(row.id)?.outcomeStatus === 'unobserved',
    );
  // A currently open contract must not keep displacing a completed monitoring window.
  const groups = getFutureGroups(artifact, events, activation.activatedAt, now)
    .filter(hasCompletedOutcome)
    .slice(-40);
  const checkpoints = approved.map((checkpointMinutes) => {
    const eligible = groups.map((group) =>
      [...group.rows]
        .sort(order)
        .find((row) => getChallengerCheckpoint(row.horizonMinutes) === checkpointMinutes),
    );
    const resolved = eligible.map((row) => row && verified.get(row.id)).filter(Boolean);
    const scored = resolved
      .filter((row) => {
        const expected = getRecordedVariant(artifact, row);
        return (
          expected !== null &&
          Math.abs(expected - row.probability) <= 1e-9 &&
          (Math.abs(expected - row.learningFeatures.baselineAboveProbability) <= 1e-9 ||
            (row.decision.learning?.applied === true &&
              row.decision.learning.modelId === artifact.id))
        );
      })
      .map((row) => ({ ...row, challengerProbability: row.probability }));
    const metrics = getMetrics(scored);
    const full = groups.length === 40;
    const degraded =
      full &&
      (scored.length !== 40 ||
        metrics.candidate.brier - metrics.baseline.brier >
          CHALLENGER_REQUIREMENTS.maximumBrierDeterioration ||
        metrics.baseline.callAccuracy - metrics.candidate.callAccuracy >
          CHALLENGER_REQUIREMENTS.maximumAccuracyDeterioration ||
        (isDirectionalReversalChallenger(artifact) &&
          metrics.currentSide.callAccuracy - metrics.candidate.callAccuracy >
            CHALLENGER_REQUIREMENTS.maximumAccuracyDeterioration));
    return {
      checkpointMinutes,
      ...metrics,
      independentWindows: scored.length,
      eligibleWindows: groups.length,
      status: degraded ? 'disabled' : full ? 'healthy' : 'monitoring',
      reliability: getCheckpointReliability(scored),
      reason: degraded
        ? 'Recent checkpoint evidence is incomplete or exceeds the deterioration limit.'
        : 'Monitoring later outcomes at this approved checkpoint.',
    };
  });
  const disabled = checkpoints.some((entry) => entry.status === 'disabled');
  return {
    modelId: artifact.id,
    evaluatedAt: now,
    status: disabled
      ? 'disabled'
      : checkpoints.every((entry) => entry.status === 'healthy')
        ? 'healthy'
        : 'monitoring',
    independentWindows: Math.min(...checkpoints.map((entry) => entry.independentWindows)),
    eligibleWindows: groups.length,
    checkpoints,
    reason: disabled
      ? 'An approved checkpoint deteriorated or lost matching evidence.'
      : 'Each approved checkpoint is monitored separately.',
  };
}

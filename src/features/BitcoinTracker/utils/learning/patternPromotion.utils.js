import {
  collectLearningEvents,
  getVerifiedLearningRows,
  scoreLearningRows,
} from './evaluation.utils';
import { getPatternProspectiveCohorts } from './patternCohorts.utils';
import {
  PATTERN_CANDIDATE_KINDS,
  isPatternModelArtifact,
  predictPatternCandidate,
  hasPatternActivation,
} from './patternModel.utils';
import { PATTERN_MODEL_VERSION, PATTERN_PROMOTION_VERSION } from './patternVersions.utils';
import { getPairedBootstrapUncertainty, LEARNING_REQUIREMENTS } from './training.utils';
import { FULL_MODEL_MONITORING_REQUIREMENTS } from './fullModelMonitoring.utils';

const matchesProbability = (left, right) =>
  Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-9;
const score = (rows, getProbability) =>
  scoreLearningRows(rows.map((row) => ({ ...row, probability: getProbability(row) })));

function getFrozenPrediction(row, artifact) {
  const saved = (row.decision.patternShadowPredictions ?? []).filter(
    (prediction) => prediction.modelId === artifact.id,
  );
  const expected = predictPatternCandidate(artifact, row.decision.patternLearningFeatures, {
    windowStartAt: row.windowStartAt,
  });
  return saved.length === 1 &&
    expected &&
    saved[0].suiteId === artifact.suiteId &&
    saved[0].kind === artifact.kind &&
    saved[0].modelVersion === artifact.version &&
    saved[0].trainedAt === artifact.trainedAt &&
    saved[0].featureCutoffAt === row.capturedAt &&
    saved[0].modelUsed === expected.modelUsed &&
    matchesProbability(saved[0].aboveProbability, expected.aboveProbability)
    ? expected
    : null;
}

function getCohortEvidence(model, events, now, patternSuites) {
  const cohort = getPatternProspectiveCohorts(events, { now, patternSuites }).find(
    (entry) => entry.registration.suiteId === model.suiteId,
  );
  const verified = new Map(getVerifiedLearningRows(events, now).rows.map((row) => [row.id, row]));
  const { outcomes, conflicts } = collectLearningEvents(events, now);
  return {
    cohort,
    verified,
    terminalFailure: (slot) =>
      slot.terminalFailure ||
      conflicts.has(slot.id) ||
      outcomes.get(slot.id)?.outcomeStatus === 'unobserved',
  };
}

/** Eligibility is read-only. The combined model is predeclared; ablation winners are never promoted. */
export function evaluatePatternPromotion(
  model,
  events = [],
  {
    now = Date.now(),
    patternSuites = [],
    candidates = [],
    incumbent = null,
    activationHistory = [],
  } = {},
) {
  const common = {
    version: PATTERN_PROMOTION_VERSION,
    phase: 'prospective-pattern-promotion',
    modelId: model?.id ?? null,
    suiteId: model?.suiteId ?? null,
    featureVersion: model?.featureVersion ?? null,
    patternVersion: model?.patternVersion ?? null,
    evaluatedAt: now,
    productionModelId: incumbent?.id ?? null,
    productionActivatedAt: incumbent?.activation?.activatedAt ?? null,
    requiredWindows: LEARNING_REQUIREMENTS.minimumShadowWindows,
    eligibleForPromotion: false,
    evaluationComplete: false,
    independentWindows: 0,
    eligibleWindows: 0,
    resolvedWindows: 0,
    callCoverage: 0,
    modelUses: 0,
    profitability:
      'Not a promotion criterion; matched observed-book reports remain separate evidence.',
  };
  const rejected = (reason) => ({ ...common, status: 'ineligible', reasons: [reason] });
  if (
    !isPatternModelArtifact(model) ||
    model.retirement ||
    model.version !== PATTERN_MODEL_VERSION ||
    model.kind !== 'combined'
  )
    return rejected(
      'Only the current combined pattern model can enter the predeclared promotion test.',
    );
  const suite = candidates.filter(
    (artifact) =>
      artifact?.suiteId === model.suiteId &&
      isPatternModelArtifact(artifact) &&
      !artifact.retirement,
  );
  if (
    suite.length !== PATTERN_CANDIDATE_KINDS.length ||
    !PATTERN_CANDIDATE_KINDS.every(
      (kind) => suite.filter((artifact) => artifact.kind === kind).length === 1,
    )
  )
    return rejected(
      'The complete frozen suite, including the fitted baseline control, is required.',
    );
  const { cohort, verified, terminalFailure } = getCohortEvidence(
    model,
    events,
    now,
    patternSuites,
  );
  if (
    !cohort ||
    cohort.registration.modelVersion !== model.version ||
    cohort.registration.featureVersion !== model.featureVersion ||
    cohort.registration.patternVersion !== model.patternVersion ||
    cohort.registration.trainedAt !== model.trainedAt ||
    suite.some((artifact) => cohort.registration.modelIds?.[artifact.kind] !== artifact.id)
  )
    return rejected(
      'Durable registration of the complete matching suite before contract start is required.',
    );
  const slots = cohort.opportunities.slice(0, LEARNING_REQUIREMENTS.minimumShadowWindows);
  const resolved = slots.map((slot) => verified.get(slot.id)).filter(Boolean);
  const failed = slots.some(terminalFailure);
  const rows = resolved.flatMap((row) => {
    const predictions = Object.fromEntries(
      suite.map((artifact) => [artifact.kind, getFrozenPrediction(row, artifact)]),
    );
    return PATTERN_CANDIDATE_KINDS.every((kind) => predictions[kind])
      ? [{ ...row, predictions }]
      : [];
  });
  const complete =
    slots.length === LEARNING_REQUIREMENTS.minimumShadowWindows &&
    (failed || resolved.length === slots.length);
  const modelUses = rows.filter(
    (row) =>
      row.predictions.combined.modelUsed &&
      !matchesProbability(
        row.predictions.combined.aboveProbability,
        row.learningFeatures.baselineAboveProbability,
      ),
  ).length;
  const report = {
    ...common,
    cohortId: cohort.registration.cohortId,
    registeredAt: cohort.registration.registeredAt,
    cohortForecastIds: slots.map((slot) => slot.id),
    firstWindowAt: slots[0]?.windowStartAt ?? null,
    lastDeadlineAt: slots.at(-1)?.expiresAt ?? null,
    independentWindows: rows.length,
    eligibleWindows: slots.length,
    resolvedWindows: resolved.length,
    callCoverage: slots.length ? rows.length / slots.length : 0,
    modelUses,
    fallbackUses: rows.length - modelUses,
    evaluationComplete: complete,
  };
  const reasons = [];
  if (!complete)
    reasons.push(
      'Wait for the first 120 independent registered future contracts and every selected official outcome.',
    );
  if (failed)
    reasons.push(
      'The fixed prospective cohort contains conflicting evidence or a terminal unobserved outcome.',
    );
  if (rows.length !== LEARNING_REQUIREMENTS.minimumShadowWindows)
    reasons.push(
      'Every enrolled contract must retain matching frozen predictions for the complete suite; missing inputs are not removed.',
    );
  if (
    ![0, 1].every(
      (outcome) =>
        rows.filter((row) => row.outcome === outcome).length >=
        LEARNING_REQUIREMENTS.minimumClassExamples,
    )
  )
    reasons.push('At least ten independent official YES and NO outcomes are required.');
  if (modelUses < LEARNING_REQUIREMENTS.minimumShadowModelUses)
    reasons.push('At least 60 prospective contracts must actually use a learned adjustment.');
  const incumbentMatches = (row) => {
    const latest = activationHistory
      .filter((entry) => entry.activatedAt <= row.capturedAt)
      .sort(
        (left, right) =>
          right.activatedAt - left.activatedAt || (right.sequence ?? 0) - (left.sequence ?? 0),
      )[0];
    const historicalId =
      latest && (latest.retiredAt === null || latest.retiredAt > row.capturedAt)
        ? latest.modelId
        : null;
    if (
      historicalId !== (incumbent?.id ?? null) ||
      (incumbent && latest.activatedAt !== incumbent.activation?.activatedAt)
    )
      return false;
    if (row.decision.learning?.applied === true)
      return row.decision.learning.modelId === historicalId;
    return (
      row.decision.modelVersion === row.learningFeatures.baselineModelVersion &&
      matchesProbability(row.probability, row.learningFeatures.baselineAboveProbability)
    );
  };
  if (rows.some((row) => !incumbentMatches(row)))
    reasons.push(
      'The current incumbent must match the production model observed throughout the frozen comparison.',
    );
  if (reasons.length) return { ...report, status: complete ? 'ineligible' : 'collecting', reasons };

  const probabilities = rows.map((row) => row.predictions.combined.aboveProbability);
  const candidate = score(rows, (row) => row.predictions.combined.aboveProbability);
  const references = {
    production: (row) => row.probability,
    rawBaseline: (row) => row.learningFeatures.baselineAboveProbability,
    fittedBaselineControl: (row) => row.predictions['baseline-control'].aboveProbability,
  };
  const metrics = { candidate, currentSide: score(rows, (row) => row.currentSide) };
  const uncertainty = {};
  for (const [name, getProbability] of Object.entries(references)) {
    metrics[name] = score(rows, getProbability);
    uncertainty[name] = getPairedBootstrapUncertainty(
      rows.map((row) => ({ ...row, probability: getProbability(row) })),
      probabilities,
    );
    if (
      !(candidate.callAccuracy > metrics[name].callAccuracy) ||
      !(candidate.brier < metrics[name].brier)
    )
      reasons.push(
        `Directional accuracy and Brier score must improve over ${name} on the identical cohort.`,
      );
    if (
      candidate.expectedCalibrationError > metrics[name].expectedCalibrationError ||
      candidate.callCoverage < metrics[name].callCoverage
    )
      reasons.push(
        `Calibration reliability and directional coverage must not deteriorate versus ${name}.`,
      );
    if (uncertainty[name].accuracyDifference[0] <= 0 || uncertainty[name].brierDifference[1] >= 0)
      reasons.push(
        `The paired 95% interval does not separate improvement over ${name} from uncertainty.`,
      );
  }
  if (
    !(candidate.callAccuracy > metrics.currentSide.callAccuracy) ||
    uncertainty.production.benchmarkAccuracyDifference[0] <= 0
  )
    reasons.push(
      'The candidate must improve on the current-side directional benchmark beyond paired sampling uncertainty.',
    );
  const marketRows = rows.filter((row) => row.marketProbability !== null);
  metrics.market = score(marketRows, (row) => row.marketProbability);
  metrics.candidateOnMarketRows = score(
    marketRows,
    (row) => row.predictions.combined.aboveProbability,
  );
  if (
    marketRows.length >= LEARNING_REQUIREMENTS.minimumTestModelUses &&
    (metrics.candidateOnMarketRows.brier > metrics.market.brier ||
      metrics.candidateOnMarketRows.callAccuracy < metrics.market.callAccuracy)
  )
    reasons.push('The candidate underperforms the contemporaneous market on matched contracts.');
  return {
    ...report,
    metrics,
    uncertainty,
    status: reasons.length ? 'ineligible' : 'eligible',
    eligibleForPromotion: reasons.length === 0,
    reasons,
  };
}

/** Existing operational deterioration limits apply only to complete post-activation evidence. */
export function evaluatePatternActiveModel(
  model,
  events = [],
  { now = Date.now(), patternSuites = [] } = {},
) {
  const requirements = FULL_MODEL_MONITORING_REQUIREMENTS;
  const common = {
    modelId: model?.id ?? null,
    evaluatedAt: now,
    requirements,
    status: 'monitoring',
    independentWindows: 0,
    modelUses: 0,
    reason: 'Complete independent post-activation evidence is required.',
  };
  if (!hasPatternActivation(model, now)) return common;
  const registered = patternSuites.find((entry) => entry.suiteId === model.suiteId);
  // Active-model surveillance continues after a newer shadow suite is registered.
  const activeRegistrations = registered
    ? [{ ...registered, registeredAt: model.activation.activatedAt, endsAt: null }]
    : [];
  const { cohort, verified, terminalFailure } = getCohortEvidence(
    model,
    events,
    now,
    activeRegistrations,
  );
  const slots = (cohort?.opportunities ?? [])
    .filter((slot) => slot.windowStartAt > model.activation.activatedAt && slot.expiresAt <= now)
    .slice(-requirements.minimumWindows);
  const rows = slots
    .filter((slot) => !terminalFailure(slot))
    .map((slot) => verified.get(slot.id))
    .filter(Boolean)
    .filter((row) => {
      // The production probability and learning identity are the immutable active record;
      // a replacement shadow suite may legitimately occupy all seven shadow prediction slots.
      const prediction = predictPatternCandidate(model, row.decision.patternLearningFeatures, {
        windowStartAt: row.windowStartAt,
      });
      return (
        prediction &&
        matchesProbability(prediction.aboveProbability, row.probability) &&
        (prediction.modelUsed
          ? row.decision.modelVersion === model.version &&
            row.decision.learning?.modelId === model.id &&
            row.decision.learning?.applied === true &&
            matchesProbability(row.decision.learning.aboveProbability, prediction.aboveProbability)
          : row.decision.learning?.applied !== true &&
            row.decision.modelVersion === row.learningFeatures.baselineModelVersion)
      );
    });
  const modelUses = rows.filter(
    (row) => !matchesProbability(row.probability, row.learningFeatures.baselineAboveProbability),
  ).length;
  const report = {
    ...common,
    independentWindows: rows.length,
    eligibleWindows: slots.length,
    modelUses,
    callCoverage: slots.length ? rows.length / slots.length : 0,
  };
  if (rows.length < requirements.minimumWindows || modelUses < requirements.minimumModelUses)
    return report;
  const baselineRows = rows.map((row) => ({
    ...row,
    probability: row.learningFeatures.baselineAboveProbability,
  }));
  const uncertainty = getPairedBootstrapUncertainty(
    baselineRows,
    rows.map((row) => row.probability),
  );
  const reasons = [];
  if (uncertainty.brierDifference[0] > requirements.maximumBrierDeterioration)
    reasons.push('Pattern probability error exceeds the existing 0.005 Brier deterioration limit.');
  if (uncertainty.accuracyDifference[1] < -requirements.maximumAccuracyDeterioration)
    reasons.push(
      'Pattern directional accuracy exceeds the existing five percentage point deterioration limit.',
    );
  return {
    ...report,
    uncertainty,
    candidate: scoreLearningRows(rows),
    baseline: scoreLearningRows(baselineRows),
    reasons,
    status: reasons.length ? 'disabled' : 'healthy',
    reason:
      reasons[0] ??
      'Complete prospective evidence does not establish deterioration beyond the existing limits.',
  };
}

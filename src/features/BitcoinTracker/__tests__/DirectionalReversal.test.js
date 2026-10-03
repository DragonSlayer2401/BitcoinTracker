import {
  DIRECTIONAL_REVERSAL_KIND,
  DIRECTIONAL_REVERSAL_REQUIREMENTS,
  isChallengerArtifact,
  predictChallengerProbability,
  getUncalibratedChallengerProbability,
} from '../utils/learning/challengerModel.utils';
import {
  trainChallengerCandidate,
  evaluateChallengerCandidate,
  getChallengerTrainingReadiness,
  getChallengerConfirmationCohort,
} from '../utils/learning/challengerTraining.utils';
import {
  getDirectionalCurrentSide,
  getDirectionalReversalFeatures,
  getDirectionalOutcomeProbability,
} from '../utils/learning/directionalReversal.utils';
import { getCheckpointAccuracyUncertainty } from '../utils/learning/challengerValidation.utils';
import { logit } from '../utils/learning/statistics.utils';
import { DERIVATIVES_LEARNING_FEATURE_NAMES } from '../utils/learning/features.utils';
import {
  windowSet,
  recordedWindow,
  afterWindow,
  startOf,
  clone,
  labelsFor,
} from './fixtures/challengerFixtures';

const fit = (events = windowSet(80)) =>
  trainChallengerCandidate(events, [], {
    kind: DIRECTIONAL_REVERSAL_KIND,
    now: afterWindow(79),
  }).artifact;
let model;
beforeAll(() => {
  model = fit();
});

function inputFor(decision) {
  return {
    baseForecast: {
      available: true,
      aboveProbability: decision.learningFeatures.baselineAboveProbability,
      target: decision.target,
      expiresAt: decision.expiresAt,
      kalshi: { referencePrice: decision.spot },
      researchVariants: decision.researchExperiment.variants,
    },
    learningFeatures: decision.learningFeatures,
    input: {
      now: decision.capturedAt,
      kalshiMarket: decision.kalshiMarket,
      kalshiQuote: decision.kalshiQuote,
    },
    windowStartAt: decision.windowStartAt,
  };
}

test('rounding, direction orientation, optional feeds and quote context describe the losing side consistently', () => {
  expect(getDirectionalCurrentSide(99_999.999, 100_000)).toBe(1);
  expect(getDirectionalCurrentSide(99_999.994, 100_000)).toBe(0);
  expect(getDirectionalOutcomeProbability(0.8, 1)).toBeCloseTo(0.2);
  expect(getDirectionalOutcomeProbability(0.8, 0)).toBe(0.8);
  const fields = {
    return3: -2,
    acceleration3: -1,
    buyPressure60: -0.7,
    flow60Available: 1,
    futuresPressure60: -0.8,
    futuresFlow60Available: 1,
  };
  const snapshot = {
    schemaVersion: 'deadline-reversal-features-v3',
    values: DERIVATIVES_LEARNING_FEATURE_NAMES.map((name) => fields[name] ?? 0),
    targetDistance: -3,
    featureCutoffAt: 1_000_000,
    expiresAt: 1_360_000,
  };
  const above = getDirectionalReversalFeatures(snapshot, 1, 0.2);
  expect(above.slice(0, 8)).toEqual([3, 0.4, 2, 1, 0.7, 0.8, 1, 1]);
  expect(above[8]).toBeCloseTo(logit(0.8));
  expect(above[9]).toBe(1);
  const absent = clone(snapshot);
  absent.values[DERIVATIVES_LEARNING_FEATURE_NAMES.indexOf('flow60Available')] = 0;
  absent.values[DERIVATIVES_LEARNING_FEATURE_NAMES.indexOf('futuresFlow60Available')] = 0;
  expect(getDirectionalReversalFeatures(absent, 0).slice(4)).toEqual([0, 0, 0, 0, 0, 0]);
});

test('fits true flip labels with chronological primary-only regularization and separate flip calibration', () => {
  expect(isChallengerArtifact(model)).toBe(true);
  expect(model.model.coefficients[5]).toBeGreaterThan(0);
  expect(model.requirements).toEqual(DIRECTIONAL_REVERSAL_REQUIREMENTS);
  expect(model.requirements.blendWeight).toBeUndefined();
  expect(model.calibration).toMatchObject({
    version: 'checkpoint-flip-calibration-v1',
    target: 'opposite-current-side',
    independentWindows: 20,
  });
  expect(model.model.regularization.folds).toHaveLength(3);
  for (const fold of model.model.regularization.folds) {
    expect(fold.trainingCutoffAt).toBeLessThanOrEqual(fold.validationStartedAt);
    expect(fold.validationCutoffAt).toBeLessThanOrEqual(model.calibration.primaryCutoffAt);
  }
  const changedCalibration = fit([...windowSet(60), ...windowSet(20, 60, { outcome: 1 })]);
  expect(changedCalibration.model).toEqual(model.model);
  expect(
    changedCalibration.calibration.checkpoints.every((entry) => entry.status === 'identity'),
  ).toBe(true);
});

test('a calibrated directional candidate can reverse a strong baseline without a hidden blend cap', () => {
  const candidate = clone(model);
  candidate.model.coefficients = [logit(0.9), ...Array(10).fill(0)];
  candidate.calibration.checkpoints.forEach((entry) => {
    entry.offset = 0;
  });
  const decision = recordedWindow(80).find((row) => row.event === 'decision');
  const input = inputFor(decision);
  expect(input.baseForecast.aboveProbability).toBe(0.8);
  expect(predictChallengerProbability(candidate, input)).toBeCloseTo(0.1);
  candidate.calibration.checkpoints[0].offset = 0.2;
  expect(predictChallengerProbability(candidate, input)).toBeLessThan(0.1);
  candidate.calibration.checkpoints[0].status = 'identity';
  candidate.calibration.checkpoints[0].offset = 0;
  expect(predictChallengerProbability(candidate, input)).toBe(0.8);
});

test('quote context accepts only fresh matching contract quotes and uses the identical replay inputs', () => {
  const candidate = clone(model);
  candidate.model.coefficients = Array(11).fill(0);
  candidate.model.coefficients[9] = 1;
  candidate.model.means = Array(10).fill(0);
  candidate.model.scales = Array(10).fill(1);
  const decision = recordedWindow(80).find((row) => row.event === 'decision');
  const input = inputFor(decision);
  const quote = {
    marketTicker: decision.kalshiMarket.ticker,
    target: decision.target,
    expiresAt: decision.expiresAt,
    receivedAt: decision.capturedAt,
    yesBid: 0.19,
    yesAsk: 0.21,
  };
  input.input.kalshiQuote = quote;
  expect(getUncalibratedChallengerProbability(candidate, input)).toBeCloseTo(0.2);
  input.input.kalshiQuote = { ...quote, marketTicker: 'wrong' };
  expect(getUncalibratedChallengerProbability(candidate, input)).toBe(0.5);
  input.input.kalshiQuote = { ...quote, receivedAt: decision.capturedAt + 1 };
  expect(getUncalibratedChallengerProbability(candidate, input)).toBe(0.5);
});

test('known invalid archived inputs cannot silently train the new family', () => {
  const events = windowSet(80);
  events
    .filter((row) => row.event === 'decision')
    .slice(0, 5)
    .forEach((row) => {
      row.researchReplay = { replayable: false };
    });
  const readiness = getChallengerTrainingReadiness(events, [], {
    kind: DIRECTIONAL_REVERSAL_KIND,
    now: afterWindow(79),
  });
  expect(readiness.ready).toBe(false);
  expect(readiness.counts.primaryFitWindows).toBe(59);
});

test.each(['development', 'confirmation'])(
  'an entirely unreplayable first contract stays in the first sixty recorded %s contracts',
  (phase) => {
    const events = windowSet(61, 80, { model });
    const options = {
      startedAt: model.trainedAt,
      now: afterWindow(140),
      phase,
      ...(phase === 'confirmation'
        ? { approvedCheckpoints: [12, 9, 6, 3, 1], attemptNumber: 1 }
        : {}),
    };
    const original = getChallengerConfirmationCohort(model, events, options);
    const firstDecisions = events.filter(
      (row) => row.event === 'decision' && row.windowStartAt === startOf(80),
    );
    expect(firstDecisions).toHaveLength(5);
    firstDecisions.forEach((row) => {
      row.researchReplay = { replayable: false };
    });

    // Selection before its first persisted membership and resumption of the saved
    // membership must both retain the bad event instead of advancing to event 140.
    for (const cohortForecastIds of [[], original.cohortForecastIds]) {
      const cohort = getChallengerConfirmationCohort(model, events, {
        ...options,
        cohortForecastIds,
      });
      expect(cohort.valid).toBe(true);
      expect(cohort.cohortForecastIds).toEqual(original.cohortForecastIds);
      const report = evaluateChallengerCandidate(model, events, {
        ...options,
        cohortForecastIds: cohort.cohortForecastIds,
      });
      expect(report).toMatchObject({
        eligibleWindows: 60,
        resolvedWindows: 60,
        evaluationComplete: true,
        developmentPassed: false,
        eligibleForPromotion: false,
        status: 'unusable-evidence',
        failureCategory: 'evidence',
        failureCode: 'incomplete-recordings',
        cohortForecastIds: original.cohortForecastIds,
      });
      expect(report.checkpoints).toHaveLength(5);
      for (const checkpoint of report.checkpoints)
        expect(checkpoint).toMatchObject({
          scoredWindows: 59,
          status: 'unusable-evidence',
          failureCategory: 'evidence',
          developmentPassed: false,
        });
    }
  },
);

test('one invalid capture cannot be replaced with a later contract at that checkpoint', () => {
  const events = windowSet(61, 80, { model });
  const options = { startedAt: model.trainedAt, now: afterWindow(140) };
  const original = getChallengerConfirmationCohort(model, events, options);
  events.find(
    (row) =>
      row.event === 'decision' && row.windowStartAt === startOf(80) && row.checkpointMinutes === 9,
  ).researchReplay = { replayable: false };
  const report = evaluateChallengerCandidate(model, events, {
    ...options,
    cohortForecastIds: original.cohortForecastIds,
  });
  expect(report.cohortForecastIds).toEqual(original.cohortForecastIds);
  expect(report.checkpoints.find((row) => row.checkpointMinutes === 9)).toMatchObject({
    scoredWindows: 59,
    status: 'unusable-evidence',
    failureCategory: 'evidence',
    developmentPassed: false,
  });
  expect(report.approvedCheckpoints).not.toContain(9);
  for (const checkpoint of report.checkpoints.filter((row) => row.checkpointMinutes !== 9))
    expect(checkpoint.scoredWindows).toBe(60);
});

test.each(['reversal', 'forward-pressure', 'reduced-pressure', 'fast-decay', 'market-blend'])(
  'the new replay eligibility rule leaves %s historical validation unchanged',
  (kind) => {
    const training = windowSet(80);
    const previous = trainChallengerCandidate(training, labelsFor(training), {
      kind,
      now: afterWindow(79),
    }).artifact;
    expect(isChallengerArtifact(previous)).toBe(true);
    const events = windowSet(61, 80, { model: previous });
    const options = { now: afterWindow(140) };
    const original = evaluateChallengerCandidate(previous, events, options);
    events
      .filter((row) => row.event === 'decision' && row.windowStartAt === startOf(80))
      .forEach((row) => {
        row.researchReplay = { replayable: false };
      });
    expect(evaluateChallengerCandidate(previous, events, options)).toEqual(original);
  },
);

test('inner regularization folds purge unpublished labels and prefer the stronger tied penalty', () => {
  const delayed = recordedWindow(29).map((row) =>
    row.event === 'outcome' ? { ...row, recordedAt: startOf(30) + 1000 } : row,
  );
  const candidate = fit([...windowSet(29), ...delayed, ...windowSet(50, 30)]);
  expect(candidate.model.regularization.folds.map((fold) => fold.trainingWindows)).toEqual([
    40, 50,
  ]);
  const tied = fit(windowSet(80, 0, { pressure: 0 }));
  expect(tied.model.regularization.selectedPenalty).toBe(0.5);
  expect(
    tied.model.regularization.scores.every((entry) => Math.abs(entry.brier - 0.25) < 1e-10),
  ).toBe(true);
});

test('prospective promotion requires a positive paired directional gain, even when Brier improves', () => {
  const tied = clone(model);
  tied.model.coefficients = [logit(0.4), ...Array(10).fill(0)];
  tied.calibration.checkpoints.forEach((entry) => {
    entry.offset = 0;
  });
  const report = evaluateChallengerCandidate(tied, windowSet(60, 80, { model: tied }), {
    now: afterWindow(139),
  });
  expect(report.developmentPassed).toBe(false);
  const checkpoint = report.checkpoints[0];
  expect(checkpoint.candidate.brier).toBeLessThan(checkpoint.baseline.brier);
  expect(checkpoint.directionUncertainty.accuracyDifference).toEqual([0, 0]);
  expect(checkpoint.reasons.join(' ')).toMatch(/current-side benchmark/);
  expect(checkpoint.directionUncertainty.alpha).toBeCloseTo(0.05 / (6 * 5 * 3));
});

test('successful development is still not activation and confirmation uses only fresh declared events', () => {
  const events = windowSet(120, 80, { model });
  const development = evaluateChallengerCandidate(model, events, { now: afterWindow(139) });
  expect(development.developmentPassed).toBe(true);
  expect(development.eligibleForPromotion).toBe(false);
  const confirmation = evaluateChallengerCandidate(model, events, {
    now: afterWindow(199),
    phase: 'confirmation',
    startedAt: afterWindow(139),
    approvedCheckpoints: [9],
    attemptNumber: 1,
  });
  expect(confirmation.eligibleForPromotion).toBe(true);
  expect(confirmation.independentWindows).toBe(60);
  expect(confirmation.checkpoints[0].directionUncertainty.alpha).toBeCloseTo(0.025 / 3);
});

test('paired accuracy uncertainty distinguishes useful from harmful disagreements', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    challengerProbability: index % 2 ? 0.9 : 0.1,
    currentSide: 1,
    outcome: index % 2,
  }));
  expect(getCheckpointAccuracyUncertainty(rows, 0.01).accuracyDifference).toEqual([0.5, 0.5]);
  expect(getCheckpointAccuracyUncertainty(rows.slice(0, 56), 0.01)).toBeNull();
});

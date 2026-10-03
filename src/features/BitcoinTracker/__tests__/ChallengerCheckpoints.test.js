import {
  CHALLENGER_MODEL_VERSION,
  CHALLENGER_KINDS,
  isChallengerArtifact,
  isApprovedChallengerHorizon,
} from '../utils/learning/challengerModel.utils';
import {
  trainChallengerCandidate,
  evaluateChallengerCandidate,
  evaluateChallengerActiveModel,
  getChallengerConfirmationCohort,
  getChallengerTrainingReadiness,
} from '../utils/learning/challengerTraining.utils';
import {
  getChallengerCheckpoint,
  getChallengerConfirmationAlpha,
  getCheckpointReliability,
} from '../utils/learning/challengerCheckpoint.utils';
import { getCheckpointBrierUncertainty } from '../utils/learning/challengerValidation.utils';
import {
  RESEARCH_EXPERIMENT_V2,
  RESEARCH_EXPERIMENT_V3,
  RESEARCH_EXPERIMENT_V4,
} from '../utils/researchVariantConfig.utils';
import {
  windowSet,
  labelsFor,
  afterWindow,
  clone,
  recordedWindow,
  startOf,
} from './fixtures/challengerFixtures';

function trained(kind = 'reduced-pressure') {
  const events = windowSet(80);
  return trainChallengerCandidate(events, labelsFor(windowSet(60)), { kind, now: afterWindow(79) });
}

test.each(CHALLENGER_KINDS)(
  '%s separates primary fitting and later calibration contracts',
  (kind) => {
    const result = trained(kind);
    expect(result.status).toBe('shadow');
    expect(result.artifact.version).toBe(CHALLENGER_MODEL_VERSION);
    expect(result.counts).toMatchObject({ primaryFitWindows: 60, calibrationWindows: 20 });
    expect(isChallengerArtifact(result.artifact)).toBe(true);
    expect(result.artifact.calibration.startedAt).toBeGreaterThanOrEqual(
      result.artifact.calibration.primaryCutoffAt,
    );
    expect(result.artifact.calibration.checkpoints.every((row) => row.samples === 20)).toBe(true);
  },
);

test('held-out outcomes change calibration without changing fitted reversal coefficients', () => {
  const original = trained('reversal');
  const different = [...windowSet(60), ...windowSet(20, 60, { outcome: 1 })];
  const refit = trainChallengerCandidate(different, [], { kind: 'reversal', now: afterWindow(79) });
  expect(refit.artifact.model).toEqual(original.artifact.model);
  expect(refit.artifact.calibration.checkpoints[0]).toMatchObject({
    status: 'identity',
    offset: 0,
    samples: 20,
  });
  expect(original.artifact.calibration.checkpoints[0].status).toBe('fitted');
  const short = trainChallengerCandidate(windowSet(79), [], {
    kind: 'reversal',
    now: afterWindow(78),
  });
  expect(short).toMatchObject({
    status: 'insufficient-data',
    artifact: null,
    counts: { primaryFitWindows: 59 },
  });
});

test('late labels purge primary fit windows rather than leak across the time boundary', () => {
  const events = windowSet(80);
  const labels = labelsFor(windowSet(60)).map((label) => ({
    ...label,
    recordedAt: afterWindow(61),
  }));
  const result = trainChallengerCandidate(events, labels, {
    kind: 'forward-pressure',
    now: afterWindow(79),
  });
  expect(result.status).toBe('insufficient-data');
  expect(result.counts.primaryFitWindows).toBeLessThan(60);
  expect(result.counts.calibrationWindows).toBe(20);
});

test('late prior-contract settlement purges the fit boundary instead of permanently leaving nineteen calibration events', () => {
  const delayed = recordedWindow(69).map((row) =>
    row.event === 'outcome' ? { ...row, recordedAt: startOf(70) + 1000 } : row,
  );
  const events = [...windowSet(69), ...delayed, ...windowSet(20, 70)];
  const readiness = getChallengerTrainingReadiness(events, [], {
    kind: 'reduced-pressure',
    now: afterWindow(89),
  });
  expect(readiness).toMatchObject({
    ready: true,
    counts: { primaryFitWindows: 69, calibrationWindows: 20 },
  });
  const fitted = trainChallengerCandidate(events, [], {
    kind: 'reduced-pressure',
    now: afterWindow(89),
  });
  expect(fitted.status).toBe('shadow');
  expect(fitted.artifact.calibration.startedAt).toBeGreaterThanOrEqual(
    fitted.artifact.calibration.primaryCutoffAt,
  );
});

test('development nominates only successful checkpoints and cannot activate any candidate', () => {
  const model = trained().artifact;
  const events = windowSet(60, 80, { model, estimateByCheckpoint: { 6: 0.99 } });
  const report = evaluateChallengerCandidate(model, events, { now: afterWindow(139) });
  expect(report).toMatchObject({
    phase: 'development',
    developmentPassed: true,
    eligibleForPromotion: false,
    evaluationComplete: true,
  });
  expect(report.approvedCheckpoints).toEqual([12, 9, 3, 1]);
  expect(report.checkpoints.find((row) => row.checkpointMinutes === 6).status).toBe(
    'candidate-rejected',
  );
  expect(report.checkpoints.every((row) => row.independentWindows === 60)).toBe(true);
});

test('confirmation needs an explicit fresh boundary, frozen nominations, and an attempt number', () => {
  const model = trained().artifact;
  const events = windowSet(120, 80, { model });
  const options = {
    now: afterWindow(199),
    phase: 'confirmation',
    startedAt: afterWindow(139),
    approvedCheckpoints: [9],
    attemptNumber: 1,
  };
  const report = evaluateChallengerCandidate(model, events, options);
  expect(report).toMatchObject({
    eligibleForPromotion: true,
    evaluationComplete: true,
    independentWindows: 60,
    approvedCheckpoints: [9],
  });
  expect(report.checkpoints).toHaveLength(1);
  expect(report.checkpoints[0].uncertainty).toMatchObject({
    method: 'paired-four-event-block-t-interval',
    oneSided: true,
    blocks: 15,
    alpha: 0.0125,
  });
  const old = evaluateChallengerCandidate(model, windowSet(60, 80, { model }), options);
  expect(old).toMatchObject({ eligibleForPromotion: false, eligibleWindows: 0 });
  for (const key of ['startedAt', 'approvedCheckpoints', 'attemptNumber']) {
    const incomplete = { ...options };
    delete incomplete[key];
    expect(evaluateChallengerCandidate(model, events, incomplete).eligibleForPromotion).toBe(false);
  }
});

test('cohort membership grows before scoring and missing checkpoints cannot be replaced with later winners', () => {
  const model = trained().artifact;
  const options = {
    phase: 'confirmation',
    startedAt: afterWindow(139),
    approvedCheckpoints: [9],
    attemptNumber: 1,
  };
  const first = windowSet(10, 140, { model });
  const cohort = getChallengerConfirmationCohort(model, first, {
    ...options,
    now: afterWindow(149),
  });
  expect(cohort).toMatchObject({ valid: true, eligibleWindows: 10 });
  const events = windowSet(80, 140, { model });
  const missing = events.find((row) => row.event === 'decision' && row.checkpointMinutes === 9);
  delete missing.researchExperiment.variants[model.variantName];
  const report = evaluateChallengerCandidate(model, events, {
    ...options,
    now: afterWindow(219),
    cohortForecastIds: cohort.cohortForecastIds,
  });
  expect(report).toMatchObject({
    eligibleForPromotion: false,
    evaluationComplete: true,
    eligibleWindows: 60,
  });
  expect(report.cohortForecastIds.slice(0, 10)).toEqual(cohort.cohortForecastIds);
  expect(report.checkpoints[0].independentWindows).toBe(59);
  const reversed = getChallengerConfirmationCohort(model, events, {
    ...options,
    now: afterWindow(219),
    cohortForecastIds: [...cohort.cohortForecastIds].reverse(),
  });
  expect(reversed.valid).toBe(false);
});

test('approved application is confined to the tested timing bands', () => {
  const artifact = trained().artifact;
  const model = {
    ...artifact,
    activation: {
      shadowEvaluation: {
        phase: 'confirmation',
        eligibleForPromotion: true,
        approvedCheckpoints: [6],
      },
    },
  };
  expect(isApprovedChallengerHorizon(model, 6)).toBe(true);
  expect(isApprovedChallengerHorizon(model, 6 - 5 / 60)).toBe(true);
  for (const horizon of [5.9, 6.1, 3, 9, NaN])
    expect(isApprovedChallengerHorizon(model, horizon)).toBe(false);
  expect(getChallengerCheckpoint(0.5)).toBeNull();
});

test('confirmation spends a shrinking error budget and requires enough chronological blocks', () => {
  expect(getChallengerConfirmationAlpha(1, 5)).toBe(0.005);
  expect(getChallengerConfirmationAlpha(2, 5)).toBeLessThan(0.005);
  expect(getChallengerConfirmationAlpha(0, 5)).toBeNull();
  const rows = Array.from({ length: 59 }, (_, index) => ({
    outcome: index % 2,
    challengerProbability: 0.6,
    probability: 0.8,
  }));
  expect(getCheckpointBrierUncertainty(rows, (row) => row.probability, 0.005)).toBeNull();
  expect(getCheckpointReliability([{ probability: 0.7, outcome: 1 }])[3]).toMatchObject({
    samples: 1,
    observedFrequency: 1,
  });
  expect(
    getCheckpointReliability([{ probability: 0.7, outcome: 1 }])[3].observedFrequencyInterval[0],
  ).toBeLessThan(0.3);
});

test('active monitoring checks each approved checkpoint and does not rewrite saved decisions', () => {
  const artifact = trained().artifact;
  const model = {
    ...artifact,
    activation: {
      modelId: artifact.id,
      activatedAt: afterWindow(199),
      shadowEvaluation: {
        modelId: artifact.id,
        phase: 'confirmation',
        eligibleForPromotion: true,
        approvedCheckpoints: [9],
      },
    },
  };
  const events = windowSet(40, 200, { model, baseline: 0.5, estimate: 0.99, active: true });
  const before = clone(events);
  expect(evaluateChallengerActiveModel(model, events, { now: afterWindow(239) }).status).toBe(
    'disabled',
  );
  expect(events).toEqual(before);
  const pending = recordedWindow(240, { model, active: true }).filter(
    (row) => row.event === 'decision',
  );
  expect(
    evaluateChallengerActiveModel(model, [...events, ...pending], { now: afterWindow(240) }).status,
  ).toBe('disabled');
});

test('active evidence stays separate when a newer candidate occupies the same variant name', () => {
  const model = trained().artifact;
  const events = recordedWindow(80, { model });
  const decision = events.find((row) => row.event === 'decision');
  decision.researchExperiment.activePrediction =
    decision.researchExperiment.variants[model.variantName];
  decision.researchExperiment.variants[model.variantName] = { modelId: 'newer-candidate' };
  const report = evaluateChallengerCandidate(model, events, { now: afterWindow(80) });
  expect(
    report.checkpoints.find((row) => row.checkpointMinutes === decision.checkpointMinutes)
      .independentWindows,
  ).toBe(1);
});

test.each([RESEARCH_EXPERIMENT_V2, RESEARCH_EXPERIMENT_V3, RESEARCH_EXPERIMENT_V4])(
  '%s matching candidate predictions remain usable for prospective checkpoint scoring',
  (version) => {
    const model = trained().artifact;
    const events = recordedWindow(80, { model });
    for (const row of events) if (row.researchExperiment) row.researchExperiment.version = version;
    const report = evaluateChallengerCandidate(model, events, { now: afterWindow(80) });
    expect(report.checkpoints.every((checkpoint) => checkpoint.scoredWindows === 1)).toBe(true);
    expect(report.eligibleForPromotion).toBe(false);
  },
);

test('a verified deployment boundary includes its first contract and excludes pre-enrollment evidence', () => {
  const model = trained().artifact;
  const events = [...recordedWindow(80, { model }), ...recordedWindow(81, { model })];
  const cohort = getChallengerConfirmationCohort(model, events, {
    startedAt: startOf(81),
    now: afterWindow(81),
    inclusiveBoundary: true,
  });
  expect(cohort).toMatchObject({ valid: true, eligibleWindows: 1 });
  const report = evaluateChallengerCandidate(model, events, {
    phase: 'development',
    startedAt: startOf(81),
    now: afterWindow(81),
    inclusiveBoundary: true,
    cohortForecastIds: cohort.cohortForecastIds,
  });
  expect(report.eligibleWindows).toBe(1);
  expect(report.checkpoints.every((row) => row.independentWindows === 1)).toBe(true);
});

test('unrecorded candidates are an evidence failure, with unknown accuracy and no statistical verdict', () => {
  const model = trained().artifact;
  const events = windowSet(60, 80);
  const report = evaluateChallengerCandidate(model, events, { now: afterWindow(139) });
  expect(report).toMatchObject({
    status: 'unusable-evidence',
    failureCategory: 'evidence',
    failureCode: 'predictions-not-recorded',
    eligibleWindows: 60,
    independentWindows: 0,
    evaluationComplete: true,
    eligibleForPromotion: false,
  });
  expect(
    report.checkpoints.every(
      (row) => row.candidate.callAccuracy === null && row.uncertainty === null,
    ),
  ).toBe(true);
  expect(report.checkpoints.flatMap((row) => row.reasons).join(' ')).not.toMatch(
    /reduces|error intervals/,
  );
});

test.each(['unobserved', 'conflicting'])(
  'a %s outcome invalidates the cohort as evidence even when other checkpoints are complete',
  (failure) => {
    const model = trained().artifact;
    const events = windowSet(60, 80, { model });
    const outcome = events.find((row) => row.event === 'outcome');
    if (failure === 'unobserved') outcome.outcomeStatus = 'unobserved';
    else events.push({ ...outcome, observedPrice: outcome.observedPrice + 1 });

    const report = evaluateChallengerCandidate(model, events, { now: afterWindow(139) });
    expect(report).toMatchObject({
      status: 'unusable-evidence',
      failureCategory: 'evidence',
      failureCode: 'invalid-outcomes',
      evaluationComplete: true,
      eligibleForPromotion: false,
      developmentPassed: false,
      approvedCheckpoints: [],
    });
    expect(report.checkpoints.some((checkpoint) => checkpoint.scoredWindows === 60)).toBe(true);
    expect(report.reasons[0]).toMatch(/unobserved or conflicting outcomes/);
  },
);

test.each([
  ['development', 'unobserved'],
  ['development', 'conflicting'],
  ['confirmation', 'unobserved'],
  ['confirmation', 'conflicting'],
])(
  '%s stops immediately when a fixed cohort has a terminal %s outcome before sixty events',
  (phase, failure) => {
    const model = trained().artifact;
    const events = windowSet(3, 80, { model });
    const options = {
      phase,
      startedAt: model.shadowStartsAt,
      now: afterWindow(82),
      ...(phase === 'confirmation' ? { approvedCheckpoints: [12, 9], attemptNumber: 1 } : {}),
    };
    const cohort = getChallengerConfirmationCohort(model, events, options);
    options.cohortForecastIds = cohort.cohortForecastIds;
    const outcome = events.find((row) => row.event === 'outcome');
    if (failure === 'unobserved') outcome.outcomeStatus = 'unobserved';
    else events.push({ ...outcome, observedPrice: outcome.observedPrice + 1 });
    const savedInputs = clone({ model, events, options });

    const report = evaluateChallengerCandidate(model, events, options);

    expect(report).toMatchObject({
      phase,
      status: 'unusable-evidence',
      failureCategory: 'evidence',
      failureCode: 'invalid-outcomes',
      evaluationComplete: true,
      eligibleWindows: 3,
      requiredWindows: 60,
      eligibleForPromotion: false,
      developmentPassed: false,
      approvedCheckpoints: [],
      cohortForecastIds: cohort.cohortForecastIds,
    });
    expect(report.checkpoints.find((row) => row.checkpointMinutes === 12)).toMatchObject({
      scoredWindows: 2,
      candidate: { examples: 2 },
      uncertainty: null,
    });
    expect(report.checkpoints.find((row) => row.checkpointMinutes === 9)).toMatchObject({
      scoredWindows: 3,
      candidate: { examples: 3 },
      uncertainty: null,
    });
    expect(report.reasons[0]).toMatch(/not a valid performance test/);
    expect({ model, events, options }).toEqual(savedInputs);
  },
);

test('pending outcomes and missing predictions do not become terminal evidence failures early', () => {
  const model = trained().artifact;
  const events = windowSet(3, 80, { model });
  const outcome = events.find((row) => row.event === 'outcome');
  events.splice(events.indexOf(outcome), 1);
  const decision = events.find((row) => row.event === 'decision' && row.checkpointMinutes === 9);
  delete decision.researchExperiment.variants[model.variantName];

  expect(evaluateChallengerCandidate(model, events, { now: afterWindow(82) })).toMatchObject({
    status: 'collecting',
    evaluationComplete: false,
    eligibleWindows: 3,
    eligibleForPromotion: false,
    failureCategory: null,
  });
});

test('a terminal outcome outside the enrolled time boundary does not stop the candidate', () => {
  const model = trained().artifact;
  const earlier = recordedWindow(80, { model });
  earlier.find((row) => row.event === 'outcome').outcomeStatus = 'unobserved';
  const report = evaluateChallengerCandidate(model, [...earlier, ...windowSet(3, 81, { model })], {
    startedAt: startOf(81),
    inclusiveBoundary: true,
    now: afterWindow(83),
  });

  expect(report).toMatchObject({
    status: 'collecting',
    evaluationComplete: false,
    eligibleWindows: 3,
    independentWindows: 3,
    failureCategory: null,
  });
});

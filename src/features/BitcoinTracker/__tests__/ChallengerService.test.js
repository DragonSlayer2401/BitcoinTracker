/** @jest-environment node */
import { createChallengerService } from '../../../services/research/challenger.service';
import {
  evaluateChallengerActiveModel,
  evaluateChallengerCandidate,
  getChallengerConfirmationCohort,
  trainChallengerCandidate,
} from '../utils/learning/challengerTraining.utils';
import { CHALLENGER_KINDS } from '../utils/learning/challengerModel.utils';
import { CHALLENGER_ENROLLMENT_POLICY } from '../../../services/research/challengerDevelopment.repository';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('../utils/learning/challengerModel.utils', () => ({
  CHALLENGER_MODEL_VERSION: 'forecast-challenger-v2',
  CHALLENGER_KINDS: [
    'reversal',
    'forward-pressure',
    'reduced-pressure',
    'fast-decay',
    'market-blend',
  ],
  CHALLENGER_REQUIREMENTS: {
    minimumTrainingWindows: 60,
    minimumCalibrationWindows: 20,
    minimumClassExamples: 10,
    minimumReversalExamples: 12,
    minimumNewWindowsForRetraining: 20,
  },
  isChallengerArtifact: (model) =>
    ['forecast-challenger-v1', 'forecast-challenger-v2'].includes(model?.version),
  matchesChallengerPipeline: (model, pipeline) =>
    model.pipeline.baselineModelVersion === pipeline.baselineModelVersion,
}));
jest.mock('../utils/learning/evaluation.utils', () => ({
  groupOverlappingWindows: (rows) => rows.map((row) => ({ rows: [row] })),
}));
jest.mock('../utils/learning/challengerTraining.utils', () => ({
  evaluateChallengerActiveModel: jest.fn(),
  evaluateChallengerCandidate: jest.fn(),
  trainChallengerCandidate: jest.fn(),
  getChallengerConfirmationCohort: jest.fn(),
  getChallengerTrainingReadiness: (rows) => ({
    ready: rows.length >= 80,
    counts: { independentWindows: rows.length },
    reason: 'Need fitting and calibration events.',
  }),
  getChallengerTrainingRows: (rows) => ({
    rows,
    pipeline: rows[0]?.pipeline ?? null,
    counts: {
      independentWindows: rows.length,
      classes: { above: Math.floor(rows.length / 2), below: Math.ceil(rows.length / 2) },
      reversals: Math.floor(rows.length / 2),
    },
  }),
}));

const pipeline = {
  baselineModelVersion: 'kalshi-brti-average-v2',
  referenceSource: 'cf-brti',
  featureInputSource: 'cf-brti-history',
  featureVersion: 'deadline-reversal-features-v2',
};
const now = 1_800_000_000_000;
const rows = (count, first = now - 100_000) =>
  Array.from({ length: count }, (_, index) => ({
    windowStartAt: first + index * 1000,
    pipeline,
  }));
const artifact = (kind = 'reversal', trainedAt = now - 2000) => ({
  id: `model-${kind}-${trainedAt}`,
  version: 'forecast-challenger-v2',
  kind,
  trainedAt,
  pipeline,
  evaluation: { eligibleForShadow: true },
});
const pending = {
  eligibleForPromotion: false,
  evaluationComplete: false,
  reasons: ['Collect later outcomes.'],
};
function store(models = [], active = null) {
  const repository = {
    events: rows(80),
    trials: [],
    developments: [],
    models,
    active,
    getLearningEvidenceRows: jest.fn(async () => repository.events),
    getForwardResearchLabels: jest.fn(async () => []),
    readModelArtifacts: jest.fn(async () => repository.models),
    getActiveModelArtifact: jest.fn(async () => repository.active),
    readChallengerTrials: jest.fn(async () => repository.trials),
    readChallengerDevelopments: jest.fn(async () => repository.developments),
    createChallengerTrial: jest.fn(async (input) => {
      const trial = {
        ...input,
        attemptNumber: repository.trials.length + 1,
        cohortForecastIds: [],
        status: 'collecting',
        evaluation: null,
      };
      repository.trials.push(trial);
      return trial;
    }),
    updateChallengerTrial: jest.fn(async (id, update) => {
      const trial = repository.trials.find((entry) => entry.modelId === id);
      Object.assign(trial, { status: 'collecting', evaluation: null, ...update });
      return trial;
    }),
    acquireLearningLease: jest.fn(async () => true),
    releaseLearningLease: jest.fn(async () => undefined),
    writeModelArtifact: jest.fn(async (model) => {
      repository.models.push(model);
    }),
    activateModelArtifact: jest.fn(async (id, activation) => {
      const trial = repository.trials.find((entry) => entry.modelId === id);
      if (trial) trial.activatedAt = activation.activatedAt;
      repository.active = {
        ...repository.models.find((model) => model.id === id),
        activation: { modelId: id, ...activation },
      };
    }),
    retireModelArtifact: jest.fn(async (id, retirement) => {
      repository.models.find((model) => model.id === id).retirement = retirement;
      if (repository.active?.id === id) repository.active = null;
    }),
  };
  return repository;
}

beforeEach(() => {
  jest.clearAllMocks();
  evaluateChallengerCandidate.mockReturnValue(pending);
  getChallengerConfirmationCohort.mockReturnValue({ valid: true, cohortForecastIds: [] });
  evaluateChallengerActiveModel.mockReturnValue({ status: 'healthy', reason: 'Within limits.' });
  trainChallengerCandidate.mockImplementation((events, labels, { kind, now: trainedAt }) => ({
    artifact: artifact(kind, trainedAt),
    status: 'shadow',
    reason: 'Frozen for future evaluation.',
  }));
});

test('the existing caller lease can run all five candidates without acquiring or releasing it', async () => {
  const repository = store();
  const service = createChallengerService(repository);
  const result = await service.runChallengerCycle({ now, leaseHeld: true });
  expect(repository.acquireLearningLease).not.toHaveBeenCalled();
  expect(repository.releaseLearningLease).not.toHaveBeenCalled();
  expect(repository.writeModelArtifact).toHaveBeenCalledTimes(5);
  expect(repository.activateModelArtifact).not.toHaveBeenCalled();
  expect(result.candidates.map((model) => model.kind)).toEqual(CHALLENGER_KINDS);
});

test('read endpoints expose compact model inputs and never write or promote', async () => {
  const repository = store([artifact()]);
  const service = createChallengerService(repository);
  expect(await service.getChallengerModels({ now })).toEqual({
    candidates: repository.models,
    active: null,
  });
  const status = await service.getChallengerStatus({ now });
  expect(status.reports).toHaveLength(5);
  expect(status.reports[0]).toMatchObject({
    kind: 'reversal',
    status: 'shadow',
    evaluation: pending,
  });
  expect(repository.writeModelArtifact).not.toHaveBeenCalled();
  expect(repository.activateModelArtifact).not.toHaveBeenCalled();
  expect(repository.retireModelArtifact).not.toHaveBeenCalled();
});

test('the training cycle forwards stored future-return labels to the pressure fit', async () => {
  const repository = store();
  const labels = [{ snapshotId: 'original-capture', horizonSeconds: 60, status: 'observed' }];
  repository.getForwardResearchLabels.mockResolvedValue(labels);
  await createChallengerService(repository).runChallengerCycle({ now, leaseHeld: true });
  expect(trainChallengerCandidate).toHaveBeenCalledWith(
    repository.events,
    labels,
    expect.objectContaining({ kind: 'forward-pressure', now }),
  );
});

test('development nominates one family by declared priority and cannot activate a model', async () => {
  const repository = store([artifact('reversal'), artifact('forward-pressure')]);
  evaluateChallengerCandidate.mockImplementation((model) => ({
    modelId: model.id,
    evaluatedAt: now,
    eligibleForPromotion: false,
    developmentPassed: true,
    approvedCheckpoints: [9, 6],
    evaluationComplete: true,
    reasons: [],
    candidate: { brier: model.kind === 'reversal' ? 0.2 : 0.1 },
  }));
  await createChallengerService(repository).runChallengerCycle({ now });
  expect(repository.activateModelArtifact).not.toHaveBeenCalled();
  expect(repository.createChallengerTrial).toHaveBeenCalledWith(
    expect.objectContaining({
      modelId: repository.models[0].id,
      startedAt: now,
      approvedCheckpoints: [9, 6],
    }),
  );
  expect(repository.releaseLearningLease).toHaveBeenCalledTimes(1);
});

test('a rejected cohort is retired and waits for twenty genuinely new events', async () => {
  const repository = store([artifact()]);
  evaluateChallengerCandidate.mockReturnValue({
    ...pending,
    evaluationComplete: true,
    reasons: ['Failed paired checks.'],
  });
  const service = createChallengerService(repository);
  await service.runChallengerCycle({ now });
  expect(repository.models[0].retirement.retiredAt).toBe(now);
  trainChallengerCandidate.mockClear();
  await service.runChallengerCycle({ now: now + 1000 });
  expect(trainChallengerCandidate).not.toHaveBeenCalled();
  repository.events.push(...rows(20, now + 1000));
  await service.runChallengerCycle({ now: now + 30_000 });
  expect(trainChallengerCandidate.mock.calls.some((call) => call[2].kind === 'reversal')).toBe(
    true,
  );
});

test('degraded active influence stops on read and retirement is written only in the leased cycle', async () => {
  const model = artifact();
  const repository = store([model], { ...model, activation: { activatedAt: now - 1000 } });
  evaluateChallengerActiveModel.mockReturnValue({
    status: 'disabled',
    reason: 'Recent probability error deteriorated.',
  });
  const service = createChallengerService(repository);
  expect((await service.getChallengerModels({ now })).active).toBeNull();
  expect(repository.retireModelArtifact).not.toHaveBeenCalled();
  await service.runChallengerCycle({ now });
  expect(repository.retireModelArtifact).toHaveBeenCalledWith(
    model.id,
    expect.objectContaining({ retiredAt: now }),
  );
});

test('a production change during confirmation invalidates the trial', async () => {
  const model = artifact();
  const repository = store([model], { id: 'full-model', activation: { activatedAt: now - 1000 } });
  repository.trials.push({
    modelId: model.id,
    status: 'collecting',
    startedAt: now - 1500,
    productionModelId: null,
    productionActivatedAt: null,
    cohortForecastIds: [],
    approvedCheckpoints: [9],
    attemptNumber: 1,
  });
  await createChallengerService(repository).runChallengerCycle({ now });
  expect(repository.activateModelArtifact).not.toHaveBeenCalled();
  expect(repository.models[0].retirement.reason).toMatch(/Production changed/);
  expect(repository.trials[0].status).toBe('abandoned');
});

test('fresh confirmation replaces a healthy incumbent and persists membership before evaluating it', async () => {
  const old = artifact('reversal', now - 20_000);
  const candidate = artifact('reversal');
  const active = { ...old, activation: { activatedAt: now - 10_000 } };
  const repository = store([old, candidate], active);
  repository.trials.push({
    modelId: candidate.id,
    startedAt: now - 1000,
    status: 'collecting',
    productionModelId: old.id,
    productionActivatedAt: active.activation.activatedAt,
    cohortForecastIds: [],
    approvedCheckpoints: [9],
    attemptNumber: 2,
  });
  const ids = Array.from({ length: 60 }, (_, index) => `event-${index}`);
  getChallengerConfirmationCohort.mockReturnValue({ valid: true, cohortForecastIds: ids });
  evaluateChallengerCandidate.mockImplementation((model, events, options) =>
    options.cohortForecastIds?.length === 60
      ? {
          modelId: model.id,
          phase: 'confirmation',
          eligibleForPromotion: true,
          evaluationComplete: true,
          approvedCheckpoints: [9],
          evaluatedAt: now,
          cohortForecastIds: ids,
          reasons: [],
        }
      : pending,
  );
  await createChallengerService(repository).runChallengerCycle({ now });
  expect(repository.active.id).toBe(candidate.id);
  expect(repository.trials[0]).toMatchObject({
    status: 'passed',
    cohortForecastIds: ids,
    activatedAt: now,
  });
  expect(repository.updateChallengerTrial.mock.invocationCallOrder[0]).toBeLessThan(
    repository.activateModelArtifact.mock.invocationCallOrder[0],
  );
  expect(trainChallengerCandidate).not.toHaveBeenCalled();
});

test('a restart resumes saved membership without fitting or creating another trial', async () => {
  const candidate = artifact();
  const repository = store([candidate]);
  const ids = ['contract-one'];
  repository.trials.push({
    modelId: candidate.id,
    startedAt: now - 1000,
    status: 'collecting',
    productionModelId: null,
    productionActivatedAt: null,
    cohortForecastIds: ids,
    approvedCheckpoints: [6],
    attemptNumber: 3,
  });
  getChallengerConfirmationCohort.mockReturnValue({ valid: true, cohortForecastIds: ids });
  await createChallengerService(repository).runChallengerCycle({ now });
  await createChallengerService(repository).runChallengerCycle({ now: now + 1000 });
  expect(getChallengerConfirmationCohort).toHaveBeenLastCalledWith(
    candidate,
    repository.events,
    expect.objectContaining({ cohortForecastIds: ids, startedAt: now - 1000 }),
  );
  expect(trainChallengerCandidate).not.toHaveBeenCalled();
  expect(repository.createChallengerTrial).not.toHaveBeenCalled();
  expect(repository.activateModelArtifact).not.toHaveBeenCalled();
});

test('a saved pass recovers after interruption before activation', async () => {
  const candidate = artifact();
  const repository = store([candidate]);
  const evaluation = {
    modelId: candidate.id,
    phase: 'confirmation',
    eligibleForPromotion: true,
    evaluationComplete: true,
    reasons: [],
  };
  repository.trials.push({
    modelId: candidate.id,
    status: 'passed',
    startedAt: now - 1000,
    productionModelId: null,
    productionActivatedAt: null,
    cohortForecastIds: [],
    approvedCheckpoints: [9],
    attemptNumber: 1,
    evaluation,
  });
  const service = createChallengerService(repository);
  expect((await service.getChallengerStatus({ now })).confirmation).toMatchObject({
    status: 'passed',
    modelId: candidate.id,
  });
  await service.runChallengerCycle({ now });
  expect(repository.activateModelArtifact).toHaveBeenCalledWith(candidate.id, {
    activatedAt: now,
    shadowEvaluation: evaluation,
  });
  expect(getChallengerConfirmationCohort).not.toHaveBeenCalled();
});

test('a healthy active family can fit a replacement after twenty new independent events', async () => {
  const candidate = artifact('reversal', now - 200_000);
  const repository = store([candidate], {
    ...candidate,
    activation: { activatedAt: now - 150_000 },
  });
  await createChallengerService(repository).runChallengerCycle({ now });
  expect(trainChallengerCandidate.mock.calls.some((call) => call[2].kind === 'reversal')).toBe(
    true,
  );
  expect(repository.active.id).toBe(candidate.id);
});

test('a busy shared lease leaves models untouched', async () => {
  const repository = store();
  repository.acquireLearningLease.mockResolvedValue(false);
  const result = await createChallengerService(repository).runChallengerCycle({ now });
  expect(result.lastRun[0].status).toBe('busy');
  expect(repository.writeModelArtifact).not.toHaveBeenCalled();
  expect(repository.releaseLearningLease).not.toHaveBeenCalled();
});

test('new candidates wait for persisted collector readiness instead of consuming future cohorts immediately', async () => {
  const candidate = { ...artifact(), enrollmentPolicy: CHALLENGER_ENROLLMENT_POLICY };
  const repository = store([candidate]);
  const service = createChallengerService(repository);
  const status = await service.getChallengerStatus({ now });
  expect(status.reports[0]).toMatchObject({
    status: 'awaiting-collector',
    evaluation: null,
    readiness: { status: 'waiting' },
  });
  expect(evaluateChallengerCandidate).not.toHaveBeenCalled();
  repository.developments.push({
    modelId: candidate.id,
    startedAt: now + 1000,
    inclusiveBoundary: true,
    readiness: { readyAt: now },
    cohortForecastIds: [],
    status: 'collecting',
  });
  expect((await service.getChallengerStatus({ now })).reports[0].status).toBe('awaiting-start');
  await service.getChallengerStatus({ now: now + 1000 });
  expect(evaluateChallengerCandidate).toHaveBeenCalledWith(
    candidate,
    repository.events,
    expect.objectContaining({ startedAt: now + 1000, inclusiveBoundary: true }),
  );
});

test('missing recordings are preserved as an infrastructure failure and a fresh candidate can fit without twenty new events', async () => {
  const candidate = artifact();
  const repository = store([candidate]);
  evaluateChallengerCandidate.mockReturnValue({
    ...pending,
    status: 'unusable-evidence',
    failureCategory: 'evidence',
    failureCode: 'predictions-not-recorded',
    evaluationComplete: true,
    reasons: ['Matching predictions were not recorded.'],
  });
  const result = await createChallengerService(repository).runChallengerCycle({ now });
  expect(candidate.retirement.reason).toMatch(/^\[unusable-evidence\]/);
  const replacement = repository.models.find(
    (model) => model.kind === candidate.kind && model.id !== candidate.id,
  );
  expect(replacement).toMatchObject({
    trainedAt: now,
    enrollmentPolicy: CHALLENGER_ENROLLMENT_POLICY,
  });
  expect(result.lastRun).toContainEqual(
    expect.objectContaining({ modelId: candidate.id, status: 'unusable-evidence' }),
  );
  expect(repository.activateModelArtifact).not.toHaveBeenCalled();
  expect(repository.events).toHaveLength(80);
});

test('confirmation evaluation cannot be hidden by a saved development pass', async () => {
  const candidate = artifact();
  const repository = store([candidate]);
  repository.developments.push({
    modelId: candidate.id,
    startedAt: now - 3000,
    status: 'passed',
    evaluation: { phase: 'development', developmentPassed: true, reasons: [] },
  });
  repository.trials.push({
    modelId: candidate.id,
    status: 'collecting',
    startedAt: now - 1000,
    approvedCheckpoints: [9],
    cohortForecastIds: [],
    attemptNumber: 1,
  });
  evaluateChallengerCandidate.mockReturnValue({ ...pending, phase: 'confirmation' });
  const result = await createChallengerService(repository).getChallengerStatus({ now });
  expect(result.reports[0].evaluation.phase).toBe('confirmation');
  expect(evaluateChallengerCandidate).toHaveBeenCalledWith(
    candidate,
    repository.events,
    expect.objectContaining({ phase: 'confirmation' }),
  );
});

test('invalid confirmation membership is abandoned as evidence while retaining its cohort and attempt', async () => {
  const candidate = artifact();
  const repository = store([candidate]);
  const cohortForecastIds = ['original-event'];
  repository.trials.push({
    modelId: candidate.id,
    status: 'collecting',
    startedAt: now - 1000,
    productionModelId: null,
    productionActivatedAt: null,
    cohortForecastIds,
    approvedCheckpoints: [9],
    attemptNumber: 3,
  });
  getChallengerConfirmationCohort.mockReturnValue({
    valid: false,
    cohortForecastIds: ['replacement-event'],
    reason: 'Stored cohort members are missing, reordered, or duplicated.',
  });

  const service = createChallengerService(repository);
  const result = await service.runChallengerCycle({ now });
  expect(repository.trials[0]).toMatchObject({
    status: 'abandoned',
    cohortForecastIds,
    attemptNumber: 3,
    evaluation: {
      status: 'unusable-evidence',
      failureCategory: 'evidence',
      failureCode: 'missing-cohort-members',
      eligibleForPromotion: false,
      cohortForecastIds,
      attemptNumber: 3,
    },
  });
  expect(candidate.retirement.reason).toMatch(/^\[unusable-evidence\]/);
  expect(result.lastRun).toContainEqual(
    expect.objectContaining({ modelId: candidate.id, status: 'unusable-evidence' }),
  );
  expect(repository.activateModelArtifact).not.toHaveBeenCalled();
  expect(trainChallengerCandidate).not.toHaveBeenCalled();

  await service.runChallengerCycle({ now: now + 1000 });
  expect(trainChallengerCandidate).toHaveBeenCalledWith(
    repository.events,
    [],
    expect.objectContaining({ kind: 'reversal', now: now + 1000 }),
  );
  expect(repository.trials[0].attemptNumber).toBe(3);
  expect(repository.trials[0].cohortForecastIds).toEqual(cohortForecastIds);
  expect(repository.events).toHaveLength(80);
});

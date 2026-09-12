/** @jest-environment node */
import { createLearningService } from '../../../services/research/learning.service';
import { trainOutcomeCandidate, evaluateShadowCandidate } from '../utils/learning/training.utils';
import {
  trainEarlyCandidate,
  evaluateEarlyShadowCandidate,
  evaluateEarlyActiveModel,
} from '../utils/learning/earlyTraining.utils';
import { EARLY_MODEL_VERSION } from '../utils/learning/earlyModel.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('../utils/learning/evaluation.utils', () => ({
  analyzeForecastEvidence: jest.fn(() => ({})),
  analyzeSavedForecasts: jest.fn(() => ({})),
  getVerifiedLearningRows: jest.fn((events) => ({ rows: events })),
  getIndependentRows: jest.fn((rows) => rows),
  groupOverlappingWindows: jest.fn((rows) => rows.map((row) => ({ rows: [row] }))),
}));
jest.mock('../utils/learning/model.utils', () => ({
  isOutcomeModelArtifact: (model) => model?.version === 'outcome-logistic-kalshi-v2',
  matchesOutcomeModelPipeline: (model, pipeline) =>
    model?.pipeline?.baselineModelVersion === pipeline?.baselineModelVersion,
}));
jest.mock('../utils/learning/training.utils', () => ({
  LEARNING_REQUIREMENTS: {
    minimumTrainingWindows: 120,
    minimumCalibrationWindows: 60,
    minimumTestWindows: 60,
    minimumShadowWindows: 120,
  },
  trainOutcomeCandidate: jest.fn(),
  evaluateShadowCandidate: jest.fn(),
  selectLearningPipelineRows: (rows) => ({ rows, pipeline: rows[0]?.pipeline ?? null }),
  splitLearningWindows: (rows) => ({
    train: rows.slice(0, Math.floor(rows.length * 0.5)),
    calibration: rows.slice(Math.floor(rows.length * 0.5), Math.floor(rows.length * 0.75)),
    test: rows.slice(Math.floor(rows.length * 0.75)),
    groupCount: rows.length,
    purgedGroups: 0,
  }),
}));
jest.mock('../utils/learning/earlyModel.utils', () => ({
  EARLY_MODEL_VERSION: 'outcome-early-kalshi-v1',
  isEarlyModelArtifact: (model) => model?.version === 'outcome-early-kalshi-v1',
  EARLY_LEARNING_REQUIREMENTS: {
    minimumTrainingWindows: 40,
    minimumClassExamples: 8,
    minimumShadowWindows: 40,
    minimumShadowModelUses: 20,
    minimumNewWindowsForRetraining: 20,
    minimumMonitoringWindows: 40,
    maximumProbabilityAdjustment: 0.05,
    blendWeight: 0.2,
  },
}));
jest.mock('../utils/learning/earlyTraining.utils', () => ({
  trainEarlyCandidate: jest.fn(),
  evaluateEarlyShadowCandidate: jest.fn(),
  evaluateEarlyActiveModel: jest.fn(),
}));

const start = Date.UTC(2026, 8, 11);
const now = start + 2 * 86_400_000;
const pipeline = {
  baselineModelVersion: 'kalshi-brti-average-v2',
  referenceSource: 'cf-brti',
  featureInputSource: 'cf-brti-history',
};
const model = (id, version = EARLY_MODEL_VERSION, trainedAt = start) => ({
  id,
  version,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  trainedAt,
  pipeline,
  evaluation: { eligibleForShadow: true },
});
const rows = (count, from = start) =>
  Array.from({ length: count }, (_, index) => ({
    id: `event-${from}-${index}`,
    windowStartAt: from + index * 900_000,
    outcome: index % 2,
    pipeline,
  }));
const pendingShadow = {
  eligibleForPromotion: false,
  evaluationComplete: false,
  independentWindows: 0,
  eligibleWindows: 0,
  reasons: ['Collect future predictions.'],
};
const passedShadow = (candidate) => ({
  ...pendingShadow,
  modelId: candidate.id,
  evaluatedAt: now,
  eligibleForPromotion: true,
  evaluationComplete: true,
  reasons: [],
});

function createStore(events = rows(87), models = [], active = null) {
  const store = {
    events,
    models,
    active,
    getLearningEvidenceRows: jest.fn(async () => store.events),
    readModelArtifacts: jest.fn(async () => store.models),
    readStoredForecasts: jest.fn(async () => ({ rows: [], nextCursor: null })),
    getActiveModelArtifact: jest.fn(async () =>
      store.models.find((candidate) => candidate.id === store.active?.id)?.retirement
        ? null
        : store.active,
    ),
    acquireLearningLease: jest.fn(async () => true),
    releaseLearningLease: jest.fn(async () => undefined),
    writeModelArtifact: jest.fn(async (candidate) => store.models.push(candidate)),
    activateModelArtifact: jest.fn(async (id, activation) => {
      store.active = {
        ...store.models.find((candidate) => candidate.id === id),
        activation: { modelId: id, ...activation },
      };
    }),
    retireModelArtifact: jest.fn(async (id, retirement) => {
      store.models.find((candidate) => candidate.id === id).retirement = {
        ...retirement,
        wasActive: store.active?.id === id,
      };
    }),
  };
  return store;
}

beforeEach(() => {
  jest.clearAllMocks();
  trainOutcomeCandidate.mockReturnValue({
    status: 'insufficient-data',
    reason: 'Full model needs more events.',
    artifact: null,
  });
  trainEarlyCandidate.mockImplementation((events, { now: trainedAt }) => ({
    status: 'shadow',
    reason: 'Early candidate fitted.',
    artifact: model(`early-${trainedAt}`, EARLY_MODEL_VERSION, trainedAt),
  }));
  evaluateShadowCandidate.mockReturnValue(pendingShadow);
  evaluateEarlyShadowCandidate.mockReturnValue(pendingShadow);
  evaluateEarlyActiveModel.mockReturnValue({
    status: 'monitoring',
    reason: 'Collecting later outcomes.',
  });
});

test('read-only status shows early readiness without training or changing full requirements', async () => {
  const store = createStore();
  const status = await createLearningService(store).getLearningStatus({ now });
  expect(status.training).toMatchObject({
    status: 'insufficient-data',
    counts: { training: 43, calibration: 22, test: 22 },
  });
  expect(status.requirements).toMatchObject({
    minimumTrainingWindows: 120,
    minimumCalibrationWindows: 60,
    minimumTestWindows: 60,
    minimumShadowWindows: 120,
  });
  expect(status.early.training).toMatchObject({
    status: 'ready-to-train',
    counts: { training: 87, independentWindows: 87 },
  });
  expect(trainEarlyCandidate).not.toHaveBeenCalled();
  expect(store.writeModelArtifact).not.toHaveBeenCalled();
  expect(store.activateModelArtifact).not.toHaveBeenCalled();
});

test('fits the early candidate while the full model is still collecting and freezes it across cycles', async () => {
  const store = createStore();
  const service = createLearningService(store);
  const first = await service.runLearningCycle({ now });
  const candidate = first.early.candidate;
  expect(candidate).toBeDefined();
  expect(first.active).toBeNull();
  expect(first.candidate).toBeNull();
  expect(first.early.lastRun.status).toBe('shadow');
  await service.runLearningCycle({ now: now + 60_000 });
  expect(trainEarlyCandidate).toHaveBeenCalledTimes(1);
  expect(store.writeModelArtifact).toHaveBeenCalledTimes(1);
  expect(store.activateModelArtifact).not.toHaveBeenCalled();
  expect(await service.getResearchModels()).toEqual({
    active: null,
    candidate: null,
    earlyCandidate: candidate,
  });
});

test('an active early model does not hide an older full candidate in either response', async () => {
  const full = model('full', 'outcome-logistic-kalshi-v2');
  const early = model('early', EARLY_MODEL_VERSION, start + 60_000);
  const active = { ...early, activation: { modelId: early.id, activatedAt: start + 120_000 } };
  const store = createStore(rows(87), [full, early], active);
  const service = createLearningService(store);
  const selected = await service.getResearchModels();
  expect(selected).toMatchObject({
    active: { id: early.id },
    candidate: { id: full.id },
    earlyCandidate: null,
  });
  const status = await service.getLearningStatus({ now });
  expect(status.early.active.id).toBe(early.id);
  expect(status.models.map((candidate) => candidate.id)).toEqual([full.id]);
});

test('an early candidate waiting for future events cannot block full training', async () => {
  const early = model('early');
  const full = model('new-full', 'outcome-logistic-kalshi-v2', now);
  const store = createStore(rows(320), [early]);
  trainOutcomeCandidate.mockReturnValue({ status: 'shadow', artifact: full });
  const status = await createLearningService(store).runLearningCycle({ now });
  expect(store.writeModelArtifact).toHaveBeenCalledWith(full);
  expect(status.candidate.id).toBe(full.id);
  expect(status.early.candidate.id).toBe(early.id);
  expect(trainEarlyCandidate).not.toHaveBeenCalled();
});

test('a newly fitted full candidate only defers a new early fit until the next cycle', async () => {
  const full = model('new-full', 'outcome-logistic-kalshi-v2', now);
  const store = createStore(rows(320));
  trainOutcomeCandidate.mockReturnValue({ status: 'shadow', artifact: full });
  const service = createLearningService(store);
  expect((await service.runLearningCycle({ now })).early.lastRun.status).toBe('deferred');
  expect(trainEarlyCandidate).not.toHaveBeenCalled();
  await service.runLearningCycle({ now: now + 60_000 });
  expect(trainEarlyCandidate).toHaveBeenCalledTimes(1);
});

test('full promotion supersedes early promotion in the same cycle', async () => {
  const full = model('full', 'outcome-logistic-kalshi-v2');
  const early = model('early');
  const store = createStore(rows(87), [full, early]);
  evaluateShadowCandidate.mockReturnValue(passedShadow(full));
  evaluateEarlyShadowCandidate.mockReturnValue(passedShadow(early));
  const status = await createLearningService(store).runLearningCycle({ now });
  expect(store.activateModelArtifact).toHaveBeenCalledTimes(1);
  expect(store.activateModelArtifact).toHaveBeenCalledWith(full.id, expect.any(Object));
  expect(status.active.id).toBe(full.id);
  expect(status.early.training.status).toBe('superseded');
  expect(status.early.candidate).toBeNull();
});

test('early promotion can proceed while the full candidate continues its larger future test', async () => {
  const full = model('full', 'outcome-logistic-kalshi-v2');
  const early = model('early');
  const store = createStore(rows(87), [full, early]);
  evaluateEarlyShadowCandidate.mockReturnValue(passedShadow(early));
  const status = await createLearningService(store).runLearningCycle({ now });
  expect(status.active.id).toBe(early.id);
  expect(status.candidate.id).toBe(full.id);
  expect(status.early.lastRun.status).toBe('activated');
  expect(trainEarlyCandidate).not.toHaveBeenCalled();
});

test('a failed future cohort is retired and needs twenty events after rejection before refitting', async () => {
  const candidate = model('early');
  const store = createStore(rows(87), [candidate]);
  evaluateEarlyShadowCandidate.mockReturnValue({
    ...pendingShadow,
    evaluationComplete: true,
    reasons: ['Probability error did not improve.'],
  });
  await createLearningService(store).runLearningCycle({ now });
  expect(store.retireModelArtifact).toHaveBeenCalledWith(candidate.id, {
    retiredAt: now,
    reason: 'Probability error did not improve.',
  });
  const restarted = createLearningService(store);
  expect((await restarted.getResearchModels()).earlyCandidate).toBeNull();
  store.events.push(...rows(19, now + 1));
  await restarted.runLearningCycle({ now: now + 20 * 900_000 });
  expect(trainEarlyCandidate).not.toHaveBeenCalled();
  store.events.push(...rows(1, now + 19 * 900_000 + 1));
  evaluateEarlyShadowCandidate.mockReturnValue(pendingShadow);
  const status = await restarted.runLearningCycle({ now: now + 21 * 900_000 });
  expect(trainEarlyCandidate).toHaveBeenCalledTimes(1);
  expect(status.early.candidate.id).not.toBe(candidate.id);
});

test('degradation retires active early influence and remains disabled after service restart', async () => {
  const early = model('early');
  const active = { ...early, activation: { modelId: early.id, activatedAt: now - 1000 } };
  const store = createStore(rows(87), [early], active);
  evaluateEarlyActiveModel.mockReturnValue({
    status: 'disabled',
    reason: 'Later probability error deteriorated.',
  });
  const status = await createLearningService(store).runLearningCycle({ now });
  expect(status.active).toBeNull();
  expect(status.early.lastRun.status).toBe('disabled');
  expect(status.early.monitoring).toMatchObject({
    status: 'disabled',
    reason: 'Later probability error deteriorated.',
  });
  expect(store.retireModelArtifact).toHaveBeenCalledTimes(1);
  expect(await createLearningService(store).getResearchModels()).toEqual({
    active: null,
    candidate: null,
    earlyCandidate: null,
  });
  expect(trainEarlyCandidate).not.toHaveBeenCalled();
});

test('read-only model and status responses suppress degraded early influence before retirement is persisted', async () => {
  const early = model('early');
  const store = createStore(rows(87), [early], {
    ...early,
    activation: { modelId: early.id, activatedAt: now - 1000 },
  });
  evaluateEarlyActiveModel.mockReturnValue({
    status: 'disabled',
    reason: 'Later outcomes deteriorated.',
  });
  const service = createLearningService(store);
  expect(await service.getResearchModels()).toEqual({
    active: null,
    candidate: null,
    earlyCandidate: null,
  });
  const status = await service.getLearningStatus({ now });
  expect(status.active).toBeNull();
  expect(status.early.active).toBeNull();
  expect(status.early.monitoring.status).toBe('disabled');
  expect(store.retireModelArtifact).not.toHaveBeenCalled();
});

test('an already active full model cannot be replaced by early influence or trigger new early fitting', async () => {
  const full = model('full', 'outcome-logistic-kalshi-v2');
  const early = model('early', EARLY_MODEL_VERSION, start + 60_000);
  const store = createStore(rows(87), [full, early], {
    ...full,
    activation: { modelId: full.id, activatedAt: now - 1000 },
  });
  evaluateEarlyShadowCandidate.mockReturnValue(passedShadow(early));
  const status = await createLearningService(store).runLearningCycle({ now });
  expect(status.active.id).toBe(full.id);
  expect(status.early.candidate).toBeNull();
  expect(trainEarlyCandidate).not.toHaveBeenCalled();
  expect(store.activateModelArtifact).not.toHaveBeenCalled();
});

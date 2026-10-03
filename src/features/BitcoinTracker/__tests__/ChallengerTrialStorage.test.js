/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createResearchRepository } from '../../../services/research/research.repository';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { CHALLENGER_MODEL_VERSION } from '../utils/learning/challengerModel.utils';

jest.mock('server-only', () => ({}), { virtual: true });

const START = Date.UTC(2026, 8, 15);
const model = (id) => ({
  id,
  version: CHALLENGER_MODEL_VERSION,
  trainedAt: START,
  status: 'shadow',
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
});
const members = (prefix = 'event') =>
  Array.from({ length: 60 }, (_, index) => `${prefix}-${index}`);
const trialInput = (id, options = {}) => ({
  modelId: id,
  startedAt: START + 1000,
  developmentCutoffAt: START + 500,
  productionModelId: null,
  productionActivatedAt: null,
  approvedCheckpoints: [9, 6],
  ...options,
});
const passing = (trial, at, cohortForecastIds = members()) => ({
  modelId: trial.modelId,
  phase: 'confirmation',
  eligibleForPromotion: true,
  evaluationComplete: true,
  evaluatedAt: at,
  startedAt: trial.startedAt,
  attemptNumber: trial.attemptNumber,
  approvedCheckpoints: [6],
  cohortForecastIds,
});
let client;
let repository;
beforeEach(() => {
  client = createClient({ url: 'file::memory:' });
  repository = createResearchRepository({ client });
});
afterEach(() => client.close());

async function begin(id, options) {
  await repository.writeModelArtifact(model(id));
  return repository.createChallengerTrial(trialInput(id, options));
}
async function finish(trial, at, prefix) {
  const cohortForecastIds = members(prefix);
  const evaluation = passing(trial, at, cohortForecastIds);
  await repository.updateChallengerTrial(trial.modelId, {
    now: at,
    cohortForecastIds,
    status: 'passed',
    evaluation,
  });
  return evaluation;
}

test('frozen cohort membership is durable and append-only across repository restarts', async () => {
  const trial = await begin('first');
  await repository.updateChallengerTrial(trial.modelId, {
    now: START + 2000,
    cohortForecastIds: ['first-event'],
  });
  const restarted = createResearchRepository({ client });
  expect((await restarted.readChallengerTrials())[0]).toMatchObject({
    attemptNumber: 1,
    cohortForecastIds: ['first-event'],
  });
  for (const cohortForecastIds of [[], ['replacement-event'], ['first-event', 'first-event']]) {
    await expect(
      restarted.updateChallengerTrial(trial.modelId, { now: START + 3000, cohortForecastIds }),
    ).rejects.toThrow();
  }
  await expect(
    restarted.updateChallengerTrial(trial.modelId, {
      now: START + 1999,
      cohortForecastIds: ['first-event'],
    }),
  ).rejects.toMatchObject({ status: 409 });
  await restarted.updateChallengerTrial(trial.modelId, {
    now: START + 3000,
    cohortForecastIds: ['first-event', 'second-event'],
  });
  expect((await restarted.readChallengerTrials())[0].cohortForecastIds).toEqual([
    'first-event',
    'second-event',
  ]);
});

test('an existing attempt is idempotent but cannot reset its start, incumbent, or approved times', async () => {
  const trial = await begin('first');
  expect(await repository.createChallengerTrial(trialInput('first'))).toEqual(trial);
  for (const patch of [
    { startedAt: START + 2000 },
    { approvedCheckpoints: [3] },
    { productionModelId: 'different-active', productionActivatedAt: START + 100 },
    { developmentCutoffAt: START + 700 },
  ])
    await expect(
      repository.createChallengerTrial(trialInput('first', patch)),
    ).rejects.toMatchObject({ status: 409 });
  expect(await repository.readChallengerTrials()).toHaveLength(1);
});

test('only one trial collects at once, completed time boundaries never overlap, and global attempts increase', async () => {
  const first = await begin('first');
  await repository.writeModelArtifact(model('second'));
  await expect(repository.createChallengerTrial(trialInput('second'))).rejects.toMatchObject({
    status: 409,
  });
  await repository.updateChallengerTrial(first.modelId, {
    now: START + 3000,
    cohortForecastIds: [],
    status: 'failed',
    evaluation: { reason: 'Insufficient evidence.' },
  });
  await expect(
    repository.createChallengerTrial(trialInput('second', { startedAt: START + 2999 })),
  ).rejects.toThrow('follow every earlier confirmation period');
  const second = await createResearchRepository({ client }).createChallengerTrial(
    trialInput('second', { startedAt: START + 3000 }),
  );
  expect(second.attemptNumber).toBe(2);
  await repository.updateChallengerTrial(second.modelId, {
    now: START + 4000,
    cohortForecastIds: [],
    status: 'abandoned',
  });
  const third = await begin('third', { startedAt: START + 5000 });
  expect(third.attemptNumber).toBe(3);
});

test.each([
  [
    'incomplete cohort',
    (evaluation) => {
      evaluation.cohortForecastIds = members().slice(0, 59);
    },
  ],
  [
    'wrong model',
    (evaluation) => {
      evaluation.modelId = 'another';
    },
  ],
  [
    'development-only proof',
    (evaluation) => {
      evaluation.phase = 'development';
    },
  ],
  [
    'failed proof',
    (evaluation) => {
      evaluation.eligibleForPromotion = false;
    },
  ],
  [
    'future timestamp',
    (evaluation) => {
      evaluation.evaluatedAt++;
    },
  ],
  [
    'wrong start',
    (evaluation) => {
      evaluation.startedAt++;
    },
  ],
  [
    'wrong global attempt',
    (evaluation) => {
      evaluation.attemptNumber++;
    },
  ],
  [
    'unapproved checkpoint',
    (evaluation) => {
      evaluation.approvedCheckpoints = [12];
    },
  ],
  [
    'duplicate checkpoints',
    (evaluation) => {
      evaluation.approvedCheckpoints = [6, 6];
    },
  ],
  [
    'unfinished evaluation',
    (evaluation) => {
      evaluation.evaluationComplete = false;
    },
  ],
])('passing confirmation rejects %s without changing the stored trial', async (_, mutate) => {
  const trial = await begin('first');
  const evaluation = passing(trial, START + 2000);
  mutate(evaluation);
  await expect(
    repository.updateChallengerTrial('first', {
      now: START + 2000,
      cohortForecastIds: members(),
      status: 'passed',
      evaluation,
    }),
  ).rejects.toThrow();
  expect((await repository.readChallengerTrials())[0]).toEqual({ ...trial, activatedAt: null });
});

test('completion freezes both the outcome proof and cohort, including after a restart', async () => {
  const trial = await begin('first');
  const evaluation = await finish(trial, START + 3000);
  const { activatedAt, ...complete } = (await repository.readChallengerTrials())[0];
  expect(activatedAt).toBeNull();
  const restarted = createResearchRepository({ client });
  expect(
    await restarted.updateChallengerTrial('first', {
      now: START + 4000,
      cohortForecastIds: members(),
      status: 'passed',
      evaluation,
    }),
  ).toEqual(complete);
  for (const patch of [
    { status: 'collecting' },
    { evaluation: { ...evaluation, approvedCheckpoints: [9] } },
    { cohortForecastIds: members('new') },
  ]) {
    await expect(
      restarted.updateChallengerTrial('first', {
        now: START + 4000,
        cohortForecastIds: members(),
        status: 'passed',
        evaluation,
        ...patch,
      }),
    ).rejects.toMatchObject({ status: 409 });
  }
});

test('activation requires persisted exact passing confirmation rather than a supplied development report', async () => {
  const trial = await begin('first');
  const evaluation = passing(trial, START + 2000);
  await expect(
    repository.activateModelArtifact('first', {
      activatedAt: START + 3000,
      shadowEvaluation: evaluation,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await repository.updateChallengerTrial('first', {
    now: START + 2000,
    cohortForecastIds: members(),
    status: 'passed',
    evaluation,
  });
  await expect(
    repository.activateModelArtifact('first', {
      activatedAt: START + 3000,
      shadowEvaluation: { ...evaluation, phase: 'development' },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    repository.activateModelArtifact('first', {
      activatedAt: START + 3000,
      shadowEvaluation: { ...evaluation, approvedCheckpoints: [9] },
    }),
  ).rejects.toMatchObject({ status: 409 });
  const active = await repository.activateModelArtifact('first', {
    activatedAt: START + 3000,
    shadowEvaluation: evaluation,
  });
  expect(active.activation.shadowEvaluation.approvedCheckpoints).toEqual([6]);
});

test('a confirmed replacement can supersede a healthy incumbent only while its identity and activation stay unchanged', async () => {
  const first = await begin('first');
  const firstEvaluation = await finish(first, START + 2000);
  await repository.activateModelArtifact('first', {
    activatedAt: START + 3000,
    shadowEvaluation: firstEvaluation,
  });
  const next = await begin('second', {
    startedAt: START + 4000,
    productionModelId: 'first',
    productionActivatedAt: START + 3000,
  });
  const nextEvaluation = await finish(next, START + 5000, 'next');
  const nextActive = await repository.activateModelArtifact('second', {
    activatedAt: START + 6000,
    shadowEvaluation: nextEvaluation,
  });
  expect(nextActive.id).toBe('second');
  expect((await repository.readModelArtifact('first')).retirement).toBeUndefined();
  await expect(
    repository.activateModelArtifact('first', {
      activatedAt: START + 7000,
      shadowEvaluation: firstEvaluation,
    }),
  ).rejects.toMatchObject({ status: 409 });
});

test('an incumbent change invalidates confirmation, including retirement back to baseline', async () => {
  const first = await begin('first');
  const firstEvaluation = await finish(first, START + 2000);
  await repository.activateModelArtifact('first', {
    activatedAt: START + 3000,
    shadowEvaluation: firstEvaluation,
  });
  const next = await begin('second', {
    startedAt: START + 4000,
    productionModelId: 'first',
    productionActivatedAt: START + 3000,
  });
  const nextEvaluation = await finish(next, START + 5000, 'next');
  await repository.retireModelArtifact('first', {
    retiredAt: START + 5500,
    reason: 'Monitoring failed.',
  });
  await expect(
    repository.activateModelArtifact('second', {
      activatedAt: START + 6000,
      shadowEvaluation: nextEvaluation,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await repository.getActiveModelArtifact()).toBeNull();
});

test('an old passed trial cannot replay after its replacement retires and returns to baseline', async () => {
  const first = await begin('first');
  const firstEvaluation = await finish(first, START + 2000);
  await repository.activateModelArtifact('first', {
    activatedAt: START + 3000,
    shadowEvaluation: firstEvaluation,
  });
  const next = await begin('second', {
    startedAt: START + 4000,
    productionModelId: 'first',
    productionActivatedAt: START + 3000,
  });
  const nextEvaluation = await finish(next, START + 5000, 'next');
  await repository.activateModelArtifact('second', {
    activatedAt: START + 6000,
    shadowEvaluation: nextEvaluation,
  });
  await repository.retireModelArtifact('second', {
    retiredAt: START + 7000,
    reason: 'Monitoring failed.',
  });
  expect(await repository.getActiveModelArtifact()).toBeNull();
  await expect(
    repository.activateModelArtifact('first', {
      activatedAt: START + 8000,
      shadowEvaluation: firstEvaluation,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await repository.getActiveModelArtifact()).toBeNull();
});

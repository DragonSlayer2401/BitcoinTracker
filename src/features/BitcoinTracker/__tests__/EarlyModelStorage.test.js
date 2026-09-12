/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createResearchRepository } from '../../../services/research/research.repository';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { EARLY_MODEL_VERSION } from '../utils/learning/earlyModel.utils';

jest.mock('server-only', () => ({}), { virtual: true });

const now = Date.UTC(2026, 8, 11);
const artifact = (id, version = EARLY_MODEL_VERSION) => ({
  id,
  version,
  trainedAt: now,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'shadow',
});
const activation = (id, at = now + 1000) => ({
  activatedAt: at,
  shadowEvaluation: { modelId: id, eligibleForPromotion: true, evaluatedAt: at },
});
let client;
let repository;

beforeEach(() => {
  client = createClient({ url: 'file::memory:' });
  repository = createResearchRepository({ client });
});
afterEach(() => client.close());

test('retirement is durable, idempotent, and never restores an older activation', async () => {
  const first = artifact('early-first');
  const second = artifact('early-second');
  await repository.writeModelArtifact(first);
  await repository.writeModelArtifact(second);
  await repository.activateModelArtifact(first.id, activation(first.id));
  await repository.activateModelArtifact(second.id, activation(second.id, now + 2000));
  const retirement = { retiredAt: now + 3000, reason: 'Later outcomes deteriorated.' };
  await repository.retireModelArtifact(second.id, retirement);
  await repository.retireModelArtifact(second.id, {
    retiredAt: now + 4000,
    reason: 'Repeated cycle.',
  });
  const restarted = createResearchRepository({ client });
  expect(await restarted.getActiveModelArtifact()).toBeNull();
  expect(await restarted.readModelArtifact(second.id)).toEqual({
    ...second,
    retirement: { ...retirement, wasActive: true },
  });
  expect(await restarted.readModelArtifacts()).toEqual([
    first,
    { ...second, retirement: { ...retirement, wasActive: true } },
  ]);
  await expect(
    restarted.activateModelArtifact(second.id, activation(second.id, now + 5000)),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await client.execute('SELECT COUNT(*) AS count FROM model_retirements')).rows[0].count,
  ).toBe(1);
});

test('a rejected shadow candidate can be retired without disabling a different active model', async () => {
  const active = artifact('active');
  const candidate = artifact('candidate');
  await repository.writeModelArtifact(active);
  await repository.writeModelArtifact(candidate);
  await repository.activateModelArtifact(active.id, activation(active.id));
  await repository.retireModelArtifact(candidate.id, {
    retiredAt: now + 2000,
    reason: 'Future test did not pass.',
  });
  expect((await repository.getActiveModelArtifact()).id).toBe(active.id);
});

test('full activation supersedes early, and storage refuses a subsequent early replacement', async () => {
  const early = artifact('early');
  const full = artifact('full', 'outcome-logistic-kalshi-v2');
  await repository.writeModelArtifact(early);
  await repository.writeModelArtifact(full);
  await repository.activateModelArtifact(early.id, activation(early.id));
  await repository.activateModelArtifact(full.id, activation(full.id, now + 2000));
  await expect(
    repository.activateModelArtifact(early.id, activation(early.id, now + 3000)),
  ).rejects.toMatchObject({ status: 409 });
  expect((await repository.getActiveModelArtifact()).id).toBe(full.id);
});

test('invalid retirements cannot disable a model or overwrite its immutable artifact', async () => {
  const model = artifact('early');
  await repository.writeModelArtifact(model);
  await repository.activateModelArtifact(model.id, activation(model.id));
  for (const retirement of [
    {},
    { retiredAt: now - 1, reason: 'Before training.' },
    { retiredAt: now + 500, reason: 'Before activation.' },
    { retiredAt: now + 2000, reason: '' },
    { retiredAt: now + 2000, reason: 'x'.repeat(2001) },
  ]) {
    await expect(repository.retireModelArtifact(model.id, retirement)).rejects.toMatchObject({
      status: 400,
    });
  }
  await expect(
    repository.retireModelArtifact('missing', { retiredAt: now + 2000, reason: 'Missing model.' }),
  ).rejects.toMatchObject({ status: 404 });
  expect((await repository.getActiveModelArtifact()).id).toBe(model.id);
  expect(await repository.readModelArtifact(model.id)).toEqual(model);
});

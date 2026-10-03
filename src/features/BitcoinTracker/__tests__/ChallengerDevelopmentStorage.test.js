/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createResearchRepository } from '../../../services/research/research.repository';
import { CHALLENGER_ENROLLMENT_POLICY } from '../../../services/research/challengerDevelopment.repository';
import { trainChallengerCandidate } from '../utils/learning/challengerTraining.utils';
import {
  CURRENT_COLLECTOR_CODE_VERSION,
  CURRENT_COLLECTOR_RESEARCH_VERSION,
  COLLECTOR_HEARTBEAT_VERSION,
} from '../utils/collectorHealth.utils';
import { windowSet, recordedWindow, afterWindow } from './fixtures/challengerFixtures';

jest.mock('server-only', () => ({}), { virtual: true });
let client;
let repository;
let artifact;
let decision;
let now;
let readiness;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  repository = createResearchRepository({ client });
  artifact = {
    ...trainChallengerCandidate(windowSet(80), [], {
      kind: 'reduced-pressure',
      now: afterWindow(79),
    }).artifact,
    enrollmentPolicy: CHALLENGER_ENROLLMENT_POLICY,
  };
  await repository.writeModelArtifact(artifact);
  decision = recordedWindow(80, { model: artifact }).find((row) => row.event === 'decision');
  decision.researchExperiment.version = CURRENT_COLLECTOR_RESEARCH_VERSION;
  decision.researchReplay = { snapshotId: decision.eventId, contentHash: 'proof-hash' };
  now = decision.capturedAt + 1000;
  readiness = {
    collectorId: 'collector-test',
    codeVersion: CURRENT_COLLECTOR_CODE_VERSION,
    researchVersion: CURRENT_COLLECTOR_RESEARCH_VERSION,
    proofEventId: decision.eventId,
  };
  await repository.writeCollectorHeartbeat({
    version: COLLECTOR_HEARTBEAT_VERSION,
    collectorId: readiness.collectorId,
    codeVersion: readiness.codeVersion,
    researchVersion: readiness.researchVersion,
    startedAt: now - 5000,
    heartbeatAt: now,
    status: 'running',
    feeds: { benchmarkAt: decision.quoteTime, spotAt: null, futuresAt: null, marketAt: null },
    lastEvidenceAt: decision.recordedAt,
  });
  // The repository receives already-validated immutable captures; these focused fixtures
  // populate their storage directly to exercise enrollment's independent cross-checks.
  await client.execute({
    sql: 'INSERT INTO evidence_events(event_id,forecast_id,recorded_at,content_hash,payload) VALUES (?,?,?,?,?)',
    args: [
      decision.eventId,
      decision.forecastId,
      decision.recordedAt,
      'decision-hash',
      JSON.stringify(decision),
    ],
  });
  await client.execute({
    sql: 'INSERT INTO research_input_snapshots(snapshot_id,forecast_id,captured_at,content_hash,payload) VALUES (?,?,?,?,?)',
    args: [
      decision.eventId,
      decision.forecastId,
      decision.capturedAt,
      'proof-hash',
      JSON.stringify({
        capturedAt: decision.capturedAt,
        timing: { replayable: true },
        models: { challengers: { candidates: [artifact] } },
      }),
    ],
  });
});
afterEach(() => client.close());

test('verified deployment creates one immutable future boundary and survives restart', async () => {
  const first = await repository.createChallengerDevelopment({
    modelId: artifact.id,
    now,
    readiness,
  });
  expect(first).toMatchObject({
    modelId: artifact.id,
    inclusiveBoundary: true,
    status: 'collecting',
    cohortForecastIds: [],
  });
  expect(first.startedAt % 900_000).toBe(0);
  expect(first.startedAt).toBeGreaterThan(now);
  expect(artifact.trainedAt).toBe(afterWindow(79));
  const restarted = createResearchRepository({ client });
  expect(
    await restarted.createChallengerDevelopment({
      modelId: artifact.id,
      now: now + 100_000,
      readiness,
    }),
  ).toEqual(first);
  expect(await restarted.readChallengerDevelopments()).toEqual([first]);
});

test.each([
  ['old code', () => ({ readiness: { ...readiness, codeVersion: 'old-code' } })],
  ['old research', () => ({ readiness: { ...readiness, researchVersion: 'kalshi-ablation-v1' } })],
  [
    'missing heartbeat',
    () => ({ readiness: { ...readiness, collectorId: 'different-collector' } }),
  ],
  ['missing proof', () => ({ readiness: { ...readiness, proofEventId: 'not-recorded' } })],
  ['stale proof', () => ({ now: decision.capturedAt + 30_001 })],
  ['no handshake', () => ({ readiness: null })],
])('cannot enroll with %s', async (_, patch) => {
  await expect(
    repository.createChallengerDevelopment({ modelId: artifact.id, now, readiness, ...patch() }),
  ).rejects.toThrow();
  expect(await repository.readChallengerDevelopments()).toEqual([]);
});

test('recorded model identity and replay proof must match the frozen candidate', async () => {
  decision.researchExperiment.variants[artifact.variantName].modelId = 'other-model';
  await client.execute({
    sql: 'UPDATE evidence_events SET payload=? WHERE event_id=?',
    args: [JSON.stringify(decision), decision.eventId],
  });
  await expect(
    repository.createChallengerDevelopment({ modelId: artifact.id, now, readiness }),
  ).rejects.toThrow(/loaded candidate/);
  decision.researchExperiment.variants[artifact.variantName].modelId = artifact.id;
  await client.execute({
    sql: 'UPDATE evidence_events SET payload=? WHERE event_id=?',
    args: [JSON.stringify(decision), decision.eventId],
  });
  await client.execute("UPDATE research_input_snapshots SET content_hash='different'");
  await expect(
    repository.createChallengerDevelopment({ modelId: artifact.id, now, readiness }),
  ).rejects.toThrow(/replay snapshot/);
});

test('older development retains its original boundary and never accepts a new deployment start', async () => {
  const legacy = { ...artifact, id: artifact.id + '-legacy' };
  delete legacy.enrollmentPolicy;
  await repository.writeModelArtifact(legacy);
  await expect(
    repository.createChallengerDevelopment({ modelId: legacy.id, now, readiness }),
  ).rejects.toThrow(/original prospective/);
  const original = await repository.createChallengerDevelopment({ modelId: legacy.id, now });
  expect(original.startedAt).toBe(artifact.shadowStartsAt);
  expect(original.inclusiveBoundary).toBe(false);
});

test('missing evidence is archived without changing cohort membership or erasing observations', async () => {
  const development = await repository.createChallengerDevelopment({
    modelId: artifact.id,
    now,
    readiness,
  });
  const cohortForecastIds = ['event-one', 'event-two'];
  await repository.updateChallengerDevelopment(artifact.id, {
    now: development.startedAt + 1000,
    cohortForecastIds,
  });
  await expect(
    repository.updateChallengerDevelopment(artifact.id, {
      now: development.startedAt + 2000,
      cohortForecastIds: ['replacement'],
    }),
  ).rejects.toThrow(/append-only/);
  const evaluation = {
    modelId: artifact.id,
    phase: 'development',
    startedAt: development.startedAt,
    evaluatedAt: development.startedAt + 2000,
    evaluationComplete: true,
    failureCategory: 'evidence',
    failureCode: 'predictions-not-recorded',
    cohortForecastIds,
  };
  await repository.updateChallengerDevelopment(artifact.id, {
    now: evaluation.evaluatedAt,
    cohortForecastIds,
    status: 'unusable-evidence',
    evaluation,
  });
  await expect(
    repository.updateChallengerDevelopment(artifact.id, {
      now: evaluation.evaluatedAt + 1000,
      cohortForecastIds,
      status: 'collecting',
    }),
  ).rejects.toThrow(/immutable/);
  expect((await repository.readChallengerDevelopments())[0]).toMatchObject({
    status: 'unusable-evidence',
    cohortForecastIds,
    evaluation,
  });
  expect((await client.execute('SELECT count(*) n FROM evidence_events')).rows[0].n).toBe(1);
});
